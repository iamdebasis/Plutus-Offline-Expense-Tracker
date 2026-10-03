"""Google Pay Takeout exports (fake data, laid out like the real thing: see tests/fake_takeout.py)."""

import io
import json
import time
import zipfile
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app import categorize, ledger, vault
from app.main import app
from app.parsers import IST, ParseError, gpay_takeout
from tests import fake_takeout


@pytest.fixture
def client():
    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def _by_payee(result):
    return {t.payee: t for t in result.transactions}


@pytest.mark.parametrize("fmt", ["html", "json"])
def test_reads_every_completed_payment_and_reports_the_rest(tmp_path, fmt):
    result = gpay_takeout.parse(fake_takeout.make_takeout(tmp_path / "t.zip", fmt), "upl_x")
    got = _by_payee(result)
    assert len(result.transactions) == 11
    # failed, pending, requests and non-payments never become transactions
    assert not {"FAKE GADGETS", "Ms Fake Sister"} & set(got)
    assert result.notes[0] == "My Activity: 13 entries · 9 payments · 1 failed · 1 pending · 1 not a payment · 1 request"
    assert "Not read: passes.json" in result.notes
    assert "2 file(s) from other Google products ignored" in result.notes
    assert any(n.startswith("Group expenses: 2 split-bill notes") for n in result.notes)


def test_dates_in_every_style_land_in_ist(tmp_path):
    got = _by_payee(gpay_takeout.parse(fake_takeout.make_takeout(tmp_path / "t.zip"), "upl_x"))
    assert got["SWIGGY"].at == datetime(2025, 9, 4, 14, 30, 45, tzinfo=IST)  # "Sep 4, 2025, 2:30:45 PM IST"
    assert got["FAKE TEA STALL"].at == datetime(2025, 9, 4, 18, 5, 10, tzinfo=IST)  # "4 Sept 2025, 18:05:10 GMT+05:30"
    assert got["FAKE ELECTRICITY"].at == datetime(2025, 1, 5, 9, 7, 3, tzinfo=IST)  # narrow no-break space before AM


@pytest.mark.parametrize("raw, expected", [
    ("Sep 4, 2025, 2:30:45 PM IST", datetime(2025, 9, 4, 14, 30, 45, tzinfo=IST)),
    ("4 Sept 2025, 14:30:45 GMT+05:30", datetime(2025, 9, 4, 14, 30, 45, tzinfo=IST)),
    ("2025-09-04T09:00:45.123Z", datetime(2025, 9, 4, 14, 30, 45, 123000, tzinfo=IST)),
    ("Sep 4, 2025, 9:00:45 AM UTC", datetime(2025, 9, 4, 14, 30, 45, tzinfo=IST)),
    ("Sep 4, 2025, 2:30 PM", datetime(2025, 9, 4, 14, 30, tzinfo=IST)),
    ("Sep 4, 2025", datetime(2025, 9, 4, tzinfo=IST)),
    ("1757000000", datetime(2025, 9, 4, 21, 3, 20, tzinfo=IST)),  # seconds since 1970
    ("1757000000000", datetime(2025, 9, 4, 21, 3, 20, tzinfo=IST)),  # milliseconds
    ("Paid ₹250.00 to SWIGGY", None),
])
def test_timestamp_styles(raw, expected):
    assert gpay_takeout._when(raw) == expected


def test_what_each_payment_is(tmp_path):
    got = _by_payee(gpay_takeout.parse(fake_takeout.make_takeout(tmp_path / "t.zip"), "upl_x"))
    assert (got["SWIGGY"].amount, got["SWIGGY"].direction, got["SWIGGY"].paid_from, got["SWIGGY"].app) == (250.0, "debit", "XX1111", "gpay")
    assert (got["FAKE ELECTRICITY"].amount) == 1234.5  # "₹1,234.50"
    assert (got["Mr Fake Friend"].direction, got["Mr Fake Friend"].kind) == ("credit", "income")
    assert (got["UPI Lite"].kind, got["UPI Lite"].amount) == ("transfer", 1000.0)  # topping up your own wallet
    assert got["FAKE CHAI POINT"].paid_from == "UPI Lite"
    assert got["Ms Fake Neighbour"].paid_from == "XXXX99"  # a RuPay credit card on UPI, as PhonePe writes it
    assert (got["YouTube Premium"].channel, got["YouTube Premium"].paid_from) == ("card", "XXXX42")


