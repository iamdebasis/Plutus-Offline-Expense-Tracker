"""Upload → background import → ledger → corrections, through the HTTP API. The local AI is unavailable
in tests, so unknown names fall back to the offline rules."""

import time

import pytest
from fastapi.testclient import TestClient

from app import payees
from app.main import app
from tests.conftest import PHONEPE_TEXT, make_cred_pdf, make_pdf


@pytest.fixture
def client():
    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def _upload(client, path, kind="auto"):
    with path.open("rb") as f:
        resp = client.post("/api/uploads", files={"file": (path.name, f, "application/pdf")}, data={"kind": kind})
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _wait(client, upload_id, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        rec = next(u for u in client.get("/api/uploads").json() if u["id"] == upload_id)
        status = rec.get("importStatus") or {}
        if status.get("state") in ("done", "failed", "skipped"):
            return status
        time.sleep(0.1)
    raise AssertionError(f"import didn't finish: {status}")


def test_phonepe_import_then_correct_a_payee(client, tmp_path):
    status = _wait(client, _upload(client, make_pdf(tmp_path / "PhonePe.pdf", [PHONEPE_TEXT])))
    assert status["state"] == "done", status
    assert (status["found"], status["added"], status["method"]) == (3, 3, "text")

    txns = {t["payee"]: t for t in client.get("/api/transactions").json()}
    assert txns["Mr Test Person"]["category"] == "transfers.p2p"
    assert txns["Mr Test Person"]["needsReview"] is True

    # label the person once: goes into the payee table, applies to their payments
    resp = client.post("/api/categorize", json={"payee": "Mr Test Person", "category": "bills.water", "label": "Water cans"})
    assert resp.json()["savedAs"] == "payee"
    assert [p.label for p in payees.list_payees()] == ["Water cans"]
    t = next(t for t in client.get("/api/transactions").json() if t["payee"] == "Mr Test Person")
    assert (t["category"], t["categorizedBy"], t["needsReview"]) == ("bills.water", "payee", False)

    # a merchant correction is remembered by name
    resp = client.post("/api/categorize", json={"payee": "FAKEMART", "category": "groceries.supermarket"})
    assert resp.json()["savedAs"] == "merchant"
    t = next(t for t in client.get("/api/transactions").json() if t["payee"] == "FAKEMART")
    assert (t["category"], t["categorizedBy"]) == ("groceries.supermarket", "user")


def test_same_statement_twice_adds_nothing(client, tmp_path):
    _wait(client, _upload(client, make_pdf(tmp_path / "a.pdf", [PHONEPE_TEXT])))
    # a different file (extra page) with the same transactions
    status = _wait(client, _upload(client, make_pdf(tmp_path / "b.pdf", [PHONEPE_TEXT, "Page 2 of 2"])))
    assert (status["added"], status["duplicates"]) == (0, 3)
    assert len(client.get("/api/transactions").json()) == 3


def test_cred_import_and_delete(client, tmp_path):
    pdf = make_cred_pdf(tmp_path / "cred.pdf", [
        ("21 mar 2025", "04:00 PM", "YES BANK 3141", "4321.50", "01AAA-1", "CV111"),
        ("14 mar 2025", "02:00 PM", "RBL FAKESHOP 1357", "38765.25", "01BBB-2", "CV222"),
    ])
    upload_id = _upload(client, pdf, kind="cred_history")
    status = _wait(client, upload_id)
    assert (status["state"], status["added"]) == ("done", 2)
    assert [p["amount"] for p in client.get("/api/card-payments").json()] == [38765.25, 4321.50]
    assert client.get("/api/status").json()["cardPayments"] == 2

    client.delete(f"/api/uploads/{upload_id}")
    assert client.get("/api/card-payments").json() == []


def test_unsupported_kind_is_skipped_with_a_reason(client, tmp_path):
    bank = ("Account Statement\nAccount Number: XXXXXXXX1234\nIFSC: ABCD0001234\nOpening Balance 1,000.00\n"
            "Closing Balance 900.00\n01/09/2025 ATM Withdrawal 100.00")
    status = _wait(client, _upload(client, make_pdf(tmp_path / "bank.pdf", [bank])))
    assert status["state"] == "skipped"
    assert "Bank account statements" in status["error"]


def test_changed_rules_are_applied_to_the_existing_ledger_at_startup(data_dir):
    """A ledger categorized under old rules (self-transfers as their own category) is brought up to date
    when the app starts, once."""
    from datetime import datetime

    from app import ledger
    from app.models import SourceRef, Transaction
    from app.parsers import IST

    ledger.save_transactions([
        Transaction(id="own", at=datetime(2025, 5, 1, tzinfo=IST), amount=10000, direction="debit",
                    payee="Bank Account XXXXXXXX1111", paid_from="XX1111", category="transfers.self",
                    categorized_by="self", confidence=0.95, sources=[SourceRef(upload="u")]),
        Transaction(id="shop", at=datetime(2025, 5, 2, tzinfo=IST), amount=120, direction="debit",
                    payee="Mystery Stall", paid_from="XX1111", category="food.snacks", categorized_by="user",
                    sources=[SourceRef(upload="u")]),
    ])
    with TestClient(app, base_url="http://127.0.0.1") as c:
        txns = {t["id"]: t for t in c.get("/api/transactions").json()}
    assert txns["own"]["category"] == "ignored"
    assert txns["shop"]["category"] == "food.snacks"  # your own choices are never touched
    assert '"rulesVersion"' in (data_dir / "state.json").read_text()


def test_a_changed_payee_table_is_applied_to_the_existing_ledger(data_dir):
    """Your payee table beats the other rules, even for payments imported before the entry changed:
    through the API right away, and when payees.json was edited by hand, at the next start."""
    import json
    from datetime import datetime

    from app import ledger, payees
    from app.models import Payee, SourceRef, Transaction
    from app.parsers import IST

    payees.upsert_payee(Payee(id="acct", name="Bank Account XXXXXX9999", label="Ignored", category="ignored"))
    ledger.save_transactions([
        Transaction(id=f"r{i}", at=datetime(2025, 5, i + 1, tzinfo=IST), amount=20000, direction="debit",
                    payee="Bank Account XXXXXX9999", paid_from="XX1111", category="ignored", categorized_by="payee",
                    confidence=1.0, sources=[SourceRef(upload="u")])
        for i in range(2)
    ])
    with TestClient(app, base_url="http://127.0.0.1") as c:
        c.get("/api/transactions")  # startup records the table as applied
        body = {"id": "acct", "name": "Bank Account XXXXXX9999", "label": "Rent to landlord", "category": "home.rent"}
        assert c.put("/api/payees/acct", json=body).status_code == 200
        assert {t["category"] for t in c.get("/api/transactions").json()} == {"home.rent"}

    # edited by hand while the app was stopped
    doc = json.loads((data_dir / "payees.json").read_text())
    doc["payees"][0]["category"] = "home.maintenance"
    (data_dir / "payees.json").write_text(json.dumps(doc))
    with TestClient(app, base_url="http://127.0.0.1") as c:
        assert {t["category"] for t in c.get("/api/transactions").json()} == {"home.maintenance"}


def test_merchant_glued_to_its_payment_gateway():
    from app.categorize import merchant_name

    assert merchant_name("SwiggyRazorpay") == "Swiggy"
    assert merchant_name("WWW SWIGGY COM") == "Swiggy"
