"""A card's transactions exported by the bank over a span you choose: CSV, Excel, or the HTML table some banks save as
.xls. Read with the statement reader's rules, matched with the statements they overlap, and covering the bills of the
cycles they list whole (fake exports only, tests/fake_cards.py)."""

from datetime import date, datetime

import pytest

from app import ledger, vault
from app.ingest.detect import detect
from app.models import CardPayment, CardRef, SourceRef
from app.parsers import IST, card_export
from tests import fake_cards
from tests.test_card_statements import CARD, _upload, client  # noqa: F401  (the client fixture)

EVERY_ROW = fake_cards.ROWS + fake_cards.EXPORT_EXTRA
DEBITS = round(sum(t.amount for t in EVERY_ROW if not t.credit), 2)
CREDITS = round(sum(t.amount for t in EVERY_ROW if t.credit), 2)

MAKERS = {
    "csv, Dr/Cr column": lambda p: fake_cards.csv_export(p / "card.csv", style="drcr"),
    "csv, signed amounts": lambda p: fake_cards.csv_export(p / "card.csv", style="signed"),
    "csv, debit and credit columns": lambda p: fake_cards.csv_export(p / "card.csv", style="columns"),
    "Excel": lambda p: fake_cards.xlsx_export(p / "card.xlsx"),
    "HTML saved as .xls": lambda p: fake_cards.html_xls_export(p / "card.xls"),
}


@pytest.mark.parametrize("made", MAKERS)
def test_every_export_format_reads_every_row(tmp_path, made):
    """Most exports don't name their bank: the card you have with those last four digits is theirs."""
    vault.register_cards([CardRef(issuer="Axis Bank", last4=fake_cards.LAST4)], "upl_statement")
    path = MAKERS[made](tmp_path)
    det = detect(path, path.name)
    assert (det.kind, [c.last4 for c in det.cards]) == ("cc_statement", [fake_cards.LAST4])
    result = card_export.parse(path, "upl_x", det)
    s = result.statement
    assert (s.kind, s.check, s.card, s.rows) == ("export", "unchecked", CARD, len(EVERY_ROW))
    assert (s.debits, s.credits) == (DEBITS, CREDITS)
    kinds = {t.note.split()[0]: t.kind for t in result.transactions}
    assert (kinds["PAYMENT"], kinds["REFUND"], kinds["CASHBACK"]) == ("bill_payment", "refund", "cashback")
    assert min(t.at.date() for t in result.transactions) == date(2026, 7, 20)
    if made.startswith("csv"):  # the span it says it covers, not just its first and last rows
        assert (s.period_start, s.period_end) == ("2026-07-15", "2026-09-25")


def test_an_export_of_a_card_you_dont_have_yet_is_a_card_of_its_own(tmp_path):
    result = card_export.parse(fake_cards.csv_export(tmp_path / "card.csv", style="columns"), "upl_x", detect(tmp_path / "card.csv", "card.csv"))
    assert result.statement.card == f"card-card-{fake_cards.LAST4}"


def test_signed_amounts_without_payments_take_the_rarer_sign_for_credits(tmp_path):
    rows = [t for t in EVERY_ROW if not t.details.startswith("PAYMENT")]
    result = card_export.parse(fake_cards.csv_export(tmp_path / "card.csv", style="signed", rows=rows), "upl_x",
                               detect(tmp_path / "card.csv", "card.csv"))
    held = result.statement.held  # the sign that marks credits was a guess: held for you to check, not counted
    assert (result.statement.status, result.transactions) == ("on_hold", [])
    assert {t.note for t in held if t.direction == "credit"} == {"REFUND FAKE FOOD APP", "CASHBACK CREDIT"}


def test_a_bank_accounts_export_is_not_a_cards(tmp_path):
    path = tmp_path / "account.csv"
    path.write_text("Account No,XXXXXXXX1111\nDate,Narration,Withdrawal Amt.,Deposit Amt.,Closing Balance\n"
                    "01/08/2026,FAKE GROCER,450.00,,10000.00\n02/08/2026,SALARY,,50000.00,60000.00\n")
    assert card_export.looks_like_card_export(path)[0] is False
    assert detect(path, path.name).kind != "cc_statement"


