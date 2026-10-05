"""Credit card statements from any bank: read, checked against the bank's totals, mapped into the ledger, merged
with what UPI already knows, and covering the bills that pay them (fake statements only, tests/fake_cards.py)."""

import json
from collections import Counter
import time
from datetime import date, datetime

import pymupdf
import pytest
from fastapi.testclient import TestClient

from app import ledger, statements
from app.ingest.detect import detect
from app.main import app
from app.models import CardPayment, SourceRef, Transaction
from app.parsers import IST, card_statement
from app.parsers.card_statement import clean_merchant, parse_date
from tests import fake_cards

CARD = f"card-axis-bank-{fake_cards.LAST4}"
LAYOUTS = ["axis", "hdfc", "icici", "sbi", "plus_signs", "no_header", "two_pages", "points_after_amount", "datetime_rewards",
           "addon_card", "debit_credit_columns"]


@pytest.fixture
def client():
    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def _read(tmp_path, layout: str, **kw):
    path = getattr(fake_cards, layout)(tmp_path / f"{layout}.pdf", **kw)
    return card_statement.parse(path, "upl_x", detect(path, path.name))


def _upload(client, path, password=None):
    with path.open("rb") as f:
        data = {"kind": "auto", **({"password": password} if password else {})}
        resp = client.post("/api/uploads", files={"file": (path.name, f, "application/pdf")}, data=data)
    assert resp.status_code == 200, resp.text
    upload_id = resp.json()["id"]
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        rec = next(u for u in client.get("/api/uploads").json() if u["id"] == upload_id)
        if (rec.get("importStatus") or {}).get("state") in ("done", "failed", "skipped"):
            return upload_id, rec["importStatus"]
        time.sleep(0.1)
    raise AssertionError("import didn't finish")


# ---- reading any bank's layout ----------------------------------------------------------------------------


@pytest.mark.parametrize("layout", LAYOUTS)
def test_every_layout_reads_every_row_and_adds_up(tmp_path, layout):
    result = _read(tmp_path, layout)
    s = result.statement
    assert (s.rows, s.debits, s.credits) == (len(fake_cards.ROWS), fake_cards.DEBITS, fake_cards.CREDITS)
    assert (s.previous_balance, s.total_due, s.check) == (fake_cards.PREVIOUS, fake_cards.TOTAL_DUE, "matched")
    assert s.last4 == fake_cards.LAST4 and s.statement_date == "2026-09-12"
    assert any(n.startswith("Adds up:") for n in result.notes)


def test_what_each_row_is(tmp_path):
    rows = {(t.note, t.at.date()): t for t in _read(tmp_path, "axis").transactions}
    get = lambda note: next(t for (n, _), t in rows.items() if n == note)  # noqa: E731
    assert (get("PAYMENT RECEIVED - THANK YOU").kind, get("PAYMENT RECEIVED - THANK YOU").direction) == ("bill_payment", "credit")
    assert (get("REFUND FAKE FOOD APP").kind, get("REFUND FAKE FOOD APP").payee) == ("refund", "FAKE FOOD APP")
    assert get("CASHBACK CREDIT").kind == "cashback"
    assert get("FOREIGN CURRENCY TRANSACTION FEE").kind == "spend"
    food = get("FAKE FOOD APP,PUNE")
    assert (food.payee, food.channel, food.paid_from, food.card, food.merchant_category) == (
        "FAKE FOOD APP", "card", f"XXXX{fake_cards.LAST4}", CARD, "Restaurants")
    assert get("PYU*FAKE GROCER BANGALORE").payee == "FAKE GROCER"


UPI_ROWS = [
    fake_cards.Txn(date(2026, 8, 28), "UPI-FAKE SWEETS-fakesweets@okfake", "", 75.00),
    fake_cards.Txn(date(2026, 8, 29), "UPI/FAKE TEA STALL/ref 900000000301", "", 30.00),
    fake_cards.Txn(date(2026, 8, 30), "UPI PAYMENT RECEIVED", "", 500.00, credit=True),
]