def test_one_payment_seen_in_several_files_is_one_transaction(tmp_path):
    result = gpay_takeout.parse(fake_takeout.make_takeout(tmp_path / "t.zip"), "upl_x")
    got = _by_payee(result)
    # My Activity + Money sends: the send's ID and memo join the activity entry
    assert (got["Mr Fake Friend"].refs, got["Mr Fake Friend"].note) == ({"txnId": "FAKETXN0001"}, "dinner share")
    # My Activity + Google transactions
    assert got["Google Play"].refs == {"txnId": "GPA.0000-1111-2222-33333"}
    # My Activity's "Received ₹15.00 from Google Pay" + Rewards earned: one cashback
    assert (got["Google Pay rewards"].kind, got["Google Pay rewards"].amount) == ("cashback", 15.0)
    assert sum(t.amount == 15.0 for t in result.transactions) == 1
    # what only the other folders had is added
    assert {"Mr Fake Cousin", "YouTube Premium"} <= set(got)
    assert "Google One" not in got  # refunded


def test_reading_the_same_export_twice_adds_nothing(tmp_path):
    path = fake_takeout.make_takeout(tmp_path / "t.zip")
    stats, _ = ledger.upsert_transactions(gpay_takeout.parse(path, "upl_x").transactions)
    assert stats.added == 11
    stats, _ = ledger.upsert_transactions(gpay_takeout.parse(path, "upl_x").transactions)
    assert (stats.added, stats.duplicates) == (0, 11)


def test_categories_upi_lite_top_up_is_ignored_and_cashback_is_money_in(tmp_path):
    txns = gpay_takeout.parse(fake_takeout.make_takeout(tmp_path / "t.zip"), "upl_x").transactions
    ctx = categorize.build_context(txns)
    categorize.categorize_offline(txns, ctx)
    got = {t.payee: t for t in txns}
    assert got["UPI Lite"].category == "ignored"
    assert got["Google Pay rewards"].category == "income.cashback"
    assert got["SWIGGY"].category == "food.delivery"


def test_an_export_without_google_pay_says_so(tmp_path):
    path = tmp_path / "other.zip"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("Takeout/Chrome/History.json", "{}")
    with pytest.raises(ParseError, match="no Google Pay data"):
        gpay_takeout.parse(path, "upl_x")


def test_whole_account_export_reads_only_google_pay_activity(tmp_path):
    """In a whole-account Takeout, My Activity has a folder per product."""
    other = fake_takeout.activity_html([("Searched for fake things", "Sep 4, 2025, 2:30:45 PM IST", None)]).replace("Google Pay<br></p>", "Search<br></p>")
    path = tmp_path / "all.zip"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("Takeout/My Activity/Google Pay/My Activity.html", fake_takeout.activity_html())
        zf.writestr("Takeout/My Activity/Search/My Activity.html", other)
    result = gpay_takeout.parse(path, "upl_x")
    assert len(result.transactions) == 9
    assert result.notes[0].startswith("My Activity: 13 entries")


# ---- through the app ------------------------------------------------------------------------------------------


