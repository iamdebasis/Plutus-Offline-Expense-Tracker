import re
from datetime import datetime, timedelta

import pytest

from app import categorize, ledger
from app.categorize import Context, decide
from app.models import Payee, SourceRef, Transaction
from app.parsers import IST

AT = datetime(2025, 5, 1, 19, 30, tzinfo=IST)


def txn(payee, amount=100.0, utr=None, at=AT, upload="u1", **kw) -> Transaction:
    refs = {"utr": utr} if utr else {}
    return Transaction(id=f"t_{payee}_{amount}_{utr}_{upload}", at=at, amount=amount, direction="debit", payee=payee,
                       refs=refs, sources=[SourceRef(upload=upload)], **kw)


def test_same_utr_from_two_sources_is_one_transaction():
    stats, _ = ledger.upsert_transactions([txn("FAKE CHAI", 30, utr="227000000001", upload="statement")])
    assert stats.added == 1
    screenshot = txn("Fake Chai", 30, utr="227000000001", upload="screenshot", payee_handle="fake@pty")
    stats, _ = ledger.upsert_transactions([screenshot])
    assert (stats.added, stats.duplicates) == (0, 1)
    [only] = ledger.load_transactions()
    assert {s.upload for s in only.sources} == {"statement", "screenshot"}
    assert only.payee_handle == "fake@pty"  # the screenshot filled in what the statement lacked


def test_loose_match_without_shared_reference():
    ledger.upsert_transactions([txn("FAKE CHAI POINT", 30, upload="a")])
    stats, _ = ledger.upsert_transactions([txn("Fake Chai", 30, at=AT + timedelta(minutes=3), upload="b")])
    assert stats.duplicates == 1
    stats, _ = ledger.upsert_transactions([txn("Fake Chai", 30, at=AT + timedelta(hours=2), upload="c")])
    assert stats.added == 1  # two hours apart: a second cup


def test_ledger_is_sharded_by_year_and_forgets_uploads(data_dir):
    ledger.upsert_transactions([txn("A", at=AT, upload="u1"), txn("B", at=AT.replace(year=2026), upload="u2")])
    assert sorted(p.name for p in (data_dir / "ledger").iterdir()) == ["2025.json", "2026.json"]
    ledger.forget_upload("u2")
    assert [t.payee for t in ledger.load_transactions()] == ["A"]


CTX = Context(
    payees=[Payee(id="w", name="Mr Test Kumar", label="Water", category="bills.water")],
    own_digits={"4321", "5678"},
)


def verdict(payee, **kw):
    v = decide(txn(payee, **kw), CTX)
    return v and (v.category, v.by)


def test_rules_in_priority_order():
    assert verdict("Mr Test Kumar") == ("bills.water", "payee")
    # transfers between your own accounts are left out entirely
    assert verdict("XXXXXX5678") == ("ignored", "self")
    assert verdict("Bank Account XXXXXXXX4321") == ("ignored", "self")
    assert verdict("FUND FAKE BANK ACCOUNT") == ("ignored", "self")
    assert verdict("Federal One Credit card") == ("transfers.card_bill", "heuristic")
    assert verdict("GROFERS INDIA PRIVATE LIMITED") == ("groceries.quick_commerce", "dictionary")
    assert verdict("RENTMOJO") == ("home.furniture_rental", "dictionary")
    assert verdict("Swiggy Ltd") == ("food.delivery", "dictionary")
    assert verdict("SAMPLE TEA ADDA") == ("food.snacks", "heuristic")
    assert verdict("SAMPLE BAR AND RESTAURANT") == ("food.drinks", "heuristic")
    assert verdict("Mr Somebody Else") == ("transfers.p2p", "heuristic")
    assert verdict("******3456") == ("transfers.p2p", "heuristic")
    assert verdict("SOMENAME") is None  # the local AI decides: person or shop?


def test_device_repair_shops_by_name():
    assert verdict("FAKE MOBILE REPAIR") == ("shopping.device_repairs", "heuristic")
    assert verdict("Fake Laptop Service Centre") == ("shopping.device_repairs", "heuristic")
    assert verdict("FAKE PHONE DOCTOR") == ("shopping.device_repairs", "heuristic")
    assert verdict("FAKE MOBILE RECHARGE SERVICE") == ("bills.mobile", "heuristic")  # a top-up shop
    assert verdict("FAKE CAR SERVICE CENTRE") is None  # no device in the name: the local AI decides
    assert verdict("FAKE MOBILES") is None  # a phone shop, not a repair shop
    assert categorize.category_ids()["shopping.device_repairs"]["parent"] == "shopping"


