"""Decide each transaction's category, cheapest and most certain source first:

  0. your answer for that very row    (data/row_answers.json: you set this one payment, or ticked it with others)
  1. money in / cashback / refunds    (from the transaction itself; money from a known shop is a refund)
     a statement's bill payment       "PAYMENT RECEIVED - THANK YOU" → Credit card bills, before anything learned
                                      by name: a bank's wording for your payment isn't a shop
  2. your payee table                 "Mr Fake Payee" → Water
  3. your corrections                 remembered per merchant (data/merchant_memory.json, by="user")
  4. transfers to your own accounts   to or from an account you pay from, or one you said is yours
                                      (data/accounts.json) → Ignored (moving your own money around isn't
                                      spending, and showing it only confuses the totals)
     card statement rows               a loan's instalment → Ignored (the loan went to your bank account);
                                      forex, GST, late, annual fees and interest → Fees & Charges; cash
                                      withdrawals → Cash
  5. card bill payments               "Federal One Credit card", "CRED …"
  6. merchant dictionary              seed/merchants.json, with name variants
  7. what the local AI said before    remembered per merchant (by="llm"), then the bank's own category
                                      for a card purchase ("RESTAURANTS"), a hint for merchants not known yet
  8. keyword rules                    "… MEDICALS" → pharmacy, "… BAR AND RESTAURANT" → bars
  9. looks like a person              → "To people", flagged for you to label
 10. the local AI, once per new name, whose answer is remembered for next time
"""

import json
import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from functools import cache
from importlib import resources

from app import accounts, logs, userdata
from app import payees as payee_table
from app.jsonstore import JsonFile
from app.models import NO_NAME, Payee, Transaction

LLM_BATCH = 20
log = logs.get("category")

# Bump whenever decide() would place existing transactions differently; the app re-applies the rules
# to the whole ledger on its next start. 2: transfers between your own accounts are ignored.
# 3: merchant names glued to a payment gateway ("FakeshopRazorpay") are recognised.
# 4: refunds are linked to their payment and subtracted from it; money from a known shop is a refund.
# 5: "CredClub" is a card bill; UPI payments to CRED are linked to the bill in your CRED history.
# 6: transfers to your own account by its UPI address ("…4321@ABCD0000001.ifsc.npci"); more known merchants.
# 7: a merchant known by its whole name only isn't matched in names that merely contain it ("Fakeclub Swimming Academy").
# 8: phone, laptop and gadget repair shops by name ("… Mobile Repair", "… Laptop Service Centre") → Device repair.
# 9: payments with no payee name ("Unknown") are never placed by an answer given for that name; they wait for you.
# 10: credit card statement rows: bill payments, EMI, fees and cash by rule; the bank's category as a hint.
# 11: a card statement's rules follow the row, not how it was paid (a card used on UPI is a UPI payment now), and
#     nothing charged to a card (a RuPay card on UPI included) is taken for a payment to a person.
# 12: a shop's name glued to a payment gateway is recognised for every known merchant; regional utilities, dairies,
#     metros and supermarket chains are known across India.
RULES_VERSION = 12
# How long after a payment its refund can arrive, when there's no shared transaction ID to go by.
REFUND_WINDOW = timedelta(days=180)
# CRED records a bill payment within a minute or two of the UPI payment that funds it. The UPI side can be a
# little less than the bill when CRED rewards (coins, cashback) cover part of it.
CARD_BILL_WINDOW = timedelta(minutes=15)
CARD_BILL_TOLERANCE = 0.05


@dataclass
class Verdict:
    category: str
    by: str
    confidence: float
    kind: str | None = None
    needs_review: bool = False


@dataclass
class Context:
    payees: list[Payee]
    own_digits: set[str]
    memory: dict[str, dict] = field(default_factory=dict)
    rows: dict[str, str] = field(default_factory=dict)  # your answer for one payment, by its row (row_key)


# ---- names ---------------------------------------------------------------------------------

_LEGAL = re.compile(r"\b(private|pvt|limited|ltd|llp|inc|india|co|company|corporation|corp|the)\b")


