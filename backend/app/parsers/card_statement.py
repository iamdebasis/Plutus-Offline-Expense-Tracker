"""Credit card statements from any bank: one engine reads the transactions table, a few bank profiles add small
hints, and every statement is checked against the bank's own printed totals.

What Indian card statements share, and what this reads:
  - a summary: previous balance, payments and credits, purchases and debits, fees, total amount due, due date,
    credit limit. Labels sit beside their figures or above them.
  - one or more transaction tables: date | details | (merchant category | reward points | reference | foreign
    amount) | amount. Credits are marked "Cr", "CR", "C", "+" or "-", or sit in a credits column or section;
    debits are unmarked or "Dr"/"D". Descriptions wrap onto a second line. Tables run across pages, often with
    the header repeated.
  - reward points tables, EMI schedules, terms: not transactions, never read as such.

The reader finds a table by its header line (by meaning: a "date" column, a "details"/"description"/
"particulars" column, an "amount" column), takes the columns from where the header's words sit, and reads rows:
a row starts with a date, ends with an amount; lines without a date continue the row above. A statement with no
header it recognises is read line by line: a line that starts with a date and ends with an amount is a row.

Then the check: previous balance − credits + debits must equal the total due, to the rupee. A statement whose
rows don't add up is still imported, with a warning saying by how much, never silently wrong.
"""

import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from pathlib import Path

import pymupdf

from app import vault
from app.ingest.issuers import detect_issuer, product_name
from app.ingest.textlines import page_lines
from app.models import CardRef, CardStatement, Detection, SourceRef, Transaction
from app.parsers import IST, ParseError, ParseResult, stable_id

# ---- reading the page: words with positions, grouped into lines ------------------------------------------


@dataclass
class Word:
    text: str
    x0: float
    x1: float
    y0: float
    y1: float


@dataclass
class Line:
    words: list[Word]
    page: int

    @property
    def text(self) -> str:
        return " ".join(w.text for w in self.words)

    @property
    def y(self) -> float:
        return sum((w.y0 + w.y1) / 2 for w in self.words) / len(self.words)

    @property
    def height(self) -> float:
        return max(w.y1 - w.y0 for w in self.words)

    def span(self, start: int, end: int) -> tuple[float, float]:
        """The x-extent of the words covering characters start..end of `text`."""
        pos, xs = 0, []
        for w in self.words:
            if pos < end and pos + len(w.text) > start:
                xs += [w.x0, w.x1]
            pos += len(w.text) + 1
        return (min(xs), max(xs)) if xs else (self.words[0].x0, self.words[-1].x1)


def read_lines(doc: pymupdf.Document) -> tuple[list[Line], str]:
    """Every line of the statement in reading order, as positioned words. The PDF's own text when it reads
    normally; otherwise the decoded or OCR lines the rest of the app uses, split into words."""
    pages, method = page_lines(doc)
    if method == "text":
        lines: list[Line] = []
        for i in range(doc.page_count):
            lines += _word_lines(doc[i], i)
        return lines, method
    out = []
    for page in pages:
        for ln in page:
            out.append(Line(_spread(ln.text, ln.x0, ln.x1, ln.y0, ln.y1), ln.page))
    return out, method


def _word_lines(page: pymupdf.Page, index: int) -> list[Line]:
    words = sorted((Word(w[4], w[0], w[2], w[1], w[3]) for w in page.get_text("words") if w[4].strip()),
                   key=lambda w: ((w.y0 + w.y1) / 2, w.x0))
    lines: list[Line] = []
    for w in words:
        centre, height = (w.y0 + w.y1) / 2, w.y1 - w.y0
        if lines and abs(centre - lines[-1].y) < max(2.0, 0.45 * height):
            lines[-1].words.append(w)
        else:
            lines.append(Line([w], index))
    for ln in lines:
        ln.words.sort(key=lambda w: w.x0)
    return lines


def _spread(text: str, x0: float, x1: float, y0: float, y1: float) -> list[Word]:
    """An OCR line's words, placed across its width in proportion to their length."""
    parts = text.split()
    total = max(1, sum(len(p) for p in parts) + len(parts) - 1)
    out, pos = [], 0
    for p in parts:
        a = x0 + (x1 - x0) * pos / total
        pos += len(p)
        out.append(Word(p, a, x0 + (x1 - x0) * pos / total, y0, y1))
        pos += 1
    return out


# ---- dates and amounts --------------------------------------------------------------------------------

_MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
_NUMERIC_DATE = re.compile(r"^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$")
_ISO_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_DAY_MON = re.compile(r"^(\d{1,2})(?:st|nd|rd|th)?[\s\-/]?([A-Za-z]{3,9})[\s\-/,]*(\d{2}|\d{4})?$")
_MON_DAY = re.compile(r"^([A-Za-z]{3,9})\s*(\d{1,2}),?\s*(\d{2}|\d{4})?$")
_TIME = re.compile(r"^\d{1,2}:\d{2}(:\d{2})?$|^(am|pm)$", re.IGNORECASE)


def _year(raw: str | None) -> int | None:
    if not raw:
        return None
    y = int(raw)
    return y + 2000 if y < 100 else y