def test_corrections_beat_the_dictionary_and_ai_guesses():
    ctx = Context(payees=[], own_digits=set(), memory={
        "blinkit": {"category": "shopping.online", "by": "user"},
        "fake drops": {"category": "shopping.apparel", "by": "llm"},
    })
    assert decide(txn("Blinkit"), ctx).category == "shopping.online"
    assert (decide(txn("FAKE DROPS"), ctx).category, decide(txn("FAKE DROPS"), ctx).by) == ("shopping.apparel", "learned")


def test_ai_guess_never_overwrites_a_correction():
    categorize.remember({"fake drops": "bills.water"}, by="user")
    categorize.remember({"fake drops": "shopping.apparel"}, by="llm")
    assert categorize.load_memory()["fake drops"]["category"] == "bills.water"


def test_normalize():
    assert categorize.normalize("ZOMATO LIMITED") == "zomato"
    assert categorize.normalize("Fakeshop Sample Road Z123") == "fakeshop sample road"
    assert categorize.normalize("Fakey's") == "fakeys"


def test_two_teas_in_the_same_minute_are_two_teas():
    stats, _ = ledger.upsert_transactions([
        txn("SOMENAME", 15, utr="300000000001"),
        txn("SOMENAME", 15, utr="300000000002"),
    ])
    assert (stats.added, stats.duplicates) == (2, 0)


def test_cashback_sharing_its_payments_transaction_id_is_kept():
    pay = txn("FAKE SHOP", 500, utr="700000000001")
    pay.refs["txnId"] = "T1"
    cashback = Transaction(id="cb", at=AT, amount=2, direction="credit", kind="cashback", payee="Cashback Received",
                           refs={"txnId": "T1"}, sources=[SourceRef(upload="u1")])
    stats, _ = ledger.upsert_transactions([pay, cashback])
    assert stats.added == 2


def test_ignored_payee_applies_in_both_directions():
    ctx = Context(payees=[Payee(id="x", name="Bank Account XXXXXXXXXX1234", label="Ignored", category="ignored"),
                          Payee(id="y", name="Test Friend", label="Ignored", category="ignored")],
                  own_digits=set())
    assert decide(txn("Bank Account XXXXXXXXXX1234"), ctx).category == "ignored"
    received = Transaction(id="r", at=AT, amount=500, direction="credit", kind="income", payee="Test Friend")
    assert (decide(received, ctx).category, decide(received, ctx).by) == ("ignored", "payee")


def test_a_new_reading_of_a_bill_payment_replaces_the_old_one():
    from app.models import CardPayment

    old = CardPayment(id="p1", at=AT, amount=4321.50, card="card-x-1111", card_title="X 1111",
                      refs={"utr": "CVFAKE1"}, source=SourceRef(upload="u"))
    ledger.upsert_card_payments([old])
    stats = ledger.upsert_card_payments([old.model_copy(update={"refs": {"utr": "CVFAKE2"}})])
    assert (stats.added, stats.duplicates) == (0, 1)
    assert ledger.load_card_payments()[0].refs["utr"] == "CVFAKE2"


# ---- refunds ------------------------------------------------------------------------------------


def _credit(payee, amount, at, kind="refund", txn_id=None, id=None):
    return Transaction(id=id or f"r_{payee}_{amount}", at=at, amount=amount, direction="credit", kind=kind, payee=payee,
                       refs={"txnId": txn_id} if txn_id else {}, sources=[SourceRef(upload="u")])


def _pay(payee, amount, at=AT, id=None, txn_id=None, **kw):
    return Transaction(id=id or f"p_{payee}_{amount}", at=at, amount=amount, direction="debit", payee=payee,
                       refs={"txnId": txn_id} if txn_id else {}, sources=[SourceRef(upload="u")], **kw)


def _placed(txns):
    categorize.recategorize(txns)
    return {t.id: t for t in ledger.load_transactions()}


def test_refund_is_filed_with_its_payment_by_transaction_id():
    pay = _pay("FAKE ELECTRICITY BOARD", 1200, id="pay", txn_id="T1")
    got = _placed([pay, _credit("FAKE ELECTRICITY BOARD", 1200, AT + timedelta(hours=1), txn_id="T1", id="ref")])
    assert got["ref"].refund_of == "pay"
    assert got["ref"].category == got["pay"].category == "bills.electricity"
    assert got["ref"].categorized_by == "refund" and not got["ref"].needs_review


