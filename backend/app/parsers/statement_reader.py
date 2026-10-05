"""Reading a credit card statement so that its numbers are right, whatever the bank, layout or period.

Several readings of the rows compete: the table reader (by its header, card_statement.read_rows) and the shape reader
(by where dates and amounts line up, app/parsers/shape_reader.py), each under every meaning a statement could give its
marks (does "+" mark a credit or a debit? is a lone "C" the rupee sign or a credit? are credits told apart only by
what they say?). The statement's own arithmetic decides:

  - a statement's figures: previous balance − credits + debits = total due (an export's opening and closing balance
    work the same way);
  - its printed totals of debits and of credits, each to the paisa, when it prints no balances (a year's summary);
  - a running balance: each row's balance moves from the one before by exactly its amount.

A reading is **proven** when exactly one set of rows passes. Anything else is **on hold**: kept, shown, and not counted
until you confirm it (or the local AI's reading, checked the same way, proves it). Nothing here invents a figure;
every amount is one the statement prints.
"""

import calendar
import re
from collections import Counter
from dataclasses import dataclass, field, replace
from datetime import date, datetime, timedelta
from itertools import product
from pathlib import Path

import pymupdf

from app.ingest.issuers import detect_issuer
from app.models import CardRef, CardStatement, Detection
from app.parsers import ParseError, ParseResult
from app.parsers import card_statement as cs
from app.parsers import shape_reader as sr

EXACT = 0.005  # rupees: the rows account for the figures to the paisa


def rounding(total_due: float) -> float:
    """How far rows may miss a total due: to the paisa, unless the bank printed the total in whole rupees (rounded,
    so up to 50 paise either way). A rupee off is a misread figure, never rounding."""
    return 0.5 + EXACT if abs(total_due - round(total_due)) < EXACT else EXACT

_CREDIT_WORDS = re.compile(cs._PAYMENT.pattern + "|" + cs._CASHBACK.pattern + r"|\brefund|\breversal|\breversed|\brev\b",
                           re.IGNORECASE)


@dataclass
class Candidate:
    """One row of one reading, with everything that might say whether it's a debit or a credit."""

    day: date
    year_printed: bool
    clock: str
    description: str
    category: str
    amount: float
    mark: str = ""  # "cr" / "dr" printed with the amount, or in a marks column
    sign: str = ""  # "+", "-", "()"
    lead_c: bool = False
    column: str = ""  # "cr" / "dr": which of separate debit and credit columns it sits in
    section_credit: bool = False
    balance: float | None = None
    last4: str | None = None
    page: int = 0
    y: float = 0.0
    line: int = -1
    rightmost: bool = True  # its amount is the last figure on its row, where statements print the amount


@dataclass
class Reading:
    name: str
    rows: list[Candidate]
    unread: list[str] = field(default_factory=list)
    from_table: bool = False


@dataclass(frozen=True)
class Convention:
    """What a statement's marks mean. "credit": a sign marks a credit (+ or −, or brackets); "plus-credit": + is a
    credit, − a debit; "plus-debit": + is a debit, − a credit. `lead_c`: a lone C before an amount marks a credit
    (else it's the rupee sign). `words`: an unmarked row that says payment, refund or cashback is a credit."""

    signs: str = "credit"
    lead_c: bool = False
    words: bool = False


def is_credit(c: Candidate, conv: Convention) -> bool:
    if c.mark == "dr" or c.column == "dr":
        return False
    if c.mark == "cr" or c.column == "cr" or c.section_credit:
        return True
    if c.sign:
        negative = c.sign in ("-", "()")
        return {"credit": True, "plus-credit": not negative, "plus-debit": negative}[conv.signs]
    if c.lead_c and conv.lead_c:
        return True
    return conv.words and bool(_CREDIT_WORDS.search(c.description))


