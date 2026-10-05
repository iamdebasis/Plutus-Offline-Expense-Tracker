"""The local AI's reading of a statement the rules couldn't prove. It points at the statement's own lines and amounts;
it never writes a figure. Its reading counts only when the statement's own arithmetic proves it, or, with nothing on
the statement to prove it by, when it found exactly the rows the rules did ("agreed"). Anything else stays on hold.

The statement's lines go to the model on this Mac, about 20 at a time (a small model reads a short list reliably, and
loops on a long one), with every date and amount tagged: "30 Jul 2026[d14] REFUND FAKE SHOP 1,319.74 Cr[m22]". It
answers which date and which amount make each transaction, whether it's a debit or a credit, and which amounts are the
previous balance and the total due. Its answers are kept in data/statement_ai.json, so reading the same file again
doesn't ask again; a part it couldn't answer is a gap, which leaves the statement unproven, never guessed.
"""

import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import httpx

from app import logs, userdata
from app.models import CardStatement, UploadRecord
from app.parsers import ParseResult
from app.parsers import card_statement as cs
from app.parsers import shape_reader as sr
from app.parsers import statement_reader as rd

log = logs.get("llm")
PROMPT_VERSION = 3  # bump when the prompt or the chunks change: earlier answers are asked again
CHUNK, OVERLAP = 20, 3  # lines per question, and how many it shares with the one before (a row split across the cut)
# With no figures on it to prove a reading by, the AI's reading counts only when it matches the rules' row for row,
# which a small model rarely manages over a long list, at about 20 seconds a part. A longer file isn't worth the wait
# (a year's list of 500 rows took a quarter of an hour): it stays on hold for you to check. With figures to prove it
# by, longer, but not without end: other files wait behind it.
UNCHECKED_PARTS, CHECKED_PARTS = 8, 16


def _checkable(s: cs.Summary) -> bool:
    """Whether the statement prints figures its rows can be proven by: balances, or totals of debits and credits."""
    return (s.previous_balance is not None and s.total_due is not None) or (s.printed_debits is not None and s.printed_credits is not None)

PROMPT = """These are some lines of a credit card statement, each with an id (L1, L2, ...). Every amount of money in them has
an id in square brackets after it, like [m7].

List every transaction in these lines: each purchase, fee, charge, interest, cash withdrawal, payment to the card,
refund, reversal or cashback. For each, give the id of its line, the id of its amount, and whether it is a "debit" (a
purchase, fee, charge, interest or withdrawal) or a "credit" (a payment to the card, a refund, a reversal, cashback).
A transaction's amount is the money it moved: usually the last amount on its line, never an amount in a foreign
currency (USD, EUR and so on) written in its description. Do not list totals, balances, credit limits, minimum dues,
offers or reward points.

Also give the id of the statement's previous balance (or opening balance) and of its total amount due (or closing
balance), if these lines print them; otherwise null.

Answer only with JSON in the given format, and use only ids that appear in these lines.

{lines}"""

SCHEMA = {
    "type": "object",
    "properties": {
        "rows": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "line": {"type": "string"},
                    "amount": {"type": "string"},
                    "direction": {"type": "string", "enum": ["debit", "credit"]},
                },
                "required": ["line", "amount", "direction"],
            },
        },
        "previous_balance": {"type": ["string", "null"]},
        "total_due": {"type": ["string", "null"]},
    },
    "required": ["rows", "previous_balance", "total_due"],
}


def _cache():
    return userdata.json_file("statement_ai.json", default=dict)


def _shown(t: sr.Tok) -> str:
    """An amount as the page prints it, its sign and marks included: the model judges debit or credit by them."""
    text = t.text
    if t.lead_c:
        text = f"C {text}"
    if t.sign == "()":
        text = f"({text})"
    elif t.sign:
        text = f"{t.sign} {text}"
    return f"{text} {t.mark.upper()}" if t.mark and not text.lower().endswith(t.mark) else text


@dataclass
class Question:
    where: str  # page and first line, for the cache
    entries: list[tuple[int, str]]  # the statement's line, and how it's shown (amounts tagged)

    @property
    def text(self) -> str:
        return "\n".join(f"L{k}: {t}" for k, (_, t) in enumerate(self.entries, 1))

    @property
    def lines(self) -> dict[str, int]:  # "L3" → the statement's line
        return {f"L{k}": i for k, (i, _) in enumerate(self.entries, 1)}

    @property
    def rows(self) -> int:  # how many of its lines carry an amount: what an answer can be about
        return sum(1 for _, t in self.entries if "[m" in t)

    def halves(self) -> list["Question"]:
        mid = len(self.entries) // 2
        return [Question(f"{self.where}a", self.entries[:mid]), Question(f"{self.where}b", self.entries[mid:])]