def test_refund_without_shared_id_goes_to_the_latest_payment_to_that_shop_that_covers_it():
    older = _pay("SWIGGY", 300, at=AT - timedelta(days=20), id="older")
    newer = _pay("Swiggy Limited", 250, at=AT - timedelta(days=2), id="newer")
    small = _pay("SWIGGY", 80, at=AT - timedelta(days=1), id="small")  # too small for a 200 refund
    got = _placed([older, newer, small, _credit("SWIGGY", 200, AT, id="ref")])
    assert got["ref"].refund_of == "newer"
    assert got["ref"].category == "food.delivery"


def test_refund_whose_payment_is_not_in_the_ledger_stays_under_refunds():
    too_old = _pay("SWIGGY", 500, at=AT - timedelta(days=400), id="old")
    got = _placed([too_old, _credit("SOME SHOP", 90, AT, id="a"), _credit("SWIGGY", 100, AT, id="b"), _credit("SWIGGY", 900, AT, id="c")])
    assert all(got[i].refund_of is None and got[i].category == "income.refund" for i in "abc")


def test_two_refunds_never_give_back_more_than_was_paid():
    pay = _pay("AMAZON", 1000, at=AT - timedelta(days=5), id="pay")
    got = _placed([pay, _credit("AMAZON", 600, AT, id="r1"), _credit("AMAZON", 600, AT + timedelta(days=1), id="r2")])
    assert got["r1"].refund_of == "pay"
    assert got["r2"].refund_of is None  # only 400 was left to refund


def test_money_from_a_known_shop_is_a_refund_but_from_a_person_it_is_income():
    pay = _pay("SWIGGY", 400, at=AT - timedelta(days=1), id="pay")
    got = _placed([pay, _credit("SWIGGY", 400, AT, kind="income", id="shop"), _credit("Mr Fake Friend", 400, AT, kind="income", id="friend")])
    assert (got["shop"].kind, got["shop"].refund_of) == ("refund", "pay")
    assert (got["friend"].kind, got["friend"].refund_of, got["friend"].category) == ("income", None, "income.received")


def test_a_refund_follows_its_payment_when_you_recategorize_it():
    from fastapi.testclient import TestClient

    from app.main import app

    pay = _pay("FAKE BOUTIQUE", 2000, at=AT - timedelta(days=1), id="pay", txn_id="T9")
    ledger.save_transactions([pay, _credit("FAKE BOUTIQUE", 2000, AT, txn_id="T9", id="ref")])
    with TestClient(app, base_url="http://127.0.0.1") as c:
        c.post("/api/categorize", json={"transactionId": "pay", "category": "shopping.apparel"})
        got = {t["id"]: t for t in c.get("/api/transactions").json()}
    assert got["ref"]["refundOf"] == "pay"
    assert got["ref"]["category"] == "shopping.apparel"


def test_a_payment_and_its_refund_never_share_an_id(tmp_path):
    """PhonePe can print a refund with its payment's transaction ID and no UTR."""
    from app.ingest.textlines import page_lines
    from app.parsers import phonepe
    from tests.conftest import make_pdf
    import pymupdf

    text = """Apr 15, 2025
08:00 PM
Paid to FAKE BOUTIQUE
Transaction ID : T777
Debited from XX1111
Debit
INR 2000.00
Apr 15, 2025
08:30 PM
Refund from FAKE BOUTIQUE
Transaction ID : T777
Credited to XX1111
Credit
INR 2000.00
"""
    with pymupdf.open(make_pdf(tmp_path / "p.pdf", [text])) as doc:
        pages, method = page_lines(doc)
    pay, refund = phonepe.parse(pages, method, "u").transactions
    assert refund.kind == "refund"
    assert pay.id != refund.id
    ledger.upsert_transactions([pay, refund])
    got = {t.id: t for t in ledger.load_transactions()}
    assert len(got) == 2


def test_the_ledger_never_stores_two_transactions_under_one_id():
    a = _pay("FAKE SHOP", 100, id="same")
    b = _credit("FAKE SHOP", 100, AT + timedelta(minutes=5), id="same")
    ledger.upsert_transactions([a, b])
    assert len({t.id for t in ledger.load_transactions()}) == 2


