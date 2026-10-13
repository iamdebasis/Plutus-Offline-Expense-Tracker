"""The local AI reading a question for "Ask Plutus" (app/ask.py, POST /api/ask), with a fake model: what it's told
(the question, the categories, today; never a transaction), how its answer is checked, and what happens without it.
The question is never written to the log. Fake data only."""

import json
import time
from contextlib import asynccontextmanager

import pytest
from fastapi.testclient import TestClient

from app.llm import llm
from app.main import app


class FakeModel:
    def __init__(self, answer):
        self.answer = answer
        self.prompts: list[str] = []
        self.schemas: list[dict] = []

    async def chat(self, messages, schema=None, **_):
        self.prompts.append(messages[0]["content"])
        self.schemas.append(schema)
        return self.answer if isinstance(self.answer, str) else json.dumps(self.answer)


@pytest.fixture
def model(monkeypatch):
    fake = FakeModel({})

    @asynccontextmanager
    async def session():
        yield fake

    monkeypatch.setattr(llm, "session", session)
    return fake


@pytest.fixture
def client():
    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


WINTER = {"kind": "total", "categories": ["bills.electricity", "bills.broadband"], "payees": [], "channel": "all", "money": "out",
          "from": "2025-11-01", "to": "2026-02-28", "compare_from": None, "compare_to": None, "by": "payee", "per": "payment",
          "limit": 5, "understood": True}


def test_a_question_becomes_a_query(model, client, caplog):
    model.answer = WINTER
    question = "What did keeping the lights on and the internet cost me last winter?"
    with caplog.at_level("INFO"):
        res = client.post("/api/ask", json={"question": question})
    assert res.status_code == 200, res.text
    assert res.json() == {"understood": True, "query": {
        "kind": "total", "categories": ["bills.electricity", "bills.broadband"], "payees": [], "cards": [], "channel": "all",
        "money": "out", "period": {"from": "2025-11-01", "to": "2026-02-28"}, "compareTo": None, "by": "payee", "per": "payment",
        "limit": 5}}
    [prompt] = model.prompts
    assert question in prompt and "- bills.electricity: Electricity" in prompt and "Today is " in prompt
    assert "bills.electricity" in model.schemas[0]["properties"]["categories"]["items"]["enum"]
    assert "lights" not in caplog.text  # the question never reaches the log


def test_what_the_model_is_told_holds_nothing_of_yours(model, client, tmp_path):
    """Even with a ledger full of payments, the prompt has only the question, the categories, today and the last reading."""
    from tests import fake_cards

    path = fake_cards.axis(tmp_path / "axis.pdf")
    with path.open("rb") as f:
        upload_id = client.post("/api/uploads", files={"file": (path.name, f, "application/pdf")}, data={"kind": "auto"}).json()["id"]
    deadline = time.monotonic() + 15
    while next(u for u in client.get("/api/uploads").json() if u["id"] == upload_id)["importStatus"]["state"] not in ("done", "failed"):
        assert time.monotonic() < deadline, "import didn't finish"
        time.sleep(0.1)
    assert client.get("/api/transactions").json(), "the ledger has payments"
    model.prompts.clear()  # the import asked the (fake) model about payees; only the question's prompt matters here
    model.answer = WINTER
    client.post("/api/ask", json={"question": "and in 2024?", "previous": {"kind": "total", "categories": ["bills.electricity"],
                                                                          "period": {"from": "2025-01-01", "to": "2025-12-31"}}})
    [prompt] = model.prompts
    for theirs in ("FAKE GROCER", "FAKE FOOD APP", "1234.50", "3141"):
        assert theirs not in prompt
    assert '"categories": ["bills.electricity"]' in prompt and "2025-01-01" in prompt  # the last reading, for the follow-up


def test_the_answer_is_checked_not_trusted(model, client):
    model.answer = {**WINTER, "kind": "compare", "categories": ["bills.electricity", "made.up"], "payees": ["Swiggy!!", "swiggy", "x" * 80],
                    "channel": "fax", "money": "sideways", "compare_from": "2024-13-01", "compare_to": "2024-12-31", "limit": 9999}
    q = client.post("/api/ask", json={"question": f"how much to swiggy or {'x' * 80}"}).json()["query"]
    assert q["categories"] == ["bills.electricity"]
    assert q["payees"] == ["Swiggy", "x" * 40]
    assert (q["channel"], q["money"], q["limit"]) == ("all", "out", 50)
    assert q["kind"] == "total" and q["compareTo"] is None  # a comparison without a real second period is a total
    model.answer = {**WINTER, "from": "2026-05-01", "to": "2026-01-01"}
    assert client.post("/api/ask", json={"question": "backwards"}).json()["query"]["period"] is None
    model.answer = "not json at all"
    assert client.post("/api/ask", json={"question": "anything"}).json() == {"understood": False, "query": None}