def parse_date(text: str, default_year: int | None = None) -> date | None:
    """A date in any of the styles statements use: 20/08/2026, 20-08-26, 20 Aug 2026, 20-Aug-26, Aug 20, 2026,
    2026-08-20, or 20 Aug with the year taken from the statement. Day first, as Indian banks write it."""
    s = text.strip().strip(",|")
    try:
        if m := _NUMERIC_DATE.match(s):
            return date(_year(m[3]), int(m[2]), int(m[1]))  # type: ignore[arg-type]
        if m := _ISO_DATE.match(s):
            return date(int(m[1]), int(m[2]), int(m[3]))
        if (m := _DAY_MON.match(s)) and m[2][:3].lower() in _MONTHS:
            y = _year(m[3]) or default_year
            return date(y, _MONTHS[m[2][:3].lower()], int(m[1])) if y else None
        if (m := _MON_DAY.match(s)) and m[1][:3].lower() in _MONTHS:
            y = _year(m[3]) or default_year
            return date(y, _MONTHS[m[1][:3].lower()], int(m[2])) if y else None
    except ValueError:
        return None
    return None


def _date_at_start(words: list[Word], default_year: int | None) -> tuple[date, int, str, bool] | None:
    """The date a row starts with, how many words it took (with a time after it), the time if any, and whether
    the year was printed."""
    for n in (3, 2, 1):
        if len(words) < n:
            continue
        text = " ".join(w.text for w in words[:n])
        d = parse_date(text, default_year)
        if d:
            used, clock = n, ""
            while used < len(words) and _TIME.match(words[used].text):
                clock += (" " if clock else "") + words[used].text
                used += 1
            return d, used, clock, parse_date(text) is not None
    return None


# An amount as statements print it: 1,23,456.78 or 1234.56, maybe with a currency sign ("`" is how some fonts
# extract ₹), a sign, and a credit/debit mark after it, attached or not.
_AMOUNT_END = re.compile(
    r"(?:^|(?<=\s))(?P<sign>[+\-])?\s?(?:₹|`|rs\.?|inr)?\s?(?P<num>\d{1,3}(?:,\d{2,3})+\.\d{1,2}|\d+\.\d{1,2})"
    r"\s*(?P<mark>cr|dr|c|d|\(cr\)|\(dr\)|credit|debit)?\.?\s*$",
    re.IGNORECASE,
)


@dataclass
class Amount:
    value: float
    mark: str  # "cr", "dr", "+", "-" or ""
    x0: float  # where it sits, for statements with separate debit and credit columns
    start: int  # the character where it starts in the line's text


def amount_at_end(line: Line) -> Amount | None:
    text = line.text
    m = _AMOUNT_END.search(text)
    if not m:
        return None
    mark = (m["mark"] or "").lower().strip("()")
    mark = {"c": "cr", "credit": "cr", "d": "dr", "debit": "dr"}.get(mark, mark) or (m["sign"] or "")
    x0, _ = line.span(m.start("num"), m.end("num"))
    return Amount(float(m["num"].replace(",", "")), mark, x0, m.start())


def _signed(text: str) -> float | None:
    """A summary figure: "12,345.67", "12,345.67 Dr", "1,000.00 Cr" (a credit balance, so negative)."""
    m = re.search(r"(?P<sign>-)?\s?(?:₹|`|rs\.?|inr)?\s?(?P<num>\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+\.\d{1,2}|\d+)\s*(?P<mark>cr|dr)?\b",
                  text, re.IGNORECASE)
    if not m:
        return None
    value = float(m["num"].replace(",", ""))
    return -value if (m["sign"] or (m["mark"] or "").lower() == "cr") else value


# ---- finding the transactions table ---------------------------------------------------------------------

_H_DATE = re.compile(r"\b(?:transaction |txn |tran |posting |purchase )?date\b", re.IGNORECASE)
_H_DETAILS = re.compile(r"\b(?:transaction |merchant )?(?:details|description|particulars|narration)\b|\bmerchant(?: name)?\b",
                        re.IGNORECASE)
_H_AMOUNT = re.compile(r"\bamount\b|\bamt\b", re.IGNORECASE)
_H_DEBIT = re.compile(r"\bdebits?\b|\bwithdrawals?\b", re.IGNORECASE)
_H_CREDIT = re.compile(r"\bcredits?\b|\bdeposits?\b", re.IGNORECASE)
_H_CATEGORY = re.compile(r"merchant category|spends? area|\bcategory\b|\bmcc\b", re.IGNORECASE)
_H_OTHER = re.compile(r"reward points?|\bpoints\b|\brewards?\b|\bref(?:erence)?(?: no\.?)?\b|ser\.? ?no|\bsl\.? ?no\b|"
                      r"\b(?:transaction|txn|tran) ?(?:id|no\.?|number)\b|"
                      r"foreign|intl\.?|international|original currency|\bfx\b", re.IGNORECASE)
_FOREIGN = re.compile(r"intl|international|foreign|original|\bfx\b|currency", re.IGNORECASE)
# Tables that hold dates and amounts but aren't transactions
_NOT_TRANSACTIONS = re.compile(r"illustrat|interest calculation|\bexamples?\b|"
                               r"tenure|instal?lments? (left|pending|remaining)|outstanding principal|loan amount|"
                               r"points (earned|redeemed)|opening points|closing points", re.IGNORECASE)