def conventions(rows: list[Candidate]) -> list[Convention]:
    """Only the meanings that change something for these rows."""
    signs = ["credit", "plus-credit", "plus-debit"] if any(c.sign for c in rows) else ["credit"]
    lead = [False, True] if any(c.lead_c for c in rows) else [False]
    unmarked = [c for c in rows if not (c.mark or c.column or c.section_credit or c.sign)]
    words = [False, True] if unmarked and any(_CREDIT_WORDS.search(c.description) for c in unmarked) else [False]
    return [Convention(s, lc, w) for s, lc, w in product(signs, lead, words)]


# ---- the readings -------------------------------------------------------------------------------------------------


def table_reading(lines: list[cs.Line], default_year: int | None, primary: str | None) -> Reading:
    rows, from_table, unread = cs.read_rows(lines, default_year, primary)
    out = []
    for r in rows:
        assert r.amount is not None
        mark = r.amount.mark if r.amount.mark in ("cr", "dr") else ""
        sign = r.amount.mark if r.amount.mark in ("+", "-") else ""
        out.append(Candidate(r.day, r.year_printed, r.clock, r.description, " ".join(r.category).strip(), r.amount.value,
                             mark=mark, sign=sign, section_credit=r.credit_section, last4=r.last4, page=r.page, y=r.y))
    return Reading("table", out, unread, from_table)


def shape_readings(lines: list[cs.Line], primary: str | None) -> list[Reading]:
    rows, _ = sr.find_rows(lines, primary)
    rows = [r for r in rows if not r.after_terms]
    if not rows:
        return []
    columns = sr.money_columns(rows)
    # A lone C or D in a column after the amount marks a credit or a debit, or it's a column of something else (which
    # card or instrument paid): both are read, and the arithmetic picks.
    marks_column = [True, False] if any(r.marks for r in rows) else [True]
    out = []
    for layout in sr.layouts(rows, columns):
        for use_marks in marks_column:
            cands, unread = [], []
            for r in rows:
                tok, column, balance = sr.amount_of(r, layout)
                if tok is None or not tok.value:
                    if r.amounts:
                        unread.append(f"{r.day:%d/%m/%Y} {r.description}".strip())
                    continue
                mark = tok.mark or (r.marks[0] if use_marks and r.marks and r.marks[0] in ("cr", "dr") else "")
                bal = None
                if balance is not None and balance.value is not None:
                    bal = -balance.value if (balance.mark == "cr" or balance.sign in ("-", "()")) else balance.value
                others = [t for t in r.amounts if t is not tok and t is not balance]
                cands.append(Candidate(r.day, r.year_printed, r.clock, r.description, "", tok.value,  # type: ignore[arg-type]
                                       mark=mark, sign=tok.sign, lead_c=tok.lead_c, column=column,
                                       section_credit=r.credit_section, balance=bal, last4=r.last4, page=r.page, y=r.y,
                                       line=r.line, rightmost=all(t.x1 <= tok.x1 + 1 for t in others)))
            out.append(Reading(f"shape:{layout.name}{'' if use_marks else ' (its C/D column not marks)'}", cands, unread))
    return out


# ---- deciding -----------------------------------------------------------------------------------------------------


@dataclass
class Decision:
    status: str  # "proven" or "on_hold"
    rows: list[Candidate]
    credits: list[bool]
    reading: Reading | None
    proof: str  # how it was proven, or why it wasn't, in words
    difference: float | None = None
    aside: list[str] = field(default_factory=list)  # rows set aside: dated outside the statement's period
    # A summary of several statements that lists more than their cycles hold: the rows its totals prove are `rows`;
    # these are the others (dated before the first cycle or after the last), held: no figure on it covers them
    beyond: list[Candidate] = field(default_factory=list)
    beyond_credits: list[bool] = field(default_factory=list)
    span: tuple[date, date] | None = None  # the cycles its totals cover


def _key(rows: list[Candidate], credits: list[bool]) -> tuple:
    return tuple(sorted((c.day, round(c.amount, 2), cr) for c, cr in zip(rows, credits)))


