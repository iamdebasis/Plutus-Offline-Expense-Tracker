"""A statement's transactions found by their shape, whatever the bank, wording or layout. Headers and wording are
hints, never requirements.

  tokens   Every printed word, typed: a date, a time, an amount of money, a plain number, or text. Dates and amounts
           are found however a bank prints them: glued to a time or a separator ("12/08/2026|14:05"), with any form of
           the rupee sign ("₹1,234.50", "Rs. 1,234.50", "` 1,234.50", "C 1,234.50" from fonts that draw ₹ as a letter),
           with a sign or a mark ("+ 1,234.50", "(1,234.50)", "1,234.50Cr").
  rows     A line with a date at its start and an amount after it. The text between is its description; lines below
           that start in the description continue it; a time alone below the date is its time.
  columns  Where amounts line up. A table's amounts share a right edge; an amount inside a description ("USD 12.99")
           doesn't. With two amount columns, rows use one or the other (debits and credits) or both (an amount and a
           running balance).

Everything a statement could mean is offered as a reading (which column is the amount, what a sign or a lone "C"
says); the statement's own arithmetic picks between them (app/parsers/statement_reader.py). Nothing here invents a
figure: every amount is a token printed on the page.
"""

import re
from dataclasses import dataclass, field
from datetime import date

from app.parsers.card_statement import (
    _CARD_NO, _CREDIT_SECTION, _DEBIT_SECTION, _H_AMOUNT, _H_DATE, _H_DEBIT, _NOT_TRANSACTIONS, _REFERENCE, _SUMMARY_ROW, _TIME,
    Line, heading, in_terms, parse_date,
)

# Where a statement's transactions end and something else with dates and amounts begins: an EMI or loan schedule, a
# rewards summary, the terms. (Not "important messages": banks print those above the table too.)
_ELSEWHERE = re.compile(r"end of statement|\b(?:emi|loan)s? (?:summary|details|schedule)|reward points? (?:summary|account)|"
                        r"rewards? summary|summary of reward|terms (?:and|&) conditions|most important terms", re.IGNORECASE)

# ---- tokens -------------------------------------------------------------------------------------------------------


@dataclass
class Tok:
    kind: str  # "date", "time", "money", "number", "text"
    text: str
    x0: float
    x1: float
    day: date | None = None
    year_printed: bool = True
    value: float | None = None
    sign: str = ""  # "+", "-" or "()" printed with an amount
    mark: str = ""  # "cr" or "dr" printed with it
    lead_c: bool = False  # a lone "C" right before it: the ₹ sign in some fonts, or a credit mark


_MONEY = re.compile(
    r"^(?P<sign>[+\-])?(?P<cur>₹|`|rs\.?|inr)?(?P<sign2>[+\-])?(?P<open>\()?(?P<cur2>₹|`|rs\.?|inr)?"
    r"(?P<num>\d{1,3}(?:,\d{2,3})+\.\d{1,2}|\d+\.\d{1,2})(?P<close>\))?(?P<mark>cr|dr)?\.?$",
    re.IGNORECASE,
)
_CURRENCY = re.compile(r"^\(?(?:₹|`|rs\.?|inr)$", re.IGNORECASE)  # "(INR" opens a bracketed amount: "(INR 1,234.50)"
_MARK = re.compile(r"^\(?(cr|dr|c|d)\.?\)?$", re.IGNORECASE)
_NUMBER = re.compile(r"^[+\-]?(?:\d{1,3}(?:,\d{2,3})+|\d+)$")
_YEARLESS = re.compile(r"^(\d{1,2})[/\-](\d{1,2})$")  # "12/08": not "1.12", which is an amount
_SEPARATORS = re.compile(r"[|¦]")
# A time or date run into the next word where columns are tight: "11:22REVERSAL", "12/08/2026FAKE"
_GLUED = re.compile(r"^(\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4})([A-Za-z].*)$")


@dataclass
class _Piece:
    text: str
    x0: float
    x1: float


