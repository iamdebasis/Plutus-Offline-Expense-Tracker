import json
import socket

import pytest
from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import CRED_TEXT, CC_STATEMENT_TEXT, PHONEPE_TEXT, make_pdf


@pytest.fixture
def client():
    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def _post(client, path, kind="auto", password=None, name=None):
    data = {"kind": kind}
    if password:
        data["password"] = password
    with path.open("rb") as f:
        return client.post("/api/uploads", files={"file": (name or path.name, f, "application/pdf")}, data=data)


def test_upload_stores_file_and_registers_cards(client, tmp_path, data_dir):
    resp = _post(client, make_pdf(tmp_path / "cred.pdf", [CRED_TEXT]))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["detection"]["kind"] == "cred_history"
    assert body["duplicate"] is False
    assert (data_dir / "uploads" / body["storedPath"]).exists()
    assert body["storedPath"].startswith("cred/")

    cards = client.get("/api/instruments").json()
    assert {c["last4"] for c in cards} == {"3141", "8642", "1357", "2468"}

    # a statement for a card we already know from CRED merges into the same instrument
    _post(client, make_pdf(tmp_path / "card.pdf", [CC_STATEMENT_TEXT]))
    cards = {c["id"]: c for c in client.get("/api/instruments").json()}
    assert len(cards) == 4
    assert len(cards["card-hsbc-2468"]["sources"]) == 2
    assert cards["card-hsbc-2468"]["network"] == "Visa"


def test_same_file_twice_is_a_duplicate(client, tmp_path):
    pdf = make_pdf(tmp_path / "pp.pdf", [PHONEPE_TEXT])
    first = _post(client, pdf).json()
    second = _post(client, pdf, name="renamed.pdf").json()
    assert second["duplicate"] is True
    assert second["id"] == first["id"]
    assert len(client.get("/api/uploads").json()) == 1


def test_password_protected_pdf(client, tmp_path, data_dir):
    pdf = make_pdf(tmp_path / "locked.pdf", [CC_STATEMENT_TEXT], password="ABCD1234")
    assert _post(client, pdf).json()["detail"]["code"] == "password_required"
    assert _post(client, pdf, password="nope").json()["detail"]["code"] == "wrong_password"

    ok = _post(client, pdf, password="ABCD1234").json()
    assert ok["unlocked"] is True
    assert ok["detection"]["kind"] == "cc_statement"  # readable once decrypted
    import pymupdf
    with pymupdf.open(data_dir / "uploads" / ok["storedPath"]) as doc:
        assert not doc.needs_pass
    assert "ABCD1234" not in (data_dir / "uploads.json").read_text()


def test_delete_upload_forgets_its_cards(client, tmp_path, data_dir):
    body = _post(client, make_pdf(tmp_path / "card.pdf", [CC_STATEMENT_TEXT])).json()
    assert client.delete(f"/api/uploads/{body['id']}").status_code == 204
    assert not (data_dir / "uploads" / body["storedPath"]).exists()
    assert client.get("/api/instruments").json() == []


def test_rejects_unsupported_type(client, tmp_path):
    (tmp_path / "notes.txt").write_text("hello")
    with (tmp_path / "notes.txt").open("rb") as f:
        resp = client.post("/api/uploads", files={"file": ("notes.txt", f, "text/plain")})
    assert resp.status_code == 415


def test_rejects_foreign_host_header(tmp_path):
    with TestClient(app, base_url="http://evil.example") as c:
        assert c.get("/api/status").status_code == 400


def test_payees_roundtrip(client):
    payee = {"id": "p1", "name": "Mr Test Person", "aliases": [], "label": "Milk", "category": "groceries", "notes": ""}
    assert client.put("/api/payees/p1", json=payee).status_code == 200
    assert client.get("/api/payees").json()[0]["label"] == "Milk"
    assert client.delete("/api/payees/p1").status_code == 204


def test_egress_guard_blocks_the_internet():
    s = socket.socket()
    with pytest.raises(RuntimeError, match="Blocked outbound"):
        s.connect(("93.184.216.34", 80))
    s.close()


def test_set_card_network(client, tmp_path):
    _post(client, make_pdf(tmp_path / "cred.pdf", [CRED_TEXT]))
    resp = client.put("/api/instruments/card-rbl-bank-1357", json={"network": "Visa"})
    assert resp.json()["network"] == "Visa"
    assert client.put("/api/instruments/card-rbl-bank-1357", json={"network": "Bogus"}).status_code == 400
    assert client.put("/api/instruments/card-nope-0000", json={"network": "Visa"}).status_code == 404
    assert client.put("/api/instruments/card-rbl-bank-1357", json={"network": None}).json()["network"] is None


def test_card_network_you_set_survives_the_card(client, tmp_path, data_dir):
    body = _post(client, make_pdf(tmp_path / "cred.pdf", [CRED_TEXT])).json()
    assert client.put("/api/instruments/card-yes-bank-3141", json={"network": "Mastercard"}).status_code == 200
    # delete everything that knew the card, then bring it back
    client.delete(f"/api/uploads/{body['id']}")
    assert client.get("/api/instruments").json() == []
    _post(client, make_pdf(tmp_path / "cred-again.pdf", [CRED_TEXT + "\n"]))
    cards = {c["id"]: c for c in client.get("/api/instruments").json()}
    assert cards["card-yes-bank-3141"]["network"] == "Mastercard"
    # "don't know" forgets it
    client.put("/api/instruments/card-yes-bank-3141", json={"network": None})
    assert "card-yes-bank-3141" not in json.loads((data_dir / "card_networks.json").read_text())


def test_card_pictures_come_from_your_data_folder_and_only_to_this_app(client, data_dir):
    assert client.get("/api/card-art").json() == []
    art = data_dir / "card-art"
    art.mkdir()
    (art / "fake-bank--rewards.jpg").write_bytes(b"\xff\xd8\xff a fake picture")
    (art / "notes.txt").write_text("not a picture")
    (art / ".hidden.jpg").write_bytes(b"\xff\xd8\xff")
    assert client.get("/api/card-art").json() == ["fake-bank--rewards.jpg"]
    assert client.get("/api/card-art/fake-bank--rewards.jpg").content == b"\xff\xd8\xff a fake picture"
    for name in ("notes.txt", ".hidden.jpg", "missing.jpg", "..%2Fsettings.json", "%2E%2E%2Fsettings.json"):
        assert client.get(f"/api/card-art/{name}").status_code == 404, name

    # another site can't load anything from here, not even as an image to learn which cards you have
    for path in ("/api/card-art/fake-bank--rewards.jpg", "/api/card-art", "/api/transactions"):
        assert client.get(path, headers={"sec-fetch-site": "cross-site"}).status_code == 403, path
    assert client.get("/api/card-art", headers={"sec-fetch-site": "same-origin"}).status_code == 200