# Payment gateways a shop's name can arrive glued to ("FakeshopRazorpay", "RAZORPAYFAKESHOP").
_GATEWAYS = r"razorpay|payu|cashfree|ccavenue|billdesk|juspay|easebuzz|instamojo|paytmpg"


def normalize(name: str) -> str:
    """'FAKEMART LIMITED' → 'fakemart', 'Fakeshop Sample Road Z123' → 'fakeshop sample road', 'FakeshopRazorpay' →
    'fakeshop razorpay'."""
    s = re.sub(r"['’`]", "", name.lower())
    s = re.sub(r"[^a-z0-9]+", " ", s)
    s = re.sub(rf"\b([a-z]{{3,}}?)({_GATEWAYS})\b", r"\1 \2", s)  # glued after the name
    s = re.sub(rf"\b({_GATEWAYS})([a-z]{{3,}})\b", r"\1 \2", s)  # glued before it
    s = _LEGAL.sub(" ", s)
    s = re.sub(r"\b[a-z]?\d+[a-z]?\b", " ", s)  # store codes like z583, k226, 5
    return re.sub(r"\s+", " ", s).strip()


@cache
def _dictionary() -> list[tuple[re.Pattern, str, str]]:
    rows = json.loads(resources.files("app.seed").joinpath("merchants.json").read_text(encoding="utf-8"))
    return [(re.compile(r["pattern"]), r["name"], r["category"]) for r in rows]


@cache
def category_ids() -> dict[str, dict]:
    tree = json.loads(resources.files("app.seed").joinpath("categories.json").read_text(encoding="utf-8"))
    out = {}
    for top in tree:
        out[top["id"]] = top
        for child in top.get("children", []):
            out[child["id"]] = {**child, "parent": top["id"], "excludeFromSpend": child.get("excludeFromSpend", top.get("excludeFromSpend", False))}
    return out


def same_shop(raw: str) -> str:
    """Names that are one shop share this key: the merchant list's name when it knows the shop ("Fakeclub" and
    "Fakeclub1" are both Fakeclub), otherwise the name without case, punctuation, company suffixes or store
    codes ("FAKEMART LIMITED" = "fakemart"). Names that only share a word ("Fakeclub Swimming Academy") differ."""
    return merchant_name(raw) or normalize(raw) or raw.strip().lower()


def merchant_name(raw: str) -> str | None:
    norm = normalize(raw)
    return next((name for pattern, name, _ in _dictionary() if pattern.search(norm)), None)


KEYWORDS: list[tuple[str, re.Pattern]] = [
    (cat, re.compile(p))
    for cat, p in [
        # a device and a repair word, and not a top-up shop: "… Mobile Repair", "… Laptop Service Centre", "Phone Doctor"
        ("shopping.device_repairs", r"^(?!.*\b(recharge|prepaid|postpaid)\b).*\b(mobiles?|phones?|cell ?phones?|laptops?|computers?|"
                                    r"gadgets?|iphones?|ipads?|macbooks?|tablets?|smart ?watch(es)?)\b.*\b(repairs?|repairing|"
                                    r"servic(e|es|ing)|care|clinic|doctor)\b"),
        ("travel.hotels", r"\b(lodge|resort|residency|inn|homestay|guest ?house|hospitality)\b"),
        ("food.drinks", r"\b(bar|liquor|wines?|beer|pub|brew(ery|ing)?|spirits)\b"),
        ("food.snacks", r"\b(tea|chai|coffee|juic\w*|bakery|bakes|iyengars?|sweets?|momos?|fuchka|chaat|vada ?pav|pan stall|paan|snacks?)\b"),
        ("food.restaurants", r"\b(restaurant|restro|dhaba|biryani|kitchen|cafe|bistro|eatery|food plaza|foods?|mess|canteen|tiffin|fast food)\b"),
        ("health.pharmacy", r"\b(medicals?|medicos?|pharma(cy)?|chemists?|drugs?)\b"),
        ("health.medical", r"\b(hospitals?|clinic|diagnostics?|polyclin\w*|labs?|dental|healthcare|nursing)\b"),
        ("transport.fuel", r"\b(fuels?|petrol|filling station|petroleum)\b"),
        ("personal_care", r"\b(salon|beauty|spa|parlou?r|barber|unisex|grooming)\b"),
        ("shopping.apparel", r"\b(garments?|fashions?|clothing|textiles?|apparels?|footwear|boutique)\b"),
        ("groceries.local", r"\b(kirana|provisions?|general store|variety store|departmental|super ?market|supermart|mart|fresh|vegetables?|fruits?|dairy|milk|traders|stores?)\b"),
        ("education", r"\b(school|college|academy|institute|education|university|coaching|tuition)\b"),
        ("bills.mobile", r"\b(recharge|prepaid|postpaid)\b"),
    ]
]