def _pieces(line: Line) -> list[_Piece]:
    """The line's words with separators ("|") cut out and a time or date split from a word it ran into:
    "12/08/2026|14:05" and "11:22REVERSAL" are two pieces each, placed where they sit in the word."""
    out: list[_Piece] = []
    for w in line.words:
        parts: list[str] = []
        for chunk in _SEPARATORS.split(w.text):
            m = _GLUED.match(chunk)
            parts += [m[1], m[2]] if m else [chunk]
        if len(parts) == 1:
            out.append(_Piece(w.text, w.x0, w.x1))
            continue
        total, pos = max(1, len(w.text)), 0
        for part in parts:
            at = w.text.find(part, pos) if part else pos
            at = pos if at < 0 else at
            if part.strip():
                out.append(_Piece(part.strip(), w.x0 + (w.x1 - w.x0) * at / total, w.x0 + (w.x1 - w.x0) * (at + len(part)) / total))
            pos = at + len(part)
    return out


def _close(a: _Piece, b: _Piece, height: float) -> bool:
    """Two pieces that belong together (a sign or ₹ before an amount, a Cr after it): a space apart, not a column."""
    return b.x0 - a.x1 <= max(2.6, 0.55 * height)


def tokens(line: Line) -> list[Tok]:
    pieces = _pieces(line)
    height = line.height if line.words else 8.0
    out: list[Tok] = []
    i = 0
    while i < len(pieces):
        p = pieces[i]
        # a date of up to three words: "12 Aug 2026", "Aug 12, 2026", "12-Aug-26", "12/08/2026"; or "12 Aug" or
        # "12/08" without a year (taken from the statement later)
        for n in (3, 2, 1):
            chunk = pieces[i:i + n]
            if len(chunk) < n or any(not _close(chunk[k], chunk[k + 1], height * 2) for k in range(n - 1)):
                continue
            text = " ".join(c.text for c in chunk)
            day, printed = parse_date(text), True
            if day is None:
                day, printed = parse_date(text, 2000), False
                if day is None and n == 1 and (m := _YEARLESS.match(text)):
                    try:
                        day = date(2000, int(m[2]), int(m[1]))
                    except ValueError:
                        day = None
            if day is not None and not (n == 1 and _NUMBER.match(text)):
                out.append(Tok("date", text, chunk[0].x0, chunk[-1].x1, day=day, year_printed=printed))
                i += n
                break
        else:
            if _TIME.match(p.text) and ":" in p.text:
                clock, j = p.text, i + 1
                if j < len(pieces) and re.fullmatch(r"am|pm", pieces[j].text, re.IGNORECASE):
                    clock, j = f"{clock} {pieces[j].text}", j + 1
                out.append(Tok("time", clock, p.x0, pieces[j - 1].x1))
                i = j
                continue
            if m := _MONEY.match(p.text):
                tok = Tok("money", p.text, p.x0, p.x1, value=float(m["num"].replace(",", "")))
                tok.sign = "()" if m["open"] and m["close"] else (m["sign"] or m["sign2"] or "")
                tok.mark = (m["mark"] or "").lower()
                opened = bool(m["open"])
                # what's printed just before it: a sign, the rupee sign, a lone "C" ("+ C 1,234.50"), each a space
                # from the next
                k, right = len(out) - 1, _Piece(p.text, p.x0, p.x1)
                while k >= 0 and out[k].kind == "text" and _close(left := _Piece(out[k].text, out[k].x0, out[k].x1), right, height):
                    before = out[k].text
                    if before in ("+", "-") and not tok.sign:
                        tok.sign = before
                    elif _CURRENCY.match(before) or before == "(":
                        opened = opened or before.startswith("(")
                    elif before.upper() in ("C", "(C") and not tok.lead_c:
                        tok.lead_c, opened = True, opened or before.startswith("(")
                    else:
                        break
                    tok.x0, right = out[k].x0, left
                    out.pop(k)
                    k -= 1
                if opened and not tok.sign and (m["close"] or (i + 1 < len(pieces) and pieces[i + 1].text == ")")):
                    tok.sign = "()"  # "(INR 1,234.50)", "( Rs. 1,234.50 )": the bracket opened before the currency
                    if not m["close"]:
                        tok.x1 = pieces[i + 1].x1
                        i += 1
                # a mark just after it: "Cr", "DR", "C", "D"
                if i + 1 < len(pieces) and (mk := _MARK.match(pieces[i + 1].text)) and _close(p, pieces[i + 1], height) and not tok.mark:
                    tok.mark = {"c": "cr", "d": "dr"}.get(mk[1].lower(), mk[1].lower())
                    tok.x1 = pieces[i + 1].x1
                    i += 1
                out.append(tok)
                i += 1
                continue
            kind = "number" if _NUMBER.match(p.text) else "text"
            out.append(Tok(kind, p.text, p.x0, p.x1))
            i += 1
    return out