def test_a_purchase_paid_over_upi_with_the_card_is_a_upi_payment(tmp_path):
    rows = {t.note: t for t in _read(tmp_path, "axis", rows=[*fake_cards.ROWS, *UPI_ROWS]).transactions}
    sweets, tea, paid = rows["UPI-FAKE SWEETS-fakesweets@okfake"], rows["UPI/FAKE TEA STALL/ref 900000000301"], rows["UPI PAYMENT RECEIVED"]
    assert (sweets.channel, sweets.payee, sweets.card) == ("upi", "FAKE SWEETS", CARD)
    assert (tea.channel, tea.payee) == ("upi", "FAKE TEA STALL")
    assert (paid.kind, paid.channel) == ("bill_payment", "card")  # paying the card, even over UPI, is the card's own
    assert rows["FAKE FOOD APP,PUNE"].channel == "card"
    assert rows["WWW.FAKESTREAM.COM"].channel == "card"  # a web address isn't a UPI address


@pytest.mark.parametrize("raised", [2.5, 7.0])
def test_a_column_after_the_amount_and_an_id_before_the_description(tmp_path, raised):
    """Points after each amount (on the row's line, or a little above it, on a line of their own) and a transaction
    ID between the date and the description: the amount is the one before the points, and neither the ID nor the
    points end up in the shop's name."""
    result = _read(tmp_path, "points_after_amount", raised=raised)
    s = result.statement
    assert (s.rows, s.debits, s.credits, s.check) == (len(fake_cards.ROWS), fake_cards.DEBITS, fake_cards.CREDITS, "matched")
    payees = {t.payee for t in result.transactions}
    assert {"FAKE FOOD APP", "FAKE CHAI POINT", "FAKE AIRWAYS MUMBAI IN".replace(" MUMBAI IN", "")} <= payees
    assert not any(any(ch.isdigit() for ch in t.payee) for t in result.transactions)
    assert not any("90000000000" in t.note for t in result.transactions)


def test_an_add_on_cards_rows_are_its_own(tmp_path):
    result = _read(tmp_path, "addon_card")
    by_card = Counter(t.paid_from for t in result.transactions)
    assert by_card == {f"XXXX{fake_cards.LAST4}": 7, "XXXX2718": len(fake_cards.ROWS) - 7}
    assert result.statement.last4 == fake_cards.LAST4  # the statement is the main card's


def test_a_rows_time_and_points_stay_out_of_its_shop(tmp_path):
    txns = {t.note: t for t in _read(tmp_path, "datetime_rewards").transactions}
    food = next(t for n, t in txns.items() if n.startswith("FAKE FOOD APP"))
    assert food.payee == "FAKE FOOD APP" and food.at.strftime("%H:%M") != "00:00"


def test_dates_without_a_year_across_new_year(tmp_path):
    s = _read(tmp_path, "yearless_new_year")
    assert sorted(t.at.date() for t in s.transactions) == [date(2026, 12, 16), date(2026, 12, 28), date(2027, 1, 5)]
    assert s.statement.check == "matched"


def test_the_same_purchase_twice_in_a_day_is_two_rows(tmp_path):
    cups = [t for t in _read(tmp_path, "axis").transactions if t.note == "FAKE CHAI POINT,PUNE"]
    assert len(cups) == 2 and cups[0].id != cups[1].id and cups[0].refs["cardRow"] != cups[1].refs["cardRow"]


def test_a_wrapped_description_and_an_international_row(tmp_path):
    txns = _read(tmp_path, "hdfc").transactions
    flight = next(t for t in txns if t.amount == 8999.00)
    assert flight.note == "FAKE AIRWAYS BOOKING REF MUMBAI IN"  # the second line joined to the first
    stream = next(t for t in txns if t.amount == 1105.32)
    assert (stream.payee, "USD 12.99" in stream.note) == ("FAKESTREAM", True)


def test_page_headings_and_reward_tables_are_not_rows(tmp_path):
    for layout in ("two_pages", "hdfc"):
        notes = " ".join(t.note for t in _read(tmp_path, layout).transactions)
        assert "CARDHOLDER" not in notes and "Page" not in notes and "Earned" not in notes


