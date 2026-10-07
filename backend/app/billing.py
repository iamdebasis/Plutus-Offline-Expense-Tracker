"""Which of your cards paid for what, and what each card bill paid for.

An app's record of a payment with a credit card names the card only by its last two digits ("XXXX99"): it's the
card of yours that ends that way. On UPI that's a RuPay card (only RuPay credit cards work on UPI), so when two of
your cards end the same way the RuPay one is it, and a card on another network never is. When it's still not clear,
the payment is left without a card rather than given to the wrong one.

A bill pays for one billing cycle of purchases: the statement it pays.
- When you've added that statement, or an export from the bank that spans the whole cycle, its purchases are
  counted one by one and the bill adds nothing (`covered_by`).
- Otherwise the bill stands for that cycle's purchases with the card number, estimated: what it paid, less what's
  already counted one by one (payments made with the card on UPI, which are in UPI spends, and any part of the
  cycle an export does list).
The cycle comes from the card's statements when you've added any, since a bank bills a card on the same day each
month (an export ends whenever it was downloaded, so it says nothing about that); for a card without one, it's
taken to end about ten days before the card's bills are usually paid.

A bill is read from a payment app's history (CRED and similar), or from a statement: every statement lists the payment
it received ("PAYMENT RECEIVED"), and that row is a bill paid unless an app recorded the same payment
(`statement_bills`). Either way it's placed by the same rules.
"""

import math
import re
from calendar import monthrange
from collections import defaultdict
from datetime import date, datetime, timedelta

from app.categorize import CARD_BILL_TOLERANCE, statement_bill
from app.models import CardPayment, CardStatement, Instrument, Transaction

# A statement found a day or two off the card's usual billing day (a holiday, a cycle the bank moved) is still it.
SAME_CYCLE = 3
# For a card with no statement added: bills are paid between the statement and its due date, about three weeks.
GUESS_BILLED_BEFORE = timedelta(days=10)

_ON_CARD = re.compile(r"X{4}(\d{2})")
# An app records a bill when you pay it; the bank posts it to the card a day or a few later.
POSTED_WITHIN = timedelta(days=5)


def card_for(t: Transaction, cards: list[Instrument]) -> str | None:
    """The card an app's record of a payment was charged to (its id), when its "XXXX99" says which."""
    m = _ON_CARD.fullmatch(t.paid_from or "")
    if not m:
        return None
    ending = [c for c in cards if c.last4.endswith(m[1])]
    if t.channel == "upi":
        rupay = [c for c in ending if (c.network or "").lower() == "rupay"]
        ending = rupay or [c for c in ending if not c.network]
    return ending[0].id if len(ending) == 1 else None


def assign_cards(txns: list[Transaction], cards: list[Instrument]) -> int:
    """Give each app-recorded card payment its card (a statement's row knows its own). Returns how many changed."""
    changed = 0
    for t in txns:
        if "cardRow" in t.refs:
            continue
        card = card_for(t, cards)
        if card != t.card:
            t.card = card
            changed += 1
    return changed


# ---- bills paid, as statements list them ----------------------------------------------------------------------


def statement_bills(txns: list[Transaction], app_bills: list[CardPayment], cards: list[Instrument]) -> list[CardPayment]:
    """Bills paid as your statements list them: each counted statement's (or export's) row for a payment to the card,
    still filed as a card bill, that no app's bill already records. An app's bill is the same payment when it's the
    same card, paid within POSTED_WITHIN before or after, for about the same amount (rewards can pay a little of it);
    each app bill stands for one row. A held statement's rows aren't in the ledger, so they pay nothing."""
    titles = {c.id: f"{c.issuer or 'Card'} ••{c.last4}" for c in cards}
    free = list(app_bills)
    out = []
    for t in sorted(txns, key=lambda t: t.at):
        if not (statement_bill(t) and t.category == "transfers.card_bill" and t.card):
            continue
        same = [b for b in free if b.card == t.card and abs(b.amount - t.amount) <= b.amount * CARD_BILL_TOLERANCE
                and abs(_day(b.at) - _day(t.at)) <= POSTED_WITHIN]
        if same:
            free.remove(min(same, key=lambda b: (abs(b.amount - t.amount) > 0.005, abs(_day(b.at) - _day(t.at)))))
            continue
        out.append(CardPayment(
            id=f"bill-{t.id}", at=t.at, amount=t.amount, card=t.card, card_title=titles.get(t.card, "Card"),
            refs={"txn": t.id, "cardRow": t.refs["cardRow"]}, source=t.sources[0], origin="statement",
        ))
    return out


# ---- billing cycles ------------------------------------------------------------------------------------------


def _end_on_or_before(day: date, cycle_day: int) -> date:
    """The last cycle end on or before `day`, for a card billed on `cycle_day` each month (a short month's last day)."""
    y, m = day.year, day.month
    while True:
        end = date(y, m, min(cycle_day, monthrange(y, m)[1]))
        if end <= day:
            return end
        y, m = (y, m - 1) if m > 1 else (y - 1, 12)


def _cycle_ending(end: date, cycle_day: int) -> tuple[date, date]:
    return _end_on_or_before(end - timedelta(days=1), cycle_day) + timedelta(days=1), end


def _statement_end(s: CardStatement) -> date | None:
    when = s.period_end or s.statement_date
    return date.fromisoformat(when) if when else None


def _usual_day(days: list[int]) -> int:
    """The day of the month these fall around (on a circle, so the 30th and the 2nd average to the 1st)."""
    angles = [2 * math.pi * (d - 1) / 31 for d in days]
    mean = math.atan2(sum(map(math.sin, angles)), sum(map(math.cos, angles)))
    return round(mean % (2 * math.pi) / (2 * math.pi) * 31) % 31 + 1