# ---- rows ----------------------------------------------------------------------------------------------------------


@dataclass
class Shaped:
    """A row as found: its date, its description, and the amounts on its line (by column, once columns are known)."""

    day: date
    year_printed: bool
    clock: str
    description: str
    money: list[Tok]  # every amount after the date on its line, left to right
    line: int  # the line it starts on
    page: int
    y: float
    last4: str | None
    credit_section: bool
    after_terms: bool  # found after the statement's terms, worked examples, or a schedule that isn't transactions
    table: int = 0  # which table it's in: a new one starts on each page, and at each section heading or table header
    marks: list[str] = field(default_factory=list)  # a lone "Cr"/"Dr" at the end of its line (a marks column)
    below: list[Tok] = field(default_factory=list)  # amounts on the lines that continue it (a wrapped row's amount)

    @property
    def amounts(self) -> list[Tok]:
        return self.money + self.below


def _row_start(toks: list[Tok]) -> int | None:
    """Where a row's date is: first on the line, after at most a serial number or a long reference."""
    for i, t in enumerate(toks[:3]):
        if t.kind == "date":
            return i
        if t.kind == "number":
            continue
        return None
    return None


def not_transactions(lines: list[Line]) -> list[bool]:
    """For each line, whether it's in a part of the statement that holds dates and amounts but no transactions: the
    terms and their worked examples (card_statement.in_terms), or a block of its own under an EMI, loan or rewards
    heading (to the next gap, page or section heading). Only a heading starts one: a note that mentions "the Terms and
    Conditions" in passing hides nothing."""
    terms = in_terms(lines)
    out, elsewhere = [], False
    for i, ln in enumerate(lines):
        text = ln.text.strip()
        if elsewhere and i > 0 and (lines[i - 1].page != ln.page or ln.y - lines[i - 1].y > 2.2 * ln.height):
            elsewhere = False  # a schedule or summary is a block of its own: it ends at a gap or a new page
        if heading(text, _ELSEWHERE) or heading(text, _NOT_TRANSACTIONS):
            elsewhere = True
        if _CREDIT_SECTION.match(text) or _DEBIT_SECTION.match(text):
            elsewhere = False
        out.append(terms[i] or elsewhere)
    return out


def find_rows(lines: list[Line], primary_last4: str | None) -> tuple[list[Shaped], list[list[Tok]]]:
    """Every line that looks like a transaction, and every line's tokens (for the lines a reading leaves out)."""
    toks = [tokens(ln) for ln in lines]
    aside = not_transactions(lines)
    rows: list[Shaped] = []
    last4, credit_section, table = primary_last4, False, 0
    for i, (ln, ts) in enumerate(zip(lines, toks)):
        text = ln.text.strip()
        if i and ln.page != lines[i - 1].page:
            table += 1
        if m := _CARD_NO.search(text):
            if re.search(r"[Xx*•]{2}", m.group(0)):
                last4 = m[1]
        if _CREDIT_SECTION.match(text):
            credit_section, table = True, table + 1
            continue
        if _DEBIT_SECTION.match(text):
            credit_section, table = False, table + 1
            continue
        start = _row_start(ts)
        if start is None:
            if _H_DATE.search(text) and (_H_AMOUNT.search(text) or _H_DEBIT.search(text)) and not any(t.kind in ("date", "money") for t in ts):
                table += 1  # a table's header
            continue
        if i > 0 and lines[i - 1].page == ln.page and 0 < ln.y - lines[i - 1].y < 1.9 * ln.height and _SUMMARY_ROW.search(lines[i - 1].text):
            continue  # the figures under a row of summary labels ("Statement Date | Due Date | Total Due")
        date_tok = ts[start]
        j = start + 1
        clock = ""
        while j < len(ts) and ts[j].kind == "time":
            clock = (clock + " " + ts[j].text).strip()
            j += 1
        rest = ts[j:]
        money = [t for t in rest if t.kind == "money"]
        rows.append(Shaped(
            day=date_tok.day, year_printed=date_tok.year_printed, clock=clock,  # type: ignore[arg-type]
            description=_describe(rest),
            money=money, line=i, page=ln.page, y=ln.y, last4=last4, credit_section=credit_section, after_terms=aside[i],
            table=table, marks=_marks_after(rest),
        ))
    rows = sorted(rows + _continue(rows, lines, toks), key=lambda r: r.line)
    return rows, toks


