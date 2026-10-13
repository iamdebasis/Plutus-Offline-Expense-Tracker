"""Reading a question with the local AI, for "Ask Plutus", when the page's rules couldn't (web/src/lib/askRules.ts).

The model turns the question into a query of a fixed shape; the page computes the answer from your ledger
(web/src/lib/ask.ts). The model never sees a transaction, an amount or a name of yours: it gets the question you typed,
the category tree (the same for everyone), today's date and, for a follow-up, the last reading. Its answer is held to a
JSON schema and checked again here: unknown categories dropped, dates that aren't dates refused, limits kept sane.
The question itself is never written to the log.

Telling where you were, the page can ask it one more thing (`read_place`): the place as you wrote it, only those words,
to have it spelt as usual and given its state, as a suggestion the page shows with a button.
"""

import json
import re
from datetime import date

from app import categorize, logs, places
from app.llm import llm

log = logs.get("llm")

KINDS = ["total", "count", "average", "top", "largest", "compare", "trend", "list", "last", "why", "where"]
# What a sentence can tell rather than ask: where you were ("stay") or weren't ("forget"). Only ever a proposal: the
# page shows what it would do, and only your button keeps it (POST /api/places).
ACTIONS = ["none", "stay", "forget"]
# India's seasons, as the page reads them (web/src/lib/ask.ts `SEASONS`; a test keeps the two the same): the month each
# starts and how many months it lasts. IMD's months, December in winter, as the owner chose (docs/DECISIONS.md #22).
SEASONS = {"winter": (12, 3), "summer": (3, 3), "monsoon": (6, 4), "post-monsoon": (10, 2)}
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
- "why": what made a period's spending differ: from/to the period asked about, compare_from/compare_to the one it
  changed from (null when the question names only one: Plutus sets it against the period before)
- "where": where the person was, the places they told Plutus, in a period
money: "in" for money received (salary, refunds, cashback); else "out".
channel: "upi" if the question says UPI, Google Pay, PhonePe or Paytm; "cards" if it says credit card(s); else "all".

from, to: the period, as YYYY-MM-DD, both days included; null for all time.
- A year is 1 January to 31 December. India's financial year (FY) is 1 April to 31 March: FY 2024-25 and FY25 are
  2024-04-01 to 2025-03-31.
- A month or season named without a year is the latest one that has begun: "since January" is from {year}-01-01 if
  January {year} has begun.
- "The last N days, weeks, months or years" and "the past N…" end today.
- Seasons in India, IMD's months with December in winter: {seasons}. "Last winter" is the latest winter that has
  ended; "this monsoon" or "the monsoon" the latest that has begun. "Winter 2025" could be either winter: understood
  only if the question says which.

categories: ids from this list only; a top-level id includes its children. None when the question is about all
spending, or asks which category got the most (kind "top", by "category"):
{categories}

payees: names of particular shops, apps, companies or people, copied from the question as written; none if it names
none. A kind of payee ("shops", "doctors", "the electricity company") is a category or nothing, never a payee.
understood: false only if the question isn't about money spent or received, or where the person was.