_BUSINESS_WORDS = re.compile(
    r"\b(store|stores|shop|traders?|enterprises?|services?|cent(er|re)|hotel|restaurant|cafe|mart|pvt|ltd|limited|llp|"
    r"company|corp\w*|foods?|bar|studio|medicals?|agency|agencies|industries|solutions|technologies|stall|house|point|"
    r"plaza|world|bazaar|emporium|fresh|express|online|digital|systems|drops|zone|adda|bank|account)\b",
    re.IGNORECASE,
)
_HONORIFIC = re.compile(r"^(mr|mrs|ms|miss|dr|shri|sri|smt)\.?\s", re.IGNORECASE)
_MASKED = re.compile(r"^(bank account\s+)?[x*]{2,}\d{2,}$", re.IGNORECASE)
# CRED appears as "CRED", "CRED Club", "CredClub" or its company, Dreamplug.
_CARD_BILL = re.compile(r"credit ?card|\bcred(?: ?club)?\b|dreamplug|onecard|card ?bill|cc ?bill|bill ?desk.*card", re.IGNORECASE)
_OWN_FUNDING = re.compile(r"^fund\b.*\baccount\b", re.IGNORECASE)

# What a card statement charges you besides purchases. The specific ones are sure; a bare "fee"/"charges" is
# checked last, after merchants and keywords ("XYZ SCHOOL FEES" is education, not a bank fee).
_CARD_FEES = [
    ("fees.forex", re.compile(r"foreign currency|forex|cross ?currency|currency conversion|mark ?up|\bdcc\b", re.IGNORECASE)),
    ("fees.tax", re.compile(r"\b(?:gst|igst|cgst|sgst|service tax)\b", re.IGNORECASE)),
    ("fees.late", re.compile(r"late (?:payment )?(?:fee|charge)|overdue (?:fee|charge)|over ?limit", re.IGNORECASE)),
    ("fees.annual", re.compile(r"annual (?:fee|charge)|membership fee|joining fee|renewal fee", re.IGNORECASE)),
    ("fees.interest", re.compile(r"\binterest\b|finance charges?", re.IGNORECASE)),
]
_CARD_FEE_ANY = re.compile(r"\bfees?\b|\bcharges?\b|surcharge|processing", re.IGNORECASE)
_CARD_CASH = re.compile(r"cash (?:withdrawal|advance)|\batm\b", re.IGNORECASE)


@cache
def _bank_categories() -> list[tuple[re.Pattern, str]]:
    rows = json.loads(resources.files("app.seed").joinpath("bank_categories.json").read_text(encoding="utf-8"))
    return [(re.compile(r["pattern"], re.IGNORECASE), r["category"]) for r in rows]


def bank_category(label: str | None) -> str | None:
    """Our category for a bank's own category label on a card statement ("RESTAURANTS" → Restaurants & cafés)."""
    return next((cat for pattern, cat in _bank_categories() if label and pattern.search(label)), None)


def _card_rule(t: Transaction) -> "Verdict | None":
    """What a card statement row is, when its wording says so."""
    if t.kind == "bill_payment":
        return Verdict("transfers.card_bill", "rule", 0.95)
    if t.kind == "transfer":
        return Verdict("ignored", "rule", 0.9)  # a loan's instalment: the loan went to your bank account
    if t.direction == "debit":
        text = f"{t.payee} {t.note}"
        for category, pattern in _CARD_FEES:
            if pattern.search(text):
                return Verdict(category, "rule", 0.95)
        if _CARD_CASH.search(text):
            return Verdict("cash", "rule", 0.95)
    return None