def place_in_time(rows: list[Candidate], anchor: date | None, period: tuple[date, date] | None) -> tuple[list[Candidate], list[str]]:
    """Years for dates printed without one, and rows dated far outside the statement's period set aside (a worked
    example in the terms isn't a purchase)."""
    placed = []
    for c in rows:
        if not c.year_printed and anchor:
            try:
                day = c.day.replace(year=anchor.year)
                if day > anchor + timedelta(days=5):
                    day = day.replace(year=anchor.year - 1)  # December's purchases on January's statement
            except ValueError:  # 29 February in a year without one
                continue
            c = replace(c, day=day)
        placed.append(c)
    if anchor or period:
        end = anchor or (period[1] if period else None)
        start = (period[0] if period else end - timedelta(days=31)) - cs.OUTSIDE_PERIOD  # type: ignore[operator]
        inside = [c for c in placed if start <= c.day <= end + timedelta(days=7)]  # type: ignore[operator]
        if len(inside) >= len(placed) / 2:
            return inside, [f"{c.day:%d/%m/%Y} {c.description} (dated outside this statement's period)" for c in placed if c not in inside]
    else:  # no period: a row years away from the rest is an example, not a purchase
        if placed:
            days = sorted(c.day for c in placed)
            middle = days[len(days) // 2]
            inside = [c for c in placed if abs((c.day - middle).days) <= 400]
            return inside, [f"{c.day:%d/%m/%Y} {c.description} (far from the other rows)" for c in placed if c not in inside]
    return placed, []


def _balance_proof(rows: list[Candidate], opening: float | None) -> list[bool] | None:
    """Directions proven by a running balance: each row's balance moves by exactly its amount, in the order printed
    (oldest or newest first). The balance is what's owed (debits raise it) or what's available (they lower it); the
    rows' own marks and words pick which, and an opening balance proves the first row too."""
    if len(rows) < 2 or any(c.balance is None for c in rows):
        return None
    for newest_first in (False, True):
        seq = rows[::-1] if newest_first else rows
        moves = [round(seq[i].balance - seq[i - 1].balance, 2) for i in range(1, len(seq))]  # type: ignore[operator]
        if not all(abs(abs(m) - seq[i].amount) <= EXACT for i, m in enumerate(moves, 1)):
            continue
        first: float | None = None
        if opening is not None:
            first = round(seq[0].balance - opening, 2)  # type: ignore[operator]
            if abs(abs(first) - seq[0].amount) > EXACT:
                continue
        best = None
        for owed in (True, False):  # debits raise what's owed / lower what's available
            ups = [None if first is None else first > 0] + [m > 0 for m in moves]
            credits = [None if up is None else (up != owed) for up in ups]
            if credits[0] is None:  # no opening balance: the first row's own marks or words decide, else it can't be proven
                c0 = seq[0]
                evidence = c0.mark or c0.column or c0.sign or c0.section_credit or _CREDIT_WORDS.search(c0.description)
                if not evidence:
                    continue
                credits[0] = is_credit(c0, Convention(words=True))
            agree = sum(1 for c, cr in zip(seq, credits) if (c.mark or c.column or c.sign or _CREDIT_WORDS.search(c.description))
                        and is_credit(c, Convention(words=True)) == cr)
            if best is None or agree > best[0]:
                best = (agree, credits)
        if best is not None:
            credits = best[1]
            return credits[::-1] if newest_first else credits  # type: ignore[return-value]
    return None


def _plausible(rows: list[Candidate], credits: list[bool]) -> int:
    """How many rows' direction agrees with what they say: a payment, refund or cashback a credit, anything else a debit."""
    return sum(1 for c, cr in zip(rows, credits) if bool(_CREDIT_WORDS.search(c.description)) == cr)


def covered(summary: cs.Summary) -> tuple[date, date] | None:
    """The days a summary of several statements covers: from the day after the statement before its first, to the
    date of its last ("MAY-2025 … MAR-2026", each dated the 1st: 2 Apr 2025 – 1 Mar 2026)."""
    if not summary.months or not summary.statement_day:
        return None

    def dated(month: date) -> date:
        return month.replace(day=min(summary.statement_day, calendar.monthrange(month.year, month.month)[1]))  # type: ignore[arg-type]

    before = (summary.months[0].month - timedelta(days=1)).replace(day=1)
    return dated(before) + timedelta(days=1), dated(summary.months[-1].month)


def _by_cycles(options: list, printed: tuple[float, float], span: tuple[date, date], months: int) -> Decision | None:
    """A summary of several statements whose list runs past their cycles (a year's file listing the year, its
    totals the statements dated in it): the rows within the cycles must come to its totals, debits and credits, to the
    paisa; a few days of give at either end (a purchase made on the statement date can post in the next)."""
    fits = []
    for a, b in product(range(-3, 4), repeat=2):
        start, end = span[0] + timedelta(days=a), span[1] + timedelta(days=b)
        for o in options:
            inside = [k for k, c in enumerate(o[2]) if start <= c.day <= end]
            debits = sum(o[2][k].amount for k in inside if not o[3][k])
            credits = sum(o[2][k].amount for k in inside if o[3][k])
            if abs(debits - printed[0]) <= EXACT and abs(credits - printed[1]) <= EXACT:
                fits.append((o, inside, (start, end)))
    keys = {(_key([f[0][2][k] for k in f[1]], [f[0][3][k] for k in f[1]]), _key([c for k, c in enumerate(f[0][2]) if k not in f[1]],
             [cr for k, cr in enumerate(f[0][3]) if k not in f[1]])) for f in fits}
    if not fits and options:  # say what was compared, over which days: the cause is then plain to see
        def off(o) -> tuple[float, float, list[int]]:
            inside = [k for k, c in enumerate(o[2]) if span[0] <= c.day <= span[1]]
            return (round(sum(o[2][k].amount for k in inside if not o[3][k]), 2), round(sum(o[2][k].amount for k in inside if o[3][k]), 2), inside)

        o = min(options, key=lambda o: max(abs(off(o)[0] - printed[0]), abs(off(o)[1] - printed[1])))
        debits, credits, inside = off(o)
        outside = [k for k in range(len(o[2])) if k not in inside]
        return Decision("on_hold", [o[2][k] for k in inside], [o[3][k] for k in inside], o[0],
                        f"within the cycles of the {months} statements it sums up ({span[0]:%-d %b %Y} – {span[1]:%-d %b %Y}) its rows "
                        f"come to debits ₹{debits:,.2f} and credits ₹{credits:,.2f}, and its totals are ₹{printed[0]:,.2f} and "
                        f"₹{printed[1]:,.2f}", round(debits - printed[0], 2), o[4],
                        beyond=[o[2][k] for k in outside], beyond_credits=[o[3][k] for k in outside], span=span)
    if len(keys) != 1:
        return None
    o, inside, window = min(fits, key=lambda f: (f[0][0].name != "table", f[0][1] != Convention(), abs((f[2][0] - span[0]).days) + abs((f[2][1] - span[1]).days)))
    outside = [k for k in range(len(o[2])) if k not in inside]
    return Decision("proven", [o[2][k] for k in inside], [o[3][k] for k in inside], o[0],
                    f"its rows from {window[0]:%-d %b %Y} to {window[1]:%-d %b %Y}, the cycles of the {months} statements it sums up, "
                    "come to their totals of debits and of credits, to the paisa", 0.0, o[4],
                    beyond=[o[2][k] for k in outside], beyond_credits=[o[3][k] for k in outside], span=window)


def decide(readings: list[Reading], summary: cs.Summary, anchor: date | None, period: tuple[date, date] | None) -> Decision:
    options: list[tuple[Reading, Convention, list[Candidate], list[bool], list[str]]] = []
    for reading in readings:
        rows, aside = place_in_time(reading.rows, anchor, period)
        for conv in conventions(rows):
            options.append((reading, conv, rows, [is_credit(c, conv) for c in rows], aside))
    span = covered(summary)
    if span and summary.printed_debits is not None and summary.printed_credits is not None \
            and (summary.previous_balance is None or summary.total_due is None):
        if decided := _by_cycles(options, (summary.printed_debits, summary.printed_credits), span, len(summary.months)):
            return decided

    def sums(o) -> tuple[float, float]:  # its debits and its credits
        return (sum(c.amount for c, cr in zip(o[2], o[3]) if not cr), sum(c.amount for c, cr in zip(o[2], o[3]) if cr))

    prev, due = summary.previous_balance, summary.total_due
    printed = (summary.printed_debits, summary.printed_credits)
    checks: list[tuple[str, float, object]] = []  # what proves a reading: how it's said, how close it must come, how far it is
    if prev is not None and due is not None:
        def diff(o) -> float:
            debits, credit = sums(o)
            return round(due - (prev - credit + debits), 2)

        checks = [(f"previous balance − credits + debits = total due, {how}", limit, diff)
                  for limit, how in ((EXACT, "to the paisa"), (rounding(due), "within the rupee the bank rounded its total to"))]
        against = "the statement's total due"
    elif printed[0] is not None and printed[1] is not None:  # no balances: its totals of debits and of credits, both
        def diff(o) -> float:
            debits, credit = sums(o)
            off = (round(debits - printed[0], 2), round(credit - printed[1], 2))  # type: ignore[operator]
            return off[0] if abs(off[0]) >= abs(off[1]) else off[1]

        checks = [("its debits and its credits are the statement's own totals of them, to the paisa", EXACT, diff)]
        against = "the statement's totals of debits and credits"
    for how, limit, measure in checks:
        fits = [o for o in options if abs(measure(o)) <= limit]  # type: ignore[operator]
        keys = {_key(o[2], o[3]) for o in fits}
        if len(keys) == 1:
            best = min(fits, key=lambda o: (o[0].name != "table", o[1] != Convention()))
            return Decision("proven", best[2], best[3], best[0], how, measure(best), best[4])  # type: ignore[operator]
        if len(keys) > 1:
            near = min(fits, key=lambda o: (o[0].name != "table", o[1] != Convention()))
            return Decision("on_hold", near[2], near[3], near[0],
                            f"{len(keys)} different sets of rows each add up to {against}; which is right needs a look",
                            measure(near), near[4])  # type: ignore[operator]

    for reading in readings:  # a running balance proves its rows by itself
        rows, aside = place_in_time(reading.rows, anchor, period)
        credits = _balance_proof(rows, summary.previous_balance)
        if credits is not None:
            return Decision("proven", rows, credits, reading, "every row moves the running balance by exactly its amount", aside=aside)

    if not options:
        return Decision("on_hold", [], [], None, "no rows found")
    if checks:
        measure = checks[0][2]
        near = min(options, key=lambda o: (abs(measure(o)), o[0].name != "table", o[1] != Convention()))  # type: ignore[operator]
        return Decision("on_hold", near[2], near[3], near[0], f"no reading of the rows adds up to {against}",
                        measure(near), near[4])  # type: ignore[operator]
    # Nothing to check the rows against. Hold the most likely reading: the most rows, and the meaning of the marks
    # under which payments, refunds and cashback are the credits and purchases the debits.
    # The shape reader's, on a tie: it knows where the amounts line up, the table reader takes a line's last figure.
    best = min(options, key=lambda o: (-len(o[2]), -_plausible(o[2], o[3]), -sum(c.rightmost for c in o[2]),
                                       o[0].name == "table", o[1] != Convention()))
    return Decision("on_hold", best[2], best[3], best[0], "it prints no totals or running balance to check its rows against",
                    aside=best[4])


# ---- the whole statement ------------------------------------------------------------------------------------------


@dataclass
class Statement:
    """A statement file as read: its lines, its own figures, and what's known of its card and period."""

    lines: list[cs.Line]
    method: str
    summary: cs.Summary
    issuer: str | None
    card: CardRef | None
    primary: str | None
    period: tuple[date, date] | None
    anchor: date | None


def read(path: Path, detection: Detection) -> Statement:
    with pymupdf.open(path) as doc:
        lines, method = cs.read_lines(doc)
    if not lines:
        raise ParseError("This statement has no readable text")
    summary = cs.read_summary(lines)
    card = (detection.cards or [None])[0]
    issuer = (card.issuer if card else None) or detection.source or detect_issuer(" ".join(ln.text for ln in lines[:80]))
    period = summary.period or cs._period_from(detection)
    return Statement(lines, method, summary, issuer, card, card.last4 if card else None, period, _anchor(summary, period))


def _anchor(summary: cs.Summary, period: tuple[date, date] | None) -> date | None:
    """The day the statement's rows end by, for the years of dates printed without one: its date, the end of its
    period, or, when it prints neither, its due date (a few weeks after: no row is dated past it)."""
    return summary.statement_date or (period[1] if period else None) or summary.due_date


NOTHING_FOUND = ("No transactions found in this statement. If it has some, run `make inspect` on it and share the masked output "
                 "so the reader can learn its layout.")


def segments(st: Statement) -> list[Statement]:
    """A file of several statements (a year's download): split where a statement's own summary begins, a page with a
    date (the statement's, or its due date when it prints none) and a total due of its own. Pages that repeat one
    statement's date in their headers stay together."""
    pages = sorted({ln.page for ln in st.lines})
    starts, seen = [], set()
    for page in pages:
        s = cs.read_summary([ln for ln in st.lines if ln.page == page])
        day = s.statement_date or s.due_date
        if day and s.total_due is not None and day not in seen:
            starts.append(page)
            seen.add(day)
    if len(starts) < 2:
        return [st]
    out = []
    for k, page in enumerate(starts):
        first = page if k else pages[0]
        end = starts[k + 1] if k + 1 < len(starts) else pages[-1] + 1
        out.append(part_of(st, list(range(first + 1, end + 1))))
    return out


def part_of(st: Statement, pages: list[int]) -> Statement:
    """One statement of a file that holds several: its pages (numbered from 1), with its own figures."""
    lines = [ln for ln in st.lines if ln.page + 1 in pages]
    summary = cs.read_summary(lines)
    return replace(st, lines=lines, summary=summary, period=summary.period, anchor=_anchor(summary, summary.period))


def readings_of(st: Statement) -> list[Reading]:
    return [table_reading(st.lines, st.anchor.year if st.anchor else None, st.primary), *shape_readings(st.lines, st.primary)]


def parse(path: Path, upload_id: str, detection: Detection) -> ParseResult:
    st = read(path, detection)
    parts = segments(st)
    results = []
    decided = []
    for part in parts:
        decision = decide(readings_of(part), part.summary, part.anchor, part.period)
        if not decision.rows:
            # Nothing read. Equal balances don't prove a quiet month: payments can match purchases to the paisa in a
            # table that wasn't read, so this is never taken as proof of no transactions.
            continue
        decided.append((part, decision))
        if decision.beyond and decision.span:  # what its statements' totals don't cover: a part of its own, held
            span = decision.span
            outside = Decision("on_hold", decision.beyond, decision.beyond_credits, decision.reading,
                               f"dated outside the cycles of the statements this file sums up ({span[0]:%-d %b %Y} – "
                               f"{span[1]:%-d %b %Y}), so none of its figures covers them. Adding the statement for those dates "
                               "proves them; or check them and count them")
            days = [c.day for c in decision.beyond]
            decided.append((replace(part, summary=cs.Summary(), period=(min(days), max(days)), anchor=max(days)), outside))
            decided[-2] = (replace(part, period=span, anchor=span[1]), decision)
    many = len(decided) > 1
    for k, (part, decision) in enumerate(decided, 1):
        result = finish(part, decision, f"{upload_id}~{k}" if many else upload_id)
        assert result.statement is not None
        if many:
            result.statement.pages = sorted({ln.page + 1 for ln in part.lines})
        result.statement.outside_cycles = decision.status == "on_hold" and decision.proof.startswith("dated outside the cycles")
        results.append(result)
    if not results:
        raise ParseError(NOTHING_FOUND)
    if len(results) == 1:
        return results[0]
    whole = ParseResult(method=st.method, transactions=[t for r in results for t in r.transactions])
    whole.statement, whole.more_statements = results[0].statement, [r.statement for r in results[1:] if r.statement]
    whole.notes = [f"{len(results)} statements in this file, each checked against its own figures" if len(parts) > 1 else
                   "A summary of several statements: the rows its figures cover, and the rows outside them"]
    for r in results:
        whole.notes += r.notes
        whole.warnings += r.warnings
    return whole


def finish(st: Statement, decision: Decision, upload_id: str, summary: cs.Summary | None = None) -> ParseResult:
    """The transactions and the statement's record, from a decision about its rows."""
    summary = summary or st.summary
    period = st.period
    if decision.rows and not period:  # the span its rows cover, to its date when it prints one
        period = (min(c.day for c in decision.rows), summary.statement_date or max(c.day for c in decision.rows))
    last4s = [c.last4 for c in decision.rows if c.last4]
    primary = st.primary or (Counter(last4s).most_common(1)[0][0] if last4s else None)
    if primary:
        from app import vault

        vault.register_cards([CardRef(issuer=st.issuer, product=st.card.product if st.card else None, last4=primary,
                                      network=st.card.network if st.card else None)], upload_id)

    rows = [cs.Row(c.day, c.clock, [c.description], [c.category] if c.category else [],
                   cs.Amount(c.amount, "cr" if credit else "dr", 0.0, 0), False, c.last4, c.page, c.y)
            for c, credit in zip(decision.rows, decision.credits)]
    result = cs._build(rows, upload_id, st.issuer, primary, period, summary, st.method, signs_mark_credits=True)
    statement = result.statement
    assert statement is not None
    statement.status = decision.status  # type: ignore[assignment]
    statement.proof = decision.proof
    statement.unread = ((decision.reading.unread if decision.reading else []) + decision.aside)[:30]
    if summary.statement_date is None and summary.due_date is None:
        # no statement date or due date: the bank's list of the card's transactions over a span, not a statement
        statement.kind, statement.statement_date = "export", None
    if decision.status == "proven" and "running balance" in decision.proof:
        result.notes.append("Adds up: every row moves the running balance by exactly its amount ✓")
    from_table = bool(decision.reading and decision.reading.from_table)
    cs._describe(statement, result, from_table or bool(decision.reading and decision.reading.name.startswith(("shape", "ai"))))
    if decision.status == "on_hold":
        result.warnings.append(f"On hold, not counted yet: {decision.proof}. Check it in Your vault.")
        statement.held, result.transactions = result.transactions, []  # read, shown, not counted until you confirm it
    return result


def rebuild(s: CardStatement, rows: list[tuple[datetime, float, bool, str, int]]) -> CardStatement:
    """A held statement with its rows as you corrected them (when, amount, credit, description, page): the check
    against its figures worked out again. It stays on hold until you confirm it."""
    def day(iso: str | None) -> date | None:
        return date.fromisoformat(iso) if iso else None

    summary = cs.Summary(previous_balance=s.previous_balance, total_due=s.total_due, minimum_due=s.minimum_due,
                         credit_limit=s.credit_limit, statement_date=day(s.statement_date), due_date=day(s.due_date),
                         printed_debits=s.printed_debits, printed_credits=s.printed_credits)
    period = (date.fromisoformat(s.period_start), date.fromisoformat(s.period_end)) if s.period_start and s.period_end else None
    built = cs._build([cs.Row(at.date(), at.strftime("%H:%M") if (at.hour or at.minute) else "", [desc], [],
                              cs.Amount(amount, "cr" if credit else "dr", 0.0, 0), False, s.last4, max(0, page - 1), 0.0)
                       for at, amount, credit, desc, page in rows], s.id, s.issuer, s.last4, period, summary, "text", True)
    out = built.statement
    assert out is not None
    out.kind, out.statement_date, out.card = s.kind, s.statement_date, s.card
    out.status, out.proof, out.unread, out.edited = "on_hold", s.proof, s.unread, True
    out.held = built.transactions
    return out

