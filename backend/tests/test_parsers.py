from datetime import datetime

import pymupdf

from app.ingest.textlines import page_lines
from app.parsers import IST, cred, phonepe, screenshot
from tests.conftest import PHONEPE_TEXT, make_cred_pdf, make_pdf


def _lines(path):
    with pymupdf.open(path) as doc:
        return page_lines(doc)


def test_phonepe_statement(tmp_path):
    pages, method = _lines(make_pdf(tmp_path / "p.pdf", [PHONEPE_TEXT]))
    result = phonepe.parse(pages, method, "upl_1")
    assert method == "text"
    assert result.warnings == []
    first, second, third = result.transactions
    assert first.payee == "Mr Test Person"
    assert first.amount == 111.0
    assert first.at == datetime(2025, 4, 10, 10, 0, tzinfo=IST)
    assert first.refs == {"txnId": "T2504101000000000000001", "utr": "900000000001"}
    assert first.paid_from == "XX1111"
    assert (second.payee, second.amount) == ("FAKEMART", 1234.0)
    assert third.paid_from == "XXXX99"
    assert third.at == datetime(2025, 4, 12, 12, 0, tzinfo=IST)  # 12:00 PM is noon


def test_phonepe_split_payment_and_cashback(tmp_path):
    text = """Apr 15, 2025
08:00 PM
Paid to FAKE TEA STALL
Transaction ID : T1
UTR No : 111111111111
Debited from XXXX99 INR 15.00 | Gift Card INR 15.00
Debit
INR 30.00
Apr 16, 2025
01:00 PM
Cashback Received
Transaction ID : T2
Credited to Gift Card
Credit
INR
2.00
"""
    pages, method = _lines(make_pdf(tmp_path / "p.pdf", [text]))
    split, cashback = phonepe.parse(pages, method, "upl_1").transactions
    assert split.paid_from == "XXXX99"
    assert split.note == "Split payment: XXXX99 ₹15.00 + Gift Card ₹15.00"
    assert (cashback.kind, cashback.direction, cashback.amount) == ("cashback", "credit", 2.0)


def test_cred_history(tmp_path):
    pdf = make_cred_pdf(tmp_path / "c.pdf", [
        ("21 mar 2025", "04:00 PM", "YES BANK 3141", "4321.50", "01AAA-1", "CV111"),
        ("14 mar 2025", "02:00 PM", "RBL FAKESHOP 1357", "38765.25", "01BBB-2", "CV222"),
        ("07 mar 2025", "10:00 PM", "HSBC FAKE PLUS 2468", "28765.00", "01CCC-3", "300000000003"),
    ])
    pages, method = _lines(pdf)
    result, cards = cred.parse(pages, method, "upl_1")
    assert [(p.card, p.amount) for p in result.card_payments] == [
        ("card-yes-bank-3141", 4321.50), ("card-rbl-bank-1357", 38765.25), ("card-hsbc-2468", 28765.0),
    ]
    first = result.card_payments[0]
    assert first.at == datetime(2025, 3, 21, 16, 0, tzinfo=IST)
    assert first.refs == {"credTxnId": "01AAA-1", "utr": "CV111"}
    assert {(c.product, c.last4) for c in cards} == {(None, "3141"), ("Fakeshop", "1357"), ("Fake Plus", "2468")}


def test_cred_amount_must_agree_with_ocr():
    assert cred._checked_amount("1234.56", "81234.56") == (1234.56, True)  # ₹ read as '8'
    assert cred._checked_amount("4321.50", "฿4321.50") == (4321.50, True)
    assert cred._checked_amount("4321.50", "4331.50") == (4321.50, False)


def test_screenshot_rules_on_phonepe_receipt():
    # what on-device OCR returns for a PhonePe receipt, in reading order
    lines = [
        "Transaction Successful", "28 September 2026 at 7:35 PM", "Paid to", "Fake Chai Point", "·30",
        "paytm.fake@pty", "Payment Details", "V", "PhonePe Transaction ID", "T2609281935370000000001",
        "Debited from", "400000XXXXXXXX99", "·30", "UTR: 227000000001",
    ]
    f = screenshot._rules(lines)
    assert screenshot._complete(f)
    t = screenshot._transaction(f, "upl_1")
    assert (t.payee, t.amount, t.payee_handle, t.paid_from, t.app) == ("Fake Chai Point", 30.0, "paytm.fake@pty", "XXXX99", "phonepe")
    assert t.at == datetime(2026, 9, 28, 19, 35, tzinfo=IST)
    assert t.refs == {"txnId": "T2609281935370000000001", "utr": "227000000001"}
    assert not t.needs_review


def test_screenshot_ids_are_not_amounts():
    assert screenshot._currency_amount("T2609281935370000000001") is None
    assert screenshot._currency_amount("₹1,250.50") == 1250.5
    assert screenshot._currency_amount("·30") == 30.0


def test_failed_payment_screenshot_is_rejected():
    import pytest
    from app.parsers import ParseError

    with pytest.raises(ParseError):
        screenshot._rules(["Payment Failed", "28 September 2026 at 7:35 PM", "Paid to", "X", "₹30"])


def test_repair_case_uses_glyph_order():
    from app.ingest.textlines import repair_case

    font = ("f", 9.0)
    # glyphs numbered in character order: 'W' came from OCR, but it sits after the small letters
    table = {(font, 10): "A", (font, 11): "B", (font, 20): "e", (font, 21): "W", (font, 22): "y"}
    assert repair_case(table)[(font, 21)] == "w"
    assert repair_case(table)[(font, 10)] == "A"  # letters already in place are left alone