def test_rows_that_dont_add_up_are_held_with_a_warning(tmp_path):
    result = _read(tmp_path, "axis", tamper=True)
    assert (result.statement.check, result.statement.difference) == ("mismatch", 100.00)
    assert any("₹100.00 apart" in w for w in result.warnings)
    assert result.transactions == [] and len(result.statement.held) == len(fake_cards.ROWS)  # held for you, not counted


def test_a_row_the_reader_missed_is_named_where_you_can_see_it(tmp_path):
    """When the rows don't add up, the lines in the table that weren't read are kept, so you can find the row."""
    result = _read(tmp_path, "axis", undated_credit=True)
    s = result.statement
    assert (s.check, s.difference) == ("mismatch", -50.00)
    assert any("CASHBACK CREDIT" in line and "50.00" in line for line in s.unread)
    assert _read(tmp_path, "axis").statement.unread == []  # a statement read whole has nothing left over


def test_a_figure_of_zero_is_a_figure(tmp_path):
    """A previous balance of ₹0.00 is read as 0, not skipped for the next label alike (a points box's "Previous
    Balance" on the same line), and a statement's terms (worked examples with their own dates and figures) are
    never where its figures come from."""
    page = fake_cards.Page().at(40, "Previous Balance: ` 0.00").at(300, "Previous Balance").at(380, "+42").down()
    page.at(40, "Total Amount Due: ` 1,234.50").down(30)
    page.at(40, "Illustration of interest").down().at(40, "For an account whose Statement Date is 09/08/2021").down()
    page.at(40, "Statement Date: 09/08/2021").at(300, "Credit Limit: 50,000.00")
    path = fake_cards.save(tmp_path / "summary.pdf", [page])
    with pymupdf.open(path) as doc:
        s = card_statement.read_summary(card_statement.read_lines(doc)[0])
    assert (s.previous_balance, s.total_due, s.statement_date, s.credit_limit) == (0.0, 1234.50, None, None)


def test_a_statement_cycle_is_its_date_or_its_period(tmp_path):
    for text, expected in (("Statement Cycle: 12 September 2026", date(2026, 9, 12)),
                           ("Statement Cycle: 13/08/2026 - 12/09/2026", date(2026, 9, 12))):
        # a page with a statement's usual words around the line, so it's read from its own text, as a statement is
        page = fake_cards.Page().at(40, "Fake Bank Credit Card Statement").down().at(40, text).down()
        page.at(40, "Your account summary for this month, with every payment and purchase on your card")
        path = fake_cards.save(tmp_path / "cycle.pdf", [page])
        with pymupdf.open(path) as doc:
            assert card_statement.read_summary(card_statement.read_lines(doc)[0]).statement_date == expected


@pytest.mark.parametrize("raw, expected", [
    ("20/08/2026", date(2026, 8, 20)), ("20-08-26", date(2026, 8, 20)), ("20 Aug 2026", date(2026, 8, 20)),
    ("20-Aug-26", date(2026, 8, 20)), ("Aug 20, 2026", date(2026, 8, 20)), ("2026-08-20", date(2026, 8, 20)),
    ("20 Sept 2026", date(2026, 9, 20)), ("31/02/2026", None), ("SWIGGY", None),
])
def test_dates_as_banks_print_them(raw, expected):
    assert parse_date(raw) == expected


@pytest.mark.parametrize("raw, expected", [
    ("FAKE FOOD APP,PUNE", "FAKE FOOD APP"), ("PYU*Fake Shop Bangalore", "Fake Shop"), ("RAZ*FakeClub", "FakeClub"),
    ("UPI-FAKE MART PRIVATE LIMITED-fakemart@ybl", "FAKE MART PRIVATE LIMITED"), ("WWW.FAKESHOP.IN", "FAKESHOP"),
    ("FAKE STORE - SOME BRANCH MUMBAI", "FAKE STORE"), ("FAKE CAFE CYBS,MUMBAI", "FAKE CAFE"), ("REFUND FAKE SHOP", "FAKE SHOP"),
    ("FAKE STREAM USD 9.99", "FAKE STREAM"), ("FAKE AIRWAYS MUMBAI IN", "FAKE AIRWAYS"),
    ("UPI/P2M/900000000301/FAKE TEA STALL", "FAKE TEA STALL"), ("UPI/FAKE TEA STALL/ref 900000000301", "FAKE TEA STALL"),
])
def test_merchant_names_as_card_statements_print_them(raw, expected):
    assert clean_merchant(raw) == expected


