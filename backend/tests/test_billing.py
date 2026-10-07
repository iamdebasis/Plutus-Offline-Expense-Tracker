"""Which card paid for what, and what each card bill paid for (fake cards and amounts only)."""

from datetime import date, datetime

from app import billing, categorize
from app.categorize import Context
from app.models import CardPayment, CardStatement, Instrument, SourceRef, Transaction
from app.parsers import IST

CARD = "card-fake-bank-1141"


def _card(id: str, last4: str, network: str | None = None) -> Instrument:
    return Instrument(id=id, last4=last4, network=network, name="Fake Bank card", first_seen=datetime(2026, 1, 1, tzinfo=IST))


def _on_upi(amount: float, at: datetime, mask: str = "XXXX41", n: int = 1, **kw) -> Transaction:
    fields = dict(id=f"t{n}", at=at, amount=amount, direction="debit", channel="upi", app="phonepe", payee="Fake Shop",
                  paid_from=mask, refs={"utr": f"90000000030{n}"}, sources=[SourceRef(upload="u_upi")])
    return Transaction(**{**fields, **kw})


def _bill(id: str, at: datetime, amount: float, card: str = CARD) -> CardPayment:
    return CardPayment(id=id, at=at, amount=amount, card=card, card_title="Fake Bank ••1141", source=SourceRef(upload="u_cred"))


def _statement(id: str, start: str, end: str, card: str = CARD) -> CardStatement:
    return CardStatement(id=id, card=card, period_start=start, period_end=end, statement_date=end)


def _day(y: int, m: int, d: int) -> datetime:
    return datetime(y, m, d, 12, tzinfo=IST)


# ---- which card -----------------------------------------------------------------------------------------------


def test_a_card_on_upi_is_the_rupay_card_ending_that_way():
    visa, rupay, unknown = _card("card-a-1141", "1141", "Visa"), _card("card-b-2241", "2241", "RuPay"), _card("card-c-3341", "3341")
    paid = _on_upi(100.0, _day(2026, 9, 1))
    assert billing.card_for(paid, [visa, rupay, unknown]) == rupay.id
    assert billing.card_for(paid, [visa, unknown]) == unknown.id  # a Visa card can't be used on UPI; the other can
    assert billing.card_for(paid, [unknown, _card("card-d-4441", "4441")]) is None  # either could be: neither is guessed
    assert billing.card_for(paid, [visa]) is None
    google = paid.model_copy(update={"channel": "card"})  # a purchase charged to a card, which can be any network
    assert billing.card_for(google, [visa]) == visa.id
    assert billing.card_for(paid.model_copy(update={"paid_from": "XX4141"}), [unknown]) is None  # a bank account


def test_a_statement_row_keeps_its_own_card_and_the_rest_are_assigned_again():
    row = _on_upi(100.0, _day(2026, 9, 1), card="card-from-statement", refs={"cardRow": "1141:20260901:d:100.00:1"})
    paid = _on_upi(50.0, _day(2026, 9, 2), n=2, card="card-gone")
    assert billing.assign_cards([row, paid], [_card(CARD, "1141", "RuPay")]) == 1
    assert (row.card, paid.card) == ("card-from-statement", CARD)


# ---- what a bill pays for -------------------------------------------------------------------------------------


def test_a_bill_pays_the_statement_you_added():
    bills = [_bill("b1", _day(2026, 9, 25), 5000.0), _bill("b0", _day(2026, 8, 22), 4000.0)]
    billing.place_bills(bills, [_statement("s1", "2026-08-13", "2026-09-12")], [])
    b1, b0 = bills
    assert (b1.covered_by, b1.pays_from, b1.pays_to, b1.cycle, b1.estimate) == ("s1", date(2026, 8, 13), date(2026, 9, 12), "statement", 0)
    # the bill before it pays the cycle before, which the same billing day places exactly
    assert (b0.covered_by, b0.pays_from, b0.pays_to, b0.cycle, b0.estimate) == (None, date(2026, 7, 13), date(2026, 8, 12), "card", 4000.0)