_ON_CARD = re.compile(r"X{4}\d{2}")


def paid_with_card(t: Transaction) -> bool:
    """Charged to a credit card: a statement's row, or an app's record naming a card ("XXXX99"). A card never pays a
    person: UPI takes credit cards for payments to shops only."""
    return t.channel == "card" or "cardRow" in t.refs or bool(t.card) or bool(_ON_CARD.fullmatch(t.paid_from or ""))


def looks_like_person(raw: str) -> bool:
    if _HONORIFIC.match(raw) or _MASKED.match(raw.strip()):
        return True
    words = raw.split()
    return 2 <= len(words) <= 4 and all(w.isalpha() for w in words) and not _BUSINESS_WORDS.search(raw) and not merchant_name(raw)


def statement_bill(t: Transaction) -> bool:
    """A card statement's row for a payment to the card (you paying its bill), read as such from the statement."""
    return "cardRow" in t.refs and t.kind == "bill_payment"


def decide(t: Transaction, ctx: Context) -> Verdict | None:
    """Everything except the LLM. None means: ask the local AI."""
    if category := ctx.rows.get(row_key(t)):
        return Verdict(category, "user", 1.0)  # you set this very payment: its file was added again
    if t.kind == "cashback":
        return Verdict("income.cashback", "heuristic", 1.0)
    if t.kind == "refund":
        return Verdict("income.refund", "heuristic", 0.9)
    if statement_bill(t):
        # A statement saying you paid the card ("PAYMENT RECEIVED - THANK YOU"): never spending or money in, whatever
        # was learned about a name; only an answer for this very row (above) changes it.
        return Verdict("transfers.card_bill", "rule", 0.95)

    unnamed = t.payee == NO_NAME  # many different payees behind one placeholder: nothing about the name applies
    if not unnamed and (payee := payee_table.match_payee(t.payee, ctx.payees)):
        return Verdict(payee.category, "payee", 1.0)

    # Shops don't send you money except to give it back.
    if t.direction == "credit" and t.kind == "income" and merchant_name(t.payee):
        return Verdict("income.refund", "dictionary", 0.9, kind="refund")

    norm = normalize(t.payee)
    mem = None if unnamed else ctx.memory.get(norm)
    if mem and mem["by"] == "user":
        return Verdict(mem["category"], "user", 1.0)

    if "cardRow" in t.refs and (card := _card_rule(t)):
        return card

    # Money moved between your own accounts is left out entirely, in both directions, however it's named.
    digits = accounts.digits_of(t.payee) or accounts.digits_of(t.payee_handle)
    if digits and any(digits.endswith(own) for own in ctx.own_digits):
        return Verdict("ignored", "self", 0.95, kind="transfer")
    if _OWN_FUNDING.match(t.payee):
        return Verdict("ignored", "self", 0.8, kind="transfer", needs_review=True)
    if t.kind == "transfer" and t.payee == "UPI Lite":  # topping up (or emptying) your own UPI Lite wallet
        return Verdict("ignored", "self", 1.0, kind="transfer")

    if t.kind == "income":
        return Verdict("income.received", "heuristic", 0.9)

    if _CARD_BILL.search(t.payee):
        return Verdict("transfers.card_bill", "heuristic", 0.9, kind="bill_payment")

    for pattern, _, category in _dictionary():
        if pattern.search(norm):
            return Verdict(category, "dictionary", 0.95)

    if mem and mem["by"] == "llm" and not (mem["category"] == "transfers.p2p" and paid_with_card(t)):
        return Verdict(mem["category"], "learned", 0.7, needs_review=mem["category"] == "transfers.p2p")

    if hinted := bank_category(t.merchant_category):
        # the bank's category: good for "restaurant or not", coarse beyond it, so a general one asks you
        return Verdict(hinted, "heuristic", 0.7, needs_review="." not in hinted)

    for category, pattern in KEYWORDS:
        if pattern.search(norm):
            return Verdict(category, "heuristic", 0.75)

    if "cardRow" in t.refs and t.direction == "debit" and _CARD_FEE_ANY.search(f"{t.payee} {t.note}"):
        return Verdict("fees", "rule", 0.8)

    if not paid_with_card(t) and (_HONORIFIC.match(t.payee) or _MASKED.match(t.payee.strip())):
        return Verdict("transfers.p2p", "heuristic", 0.6, needs_review=True)
    if unnamed:  # not for the local AI either: it would only see the word "Unknown"
        return Verdict("uncategorized", "default", 0.0, needs_review=True)
    return None  # includes plain names: the local AI tells "MS EXAMPLE PERSON" from "Example Juice Bar"