_END = re.compile(r"end of statement|reward points? (summary|account)|rewards? summary|summary of reward|"
                  r"important (message|information|notes?)|terms (and|&) conditions|"
                  r"(emi|loan) (summary|details)|this is a (system|computer)[- ]generated", re.IGNORECASE)
_CREDIT_SECTION = re.compile(r"^(?:your )?payments?(?: (?:and|&|/) (?:other )?credits?)?$|^(?:other )?credits?$", re.IGNORECASE)
_DEBIT_SECTION = re.compile(r"^(?:new |your )?(?:purchases|transactions|charges|spends|debits)\b|domestic transactions|"
                            r"international transactions", re.IGNORECASE)
_CARD_NO = re.compile(r"(?<![0-9A-Za-z])[0-9Xx*•]{4}[ -]?[0-9Xx*•]{2,4}[ -]?[0-9Xx*•]{2,6}[ -]?(\d{4})(?![0-9])")


def _card_number(text: str) -> str | None:
    """The last four digits of a masked card number on the line ("4000 12XX XXXX 1234"); a long reference
    number isn't one."""
    m = _CARD_NO.search(text)
    return m[1] if m and re.search(r"[Xx*•]{2}", m.group(0)) else None


@dataclass
class Columns:
    """Where a table's columns start, from its header line."""

    details: float
    category: float | None = None
    others: list[float] = field(default_factory=list)  # reward points, reference, foreign amount: not read
    debit: float | None = None  # separate debit / credit amount columns
    credit: float | None = None
    after_amount: float | None = None  # a column after the amount (cash or reward points): a row's amount ends before it

    def kind_of(self, x: float) -> str:
        starts = [(self.details, "details")]
        if self.category is not None:
            starts.append((self.category, "category"))
        starts += [(x0, "other") for x0 in self.others]
        best = "details"
        for start, name in sorted(starts):
            if x >= start - 2:
                best = name
        return best


def _header(line: Line, below: Line | None) -> Columns | None:
    """A transactions header, possibly wrapped over two lines ("Amount" / "(in Rs.)")."""
    candidates = [line]
    if below and below.page == line.page and 0 < below.y - line.y < 2.5 * line.height:
        candidates.append(Line(line.words + below.words, line.page))
    for ln in candidates:
        text = ln.text
        if amount_at_end(ln) or any(parse_date(w.text) for w in ln.words) or _NOT_TRANSACTIONS.search(text):
            continue  # a header holds no figures, and EMI or points tables aren't transactions
        if _SUMMARY_ROW.search(text):
            continue  # "Statement Date | Payment Due Date | Total Amount Due": the statement's own figures' labels
        d = _H_DATE.search(text)
        a = _H_AMOUNT.search(text)
        dr, cr = _H_DEBIT.search(text), _H_CREDIT.search(text)
        det = _H_DETAILS.search(text)
        if not d or not (a or (dr and cr)) or not det:
            continue  # a transactions table names its description column; an example's "Date | Transaction | Amount" doesn't
        details_x = ln.span(det.start(), det.end())[0]
        cols = Columns(details=details_x)
        cells = _cells(ln)
        cell_of = lambda m: next((c for c in cells if c[0] - 1 <= ln.span(m.start(), m.end())[0] <= c[1]), None)  # noqa: E731
        if cat := _H_CATEGORY.search(text):
            cols.category = ln.span(cat.start(), cat.end())[0]
        for o in _H_OTHER.finditer(text):
            if (cell := cell_of(o)) and cell[0] > details_x + 1:
                cols.others.append(cell[0])  # the column starts where its heading does ("Cash Points": at "Cash")
        date_cell = cell_of(d)
        for x0, x1, _ in cells:  # between the date and the details: a reference or ID column, not the description
            if date_cell and date_cell[1] < x0 and x1 < details_x - 2:
                cols.others.append(x0)
        if dr and cr and not a:
            cols.debit, cols.credit = ln.span(dr.start(), dr.end())[0], ln.span(cr.start(), cr.end())[0]
        # the row's amount is under the last amount heading that isn't a foreign-currency one ("Intl.# amount")
        amounts = [c for m in _H_AMOUNT.finditer(text) if (c := cell_of(m)) and not _FOREIGN.search(c[2])]
        money = amounts[-1:] + [c for m in (dr, cr) if m and (c := cell_of(m))]
        if money:
            end = max(c[1] for c in money)
            cols.after_amount = min((c[0] for c in cells if c[0] > end + 1 and _H_OTHER.search(c[2])), default=None)
        return cols
    return None


def _cells(line: Line) -> list[tuple[float, float, str]]:
    """A header's cells, left to right: words a space apart are one cell; a gap of more than about half the text's
    height starts the next one ("Amount in INR" and "Cash Points" sit 8pt apart, the words in each 2pt)."""
    out: list[tuple[float, float, str]] = []
    for w in sorted(line.words, key=lambda w: w.x0):
        gap = w.x0 - out[-1][1] if out else None
        if gap is not None and gap <= max(3.0, 0.45 * (w.y1 - w.y0)):
            out[-1] = (out[-1][0], max(out[-1][1], w.x1), f"{out[-1][2]} {w.text}")
        else:
            out.append((w.x0, w.x1, w.text))
    return out