def test_old_duplicate_ids_are_repaired():
    ledger.save_transactions([_pay("FAKE SHOP", 100, id="same"), _credit("FAKE SHOP", 100, AT, id="same")])
    assert ledger.repair_duplicate_ids() == 1
    assert len({t.id for t in ledger.load_transactions()}) == 2
    assert ledger.repair_duplicate_ids() == 0


def test_one_refund_listed_twice_under_one_utr_counts_once():
    """PhonePe: a failed bill payment, its refund, and the same refund again as "Payment Received"."""
    pay = _pay("ELECTRICITY BOARD", 451, id="pay", txn_id="T1")
    pay.refs["utr"] = "100000000001"
    refund = _credit("Refund Received - Electricity Bill Payment", 451, AT, txn_id="T1", id="refund")
    refund.refs["utr"] = "200000000002"
    again = _credit("Payment Received", 451, AT, kind="income", txn_id="T2", id="again")
    again.refs["utr"] = "200000000002"
    stats, _ = ledger.upsert_transactions([pay, refund, again])
    assert (stats.added, stats.duplicates) == (2, 1)
    [credit] = [t for t in ledger.load_transactions() if t.direction == "credit"]
    assert credit.kind == "refund" and credit.refs["txnId"] == "T1"

    # the other way round, the refund's details still win
    ledger.save_transactions([])
    ledger.upsert_transactions([pay, again, refund])
    [credit] = [t for t in ledger.load_transactions() if t.direction == "credit"]
    assert (credit.kind, credit.payee, credit.refs["txnId"]) == ("refund", "Refund Received - Electricity Bill Payment", "T1")


def test_two_different_payments_with_different_utrs_are_still_two():
    a = _pay("FAKE CHAI", 15, id="a", txn_id="T1")
    a.refs["utr"] = "1"
    b = _pay("FAKE CHAI", 15, id="b", txn_id="T2")
    b.refs["utr"] = "2"
    assert ledger.upsert_transactions([a, b])[0].added == 2


def test_existing_same_utr_duplicates_are_folded_at_startup():
    refund = _credit("Refund Received - Electricity Bill Payment", 451, AT, txn_id="T1", id="refund")
    refund.refs["utr"] = "200000000002"
    again = _credit("Payment Received", 451, AT, kind="income", txn_id="T2", id="refund")  # and the same id, as before
    again.refs["utr"] = "200000000002"
    ledger.save_transactions([refund, again])
    assert ledger.merge_same_utr() == 1
    [only] = ledger.load_transactions()
    assert (only.kind, only.payee) == ("refund", "Refund Received - Electricity Bill Payment")
    assert ledger.merge_same_utr() == 0


# ---- card bills paid through CRED with UPI ------------------------------------------------------


def _bill(amount, at, id, card="card-hsbc-2468", title="HSBC ••2468"):
    from app.models import CardPayment

    return CardPayment(id=id, at=at, amount=amount, card=card, card_title=title, refs={"credTxnId": id}, source=SourceRef(upload="cred"))


def test_every_cred_spelling_is_a_card_bill_not_spending():
    for name in ("CRED", "CRED Club", "CredClub", "CREDCLUB", "DREAMPLUG TECHNOLOGIES PVT LTD", "Federal One Credit card"):
        v = decide(_pay(name, 5000), Context(payees=[], own_digits=set()))
        assert (v.category, v.kind) == ("transfers.card_bill", "bill_payment"), name
    assert decide(_pay("CREDENCE FAKE SALON", 500), Context(payees=[], own_digits=set())) is None or \
        decide(_pay("CREDENCE FAKE SALON", 500), Context(payees=[], own_digits=set())).category != "transfers.card_bill"


def test_upi_payment_to_cred_is_linked_to_the_bill_it_paid():
    ledger.upsert_card_payments([_bill(4321.50, AT + timedelta(minutes=1), "bill1"), _bill(4321.50, AT + timedelta(days=30), "bill2")])
    # the AI once guessed "broadband" for CredClub; the card-bill rule wins
    upi = _pay("CredClub", 4321.50, id="upi", category="bills.broadband", categorized_by="learned", confidence=0.7)
    person = _pay("Mr Fake Person", 4321.50, id="person")  # same amount, same minute: not a card bill
    got = _placed([upi, person])
    assert (got["upi"].category, got["upi"].settles) == ("transfers.card_bill", "bill1")
    assert got["person"].settles is None


