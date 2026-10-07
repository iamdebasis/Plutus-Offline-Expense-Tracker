"""Every transaction, flat, in data/ledger/<year>.json; card bill payments in data/card_payments.json.

The same payment often arrives more than once: a screenshot now, the monthly statement later, a
re-uploaded file. Matching is by UTR, then the app's transaction ID, then time + amount + payee.
A match merges the new source into the existing record instead of adding a copy.
"""

import functools
import hashlib
import inspect
import re
import threading
from dataclasses import dataclass, field
from datetime import timedelta

from app import billing, statements, userdata
from app.jsonstore import JsonFile
from app.models import CardPayment, Transaction

_lock = threading.RLock()
LOOSE_MATCH_WINDOW = timedelta(minutes=10)


@dataclass
class UpsertStats:
    added: int = 0
    duplicates: int = 0
    # records a new reading of the same statement row refreshed: their rules are applied again
    refreshed: list[Transaction] = field(default_factory=list)
    # every existing record the new readings matched
    matched: list[Transaction] = field(default_factory=list)


def _shard(year: int) -> JsonFile:
    return JsonFile(userdata.path("ledger", f"{year}.json"), default=list)


def _payments() -> JsonFile:
    return userdata.json_file("card_payments.json", default=list)


def exclusive(fn):
    """A route that reads, changes and saves the ledger holds it throughout (see `editing`), and then the card bills
    are placed again from what it saved: a payment filed as a card bill, or taken out of one, changes which bills
    there are and what each stands for."""
    if inspect.iscoroutinefunction(fn):
        raise TypeError(f"{fn.__name__}: an edit of the ledger runs whole under its lock, so it can't be async")

    @functools.wraps(fn)
    def run(*args, **kwargs):
        with _lock:
            result = fn(*args, **kwargs)
            place_cards()
            return result
    return run


def editing() -> threading.RLock:
    """Hold the ledger for a whole read, change and save: `with ledger.editing(): …`. Nothing else (an import, another
    change of yours) writes in between, so neither undoes the other."""
    return _lock


def load_transactions() -> list[Transaction]:
    folder = userdata.path("ledger")
    if not folder.exists():
        return []
    with _lock:
        txns = [Transaction.model_validate(row) for f in sorted(folder.glob("*.json")) for row in _shard(int(f.stem)).read()]
    return sorted(txns, key=lambda t: t.at)


def save_transactions(txns: list[Transaction]) -> None:
    by_year: dict[int, list[dict]] = {}
    for t in sorted(txns, key=lambda t: t.at):
        by_year.setdefault(t.at.year, []).append(t.model_dump(mode="json"))
    with _lock:
        folder = userdata.path("ledger")
        for f in folder.glob("*.json") if folder.exists() else []:
            if int(f.stem) not in by_year:
                f.unlink()
        for year, rows in by_year.items():
            _shard(year).write(rows)


def payee_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def _card_rows(t: Transaction) -> set[str]:
    """The card statement rows a record is ("cardRow", and "cardRow2"… when files that overlap list it too)."""
    return {v for k, v in t.refs.items() if k.startswith("cardRow") and v}


def _keys(t: Transaction) -> set[str]:
    keys = {f"utr:{t.refs['utr']}"} if t.refs.get("utr") else set()
    if t.refs.get("txnId"):
        keys.add(f"txn:{t.refs['txnId']}")
    keys |= {f"card:{row}" for row in _card_rows(t)}  # a row of a card statement: the same file added again
    keys.add(f"fp:{t.at:%Y%m%d%H%M}:{t.amount:.2f}:{t.direction}:{payee_key(t.payee)}")
    return keys


def _can_be_same(a: Transaction, b: Transaction) -> bool:
    """A shared key isn't enough on its own:
    - different UTRs (or app transaction IDs) are different payments, however alike they look: two ₹15
      teas from the same stall in the same minute are two teas;
    - a different amount or direction is a different movement, even with the same reference: PhonePe
      gives a cashback the transaction ID of the payment that earned it;
    - but the same UTR, amount and direction is one movement of money whatever the app's own IDs say: the
      UTR is the bank's reference, and PhonePe sometimes lists a refund twice ("Refund Received - …" and
      "Payment Received") under two transaction IDs."""
    if a.direction != b.direction or abs(a.amount - b.amount) > 0.005:
        return False
    if a.refs.get("utr") and a.refs.get("utr") == b.refs.get("utr"):
        return True
    rows_a, rows_b = _card_rows(a), _card_rows(b)
    if rows_a and rows_b and not rows_a & rows_b:
        return False  # two rows of card statements: the same only by _same_purchase_in_two_files
    return not any(k in b.refs and a.refs[k] != b.refs[k] for k in a.refs if not k.startswith("cardRow"))


