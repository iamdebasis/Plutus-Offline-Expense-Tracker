"""Where you were (data/places.json): stays you tell Plutus about, a place and its days. They never touch the ledger:
the page works out each payment's place from its day. Told in Ask Plutus and confirmed with a button, or added in
Places; changed or removed there; put back exactly by Undo; removed by Start over with everything else."""

import json
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import ledger, places, userdata
from app.main import app
from app.models import Transaction

IST = timezone(timedelta(hours=5, minutes=30))
GOA = {"place": "Goa", "start": "2026-01-01", "end": "2026-03-05"}


@pytest.fixture
def client():
    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def test_a_stay_is_kept_with_its_place_and_days(client):
    stay = client.post("/api/places", json=GOA).json()
    assert stay["place"] == "Goa" and (stay["start"], stay["end"]) == ("2026-01-01", "2026-03-05")
    assert stay["id"].startswith("stay-") and stay["addedAt"]
    assert client.get("/api/places").json() == [stay]
    stored = json.loads(userdata.path("places.json").read_text(encoding="utf-8"))
    assert stored["stays"] == [stay]


def test_a_place_is_tidied_and_a_bad_one_refused(client):
    assert client.post("/api/places", json={**GOA, "place": "  north   goa "}).json()["place"] == "north goa"
    for bad in ["", "   ", "x" * 41, "Goa<script>", "Goa\nKerala", "{Goa}"]:
        r = client.post("/api/places", json={**GOA, "place": bad})
        assert r.status_code == 400 and r.json()["detail"]["code"] == "bad_place", bad


def test_days_must_be_real_in_order_and_sane(client):
    for start, end in [("2026-03-05", "2026-01-01"), ("1999-12-31", "2000-01-02"), ("2026-01-01", "2101-01-01"),
                       ("2010-01-01", "2026-01-01")]:  # backwards, too early, too late, longer than ten years
        r = client.post("/api/places", json={**GOA, "start": start, "end": end})
        assert r.status_code == 400 and r.json()["detail"]["code"] == "bad_days", (start, end)
    assert client.post("/api/places", json={**GOA, "start": "2026-02-30"}).status_code == 422  # not a date at all


def test_a_stay_is_changed_and_removed(client):
    stay = client.post("/api/places", json=GOA).json()
    changed = client.put(f"/api/places/{stay['id']}", json={"place": "Goa", "start": "2026-01-02", "end": "2026-03-05"}).json()
    assert changed["id"] == stay["id"] and changed["start"] == "2026-01-02" and changed["addedAt"] >= stay["addedAt"]
    assert client.delete(f"/api/places/{stay['id']}").json() == changed
    assert client.get("/api/places").json() == []
    assert client.delete(f"/api/places/{stay['id']}").status_code == 404
    assert client.put(f"/api/places/{stay['id']}", json=GOA).status_code == 404


def test_undo_puts_a_removed_stay_back_exactly(client):
    stay = client.post("/api/places", json=GOA).json()
    client.delete(f"/api/places/{stay['id']}")
    assert client.post("/api/places", json={**GOA, "id": stay["id"], "addedAt": stay["addedAt"]}).json() == stay
    assert client.post("/api/places", json={**GOA, "id": stay["id"], "addedAt": stay["addedAt"]}).status_code == 409  # it's back already
    future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    assert client.post("/api/places", json={**GOA, "id": "stay-0123456789ab", "addedAt": future}).status_code == 400
    assert client.post("/api/places", json={**GOA, "id": "../../etc", "addedAt": stay["addedAt"]}).status_code == 400