def fallback(t: Transaction) -> None:
    """When the local AI isn't available or can't place a name."""
    if not paid_with_card(t) and looks_like_person(t.payee):  # a card is never used to pay a person
        apply(t, Verdict("transfers.p2p", "heuristic", 0.4, needs_review=True))
    else:
        t.category, t.categorized_by, t.confidence, t.needs_review = "uncategorized", "default", 0.0, True


def apply(t: Transaction, v: Verdict) -> None:
    t.category, t.categorized_by, t.confidence = v.category, v.by, v.confidence  # type: ignore[assignment]
    t.needs_review = t.needs_review or v.needs_review
    if v.kind:
        t.kind = v.kind  # type: ignore[assignment]


# ---- memory of past answers ------------------------------------------------------------------


def _memory_file() -> JsonFile:
    return userdata.json_file("merchant_memory.json", default=dict)


def load_memory() -> dict[str, dict]:
    return _memory_file().read()


def remember(entries: dict[str, str], by: str) -> None:
    now = datetime.now(timezone.utc).isoformat()

    def apply_(mem: dict) -> dict:
        for norm, category in entries.items():
            if norm == normalize(NO_NAME):
                continue  # an answer for "no name" would land on every payment without one
            if by == "llm" and mem.get(norm, {}).get("by") == "user":
                continue  # never let a guess overwrite a correction
            mem[norm] = {"category": category, "by": by, "at": now}
        return mem

    _memory_file().update(apply_)


def row_key(t: Transaction) -> str:
    """What finds one payment again when its file is added again: its row on a card statement, or the app's own
    ID for it; else its id."""
    if row := t.refs.get("cardRow"):
        return f"card:{row}"
    if ref := t.refs.get("txnId") or t.refs.get("utr"):
        return f"ref:{ref}:{t.direction}"
    return f"id:{t.id}"


def _row_file() -> JsonFile:
    return userdata.json_file("row_answers.json", default=dict)


def remember_rows(txns: list[Transaction]) -> None:
    """Your category for these payments, one by one: a file deleted and added again gets them back."""
    answers = {row_key(t): t.category for t in txns}
    _row_file().update(lambda rows: {**rows, **answers})


def forget_rows(txns: list[Transaction]) -> None:
    """These payments are no longer yours to have set (an undo): their rows' answers go."""
    keys = {row_key(t) for t in txns}
    _row_file().update(lambda rows: {k: v for k, v in rows.items() if k not in keys})


def forget(names: list[str]) -> None:
    """Drop what's remembered for these payee names, your corrections included."""
    keys = {normalize(n) or n.lower() for n in names}
    _memory_file().update(lambda mem: {k: v for k, v in mem.items() if k not in keys})


def build_context(txns: list[Transaction]) -> Context:
    from app import vault

    own = {d for t in txns if t.paid_from and (d := re.sub(r"\D", "", t.paid_from)) and len(d) >= 4}
    own |= {i.last4 for i in vault.list_instruments()}
    own |= {a.last4 for a in accounts.list_accounts()}
    return Context(payees=payee_table.list_payees(), own_digits=own, memory=load_memory(), rows=_row_file().read())


def categorize_offline(txns: list[Transaction], ctx: Context) -> list[Transaction]:
    """Categorize in place; return the ones only the local AI can place (not user-set ones)."""
    unknown = []
    for t in txns:
        if t.categorized_by == "user":
            continue
        verdict = decide(t, ctx)
        if verdict:
            apply(t, verdict)
        else:
            t.category, t.categorized_by, t.confidence = "uncategorized", "default", 0.0
            unknown.append(t)
    return unknown