def test_an_old_binary_excel_file_asks_to_be_saved_as_xlsx(tmp_path):
    path = tmp_path / "old.xls"
    path.write_bytes(bytes.fromhex("d0cf11e0a1b11ae1") + b"\x00" * 600)
    with pytest.raises(card_export.ParseError, match="save it as .xlsx"):
        card_export.read_table(path)


def test_an_export_and_the_statement_it_overlaps_count_each_purchase_once(client, tmp_path):  # noqa: F811
    """The monthly statement for 13 Aug – 12 Sep, then the bank's export of 15 Jul – 25 Sep, which dates each
    purchase when it posted: the statement's purchases once, the export's others added, and the bills of the
    cycles the export lists whole covered by it."""
    bill = lambda id, day, amount: CardPayment(id=id, at=datetime(2026, day[0], day[1], 12, tzinfo=IST), amount=amount,  # noqa: E731
                                               card=CARD, card_title="Axis Bank ••3141", source=SourceRef(upload="u_cred"))
    # August's is CRED's record of the payment the statement shows it received (₹9,000, posted on the 22nd): one bill
    ledger.upsert_card_payments([bill("aug", (8, 21), 9000.0), bill("sep", (9, 25), 11712.27), bill("oct", (10, 25), 3000.0)])
    statement, _ = _upload(client, fake_cards.axis(tmp_path / "Axis.pdf"))
    export, status = _upload(client, fake_cards.csv_export(tmp_path / "Axis_card_transactions.csv", posted=1))
    assert status["state"] == "done", status

    txns = client.get("/api/transactions").json()
    assert len(txns) == len(EVERY_ROW)  # each purchase once
    both = [t for t in txns if {s["upload"] for s in t["sources"]} == {statement, export}]
    assert len(both) == len(fake_cards.ROWS)
    assert {t["amount"] for t in txns if [s["upload"] for s in t["sources"]] == [export]} == {640.00, 2000.00}

    placed = {p["id"]: (p["coveredBy"], p["paysFrom"], p["paysTo"], p["estimate"]) for p in client.get("/api/card-payments").json()}
    assert placed["sep"] == (statement, "2026-08-13", "2026-09-12", 0.0)
    # 13 Jul – 12 Aug: the export starts on the 15th, so it isn't whole; what it lists of the cycle comes off
    assert placed["aug"] == (None, "2026-07-13", "2026-08-12", 9000.0 - 640.0)
    assert set(placed) == {"aug", "sep", "oct"}  # the statement's payment row is August's bill, not another
    assert placed["oct"] == (None, "2026-09-13", "2026-10-12", 3000.0 - 2000.0)
    kinds = {s["id"]: s["kind"] for s in client.get("/api/card-statements").json()}
    assert kinds == {statement: "statement", export: "export"}


def test_files_added_before_exports_were_read_are_read_now(client, tmp_path):  # noqa: F811
    """At startup, files identified by an older detector are identified again; only those that turn out to be
    something else now are read again."""
    from app import imports, vault as files
    from app.models import Detection, ImportStatus

    export, _ = _upload(client, fake_cards.csv_export(tmp_path / "card.csv"))
    statement, _ = _upload(client, fake_cards.axis(tmp_path / "Axis.pdf"))
    files.update_upload(export, detection=Detection(kind="unknown", label="Unrecognised export"), detector_version=2,
                        import_status=ImportStatus(state="skipped"))
    files.update_upload(statement, detector_version=2)
    imports.redetect_old_uploads()
    after = {u.id: u for u in files.list_uploads()}
    assert (after[export].detection.kind, after[export].import_status) == ("cc_statement", None)  # to be read again
    assert after[statement].import_status.state == "done" and after[statement].detector_version == imports.DETECTOR_VERSION