def _amount_in(line: Line, cols: Columns | None) -> Amount | None:
    """A row's amount: at the end of its line or, when the table has a column after the amount (cash or reward
    points), at the end of what comes before that column."""
    if cols and cols.after_amount is not None:
        before = [w for w in line.words if w.x0 < cols.after_amount - 2]
        if before and len(before) < len(line.words):
            return amount_at_end(Line(before, line.page))
    return amount_at_end(line)


# ---- one row of the table -----------------------------------------------------------------------------


@dataclass
class Row:
    day: date
    clock: str
    details: list[str]
    category: list[str]
    amount: Amount | None
    credit_section: bool
    last4: str | None
    page: int
    y: float
    year_printed: bool = True

    @property
    def description(self) -> str:
        return re.sub(r"\s+", " ", " ".join(self.details)).strip()

    def is_credit(self, signs_mark_credits: bool = True) -> bool:
        """Cr marks a credit, Dr a debit; unmarked rows are debits unless they sit in a credits column or
        section. A bare + or - usually marks a credit too; the check against the bank's totals decides when not."""
        if self.amount is None or self.amount.mark == "dr":
            return False
        if self.amount.mark == "cr" or self.credit_section:
            return True
        return signs_mark_credits and self.amount.mark in ("+", "-")


# A transaction's reference or ID ("900000000000000000001"): long, mostly digits. Right after the date, it isn't
# the description's start.
_REFERENCE = re.compile(r"(?=(?:\D*\d){8})[A-Za-z0-9]{10,}")


def _fill(row: Row, line: Line, start: int, cols: Columns | None, amount: Amount | None) -> None:
    """Put a line's words (after the date) into the row's details and category, up to its amount."""
    stop = amount.start if amount else len(line.text) + 1
    pos = 0
    for w in line.words:
        here = pos
        pos += len(w.text) + 1
        if here < start or here >= stop:
            continue
        kind = cols.kind_of(w.x0) if cols else "details"
        if kind == "details" and not row.details and _REFERENCE.fullmatch(w.text):
            continue
        if kind == "details":
            row.details.append(w.text)
        elif kind == "category":
            row.category.append(w.text)


def read_rows(lines: list[Line], default_year: int | None, primary_last4: str | None) -> tuple[list[Row], bool, list[str]]:
    """The transaction rows; whether a header was found (rows read from a table, not guessed line by line); and the
    lines inside a table that weren't read as rows though they carry an amount or a date (a total, a row in a shape
    the reader didn't expect). Those are where a missing row is, when the rows don't add up."""
    headers = {i: cols for i, ln in enumerate(lines) if (cols := _header(ln, lines[i + 1] if i + 1 < len(lines) else None))}
    rows: list[Row] = []
    cols: Columns | None = None
    in_table = not headers  # no header anywhere: read every line that looks like a row
    credit_section = False
    last4 = primary_last4
    current: Row | None = None
    unread: list[str] = []

    def skip(line: Line, amount: Amount | None) -> None:
        if headers and amount is not None and len(unread) < 30:
            unread.append(line.text.strip())

    for i, ln in enumerate(lines):
        text = ln.text.strip()
        if i in headers:
            cols, in_table, current = headers[i], True, None
            continue
        if _END.search(text):
            in_table, current = False, None
            continue
        if found := _card_number(text):
            last4 = found
        if current is not None and ln.page != current.page:
            current = None  # rows don't run across pages; the next page starts with its own heading lines
        if not in_table:
            continue
        if _CREDIT_SECTION.match(text):
            credit_section, current = True, None
            continue
        if _DEBIT_SECTION.match(text):
            credit_section, current = False, None
            continue
        start = _date_at_start(ln.words, default_year)
        amount = _amount_in(ln, cols)
        if start and (cols is None or ln.words[0].x0 < cols.details - 2):
            day, used, clock, year_printed = start
            if not headers and amount is None:
                continue  # without a table, a row needs its amount on the same line
            current = Row(day, clock, [], [], None, credit_section, last4, ln.page, ln.y, year_printed)
            char = len(" ".join(w.text for w in ln.words[:used])) + 1
            _fill(current, ln, char, cols, amount)
            current.amount = _with_column(amount, cols)
            rows.append(current)
            continue
        if current is None:
            skip(ln, amount)
            continue
        # a line without a date: the row above continues, with more of its description or its amount. A line
        # that starts in the date column, or brings a second amount (a total), ends the row instead.
        in_columns = cols is None or ln.words[0].x0 >= cols.details - 2
        if in_columns and 0 <= ln.y - current.y < 3.2 * ln.height:
            if current.amount is None and amount:
                _fill(current, ln, 0, cols, amount)
                current.amount = _with_column(amount, cols)
            elif amount is None and len(current.details) < 24:
                _fill(current, ln, 0, cols, None)
            else:
                skip(ln, amount)
                current = None
                continue
            current.y = ln.y
        else:
            skip(ln, amount)
            current = None
    unread += [f"{r.day:%d/%m/%Y} {r.description}" for r in rows if r.amount is None and headers][: max(0, 30 - len(unread))]
    return [r for r in rows if r.amount is not None and r.amount.value > 0], bool(headers), unread


def _with_column(amount: Amount | None, cols: Columns | None) -> Amount | None:
    """With separate debit and credit columns, the column says which it is."""
    if amount and cols and cols.debit is not None and cols.credit is not None and not amount.mark:
        nearer_credit = abs(amount.x0 - cols.credit) < abs(amount.x0 - cols.debit)
        amount.mark = "cr" if nearer_credit else "dr"
    return amount