def test_bills_follow_the_cards_billing_day_through_short_months():
    statement = _statement("s1", "2026-01-01", "2026-01-31")  # billed on the last day of the month
    bills = [_bill("feb", _day(2026, 3, 10), 1000.0), _bill("mar", _day(2026, 4, 2), 1000.0)]
    billing.place_bills(bills, [statement], [])
    assert [(b.pays_from, b.pays_to) for b in bills] == [(date(2026, 2, 1), date(2026, 2, 28)), (date(2026, 3, 1), date(2026, 3, 31))]


def test_a_card_without_statements_is_taken_to_be_billed_ten_days_before_its_bills_are_paid():
    bills = [_bill("oct", _day(2026, 10, 25), 1000.0), _bill("nov", _day(2026, 11, 24), 1000.0), _bill("dec", _day(2026, 12, 26), 1000.0)]
    billing.place_bills(bills, [], [])
    assert all(b.cycle == "guess" and b.covered_by is None and b.estimate == 1000.0 for b in bills)
    assert [(b.pays_from, b.pays_to) for b in bills] == [
        (date(2026, 9, 16), date(2026, 10, 15)), (date(2026, 10, 16), date(2026, 11, 15)), (date(2026, 11, 16), date(2026, 12, 15))]


def test_upi_payments_with_the_card_come_off_the_bill_that_paid_for_them():
    cards = [_card(CARD, "1141", "RuPay")]
    sweets = _on_upi(1200.0, _day(2026, 10, 20))
    refund = Transaction(id="r1", at=_day(2026, 10, 24), amount=200.0, direction="credit", kind="refund", payee="Fake Shop",
                         refund_of="t1", sources=[SourceRef(upload="u_upi")])
    later = _on_upi(700.0, _day(2026, 11, 20), n=2)  # the next cycle's
    txns = [sweets, refund, later]
    billing.assign_cards(txns, cards)
    bills = [_bill("b1", _day(2026, 11, 25), 5000.0)]
    billing.place_bills(bills, [_statement("s1", "2026-08-13", "2026-09-12")], txns)
    [b] = bills
    assert (b.pays_from, b.pays_to, b.counted, b.estimate) == (date(2026, 10, 13), date(2026, 11, 12), 1000.0, 4000.0)


def test_two_bills_for_one_cycle_share_it():
    txns = [_on_upi(2000.0, _day(2026, 10, 20))]
    billing.assign_cards(txns, [_card(CARD, "1141", "RuPay")])
    bills = [_bill("part", _day(2026, 11, 20), 3000.0), _bill("rest", _day(2026, 11, 28), 1000.0)]
    billing.place_bills(bills, [_statement("s1", "2026-08-13", "2026-09-12")], txns)
    assert [(b.pays_to, b.counted, b.estimate) for b in bills] == [(date(2026, 11, 12), 1500.0, 1500.0), (date(2026, 11, 12), 500.0, 500.0)]


def test_upi_payments_beyond_a_bill_come_off_the_next_one():
    txns = [_on_upi(800.0, _day(2026, 10, 20))]  # billed late, so October's bill paid less than this
    billing.assign_cards(txns, [_card(CARD, "1141", "RuPay")])
    bills = [_bill("b1", _day(2026, 11, 20), 500.0), _bill("b2", _day(2026, 12, 20), 2000.0), _bill("b4", _day(2027, 2, 20), 900.0)]
    billing.place_bills(bills, [_statement("s1", "2026-08-13", "2026-09-12")], txns)
    assert [(b.counted, b.estimate) for b in bills] == [(500.0, 0.0), (300.0, 1700.0), (0.0, 900.0)]  # no bill for January: nothing carries


def test_an_older_statement_doesnt_cover_a_later_cycles_bill():
    """Paid in March: February's statement, which you didn't add, not January's, which you did."""
    bills = [_bill("jan", _day(2026, 2, 18), 3000.0), _bill("feb", _day(2026, 3, 10), 2000.0)]
    billing.place_bills(bills, [_statement("s1", "2026-01-01", "2026-01-31")], [])
    assert [(b.covered_by, b.cycle, b.estimate) for b in bills] == [("s1", "statement", 0.0), (None, "card", 2000.0)]