def test_unmatched_cred_payment_is_still_a_card_bill():
    got = _placed([_pay("CRED", 999, id="upi")])
    assert (got["upi"].category, got["upi"].settles) == ("transfers.card_bill", None)


def test_cred_rewards_can_make_the_upi_side_a_little_less_than_the_bill():
    ledger.upsert_card_payments([_bill(10000, AT, "bill")])
    got = _placed([_pay("CRED Club", 9944, at=AT + timedelta(minutes=1), id="upi"), _pay("CRED", 8000, at=AT, id="far")])
    assert got["upi"].settles == "bill"  # 0.56% covered by CRED rewards
    assert got["far"].settles is None  # 20% off isn't the same payment


def test_an_exact_amount_wins_over_a_near_one():
    ledger.upsert_card_payments([_bill(10000, AT, "near"), _bill(9950, AT + timedelta(minutes=2), "exact")])
    got = _placed([_pay("CredClub", 9950, at=AT, id="upi")])
    assert got["upi"].settles == "exact"


# ---- own accounts by UPI address; a shop known by its whole name only ---------------------------


@pytest.fixture
def fakeclub(monkeypatch):
    """A shop the merchant list knows by its whole name only (its name is an everyday phrase too): "Fakeclub",
    "Fakeclub1", "FAKE CLUB TECHNOLOGIES" are it; "Fakeclub Swimming Academy" isn't."""
    real = categorize._dictionary()
    entry = (re.compile(r"^fake ?club\d*(?: technologies)?$"), "Fakeclub", "groceries.quick_commerce")
    monkeypatch.setattr(categorize, "_dictionary", lambda: [entry, *real])


def test_transfer_to_your_own_account_by_its_upi_address_is_ignored():
    ctx = Context(payees=[], own_digits={"4321"})
    v = decide(_pay("500000004321@ABCD0000001.ifsc.npci", 20000), ctx)
    assert (v.category, v.kind) == ("ignored", "transfer")
    assert decide(_pay("123456781111@HDFC0001234.ifsc.npci", 500), ctx) is None or \
        decide(_pay("123456781111@HDFC0001234.ifsc.npci", 500), ctx).category != "ignored"  # someone else's account


def test_a_shop_known_by_its_whole_name_only(fakeclub):
    ctx = Context(payees=[], own_digits=set())
    for name in ("Fakeclub", "Fakeclub1", "FAKE CLUB TECHNOLOGIES", "FAKECLUB TECHNOLOGIES PRIVATE LIMITED"):
        assert decide(_pay(name, 400), ctx).category == "groceries.quick_commerce", name
    for name in ("Fakeclub Swimming Academy", "Fake Club Gym"):
        v = decide(_pay(name, 400), ctx)
        assert v is None or v.category != "groceries.quick_commerce", name


# ---- confirming the review list ----------------------------------------------------------------


def test_confirm_the_whole_review_list_at_once(data_dir):
    import json

    from fastapi.testclient import TestClient

    from app import payees
    from app.main import app

    review = dict(needs_review=True, categorized_by="heuristic", confidence=0.6)
    ledger.save_transactions([
        _pay("Mr Fake Milkman", 60, id="milk", category="transfers.p2p", **review),
        _pay("Ms Fake Friend", 500, id="friend", category="transfers.p2p", **review),
        _pay("FAKE GADGET HUB", 900, id="shop", category="shopping.online", **review),
        _pay("FAKE LAUNDRY", 200, id="laundry", category="uncategorized", **review),
    ])
    items = [
        {"payee": "Mr Fake Milkman", "category": "groceries.local", "label": "Milk"},  # named: payee table
        {"payee": "Ms Fake Friend", "category": "transfers.p2p"},  # confirmed as is: remembered, not in the table
        {"payee": "FAKE GADGET HUB", "category": "shopping.online"},
        {"payee": "FAKE LAUNDRY", "category": "home.services"},  # changed in the dropdown
        {"payee": "Nobody", "category": "food.snacks"},  # no such payee: skipped
    ]
    with TestClient(app, base_url="http://127.0.0.1") as c:
        body = c.post("/api/categorize/bulk", json={"items": items}).json()
        got = {t["id"]: t for t in c.get("/api/transactions").json()}
    assert (body["confirmed"], body["payees"], body["remembered"], body["updated"]) == (4, 1, 3, 4)
    assert not any(t["needsReview"] for t in got.values())
    assert (got["milk"]["category"], got["laundry"]["category"], got["friend"]["category"]) == ("groceries.local", "home.services", "transfers.p2p")
    assert [p.label for p in payees.list_payees()] == ["Milk"]  # the table only holds names you gave

    # the answers hold for new payments too
    new = [_pay("Ms Fake Friend", 700, id="friend2", at=AT + timedelta(days=9), category="transfers.p2p", **review),
           _pay("FAKE LAUNDRY", 150, id="laundry2", at=AT + timedelta(days=9))]
    ledger.upsert_transactions(new)
    got = {t.id: t for t in (lambda txns: (categorize.recategorize(txns), ledger.load_transactions())[1])(ledger.load_transactions())}
    assert not got["friend2"].needs_review and got["laundry2"].category == "home.services"
    assert json.loads((data_dir / "merchant_memory.json").read_text())["fake laundry"]["by"] == "user"