def test_names_come_from_the_question_and_most_categories_is_everything(model, client):
    """A payee the question doesn't name (a guess, a name from an example) is dropped; a list of most categories is
    "everything", not a filter; a few named are kept."""
    from app import ask, categorize

    model.answer = {**WINTER, "payees": ["swiggy", "Mr Fake Payee"]}
    q = client.post("/api/ask", json={"question": "top 3 places in march, and what about mr fake payee?"}).json()["query"]
    assert q["payees"] == ["Mr Fake Payee"]
    tops = [cid for cid in categorize.category_ids() if "." not in cid]
    model.answer = {**WINTER, "kind": "top", "by": "category", "categories": tops}
    assert client.post("/api/ask", json={"question": "Which category ate most of my money?"}).json()["query"]["categories"] == []
    model.answer = {**WINTER, "categories": ["food", "groceries", "bills.electricity"]}
    assert client.post("/api/ask", json={"question": "food, groceries and power"}).json()["query"]["categories"] == [
        "food", "groceries", "bills.electricity"]
    assert not any(name in ask.PROMPT.lower() for name in ("swiggy", "zomato", "amazon"))  # no names to copy


def test_a_question_that_isnt_about_money(model, client):
    model.answer = {**WINTER, "understood": False}
    assert client.post("/api/ask", json={"question": "what's the weather"}).json()["understood"] is False


def test_empty_or_overlong_questions_are_refused(model, client):
    assert client.post("/api/ask", json={"question": "   "}).status_code == 400
    res = client.post("/api/ask", json={"question": "x" * 301})
    assert res.status_code == 400 and "under 300 characters" in res.json()["detail"]["message"]
    assert model.prompts == []


def test_without_a_local_ai_the_page_is_told(client):
    res = client.post("/api/ask", json={"question": "what did winter cost me"})  # conftest: no LLM in tests
    assert res.status_code == 409 and res.json()["detail"]["code"] == "no_ai"


def test_the_ai_is_told_the_seasons_the_page_reads():
    """The rules in the page and the local AI mean the same months by a season: ask.py's SEASONS is the page's
    (web/src/lib/ask.ts), and the prompt says them in words."""
    import re
    from pathlib import Path

    from app import ask

    page = (Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "ask.ts").read_text(encoding="utf-8")
    block = page[page.index("export const SEASONS"):page.index("}\n", page.index("export const SEASONS"))]
    theirs = {name: (int(start), int(months)) for name, start, months in re.findall(r"'?([\w-]+)'?: \{ start: (\d+), months: (\d+) \}", block)}
    assert theirs == ask.SEASONS
    assert ask._seasons() == "winter December to February, summer March to May, monsoon June to September, post-monsoon October to November"


def test_a_why_question_keeps_what_it_is_set_against(model, client):
    """The local AI can read a "why" the rules can't: the period asked about, and what it changed from, or none (the
    page sets it against the period before)."""
    model.answer = {**WINTER, "kind": "why", "from": "2026-03-01", "to": "2026-03-31", "compare_from": None, "compare_to": None}
    q = client.post("/api/ask", json={"question": "what drove my spending up in march?"}).json()["query"]
    assert (q["kind"], q["period"], q["compareTo"]) == ("why", {"from": "2026-03-01", "to": "2026-03-31"}, None)
    model.answer = {**WINTER, "kind": "why", "from": "2026-01-01", "to": "2026-12-31", "compare_from": "2025-01-01", "compare_to": "2025-12-31"}
    q = client.post("/api/ask", json={"question": "what drove 2026 above 2025?"}).json()["query"]
    assert (q["kind"], q["compareTo"]) == ("why", {"from": "2025-01-01", "to": "2025-12-31"})
    assert "why" in model.schemas[-1]["properties"]["kind"]["enum"] and '"why"' in model.prompts[-1]


def test_telling_where_you_were_comes_back_as_a_stay_to_confirm(model, client):
    """The model only reads the sentence; what it reads is a proposal the page shows, saved only by your button. The
    place must be written in the sentence, the days real and in order (else the page asks when); nothing else is an
    action."""
    from app import ask

    stay = {**WINTER, "action": "stay", "place": "Goa", "from": "2026-01-01", "to": "2026-03-05"}
    model.answer = stay
    said = "spent new year's day through the fifth of march in goa"
    assert client.post("/api/ask", json={"question": said}).json() == {
        "understood": True, "query": None, "action": {"kind": "stay", "place": "Goa", "from": "2026-01-01", "to": "2026-03-05"}}
    model.answer = {**stay, "place": "Kerala"}  # not in the sentence: never taken
    assert client.post("/api/ask", json={"question": said}).json() == {"understood": False, "query": None}
    model.answer = {**stay, "from": "2026-03-05", "to": "2026-01-01"}  # backwards: the page asks when
    assert client.post("/api/ask", json={"question": said}).json()["action"] == {"kind": "stay", "place": "Goa", "from": None, "to": None}
    model.answer = {**stay, "action": "forget", "from": None, "to": None}
    assert client.post("/api/ask", json={"question": "please forget goa"}).json()["action"] == {
        "kind": "forget", "place": "Goa", "from": None, "to": None}
    model.answer = {**WINTER, "action": "delete_everything", "place": "Goa"}  # not an action Plutus has: a question
    res = client.post("/api/ask", json={"question": "goa"}).json()
    assert "action" not in res and res["query"]["kind"] == "total"
    assert model.schemas[-1]["properties"]["action"]["enum"] == ["none", "stay", "forget"]
    assert '"stay"' in ask.PROMPT and '"where"' in ask.PROMPT


