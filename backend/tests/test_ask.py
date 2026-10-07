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
