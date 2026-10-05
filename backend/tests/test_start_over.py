"""Start over: everything Plutus keeps about you goes to the Trash as one folder (in tests, a folder of the test's own),
nothing else in the data folder moves, and Plutus carries on as a fresh clone. Never while something is being read;
never in a folder that isn't Plutus's own; and if the Trash refuses, everything stays where it was. Fake data only."""

import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import reset, userdata, vault
from app.imports import _set_status
from app.llm import llm
from app.main import app
from app.models import ImportStatus
from tests import fake_cards

CONFIRM = {"confirm": "start over"}


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


def _yours(client, tmp_path, data_dir):
    """A data folder with something of everything: a statement read, an answer, a setting, a card picture; and two
    things that aren't Plutus's (a note of yours, a folder of yours) that must stay."""
    _add(client, fake_cards.axis(tmp_path / "axis.pdf"))
    grocer = next(t for t in client.get("/api/transactions").json() if t["payee"] == "FAKE GROCER")
    assert client.post("/api/categorize", json={"transactionId": grocer["id"], "category": "groceries.local"}).status_code == 200
    assert client.put("/api/preferences", json={"countInvestments": True}).status_code == 200
    (data_dir / "card-art").mkdir(exist_ok=True)
    (data_dir / "card-art" / "fake-bank.png").write_bytes(b"\x89PNG fake")
    (data_dir / ".uploads.json.abc123.tmp").write_text("{}")  # a crash's half-written copy: Plutus's too
    (data_dir / "my notes.txt").write_text("not Plutus's")
    (data_dir / "my folder").mkdir()


def test_everything_plutus_keeps_goes_to_the_trash_and_nothing_else(client, tmp_path, data_dir, fake_trash):
    _yours(client, tmp_path, data_dir)
    before = sorted(p.name for p in data_dir.iterdir())
    plutus = sorted(n for n in before if n not in ("my notes.txt", "my folder"))
    assert {"uploads.json", "ledger", "uploads", "settings.json", "card-art", "row_answers.json"} <= set(plutus)

    preview = client.get("/api/reset").json()
    assert preview["anything"] and preview["busy"] is None
    assert (preview["files"], preview["cards"], preview["statements"], preview["cardPictures"]) == (1, 1, 1, 1)
    assert preview["transactions"] == len(client.get("/api/transactions").json()) > 0
    assert preview["answers"] >= 1

    assert client.post("/api/reset", json={"confirm": "start ovr"}).status_code == 400  # not typed right: nothing moves
    assert sorted(p.name for p in data_dir.iterdir()) == before

    res = client.post("/api/reset", json=CONFIRM)
    assert res.status_code == 200, res.text
    [box] = list(fake_trash.iterdir())
    assert box.name.startswith("Plutus data (removed ") and res.json() == {"moved": len(plutus), "trash": str(box)}
    assert sorted(p.name for p in box.iterdir()) == plutus
    assert sorted(p.name for p in data_dir.iterdir()) == ["my folder", "my notes.txt"]  # yours, untouched

    assert client.get("/api/transactions").json() == [] and client.get("/api/uploads").json() == []
    assert client.get("/api/reset").json()["anything"] is False
    assert client.get("/api/preferences").json()["countInvestments"] is False  # the default again


def test_plutus_carries_on_as_new(client, tmp_path):
    _add(client, fake_cards.axis(tmp_path / "axis.pdf"))
    grocer = next(t for t in client.get("/api/transactions").json() if t["payee"] == "FAKE GROCER")
    client.post("/api/categorize", json={"transactionId": grocer["id"], "category": "groceries.local"})
    assert client.post("/api/reset", json=CONFIRM).status_code == 200

    _add(client, fake_cards.axis(tmp_path / "again.pdf"))  # the same file, added again: read, not "added before"
    again = next(t for t in client.get("/api/transactions").json() if t["payee"] == "FAKE GROCER")
    assert again["category"] != "groceries.local"  # your old answer went with the rest


def test_not_while_a_file_is_being_read(client, tmp_path, data_dir, fake_trash):
    upload_id = _add(client, fake_cards.axis(tmp_path / "axis.pdf"))
    _set_status(upload_id, ImportStatus(state="running", step="Reading the file"))
    assert "still being read" in client.get("/api/reset").json()["busy"]
    res = client.post("/api/reset", json=CONFIRM)
    assert res.status_code == 409 and "still being read" in res.json()["detail"]["message"]
    assert not fake_trash.exists() and vault.find_upload(upload_id) is not None


def test_if_the_trash_refuses_everything_stays_where_it_was(client, tmp_path, data_dir, monkeypatch):
    _yours(client, tmp_path, data_dir)
    before = sorted(p.name for p in data_dir.iterdir())
    ledger_before = sorted(p.name for p in (data_dir / "ledger").iterdir())

    def refuses(folder: Path) -> Path:
        raise OSError("the volume has no Trash")

    monkeypatch.setattr(reset, "to_trash", refuses)
    res = client.post("/api/reset", json=CONFIRM)
    assert res.status_code == 500 and "Nothing was removed" in res.json()["detail"]["message"]
    assert sorted(p.name for p in data_dir.iterdir()) == before  # no "Plutus data (removed …)" left behind either
    assert sorted(p.name for p in (data_dir / "ledger").iterdir()) == ledger_before
    assert client.get("/api/transactions").json()


def test_files_are_turned_away_while_it_runs(client, tmp_path, monkeypatch):
    monkeypatch.setattr(reset, "in_progress", True)
    path = fake_cards.axis(tmp_path / "axis.pdf")
    with path.open("rb") as f:
        res = client.post("/api/uploads", files={"file": (path.name, f, "application/pdf")}, data={"kind": "auto"})
    assert res.status_code == 409 and "starting over" in res.json()["detail"]["message"]


def test_a_folder_that_isnt_plutus_own_is_refused(client, tmp_path, monkeypatch, fake_trash):
    """ET_DATA_DIR pointed at your home folder, or at the project or a folder above it: nothing moves, even if it has
    a "ledger" or "uploads" of its own."""
    home = tmp_path / "home"
    project = home / "Developer" / "plutus"
    project.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    monkeypatch.setattr(reset, "ROOT", project)
    for folder in (home, project, home / "Developer"):
        (folder / "uploads").mkdir(exist_ok=True)
        monkeypatch.setattr(userdata.settings, "data_dir", folder)
        res = client.post("/api/reset", json=CONFIRM)
        assert res.status_code == 409 and "isn't a folder of Plutus's own" in res.json()["detail"]["message"]
        assert (folder / "uploads").is_dir()
    assert not fake_trash.exists()


def test_an_ollama_plutus_started_is_stopped_first(client, monkeypatch):
    stopped = []

    async def shutdown():
        stopped.append(True)

    monkeypatch.setattr(llm, "shutdown", shutdown)
    assert client.post("/api/reset", json=CONFIRM).status_code == 200
    assert stopped == [True]


def test_the_data_file_list_is_what_moves():
    """Every file Plutus keeps is listed in app/userdata.py, so starting over can't miss a new kind of file."""
    root = userdata.root()
    for name in [*userdata.FILES, *userdata.FOLDERS]:
        target = root / name
        if name in userdata.FOLDERS:
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.write_text(json.dumps({}))
    assert sorted(p.name for p in reset._entries(root)) == sorted([*userdata.FILES, *userdata.FOLDERS])
