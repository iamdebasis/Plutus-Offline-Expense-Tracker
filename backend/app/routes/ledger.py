import re
from collections import defaultdict

from fastapi import APIRouter, HTTPException

from app import accounts, categorize, ledger, logs, payees, statements
from app.models import NO_NAME, CardPayment, CardStatement, Model, OwnAccount, Payee, Transaction

router = APIRouter(prefix="/api")
log = logs.get("category")


@router.get("/transactions")
def transactions() -> list[Transaction]:
    return ledger.load_transactions()


@router.get("/card-payments")
def card_payments() -> list[CardPayment]:
    return ledger.load_card_payments()


@router.get("/card-statements")
def card_statements() -> list[CardStatement]:
    """The credit card statements you added: period, the bank's figures, and whether the rows add up to them."""
    return statements.list_statements()


class CategorizeRequest(Model):
    category: str
    transaction_id: str | None = None
    payee: str | None = None  # apply to every payment to this payee, now and in future imports
    label: str | None = None  # for people: what they are to you, e.g. "Water delivery"


@router.post("/categorize")
def set_category(req: CategorizeRequest) -> dict:
    cats = categorize.category_ids()
    if req.category not in cats:
        raise HTTPException(400, {"code": "bad_category", "message": f"Unknown category {req.category}"})
    txns = ledger.load_transactions()

    if req.payee == NO_NAME:
        raise HTTPException(400, {"code": "no_name", "message": _NO_NAME_MESSAGE})
    if req.payee:
        matching = [t for t in txns if t.payee == req.payee]
        if not matching:
            raise HTTPException(404, {"code": "not_found", "message": "No payments to that payee"})
        corrections: dict[str, str] = {}
        before = _states(txns)
        saved_as = _keep_answer(req.payee, req.category, req.label, matching, corrections)
        categorize.remember(corrections, by="user")
        for t in matching:
            t.needs_review = False
        recategorize(txns)
        updated = _changed(txns, before)
        where = {"payee": "saved to your payee table", "merchant": "remembered as your correction",
                 "account": "saved as one of your own accounts (data/accounts.json)"}[saved_as]
        log.info("you set %s → %s (%s); %d transaction(s) updated", req.payee, cats[req.category]["label"], where, updated)
        return {"updated": updated, "savedAs": saved_as, "account": accounts.last4(req.payee) if saved_as == "account" else None}

    if req.transaction_id:
        t = next((t for t in txns if t.id == req.transaction_id), None)
        if t is None:
            raise HTTPException(404, {"code": "not_found", "message": "No such transaction"})
        t.category, t.categorized_by, t.confidence, t.needs_review = req.category, "user", 1.0, False
        categorize.link_refunds(txns)  # its refunds follow it
        ledger.save_transactions(txns)
        log.info("you set one payment to %s → %s", t.payee, cats[req.category]["label"])
        return {"updated": 1, "savedAs": "transaction", "related": _same_shop(t, txns), "account": _account_to_offer(t, req.category, txns)}

    raise HTTPException(400, {"code": "missing_target", "message": "Give a transactionId or a payee"})


_NO_NAME_MESSAGE = ("These payments have no payee name, so they're different payees under one label and one answer can't "
                    "cover them. Set them one by one in the transactions list.")


def _account_to_offer(t: Transaction, category: str, txns: list[Transaction]) -> dict | None:
    """Ignoring a transfer to a bank account that isn't known to be yours: the page asks whether it is, so every
    transfer to and from it can be left out (POST /api/accounts)."""
    digits = accounts.last4(t.payee, t.payee_handle) if category == "ignored" else None
    if not digits or digits in categorize.build_context(txns).own_digits:
        return None
    return {"last4": digits, "payee": t.payee}


def _changeable(t: Transaction) -> bool:
    """A payment whose category you'd change with its shop's: not a refund or cashback, which follow their own rules."""
    return t.kind not in ("refund", "cashback")