# ---- into the ledger --------------------------------------------------------------------------------------


def test_import_end_to_end(client, tmp_path, data_dir):
    upload_id, status = _upload(client, fake_cards.axis(tmp_path / "Axis.pdf"))
    assert status["state"] == "done", status
    assert any(d.startswith("Adds up:") for d in status["details"])
    txns = {t["note"]: t for t in client.get("/api/transactions").json()}
    assert len(client.get("/api/transactions").json()) == len(fake_cards.ROWS)
    assert txns["FOREIGN CURRENCY TRANSACTION FEE"]["category"] == "fees.forex"
    assert txns["GST"]["category"] == "fees.tax"
    assert txns["PAYMENT RECEIVED - THANK YOU"]["category"] == "transfers.card_bill"
    assert txns["CASHBACK CREDIT"]["category"] == "income.cashback"
    assert txns["FAKE AIRWAYS MUMBAI IN"]["category"] == "travel.flights"  # the bank's category, as a hint
    food = txns["FAKE FOOD APP,PUNE"]
    assert food["category"] == "food.restaurants"
    assert txns["REFUND FAKE FOOD APP"]["refundOf"] == food["id"]  # taken off the purchase it refunds
    assert txns["PYU*FAKE GROCER BANGALORE"]["category"] != "transfers.p2p"  # a card never pays a person

    [s] = client.get("/api/card-statements").json()
    assert (s["id"], s["card"], s["check"], s["periodStart"], s["periodEnd"]) == (upload_id, CARD, "matched", "2026-08-13", "2026-09-12")
    assert json.loads((data_dir / "card_statements.json").read_text())[0]["id"] == upload_id


def test_reading_again_adds_nothing(client, tmp_path):
    upload_id, _ = _upload(client, fake_cards.axis(tmp_path / "Axis.pdf"))
    client.post(f"/api/uploads/{upload_id}/reimport")
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        rec = next(u for u in client.get("/api/uploads").json() if u["id"] == upload_id)
        if rec["importStatus"]["state"] == "done":
            break
        time.sleep(0.1)
    assert len(client.get("/api/transactions").json()) == len(fake_cards.ROWS)
    assert len(client.get("/api/card-statements").json()) == 1


def test_two_purchases_alike_but_for_the_shop_stay_two(client, tmp_path):
    """Same day, same amount, different shops: two rows, however alike their figures."""
    books = fake_cards.Txn(date(2026, 9, 2), "FAKE BOOKSHOP,PUNE", "BOOKS", 1105.32)
    _upload(client, fake_cards.axis(tmp_path / "Axis.pdf", rows=[*fake_cards.ROWS, books]))
    same = sorted(t["payee"] for t in client.get("/api/transactions").json() if t["amount"] == 1105.32)
    assert same == ["FAKE BOOKSHOP", "FAKESTREAM"]


def test_reading_again_with_a_better_reader_updates_its_rows(client, tmp_path):
    upload_id, _ = _upload(client, fake_cards.axis(tmp_path / "Axis.pdf", rows=[*fake_cards.ROWS, *UPI_ROWS]))
    # as an earlier reader had it: the UPI payment taken for a card purchase, and you'd answered one row yourself
    txns = ledger.load_transactions()
    sweets = next(t for t in txns if t.amount == 75.00)
    sweets.channel, sweets.payee = "card", "UPI-FAKE SWEETS"
    flight = next(t for t in txns if t.amount == 8999.00)
    flight.category, flight.categorized_by = "travel.trains", "user"
    ledger.update_transactions([sweets, flight])

    client.post(f"/api/uploads/{upload_id}/reimport")
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if next(u for u in client.get("/api/uploads").json() if u["id"] == upload_id)["importStatus"]["state"] == "done":
            break
        time.sleep(0.1)
    txns = {t["amount"]: t for t in client.get("/api/transactions").json()}
    assert len(client.get("/api/transactions").json()) == len(fake_cards.ROWS) + len(UPI_ROWS)
    assert (txns[75.00]["channel"], txns[75.00]["payee"]) == ("upi", "FAKE SWEETS")
    assert txns[8999.00]["category"] == "travel.trains"  # your answer stays