def test_where_was_i_is_a_kind_of_question(model, client):
    model.answer = {**WINTER, "kind": "where", "categories": [], "from": "2026-02-01", "to": "2026-02-28"}
    q = client.post("/api/ask", json={"question": "which town was I in during feb"}).json()["query"]
    assert (q["kind"], q["period"]) == ("where", {"from": "2026-02-01", "to": "2026-02-28"})


def test_a_place_is_read_into_its_usual_spelling_and_its_state(model, client, caplog):
    """Telling a stay, the page sends the local AI only the place as written (never a payment, never the rest of the
    sentence); what comes back is a suggestion the page shows, never kept by itself. The place never reaches the log."""
    from app import places

    model.answer = {"known": True, "places": [{"name": "Mumbai", "state": "MH"}]}
    with caplog.at_level("INFO"):
        res = client.post("/api/ask/place", json={"written": "mambaii"})
    assert res.status_code == 200 and res.json() == {"places": [{"place": "Mumbai", "region": "MH"}]}
    [prompt] = model.prompts
    assert '"mambaii"' in prompt and "- WB: West Bengal" in prompt and "- DD: Dadra and Nagar Haveli and Daman and Diu" in prompt
    assert model.schemas[0]["properties"]["places"]["items"]["properties"]["state"]["enum"] == list(places.STATES)
    assert "mambaii" not in caplog.text.lower() and "mumbai" not in caplog.text.lower()


def test_a_name_in_several_states_comes_back_as_each(model, client):
    model.answer = {"known": True, "places": [{"name": "Aurangabad", "state": "MH"}, {"name": "Aurangabad", "state": "BR"}]}
    assert client.post("/api/ask/place", json={"written": "Aurangadad"}).json()["places"] == [
        {"place": "Aurangabad", "region": "MH"}, {"place": "Aurangabad", "region": "BR"}]


def test_what_the_ai_says_about_a_place_is_checked_not_trusted(model, client):
    """A state from India's 36 (an old code taken as today's), a short plain name, no repeats, at most four; a place
    it doesn't know, or an answer of the wrong shape, is nothing: the page keeps the place as you wrote it."""
    model.answer = {"known": True, "places": [
        {"name": "Fakenagar", "state": "XX"}, {"name": "Fake<b>pur", "state": "WB"}, {"name": "x" * 41, "state": "KA"},
        {"name": "Fakeganj", "state": None}, {"name": None, "state": "KA"}, "Fakepur",
        {"name": "  Fakeganj ", "state": "ts"}, {"name": "fakeganj", "state": "TG"},
        {"name": "Fakepur", "state": "WB"}, {"name": "Fakepur", "state": "OD"}, {"name": "Fakepur", "state": "BR"},
        {"name": "Fakepur", "state": "UP"}]}
    assert client.post("/api/ask/place", json={"written": "fakepur"}).json()["places"] == [
        {"place": "Fakeganj", "region": "TG"}, {"place": "Fakepur", "region": "WB"}, {"place": "Fakepur", "region": "OD"},
        {"place": "Fakepur", "region": "BR"}]
    for answer in [{"known": False, "places": [{"name": "Fakepur", "state": "WB"}]}, "not json at all",
                   {"known": True, "places": "Fakepur"}, ["Fakepur"]]:
        model.answer = answer
        assert client.post("/api/ask/place", json={"written": "fakepur"}).json() == {"places": []}, answer


def test_a_place_to_read_is_a_short_plain_name(model, client):
    for bad in ["", "   ", "x" * 41, "Goa\nKerala", "{Goa}"]:
        r = client.post("/api/ask/place", json={"written": bad})
        assert r.status_code == 400 and r.json()["detail"]["code"] == "bad_place", repr(bad)
    assert model.prompts == []


def test_without_a_local_ai_a_place_isnt_read(client):
    res = client.post("/api/ask/place", json={"written": "fakepur"})  # conftest: no LLM in tests
    assert res.status_code == 409 and res.json()["detail"]["code"] == "no_ai"