def test_an_export_that_lists_a_whole_cycle_covers_its_bill():
    """The bank's export of Jan–Apr lists the purchases of the cycles inside it one by one; it doesn't say when
    the card is billed (it ends the day it was downloaded), so the cycles come from the monthly statement."""
    export = _statement("x1", "2026-01-01", "2026-04-20").model_copy(update={"kind": "export", "statement_date": None})
    statement = _statement("s1", "2025-11-13", "2025-12-12")
    listed = Transaction(id="row1", at=_day(2026, 4, 15), amount=300.0, direction="debit", channel="card", payee="Fake Shop",
                         card=CARD, refs={"cardRow": "1141:20260415:d:300.00:1"}, sources=[SourceRef(upload="x1")])
    bills = [_bill("feb", _day(2026, 2, 25), 3000.0), _bill("apr", _day(2026, 4, 25), 2000.0), _bill("may", _day(2026, 5, 25), 1000.0)]
    billing.place_bills(bills, [export, statement], [listed])
    assert [(b.covered_by, b.pays_from, b.pays_to, b.estimate) for b in bills] == [
        ("x1", date(2026, 1, 13), date(2026, 2, 12), 0.0),
        ("x1", date(2026, 3, 13), date(2026, 4, 12), 0.0),
        (None, date(2026, 4, 13), date(2026, 5, 12), 700.0)]  # the export lists a week of it: that part comes off


def test_placing_again_changes_nothing():
    bills = [_bill("b1", _day(2026, 9, 25), 5000.0)]
    statements = [_statement("s1", "2026-08-13", "2026-09-12")]
    assert billing.place_bills(bills, statements, []) == 1
    assert billing.place_bills(bills, statements, []) == 0


# ---- nothing charged to a card pays a person ------------------------------------------------------------------


def test_a_card_on_upi_never_pays_a_person():
    ctx = Context(payees=[], own_digits=set(), memory={})
    on_card = _on_upi(250.0, _day(2026, 9, 1), payee="Fake Kumar Sharma")
    from_bank = on_card.model_copy(update={"paid_from": "XX4141"})
    for t in (on_card, from_bank):
        assert categorize.decide(t, ctx) is None  # a plain name: the local AI is asked first
        categorize.fallback(t)
    assert (on_card.category, from_bank.category) == ("uncategorized", "transfers.p2p")
    honorific = _on_upi(250.0, _day(2026, 9, 1), payee="Mr Fake Name")
    assert categorize.decide(honorific, ctx) is None  # a shop with a person's name: the local AI is asked
    assert categorize.decide(honorific.model_copy(update={"paid_from": "XX4141"}), ctx).category == "transfers.p2p"


# ---- bills paid, from statements ------------------------------------------------------------------------------


def _paid_row(amount: float, at: datetime, n: int = 1, card: str | None = CARD, upload: str = "u_stmt", **kw) -> Transaction:
    """A card statement's row for a payment to the card ("PAYMENT RECEIVED - THANK YOU")."""
    fields = dict(id=f"row{n}", at=at, amount=amount, direction="credit", kind="bill_payment", channel="card",
                  payee="PAYMENT RECEIVED - THANK YOU", card=card, category="transfers.card_bill",
                  refs={"cardRow": f"1141:{at:%Y%m%d}:c:{amount:.2f}:{n}"}, sources=[SourceRef(upload=upload, page=1, y=300.0)])
    return Transaction(**{**fields, **kw})


def _fake_card() -> Instrument:
    return _card(CARD, "1141").model_copy(update={"issuer": "Fake Bank"})


def test_a_statements_payment_row_is_a_bill_paid():
    row = _paid_row(9000.0, _day(2026, 8, 22))
    [bill] = billing.statement_bills([row], [], [_fake_card()])
    assert (bill.origin, bill.card, bill.amount, bill.at, bill.card_title) == ("statement", CARD, 9000.0, row.at, "Fake Bank ••1141")
    assert bill.source == row.sources[0] and bill.refs["txn"] == row.id  # it cites the statement's row
    assert billing.statement_bills([row], [], [_fake_card()])[0].id == bill.id  # the same id every time


