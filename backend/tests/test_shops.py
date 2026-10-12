"""Each payment's shop, as the page gets it from /api/transactions: one shop however its files spell it (the merchant
list's name when it knows the shop, else the spelling its payments use most), worked out on the way out and never
stored. The page groups "top shops" by it (web/src/lib/focus.ts)."""

import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import categorize, ledger, userdata
from app.main import app
from app.models import NO_NAME, Transaction

IST = timezone(timedelta(hours=5, minutes=30))


def _txn(n: int, payee: str) -> Transaction:
    return Transaction(id=f"t{n}", at=datetime(2026, 3, 1, 12, tzinfo=IST) + timedelta(days=n), amount=100.0 + n,
                       direction="debit", payee=payee, category="groceries.local")


@pytest.fixture
def shops():
    names = ["BLINKIT GURGAON", "Blinkit", "blink commerce pvt ltd",  # the merchant list knows it: "Blinkit"
             "FAKEMART LIMITED", "FAKEMART LIMITED", "Fakemart",  # unknown: its payments' most used spelling
             "Fakeclub", "Fakeclub Swimming Academy",  # only a word in common: two shops
             NO_NAME, NO_NAME]  # many payees under one placeholder: never one shop with a name
    ledger.save_transactions([_txn(i, name) for i, name in enumerate(names)])
    with TestClient(app, base_url="http://127.0.0.1") as client:
        rows = client.get("/api/transactions").json()
    return {(r["payee"], r["id"]): r["shop"] for r in rows}


def test_one_shop_however_its_files_spell_it(shops):
    by_payee = {payee: shop for (payee, _), shop in shops.items()}
    assert by_payee["BLINKIT GURGAON"] == by_payee["Blinkit"] == by_payee["blink commerce pvt ltd"] == "Blinkit"
    assert by_payee["FAKEMART LIMITED"] == by_payee["Fakemart"] == "FAKEMART LIMITED"
    assert by_payee["Fakeclub"] == "Fakeclub" and by_payee["Fakeclub Swimming Academy"] == "Fakeclub Swimming Academy"
    assert by_payee[NO_NAME] == NO_NAME


def test_the_spelling_shown_is_the_one_used_most_then_the_first_alphabetically():
    assert categorize.shops(["Fakemart", "FAKEMART LIMITED", "FAKEMART LIMITED"]) == {"Fakemart": "FAKEMART LIMITED", "FAKEMART LIMITED": "FAKEMART LIMITED"}
    assert categorize.shops(["Fakemart", "FAKEMART LIMITED"])["Fakemart"] == "FAKEMART LIMITED"  # a tie: "F" before "Fa"


def test_the_shop_is_never_stored(shops):
    stored = [row for f in userdata.path("ledger").glob("*.json") for row in json.loads(f.read_text(encoding="utf-8"))]
    assert stored and not any("shop" in row for row in stored)


KINDS = ["Supermarket chain", "Metro", "FASTag", "Mobile recharge", "Electricity board", "Water board", "Gas",
         "Mutual fund", "Dairy cooperative"]


def test_a_kind_of_payee_is_not_one_shop():
    """Some entries of the merchant list name a kind of payee, many companies under one name (every electricity
    board): they file a payment, but each company is still its own shop, shown as its files spell it."""
    shown = categorize.shops(["TATA POWER", "Tata Power", "BESCOM", "INDANE GAS", "HP GAS"])
    assert shown == {"TATA POWER": "TATA POWER", "Tata Power": "TATA POWER", "BESCOM": "BESCOM", "INDANE GAS": "INDANE GAS", "HP GAS": "HP GAS"}
    assert categorize.same_shop("TATA POWER") != categorize.same_shop("BESCOM")  # re-filing one doesn't offer the other
    assert categorize.merchant_name("BESCOM") == "Electricity board"  # still filed the same way


def test_the_merchant_list_says_which_entries_are_kinds():
    assert sorted(categorize.kinds()) == sorted(KINDS)