# ---- the statement's own figures ------------------------------------------------------------------------

_LABELS = {
    "previous_balance": r"previous (?:statement )?(?:balance|dues)|opening balance|last statement balance|balance b/?f",
    "total_due": r"total (?:amount )?(?:due|dues|payable)|total payment due|total outstanding|closing balance|amount payable",
    "minimum_due": r"minimum (?:amount )?(?:due|payable)|min\.? (?:amount )?due",
    "credit_limit": r"(?<!available )(?<!cash )credit limit",
    "statement_date": r"statement date|date of statement|statement generation date|statement cycle|billing cycle",
    "due_date": r"(?:payment )?due date",
    "period": r"statement period|billing period|statement for the period|period|statement cycle|billing cycle|"
              r"(?<![a-z])from(?= +\d{1,2}[/.\- ])",
}


# A line of the summary's labels (with their figures in the line below) also says "date" and "amount"; it isn't the
# transactions header.
_SUMMARY_ROW = re.compile("|".join(pattern for key, pattern in _LABELS.items() if key != "period"), re.IGNORECASE)


@dataclass
class Summary:
    previous_balance: float | None = None
    total_due: float | None = None
    minimum_due: float | None = None
    credit_limit: float | None = None
    statement_date: date | None = None
    due_date: date | None = None
    period: tuple[date, date] | None = None


# Where a statement's terms start: their worked examples ("For an account whose statement date is …") print the
# same labels with made-up figures.
_TERMS = re.compile(r"illustrat|interest calculation|terms (?:and|&) conditions|most important terms|\bfor example\b|"
                    r"for an account (?:whose|with)", re.IGNORECASE)


def read_summary(lines: list[Line]) -> Summary:
    """The figures a statement prints about itself, before its terms start. A label's value is beside it, after it on
    the line, or below it, under the label (summary boxes put labels in a row and figures in the row beneath)."""
    found: dict[str, object] = {}
    for i, ln in enumerate(lines[:400]):
        if _TERMS.search(ln.text):
            break
        low = ln.text.lower()
        for key, pattern in _LABELS.items():
            if key in found:
                continue
            for m in re.finditer(pattern, low):
                value = _value_beside(ln, m.end(), key)
                if value is None:  # not `or`: a figure of ₹0.00 is a figure
                    value = _value_below(lines, i, ln.span(m.start(), m.end()), key)
                if value is not None:
                    found[key] = value
                    break
    s = Summary(**{k: v for k, v in found.items() if k != "period"})
    if isinstance(found.get("period"), tuple):
        s.period = found["period"]  # type: ignore[assignment]
    return s


def _value(text: str, key: str) -> object | None:
    if key == "period":
        days = [d for d in (parse_date(x) for x in re.findall(r"\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{1,2}[ \-][A-Za-z]{3,9}[ \-,]*\d{2,4}|"
                                                               r"[A-Za-z]{3,9} \d{1,2},? \d{4}", text)) if d]
        return (days[0], days[1]) if len(days) >= 2 else None
    if key.endswith("date"):
        days = [d for token in re.findall(r"\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{1,2}[ \-][A-Za-z]{3,9}[ \-,]*\d{2,4}|"
                                          r"[A-Za-z]{3,9} \d{1,2},? \d{4}", text) if (d := parse_date(token))]
        # a cycle printed as a range ("Statement Cycle: 13/08/2026 - 12/09/2026"): the statement is dated at its end
        return (days[1] if key == "statement_date" and len(days) >= 2 and days[1] > days[0] else days[0]) if days else None
    text = re.sub(r"\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{1,2}[ \-][A-Za-z]{3,9}[ \-,]*\d{2,4}", " ", text)  # a date isn't a figure
    if key in _MONEY_KEYS and not _MONEY.search(text):
        return None  # a balance or a due is money, with paise or a ₹: "Closing Balance 54" in a points box is points
    return _signed(text)


_MONEY_KEYS = {"previous_balance", "total_due", "minimum_due"}
_MONEY = re.compile(r"(?:₹|`|\brs\.?|\binr)\s?\d|\d\.\d{2}\b", re.IGNORECASE)


def _value_beside(line: Line, after: int, key: str) -> object | None:
    rest = line.text[after:]
    nxt = min((m.start() for p in _LABELS.values() for m in re.finditer(p, rest.lower()) if m.start() > 0), default=len(rest))
    return _value(rest[:nxt], key)


def _value_below(lines: list[Line], i: int, span: tuple[float, float], key: str) -> object | None:
    x0, x1 = span
    for ln in lines[i + 1:i + 4]:
        if ln.page != lines[i].page or ln.y - lines[i].y > 4 * lines[i].height:
            break
        near = [w for w in ln.words if w.x1 > x0 - 12 and w.x0 < x1 + 12]
        if near and (v := _value(" ".join(w.text for w in near), key)) is not None:
            return v
    return None


# ---- what each row is -----------------------------------------------------------------------------------

_PAYMENT = re.compile(r"payment (received|recd|thank)|thank you|\bbbps\b|bill ?pay|auto ?pay|auto ?debit|\bnach\b|\bneft\b|\bimps\b|"
                      r"\brtgs\b|\bcred\b|net ?banking|\bpayment\b.*\b(upi|online|mobile)\b|^(upi )?payment\b|cheque|clearing",
                      re.IGNORECASE)