def _same_shop(edited: Transaction, txns: list[Transaction]) -> list[dict]:
    """The other payments to the shop you just re-filed one payment of, per name as it appears on them."""
    if edited.payee == NO_NAME:
        return []  # no shop to share: every payment without a name is someone else
    key = categorize.same_shop(edited.payee)
    names: dict[str, dict] = {}
    for t in txns:
        if t.id == edited.id or not _changeable(t) or categorize.same_shop(t.payee) != key:
            continue
        n = names.setdefault(t.payee, {"payee": t.payee, "count": 0, "already": 0})
        n["count"] += 1
        n["already"] += t.category == edited.category
    # the name you edited first, then the rest by how many payments they have
    return sorted(names.values(), key=lambda n: (n["payee"] != edited.payee, -n["count"], n["payee"]))


class ShopChange(Model):
    payees: list[str]
    category: str


@router.post("/categorize/shop")
def set_shop_category(req: ShopChange) -> dict:
    """"Change all" after re-filing one payment: every payment to these names takes the category, including ones
    you'd set one by one before (you asked for all of them), and it's remembered for their future payments."""
    cats = categorize.category_ids()
    if req.category not in cats:
        raise HTTPException(400, {"code": "bad_category", "message": f"Unknown category {req.category}"})
    names = set(req.payees) - {NO_NAME}
    if not names:
        raise HTTPException(400, {"code": "no_name", "message": _NO_NAME_MESSAGE})
    txns = ledger.load_transactions()
    updated = 0
    for t in txns:
        if t.payee in names and _changeable(t):
            updated += (t.category, t.needs_review) != (req.category, False)
            t.category, t.categorized_by, t.confidence, t.needs_review = req.category, "user", 1.0, False
    categorize.remember({categorize.normalize(n) or n.lower(): req.category for n in names}, by="user")
    categorize.link_refunds(txns)
    ledger.save_transactions(txns)
    if changed := _accounts_follow(names, req.category):
        updated += categorize.recategorize(txns)  # transfers the other way, and under other names, follow
    log.info("you set every payment to %s → %s; %d transaction(s) updated", ", ".join(sorted(names)), cats[req.category]["label"], updated)
    return {"updated": updated, "accounts": changed}


def _accounts_follow(names: set[str], category: str) -> list[str]:
    """Names that are bank accounts: ignoring them marks the account as yours; any other category unmarks it.
    Returns the last four digits of each account that changed."""
    changed = []
    for name in sorted(names):
        digits = accounts.last4(name)
        if digits and category == "ignored":
            accounts.add(digits, seen_as=name)
            changed.append(digits)
        elif digits and accounts.remove(digits):
            changed.append(digits)
    return changed


class Answer(Model):
    payee: str
    category: str
    label: str | None = None


class Answers(Model):
    items: list[Answer]


@router.post("/categorize/bulk")
def set_categories(req: Answers) -> dict:
    """Many payees at once ("Looks right" for the whole review list): each answer is kept exactly as the
    single one would be, and the ledger is re-sorted once."""
    cats = categorize.category_ids()
    if bad := sorted({a.category for a in req.items if a.category not in cats}):
        raise HTTPException(400, {"code": "bad_category", "message": f"Unknown categories {bad}"})
    txns = ledger.load_transactions()
    by_payee: dict[str, list[Transaction]] = defaultdict(list)
    for t in txns:
        by_payee[t.payee].append(t)

    corrections: dict[str, str] = {}
    before = _states(txns)
    kept = {"payee": 0, "merchant": 0, "account": 0}
    for a in req.items:
        matching = by_payee.get(a.payee) if a.payee != NO_NAME else None  # never one answer for every unnamed payment
        if not matching:
            continue
        kept[_keep_answer(a.payee, a.category, a.label, matching, corrections)] += 1
        for t in matching:
            t.needs_review = False
    categorize.remember(corrections, by="user")
    recategorize(txns)
    updated = _changed(txns, before)
    log.info("you confirmed %d payee(s) at once: %d to your payee table, %d remembered as corrections, %d as your own accounts; "
             "%d transaction(s) updated", sum(kept.values()), kept["payee"], kept["merchant"], kept["account"], updated)
    return {"updated": updated, "confirmed": sum(kept.values()), "payees": kept["payee"], "remembered": kept["merchant"],
            "accounts": kept["account"]}