action: "stay" when the sentence tells where the person was or will be on some days instead of asking ("I was in Goa
from 1 Jan to 5 Mar", "we're in Kerala this week"): place = the place as written in the sentence, from/to = its days.
"forget" when it asks to forget or remove a place told before ("forget Goa", "I wasn't in Goa in January"): place, and
from/to only if it names days. Otherwise "none".
place: the place for an action, copied from the sentence as written; null otherwise.

The previous question's query:
{previous}
If the new question is a follow-up ("and in 2024?", "what about the year before?", "only UPI"), start from the previous
query and change only what the new question changes, keeping its categories and payees. If the new question stands
alone, ignore the previous query.

Question: {question}"""


PLACE_PROMPT = """Someone told an app where they stayed in India. They wrote the place as: "{written}"
It may be misspelt, or not capitalised. Answer only with JSON in the given format.

places: the place they meant: its name, spelt as it is usually written, and the state or union territory it is in, by
its code from the list below.
- If places in more than one state have that name, give each one, the best known first, at most 4.
- Keep the name they used: correct only its spelling. Never give another name for the same place, a newer or an older
  one.
- If the name is a state or union territory itself, give that, with its own code.
known: false, with no places, if you don't know a place in India by that name, or aren't sure. Never guess.

States and union territories:
{states}"""
MAX_CANDIDATES = 4


def _seasons() -> str:
    """ "winter December to February, summer March to May, …", from `SEASONS`."""
    month = lambda n: date(2000, (n - 1) % 12 + 1, 1).strftime("%B")  # noqa: E731
    return ", ".join(f"{name} {month(start)} to {month(start + length - 1)}" for name, (start, length) in SEASONS.items())


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
            "action": {"type": "string", "enum": ACTIONS},
            "place": {"type": ["string", "null"]},
        },
        "required": ["kind", "categories", "payees", "channel", "money", "from", "to", "compare_from", "compare_to", "by",
                     "per", "limit", "understood", "action", "place"],
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


def _told(answer: dict, today: date, question: str) -> dict | None:
    """A sentence telling where you were (or weren't), as a proposal for the page to show: the place must be written in
    the sentence; days that aren't real or are out of order are left out, so the page asks when. Nothing is kept here."""
    kind = answer.get("action")
    if kind not in ("stay", "forget"):
        return None
    raw = answer.get("place")
    place = re.sub(r"[^\w .,'&()/-]+", " ", raw).strip()[:40] if isinstance(raw, str) else ""
    if place and _compact(place) not in _compact(question):
        place = ""
    if not place and kind == "stay":
        return {"understood": False, "query": None}
    days = _period(answer.get("from"), answer.get("to"), today)
    action = {"kind": kind, "place": place or None, "from": days["from"] if days else None, "to": days["to"] if days else None}
    return {"understood": True, "query": None, "action": action}


def checked(answer: dict, today: date, question: str) -> dict:
    """The model's answer as a query the page can run, or `understood: false`. Nothing it says is taken unchecked: a
    payee must be in the question (not a guess, not a name from an example), and a list of most categories is
    "everything", not a filter. A sentence telling where you were comes back as a proposal (`_told`)."""
    if (told := _told(answer, today, question)) is not None:
        return told
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
            "compareTo": compare_to if kind in ("compare", "why") else None,
            "by": "category" if answer.get("by") == "category" else "payee",
            "per": "month" if answer.get("per") == "month" else "payment",
            "limit": min(max(limit, 1), 50) if isinstance(limit, int) and not isinstance(limit, bool) else 5,
        },
    }


def place_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "known": {"type": "boolean"},
            "places": {"type": "array", "items": {
                "type": "object",
                "properties": {"name": {"type": "string"}, "state": {"type": "string", "enum": list(places.STATES)}},
                "required": ["name", "state"],
            }},
        },
        "required": ["known", "places"],
    }


def checked_places(answer) -> list[dict]:
    """What the model says a place is, as suggestions: each a short plain name and a state of India's (an old code
    taken as today's); no repeats; at most `MAX_CANDIDATES`. Nothing when it doesn't know the place."""
    if not isinstance(answer, dict) or answer.get("known") is not True or not isinstance(answer.get("places"), list):
        return []
    out: list[dict] = []
    for row in answer["places"]:
        if not isinstance(row, dict) or not isinstance(row.get("name"), str) or not isinstance(row.get("state"), str):
            continue
        try:
            place, region = places.place_name(row["name"]), places.region_code(row["state"])
        except places.BadStay:
            continue
        if not any(p["place"].casefold() == place.casefold() and p["region"] == region for p in out):
            out.append({"place": place, "region": region})
    return out[:MAX_CANDIDATES]


async def read_place(written: str) -> dict:
    """A place as you wrote it, read by the local AI into its usual spelling and its state; `places` is empty when it
    doesn't know it. Raises places.BadStay unless it's a short plain name, LLMUnavailable without a local AI."""
    written = places.place_name(written)
    prompt = PLACE_PROMPT.format(written=written, states="\n".join(f"- {code}: {name}" for code, name in places.STATES.items()))
    async with llm.session() as ai:
        raw = await ai.chat([{"role": "user", "content": prompt}], schema=place_schema(), timeout=90, purpose="read a place",
                            limit=200)
    try:
        answer = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("the local AI's reading of a place wasn't valid JSON")
        return {"places": []}
    return {"places": checked_places(answer)}


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
        categories="\n".join(f"- {cid}: {label}" for cid, label in _categories()), seasons=_seasons(),
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