_CASHBACK = re.compile(r"cash ?back|\breward|voucher|points? redeem|redemption", re.IGNORECASE)
_EMI = re.compile(r"\bemi\b|loan on card|instal?lment", re.IGNORECASE)
_EMI_INTEREST = re.compile(r"interest|processing fee|\bfee\b|charges?|\bgst\b|\btax\b", re.IGNORECASE)


# A row starting "UPI", or carrying the shop's UPI address (no dot after the @, unlike an e-mail address).
_UPI_ROW = re.compile(r"^\s*upi(?![a-z])|[\w.\-]{2,}@[a-z][a-z0-9]+(?![\w.])", re.IGNORECASE)


def paid_over_upi(description: str) -> bool:
    """A card statement's row for a payment made with the card over UPI ("UPI-SHOP-shop@okbank", "UPI/123/SHOP")."""
    return bool(_UPI_ROW.search(description))


def classify(description: str, credit: bool) -> str:
    """The kind of money movement a row is."""
    if credit:
        if _PAYMENT.search(description):
            return "bill_payment"  # you paying the card: not money in, not spending
        if _EMI.search(description):
            return "transfer"  # a purchase turned into EMIs is credited back; the instalments follow
        if _CASHBACK.search(description):
            return "cashback"
        return "refund"
    if _EMI.search(description) and not _EMI_INTEREST.search(description):
        return "transfer"  # an instalment of a purchase counted when you made it
    return "spend"


# ---- merchant names as card statements print them --------------------------------------------------------

_GATEWAY_PREFIX = re.compile(r"^(?:(?:pyu|payu|raz|rzp|razorpay|cca|ccav|ccavenue|bdk|billdesk|ptm|paytm|ind|sp|sq|pp|paypal|amz|"
                             r"amzn|cf|cashfree|jp|juspay|pg|www)\s*[*.]\s*)+", re.IGNORECASE)
_GATEWAY_WORDS = {"cybs", "cybersource", "payu", "razorpay", "rzp", "billdesk", "ccavenue", "cashfree", "juspay", "pg", "paytm", "ecom"}
_COUNTRIES = {"in", "ind", "india", "us", "usa", "gb", "gbr", "uk", "sg", "sgp", "ie", "irl", "nl", "nld", "au", "aus", "ae", "are",
              "hk", "lu", "lux", "de", "deu", "fr", "fra", "ca", "can", "jp", "jpn"}
_CITIES = {"bangalore", "bengaluru", "blr", "mumbai", "bombay", "delhi", "newdelhi", "gurgaon", "gurugram", "noida", "ghaziabad",
           "faridabad", "hyderabad", "secunderabad", "chennai", "madras", "pune", "kolkata", "calcutta", "ahmedabad", "jaipur",
           "lucknow", "kochi", "cochin", "ernakulam", "chandigarh", "mohali", "indore", "bhopal", "nagpur", "surat", "vadodara",
           "baroda", "coimbatore", "mysore", "mysuru", "mangalore", "mangaluru", "thane", "patna", "bhubaneswar", "goa", "panaji",
           "visakhapatnam", "vizag", "vijayawada", "kanpur", "agra", "varanasi", "dehradun", "raipur", "ranchi", "guwahati",
           "trivandrum", "thiruvananthapuram", "madurai", "nashik", "aurangabad", "ludhiana", "amritsar", "jodhpur", "udaipur",
           "navi", "new", "singapore", "dublin", "london", "amsterdam", "luxembourg", "seattle", "san", "francisco", "cupertino"}


_UPI_PART = re.compile(r"^(?:p2[mpa]|dr|cr|collect|pay|upi)$|^(?:ref|txn|rrn|utr)\b", re.IGNORECASE)


def clean_merchant(description: str) -> str:
    """'FAKEMART,PUNE' → 'FAKEMART'; 'PYU*Fake Food Pune' → 'Fake Food'; 'UPI-FAKE MART LIMITED-fakemart@ybl'
    → 'FAKE MART LIMITED'; 'WWW.FAKESHOP.IN' → 'FAKESHOP'. The full text stays in the transaction's note."""
    s = description.strip()
    upi = re.match(r"upi(?![a-z])", s, re.IGNORECASE)
    s = re.sub(r"^upi[-/ ]+", "", s, flags=re.IGNORECASE)
    s = re.sub(r"[-/\s][^-/\s]*@\S*$", "", s)  # a UPI address after the name
    if upi and "/" in s:  # "UPI/P2M/900000000301/SHOP NAME/ref …": the part that's a name
        s = next((part for part in map(str.strip, s.split("/")) if re.search(r"[a-z]{2}", part, re.IGNORECASE)
                  and not _UPI_PART.match(part)), s)
    s = _GATEWAY_PREFIX.sub("", s)
    s = s.split(",")[0]  # "NAME,CITY"
    s = s.split(" - ")[0]  # "NAME - BRANCH"
    s = re.sub(r"\b(?:usd|eur|gbp|sgd|aed|aud|cad|jpy|chf|hkd|myr|thb)\s*[\d,]+\.\d{2}\b", "", s, flags=re.IGNORECASE)  # foreign amount
    s = re.sub(r"^(?:refund|reversal|rev|credit)\b[\s:\-/]*|[\s\-/]*\b(?:refund|reversal|rev)$", "", s.strip(), flags=re.IGNORECASE)
    s = re.sub(r"\b(?:www\.)?([a-z0-9\-]+)\.(?:com|in|co\.in|net|org|io)\b", r"\1", s, flags=re.IGNORECASE)
    s = re.sub(r"\s+(?:ref(?:erence)?|txn|ref no)?\s*[#:]?\s*\d{6,}\b.*$", "", s, flags=re.IGNORECASE)
    words = s.split()
    while len(words) > 1 and (w := words[-1].lower().strip(".")) and (w in _COUNTRIES or w in _CITIES or w in _GATEWAY_WORDS or w.isdigit()):
        words.pop()
    cleaned = " ".join(words).strip(" -*.")
    return cleaned or description.strip()


