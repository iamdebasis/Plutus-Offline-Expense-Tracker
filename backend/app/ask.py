"""Reading a question with the local AI, for "Ask Plutus", when the page's rules couldn't (web/src/lib/askRules.ts).

The model turns the question into a query of a fixed shape; the page computes the answer from your ledger
(web/src/lib/ask.ts). The model never sees a transaction, an amount or a name of yours: it gets the question you typed,
the category tree (the same for everyone), today's date and, for a follow-up, the last reading. Its answer is held to a
JSON schema and checked again here: unknown categories dropped, dates that aren't dates refused, limits kept sane.
The question itself is never written to the log.
"""

import json
import re
from datetime import date

from app import categorize, logs
from app.llm import llm

log = logs.get("llm")

KINDS = ["total", "count", "average", "top", "largest", "compare", "trend", "list", "last"]
MAX_QUESTION = 300

PROMPT = """You turn a question about someone's spending into a query. Answer only with JSON in the given format.

Today is {today} ({weekday}).

kind:
- "total": how much (the usual one)
- "count": how many payments
- "average": per payment, order or bill (per = "payment"), or per month (per = "month")
- "top": which payees or categories got the most (by = "payee" or "category"); limit = how many asked, else 5
- "largest": the biggest single payments; limit = how many asked, else 1 for "the biggest payment"
- "compare": two periods, from/to against compare_from/compare_to
- "trend": month by month
- "list": show the payments
- "last": the most recent payment
money: "in" for money received (salary, refunds, cashback); else "out".
channel: "upi" if the question says UPI, Google Pay, PhonePe or Paytm; "cards" if it says credit card(s); else "all".

from, to: the period, as YYYY-MM-DD, both days included; null for all time.
- A year is 1 January to 31 December. India's financial year (FY) is 1 April to 31 March: FY 2024-25 and FY25 are
  2024-04-01 to 2025-03-31.
- A month or season named without a year is the latest one that has begun: "since January" is from {year}-01-01 if
  January {year} has begun.
- "The last N days, weeks, months or years" and "the past N…" end today.
- Seasons in India: winter November to February, summer March to June, monsoon July to September. "Last winter" is
  the latest winter that has ended.

categories: ids from this list only; a top-level id includes its children. None when the question is about all
spending, or asks which category got the most (kind "top", by "category"):
{categories}

payees: names of particular shops, apps, companies or people, copied from the question as written; none if it names
none. A kind of payee ("shops", "doctors", "the electricity company") is a category or nothing, never a payee.
understood: false only if the question isn't about money spent or received.

The previous question's query:
{previous}
If the new question is a follow-up ("and in 2024?", "what about the year before?", "only UPI"), start from the previous
query and change only what the new question changes, keeping its categories and payees. If the new question stands
alone, ignore the previous query.

Question: {question}"""


def _categories() -> list[tuple[str, str]]:
    return [(cid, node["label"]) for cid, node in categorize.category_ids().items()]


def schema() -> dict:
    ids = [cid for cid, _ in _categories()]
    day = {"type": ["string", "null"]}
    return {
        "type": "object",
        "properties": {
            "kind": {"type": "string", "enum": KINDS},
            "categories": {"type": "array", "items": {"type": "string", "enum": ids}},
            "payees": {"type": "array", "items": {"type": "string"}},
            "channel": {"type": "string", "enum": ["all", "upi", "cards"]},
            "money": {"type": "string", "enum": ["out", "in"]},
            "from": day, "to": day, "compare_from": day, "compare_to": day,
            "by": {"type": "string", "enum": ["payee", "category"]},
            "per": {"type": "string", "enum": ["payment", "month"]},
            "limit": {"type": "integer"},
            "understood": {"type": "boolean"},
        },
        "required": ["kind", "categories", "payees", "channel", "money", "from", "to", "compare_from", "compare_to", "by",
                     "per", "limit", "understood"],
    }


def _day(value, today: date) -> date | None:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return None
    try:
        d = date.fromisoformat(value)
    except ValueError:
        return None
    return d if date(1990, 1, 1) <= d <= date(today.year + 1, 12, 31) else None


def _period(start, end, today: date) -> dict | None:
    a, b = _day(start, today), _day(end, today)
    if a is None or b is None or a > b:
        return None
    return {"from": a.isoformat(), "to": b.isoformat()}


def _compact(text: str) -> str:
    return re.sub(r"\W+", "", text.casefold())


def checked(answer: dict, today: date, question: str) -> dict:
    """The model's answer as a query the page can run, or `understood: false`. Nothing it says is taken unchecked: a
    payee must be in the question (not a guess, not a name from an example), and a list of most categories is
    "everything", not a filter."""
    ids = {cid for cid, _ in _categories()}
    tops = [cid for cid in ids if "." not in cid]
    said = _compact(question)
    payees = []
    for p in answer.get("payees") or []:
        word = re.sub(r"[^\w .&'-]+", " ", str(p)).strip()[:40]
        if word and _compact(word) in said and word.lower() not in (x.lower() for x in payees):
            payees.append(word)
    categories = [c for c in dict.fromkeys(answer.get("categories") or []) if c in ids]
    if len(categories) >= len(tops) / 2:
        categories = []
    limit = answer.get("limit")
    kind = answer.get("kind") if answer.get("kind") in KINDS else "total"
    period = _period(answer.get("from"), answer.get("to"), today)
    compare_to = _period(answer.get("compare_from"), answer.get("compare_to"), today)
    if kind == "compare" and (period is None or compare_to is None):
        kind = "total"
    return {
        "understood": bool(answer.get("understood", True)),
        "query": {
            "kind": kind,
            "categories": categories,
            "payees": payees[:5],
            "cards": [],
            "channel": answer.get("channel") if answer.get("channel") in ("all", "upi", "cards") else "all",
            "money": "in" if answer.get("money") == "in" else "out",
            "period": period,
            "compareTo": compare_to if kind == "compare" else None,
            "by": "category" if answer.get("by") == "category" else "payee",
            "per": "month" if answer.get("per") == "month" else "payment",
            "limit": min(max(limit, 1), 50) if isinstance(limit, int) and not isinstance(limit, bool) else 5,
        },
    }


def _previous(previous: dict | None) -> str:
    if not previous:
        return "none"
    keep = {k: previous.get(k) for k in ("kind", "categories", "payees", "channel", "money", "by", "per", "limit")}
    for key in ("period", "compareTo"):
        p = previous.get(key)
        if isinstance(p, dict):
            keep[key] = {"from": p.get("from"), "to": p.get("to")}
    return json.dumps(keep)


async def read_question(question: str, previous: dict | None, today: date) -> dict:
    """The question as a query (see `checked`). Raises ValueError for an empty or overlong question, LLMUnavailable
    when there's no local AI to ask."""
    question = " ".join(question.split())
    if not question:
        raise ValueError("Ask a question first")
    if len(question) > MAX_QUESTION:
        raise ValueError(f"That's a long question: keep it under {MAX_QUESTION} characters")
    prompt = PROMPT.format(
        today=today.isoformat(), weekday=today.strftime("%A"), year=today.year, question=question, previous=_previous(previous),
        categories="\n".join(f"- {cid}: {label}" for cid, label in _categories()),
    )
    async with llm.session() as ai:
        raw = await ai.chat([{"role": "user", "content": prompt}], schema=schema(), timeout=90, purpose="read a question",
                            limit=400)
    try:
        answer = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("the local AI's reading of a question wasn't valid JSON")
        return {"understood": False, "query": None}
    return checked(answer if isinstance(answer, dict) else {}, today, question)