def _tag(st: rd.Statement) -> tuple[list[Question], dict[str, tuple[sr.Tok, int]]]:
    """The questions to ask, about 20 lines at a time from each page, leaving out the parts the rules already know hold
    no transactions (an EMI schedule, the terms); and every amount's token and line."""
    money: dict[str, tuple[sr.Tok, int]] = {}
    aside = sr.not_transactions(st.lines)
    pages: dict[int, list[tuple[int, str]]] = {}
    for i, ln in enumerate(st.lines):
        if aside[i]:
            continue
        parts = []
        for t in sr.tokens(ln):
            if t.kind == "money":
                tag = f"m{len(money) + 1}"
                money[tag] = (t, i)
                parts.append(f"{_shown(t)}[{tag}]")
            else:
                parts.append(t.text)
        pages.setdefault(ln.page, []).append((i, " ".join(parts)))
    questions = []
    for page, lines in sorted(pages.items()):
        for start in range(0, max(1, len(lines) - OVERLAP), CHUNK - OVERLAP):
            chunk = lines[start:start + CHUNK]
            if any("[m" in text for _, text in chunk):
                questions.append(Question(f"{page}:{start}", chunk))
    return questions, money


async def resolve(path: Path, rec: UploadRecord, held: CardStatement | None,
                  on_progress: Callable[[int, int], None] | None = None) -> ParseResult | None:
    """Ask the local AI to read a statement the rules couldn't prove (`held`, on hold) or couldn't read at all (None).
    Returns its statement proven or agreed, a reading on hold when the rules had none, or None when nothing changed.
    Raises LLMUnavailable when there's no local AI to ask."""
    from app.llm import llm

    st = rd.read(path, rec.detection)
    if held is not None and held.pages:  # one statement of a file that holds several: its own pages
        st = rd.part_of(st, held.pages)
    statement_id = held.id if held is not None else rec.id
    questions, money = _tag(st)
    if not questions:
        return held
    if len(questions) > (CHECKED_PARTS if _checkable(st.summary) else UNCHECKED_PARTS):
        log.info("not asking the local AI about %s: %d parts is too long to wait for%s; it stays on hold for you", statement_id,
                 len(questions), "" if _checkable(st.summary) else " with no figures to check its reading by")
        return None
    cache = _cache().read()
    answers: list[tuple[Question, dict]] = []
    gaps = 0
    async with llm.session() as ai:

        async def ask(q: Question, part: str) -> dict | None:
            key = f"{rec.sha256}:{llm.model}:{PROMPT_VERSION}:{q.where}"
            if key in cache:
                return cache[key]
            try:
                raw = await ai.chat([{"role": "user", "content": PROMPT.format(lines=q.text)}], schema=SCHEMA, context=4096,
                                    limit=150 + 50 * q.rows, timeout=180, purpose=f"read {part} of a statement")
                cache[key] = json.loads(raw)
            except (httpx.HTTPError, ValueError) as exc:  # no answer, or one that ran on
                log.warning("the local AI couldn't answer %s (%s)", part, type(exc).__name__)
                return None
            _cache().update(lambda all_: {**all_, key: cache[key]})
            return cache[key]

        for n, q in enumerate(questions, 1):
            if on_progress:
                on_progress(n, len(questions))
            part = f"part {n} of {len(questions)}"
            answer = await ask(q, part)
            if answer is not None:
                answers.append((q, answer))
                continue
            for half, name in zip(q.halves(), ("first", "second")):  # a shorter question, once
                answer = await ask(half, f"the {name} half of {part}")
                if answer is None:
                    gaps += 1
                else:
                    answers.append((half, answer))
    if gaps:
        log.warning("%d part(s) of %d left unanswered: the local AI's reading is incomplete, so it can't prove anything", gaps, len(questions))

    rows, invented = _rows(st, answers, money)
    if invented:
        log.warning("the local AI pointed at %d amount(s) that aren't transactions (not on the page, or the statement's own "
                    "figures): left out", invented)
    summary = st.summary
    if summary.previous_balance is None or summary.total_due is None:  # the rules didn't find the figures: the AI's picks
        picked = {k: next((money[a[k]][0] for _, a in answers if isinstance(a.get(k), str) and a[k] in money), None)
                  for k in ("previous_balance", "total_due")}
        figure = lambda t: None if t is None else (-t.value if t.mark == "cr" or t.sign in ("-", "()") else t.value)  # noqa: E731
        summary = cs.Summary(previous_balance=summary.previous_balance if summary.previous_balance is not None else figure(picked["previous_balance"]),
                             total_due=summary.total_due if summary.total_due is not None else figure(picked["total_due"]),
                             minimum_due=summary.minimum_due, credit_limit=summary.credit_limit,
                             statement_date=summary.statement_date, due_date=summary.due_date, period=summary.period,
                             printed_debits=summary.printed_debits, printed_credits=summary.printed_credits)

    decision = rd.decide([rd.Reading("ai", rows)], summary, st.anchor, st.period)
    if decision.status == "proven":
        decision.proof = f"read by the local AI; {decision.proof}"
        result = rd.finish(st, decision, statement_id, summary)
        if held is not None and result.statement is not None:
            result.statement.pages = held.pages
        result.notes.append("Read by the local AI, and proven by the statement's own figures ✓")
        return result
    if held is not None:
        mine = sorted((t.at.date(), round(t.amount, 2), t.direction == "credit") for t in held.held)
        theirs = sorted((c.day, round(c.amount, 2), cr) for c, cr in zip(decision.rows, decision.credits))
        if not _checkable(st.summary) and mine and mine == theirs:  # with figures printed, only proof counts
            agreed = held.model_copy(update={
                "status": "agreed", "held": [],
                "proof": "nothing on it to check its rows against, but the rules and the local AI read the same rows"})
            return ParseResult(method=st.method, transactions=held.held, statement=agreed,
                               notes=["The rules and the local AI read the same rows ✓"])
        log.info("the local AI's reading of %s isn't proven either: it stays on hold", statement_id)
        return None
    if decision.rows:  # the rules found nothing; the AI did, unproven
        decision.status = "on_hold"
        decision.proof = (f"read by the local AI, but {decision.proof}" if _checkable(summary)
                          else "read by the local AI, with nothing on the statement to prove its reading")
        return rd.finish(st, decision, statement_id, summary)
    return None