def recategorize(txns: list[Transaction], only: set[str] | None = None) -> int:
    """Re-run the offline rules over the whole ledger (after the payee table, a correction or the rules
    changed) and save it. Hand-set transactions, and earlier AI answers the rules can't improve on, stay.
    `only`: just these, read again by a better reader, so whatever the rules now say about them goes."""
    from app import ledger

    ctx = build_context(txns)
    before = {t.id: (t.category, t.needs_review, t.refund_of, t.settles) for t in txns}
    for t in txns:
        if t.categorized_by == "user" or (only is not None and t.id not in only):
            continue
        verdict = decide(t, ctx)
        if verdict is None:
            if t.categorized_by == "self" or (only and t.categorized_by == "rule"):  # what placed it no longer applies
                fallback(t)
            continue
        prev = t.category
        if (only is not None or t.categorized_by in ("payee", "user", "self", "refund") or verdict.by in ("payee", "user", "self")
                or verdict.confidence >= t.confidence):
            reviewed = not t.needs_review
            apply(t, verdict)
            if verdict.by in ("payee", "user"):
                t.needs_review = False
            elif reviewed and t.category == prev:
                t.needs_review = False
            elif t.category != prev and verdict.confidence >= 0.9 and not verdict.needs_review:
                t.needs_review = False  # a sure rule now places what a weaker guess had flagged
    link_refunds(txns)
    link_card_bills(txns, ledger.load_card_payments())
    ledger.save_transactions(txns)
    return sum(before[t.id] != (t.category, t.needs_review, t.refund_of, t.settles) for t in txns)


def link_card_bills(txns: list[Transaction], bills: list) -> None:
    """Paying a card bill in the CRED app with PhonePe shows up twice: a UPI payment to CRED in PhonePe (the
    bank account it left) and the bill in your CRED history (the card it paid). Link the two, by amount within
    CARD_BILL_WINDOW, so the UPI side says which card it paid. It's a card bill either way, never spending;
    the Credit cards section counts the bill once, from CRED. The amounts can differ a little
    (CARD_BILL_TOLERANCE) when CRED rewards paid part of the bill; an exact amount is preferred.
    Changes `txns` in place."""
    free = list(bills)
    for t in sorted(txns, key=lambda t: t.at):
        if t.direction != "debit" or not _CARD_BILL.search(t.payee):
            t.settles = None
            continue
        near = [b for b in free if abs(b.amount - t.amount) <= b.amount * CARD_BILL_TOLERANCE and abs(b.at - t.at) <= CARD_BILL_WINDOW]
        bill = min(near, key=lambda b: (abs(b.amount - t.amount) > 0.005, abs(b.at - t.at)), default=None)
        t.settles = bill.id if bill else None
        if bill:
            free.remove(bill)


def _refund_key(payee: str) -> str:
    return merchant_name(payee) or normalize(payee)


