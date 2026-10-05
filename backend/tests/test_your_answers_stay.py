"""What you set stays: through a page refresh, a statement read again, its file deleted and added again, and an
import running while you change things. Fake data only."""

import time

import pytest
from fastapi.testclient import TestClient

from app import categorize, imports, ledger, vault
from app.main import app
from app.parsers import card_statement
from tests import fake_cards


@pytest.fixture
def client():
    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def _wait(client, upload_id):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        rec = next((u for u in client.get("/api/uploads").json() if u["id"] == upload_id), None)
        if rec and (rec.get("importStatus") or {}).get("state") in ("done", "failed", "skipped"):
            return rec["importStatus"]
        time.sleep(0.1)
    raise AssertionError("import didn't finish")


def _add(client, path):
    with path.open("rb") as f:
        upload_id = client.post("/api/uploads", files={"file": (path.name, f, "application/pdf")}, data={"kind": "auto"}).json()["id"]
    _wait(client, upload_id)
    return upload_id


def _txns(client):
    return {t["note"]: t for t in client.get("/api/transactions").json()}


def test_one_payment_you_set_survives_its_file_deleted_and_added_again(client, tmp_path):
    path = fake_cards.axis(tmp_path / "axis.pdf")
    upload_id = _add(client, path)
    chai = next(t for t in client.get("/api/transactions").json() if t["note"].startswith("FAKE CHAI POINT"))
    assert client.post("/api/categorize", json={"transactionId": chai["id"], "category": "food.snacks"}).status_code == 200
    assert next(t for t in client.get("/api/transactions").json() if t["id"] == chai["id"])["category"] == "food.snacks"  # a refresh

    client.delete(f"/api/uploads/{upload_id}")
    assert client.get("/api/transactions").json() == []
    _add(client, fake_cards.axis(tmp_path / "again.pdf"))
    back = next(t for t in client.get("/api/transactions").json() if t["id"] == chai["id"])
    assert (back["category"], back["categorizedBy"]) == ("food.snacks", "user")
    others = [t for t in client.get("/api/transactions").json() if t["note"].startswith("FAKE CHAI POINT") and t["id"] != chai["id"]]
    assert all(t["category"] != "food.snacks" for t in others)  # only the one you set: the other cup is its own payment


def test_every_payment_you_set_survives_even_if_a_better_reader_renames_the_shop(client, tmp_path, monkeypatch):
    upload_id = _add(client, fake_cards.axis(tmp_path / "axis.pdf"))
    grocer = next(t for t in client.get("/api/transactions").json() if "GROCER" in t["note"])
    assert client.post("/api/categorize/shop", json={"payees": [grocer["payee"]], "category": "shopping.online"}).status_code == 200
    client.delete(f"/api/uploads/{upload_id}")
    renamed = card_statement.clean_merchant
    monkeypatch.setattr(card_statement, "clean_merchant", lambda d: f"RENAMED {renamed(d)}")
    _add(client, fake_cards.axis(tmp_path / "again.pdf"))
    back = next(t for t in client.get("/api/transactions").json() if "GROCER" in t["note"])
    assert back["payee"].startswith("RENAMED") and back["category"] == "shopping.online"


def test_a_statement_read_again_keeps_what_you_set(client, tmp_path):
    upload_id = _add(client, fake_cards.axis(tmp_path / "axis.pdf"))
    first = client.get("/api/transactions").json()[0]
    client.post("/api/categorize", json={"transactionId": first["id"], "category": "shopping.online"})
    vault.update_upload(upload_id, import_version=imports.parser_version("cc_statement") - 1)
    client.post(f"/api/uploads/{upload_id}/reimport")
    _wait(client, upload_id)
    assert next(t for t in client.get("/api/transactions").json() if t["id"] == first["id"])["category"] == "shopping.online"


def test_a_slow_step_of_an_import_never_writes_over_what_you_set_meanwhile(client, tmp_path):
    """The local AI sorting new payees takes a while; the import then saves its copies of them. A payment you set in
    the meantime keeps your answer."""
    _add(client, fake_cards.axis(tmp_path / "axis.pdf"))
    stale = ledger.load_transactions()  # the import's copies, taken before you answered
    target = stale[0]
    client.post("/api/categorize", json={"transactionId": target.id, "category": "food.snacks"})
    target.category, target.categorized_by = "shopping.online", "llm"
    ledger.update_transactions(stale)
    assert next(t for t in ledger.load_transactions() if t.id == target.id).category == "food.snacks"


def test_a_change_holds_the_ledger_from_reading_it_to_saving_it(client, tmp_path, monkeypatch):
    """Nothing (an import adding rows, another change) can write between a change reading the ledger and saving it,
    so neither undoes the other."""
    _add(client, fake_cards.axis(tmp_path / "axis.pdf"))
    held = []
    link = categorize.link_refunds
    monkeypatch.setattr(categorize, "link_refunds", lambda txns: (held.append(ledger.editing()._is_owned()), link(txns))[1])
    t = client.get("/api/transactions").json()[0]
    client.post("/api/categorize", json={"transactionId": t["id"], "category": "food.snacks"})
    client.post("/api/categorize/shop", json={"payees": [t["payee"]], "category": "food.snacks"})
    assert held and all(held)