def test_bulk_rejects_unknown_categories():
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app, base_url="http://127.0.0.1") as c:
        assert c.post("/api/categorize/bulk", json={"items": [{"payee": "X", "category": "nope"}]}).status_code == 400


def test_a_sure_rule_clears_the_review_flag_of_an_earlier_guess(fakeclub):
    guessed = _pay("Fakeclub1", 300, id="fc", category="transfers.p2p", categorized_by="learned", confidence=0.7, needs_review=True)
    unsure = _pay("Mr Fake Person", 300, id="person", category="transfers.p2p", categorized_by="heuristic", confidence=0.6, needs_review=True)
    got = _placed([guessed, unsure])
    assert (got["fc"].category, got["fc"].needs_review) == ("groceries.quick_commerce", False)
    assert got["person"].needs_review  # still yours to answer



# ---- one payment re-filed, then its whole shop ---------------------------------------------------


def test_refiling_one_payment_offers_the_rest_of_that_shop(fakeclub):
    from fastapi.testclient import TestClient

    from app.main import app

    txns = [_pay("Fakeclub", 100 + i, id=f"fc{i}", at=AT + timedelta(days=i), category="groceries.quick_commerce") for i in range(3)]
    txns += [
        _pay("Fakeclub1", 200, id="fc1x", category="groceries.quick_commerce"),  # the same shop, another name
        _pay("Fakeclub Swimming Academy", 900, id="swim", category="health.fitness"),  # shares a word: not the same shop
        _credit("Fakeclub", 100, AT + timedelta(days=1), id="refund"),  # a refund follows its payment, not the shop
    ]
    ledger.save_transactions(txns)
    with TestClient(app, base_url="http://127.0.0.1") as c:
        body = c.post("/api/categorize", json={"transactionId": "fc0", "category": "groceries"}).json()
    assert body["savedAs"] == "transaction"
    assert body["related"] == [
        {"payee": "Fakeclub", "count": 2, "already": 0},
        {"payee": "Fakeclub1", "count": 1, "already": 0},
    ]
    assert {t.id: t.category for t in ledger.load_transactions()}["fc1"] == "groceries.quick_commerce"  # just the one, so far


def test_change_all_moves_the_whole_shop_and_remembers_it(fakeclub):
    from fastapi.testclient import TestClient

    from app.main import app

    ledger.save_transactions([
        _pay("Fakeclub", 100, id="a", category="groceries.quick_commerce"),
        _pay("Fakeclub", 150, id="b", category="shopping.online", categorized_by="user"),  # set by hand before: you asked for all
        _pay("Fakeclub1", 200, id="c", category="groceries.quick_commerce"),
        _pay("Fakeclub Swimming Academy", 900, id="swim", category="health.fitness", categorized_by="user"),
    ])
    with TestClient(app, base_url="http://127.0.0.1") as c:
        body = c.post("/api/categorize/shop", json={"payees": ["Fakeclub", "Fakeclub1"], "category": "groceries"}).json()
        got = {t["id"]: t["category"] for t in c.get("/api/transactions").json()}
    assert body["updated"] == 3
    assert got == {"a": "groceries", "b": "groceries", "c": "groceries", "swim": "health.fitness"}

    # and their future payments follow
    ledger.upsert_transactions([_pay("Fakeclub1", 300, id="later", at=AT + timedelta(days=30))])
    got = _placed(ledger.load_transactions())
    assert got["later"].category == "groceries"