# ---- the whole statement ------------------------------------------------------------------------------


def parse(path: Path, upload_id: str, detection: Detection) -> ParseResult:
    with pymupdf.open(path) as doc:
        lines, method = read_lines(doc)
    if not lines:
        raise ParseError("This statement has no readable text")
    summary = read_summary(lines)

    card = (detection.cards or [None])[0]
    issuer = (card.issuer if card else None) or detection.source or detect_issuer(" ".join(ln.text for ln in lines[:80]))
    primary = card.last4 if card else None
    period = summary.period or _period_from(detection)
    anchor = (summary.statement_date or (period[1] if period else None))
    rows, from_table, unread = read_rows(lines, anchor.year if anchor else None, primary)
    if anchor:
        rows = [_fix_year(r, anchor) if not r.year_printed else r for r in rows]
        # a statement lists its cycle's purchases (and a few that posted late); a row dated far outside that is a
        # worked example in the terms, not a purchase: shown with the lines not read, never counted
        earliest = (period[0] if period else anchor - timedelta(days=31)) - OUTSIDE_PERIOD
        inside = [r for r in rows if earliest <= r.day <= anchor + timedelta(days=7)]
        if len(inside) >= len(rows) / 2:
            unread += [f"{r.day:%d/%m/%Y} {r.description} (dated outside this statement's period)" for r in rows if r not in inside]
            rows = inside
        else:  # most rows are far from it: the statement date is what was misread, not the rows
            summary.statement_date, period, anchor = None, None, None
    if rows and not period:
        # no period printed: from the first transaction to the statement date (or the last transaction)
        period = (min(r.day for r in rows), anchor or max(r.day for r in rows))
    if not rows:
        raise ParseError("No transactions found in this statement. If it has some, run `make inspect` on it and share the "
                         "masked output so the reader can learn its layout.")

    last4s = [r.last4 for r in rows if r.last4]
    primary = primary or (Counter(last4s).most_common(1)[0][0] if last4s else None)
    if primary:
        vault.register_cards([CardRef(issuer=issuer, product=card.product if card else None, last4=primary,
                                      network=card.network if card else None)], upload_id)

    result = _build(rows, upload_id, issuer, primary, period, summary, method, signs_mark_credits=True)
    signed = any(r.amount and r.amount.mark in ("+", "-") for r in rows)
    if signed and result.statement and result.statement.check == "mismatch":
        other = _build(rows, upload_id, issuer, primary, period, summary, method, signs_mark_credits=False)
        if other.statement and other.statement.check == "matched":
            result = other  # this bank's + and - mark debits and credits the other way round
    assert result.statement is not None
    result.statement.unread = unread
    if summary.total_due is None and summary.statement_date is None and summary.due_date is None:
        # no statement date, total or due date: the bank's list of the card's transactions over a span, not a statement
        result.statement.kind, result.statement.statement_date = "export", None
    _describe(result.statement, result, from_table)
    return result


def _build(rows: list[Row], upload_id: str, issuer: str | None, primary: str | None, period: tuple[date, date] | None,
           summary: Summary, method: str, signs_mark_credits: bool) -> ParseResult:
    result = ParseResult(method=method)
    seen: Counter = Counter()  # the same purchase twice in a day: two rows, told apart by their order
    same_day: Counter = Counter()  # rows of one card with the same day, direction and amount, whatever they say
    for r in rows:
        assert r.amount is not None
        credit = r.is_credit(signs_mark_credits)
        kind = classify(r.description, credit)
        last4 = r.last4 or primary
        key = (r.day, credit, round(r.amount.value * 100), r.description.lower())
        seen[key] += 1
        same_day[key[:3] + (last4,)] += 1
        payee = clean_merchant(r.description) if kind in ("spend", "refund") else r.description
        # A purchase paid over UPI with the card is a UPI payment, wherever it was learned (it merges with the app's
        # own record of it when there is one); paying the card, EMIs and the bank's credits are the card's own.
        upi = kind in ("spend", "refund") and paid_over_upi(r.description)
        result.transactions.append(Transaction(
            id=stable_id("txn", "card", last4, r.day.isoformat(), credit, f"{r.amount.value:.2f}", r.description.lower(), seen[key]),
            at=datetime.combine(r.day, _clock(r.clock), IST), amount=r.amount.value, direction="credit" if credit else "debit",
            kind=kind, channel="upi" if upi else "card", payee=payee or r.description,  # type: ignore[arg-type]
            paid_from=f"XXXX{last4}" if last4 else None,
            # which row of the statement this is, the same however its words are read: a statement added again (or
            # read again by a better reader) finds its rows by it
            refs={"cardRow": f"{last4 or 'card'}:{r.day:%Y%m%d}:{'c' if credit else 'd'}:{r.amount.value:.2f}:{same_day[key[:3] + (last4,)]}"},
            note=r.description, card=vault.instrument_id(CardRef(issuer=issuer, last4=last4)) if last4 else None,
            merchant_category=" ".join(r.category).strip().title() or None,
            sources=[SourceRef(upload=upload_id, page=r.page + 1)],
        ))

    stmt_date = summary.statement_date or (period[1] if period else None)
    statement = CardStatement(
        id=upload_id, card=vault.instrument_id(CardRef(issuer=issuer, last4=primary)) if primary else None,
        issuer=issuer, last4=primary,
        period_start=period[0].isoformat() if period else None, period_end=period[1].isoformat() if period else None,
        statement_date=stmt_date.isoformat() if stmt_date else None,
        due_date=summary.due_date.isoformat() if summary.due_date else None, previous_balance=summary.previous_balance,
        total_due=summary.total_due, minimum_due=summary.minimum_due, credit_limit=summary.credit_limit,
        debits=round(sum(t.amount for t in result.transactions if t.direction == "debit"), 2),
        credits=round(sum(t.amount for t in result.transactions if t.direction == "credit"), 2),
        rows=len(result.transactions),
    )
    _check(statement, result)
    result.statement = statement
    return result