def _states(txns: list[Transaction]) -> dict[str, tuple]:
    return {t.id: (t.category, t.needs_review) for t in txns}


def _changed(txns: list[Transaction], before: dict[str, tuple]) -> int:
    """Payments whose category or review flag an answer changed (marking them reviewed counts)."""
    return sum(before.get(t.id) != (t.category, t.needs_review) for t in txns)


def _keep_answer(payee: str, category: str, label: str | None, matching: list[Transaction], corrections: dict[str, str]) -> str:
    """Where an answer about a payee is kept, so it holds for their future payments too, all of it in data/.
    A bank account you ignore ("Bank Account XXXXXX1234") is one of your own: it goes to your accounts, so
    transfers to and from it are left out under any name. A person you put a name to ("Water delivery") goes
    into your payee table. Anything else (a shop, or a person you simply confirmed) is remembered as your
    correction for that name. Adds to `corrections`; returns "account", "payee" or "merchant"."""
    label = (label or "").strip()
    digits = accounts.last4(payee)
    if digits and category == "ignored":
        accounts.add(digits, seen_as=payee, label=label)
        categorize.forget([payee])  # an older answer for this name would otherwise win over the account
        return "account"
    if digits and accounts.remove(digits):
        log.info("••%s is no longer one of your accounts: you gave %s a category", digits, payee)
    is_person = any(t.category == "transfers.p2p" for t in matching) or categorize.looks_like_person(payee)
    if is_person and label:
        slug = re.sub(r"[^a-z0-9]+", "-", payee.lower()).strip("-")
        payees.upsert_payee(Payee(id=slug, name=payee, label=label, category=category))
        return "payee"
    corrections[categorize.normalize(payee) or payee.lower()] = category
    return "merchant"


@router.post("/recategorize")
def recategorize_all() -> dict:
    updated = recategorize(ledger.load_transactions())
    log.info("rules re-applied to the whole ledger: %d transaction(s) changed", updated)
    return {"updated": updated}


recategorize = categorize.recategorize


# ---- your own accounts -----------------------------------------------------------------------------------


@router.get("/accounts")
def own_accounts() -> list[OwnAccount]:
    return accounts.list_accounts()


class AccountClaim(Model):
    transaction_id: str | None = None  # the transfer you just ignored
    payee: str | None = None  # or the name the account appears under
    label: str = ""


@router.post("/accounts")
def claim_account(req: AccountClaim) -> dict:
    """"Yes, it's mine": every transfer to or from this account is left out from now on."""
    txns = ledger.load_transactions()
    t = next((t for t in txns if t.id == req.transaction_id), None) if req.transaction_id else None
    name = t.payee if t else (req.payee or "")
    digits = accounts.last4(name, t.payee_handle if t else None)
    if not digits:
        raise HTTPException(400, {"code": "not_an_account", "message": "That payee doesn't show a bank account number"})
    account = accounts.add(digits, seen_as=name, label=req.label)
    categorize.forget([name])
    updated = categorize.recategorize(txns)
    log.info("••%s is one of your accounts now (%s); %d transaction(s) left out", digits, name, updated)
    return {"account": account, "updated": updated}


@router.delete("/accounts/{last4}")
def forget_account(last4: str) -> dict:
    """"Not mine": transfers to and from it count again, sorted by the usual rules."""
    removed = accounts.remove(last4)
    if removed is None:
        raise HTTPException(404, {"code": "not_found", "message": "That account isn't one of yours"})
    updated = categorize.recategorize(ledger.load_transactions())
    log.info("••%s is no longer one of your accounts; %d transaction(s) re-sorted", last4, updated)
    return {"updated": updated}