def test_reading_again_drops_what_the_earlier_reading_made_up(client, tmp_path):
    """An older reader took a line of the summary for a purchase; reading the statement again with a better one
    removes it. A row another file also lists stays, and only stops citing this statement."""
    upload_id, _ = _upload(client, fake_cards.axis(tmp_path / "Axis.pdf"))
    made_up = Transaction(id="t_made_up", at=datetime(2026, 9, 12, tzinfo=IST), amount=1000.0, direction="debit", channel="card",
                          payee="02-10-2026", card=CARD, refs={"cardRow": f"{fake_cards.LAST4}:20260912:d:1000.00:1"},
                          sources=[SourceRef(upload=upload_id)])
    shared = made_up.model_copy(update={"id": "t_shared", "amount": 77.0, "refs": {"cardRow": f"{fake_cards.LAST4}:20260911:d:77.00:1"},
                                        "sources": [SourceRef(upload=upload_id), SourceRef(upload="u_other")]})
    ledger.upsert_transactions([made_up, shared])
    client.post(f"/api/uploads/{upload_id}/reimport")
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if next(u for u in client.get("/api/uploads").json() if u["id"] == upload_id)["importStatus"]["state"] == "done":
            break
        time.sleep(0.1)
    txns = {t["id"]: t for t in client.get("/api/transactions").json()}
    assert "t_made_up" not in txns and len(txns) == len(fake_cards.ROWS) + 1
    assert [s["upload"] for s in txns["t_shared"]["sources"]] == ["u_other"]


def test_a_google_purchase_charged_to_the_card_is_one_payment(client, tmp_path):
    """Google Pay's record of a purchase charged to the card, and the card statement's row for it."""
    ledger.upsert_transactions([Transaction(
        id="t_google", at=datetime(2026, 9, 1, 20, 15, tzinfo=IST), amount=1105.32, direction="debit", channel="card",
        app="gpay", payee="Fake Stream Premium", paid_from=f"XXXX{fake_cards.LAST4[-2:]}", refs={"txnId": "GPA.0000-0000-0000-00001"},
        sources=[SourceRef(upload="u_gpay")])])
    _upload(client, fake_cards.axis(tmp_path / "Axis.pdf"))
    txns = client.get("/api/transactions").json()
    assert len(txns) == len(fake_cards.ROWS)
    stream = next(t for t in txns if t["amount"] == 1105.32)
    assert (stream["channel"], stream["card"], stream["payee"], stream["at"][11:16]) == ("card", CARD, "Fake Stream Premium", "20:15")


def _listed(upload: str, day: int, amount: float, payee: str, n: int = 1) -> Transaction:
    """A purchase as one file of the card lists it."""
    return Transaction(id=f"{upload}-{day}-{amount}-{n}", at=datetime(2026, 8, day, tzinfo=IST), amount=amount, direction="debit",
                       channel="card", payee=payee, paid_from=f"XXXX{fake_cards.LAST4}", card=CARD,
                       refs={"cardRow": f"{fake_cards.LAST4}:202608{day:02d}:d:{amount:.2f}:{n}"}, sources=[SourceRef(upload=upload)])


