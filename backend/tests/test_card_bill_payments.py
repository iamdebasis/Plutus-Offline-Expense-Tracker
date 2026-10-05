"""A statement's row for paying the card ("PAYMENT RECEIVED - THANK YOU") is a credit card bill: never spending and
never money in. Nothing learned about a name moves it (a "Change all", an answer in the review list, a correction by
payee): the wording is the bank's, not a shop's, and the next statement's payment would follow. Only a change to that
one row, which the page asks you to confirm, does. Fake data only."""

import time
from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.main import app
from tests import fake_cards

CARD_BILL = "transfers.card_bill"


@pytest.fixture
def client():
    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def _add(client, path):
    with path.open("rb") as f:
        upload_id = client.post("/api/uploads", files={"file": (path.name, f, "application/pdf")}, data={"kind": "auto"}).json()["id"]
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        rec = next((u for u in client.get("/api/uploads").json() if u["id"] == upload_id), None)
        if rec and (rec.get("importStatus") or {}).get("state") in ("done", "failed", "skipped"):
            return upload_id
        time.sleep(0.1)
    raise AssertionError("import didn't finish")


def _next_month(path):
    """Another statement of the card, with its own payment worded the same way (it adds up, so it's counted)."""
    return fake_cards.axis(path, rows=[
        fake_cards.Txn(date(2026, 9, 5), "FAKE BOOKSHOP,PUNE", "BOOKS", 700.00),
        fake_cards.Txn(date(2026, 9, 6), "PAYMENT RECEIVED - THANK YOU", "", 5000.00, credit=True),
    ])


def _payment(client):
    return next(t for t in client.get("/api/transactions").json() if t["payee"] == "PAYMENT RECEIVED - THANK YOU")


def test_a_statements_card_payment_is_a_card_bill(client, tmp_path):
    _add(client, fake_cards.axis(tmp_path / "axis.pdf"))
    paid = _payment(client)
    assert (paid["kind"], paid["direction"], paid["category"]) == ("bill_payment", "credit", CARD_BILL)


def test_nothing_learned_by_name_moves_it(client, tmp_path):
    _add(client, fake_cards.axis(tmp_path / "axis.pdf"))
    name = _payment(client)["payee"]

    shop = client.post("/api/categorize/shop", json={"payees": [name], "category": "shopping.online"})
    assert shop.status_code == 200 and shop.json()["updated"] == 0  # "Change all" never reaches it
    assert _payment(client)["category"] == CARD_BILL

    assert client.post("/api/categorize", json={"payee": name, "category": "income.received"}).status_code == 200
    assert client.post("/api/categorize/bulk", json={"items": [{"payee": name, "category": "food.snacks"}]}).status_code == 200
    assert client.post("/api/recategorize").status_code == 200
    assert _payment(client)["category"] == CARD_BILL

    _add(client, _next_month(tmp_path / "next.pdf"))  # the next statement's payment, worded the same way
    payments = [t for t in client.get("/api/transactions").json() if t["payee"] == name]
    assert len(payments) == 2 and all(t["category"] == CARD_BILL for t in payments)


def test_changing_that_one_row_is_yours_to_make(client, tmp_path):
    """The page asks first; once you confirm, your answer for the row stands and is kept with it."""
    _add(client, fake_cards.axis(tmp_path / "axis.pdf"))
    _add(client, _next_month(tmp_path / "next.pdf"))
    paid = _payment(client)
    res = client.post("/api/categorize", json={"transactionId": paid["id"], "category": "income.received"}).json()
    assert res["related"] == []  # no "Change all" offered for the other payment worded the same way
    assert client.post("/api/recategorize").status_code == 200
    rows = {t["id"]: t for t in client.get("/api/transactions").json() if t["payee"] == paid["payee"]}
    assert (rows[paid["id"]]["category"], rows[paid["id"]]["categorizedBy"]) == ("income.received", "user")
    assert [t["category"] for i, t in rows.items() if i != paid["id"]] == [CARD_BILL]  # the other stays a card bill


def test_ticked_with_others_it_changes_and_undo_puts_it_back(client, tmp_path):
    _add(client, fake_cards.axis(tmp_path / "axis.pdf"))
    paid = _payment(client)
    grocer = next(t for t in client.get("/api/transactions").json() if t["payee"] == "FAKE GROCER")
    res = client.post("/api/categorize/payments", json={"transactionIds": [paid["id"], grocer["id"]], "category": "bills.electricity"})
    assert res.status_code == 200 and res.json()["updated"] == 2
    assert _payment(client)["category"] == "bills.electricity"
    assert client.post("/api/categorize/payments/undo", json=res.json()["before"]).status_code == 200
    assert _payment(client)["category"] == CARD_BILL