def link_refunds(txns: list[Transaction]) -> None:
    """File each refund with the payment it gives money back for, so it's subtracted from that spending
    rather than counted as money in: by the app's transaction ID (PhonePe gives a refund its payment's),
    else the latest earlier payment to the same shop, within REFUND_WINDOW, with enough left to refund.
    A refund whose payment isn't in the ledger (paid by card, or before your first statement) stays
    under Refunds. A purchase turned into EMIs is credited back with its exact amount, but rarely its shop's name:
    it's matched by amount on the same card, and without its purchase in the ledger it's left out (its instalments
    carry the cost). Changes `txns` in place."""
    from app.parsers.card_statement import is_emi

    payments = [t for t in txns if t.direction == "debit"]
    by_ref = {t.refs["txnId"]: t for t in payments if t.refs.get("txnId")}
    by_shop: dict[str, list[Transaction]] = defaultdict(list)
    for p in payments:
        by_shop[_refund_key(p.payee)].append(p)
    left = {p.id: p.amount for p in payments}  # how much of each payment can still come back

    for r in sorted((t for t in txns if t.kind == "refund" and t.direction == "credit"), key=lambda t: t.at):
        fits = lambda p: left[p.id] + 0.005 >= r.amount  # noqa: E731
        orig = by_ref.get(r.refs.get("txnId", ""))
        emi = r.channel == "card" and is_emi(r.note or "")
        if emi:  # the same card's purchase of exactly this amount, the latest before it
            orig = max((p for p in payments if p.card == r.card and abs(p.amount - r.amount) <= 0.005 and p.at <= r.at
                        and r.at - p.at <= REFUND_WINDOW and fits(p) and not is_emi(p.note or "")), key=lambda p: p.at, default=None)
            if orig is None:
                r.refund_of = None
                if r.categorized_by != "user":
                    r.category, r.categorized_by, r.confidence, r.needs_review = "ignored", "rule", 0.9, False
                continue
        if orig is None or not fits(orig):
            earlier = [p for p in by_shop.get(_refund_key(r.payee), []) if p.at <= r.at and r.at - p.at <= REFUND_WINDOW and fits(p)]
            # the same amount first (a full refund), then the most recent
            orig = min(earlier, key=lambda p: (abs(p.amount - r.amount) > 0.005, r.at - p.at), default=None)
        if orig is None and r.channel == "card" and r.card:  # a card's refund under another name: its purchase of exactly that much
            orig = max((p for p in payments if p.card == r.card and abs(p.amount - r.amount) <= 0.005 and p.at <= r.at
                        and r.at - p.at <= REFUND_WINDOW and fits(p)), key=lambda p: p.at, default=None)
        if orig is None:
            r.refund_of = None
            if r.categorized_by == "refund":
                r.category, r.categorized_by, r.confidence = "income.refund", "heuristic", 0.9
            continue
        left[orig.id] -= r.amount
        r.refund_of = orig.id
        if r.categorized_by != "user":
            r.category, r.categorized_by, r.confidence, r.needs_review = orig.category, "refund", 1.0, False


def apply_new_rules() -> int | None:
    """At startup: if the rules or your payee table changed since the ledger was last categorized
    (payees.json edited by hand counts too), re-apply them. None if nothing changed."""
    from app import ledger

    state = userdata.json_file("state.json", default=dict)
    seen = state.read()
    fingerprint = payee_table.fingerprint()
    if seen.get("rulesVersion") == RULES_VERSION and seen.get("payeesFingerprint") == fingerprint:
        return None
    with ledger.editing():
        changed = recategorize(ledger.load_transactions())
    state.update(lambda s: {**s, "rulesVersion": RULES_VERSION, "payeesFingerprint": fingerprint})
    return changed


# ---- the local AI ----------------------------------------------------------------------------

_LLM_CATEGORIES = [
    ("food.delivery", "food delivery apps"), ("food.restaurants", "restaurants, dhabas, hotels serving food"),
    ("food.snacks", "tea stalls, cafés, bakeries, sweets, street food"), ("food.drinks", "bars, pubs, liquor shops"),
    ("groceries.quick_commerce", "Blinkit, Zepto, Instamart"), ("groceries.supermarket", "supermarkets"),
    ("groceries.local", "kirana, vegetables, fruits, milk, water cans"), ("groceries.meat_fish", "meat and fish shops"),
    ("transport.ride_hailing", "cabs, autos, bike taxis"), ("transport.fuel", "petrol pumps"), ("transport.public", "metro, bus, train tickets"),
    ("shopping.online", "online shopping"), ("shopping.apparel", "clothes and shoes"), ("shopping.electronics", "buying electronics"),
    ("shopping.device_repairs", "repairing and servicing phones, laptops and gadgets"),
    ("shopping.home", "home goods, furniture, hardware"), ("bills.mobile", "mobile recharge"), ("bills.broadband", "internet"),
    ("bills.electricity", "electricity"), ("bills.water", "water"), ("bills.gas", "cooking gas"), ("entertainment.ott", "streaming"),
    ("entertainment.events", "movies, events"), ("subscriptions.software", "apps, software, SaaS"), ("health.pharmacy", "pharmacy"),
    ("health.medical", "doctors, hospitals, labs"), ("health.fitness", "gym, sports, supplements"), ("travel.hotels", "hotels and lodges for stays"),
    ("travel.flights", "flights"), ("home.rent", "rent"), ("home.furniture_rental", "furniture/appliance rental"),
    ("home.services", "home services, repairs, laundry"), ("education", "courses, schools"), ("personal_care", "salon, beauty"),
    ("insurance", "insurance"), ("investments", "investments"), ("fees", "government fees, taxes, bank charges"),
    ("transfers.p2p", "an individual person, not a business"), ("uncategorized", "can't tell"),
]