def test_the_same_purchase_in_two_files_that_overlap_counts_once():
    """A monthly statement, then the bank's export of a longer span: it dates each purchase when it posted and
    names shops its own way."""
    statement = [_listed("stmt", 14, 450.0, "FAKE FOOD APP"), _listed("stmt", 26, 60.0, "FAKE CHAI POINT", 1),
                 _listed("stmt", 26, 60.0, "FAKE CHAI POINT", 2), _listed("stmt", 16, 999.0, "FAKE SHOP")]
    export = [_listed("export", 15, 450.0, "Fake Food App Pvt Ltd"), _listed("export", 27, 60.0, "FAKE CHAI POINT PUNE", 1),
              _listed("export", 27, 60.0, "FAKE CHAI POINT PUNE", 2), _listed("export", 18, 999.0, "ANOTHER STORE")]
    ledger.upsert_transactions(statement)
    stats, _ = ledger.upsert_transactions(export)
    txns = ledger.load_transactions()
    assert (stats.added, stats.duplicates, len(txns)) == (1, 3, 5)  # the ₹999s, two days and two shops apart, are two
    cups = [t for t in txns if t.amount == 60.0]
    assert len(cups) == 2 and all({s.upload for s in t.sources} == {"stmt", "export"} for t in cups)

    # each file finds its rows again when it's read again, and deleting one keeps what the other lists
    assert ledger.upsert_transactions(export)[0].added == 0 and ledger.upsert_transactions(statement)[0].added == 0
    ledger.forget_upload("stmt")
    assert sorted(t.amount for t in ledger.load_transactions()) == [60.0, 60.0, 450.0, 999.0]  # the export's


def _upi_on_card(amount: float, at: datetime, payee: str, utr: str) -> Transaction:
    """A payment made with the card over UPI, as PhonePe records it: 'paid from XXXX' + the card's last two digits."""
    return Transaction(id=f"t_{utr}", at=at, amount=amount, direction="debit", channel="upi", app="phonepe", payee=payee,
                       paid_from=f"XXXX{fake_cards.LAST4[-2:]}", refs={"utr": utr}, sources=[SourceRef(upload="u_upi")])


def test_a_card_used_on_upi_is_one_payment_whichever_statement_comes_first(client, tmp_path):
    ledger.upsert_transactions([_upi_on_card(450.00, datetime(2026, 8, 14, 13, 5, tzinfo=IST), "Fake Food App", "900000000101")])
    _upload(client, fake_cards.axis(tmp_path / "Axis.pdf"))
    txns = client.get("/api/transactions").json()
    assert len(txns) == len(fake_cards.ROWS)  # the card's row merged into the UPI payment
    merged = next(t for t in txns if t["refs"].get("utr") == "900000000101")
    assert (merged["channel"], merged["card"], len(merged["sources"]), merged["at"][11:16]) == ("upi", CARD, 2, "13:05")

    # the other way round: the card statement first, the UPI app's payment later
    ledger.upsert_transactions([_upi_on_card(1234.50, datetime(2026, 8, 16, 9, 30, tzinfo=IST), "Fake Grocer", "900000000102")])
    assert len(ledger.load_transactions()) == len(fake_cards.ROWS)


def test_two_identical_card_payments_on_upi_stay_two(client, tmp_path):
    for n in (1, 2):
        ledger.upsert_transactions([_upi_on_card(60.00, datetime(2026, 8, 26, 10, n, tzinfo=IST), "Fake Chai Point", f"90000000020{n}")])
    _upload(client, fake_cards.axis(tmp_path / "Axis.pdf"))
    cups = [t for t in client.get("/api/transactions").json() if t["amount"] == 60.00]
    assert len(cups) == 2 and all(t["card"] == CARD and t["refs"].get("utr") for t in cups)


def test_a_bill_paying_a_statement_you_added_is_covered(client, tmp_path):
    bill = lambda id, day: CardPayment(id=id, at=datetime(2026, day[0], day[1], 12, tzinfo=IST), amount=11737.82,  # noqa: E731
                                       card=CARD, card_title="Axis Bank ••3141", source=SourceRef(upload="u_cred"))
    ledger.upsert_card_payments([bill("before", (8, 22)), bill("after", (9, 25))])
    upload_id, _ = _upload(client, fake_cards.axis(tmp_path / "Axis.pdf"))
    covered = {p["id"]: (p["coveredBy"], p["paysFrom"], p["paysTo"], p["cycle"], p["estimate"]) for p in client.get("/api/card-payments").json()}
    assert covered == {"before": (None, "2026-07-13", "2026-08-12", "card", 11737.82),
                       "after": (upload_id, "2026-08-13", "2026-09-12", "statement", 0.0)}

    # deleting the statement takes its rows and its record, and the bill counts again
    assert client.delete(f"/api/uploads/{upload_id}").status_code == 204
    assert client.get("/api/transactions").json() == [] and client.get("/api/card-statements").json() == []
    assert all(p["coveredBy"] is None for p in client.get("/api/card-payments").json())


