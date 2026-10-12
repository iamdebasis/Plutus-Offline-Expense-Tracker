"""One version for Plutus: backend/pyproject.toml's. The page's package.json carries the same, the server says it, and
the release notes describe it."""

import json
import re
import tomllib
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app

REPO = Path(__file__).resolve().parents[2]
VERSION = tomllib.loads((REPO / "backend" / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]


def test_the_page_carries_the_same_version():
    assert json.loads((REPO / "web" / "package.json").read_text(encoding="utf-8")).get("version") == VERSION


def test_the_server_says_its_version():
    with TestClient(app, base_url="http://127.0.0.1") as client:
        assert client.get("/api/openapi.json").json()["info"]["version"] == VERSION


def test_the_release_notes_describe_this_version():
    notes = (REPO / "docs" / "RELEASE-NOTES.md").read_text(encoding="utf-8")
    assert re.search(rf"^## {re.escape(VERSION)} ", notes, re.M), f"docs/RELEASE-NOTES.md has no section for {VERSION}"