def test_another_site_cant_add_or_remove_a_stay(client):
    r = client.post("/api/places", json=GOA, headers={"Origin": "http://evil.example"})
    assert r.status_code == 403 and client.get("/api/places").json() == []
    stay = client.post("/api/places", json=GOA).json()
    assert client.delete(f"/api/places/{stay['id']}", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert client.get("/api/places", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403


def test_there_is_a_limit_to_how_many(client, monkeypatch):
    monkeypatch.setattr(places, "MAX_STAYS", 2)
    for _ in range(2):
        assert client.post("/api/places", json=GOA).status_code == 200
    r = client.post("/api/places", json=GOA)
    assert r.status_code == 400 and r.json()["detail"]["code"] == "too_many"


def test_a_stay_never_touches_the_ledger(client):
    ledger.save_transactions([Transaction(id="t1", at=datetime(2026, 1, 3, 12, tzinfo=IST), amount=420.0, direction="debit",
                                          payee="Fake Beach Cafe", category="food.restaurants")])
    before = {f.name: f.read_bytes() for f in userdata.path("ledger").glob("*.json")}
    stay = client.post("/api/places", json=GOA).json()
    client.put(f"/api/places/{stay['id']}", json={**GOA, "place": "Kerala"})
    client.delete(f"/api/places/{stay['id']}")
    assert {f.name: f.read_bytes() for f in userdata.path("ledger").glob("*.json")} == before


def test_start_over_removes_your_places(client, fake_trash):
    client.post("/api/places", json=GOA)
    assert client.post("/api/reset", json={"confirm": "start over"}).status_code == 200
    assert not userdata.path("places.json").exists() and client.get("/api/places").json() == []
    assert any((box / "places.json").exists() for box in fake_trash.iterdir())


def test_the_list_is_read_whole_even_if_a_row_is_damaged():
    places._file().write({"version": 1, "stays": [{"id": "stay-0123456789ab", "place": "Goa", "start": "2026-01-01",
                                                   "end": "2026-01-05", "addedAt": "2026-01-06T10:00:00+05:30"},
                                                  {"id": "broken"}]})
    assert [s.place for s in places.list_stays()] == ["Goa"]
    assert date(2026, 1, 1) == places.list_stays()[0].start


def test_a_stay_keeps_its_state_as_a_number_plate_code(client):
    stay = client.post("/api/places", json={**GOA, "place": "Darjeeling", "region": "wb"}).json()
    assert (stay["place"], stay["region"]) == ("Darjeeling", "WB")
    assert client.post("/api/places", json=GOA).json()["region"] is None  # a state is optional
    # the official (ISO) codes and the old ones are taken as the plate codes people write
    for given, kept in [("CT", "CG"), ("UT", "UK"), ("TS", "TG"), ("OR", "OD"), ("DN", "DD"), ("DH", "DD")]:
        assert client.post("/api/places", json={**GOA, "region": given}).json()["region"] == kept, given
    for bad in ["XX", "W", "West Bengal", "WB1", ""]:
        r = client.post("/api/places", json={**GOA, "region": bad})
        assert r.status_code == 400 and r.json()["detail"]["code"] == "bad_region", bad


def test_a_state_is_added_changed_or_cleared_and_put_back_by_undo(client):
    stay = client.post("/api/places", json={**GOA, "place": "Aurangabad"}).json()
    with_state = client.put(f"/api/places/{stay['id']}", json={**GOA, "place": "Aurangabad", "region": "MH"}).json()
    assert with_state["region"] == "MH"
    assert client.put(f"/api/places/{stay['id']}", json={**GOA, "place": "Aurangabad", "region": None}).json()["region"] is None
    client.put(f"/api/places/{stay['id']}", json={**GOA, "place": "Aurangabad", "region": "BR"})
    gone = client.delete(f"/api/places/{stay['id']}").json()
    assert client.post("/api/places", json={**GOA, "place": "Aurangabad", "region": "BR", "id": gone["id"], "addedAt": gone["addedAt"]}).json() == gone


def test_the_states_are_indias_28_states_and_8_union_territories():
    assert len(places.STATES) == 36 and len(set(places.STATES.values())) == 36
    assert all(len(code) == 2 and code.isupper() for code in places.STATES)
    assert places.STATES["TG"] == "Telangana" and places.STATES["DD"] == "Dadra and Nagar Haveli and Daman and Diu"


def test_the_page_has_the_same_states_and_old_codes():
    """web/src/lib/places.ts reads and shows the states by the same table, and takes the same old codes."""
    page = (Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "places.ts").read_text(encoding="utf-8")
    block = lambda name: page[page.index(name):page.index("}\n", page.index(name))]  # noqa: E731
    assert dict(re.findall(r"\b([A-Z]{2}): '([^']+)'", block("export const STATES"))) == places.STATES
    assert dict(re.findall(r"\b([A-Z]{2}): '([A-Z]{2})'", block("const ALIASES"))) == places.ALIASES