_LLM_PROMPT = """You categorize payees from an Indian person's UPI and card payments.
For each payee name below, pick the single best category id.
- If the name contains a business word (Store, Enterprises, Traders, Hotel, Drops, Services, Centre…) or
  reads like a shop, brand or restaurant name, choose the business category that fits best.
- Choose transfers.p2p only when the name is clearly just a person: a first name and surname, or initials.
- Use the typical amount as a hint: small repeated amounts are usually food, snacks or daily needs.

Categories:
{categories}

Payees (with a typical amount paid):
{payees}"""


async def categorize_with_llm(txns: list[Transaction], on_progress=None) -> int:
    """Ask the local AI about each distinct unknown payee once; remember the answers. Returns how many
    names it placed."""
    from app.llm import llm

    names: dict[str, list[Transaction]] = {}
    for t in txns:
        names.setdefault(normalize(t.payee) or t.payee.lower(), []).append(t)
    if not names:
        return 0

    valid = {cid for cid, _ in _LLM_CATEGORIES}
    schema = {
        "type": "object",
        "properties": {"results": {"type": "array", "items": {
            "type": "object",
            "properties": {"payee": {"type": "string"}, "category": {"type": "string", "enum": sorted(valid)}},
            "required": ["payee", "category"],
        }}},
        "required": ["results"],
    }
    categories = "\n".join(f"- {cid}: {desc}" for cid, desc in _LLM_CATEGORIES)
    learned: dict[str, str] = {}
    keys = list(names)
    batches = (len(keys) + LLM_BATCH - 1) // LLM_BATCH
    log.info("asking the local AI to place %d payee name(s) in %d batch(es); only names and a typical amount are sent", len(keys), batches)
    async with llm.session() as ai:
        for n, start in enumerate(range(0, len(keys), LLM_BATCH), 1):
            batch = keys[start:start + LLM_BATCH]
            if on_progress:
                on_progress(start, len(keys))
            listing = "\n".join(
                f"{i + 1}. {names[k][0].payee} (₹{sorted(t.amount for t in names[k])[len(names[k]) // 2]:,.0f})"
                for i, k in enumerate(batch)
            )
            raw = await ai.chat([{"role": "user", "content": _LLM_PROMPT.format(categories=categories, payees=listing)}],
                                schema=schema, purpose=f"categorize payees, batch {n}/{batches} ({len(batch)} names)")
            try:
                results = json.loads(raw).get("results", [])
            except json.JSONDecodeError:
                log.warning("batch %d/%d: the model's answer wasn't valid JSON; those names go to review", n, batches)
                continue
            by_name = {normalize(r["payee"]) or r["payee"].lower(): r["category"] for r in results if r.get("category") in valid}
            for i, key in enumerate(batch):
                category = by_name.get(key) or (results[i]["category"] if i < len(results) and results[i].get("category") in valid else None)
                if category and category != "uncategorized":
                    learned[key] = category

    remember(learned, by="llm")
    people = sum(c == "transfers.p2p" for c in learned.values())
    log.info("local AI placed %d/%d names: %d as shops/services, %d as people (those go to review)%s",
             len(learned), len(keys), len(learned) - people, people,
             f"; {len(keys) - len(learned)} it couldn't place" if len(learned) < len(keys) else "")
    for key, category in learned.items():
        for t in names[key]:
            if category == "transfers.p2p" and paid_with_card(t):
                fallback(t)  # a card is never used to pay a person: the name is a shop the AI didn't know
                continue
            t.category, t.categorized_by, t.confidence = category, "llm", 0.7  # type: ignore[assignment]
            t.needs_review = category == "transfers.p2p"
    for key in set(names) - set(learned):
        for t in names[key]:
            fallback(t)
    return len(learned)