def _day(at: datetime | date) -> date:
    return at.date() if isinstance(at, datetime) else at


def place_bills(payments: list[CardPayment], statements: list[CardStatement], txns: list[Transaction]) -> int:
    """Set what each bill pays for: the statement you added (covered), or its card's billing cycle and the card
    purchases it's taken to pay for. Returns how many bills changed."""
    by_card: dict[str, list[CardStatement]] = defaultdict(list)  # monthly statements: they show the billing day
    spans: dict[str, list[CardStatement]] = defaultdict(list)  # anything that lists a span of the card's purchases
    for s in statements:
        if not s.card or not _statement_end(s):
            continue
        if s.kind == "statement":
            by_card[s.card].append(s)
        if s.period_start:
            spans[s.card].append(s)
    billed_on: dict[str, int] = {}  # a card without statements: the day its cycles are taken to end
    for card, bills in _group(payments, lambda p: p.card).items():
        if card not in by_card:
            billed_on[card] = _usual_day([(_day(p.at) - GUESS_BILLED_BEFORE).day for p in bills])

    placed: dict[str, tuple] = {}
    for p in payments:
        paid = _day(p.at)
        own = by_card.get(p.card, [])
        if not own:
            day = billed_on[p.card]
            placed[p.id] = (None, *_cycle_ending(_end_on_or_before(paid - timedelta(days=1), day), day), "guess")
            continue
        # it pays the last cycle that ended before it was paid, on the card's billing day (the nearest statement's)
        day = _statement_end(min(own, key=lambda s: abs((_statement_end(s) - paid).days))).day
        end = _end_on_or_before(paid - timedelta(days=1), day)
        pays = [s for s in own if abs((_statement_end(s) - end).days) <= SAME_CYCLE and _statement_end(s) < paid]
        if pays:  # that statement is one you added
            s = min(pays, key=lambda s: abs((_statement_end(s) - end).days))
            end = _statement_end(s)
            start = date.fromisoformat(s.period_start) if s.period_start else _cycle_ending(end, end.day)[0]
            placed[p.id] = (s.id, start, end, "statement")
        else:
            placed[p.id] = (None, *_cycle_ending(end, day), "card")

    for p in payments:  # a cycle a file of the card lists whole: its purchases are counted one by one
        covered, start, end, how = placed[p.id]
        whole = [s for s in spans.get(p.card, ()) if date.fromisoformat(s.period_start) <= start and end <= _statement_end(s)]
        if not covered and whole:
            placed[p.id] = (whole[0].id, start, end, how)

    estimates = _estimates(payments, placed, txns)
    changed = 0
    for p in payments:
        covered, start, end, how = placed[p.id]
        counted, estimate = estimates.get(p.id, (0.0, 0.0))
        new = (covered, start, end, how, counted, estimate)
        if new != (p.covered_by, p.pays_from, p.pays_to, p.cycle, p.counted, p.estimate):
            p.covered_by, p.pays_from, p.pays_to, p.cycle, p.counted, p.estimate = new
            changed += 1
    return changed


def _group(items, key) -> dict:
    out: dict = defaultdict(list)
    for item in items:
        out[key(item)].append(item)
    return out


def _estimates(payments: list[CardPayment], placed: dict[str, tuple], txns: list[Transaction]) -> dict[str, tuple[float, float]]:
    """For each bill that pays no statement you added: (already counted, estimated card purchases). A cycle's bills
    together pay its purchases; what was paid with the card on UPI in that cycle is counted in UPI spends already,
    so it comes off. When a cycle's UPI payments are more than its bills (a payment late in a cycle can be billed
    in the next one), the rest comes off the next cycle's bills."""
    by_id = {t.id: t for t in txns}
    charged = _group((t for t in txns if _card_of(t, by_id)), lambda t: _card_of(t, by_id))
    out: dict[str, tuple[float, float]] = {}
    for card, bills in _group((p for p in payments if not placed[p.id][0]), lambda p: p.card).items():
        cycles = _group(bills, lambda p: placed[p.id][1:3])
        carry, last_end = 0.0, None
        for start, end in sorted(cycles):
            if last_end is None or start != last_end + timedelta(days=1):
                carry = 0.0  # a gap: no bill paid the cycle in between
            counted = sum(_on_card(t, by_id) for t in charged.get(card, ()) if start <= _day(t.at) <= end) + carry
            paid = sum(p.amount for p in cycles[(start, end)])
            left = paid - counted
            carry, last_end = max(0.0, -left), end
            for p in cycles[(start, end)]:
                share = p.amount / paid if paid else 0
                out[p.id] = (round(min(counted, paid) * share, 2), round(max(0.0, left) * share, 2))
    return out


def _card_of(t: Transaction, by_id: dict[str, Transaction]) -> str | None:
    """The card a record was charged to; a refund goes back to the card its payment was made with."""
    payment = by_id.get(t.refund_of or "")
    return t.card or (payment.card if payment else None)


def _on_card(t: Transaction, by_id: dict[str, Transaction]) -> float:
    """What a record charged to a card adds to its bill: a payment adds, a refund or cashback back to it takes off.
    Paying the bill itself isn't a purchase."""
    if t.kind == "bill_payment" or t.category == "transfers.card_bill":
        return 0.0
    if t.direction == "debit":
        return t.amount
    return -t.amount if t.kind in ("refund", "cashback") or t.refund_of else 0.0