def _loosely_same(a: Transaction, b: Transaction) -> bool:
    """Same payment seen by two sources that share no reference: amount, direction, time and payee agree."""
    if abs(a.at - b.at) > LOOSE_MATCH_WINDOW or not _can_be_same(a, b):
        return False
    ka, kb = payee_key(a.payee), payee_key(b.payee)
    return bool(ka and kb) and (ka in kb or kb in ka)


def _card_and_app(a: Transaction, b: Transaction) -> bool:
    """A payment with a credit card can be seen twice: by the app you paid with (a RuPay card on UPI, a Google
    purchase charged to a card), which writes the card as "XXXX" and its last two digits, and by the card's
    statement (that card, that day). Same amount and direction, close in time (UPI is instant; a card purchase can
    post a few days later), and no reference that tells them apart: one payment."""
    card, app = (a, b) if "cardRow" in a.refs else (b, a)
    if "cardRow" not in card.refs or "cardRow" in app.refs or not card.paid_from or not app.paid_from:
        return False
    on_card = re.fullmatch(r"X{4}(\d{2})", app.paid_from)
    within = 1 if app.channel == "upi" else 3
    return bool(on_card and card.paid_from.endswith(on_card[1]) and abs((card.at.date() - app.at.date()).days) <= within
                and _can_be_same(card, app))


def _same_purchase_in_two_files(a: Transaction, b: Transaction) -> bool:
    """Files of one card that overlap (a monthly statement and the bank's export of a longer span, or two exports)
    list the same purchases, each its own way: one may date a purchase when it posted, a day or three later, and
    name the shop differently. Same card, amount and direction, within three days, a shop name that one contains
    or shares a word with the other, from two different files: one purchase. Two rows of one file never are."""
    rows_a, rows_b = _card_rows(a), _card_rows(b)
    if not rows_a or not rows_b or rows_a & rows_b or not a.card or a.card != b.card:
        return False
    if {s.upload for s in a.sources} & {s.upload for s in b.sources}:
        return False
    if a.direction != b.direction or abs(a.amount - b.amount) > 0.005 or abs((a.at.date() - b.at.date()).days) > 3:
        return False
    if any(a.refs.get(k) and b.refs.get(k) and a.refs[k] != b.refs[k] for k in ("utr", "txnId")):
        return False
    ka, kb = payee_key(a.payee), payee_key(b.payee)
    words = lambda t: {w for w in re.findall(r"[a-z]{4,}", f"{t.payee} {t.note}".lower()) if w not in _NOT_A_NAME}  # noqa: E731
    return bool(ka and kb) and (ka in kb or kb in ka or bool(words(a) & words(b)))


# Words that say nothing about which shop it was.
_NOT_A_NAME = {"payment", "purchase", "india", "private", "limited", "store", "stores", "online", "services", "retail",
               "bangalore", "bengaluru", "mumbai", "delhi", "pune", "chennai", "hyderabad", "kolkata", "gurgaon", "noida"}


def _from_app(t: Transaction) -> bool:
    """Includes an app's own record of the payment (its references, or which app), not just a statement's row."""
    return bool(t.app) or any(k != "cardRow" for k in t.refs)


def _amount_key(t: Transaction) -> tuple[str, int]:
    return t.direction, round(t.amount * 100)


def _same_row(a: Transaction, b: Transaction) -> bool:
    return bool(a.refs.get("cardRow")) and a.refs.get("cardRow") == b.refs.get("cardRow")