def test_what_you_set_before_rows_were_kept_is_kept_from_the_next_start(tmp_path):
    """Payments you set one by one before answers were kept with their rows: the next start keeps them too."""
    from datetime import datetime

    from app.models import Transaction
    from app.parsers import IST

    t = Transaction(id="t1", at=datetime(2026, 8, 1, tzinfo=IST), amount=99.0, direction="debit", kind="spend", channel="card",
                    payee="FAKE SHOP", refs={"cardRow": "3141:20260801:d:99.00:1"}, category="food.snacks", categorized_by="user")
    ledger.save_transactions([t])
    with TestClient(app, base_url="http://127.0.0.1"):
        pass
    assert categorize.build_context([]).rows == {"card:3141:20260801:d:99.00:1": "food.snacks"}


def _one_payee_many_bills(tmp_path):
    """A payment company in front of several kinds of bill: five payments to one name (fake)."""
    from datetime import date

    from tests.fake_cards import ROWS, Txn

    bills = [Txn(date(2026, 8, d), "FAKE PAYMENTS LIMITED GURGAON", "", a) for d, a in ((15, 111.11), (17, 2222.22), (19, 333.33),
                                                                                       (21, 4444.44), (23, 555.55))]
    return fake_cards.axis(tmp_path / "bills.pdf", rows=[*ROWS, *bills])


def test_payments_picked_out_take_a_category_and_their_payee_learns_nothing(client, tmp_path):
    """Pick three of the payee's five payments and file them under electricity: those three change, the other two
    stay; nothing is remembered for the payee (its next payment isn't assumed to be electricity); each is kept with
    its row, so deleting and adding the file again keeps them."""
    upload_id = _add(client, _one_payee_many_bills(tmp_path))
    theirs = sorted((t for t in client.get("/api/transactions").json() if t["payee"].startswith("FAKE PAYMENTS")), key=lambda t: t["at"])
    picked, rest = theirs[:3], theirs[3:]
    res = client.post("/api/categorize/payments", json={"transactionIds": [t["id"] for t in picked], "category": "bills.electricity"})
    assert res.status_code == 200 and res.json()["updated"] == 3
    now = {t["id"]: t for t in client.get("/api/transactions").json()}
    assert all((now[t["id"]]["category"], now[t["id"]]["categorizedBy"], now[t["id"]]["needsReview"]) == ("bills.electricity", "user", False) for t in picked)
    assert all(now[t["id"]]["category"] == t["category"] for t in rest)  # the payee's other payments as they were
    assert not any(v.get("by") == "user" for k, v in categorize.load_memory().items() if "fake payments" in k)

    client.delete(f"/api/uploads/{upload_id}")
    _add(client, _one_payee_many_bills(tmp_path))
    again = {t["id"]: t for t in client.get("/api/transactions").json()}
    assert all(again[t["id"]]["category"] == "bills.electricity" for t in picked)
    assert all(again[t["id"]]["category"] != "bills.electricity" for t in rest)


def test_a_change_of_several_payments_can_be_undone_exactly(client, tmp_path):
    _add(client, _one_payee_many_bills(tmp_path))
    theirs = [t for t in client.get("/api/transactions").json() if t["payee"].startswith("FAKE PAYMENTS")]
    client.post("/api/categorize", json={"transactionId": theirs[0]["id"], "category": "shopping.online"})  # one you'd set before
    before = {t["id"]: (t["category"], t["categorizedBy"], t["needsReview"]) for t in client.get("/api/transactions").json()}
    res = client.post("/api/categorize/payments", json={"transactionIds": [t["id"] for t in theirs], "category": "insurance"})
    assert client.post("/api/categorize/payments/undo", json=res.json()["before"]).json()["updated"] == len(theirs)
    after = {t["id"]: (t["category"], t["categorizedBy"], t["needsReview"]) for t in client.get("/api/transactions").json()}
    assert after == before
    # and what's kept by row is as before too: yours stays yours, the rest isn't kept as if you'd set it
    rows = categorize.build_context([]).rows
    kept = {k for k, v in rows.items()}
    assert sum(1 for t in ledger.load_transactions() if categorize.row_key(t) in kept) == 1


def test_picking_payments_needs_a_known_category_and_payments_that_exist(client, tmp_path):
    _add(client, _one_payee_many_bills(tmp_path))
    some = client.get("/api/transactions").json()[0]["id"]
    assert client.post("/api/categorize/payments", json={"transactionIds": [some], "category": "no.such"}).status_code == 400
    assert client.post("/api/categorize/payments", json={"transactionIds": [], "category": "insurance"}).status_code == 400
    assert client.post("/api/categorize/payments", json={"transactionIds": [some, "gone"], "category": "insurance"}).status_code == 404
    assert next(t for t in client.get("/api/transactions").json() if t["id"] == some)["category"] != "insurance"  # nothing half-done