def test_a_payment_the_app_recorded_is_counted_once():
    """CRED records the bill when you pay; the bank posts it a day or few later, sometimes a little different (rewards)."""
    row = _paid_row(9000.0, _day(2026, 8, 22))
    assert billing.statement_bills([row], [_bill("b1", _day(2026, 8, 20), 9000.0)], [_fake_card()]) == []
    assert billing.statement_bills([row], [_bill("b1", _day(2026, 8, 21), 8800.0)], [_fake_card()]) == []
    # not the same payment: another card, long before, or another amount
    for other in (_bill("b1", _day(2026, 8, 21), 9000.0, card="card-other-2222"), _bill("b1", _day(2026, 8, 1), 9000.0),
                  _bill("b1", _day(2026, 8, 21), 4500.0)):
        assert len(billing.statement_bills([row], [other], [_fake_card()])) == 1, other
    # one app bill is one payment: two rows of the same amount, one of them is it
    rows = [row, _paid_row(9000.0, _day(2026, 8, 23), n=2)]
    assert [b.refs["txn"] for b in billing.statement_bills(rows, [_bill("b1", _day(2026, 8, 21), 9000.0)], [_fake_card()])] == ["row2"]


def test_only_a_statements_counted_card_bill_row_is_a_bill():
    """A row you re-filed (it wasn't a payment to the card), one whose card isn't known, and the UPI side of paying a
    bill (a card bill too, but from the account it left) are not bills paid."""
    refiled = _paid_row(9000.0, _day(2026, 8, 22), category="income.refund")
    no_card = _paid_row(9000.0, _day(2026, 8, 22), n=2, card=None)
    upi_side = _on_upi(9000.0, _day(2026, 8, 22), payee="CRED", kind="bill_payment", category="transfers.card_bill")
    assert billing.statement_bills([refiled, no_card, upi_side], [], [_fake_card()]) == []


def test_a_statements_bill_is_placed_like_any_other():
    """Paid in August's statement, it pays July's cycle: covered when you added July's statement, else it stands for that
    cycle's purchases, less what was paid with the card on UPI. With an app's bill in the same cycle, they pay it
    together."""
    july = _statement("s_jul", "2026-07-13", "2026-08-12")
    [covered] = billing.statement_bills([_paid_row(9000.0, _day(2026, 8, 22))], [], [_fake_card()])
    billing.place_bills([covered], [july], [])
    assert (covered.covered_by, covered.pays_from, covered.pays_to, covered.estimate) == ("s_jul", date(2026, 7, 13), date(2026, 8, 12), 0.0)

    august = _statement("s_aug", "2026-08-13", "2026-09-12")
    [first] = billing.statement_bills([_paid_row(9000.0, _day(2026, 8, 22))], [], [_fake_card()])
    on_upi = _on_upi(1000.0, _day(2026, 8, 1), card=CARD)  # in July's cycle, already in UPI spends
    billing.place_bills([first], [august], [on_upi])
    assert (first.covered_by, first.pays_from, first.pays_to, first.counted, first.estimate) == (
        None, date(2026, 7, 13), date(2026, 8, 12), 1000.0, 8000.0)

    app = _bill("b1", _day(2026, 8, 15), 6000.0)  # a part paid with CRED, the rest straight to the bank
    [rest] = billing.statement_bills([_paid_row(3000.0, _day(2026, 8, 22))], [app], [_fake_card()])
    billing.place_bills([app, rest], [august], [])
    assert (app.pays_to, rest.pays_to, app.estimate + rest.estimate) == (date(2026, 8, 12), date(2026, 8, 12), 9000.0)


def test_only_the_apps_bills_are_linked_to_payments_to_cred():
    """A UPI payment to CRED is linked to the bill in your CRED history; a statement's bill isn't one to link to."""
    to_cred = _on_upi(9000.0, _day(2026, 8, 22), payee="CRED", paid_from="XX4141", category="transfers.card_bill")
    [from_statement] = billing.statement_bills([_paid_row(9000.0, to_cred.at)], [], [_fake_card()])
    categorize.link_card_bills([to_cred], [from_statement])
    assert to_cred.settles is None