def _merge(into: Transaction, other: Transaction) -> None:
    if _same_row(into, other):
        # the same statement row read again, perhaps by a better reader: what the statement says is refreshed (your
        # category stays); its time, payee and channel too, unless the app you paid with has its own record of it
        into.kind, into.note, into.card = other.kind, other.note, other.card or into.card
        into.merchant_category = other.merchant_category or into.merchant_category
        if not _from_app(into):
            into.at, into.payee, into.channel, into.paid_from = other.at, other.payee, other.channel, other.paid_from
    elif ("cardRow" in into.refs) != ("cardRow" in other.refs):
        # one payment with a card, seen by the app you paid with and by the card's statement: the app's reading has
        # the exact time, the payee and how it was paid (UPI, or the card itself); the statement's says which card
        # it was charged to and how the bank classes it
        app = other if "cardRow" in into.refs else into
        into.at, into.channel, into.paid_from = app.at, app.channel, app.paid_from
        into.payee, into.payee_handle, into.app = app.payee, app.payee_handle or into.payee_handle, app.app or into.app
        into.card = into.card or other.card
        into.merchant_category = into.merchant_category or other.merchant_category
    # a row of another file that lists the same purchase: kept, so that file finds it again when it's read again
    for row in _card_rows(other) - _card_rows(into):
        into.refs["cardRow" if "cardRow" not in into.refs else next(f"cardRow{n}" for n in range(2, 99) if f"cardRow{n}" not in into.refs)] = row
    # "Refund Received - …" says more than "Payment Received": keep what the money was, and the refund's
    # transaction ID, which is its payment's
    if into.kind == "income" and other.kind in ("refund", "cashback"):
        into.kind, into.payee, into.category = other.kind, other.payee, other.category
        if other.refs.get("txnId"):
            into.refs["txnId"] = other.refs["txnId"]
    for src in other.sources:
        if src not in into.sources:
            into.sources.append(src)
    for k, v in other.refs.items():
        if not k.startswith("cardRow"):
            into.refs.setdefault(k, v)
    into.payee_handle = into.payee_handle or other.payee_handle
    into.paid_from = into.paid_from or other.paid_from


def upsert_transactions(new: list[Transaction]) -> tuple[UpsertStats, list[Transaction]]:
    """Returns stats and the transactions that were actually added."""
    stats, added = UpsertStats(), []
    with _lock:
        existing = load_transactions()
        index = {k: t for t in existing for k in _keys(t)}
        # a loose match needs the same amount and direction, so only those are compared (an all-time
        # statement is thousands of rows; comparing each with every other one gets slow)
        taken = {t.id for t in existing}
        same_amount: dict[tuple, list[Transaction]] = {}
        for e in existing:
            same_amount.setdefault(_amount_key(e), []).append(e)
        for t in new:
            match = next((index[k] for k in _keys(t) if k in index and _can_be_same(index[k], t)), None)
            if match is None:
                match = next((e for e in same_amount.get(_amount_key(t), ()) if _loosely_same(e, t)), None)
            if match is None:
                same_card = [e for e in same_amount.get(_amount_key(t), ()) if _card_and_app(e, t)]
                match = min(same_card, key=lambda e: abs((e.at - t.at).total_seconds()), default=None)
            if match is None:
                listed = [e for e in same_amount.get(_amount_key(t), ()) if _same_purchase_in_two_files(e, t)]
                match = min(listed, key=lambda e: abs((e.at - t.at).total_seconds()), default=None)
            if match is not None:
                if _same_row(match, t):
                    stats.refreshed.append(match)
                stats.matched.append(match)
                _merge(match, t)
                stats.duplicates += 1
                continue
            if t.id in taken:
                t.id = _free_id(t, taken)
            taken.add(t.id)
            existing.append(t)
            added.append(t)
            index.update({k: t for k in _keys(t)})
            same_amount.setdefault(_amount_key(t), []).append(t)
            stats.added += 1
        save_transactions(existing)
    return stats, added


def _free_id(t: Transaction, taken: set[str]) -> str:
    """Another id for a transaction whose id is already used by a different one, stable across runs."""
    for n in range(1, 1000):
        candidate = f"{t.id}-{hashlib.sha1(f'{t.direction}|{t.amount:.2f}|{t.at.isoformat()}|{n}'.encode()).hexdigest()[:6]}"
        if candidate not in taken:
            return candidate
    raise RuntimeError(f"no free id for {t.id}")


def merge_same_utr() -> int:
    """Records saved before the same-UTR rule: fold each into the first with the same UTR, amount and
    direction. Returns how many were folded in."""
    with _lock:
        kept: list[Transaction] = []
        first: dict[tuple, Transaction] = {}
        folded = 0
        for t in sorted(load_transactions(), key=lambda t: t.at):
            key = (t.refs["utr"], t.direction, round(t.amount * 100)) if t.refs.get("utr") else None
            if key in first:
                _merge(first[key], t)
                folded += 1
                continue
            if key:
                first[key] = t
            kept.append(t)
        if folded:
            from app import categorize

            categorize.link_refunds(kept)
            save_transactions(kept)
        return folded


