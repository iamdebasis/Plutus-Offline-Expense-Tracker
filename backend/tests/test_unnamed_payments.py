"""Payments whose source shows no payee name ("Unknown") are many payees under one label: nothing decided for
the name may land on all of them (fake data only)."""

import json
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app import categorize, ledger
from app.categorize import Context, decide
from app.main import app
from app.models import NO_NAME, SourceRef, Transaction
from app.parsers import IST

AT = datetime(2020, 5, 1, 19, 30, tzinfo=IST)


@pytest.fixture
def client():
    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def _t(id, payee, amount, day=1):
    return Transaction(id=id, at=AT.replace(day=day), amount=amount, direction="debit", payee=payee,
                       sources=[SourceRef(upload="u")], paid_from="XX1111")


def test_waits_for_you_and_never_goes_to_the_local_ai():
    v = decide(_t("a", NO_NAME, 500), Context(payees=[], own_digits=set()))
    assert v is not None and (v.category, v.needs_review) == ("uncategorized", True)  # None would mean "ask the AI"


def test_an_answer_remembered_for_the_name_is_ignored(data_dir):
    remembered = {categorize.normalize(NO_NAME): {"category": "food.restaurants", "by": "user"}}
    v = decide(_t("a", NO_NAME, 500), Context(payees=[], own_digits=set(), memory=remembered))
    assert v.category == "uncategorized"
    categorize.remember({categorize.normalize(NO_NAME): "food.restaurants"}, by="user")
    assert categorize.load_memory() == {}


def test_one_answer_for_all_of_them_is_refused(client, data_dir):
    ledger.upsert_transactions([_t("a", NO_NAME, 500), _t("b", NO_NAME, 20000, day=2), _t("s", "FAKE SHOP", 300, day=3)])
    res = client.post("/api/categorize", json={"payee": NO_NAME, "category": "food.restaurants"})
    assert res.status_code == 400 and res.json()["detail"]["code"] == "no_name"

    # "Looks right for all" saves the others and leaves them be
    res = client.post("/api/categorize/bulk", json={"items": [{"payee": NO_NAME, "category": "food.restaurants"},
                                                             {"payee": "FAKE SHOP", "category": "shopping.online"}]}).json()
    assert res["confirmed"] == 1
    got = {t["id"]: t for t in client.get("/api/transactions").json()}
    assert got["a"]["category"] == got["b"]["category"] == "uncategorized"
    assert got["s"]["category"] == "shopping.online"
    assert not (data_dir / "merchant_memory.json").exists() or "unknown" not in json.loads((data_dir / "merchant_memory.json").read_text())

    assert client.post("/api/categorize/shop", json={"payees": [NO_NAME], "category": "food.restaurants"}).status_code == 400


def test_one_at_a_time_works_and_offers_no_others(client, data_dir):
    ledger.upsert_transactions([_t("a", NO_NAME, 500), _t("b", NO_NAME, 20000, day=2)])
    res = client.post("/api/categorize", json={"transactionId": "a", "category": "food.restaurants"}).json()
    assert res["related"] == []  # every payment without a name is someone else
    got = {t["id"]: t for t in client.get("/api/transactions").json()}
    assert (got["a"]["category"], got["b"]["category"]) == ("food.restaurants", "uncategorized")
