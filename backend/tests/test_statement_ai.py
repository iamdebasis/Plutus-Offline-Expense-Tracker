"""The local AI reading statements the rules couldn't prove, with a fake model (tests never run the real one): its
reading counts only when the statement's own figures prove it, or when it found exactly the rows the rules did. A
model that points at the wrong figures, or at ids that aren't there, never gets anything counted. Fake data only."""

import json
import re
import time
from contextlib import asynccontextmanager

import pytest
from fastapi.testclient import TestClient

from app import statements
from app.ingest.detect import detect
from app.llm import llm
from app.main import app
from app.parsers import statement_ai
from app.parsers.statement_reader import parse
from tests import fake_cards

_SUMMARY = re.compile(r"balance|due|limit|total", re.IGNORECASE)
_CREDIT = re.compile(r"\bCR\b|PAYMENT|REFUND|CASHBACK|REVERSAL", re.IGNORECASE)
_DATE = re.compile(r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{1,2}[- ][A-Z][a-z]{2}[- ]\d{2,4}\b")


class FakeAI:
    """Answers the way a careful model would: a line with a date and an amount is a transaction (its last amount);
    the previous balance and total due by their labels. `liar` points at the wrong figures and at ids that don't exist;
    `careless` takes every row for a debit, payments and refunds too."""

    def __init__(self, liar: bool = False) -> None:
        self.liar = liar
        self.careless = False
        self.breaks_on = 0  # a question with more lines than this gets a broken answer (a small model running on)
        self.takes_totals = False  # lists the statement's own figures as transactions too (a real model did)
        self.calls = 0

    async def chat(self, messages, schema=None, **_):
        self.calls += 1
        if self.breaks_on and sum(1 for line in messages[0]["content"].splitlines() if re.match(r"L\d+: ", line)) > self.breaks_on:
            return '{"rows": [{"line": "L1", "amou'

        rows, previous, due = [], None, None
        for line in messages[0]["content"].splitlines():
            m = re.match(r"(L\d+): (.*)", line)
            if not m:
                continue
            lid, text = m[1], m[2]
            ms = re.findall(r"\[(m\d+)\]", text)
            if ms and re.search(r"previous balance|opening balance", text, re.IGNORECASE):
                previous = ms[0]
            elif ms and re.search(r"total (amount )?due|total dues|total payment due", text, re.IGNORECASE):
                due = ms[0]
            if ms and self.takes_totals and _SUMMARY.search(text):
                rows.append({"line": lid, "amount": ms[0], "direction": "debit"})
            elif ms and _DATE.search(text) and not _SUMMARY.search(text):
                rows.append({"line": "L999" if self.liar and len(rows) % 2 else lid, "amount": ms[0] if self.liar else ms[-1],
                             "direction": "debit" if self.liar or self.careless else ("credit" if _CREDIT.search(text) else "debit")})
        return json.dumps({"rows": rows, "previous_balance": previous, "total_due": due})


@pytest.fixture
def ai(monkeypatch):
    model = FakeAI()

    @asynccontextmanager
    async def session():
        yield model

    monkeypatch.setattr(llm, "session", session)
    return model


@pytest.fixture
def client():
    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def _upload(client, path):
    with path.open("rb") as f:
        upload_id = client.post("/api/uploads", files={"file": (path.name, f, "application/pdf")}, data={"kind": "cc_statement"}).json()["id"]
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        rec = next(u for u in client.get("/api/uploads").json() if u["id"] == upload_id)
        if (rec.get("importStatus") or {}).get("state") in ("done", "failed", "skipped"):
            return upload_id, rec["importStatus"]
        time.sleep(0.1)
    raise AssertionError("import didn't finish")


def _dates_in_the_middle(path):
    """A layout the rules can't read (each row's date sits after its shop), with figures that prove a reading."""
    page = fake_cards.Page().at(40, "Fake Bank Credit Card Statement").down().at(40, "Card No: 4000 00XX XXXX 3141").down()
    page.at(40, "Statement Date: 12/09/2026").down().at(40, "Previous Balance: 1,000.00").down().at(40, "Total Amount Due: 2,940.25").down(25)
    for shop, day, amount in (("FAKE GROCER", "14/08/2026", "1,234.50"), ("FAKE CHAI POINT", "20/08/2026", "205.75"),
                              ("FAKE AIRWAYS", "02/09/2026", "1,500.00 Cr"), ("FAKE BOOKSHOP", "05/09/2026", "2,000.00")):
        page.at(40, f"{shop} on {day}").at(420, amount).down()
    return fake_cards.save(path, [page])


def test_a_layout_the_rules_cant_read_is_read_by_the_ai_and_proven_by_its_figures(client, tmp_path, ai):
    upload_id, status = _upload(client, _dates_in_the_middle(tmp_path / "middle.pdf"))
    s = statements.get(upload_id)
    assert (status["state"], s.status, s.check) == ("done", "proven", "matched")
    assert s.proof.startswith("read by the local AI")
    got = sorted((t["at"][:10], t["amount"], t["direction"]) for t in client.get("/api/transactions").json())
    assert got == [("2026-08-14", 1234.5, "debit"), ("2026-08-20", 205.75, "debit"), ("2026-09-02", 1500.0, "credit"),
                   ("2026-09-05", 2000.0, "debit")]


def test_the_statements_own_figures_are_never_taken_for_transactions(client, tmp_path, ai):
    """A model that lists "Total Amount Due" as a purchase (a real one did): that figure is left out, never dated by
    the statement date above it, and the true rows are proven."""
    ai.takes_totals = True
    upload_id, _ = _upload(client, _dates_in_the_middle(tmp_path / "middle.pdf"))
    assert statements.get(upload_id).status == "proven"
    assert len(client.get("/api/transactions").json()) == 4


def test_an_ai_pointing_at_the_wrong_figures_gets_nothing_counted(client, tmp_path, ai):
    ai.liar = True
    upload_id, status = _upload(client, _dates_in_the_middle(tmp_path / "middle.pdf"))
    s = statements.get(upload_id)
    assert s.status == "on_hold" and client.get("/api/transactions").json() == []


def _export(path, extra: str | None = None):
    """The card's transactions over a span, as a bank's site exports them: no totals, no balance."""
    page = fake_cards.Page().at(40, "Fake Bank Credit Card Transactions").down().at(40, "Card No: 4000 00XX XXXX 3141").down()
    page.at(40, "From 01/07/2026 To 30/09/2026").down(25).at(40, "Date").at(120, "Transaction Details").at(420, "Amount (Rs.)").down()
    for day, shop, amount in (("03/07/2026", "FAKE GROCER", "1,234.50"), ("15/08/2026", "PAYMENT RECEIVED - THANK YOU", "5,000.00 Cr"),
                              ("09/09/2026", "FAKE CHAI POINT", "205.75")):
        page.at(40, day).at(120, shop).at(420, amount).down()
    if extra:  # a schedule a careless reader takes for transactions
        page.down(20).at(40, "EMI Summary").down().at(40, "01/08/2026").at(120, extra).at(420, "9,999.00").down()
    return fake_cards.save(path, [page])


def test_with_nothing_to_check_against_the_ai_must_read_exactly_what_the_rules_did(client, tmp_path, ai):
    upload_id, _ = _upload(client, _export(tmp_path / "export.pdf"))
    assert statements.get(upload_id).status == "agreed"  # the rules and the AI found the same rows: counted
    got = sorted((t["at"][:10], t["amount"], t["direction"]) for t in client.get("/api/transactions").json())
    assert got == [("2026-07-03", 1234.5, "debit"), ("2026-08-15", 5000.0, "credit"), ("2026-09-09", 205.75, "debit")]


def test_when_the_ai_and_the_rules_disagree_it_stays_held(client, tmp_path, ai):
    """The model takes the payment for a debit; the rules don't: no agreement, nothing counted."""
    ai.careless = True
    upload_id, _ = _upload(client, _export(tmp_path / "export.pdf"))
    assert statements.get(upload_id).status == "on_hold" and client.get("/api/transactions").json() == []


def test_the_ai_isnt_asked_about_a_schedule_the_rules_know_holds_no_transactions(client, tmp_path, ai):
    """An EMI schedule's lines never reach the model: it can't take them for purchases."""
    upload_id, _ = _upload(client, _export(tmp_path / "export.pdf", extra="FAKE PHONE EMI 3 OF 12"))
    assert statements.get(upload_id).status == "agreed"
    assert all("EMI" not in t["note"] for t in client.get("/api/transactions").json())


def test_a_long_list_with_nothing_to_check_it_by_isnt_worth_the_wait(client, tmp_path, ai):
    """A year's list of the card's rows, no figures: the AI could only agree row for row, at about 20 seconds a part.
    It isn't asked; the list waits on hold for you, and other files aren't kept waiting behind it."""
    pages, page = [], fake_cards.Page().at(40, "Fake Bank Credit Card Transactions").down().at(40, "Card No: 4000 00XX XXXX 3141").down(25)
    page.at(40, "Date").at(120, "Transaction Details").at(420, "Amount (Rs.)").down()
    for n in range(180):
        if page.y > 790:
            pages.append(page)
            page = fake_cards.Page()
        page.at(40, f"{1 + n % 28:02d}/{1 + n // 20:02d}/2026").at(120, f"FAKE SHOP {n}").at(420, f"{100 + n}.50").down()
    upload_id, status = _upload(client, fake_cards.save(tmp_path / "year.pdf", [*pages, page]))
    assert (status["state"], statements.get(upload_id).status, ai.calls) == ("done", "on_hold", 0)
    assert len(statements.get(upload_id).held) == 180


def test_a_file_with_totals_counts_only_when_they_prove_it_not_when_the_ai_agrees(client, tmp_path, ai):
    """A year's summary whose totals the rows don't come to: the AI reading the same rows as the rules is no proof."""
    upload_id, _ = _upload(client, fake_cards.year_end(tmp_path / "year.pdf", tamper=True))
    s = statements.get(upload_id)
    assert (s.status, s.check, ai.calls > 0) == ("on_hold", "mismatch", True)
    assert client.get("/api/transactions").json() == []


def test_a_statement_that_doesnt_add_up_stays_held_whatever_the_ai_says(client, tmp_path, ai):
    upload_id, _ = _upload(client, fake_cards.axis(tmp_path / "axis.pdf", tamper=True))
    assert statements.get(upload_id).status == "on_hold" and client.get("/api/transactions").json() == []


def test_the_ais_answers_are_kept_so_a_file_read_again_asks_nothing(tmp_path, ai):
    import asyncio

    from app import vault
    from app.models import Detection, UploadRecord

    path = _dates_in_the_middle(tmp_path / "middle.pdf")
    rec = UploadRecord(id="u1", original_name="middle.pdf", stored_path=str(path), sha256="0" * 64, size=1,
                       detection=Detection(kind="cc_statement", label="Fake", confidence=1.0), uploaded_at="2026-09-12T00:00:00Z")
    first = asyncio.run(statement_ai.resolve(path, rec, None))
    calls = ai.calls
    again = asyncio.run(statement_ai.resolve(path, rec, None))
    assert ai.calls == calls and first.statement.status == again.statement.status == "proven"
    del vault  # (registering the card is the only other thing it touches)


def test_the_rules_read_the_middle_layout_as_nothing_on_their_own(tmp_path):
    from app.parsers import ParseError

    path = _dates_in_the_middle(tmp_path / "middle.pdf")
    with pytest.raises(ParseError):
        parse(path, "u", detect(path, path.name))


def test_a_part_the_model_breaks_on_is_asked_again_in_halves(client, tmp_path, ai):
    """A small model can loop on a long list; asked about half as many lines, it answers. The reading is whole again,
    and proven by the figures."""
    ai.breaks_on = 6
    upload_id, _ = _upload(client, _dates_in_the_middle(tmp_path / "middle.pdf"))
    assert statements.get(upload_id).status == "proven"
    assert len(client.get("/api/transactions").json()) == 4