def repair_duplicate_ids() -> int:
    """Older imports could give a payment and its refund one id. Give each its own; returns how many changed."""
    with _lock:
        txns, taken, changed = load_transactions(), set(), 0
        for t in txns:
            if t.id in taken:
                t.id = _free_id(t, taken)
                changed += 1
            taken.add(t.id)
        if changed:
            save_transactions(txns)
        return changed


def relink() -> None:
    """After an import or a change: match refunds to their payments, and UPI payments to CRED to the card
    bills in your CRED history, across the whole ledger."""
    from app import categorize

    with _lock:
        txns = load_transactions()
        categorize.link_refunds(txns)
        payments = load_card_payments()
        categorize.link_card_bills(txns, payments)
        _place(txns, payments)
        save_transactions(txns)


def place_cards() -> None:
    """Which card each app-recorded card payment was charged to, and what each bill paid for: again after your
    cards, their networks or your statements change."""
    with _lock:
        txns = load_transactions()
        if _place(txns, load_card_payments()):
            save_transactions(txns)


def _place(txns: list[Transaction], payments: list[CardPayment]) -> bool:
    """The bills, placed again: the apps' records, and the statements' own payment rows that no app recorded (made
    again from the ledger each time, so a row re-filed or a file deleted takes its bill with it). Saves the bills when
    they changed; True when transactions changed (the caller saves those)."""
    from app import vault

    in_order = lambda bills: sorted(bills, key=lambda p: (p.at, p.id))  # noqa: E731
    before = [p.model_dump(mode="json") for p in in_order(payments)]
    cards = vault.list_instruments()
    changed = billing.assign_cards(txns, cards)
    apps = [p for p in payments if p.origin == "app"]
    bills = in_order(apps + billing.statement_bills(txns, apps, cards))
    billing.place_bills(bills, statements.counted(), txns)  # a statement on hold covers no bill: its rows aren't counted
    after = [p.model_dump(mode="json") for p in bills]
    if after != before:
        _payments().write(after)
    return changed > 0


def update_transactions(changed: list[Transaction]) -> None:
    """Save these, as changed by a step that took a while (the local AI sorting new payees): a payment you set
    yourself in the meantime keeps your answer."""
    by_id = {t.id: t for t in changed}
    with _lock:
        save_transactions([t if t.categorized_by == "user" else by_id.get(t.id, t) for t in load_transactions()])


def load_card_payments() -> list[CardPayment]:
    with _lock:
        return sorted((CardPayment.model_validate(r) for r in _payments().read()), key=lambda p: p.at)


def upsert_card_payments(new: list[CardPayment]) -> UpsertStats:
    """Bill payments carry nothing you edit, so a new reading of the same payment replaces the old one
    (that's how parser improvements reach files imported earlier)."""
    stats = UpsertStats()
    with _lock:
        rows = {r["id"]: r for r in _payments().read()}
        for p in new:
            if p.id in rows:
                stats.duplicates += 1
            else:
                stats.added += 1
            rows[p.id] = p.model_dump(mode="json")
        _payments().write(sorted(rows.values(), key=lambda r: r["at"]))
    return stats


def retract(upload_id: str, keep: set[str]) -> int:
    """A file read again: what its earlier reading found and this one doesn't (a row the old reader made up, such as
    a summary figure taken for a purchase) goes. A record another file also lists only stops citing this one.
    Returns how many records this file no longer vouches for."""
    with _lock:
        txns, kept, gone = load_transactions(), [], 0
        for t in txns:
            if t.id not in keep and any(_file_of(s.upload) == upload_id for s in t.sources):
                gone += 1
                t.sources = [s for s in t.sources if _file_of(s.upload) != upload_id]
                if not t.sources:
                    continue
            kept.append(t)
        if gone:
            save_transactions(kept)
        return gone


def _file_of(source: str) -> str:
    """The file a row was read from ("upl_1~2", one of several statements in it, as rows once cited it, is upl_1)."""
    return source.split("~", 1)[0]


def forget_upload(upload_id: str) -> None:
    """Drop what only this upload contributed; keep records other files also vouch for."""
    with _lock:
        kept = []
        for t in load_transactions():
            t.sources = [s for s in t.sources if _file_of(s.upload) != upload_id]
            if t.sources:
                kept.append(t)
        _payments().write([r for r in _payments().read() if r["source"]["upload"] != upload_id])
        from app import categorize

        # a refund whose payment went with the file goes back under Refunds; a bill that went unlinks its UPI side
        categorize.link_refunds(kept)
        payments = load_card_payments()
        categorize.link_card_bills(kept, payments)
        statements.forget(upload_id)
        _place(kept, payments)
        save_transactions(kept)
