"""Your uploaded originals stay in data/uploads, inside the project's data folder with everything else about you."""

from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import storage, vault
from app.main import app
from app.models import Detection, UploadRecord
from tests.conftest import PHONEPE_TEXT, make_pdf


@pytest.fixture
def client():
    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def _upload(client, path):
    with path.open("rb") as f:
        return client.post("/api/uploads", files={"file": (path.name, f, "application/pdf")}, data={"kind": "auto"}).json()


def _record(upload_id: str, stored_path: str) -> UploadRecord:
    return UploadRecord(
        id=upload_id, original_name=f"{upload_id}.pdf", stored_path=stored_path, sha256=upload_id.ljust(64, "0"), size=4,
        declared_kind="auto", detection=Detection(kind="cred_history", label="CRED", confidence=1),
        uploaded_at=datetime.now(timezone.utc),
    )


def test_files_are_kept_in_the_data_folder(client, tmp_path, data_dir):
    info = client.get("/api/storage").json()
    assert info["folder"] == str(data_dir / "uploads")
    body = _upload(client, make_pdf(tmp_path / "pp.pdf", [PHONEPE_TEXT]))
    kept = data_dir / "uploads" / body["storedPath"]
    assert kept.exists() and client.get("/api/storage").json()["files"] == 1
    assert client.delete(f"/api/uploads/{body['id']}").status_code == 204
    assert not kept.exists()


def test_there_is_no_way_to_keep_them_elsewhere(client, tmp_path):
    assert client.put("/api/storage", json={"folder": str(tmp_path / "Elsewhere")}).status_code in (404, 405)
    assert client.post("/api/storage/choose").status_code in (404, 405)
    assert not (tmp_path / "Elsewhere").exists()


def test_files_an_older_install_kept_elsewhere_come_home(data_dir, tmp_path):
    """Before this rule, originals could live in a folder chosen anywhere; at startup they move into data/uploads."""
    elsewhere = tmp_path / "Statements"
    (elsewhere / "cred").mkdir(parents=True)
    (elsewhere / "cred" / "old.pdf").write_bytes(b"%PDF")
    vault.add_upload(_record("upl_far", "cred/old.pdf"))
    storage._prefs().write({"uploadsDir": str(elsewhere), "storageConfirmed": True, "countInvestments": False})

    assert storage.bring_files_home() == 1
    assert (data_dir / "uploads" / "cred" / "old.pdf").read_bytes() == b"%PDF"
    assert not (elsewhere / "cred").exists()
    assert storage._prefs().read() == {"countInvestments": False}  # your other settings stay
    assert storage.bring_files_home() == 0  # once


def test_a_data_folder_that_syncs_to_the_cloud_is_flagged(monkeypatch, tmp_path):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    assert "iCloud Drive" in storage.cloud_sync_warning(tmp_path / "Library/Mobile Documents/com~apple~CloudDocs/Plutus/data")
    assert "cloud drive" in storage.cloud_sync_warning(tmp_path / "Library/CloudStorage/GoogleDrive-me/Plutus/data")
    assert storage.cloud_sync_warning(tmp_path / "Developer/Plutus/data") is None
    (tmp_path / "Library/Mobile Documents/com~apple~CloudDocs/Desktop").mkdir(parents=True)
    assert "Desktop & Documents" in storage.cloud_sync_warning(tmp_path / "Documents/Plutus/data")


def test_old_paths_are_migrated(data_dir):
    stored = data_dir / "uploads" / "cred" / "abc-old.pdf"
    stored.parent.mkdir(parents=True)
    stored.write_bytes(b"%PDF")
    vault.add_upload(_record("upl_old", "uploads/cred/abc-old.pdf"))
    storage.migrate_legacy_paths()
    rec = vault.find_upload("upl_old")
    assert rec.stored_path == "cred/abc-old.pdf"
    assert storage.file_path(rec) == stored


def test_other_sites_cant_change_anything(client):
    evil = {"origin": "https://example.com"}
    assert client.post("/api/storage/reveal", headers=evil).status_code == 403
    assert client.post("/api/uploads", headers=evil, files={"file": ("x.pdf", b"%PDF")}).status_code == 403
    assert client.post("/api/recategorize", headers={"sec-fetch-site": "cross-site"}).status_code == 403
    assert client.get("/api/storage", headers=evil).status_code == 200  # reading is harmless: CORS keeps the answer from them
    ok = {"origin": "http://localhost:5173"}
    assert client.post("/api/recategorize", headers=ok).status_code == 200
