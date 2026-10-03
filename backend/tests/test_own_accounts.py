"""Your own bank accounts and your settings live in the data folder, and only there (fake data only)."""

import json
import re
from datetime import datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import accounts, ledger, userdata
from app.main import app
from app.models import SourceRef, Transaction
from app.parsers import IST

AT = datetime(2025, 5, 1, 19, 30, tzinfo=IST)


@pytest.fixture
def client():
    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def _t(id, payee, amount, direction="debit", handle=None, kind="spend", day=1):
    return Transaction(id=id, at=AT.replace(day=day), amount=amount, direction=direction, kind=kind, payee=payee,
                       payee_handle=handle, sources=[SourceRef(upload="u")], paid_from="XX1111")


def _ledger(*txns):
    ledger.upsert_transactions(list(txns))


def _by_id(client):
    return {t["id"]: t for t in client.get("/api/transactions").json()}


def test_ignoring_a_bank_account_payee_makes_it_one_of_your_accounts(client, data_dir):
    _ledger(
        _t("out", "Bank Account XXXXXX5678", 20000),
        _t("in", "XXXXXXXX5678", 5000, direction="credit", kind="income", day=2),  # money back from it, named differently
        _t("landlord", "Bank Account XXXXXXXXXX3456", 18000, day=3),  # someone else's account
    )
    res = client.post("/api/categorize", json={"payee": "Bank Account XXXXXX5678", "category": "ignored", "label": "Rent account"}).json()
    assert (res["savedAs"], res["account"]) == ("account", "5678")

    saved = json.loads((data_dir / "accounts.json").read_text())["accounts"]
    assert [(a["last4"], a["label"], a["seenAs"]) for a in saved] == [("5678", "Rent account", "Bank Account XXXXXX5678")]
    got = _by_id(client)
    assert got["out"]["category"] == got["in"]["category"] == "ignored"  # both directions, under any name
    assert got["landlord"]["category"] != "ignored"


def test_only_the_last_four_digits_are_kept(client, data_dir):
    _ledger(_t("x", "500000005678@ABCD0001234.ifsc.npci", 1000))
    client.post("/api/categorize", json={"payee": "500000005678@ABCD0001234.ifsc.npci", "category": "ignored"})
    text = (data_dir / "accounts.json").read_text()
    saved = json.loads(text)["accounts"][0]
    assert (saved["last4"], saved["seenAs"]) == ("5678", "XXXXXXXX5678@ABCD0001234.ifsc.npci")
    assert "500000005678" not in text  # never the account number, not even in the name it was seen as


def test_ignoring_one_transfer_asks_whether_the_account_is_yours(client, data_dir):
    _ledger(
        _t("sip", "Ms Fake Person", 5000, handle="500000004321@ABCD0001234.ifsc.npci"),
        _t("back", "Ms Fake Person", 700, direction="credit", kind="income", handle="500000004321@ABCD0001234.ifsc.npci", day=2),
    )
    res = client.post("/api/categorize", json={"transactionId": "sip", "category": "ignored"}).json()
    assert res["account"] == {"last4": "4321", "payee": "Ms Fake Person"}
    assert not (data_dir / "accounts.json").exists()  # nothing is saved until you say it's yours

    claimed = client.post("/api/accounts", json={"transactionId": "sip"}).json()
    assert claimed["account"]["last4"] == "4321"
    assert _by_id(client)["back"]["category"] == "ignored"

    # once it's yours, ignoring another transfer doesn't ask again
    assert client.post("/api/categorize", json={"transactionId": "back", "category": "ignored"}).json()["account"] is None


def test_not_mine_brings_the_transfers_back(client, data_dir):
    _ledger(_t("out", "Bank Account XXXXXX5678", 20000))
    client.post("/api/categorize", json={"payee": "Bank Account XXXXXX5678", "category": "ignored"})
    assert client.get("/api/accounts").json()[0]["last4"] == "5678"

    assert client.delete("/api/accounts/5678").status_code == 200
    assert client.get("/api/accounts").json() == []
    out = _by_id(client)["out"]
    assert out["category"] != "ignored" and out["needsReview"]
    assert client.delete("/api/accounts/5678").status_code == 404


def test_giving_an_account_a_category_unmarks_it(client, data_dir):
    _ledger(_t("out", "Bank Account XXXXXX5678", 20000))
    client.post("/api/categorize", json={"payee": "Bank Account XXXXXX5678", "category": "ignored"})
    client.post("/api/categorize", json={"payee": "Bank Account XXXXXX5678", "category": "home.rent", "label": "Rent"})
    assert client.get("/api/accounts").json() == []
    assert _by_id(client)["out"]["category"] == "home.rent"


def test_names_that_arent_accounts():
    assert accounts.last4("Bank Account XXXXXX5678") == "5678"
    assert accounts.last4("Mr Fake Person", "500000004321@ABCD0001234.ifsc.npci") == "4321"
    assert accounts.last4("SWIGGY", "swiggy@icici") is None
    assert accounts.last4("FAKE STORE 1234") is None  # a store code isn't an account


def test_settings_live_in_the_data_folder(client, data_dir):
    assert client.get("/api/preferences").json() == {"countInvestments": False}  # the category tree's default
    assert client.put("/api/preferences", json={"countInvestments": True}).json() == {"countInvestments": True}
    assert json.loads((data_dir / "settings.json").read_text())["countInvestments"] is True
    assert client.get("/api/preferences").json() == {"countInvestments": True}


def test_every_file_about_you_is_listed_in_one_place():
    """The data folder is reached only through app/userdata.py, so its list of files is complete."""
    app_dir = Path(__file__).parent.parent / "app"
    for source in app_dir.rglob("*.py"):
        if source.name in ("userdata.py", "config.py"):
            continue
        assert "data_dir" not in source.read_text(), f"{source.relative_to(app_dir)} reaches the data folder directly"
    with pytest.raises(ValueError, match="list it in app/userdata.py"):
        userdata.path("somewhere-new.json")


def test_every_part_of_the_data_folder_the_code_uses_is_listed():
    """userdata.path() refuses a name it doesn't list, so a name the code uses but the list lacks only fails when that
    code runs (`make redact` once did): every name in the code must be on the list."""
    app_dir = Path(__file__).parent.parent / "app"
    used = set()
    for source in app_dir.rglob("*.py"):
        used |= set(re.findall(r"userdata\.(?:path|json_file)\(\s*\"([^\"]+)\"", source.read_text()))
    assert {"uploads", "run", "redacted", "card-art"} <= used
    assert used <= set(userdata.FILES) | set(userdata.FOLDERS), used - set(userdata.FILES) - set(userdata.FOLDERS)


def test_no_one_s_details_in_the_code():
    """Card and account digits, UPI addresses and names belong in data/; the code only knows public things.
    Fake values in examples follow obvious patterns, so anything else that looks real fails here."""
    root = Path(__file__).parent.parent.parent
    sources = [*root.joinpath("backend/app").rglob("*.py"), *root.joinpath("backend/app/seed").glob("*.json"),
               *root.joinpath("web/src").rglob("*.ts"), *root.joinpath("web/src").rglob("*.tsx")]
    address = re.compile(r"\b(\d{6,})@[A-Za-z]{4}0[A-Za-z0-9]{6}\b")  # a UPI address of a bank account
    fake = re.compile(r"5000000\d+|123456\d*|(\d)\1+")  # how examples here spell an account number
    for source in sources:
        for number in address.findall(source.read_text()):
            assert fake.fullmatch(number), f"{source.name}: {number} looks like a real account number"