def _marks_after(toks: list[Tok]) -> list[str]:
    """A lone "Cr" or "Dr" after the row's amount: a marks column, at the end of the line or with another column after
    it ("1,234.50 | DR | 400000XXXXXX3141"). The last one first."""
    first_money = next((k for k, t in enumerate(toks) if t.kind == "money"), None)
    if first_money is None:
        return []
    marks = [t.text.lower().strip("().") for t in toks[first_money + 1:] if t.kind == "text" and _MARK.match(t.text)]
    return [{"c": "cr", "d": "dr"}.get(m, m) for m in reversed(marks)]


def _describe(rest: list[Tok]) -> str:
    """The words between the date and the amounts: no leading reference number, no points just before the amount."""
    words = [t for t in rest if t.kind in ("text", "number", "date", "time")]
    while words and words[0].kind in ("date", "time"):
        words.pop(0)  # the day it posted, after the day it was made
    while words and words[0].kind == "number" and _REFERENCE.fullmatch(words[0].text.lstrip("+-")):
        words.pop(0)
    while words and words[0].kind == "text" and _REFERENCE.fullmatch(words[0].text):
        words.pop(0)
    first_money = next((t.x0 for t in rest if t.kind == "money"), None)
    if first_money is not None:
        words = [t for t in words if t.x1 <= first_money]
    while words and (words[-1].kind == "number" or words[-1].text in ("+", "-", "|")):
        words.pop()  # reward points printed before the amount ("+ 12")
    return " ".join(t.text for t in words).strip()