def _rows(st: rd.Statement, answers: list[tuple[Question, dict]], money: dict) -> tuple[list[rd.Candidate], int]:
    """The AI's rows, from the lines and amounts it pointed at. Its date is the one printed at the start of its line (or
    anywhere on it), or, when its line has none, on the line just above (a wrapped row). An id that isn't in the question, an amount that isn't on or beside its line,
    or an amount listed twice, is left out."""
    out, used, invented = [], set(), 0
    for q, answer in answers:
        for row in answer.get("rows") or []:
            line, m, direction = q.lines.get(row.get("line") or ""), row.get("amount"), row.get("direction")
            if line is None or m not in money or direction not in ("debit", "credit") or abs(money[m][1] - line) > 1:
                invented += 1
                continue
            if m in used or not money[m][0].value:
                continue
            if cs._SUMMARY_ROW.search(st.lines[money[m][1]].text):
                invented += 1  # the statement's own figure ("Total Amount Due"), never a transaction
                continue
            day = None
            for k in (line, line - 1, line - 2):
                if k >= 0 and st.lines[k].page == st.lines[line].page and not cs._SUMMARY_ROW.search(st.lines[k].text):
                    toks = sr.tokens(st.lines[k])
                    start = sr._row_start(toks)
                    if start is None:  # a date later in the line ("FAKE SHOP on 12/08/2026")
                        start = next((j for j, t in enumerate(toks) if t.kind == "date"), None)
                    if start is not None:
                        day, day_line, words = toks[start], k, toks[start + 1:]
                        break
            if day is None:
                invented += 1
                continue
            used.add(m)
            clock = next((t.text for t in words if t.kind == "time"), "")
            before = [t for t in sr.tokens(st.lines[day_line]) if t.x1 <= day.x0 and t.kind == "text"]
            description = " ".join(t.text for t in before) or sr._describe(words)
            if money[m][1] != day_line:
                description = f"{description} {' '.join(t.text for t in sr.tokens(st.lines[money[m][1]]) if t.kind == 'text')}".strip()
            ln = st.lines[money[m][1]]
            out.append(rd.Candidate(day.day, day.year_printed, clock, description or "Card transaction", "",  # type: ignore[arg-type]
                                    money[m][0].value, mark="cr" if direction == "credit" else "dr", last4=st.primary,
                                    page=ln.page, y=ln.y, line=money[m][1]))
    return out, invented
