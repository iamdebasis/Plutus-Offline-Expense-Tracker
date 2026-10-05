"""A credit card's transactions exported from the bank's app or net banking: a table (CSV, Excel .xlsx, or the
HTML table some banks save as .xls) over whatever span you chose, from any bank.

The columns are found by what their headers mean (the same words the statement reader knows: date, details,
amount, debit and credit, category), wherever they sit. What's above the table is read like a statement's header:
the card number, the period, and the bank's totals when the export has them (then the rows are checked against
them, as a statement's are). Each row becomes the same kind of row a PDF statement gives, so everything after
reading (what a row is, the shop's name, matching, the check) is the statement reader's.

How a credit is marked varies by bank: a Cr / Dr after the amount or in a column of its own, separate debit and
credit columns, or a sign. With only a sign, the sign your payments to the card carry is the credits' sign.
"""

import csv
import io
import re
import zipfile
from collections import Counter
from datetime import date, datetime, timedelta
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree

from app import vault
from app.ingest.issuers import detect_issuer
from app.models import CardRef, Detection
from app.parsers import ParseError, ParseResult
from app.parsers.card_statement import (
    _H_AMOUNT, _H_CATEGORY, _H_CREDIT, _H_DATE, _H_DEBIT, _H_DETAILS, _PAYMENT, Amount, Line, Row, Word, _build, _check,
    _describe, parse_date, read_summary,
)

TABLE_EXTS = {".csv", ".xlsx", ".xls"}
_MAX_XML = 100 * 1024 * 1024  # an Excel file's parts, unpacked

_H_TYPE = re.compile(r"^(?:dr ?/ ?cr|cr ?/ ?dr|debit ?/ ?credit|credit ?/ ?debit|type|transaction type|txn type|dr/cr indicator)$",
                     re.IGNORECASE)
_H_CARD = re.compile(r"\bcard\b.*\b(?:no|number)\b", re.IGNORECASE)
_NOT_THE_DATE = re.compile(r"\b(?:posting|post|value|settlement|statement|due)\b", re.IGNORECASE)
_NOT_THE_AMOUNT = re.compile(r"foreign|original|\bfx\b|currency|points?|\bemi\b|balance", re.IGNORECASE)
_CREDIT_WORDS = re.compile(r"\b(?:refund|reversal|reversed|cash ?back|credit(?:ed)?)\b", re.IGNORECASE)


# ---- reading the table --------------------------------------------------------------------------------------


def read_table(path: Path) -> list[list[str]]:
    """Every row of the file's (first) table, as text cells."""
    raw = path.read_bytes()
    if raw[:4] == b"PK\x03\x04":
        return _xlsx_rows(path)
    if raw[:8] == bytes.fromhex("d0cf11e0a1b11ae1"):
        raise ParseError("This is an old-style Excel file (.xls), which can't be read here. Open it and save it as .xlsx or "
                         ".csv, then add that.")
    text = _decode(raw)
    if re.search(r"<\s*(?:table|tr)\b", text[:200_000], re.IGNORECASE):
        return _html_rows(text)  # many banks' ".xls" is an HTML table
    sample = text[:20_000]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    return [[c.strip() for c in row] for row in csv.reader(io.StringIO(text), dialect)]