def _continue(rows: list[Shaped], lines: list[Line], toks: list[list[Tok]]) -> list[Shaped]:
    """Lines near a row that carry no date of their own: more of its description, its time, or its amount. A line with
    an amount of its own lined up under the row's (SBI prints a fee's GST on the line below the fee, undated) is a row
    of its own, made the same day: returned. A description line nearer the next row than this one is the start of
    that row's description (a cell centred on its row puts its first line above the date)."""
    row_lines = {r.line: r for r in rows}
    ordered = sorted(rows, key=lambda r: r.line)
    claimed: set[int] = set()
    extra: list[Shaped] = []

    def own_x(r: Shaped) -> float | None:
        after = [t for t in toks[r.line] if t.kind in ("text", "number")]
        return min(t.x0 for t in after) if after else None

    # where descriptions start in each table: for a row whose description is all on the lines around it
    starts: dict[int, list[float]] = {}
    for r in ordered:
        if (x := own_x(r)) is not None:
            starts.setdefault(r.table, []).append(x)
    usual = {t: sorted(xs)[len(xs) // 2] for t, xs in starts.items()}

    def desc_x(r: Shaped) -> float | None:
        x = own_x(r)
        return x if x is not None else usual.get(r.table)

    for n, r in enumerate(ordered):
        start = desc_x(r)
        nxt = ordered[n + 1] if n + 1 < len(ordered) and ordered[n + 1].page == r.page else None
        y, added = r.y, 0
        for k in range(r.line + 1, min(r.line + 4, len(lines))):
            if k in row_lines:
                break
            ln, kts = lines[k], toks[k]
            if ln.page != r.page or ln.y - y > 1.9 * ln.height or _CREDIT_SECTION.match(ln.text.strip()) or _DEBIT_SECTION.match(ln.text.strip()):
                break
            money = [t for t in kts if t.kind == "money"]
            if nxt is not None and not money and nxt.y - ln.y < ln.y - y:
                break  # nearer the next row: the first line of its description
            if kts and all(t.kind == "time" for t in kts):
                r.clock = r.clock or kts[0].text
            elif money and not any(t.kind == "date" for t in kts):
                if r.money and any(abs(t.x1 - m.x1) <= 3 for t in money for m in r.money):
                    extra.append(Shaped(day=r.day, year_printed=r.year_printed, clock=r.clock, description=_describe(kts),
                                        money=money, line=k, page=ln.page, y=ln.y, last4=r.last4, credit_section=r.credit_section,
                                        after_terms=r.after_terms, table=r.table, marks=_marks_after(kts)))
                    claimed.add(k)
                    break  # a row of its own: its amount lines up with this row's
                r.below += money  # a wrapped row's amount, on its second line
                r.marks = r.marks or _marks_after(kts)
                words = " ".join(t.text for t in kts if t.kind == "text" and not _MARK.match(t.text))
                if words and added < 2:
                    r.description = f"{r.description} {words}".strip()
                    added += 1
            elif start is not None and kts and kts[0].x0 >= start - 3 and added < 2:
                r.description = f"{r.description} {' '.join(t.text for t in kts)}".strip()
                added += 1
            else:
                break
            claimed.add(k)
            y = ln.y
    for r in ordered:  # the line just above a row, half a line up, in its description's column: its description's start
        start, k = desc_x(r), r.line - 1
        if start is None or k < 0 or k in claimed or k in row_lines:
            continue
        ln, kts = lines[k], toks[k]
        if ln.page == r.page and 0 < r.y - ln.y <= 0.9 * ln.height and kts and kts[0].x0 >= start - 3 \
                and not any(t.kind in ("money", "date") for t in kts) and not _CREDIT_SECTION.match(ln.text.strip()):
            r.description = f"{' '.join(t.text for t in kts)} {r.description}".strip()
    return extra


# ---- columns -------------------------------------------------------------------------------------------------------


def _cluster(values: list[float], tolerance: float) -> list[tuple[float, int]]:
    """Positions that line up (within `tolerance`): each group's middle and how many it has, biggest first."""
    groups: list[list[float]] = []
    for v in sorted(values):
        if groups and v - groups[-1][-1] <= tolerance:
            groups[-1].append(v)
        else:
            groups.append([v])
    return sorted(((sum(g) / len(g), len(g)) for g in groups), key=lambda g: -g[1])


SHIFT = 24.0  # points: how far a table may print a column to one side of where another prints it. Two columns of
# one table are further apart than that: each is as wide as its widest amount.


@dataclass
class Column:
    edge: float
    side: str  # "x1": amounts right-aligned on this edge; "x0": left-aligned
    rows: int
    more: tuple[float, ...] = ()  # where other tables print the same column, a little to one side

    @property
    def edges(self) -> tuple[float, ...]:
        return (self.edge, *self.more)

    def holds(self, t: Tok) -> bool:
        x = t.x1 if self.side == "x1" else t.x0
        return any(abs(x - e) <= 3.0 for e in self.edges)

    def joined(self, other: "Column") -> "Column":
        big, small = (self, other) if self.rows >= other.rows else (other, self)
        return Column(big.edge, big.side, self.rows + other.rows, tuple(sorted({*big.more, *small.edges})))


def _tables(c: Column, rows: list["Shaped"]) -> set[int]:
    return {r.table for r in rows if any(c.holds(t) for t in r.amounts)}


def _edge(t: Tok, side: str) -> float:
    return t.x1 if side == "x1" else t.x0


def _table_shifts(rows: list[Shaped], side: str) -> dict[int, float]:
    """For each table printed a little to one side of the biggest one (a first page laid out around its summary, a page
    whose columns are narrower), the shift that lines its amounts up with that table's columns, even for a page of one
    row."""
    tables: dict[int, list[Tok]] = {}
    for r in rows:
        tables.setdefault(r.table, []).extend(r.amounts)
    if len(tables) < 2:
        return {}
    main = max(tables, key=lambda k: len(tables[k]))
    ref = [e for e, n in _cluster([_edge(t, side) for t in tables[main]], 3.0) if n >= max(2, 0.2 * len(tables[main]))]
    out = {}
    for table, mine in tables.items():
        def fit(d: float) -> int:
            return sum(1 for t in mine if any(abs(_edge(t, side) + d - e) <= 3.0 for e in ref))

        shifts = {round(e - _edge(t, side), 2) for t in mine for e in ref if 3.0 < abs(e - _edge(t, side)) <= SHIFT}
        best = max(shifts, key=lambda d: (fit(d), -abs(d)), default=0.0)
        if table != main and fit(best) > fit(0.0):
            out[table] = best
    return out


def money_columns(rows: list[Shaped]) -> list[Column]:
    """Where the rows' amounts line up, left to right. Amounts are usually right-aligned; left-aligned ones line up on
    their left edge instead: the side where they line up in the fewest, fullest columns. A column is where at least
    two rows' amounts line up exactly; an amount inside a description ("USD 12.99") rarely does. A row with no amount
    in any of those columns has its own: the month's one payment in a credits column is a column of one."""
    tokens_ = [t for r in rows for t in r.amounts]
    if not tokens_:
        return []
    need = 2 if len(rows) > 3 else 1

    shifts = {side: _table_shifts(rows, side) for side in ("x1", "x0")}

    def strength(side: str) -> int:  # how few edges the amounts share: a column's amounts share one, whatever their width
        edges = [_edge(t, side) + shifts[side].get(r.table, 0.0) for r in rows for t in r.amounts]
        return sum(n * n for _, n in _cluster(edges, 3.0) if n >= need)

    side = "x0" if strength("x0") > strength("x1") else "x1"
    for r in rows:  # a table printed to one side: its amounts moved into line with the others (only where they sit)
        if d := shifts[side].get(r.table):
            for t in r.amounts:
                t.x0, t.x1 = t.x0 + d, t.x1 + d
    best = [Column(edge, side, n) for edge, n in _cluster([_edge(t, side) for t in tokens_], 3.0) if n >= need]
    orphans = [r.amounts[-1] for r in rows if r.amounts and not any(c.holds(t) for c in best for t in r.amounts)]
    for edge, n in _cluster([t.x1 if side == "x1" else t.x0 for t in orphans], 3.0):
        best.append(Column(edge, side, n))
    # A table can print a column a little to one side of where the others do (a first page laid out around a summary
    # box, a narrower column of points): amounts a few points apart that never share a table are one column.
    out: list[tuple[Column, set[int]]] = []
    for c in sorted(best, key=lambda c: c.edge):
        mine = _tables(c, rows)
        if out and c.edge - max(out[-1][0].edges) <= SHIFT and not mine & out[-1][1]:
            out[-1] = (out[-1][0].joined(c), out[-1][1] | mine)
        else:
            out.append((c, mine))
    return [c for c, _ in out]


@dataclass
class Layout:
    """One way to read the rows' amounts."""

    name: str
    amount: Column | None = None  # one amount column
    debit: Column | None = None  # or separate debit and credit columns
    credit: Column | None = None
    balance: Column | None = None  # a running balance beside the amount


def layouts(rows: list[Shaped], columns: list[Column]) -> list[Layout]:
    """Every reasonable reading of the amount columns."""
    out = [Layout(f"amount@{c.edge:.0f}", amount=c) for c in columns]
    for i, a in enumerate(columns):
        for b in columns[i + 1:]:
            both = sum(1 for r in rows if any(a.holds(t) for t in r.amounts) and any(b.holds(t) for t in r.amounts))
            either = sum(1 for r in rows if any(a.holds(t) or b.holds(t) for t in r.amounts))
            if not either:
                continue
            if both == 0:  # rows use one or the other, never both: debits and credits
                out.append(Layout(f"debit@{a.edge:.0f}+credit@{b.edge:.0f}", debit=a, credit=b))
                out.append(Layout(f"credit@{a.edge:.0f}+debit@{b.edge:.0f}", debit=b, credit=a))
                if not _tables(a, rows) & _tables(b, rows):  # or, in tables of their own, one column printed in two places
                    out.append(Layout(f"amount@{a.edge:.0f}|{b.edge:.0f}", amount=a.joined(b)))
            elif both >= 0.6 * either:  # rows have both: an amount and its running balance
                out.append(Layout(f"amount@{a.edge:.0f}+balance@{b.edge:.0f}", amount=a, balance=b))
                out.append(Layout(f"amount@{b.edge:.0f}+balance@{a.edge:.0f}", amount=b, balance=a))
    if not columns:  # a statement of a row or two: its last amount
        out.append(Layout("last amount"))
    return out


def amount_of(row: Shaped, layout: Layout) -> tuple[Tok | None, str, Tok | None]:
    """The row's amount under this reading, which column says it is a debit or credit ("" when none does), and its
    running balance."""
    if layout.debit and layout.credit:
        for t in row.amounts:
            if layout.debit.holds(t):
                return t, "dr", None
            if layout.credit.holds(t):
                return t, "cr", None
        return None, "", None
    if layout.amount:
        amount = next((t for t in row.amounts if layout.amount.holds(t)), None)
        balance = next((t for t in row.amounts if layout.balance and layout.balance.holds(t)), None)
        return amount, "", balance
    return (row.amounts[-1] if row.amounts else None), "", None