def _wait(client, upload_id, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        rec = next(u for u in client.get("/api/uploads").json() if u["id"] == upload_id)
        status = rec.get("importStatus") or {}
        if status.get("state") in ("done", "failed", "skipped"):
            return status
        time.sleep(0.1)
    raise AssertionError("import didn't finish")


def test_upload_the_zip(client, tmp_path):
    path = fake_takeout.make_takeout(tmp_path / "takeout-20250929.zip")
    with path.open("rb") as f:
        body = client.post("/api/uploads", files={"file": (path.name, f, "application/zip")}, data={"kind": "auto"}).json()
    assert body["detection"]["kind"] == "gpay_takeout"
    status = _wait(client, body["id"])
    assert status["state"] == "done", status
    assert (status["found"], status["added"]) == (11, 11)
    assert status["details"][0].startswith("My Activity: 13 entries")
    assert {t["app"] for t in client.get("/api/transactions").json()} == {"gpay"}


def test_upload_the_extracted_folder(client, tmp_path):
    """The folder picker sends each file under its path inside the folder; the app packs them into one zip,
    the same bytes every time, so choosing the same folder again is caught as a repeat."""
    def send():
        files = [("files", (name, io.BytesIO(text.encode()), "application/octet-stream")) for name, text in fake_takeout.files().items()]
        files.append(("files", ("Takeout/Google Pay/photo.jpg", io.BytesIO(b"\xff\xd8"), "image/jpeg")))  # not an export file: left out
        return client.post("/api/uploads/folder", files=files, data={"name": "Takeout"}).json()

    first = send()
    assert first["originalName"] == "Takeout.zip" and first["detection"]["kind"] == "gpay_takeout"
    assert _wait(client, first["id"])["added"] == 11
    again = send()
    assert again["duplicate"] is True and again["id"] == first["id"]


def test_folder_without_export_files_is_refused(client):
    resp = client.post("/api/uploads/folder", files=[("files", ("notes/readme.txt", io.BytesIO(b"hi"), "text/plain"))], data={"name": "x"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "empty_folder"


def test_folder_paths_cannot_climb_out():
    from app.routes.uploads import _safe_rel

    assert _safe_rel("Takeout/Google Pay/a.csv") == "Takeout/Google Pay/a.csv"
    assert _safe_rel("/Takeout\\\\Google Pay\\\\a.csv") == "Takeout/Google Pay/a.csv"
    assert _safe_rel("../../etc/passwd") == ""


def test_a_skipped_export_is_read_once_a_reader_exists(data_dir, tmp_path):
    """Your zip, uploaded before this reader, was skipped; the next start reads it."""
    from datetime import timezone

    from app import storage
    from app.models import Detection, ImportStatus, UploadRecord

    stored = storage.uploads_dir() / "upi" / "abc-takeout.zip"
    stored.parent.mkdir(parents=True, exist_ok=True)
    fake_takeout.make_takeout(stored)
    vault.add_upload(UploadRecord(
        id="upl_old", original_name="takeout.zip", stored_path="upi/abc-takeout.zip", sha256="1" * 64, size=stored.stat().st_size,
        declared_kind="auto", detection=Detection(kind="gpay_takeout", label="Google Pay history (Takeout)", source="gpay", confidence=0.9),
        uploaded_at=datetime.now(timezone.utc), detector_version=2, import_version=0,
        import_status=ImportStatus(state="skipped", error="The Google Pay Takeout reader will be built from your first export."),
    ))
    with TestClient(app, base_url="http://127.0.0.1") as c:
        status = _wait(c, "upl_old")
    assert status["state"] == "done" and status["added"] == 11


def test_other_wordings_of_a_payment_are_read(tmp_path):
    entries = [("You paid ₹75.00 to FAKE JUICE BAR using Bank Account XXXXXX1111", "Sep 4, 2025, 2:30:45 PM IST", "Completed"),
               ("Payment received: ₹60.00 from Mr Fake Friend", "Sep 4, 2025, 3:30:45 PM IST", "Completed")]
    path = tmp_path / "t.zip"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("Takeout/Google Pay/My Activity/My Activity.html", fake_takeout.activity_html(entries))
    got = _by_payee(gpay_takeout.parse(path, "upl_x"))
    assert (got["FAKE JUICE BAR"].amount, got["FAKE JUICE BAR"].direction) == (75.0, "debit")
    assert (got["Mr Fake Friend"].amount, got["Mr Fake Friend"].direction) == (60.0, "credit")


REWARDS_CSV = "Takeout/Google Pay/Rewards earned/Rewards earned.csv"
REWARDS_JSON = "Takeout/Google Pay/Rewards earned/Rewards earned.json"
_rewards_rows = json.dumps(fake_takeout.REWARDS, ensure_ascii=False)


def _with(tmp_path, replace: dict[str, str | None]):
    """The fake export with some files swapped (None removes one)."""
    files = {**fake_takeout.files(), **replace}
    path = tmp_path / "t.zip"
    with zipfile.ZipFile(path, "w") as zf:
        for name, text in files.items():
            if text is not None:
                zf.writestr(name, text)
    return path


@pytest.mark.parametrize("text", [
    _rewards_rows,
    ")]}'\n" + _rewards_rows,  # Google's guard against JSON hijacking
    "\n".join(json.dumps(r, ensure_ascii=False) for r in fake_takeout.REWARDS),  # one object per line
    json.dumps({"rewards": {"items": [  # nested, camelCase, money as an object, times as ISO
        {"rewardedOn": "2025-09-08T04:30:00Z", "description": "Cashback for paying a bill", "amount": {"currencyCode": "INR", "units": "15"}},
        {"rewardedOn": "2025-09-09T04:30:00Z", "description": "Scratch card: 10% off at a partner store"},
    ]}}),
    fake_takeout._csv(fake_takeout.REWARDS),  # a CSV that calls itself .json
], ids=["list", "guarded", "lines", "nested", "csv"])
def test_rewards_json_in_any_shape_google_writes(tmp_path, text):
    result = gpay_takeout.parse(_with(tmp_path, {REWARDS_CSV: None, REWARDS_JSON: text}), "upl_x")
    assert "Rewards earned: 2 entries · 1 already in My Activity · 1 without a cash amount (vouchers, offers)" in result.notes
    assert result.warnings == []


def test_an_empty_file_is_just_empty(tmp_path):
    result = gpay_takeout.parse(_with(tmp_path, {REWARDS_CSV: None, REWARDS_JSON: ""}), "upl_x")
    assert "Rewards earned: 0 entries" in result.notes and result.warnings == []
    assert len(result.transactions) == 11


def test_a_file_that_cant_be_read_is_reported_and_the_rest_is_still_read(tmp_path):
    result = gpay_takeout.parse(_with(tmp_path, {REWARDS_CSV: None, REWARDS_JSON: "<html><body>Sorry</body></html>"}), "upl_x")
    assert len(result.transactions) == 11  # the ₹15 cashback is still there, from My Activity
    assert result.warnings == ["Rewards earned: couldn't read Rewards earned.json (an HTML page, not JSON). The rest of the export was read."]
    assert not any(n.startswith("Rewards earned") for n in result.notes)


def test_a_reader_that_trips_up_midway_counts_nothing_from_that_file(tmp_path, monkeypatch):
    def trips(raw, name, report):
        report.read += 5
        raise KeyError("some field")

    monkeypatch.setitem(gpay_takeout._READERS, "sends", trips)
    result = gpay_takeout.parse(fake_takeout.make_takeout(tmp_path / "t.zip"), "upl_x")
    assert result.warnings == ["Money sends and requests: couldn't read Money sends and requests.csv (unexpected layout: KeyError). The rest of the export was read."]
    assert result.notes[0].startswith("My Activity: 13 entries")


def test_the_inspector_describes_a_file_it_cant_read_without_quoting_it(tmp_path, capsys):
    from app.tools import inspect_takeout

    inspect_takeout.main(_with(tmp_path, {REWARDS_CSV: None, REWARDS_JSON: "<html><body>Secret Shop 4242</body></html>"}))
    out = capsys.readouterr().out
    assert "Rewards earned.json: the reader can't read it (an HTML page, not JSON)" in out
    assert "starts with '<' (HTML or XML)" in out
    assert "Secret" not in out and "4242" not in out
    assert "→ 11 transactions" in out


def test_other_files_are_not_read_again_when_only_the_takeout_reader_improves():
    from app.imports import parser_version

    assert parser_version("gpay_takeout") > parser_version("cred_history") == parser_version("upi_statement")


def test_the_inspector_shows_structure_and_never_the_data(tmp_path, capsys):
    from app.tools import inspect_takeout

    inspect_takeout.main(fake_takeout.make_takeout(tmp_path / "t.zip"))
    out = capsys.readouterr().out
    assert "My Activity (HTML): 13 entries" in out and "Paid ₹999.99 to XXXXXX using Bank Account XXXXXX9999" in out
    for secret in ("SWIGGY", "Fake", "250.00", "1,234.50", "FAKETXN", "dinner", "2025", "1111", "GPA.0000"):
        assert secret not in out, secret


def test_the_inspector_shows_where_a_missing_name_is_without_showing_it(tmp_path, capsys):
    """A payment the reader can't find a name for: the inspector shows the shape of the whole entry, masked."""
    from app.tools import inspect_takeout

    entries = [("Paid ₹75.00<br>to FAKE SECRET SHOP", "Sep 4, 2025, 2:30:45 PM IST", "Completed"),  # name on its own line
               ("Paid ₹250.00 to SWIGGY using Bank Account XXXXXX1111", "Sep 4, 2025, 3:30:45 PM IST", "Completed")]
    path = tmp_path / "t.zip"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("Takeout/Google Pay/My Activity/My Activity.html", fake_takeout.activity_html(entries))
    inspect_takeout.main(path)
    out = capsys.readouterr().out
    assert "payments the reader found no name for: 1" in out
    assert "Paid ₹99.99 ⏎ to XXXX XXXXXX XXXX" in out  # where the name is, not what it is
    assert 'class="content-cell' in out
    for secret in ("SECRET", "SHOP", "SWIGGY", "75.00", "2025", "1111", "href"):
        assert secret not in out, secret