def test_a_statement_that_couldnt_be_read_is_tried_again_by_a_better_reader(client, tmp_path):
    from app import imports, vault as files

    path = tmp_path / "Unreadable.pdf"
    page = fake_cards.Page().at(40, "Credit Card Statement").down().at(40, "Card No: 4000 00XX XXXX 3141").down()
    page.at(40, "Payment Due Date: 02/10/2026").down().at(40, "Minimum Amount Due: 1,000.00").down().at(40, "Credit Limit: 3,00,000.00")
    page.down().at(40, "Previous Balance: 9,000.00").down().at(40, "Total Amount Due: 9,000.00")  # and no transactions table
    fake_cards.save(path, [page])
    upload_id, status = _upload(client, path)
    assert status["state"] == "failed"
    rec = next(u for u in files.list_uploads() if u.id == upload_id)
    assert not imports.needs_reading_again(rec)  # tried with this reader
    files.update_upload(upload_id, import_version=imports.parser_version("cc_statement") - 1)
    assert imports.needs_reading_again(next(u for u in files.list_uploads() if u.id == upload_id))


def test_a_password_protected_statement(client, tmp_path):
    path = fake_cards.axis(tmp_path / "Locked.pdf", password="FAKE1234")
    with path.open("rb") as f:
        assert client.post("/api/uploads", files={"file": (path.name, f, "application/pdf")}).json()["detail"]["code"] == "password_required"
    _, status = _upload(client, path, password="FAKE1234")
    assert status["state"] == "done" and len(client.get("/api/transactions").json()) == len(fake_cards.ROWS)


def test_statements_are_kept_in_the_data_folder_only(data_dir):
    s = statements.CardStatement(id="u1", card=CARD, statement_date="2026-09-12")
    statements.save(s)
    assert [x.id for x in statements.list_statements()] == ["u1"]
    assert (data_dir / "card_statements.json").exists()
    assert statements.forget("u1") and statements.list_statements() == []


@pytest.mark.parametrize("layout", ["axis", "hdfc", "no_header"])
def test_make_inspect_shows_the_layout_and_nothing_of_yours(tmp_path, capsys, layout):
    """What `make inspect` prints is pasted to whoever fixes the reader: the layout, never a name or a number."""
    import re as regex

    from app.tools import inspect

    path = getattr(fake_cards, layout)(tmp_path / f"{layout}.pdf")
    inspect.main([str(path)])
    out = capsys.readouterr().out
    assert "card statement reader" in out and "rows read: 11" in out
    for name in ("FAKE", "CHAI", "PUNE", "GROCER", "FAKESTREAM", fake_cards.LAST4):
        assert name not in out
    # the tool's own counts and positions aren't the statement's; everything else must be masked to 9s
    counts = (r"\bp\d+ y\s*\d+|\bx\s*\d+|\by\s*\d+\b|\d+ lines?|\d+ page|first \d+|chars on first pages \[[\d, ]+\]|pages\s*: \d+|"
              r"page \d+ spans: \d+|images: \d+|\(\d\.\d\d\)|cards: \d|rows read: \d+|headers found\s*: \d+|on page [\d, ]+|"
              r"date: \d+|amount: \d+|not read: \d+|recognised=\d+|\(NAME 1234\)=\d+|': \d+|of page \d+|"
              r"statements in this file: \d+|statement \d+|\d+ rows|(?:amount|balance|debit|credit)@\d+|by their shape: \d+|"
              r"line up at x [\d, ]+|pages \d+–\d+")
    left = regex.findall(r".{0,30}[0-8].{0,10}", regex.sub(counts, "", out))
    assert not left, left