def _period_from(detection: Detection) -> tuple[date, date] | None:
    if detection.period:
        try:
            return date.fromisoformat(detection.period.start), date.fromisoformat(detection.period.end)
        except ValueError:
            return None
    return None


def _fix_year(row: Row, anchor: date) -> Row:
    """A date printed without its year ("20 Aug") is in the weeks before the statement date: December's
    purchases on January's statement are last year's."""
    if row.day > anchor + timedelta(days=5):
        try:
            row.day = row.day.replace(year=row.day.year - 1)
        except ValueError:
            pass
    return row


def _clock(raw: str) -> time:
    m = re.match(r"(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?", raw or "", re.IGNORECASE)
    if not m:
        return time(0, 0)
    hour = int(m[1]) % 12 + (12 if (m[4] or "").lower() == "pm" else 0) if m[4] else int(m[1])
    return time(min(hour, 23), int(m[2]), int(m[3] or 0))


_TOLERANCE = 1.5  # rupees: rounding on the statement
# How long before a statement's cycle a row can be dated and still belong to it (purchases that posted late).
OUTSIDE_PERIOD = timedelta(days=62)


def _check(s: CardStatement, result: ParseResult) -> None:
    """The rows must account for the statement's own figures: previous balance − credits + debits = total due."""
    if s.previous_balance is None or s.total_due is None:
        s.check = "unchecked"
        return
    expected = round(s.previous_balance - s.credits + s.debits, 2)
    s.difference = round(s.total_due - expected, 2)
    s.check = "matched" if abs(s.difference) <= _TOLERANCE else "mismatch"


def _describe(s: CardStatement, result: ParseResult, from_table: bool) -> None:
    def inr(v: float) -> str:
        return f"₹{v:,.2f}"

    txns = result.transactions
    count = Counter(t.kind for t in txns)
    spent = [t for t in txns if t.kind == "spend"]
    card = f"{s.issuer or 'Card'}{f' ••{s.last4}' if s.last4 else ''}"
    period = f"{_day(s.period_start)} – {_day(s.period_end)}" if s.period_start and s.period_end else "this statement"
    result.notes.append(f"{card} · {period}: {len(spent)} purchase{'' if len(spent) == 1 else 's'} and charges, "
                        f"{inr(sum(t.amount for t in spent))}")
    labels = (("bill_payment", "bill payment"), ("refund", "refund"), ("cashback", "cashback credit"), ("transfer", "EMI entry"))
    others = [f"{count[k]} {label if count[k] == 1 else label.replace('entry', 'entrie') + 's'}" for k, label in labels if count[k]]
    if others:
        result.notes.append("Also: " + ", ".join(others))
    if s.check == "matched":
        result.notes.append(f"Adds up: previous balance {inr(s.previous_balance or 0)} − credits {inr(s.credits)} + debits "
                            f"{inr(s.debits)} = total due {inr(s.total_due or 0)} ✓")
    elif s.check == "mismatch":
        result.warnings.append(f"Doesn't add up: by the rows read, the total due would be "
                               f"{inr((s.previous_balance or 0) - s.credits + s.debits)}, the statement says {inr(s.total_due or 0)} "
                               f"({inr(abs(s.difference or 0))} apart). Some rows may be missing or misread; check this statement.")
    elif s.kind == "export":
        result.notes.append("An export of the card's transactions: it has no totals to check its rows against")
    else:
        result.notes.append("Couldn't check the rows against the statement's totals: its previous balance or total due wasn't found")
    if not from_table:
        result.warnings.append("No transactions table header was recognised, so rows were read line by line")
    if not s.last4 and s.kind == "statement":
        result.warnings.append("Couldn't tell which card this statement is for")


def _day(iso: str | None) -> str:
    return date.fromisoformat(iso).strftime("%-d %b %Y") if iso else "?"