def _decode(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-16", "cp1252"):
        try:
            text = raw.decode(encoding)
            if encoding != "utf-16" or "\x00" not in text:
                return text
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1")


class _Cells(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.rows: list[list[str]] = []
        self._cell: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.rows.append([])
        elif tag in ("td", "th"):
            if not self.rows:
                self.rows.append([])
            self._cell = []

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._cell is not None:
            self.rows[-1].append(re.sub(r"\s+", " ", "".join(self._cell)).strip())
            self._cell = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def _html_rows(text: str) -> list[list[str]]:
    parser = _Cells()
    parser.feed(text)
    return [r for r in parser.rows if any(r)]


_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
# Excel's own number formats that are dates
_DATE_FORMATS = set(range(14, 23)) | set(range(27, 37)) | set(range(45, 48)) | set(range(50, 59))


def _xml(z: zipfile.ZipFile, name: str) -> ElementTree.Element:
    if z.getinfo(name).file_size > _MAX_XML:
        raise ParseError("This Excel file is too large to read")
    data = z.read(name)
    if b"<!DOCTYPE" in data[:2000] or b"<!ENTITY" in data[:2000]:
        raise ParseError("This Excel file isn't one a bank would write")
    return ElementTree.fromstring(data)


def _xlsx_rows(path: Path) -> list[list[str]]:
    try:
        with zipfile.ZipFile(path) as z:
            names = set(z.namelist())
            shared = [] if "xl/sharedStrings.xml" not in names else [
                "".join(t.text or "" for t in si.iter(f"{_NS}t")) for si in _xml(z, "xl/sharedStrings.xml").iter(f"{_NS}si")]
            dates = _date_styles(z) if "xl/styles.xml" in names else set()
            sheet = _first_sheet(z, names)
            rows: list[list[str]] = []
            for row in _xml(z, sheet).iter(f"{_NS}row"):
                cells: dict[int, str] = {}
                for c in row.iter(f"{_NS}c"):
                    value = c.find(f"{_NS}v")
                    text = value.text or "" if value is not None else ""
                    kind = c.get("t")
                    if kind == "s" and text:
                        text = shared[int(text)]
                    elif kind == "inlineStr":
                        text = "".join(t.text or "" for t in c.iter(f"{_NS}t"))
                    elif kind in (None, "n") and text and int(c.get("s", "0")) in dates:
                        text = _excel_date(float(text))
                    cells[_column(c.get("r", ""), len(cells))] = text.strip()
                rows.append([cells.get(i, "") for i in range(max(cells) + 1)] if cells else [])
            return rows
    except (zipfile.BadZipFile, KeyError, ValueError, ElementTree.ParseError) as exc:
        raise ParseError(f"This Excel file couldn't be read ({type(exc).__name__})") from exc


def _first_sheet(z: zipfile.ZipFile, names: set[str]) -> str:
    try:
        first = next(_xml(z, "xl/workbook.xml").iter(f"{_NS}sheet"))
        rid = first.get(f"{_REL}id")
        for rel in _xml(z, "xl/_rels/workbook.xml.rels"):
            if rel.get("Id") == rid:
                target = rel.get("Target", "").lstrip("/")
                return target if target.startswith("xl/") else f"xl/{target}"
    except (KeyError, StopIteration):
        pass
    sheets = sorted(n for n in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n))
    if not sheets:
        raise ParseError("This Excel file has no sheets")
    return sheets[0]


def _date_styles(z: zipfile.ZipFile) -> set[int]:
    """The cell styles that show a number as a date."""
    styles = _xml(z, "xl/styles.xml")
    custom = {int(f.get("numFmtId", "0")) for f in styles.iter(f"{_NS}numFmt")
              if re.search(r"[dy]", re.sub(r'"[^"]*"|\[[^\]]*\]', "", f.get("formatCode", "")), re.IGNORECASE)}
    xfs = styles.find(f"{_NS}cellXfs")
    if xfs is None:
        return set()
    return {i for i, xf in enumerate(xfs.iter(f"{_NS}xf")) if int(xf.get("numFmtId", "0")) in _DATE_FORMATS | custom}


def _excel_date(serial: float) -> str:
    when = datetime(1899, 12, 30) + timedelta(days=serial)
    return when.strftime("%Y-%m-%d %H:%M") if when.hour or when.minute else when.strftime("%Y-%m-%d")


def _column(ref: str, fallback: int) -> int:
    letters = re.match(r"[A-Z]+", ref)
    if not letters:
        return fallback
    n = 0
    for ch in letters.group(0):
        n = n * 26 + ord(ch) - 64
    return n - 1


# ---- the table's columns ------------------------------------------------------------------------------------


class Columns:
    def __init__(self) -> None:
        self.date: int | None = None
        self.details: int | None = None
        self.amount: int | None = None
        self.debit: int | None = None
        self.credit: int | None = None
        self.type: int | None = None
        self.category: int | None = None
        self.card: int | None = None

    @property
    def complete(self) -> bool:
        return self.date is not None and self.details is not None and (self.amount is not None or (self.debit is not None and self.credit is not None))


def header(cells: list[str]) -> Columns | None:
    """The transactions header, by what its cells mean, or None when the row isn't one."""
    cols = Columns()
    for i, raw in enumerate(cells):
        text = re.sub(r"\s+", " ", raw).strip()
        if not text or len(text) > 40 or re.search(r"\d{2}", text):
            continue
        if _H_TYPE.match(text):
            cols.type = cols.type if cols.type is not None else i
        elif _H_CARD.search(text):
            cols.card = cols.card if cols.card is not None else i
        elif _H_DATE.search(text):
            if cols.date is None or (_NOT_THE_DATE.search(cells[cols.date]) and not _NOT_THE_DATE.search(text)):
                cols.date = i  # the purchase's date, not when it posted
        elif _H_CATEGORY.search(text):
            cols.category = cols.category if cols.category is not None else i
        elif _H_DETAILS.search(text):
            cols.details = cols.details if cols.details is not None else i
        elif _H_DEBIT.search(text) and not _H_CREDIT.search(text):
            cols.debit = i
        elif _H_CREDIT.search(text) and not _H_DEBIT.search(text):
            cols.credit = i
        elif _H_AMOUNT.search(text) and not _NOT_THE_AMOUNT.search(text):
            cols.amount = cols.amount if cols.amount is not None else i
    return cols if cols.complete else None


def find_header(rows: list[list[str]]) -> tuple[int, Columns] | None:
    for i, row in enumerate(rows[:60]):
        if cols := header(row):
            return i, cols
    return None


# ---- reading it ---------------------------------------------------------------------------------------------

_MONEY = re.compile(r"^(?P<open>\()?\s*(?P<sign>[+\-])?\s*(?:₹|rs\.?|inr)?\s*(?P<num>\d[\d,]*(?:\.\d{1,2})?)\s*\)?\s*(?P<mark>cr|dr|c|d)?\.?$",
                    re.IGNORECASE)


def _money(text: str) -> tuple[float, str] | None:
    """'1,234.50' → (1234.5, ''), '1,234.50 Cr' → (…, 'cr'), '-500.00' or '(500.00)' → (500.0, '-')."""
    m = _MONEY.match(text.strip().replace("−", "-"))
    if not m:
        return None
    mark = (m["mark"] or "").lower()
    mark = {"c": "cr", "d": "dr"}.get(mark, mark) or ("-" if m["sign"] == "-" or m["open"] else "+" if m["sign"] == "+" else "")
    return float(m["num"].replace(",", "")), mark


def _day(text: str) -> tuple[date, str] | None:
    text = text.strip()
    m = re.match(r"^(.*?)(?:[ T](\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m)?))?$", text, re.IGNORECASE)
    if not m:
        return None
    day = parse_date(m[1].strip())
    return (day, m[2] or "") if day else None


def _lines(rows: list[list[str]]) -> list[Line]:
    """Rows as positioned lines (a cell to a column), for the statement reader's header and summary rules."""
    return [Line([Word(c, 100 * j, 100 * j + 90, 10 * i, 10 * i + 8) for j, c in enumerate(row) if c.strip()], 0)
            for i, row in enumerate(rows) if any(c.strip() for c in row)]


def parse(path: Path, upload_id: str, detection: Detection) -> ParseResult:
    table = read_table(path)
    found = find_header(table)
    if not found:
        raise ParseError("No transactions table found in this export: it needs a date, a description and an amount column.")
    at, cols = found
    above, body = table[:at], table[at + 1:]
    head = _lines(above)
    summary = read_summary(head) if head else read_summary([])

    card = (detection.cards or [None])[0]
    text_above = " ".join(" ".join(r) for r in above)
    issuer = (card.issuer if card else None) or detection.source or detect_issuer(f"{text_above} {path.name}")
    primary = (card.last4 if card else None) or card_last4(text_above)

    rows: list[Row] = []
    for i, cells in enumerate(body):
        get = lambda k: cells[k].strip() if k is not None and k < len(cells) else ""  # noqa: E731
        when = _day(get(cols.date))
        if not when:
            continue  # a blank line, a total, a note
        amount = _amount_of(get, cols)
        if amount is None:
            continue
        details = get(cols.details)
        if not details:
            continue
        rows.append(Row(day=when[0], clock=when[1], details=[details], category=[get(cols.category)] if get(cols.category) else [],
                        amount=amount, credit_section=False, last4=card_last4(get(cols.card)) if cols.card is not None else None,
                        page=0, y=float(i)))
    if not rows:
        raise ParseError("The export's table has no transactions in it.")
    settled = _settle_signs(rows)

    notes: list[str] = []
    last4s = [r.last4 for r in rows if r.last4]
    primary = primary or (Counter(last4s).most_common(1)[0][0] if last4s else None)
    if primary and not issuer:
        # the export doesn't name its bank: a card of yours with these last four digits is this one
        same = [c for c in vault.list_instruments() if c.last4 == primary]
        if len(same) == 1:
            issuer = same[0].issuer
    if not primary and issuer:
        # the export doesn't say which card: when you have one card of that bank, it's that one
        mine = [c for c in vault.list_instruments() if c.issuer == issuer]
        if len(mine) == 1:
            primary = mine[0].last4
            notes.append(f"This export doesn't print its card number: taken to be your {mine[0].name} ••{primary}, your only "
                         f"{issuer} card here.")
    if primary:
        vault.register_cards([CardRef(issuer=issuer, product=card.product if card else None, last4=primary,
                                      network=card.network if card else None)], upload_id)
    else:
        notes.append("This export doesn't say which card it's for, so its purchases aren't tied to a card. Add one of the "
                     "card's monthly statements first, then this export again.")

    period = summary.period or (min(r.day for r in rows), max(r.day for r in rows))
    result = _build(rows, upload_id, issuer, primary, period, summary, "export", signs_mark_credits=True)
    assert result.statement is not None
    statement = result.statement
    has_totals = summary.total_due is not None or summary.statement_date is not None or summary.due_date is not None
    statement.kind = "statement" if has_totals else "export"
    if not has_totals:
        statement.statement_date = None
    _check(statement, result)
    # The cells are exact; what can still be wrong is which rows are credits, or rows missing from the totals.
    if statement.check == "matched":
        statement.status, statement.proof = "proven", "previous balance − credits + debits = total due"
    elif statement.check == "mismatch":
        statement.status, statement.proof = "on_hold", "its rows don't add up to the totals it prints"
    elif settled == "guessed":
        statement.status, statement.proof = "on_hold", "which sign marks its credits had to be guessed: nothing in it says"
    else:
        statement.status, statement.proof = "exact", "read from the export's own cells"
    _describe(statement, result, True)
    result.notes = notes + result.notes
    if statement.status == "on_hold":
        result.warnings.append(f"On hold, not counted yet: {statement.proof}. Check it in Your vault.")
        statement.held, result.transactions = result.transactions, []  # read, shown, not counted until you confirm it
    return result


def _amount_of(get, cols: Columns) -> Amount | None:
    if cols.debit is not None and cols.credit is not None and (get(cols.debit) or get(cols.credit)):
        debit, credit = _money(get(cols.debit) or ""), _money(get(cols.credit) or "")
        if credit and credit[0] > 0:
            return Amount(credit[0], "cr", 0, 0)
        if debit and debit[0] > 0:
            return Amount(debit[0], "dr", 0, 0)
        return None
    if cols.amount is None:
        return None
    found = _money(get(cols.amount))
    if not found or found[0] <= 0:
        return None
    value, mark = found
    kind = get(cols.type).lower()
    if kind:
        if re.match(r"^(?:cr|c|credit)\b", kind):
            mark = "cr"
        elif re.match(r"^(?:dr|d|debit)\b", kind):
            mark = "dr"
    return Amount(value, mark, 0, 0)


def _settle_signs(rows: list[Row]) -> str | None:
    """Rows marked only by a sign, or not at all: which are credits. The sign your payments to the card carry is
    the credits' sign; without payments, the less common sign is (purchases outnumber refunds). Unsigned rows that
    say they're a refund or a payment are credits."""
    if any(r.amount and r.amount.mark == "-" for r in rows):
        for r in rows:  # in a column of signed amounts, a figure without a sign is a plus
            if r.amount and r.amount.mark == "":
                r.amount.mark = "+"
    settled = None  # how the sign's meaning was settled: by the payments' sign, or guessed from which is rarer
    signed = [r for r in rows if r.amount and r.amount.mark in ("+", "-")]
    if signed:
        paid = Counter(r.amount.mark for r in signed if _PAYMENT.search(r.description))
        signs = Counter(r.amount.mark for r in signed)
        credit_sign = paid.most_common(1)[0][0] if paid else (min(signs, key=signs.get) if len(signs) > 1 else None)
        for r in signed:
            r.amount.mark = "cr" if r.amount.mark == credit_sign else "dr"
        settled = "payments" if paid else "guessed"
    for r in rows:
        if r.amount and r.amount.mark == "":
            r.amount.mark = "cr" if _PAYMENT.search(r.description) or _CREDIT_WORDS.search(r.description) else "dr"
    return settled


# ---- recognising one --------------------------------------------------------------------------------------------

_CARD_WORDS = re.compile(r"credit card|card (?:no|number|ending)|card statement|\bcard\b.*\btransactions?\b", re.IGNORECASE)
_BALANCE = re.compile(r"\bbalance\b", re.IGNORECASE)
_MASKED_RUN = re.compile(r"[0-9Xx*•][0-9Xx*• \-]{11,24}\d{4}(?!\d)")


def card_last4(text: str) -> str | None:
    """A card number's last four digits: 15 to 19 characters with at least four masked ("4000 00XX XXXX 1234"); a
    bank account's masked number ("XXXXXXXX1234") is shorter."""
    for run in _MASKED_RUN.findall(text):
        compact = re.sub(r"[ \-]", "", run)
        if 15 <= len(compact) <= 19 and sum(ch in "Xx*•" for ch in compact) >= 4:
            return compact[-4:]
    return None


def looks_like_card_export(path: Path) -> tuple[bool, str | None, str | None]:
    """(a card's transactions table?, its card's last four digits, its bank). Cheap: reads the table once. A bank
    account's export (a running balance, an account number) isn't one."""
    try:
        table = read_table(path)
    except (ParseError, OSError, UnicodeError, csv.Error):
        return False, None, None
    found = find_header(table)
    if not found:
        return False, None, None
    at, cols = found
    above = table[:at]
    text = " ".join(" ".join(r) for r in above)
    last4 = card_last4(text)
    if last4 is None and cols.card is not None:
        last4 = next((n for r in table[at + 1:at + 50] if cols.card < len(r) and (n := card_last4(r[cols.card]))), None)
    if any(_BALANCE.search(c) for c in table[at]) and not last4:
        return False, None, None
    card_like = bool(last4) or bool(_CARD_WORDS.search(f"{text} {path.name.replace('_', ' ')}"))
    return card_like, last4, detect_issuer(f"{text} {path.name}")
