"""Random credit card statements, each with the truth about it (fake data only).

The reader has to read statements nobody showed it: any bank, any period, laid out any of the ways banks lay them
out. The fixed fake layouts (fake_cards.py) test layouts someone thought of; this makes a new statement from every
seed, varying everything statements are known to vary in, and keeps what it printed (every row, the bank's own
figures) so a test can tell whether the reader got it exactly right.

    statement = generate(seed)          # what to print, and the truth
    path = render(statement, tmp_path / "s.pdf")
"""

import calendar
import random
from dataclasses import dataclass, field, replace
from datetime import date, timedelta
from pathlib import Path

import pymupdf

FONT = Path("/System/Library/Fonts/Helvetica.ttc")  # has the ₹ glyph
_METRICS = pymupdf.Font(fontfile=str(FONT)) if FONT.exists() else pymupdf.Font("helv")

SHOPS = ["FAKE FOOD APP", "FAKE GROCER", "FAKE AIRWAYS", "FAKE FUEL STATION", "FAKE CHAI POINT", "FAKE BOOKSHOP",
         "FAKE PHARMACY", "FAKE STREAM", "FAKE CABS", "FAKE MART", "FAKE CINEMAS", "FAKE ELECTRONICS", "FAKE HOTELS",
         "FAKE BAKERY", "FAKE SHOES", "FAKE TELECOM", "FAKE INSURANCE", "FAKE GYM", "FAKE SALON", "FAKE TOYS"]
CITIES = ["PUNE", "MUMBAI", "BANGALORE", "DELHI", "CHENNAI", "KOLKATA", "HYDERABAD"]
PAYMENTS = ["PAYMENT RECEIVED - THANK YOU", "BBPS PAYMENT RECEIVED", "AUTOPAY PAYMENT RECEIVED", "NEFT PAYMENT RECEIVED"]
REFUNDS = ["REFUND {shop}", "REVERSAL {shop}", "{shop} REFUND"]
CASHBACKS = ["CASHBACK CREDIT", "CASHBACK ON SPENDS", "REWARD CASHBACK"]


@dataclass
class Row:
    day: date
    clock: str  # "14:05", or "" when the statement prints no times
    details: str
    amount: float
    credit: bool
    more: str = ""  # a second line of description, when it wraps


@dataclass
class Style:
    """Every way the layout varies; one random choice each."""

    kind: str  # "statement": one cycle with its summary; "export": the card's transactions over a span, no summary
    date_fmt: str
    time: str  # "none", "word" ("14:05" after the date), "pipe" ("12/08/2026|14:05"), "pipe-space", "below"
    columns: list[str]  # left to right: date, posted, ref, details, category, foreign, points, amount | debit+credit, mark, pi, card, balance
    currency: str  # what precedes an amount: "", "₹", "₹ ", "` ", "Rs. ", "INR ", "C "
    credits: str  # how credits are told apart: cr, cr-glued, plus, minus, parens, columns, mark, section, words
    debits_marked: bool  # "Dr" after debits too
    grouping: str  # "indian" 1,23,456.78, "western" 123,456.78, "plain" 123456.78
    header: str  # "none", "line", "two-lines", "every-page"
    summary: str  # "beside", "below", "boxes", "sum" (the figures as a sum in a row, no statement date) (statements only)
    wrap: float  # how often a description runs onto a second line
    descending: bool  # newest first
    noise: list[str] = field(default_factory=list)  # "rewards", "terms", "gst", "message", "emi", "note", "apply"
    size: float = 8.5
    amount_low: bool = False  # a wrapped row's amount printed on its second line
    rounded: bool = False  # the total due printed to the rupee, the rows to the paisa
    shift: float = 0.0  # the first page's table printed this many points to one side (laid out around its summary)
    totals: bool = False  # an export that prints its totals of debits and credits (a year's summary): they prove it
    months: bool = False  # an export's period in months ("for the period from APRIL-25 to MARCH-26")


@dataclass
class Statement:
    style: Style
    rows: list[Row]
    period: tuple[date, date]
    statement_date: date | None
    due_date: date | None
    previous: float | None  # the bank's figures (None for an export without them)
    total_due: float | None
    last4: str
    seed: int = 0
    running_from: float | None = None  # an export's opening balance, when it prints a running balance
    parts: list["Statement"] = field(default_factory=list)  # a year's file: monthly statements one after another
    # a summary of several statements (a bank's statement of a year): the day each is dated, and per statement month
    # its purchases, payments and total due; `after`: rows its list holds past the last statement, in no total
    day: int = 0
    months: list[tuple[date, float, float, float]] = field(default_factory=list)
    after: list[Row] = field(default_factory=list)

    @property
    def debits(self) -> float:
        return round(sum(r.amount for r in self.rows if not r.credit), 2)

    @property
    def credits(self) -> float:
        return round(sum(r.amount for r in self.rows if r.credit), 2)

    def truth(self) -> list[tuple[date, float, bool]]:
        return sorted((r.day, r.amount, r.credit) for p in (self.parts or [self]) for r in p.rows + p.after)


DATE_FORMATS = ["%d/%m/%Y", "%d-%m-%Y", "%d/%m/%y", "%d.%m.%Y", "%d %b %Y", "%d-%b-%y", "%d %b %y", "%d-%b-%Y",
                "%b %d, %Y", "%Y-%m-%d", "%d %b", "%d/%m"]
YEARLESS = {"%d %b", "%d/%m"}


def generate(seed: int) -> Statement:
    if random.Random(seed * 7919 + 18).random() < 0.08:  # its own draw: every other seed stays the statement it was
        return _year_summary(seed)
    rng = random.Random(seed)
    if rng.random() < 0.1:
        return _bundle(rng, seed)
    kind = rng.choice(["statement"] * 3 + ["export"])
    style = _style(rng, kind)
    if kind == "statement":
        end = date(2026, rng.randint(1, 12), rng.randint(1, 28))
        start = end - timedelta(days=rng.choice([29, 30, 31]))
    else:  # a span someone picked: a fortnight to a year
        start = date(2025, rng.randint(1, 12), rng.randint(1, 28))
        end = start + timedelta(days=rng.randint(14, 365))
    rows = _rows(rng, start, end, style)
    previous = total = None
    if kind == "statement":
        previous = rng.choice([0.0, round(rng.uniform(500, 60000), 2), round(rng.uniform(500, 60000), 2)])
        total = round(previous - sum(r.amount for r in rows if r.credit) + sum(r.amount for r in rows if not r.credit), 2)
        if total < 0:  # a credit balance is real, but keep the totals the ordinary way round
            rows.append(Row(end - timedelta(days=1), "12:00" if style.time != "none" else "", rng.choice(SHOPS), round(-total + 100, 2), False))
            rows.sort(key=lambda r: (r.day, r.clock), reverse=style.descending)
            total = round(previous - sum(r.amount for r in rows if r.credit) + sum(r.amount for r in rows if not r.credit), 2)
        if style.rounded:
            total = float(round(total))
    statement = Statement(style, rows, (start, end), end if kind == "statement" else None,
                          end + timedelta(days=20) if kind == "statement" else None, previous, total, f"{rng.randint(1000, 9999)}", seed)
    if "balance" in style.columns:
        statement.running_from = round(rng.uniform(0, 20000), 2)
    return statement


def _bundle(rng: random.Random, seed: int) -> Statement:
    """Several months' statements in one file, as a bank's download of a year can be: each starts a page with its own
    summary, and each one's previous balance is the total due of the one before."""
    style = _style(rng, "statement")
    end = date(2026, rng.randint(1, 8), rng.randint(1, 28))
    previous = round(rng.uniform(0, 30000), 2)
    parts = []
    for k in range(rng.randint(2, 4)):
        start = end - timedelta(days=30)
        rows = _rows(rng, start, end, style)
        total = round(previous - sum(r.amount for r in rows if r.credit) + sum(r.amount for r in rows if not r.credit), 2)
        if total < 0:
            rows.append(Row(end - timedelta(days=1), "12:00" if style.time != "none" else "", rng.choice(SHOPS), round(-total + 100, 2), False))
            rows.sort(key=lambda r: (r.day, r.clock), reverse=style.descending)
            total = round(previous - sum(r.amount for r in rows if r.credit) + sum(r.amount for r in rows if not r.credit), 2)
        if style.rounded:
            total = float(round(total))
        parts.append(Statement(style, rows, (start, end), end, end + timedelta(days=20), previous, total, "4321", seed + k))
        previous, end = total, end + timedelta(days=31)
    whole = Statement(style, [r for p in parts for r in p.rows], (parts[0].period[0], parts[-1].period[1]), parts[-1].statement_date,
                      parts[-1].due_date, parts[0].previous, parts[-1].total_due, "4321", seed, parts=parts)
    return whole


def _year_summary(seed: int) -> Statement:
    """A bank's statement of a year: the statements dated in it summed up month by month, then every transaction, the
    list sometimes running past the last statement to the year's end."""
    rng = random.Random(seed * 31 + 5)
    style = _style(rng, "export")
    style.kind, style.totals, style.months = "year", False, False
    if "amount" in style.columns:  # (else separate debit and credit columns say it)
        style.credits = rng.choice(["mark", "cr", "plus"])
        if style.credits == "mark" and "mark" not in style.columns:
            style.columns.insert(style.columns.index("amount") + 1, "mark")
    style.columns = [c for c in style.columns if c != "balance"]
    day, count = rng.randint(1, 28), rng.randint(3, 12)
    first = date(2025, rng.randint(1, 12), 1)
    months = [date(first.year + (first.month - 1 + k) // 12, (first.month - 1 + k) % 12 + 1, 1) for k in range(count)]

    def dated(m: date) -> date:
        return m.replace(day=min(day, calendar.monthrange(m.year, m.month)[1]))

    rows, totals, due = [], [], round(rng.uniform(0, 20000), 2)
    for m in months:
        start, end = dated(date(m.year - (m.month == 1), (m.month - 2) % 12 + 1, 1)) + timedelta(days=1), dated(m)
        cycle = _rows(random.Random(rng.random()), start, end, replace(style, kind="statement"))
        cycle = [r for r in cycle if start <= r.day <= end]
        spent, paid = round(sum(r.amount for r in cycle if not r.credit), 2), round(sum(r.amount for r in cycle if r.credit), 2)
        due = round(due - paid + spent, 2)
        totals.append((m, spent, paid, due))
        rows += cycle
    after = []
    if rng.random() < 0.5:  # the list runs to the end of the last statement's month and on
        last = dated(months[-1])
        after = [Row(last + timedelta(days=rng.randint(1, 25)), "", rng.choice(SHOPS), round(rng.uniform(50, 5000), 2), False) for _ in range(rng.randint(1, 6))]
        after.append(Row(last + timedelta(days=rng.randint(1, 25)), "", rng.choice(PAYMENTS), round(rng.uniform(500, 9000), 2), True))
    rows.sort(key=lambda r: r.day, reverse=style.descending)
    period = (months[0] - timedelta(days=28), (after and max(r.day for r in after)) or dated(months[-1]))
    s = Statement(style, rows, (period[0].replace(day=1), period[1]), None, None, None, None, f"{rng.randint(1000, 9999)}", seed,
                  day=day, months=totals, after=sorted(after, key=lambda r: r.day, reverse=style.descending))
    return s


def _style(rng: random.Random, kind: str) -> Style:
    date_fmt = rng.choice([f for f in DATE_FORMATS if kind == "statement" or f not in YEARLESS])
    credits = rng.choice(["cr", "cr", "cr-glued", "plus", "minus", "parens", "columns", "mark", "section", "words"])
    if kind == "export" and credits == "section":
        credits = "cr"
    columns = ["date"]
    if rng.random() < 0.15:
        columns.append("posted")  # the day it posted, after the day it was made
    if rng.random() < 0.2:
        columns.append("ref")
    columns.append("details")
    if rng.random() < 0.3:
        columns.append("category")
    if rng.random() < 0.15:
        columns.append("foreign")  # the amount in a foreign currency, for some rows: a column of figures that isn't the amount
    points = rng.random() < 0.35
    if points and rng.random() < 0.5:
        columns.append("points")
    columns += ["debit", "credit"] if credits == "columns" else ["amount"]
    if credits == "mark":
        columns.append("mark")
    if points and "points" not in columns:
        columns.append("points")  # after the amount
    if rng.random() < 0.15:
        columns.append("pi")  # a single mark after the amount (which card or instrument)
    if rng.random() < 0.15:
        columns.append("card")  # the card's number on every row, after the amount and its marks
    if kind == "export" and credits != "columns" and rng.random() < 0.4:
        columns.append("balance")
    for optional in ("card", "pi", "ref", "posted", "category", "foreign", "points"):  # a statement's table fits its page
        if sum(WIDTHS[c] for c in columns) > 520 and optional in columns:
            columns.remove(optional)
    return Style(
        kind=kind,
        date_fmt=date_fmt,
        time=rng.choice(["none", "none", "word", "pipe", "pipe-space", "below"]),
        columns=columns,
        currency=rng.choice(["", "", "", "₹", "₹ ", "` ", "Rs. ", "INR ", "C "]),
        credits=credits,
        debits_marked=credits in ("cr", "cr-glued") and rng.random() < 0.3,
        grouping=rng.choice(["indian", "indian", "western", "plain"]),
        header=rng.choice(["line", "line", "two-lines", "every-page", "none"]),
        summary=rng.choice(["beside", "below", "boxes", "sum"]),
        wrap=rng.choice([0.0, 0.0, 0.15, 0.4]),
        descending=rng.random() < 0.2,
        noise=[n for n in ("rewards", "terms", "gst", "message", "emi", "note", "apply") if rng.random() < 0.3],
        size=rng.choice([7.5, 8.0, 8.5, 9.0]),
        amount_low=rng.random() < 0.25,
        rounded=kind == "statement" and rng.random() < 0.2,
        shift=rng.uniform(4, 20) * rng.choice([-1, 1]) if rng.random() < 0.2 else 0.0,
        totals=kind == "export" and rng.random() < 0.4,
        months=kind == "export" and rng.random() < 0.3,
    )


def _rows(rng: random.Random, start: date, end: date, style: Style) -> list[Row]:
    span = (end - start).days
    n = rng.randint(4, 35) if style.kind == "statement" else rng.randint(8, min(150, 8 + span // 2))
    rows = []
    for _ in range(n):
        day = start + timedelta(days=rng.randint(1, span))
        clock = f"{rng.randint(0, 23):02d}:{rng.randint(0, 59):02d}" if style.time != "none" else ""
        roll = rng.random()
        shop = rng.choice(SHOPS)
        if roll < 0.08:
            details, amount, credit = rng.choice(PAYMENTS), round(rng.uniform(2000, 60000), 2), True
        elif roll < 0.14:
            details, amount, credit = rng.choice(REFUNDS).format(shop=shop), round(rng.uniform(50, 3000), 2), True
        elif roll < 0.18:
            details, amount, credit = rng.choice(CASHBACKS), round(rng.uniform(5, 500), 2), True
        else:
            details = rng.choice([f"{shop}", f"{shop},{rng.choice(CITIES)}", f"{shop} {rng.choice(CITIES)}",
                                  f"UPI-{shop}-{shop.split()[-1].lower()}@okfake", f"PYU*{shop} {rng.choice(CITIES)}",
                                  f"{shop} USD {rng.randint(5, 90)}.{rng.randint(10, 99)}", f"{shop} EMI {rng.randint(1, 9)}/12"])
            amount = round(rng.choice([rng.uniform(10, 900), rng.uniform(100, 5000), rng.uniform(1000, 80000)]), 2)
            if rng.random() < 0.15:
                amount = float(round(amount))  # ".00"
            credit = False
        more = rng.choice(CITIES) + " IN" if rng.random() < style.wrap else ""
        rows.append(Row(day, clock, details, amount, credit, more))
    rows.sort(key=lambda r: (r.day, r.clock), reverse=style.descending)
    if style.credits == "words":  # credits told apart only by what they say: never a plain shop name
        rows = [r for r in rows if not r.credit or not r.details.startswith(tuple(SHOPS))]
    return rows


# ---- printing it --------------------------------------------------------------------------------------------


def money(v: float, style: Style, credit: bool = False, *, marks: bool = True) -> str:
    whole, paise = f"{abs(v):.2f}".split(".")
    if style.grouping == "indian" and len(whole) > 3:
        head, tail, groups = whole[:-3], whole[-3:], []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        whole = ",".join(([head] if head else []) + groups) + "," + tail
    elif style.grouping == "western":
        whole = f"{int(whole):,}"
    text = f"{style.currency}{whole}.{paise}"
    if not marks:
        return text
    c = style.credits
    if credit and c == "cr":
        return f"{text} Cr"
    if credit and c == "cr-glued":
        return f"{text}CR"
    if credit and c == "plus":
        return f"+ {text}"
    if credit and c == "minus":
        return f"-{text}"
    if credit and c == "parens":
        return f"({text})"
    if not credit and style.debits_marked:
        return f"{text} Dr" if c == "cr" else f"{text}DR"
    return text


def _date(d: date, style: Style) -> str:
    return d.strftime(style.date_fmt)


def _width(text: str, size: float) -> float:
    return _METRICS.text_length(text, fontsize=size)


HEADINGS = {
    "date": ["Date", "DATE", "Txn Date", "Transaction Date", "Tran Date"],
    "date+time": ["DATE & TIME", "Date & Time", "Date / Time"],
    "posted": ["Posting Date", "Post Date", "Value Date"],
    "foreign": ["Foreign Amount", "Intl. Amount", "Original Amount"],
    "ref": ["Ref No", "Reference", "Transaction ID", "SerNo."],
    "details": ["Transaction Details", "Description", "Particulars", "Narration", "Merchant Name", "TRANSACTION DESCRIPTION"],
    "category": ["Category", "Merchant Category", "Spend Category"],
    "points": ["Reward Points", "Points", "REWARDS", "Cash Points"],
    "amount": ["Amount", "Amount (Rs.)", "Amount (in ₹)", "AMOUNT", "Amount in INR", "Amt"],
    "debit": ["Debit", "Debits", "Withdrawal"],
    "credit": ["Credit", "Credits", "Deposit"],
    "mark": ["Dr/Cr", "Type", "CR/DR"],
    "pi": ["PI", ""],
    "card": ["Card Number", "Card No."],
    "balance": ["Balance", "Running Balance"],
}
WIDTHS = {"date": 78, "posted": 66, "foreign": 74, "ref": 96, "details": 210, "category": 80, "points": 46, "amount": 84, "debit": 76, "credit": 76,
          "mark": 34, "pi": 18, "card": 88, "balance": 84}
RIGHT = {"points", "amount", "debit", "credit", "balance", "foreign"}  # right-aligned, as figures are


class _Doc:
    """Pages of placed text."""

    def __init__(self, size: float) -> None:
        self.pages: list[list[tuple[float, float, str, float]]] = [[]]
        self.y = 50.0
        self.size = size

    def text(self, x: float, s: str, size: float | None = None, right: bool = False) -> None:
        size = size or self.size
        if s:
            self.pages[-1].append((x - _width(s, size) if right else x, self.y, s, size))

    def down(self, by: float | None = None) -> None:
        self.y += by if by is not None else self.size * 1.75

    def room(self, lines: int = 1) -> bool:
        return self.y + lines * self.size * 1.75 < 790

    def new_page(self) -> None:
        self.pages.append([])
        self.y = 50.0


def render(s: Statement, path: Path) -> Path:
    doc = _Doc(s.style.size)
    if s.style.kind == "year":
        _render_year(doc, s, random.Random(s.seed + 1))
        for i, page in enumerate(doc.pages):
            page.append((480, 820, f"Page {i + 1} of {len(doc.pages)}", 7))
        return _save(doc, path)
    for k, part in enumerate(s.parts or [s]):
        if k:
            doc.new_page()
        _render(doc, part, random.Random(part.seed + 1))
    for i, page in enumerate(doc.pages):
        page.append((480, 820, f"Page {i + 1} of {len(doc.pages)}", 7))
    return _save(doc, path)


def _render(doc: "_Doc", s: Statement, rng: random.Random) -> None:
    st = s.style
    title = "Fake Bank Credit Card Statement" if st.kind == "statement" else "Fake Bank Credit Card Transactions"
    doc.text(40, title, size=13)
    doc.down(20)
    doc.text(40, f"Card No: XXXX XXXX XXXX {s.last4}")
    doc.text(330, "MR FAKE CARDHOLDER")
    doc.down()
    if st.kind == "statement":
        _summary(doc, s, rng)
    else:
        if st.months:
            doc.text(40, f"Account Summary for the period from {s.period[0]:%B-%y} to {s.period[1]:%B-%y}".upper())
        else:
            doc.text(40, f"From {s.period[0]:%d/%m/%Y} To {s.period[1]:%d/%m/%Y}")
        doc.down()
        if st.totals:  # its totals, under labels that may wrap over two lines
            wrapped = rng.random() < 0.5
            labels = [("Purchases &", "Debits", s.debits), ("Payments &", "Credits", s.credits), ("Credit", "Limit", 300000.0)]
            for i, (first, second, _) in enumerate(labels):
                doc.text(40 + i * 120, first if wrapped else f"{first} {second}")
            doc.down(doc.size * 1.2)
            if wrapped:
                for i, (_, second, _) in enumerate(labels):
                    doc.text(50 + i * 120, second)
                doc.down(doc.size * 1.2)
            for i, (_, _, value) in enumerate(labels):
                doc.text(40 + i * 120, money(value, st, marks=False))
            doc.down()
        if s.running_from is not None:
            doc.text(40, f"Opening Balance {money(s.running_from, st, marks=False)}")
            doc.down()
    if "message" in st.noise:
        doc.down(6)
        doc.text(40, "IMPORTANT MESSAGES")
        doc.down()
        doc.text(40, f"Pay {money(1000, st, marks=False)} more to unlock offers valid till {s.period[1] + timedelta(days=40):%d/%m/%Y}")
        doc.down()
    if "rewards" in st.noise:
        doc.down(6)
        doc.text(40, "Reward Points Summary")
        doc.down()
        for label, n in (("Opening", rng.randint(0, 5000)), ("Earned", rng.randint(0, 900)), ("Closing", rng.randint(0, 6000))):
            doc.text(40, label)
            doc.text(140, f"{n:,}", right=True)
            doc.down()
    if "note" in st.noise:  # a note that names the terms in passing: not where they start
        doc.down(6)
        doc.text(40, "Fees and charges on your card are as per the Terms and Conditions on the bank's website; for example, a late fee.",
                 size=6.5)
        doc.down()
    if "apply" in st.noise and (st.header != "none" or st.credits == "section"):
        doc.text(40, "Terms and Conditions apply.")  # a line that looks like their heading: the table's own ends it
        doc.down()
    doc.down(10)
    _table(doc, s, rng)
    if "gst" in st.noise:
        if not doc.room(4):
            doc.new_page()
        doc.down(8)
        doc.text(40, "GST SUMMARY")
        doc.down()
        doc.text(40, "CGST")
        doc.text(200, money(round(rng.uniform(1, 90), 2), st, marks=False), right=True)
        doc.down()
    if "emi" in st.noise:
        if not doc.room(5):
            doc.new_page()
        doc.down(8)
        doc.text(40, "EMI Summary")
        doc.down()
        for x, label in ((40, "Booking Date"), (130, "Description"), (330, "Loan Amount"), (420, "Instalments Pending"), (540, "EMI")):
            doc.text(x, label)
        doc.down()
        for k in range(rng.randint(1, 3)):
            doc.text(40, f"{s.period[0] - timedelta(days=30 * (k + 1)):%d/%m/%Y}")
            doc.text(130, f"FAKE PHONE EMI {k + 1}")
            doc.text(400, money(round(rng.uniform(9000, 90000), 2), st, marks=False), right=True)
            doc.text(470, str(rng.randint(2, 11)))
            doc.text(560, money(round(rng.uniform(900, 9000), 2), st, marks=False), right=True)
            doc.down()
    if "terms" in st.noise:
        doc.new_page()
        doc.text(40, "Illustration of how interest is charged")
        doc.down()
        doc.text(40, "Date")
        doc.text(140, "Transaction")
        doc.text(400, "Amount", right=True)
        doc.down()
        for day, what, amount in ((date(2020, 1, 5), "Purchase of a fake gadget", 4000.0), (date(2020, 1, 20), "Statement date", 4000.0)):
            doc.text(40, f"{day:%d-%b-%y}")
            doc.text(140, what)
            doc.text(400, money(amount, st, marks=False), right=True)
            doc.down()


def _render_year(doc: "_Doc", s: Statement, rng: random.Random) -> None:
    st = s.style
    doc.text(40, "Fake Bank Year End Statement & Summary", size=13)
    doc.down(20)
    doc.text(40, f"Account Summary for the period from {s.period[0]:%B-%y} to {s.period[1]:%B-%y}".upper())
    doc.down()
    spent, paid = round(sum(m[1] for m in s.months), 2), round(sum(m[2] for m in s.months), 2)
    wrapped = rng.random() < 0.6
    labels = [("Card", "Number", f"XXXXXXXXXXXX{s.last4}"), ("Purchases &", "Debits", money(spent, st, marks=False)),
              ("Payments &", "Credits", money(paid, st, marks=False)), ("Credit", "Limit", money(300000, st, marks=False)),
              ("Monthly Statement", "Date", f"{s.day:02d}")]
    for i, (a, b, _) in enumerate(labels):
        doc.text(40 + i * 110, a if wrapped else f"{a} {b}", size=7)
    doc.down(8.5)
    if wrapped:
        for i, (_, b, _) in enumerate(labels):
            doc.text(48 + i * 110, b, size=7)
        doc.down(8.5)
    for i, (_, _, v) in enumerate(labels):
        doc.text(40 + i * 110, v, size=7.5)
    doc.down(22)
    doc.text(40, "Monthly Statement wise Summary", size=10)
    doc.down()
    form = rng.choice(["%b-%Y", "%B %Y", "%b-%y"])
    cols = [("Month", 40), ("Purchases & Debits", 200), ("Payments & Credits", 320), ("Total Amount Dues", 440)]
    for label, x in cols:
        doc.text(x, label, size=7)
    doc.down()
    for m, debit, credit, due in s.months:
        doc.text(40, m.strftime(form).upper() if form != "%B %Y" else m.strftime(form), size=7.5)
        for (_, x), v in zip(cols[1:], (debit, credit, due)):
            doc.text(x + 70, money(v, st, marks=False), size=7.5, right=True)
        doc.down()
    doc.down(14)
    doc.text(40, "Transaction Details - Primary Card Holder MR FAKE CARDHOLDER")
    doc.down()
    full = Statement(st, sorted(s.rows + s.after, key=lambda r: r.day, reverse=st.descending), s.period, None, None, None, None, s.last4, s.seed)
    _table(doc, full, rng)


def _summary(doc: _Doc, s: Statement, rng: random.Random) -> None:
    st = s.style
    figures = [
        (rng.choice(["Statement Date", "Statement Generation Date", "Statement Cycle"]), f"{s.statement_date:%d/%m/%Y}"),
        (rng.choice(["Payment Due Date", "Due Date"]), f"{s.due_date:%d/%m/%Y}"),
        (rng.choice(["Previous Balance", "Opening Balance", "Last Statement Balance"]), money(s.previous, st, marks=False)),
        (rng.choice(["Payments/Credits", "Payments & Credits"]), money(s.credits, st, marks=False)),
        (rng.choice(["Purchases/Debits", "Purchases & Charges"]), money(s.debits, st, marks=False)),
        (rng.choice(["Total Amount Due", "Total Dues", "Total Payment Due"]), money(s.total_due, st, marks=False)),
        ("Minimum Amount Due", money(round(max(200.0, s.total_due * 0.05), 2), st, marks=False)),
        ("Credit Limit", money(300000, st, marks=False)),
    ]
    if rng.random() < 0.5:
        figures.insert(0, ("Statement Period", f"{s.period[0]:%d/%m/%Y} to {s.period[1]:%d/%m/%Y}"))
    if st.summary == "sum":  # labels over a sum of the figures, and no statement date or period: only the due date
        glued = (lambda t: t.replace("C ", "C")) if st.currency == "C " else (lambda t: t)  # noqa: E731
        doc.down(6)
        for i, label in enumerate(["PREVIOUS STATEMENT DUES", "PAYMENTS/CREDITS RECEIVED", "PURCHASES/DEBITS", "FINANCE CHARGES",
                                   "TOTAL AMOUNT DUE"]):
            doc.text(40 + i * 110, label, size=6.5)
        doc.down()
        for i, (value, op) in enumerate(zip([s.previous, s.credits, s.debits, 0.0, s.total_due], [rng.choice(["-", "_"]), "+", "+", "=", ""])):
            doc.text(40 + i * 110, glued(money(value, st, marks=False)))
            doc.text(40 + i * 110 + 100, op)
        doc.down(22)
        for i, (label, value) in enumerate([("TOTAL CREDIT LIMIT", money(300000, st, marks=False)),
                                            ("AVAILABLE CREDIT LIMIT", money(round(300000 - s.total_due, 2), st, marks=False)),
                                            ("MINIMUM DUE", money(round(max(200.0, s.total_due * 0.05), 2), st, marks=False)),
                                            ("DUE DATE", f"{s.due_date:%d %b, %Y}")]):
            doc.text(40 + i * 135, label, size=6.5)
            doc.down()
            doc.text(40 + i * 135, glued(value))
            doc.down(-doc.size * 1.75)
        doc.down(2 * doc.size * 1.75)
        return
    if st.summary == "beside":
        for label, value in figures:
            doc.text(40, f"{label}: {value}")
            doc.down()
    elif st.summary == "below":
        for chunk in (figures[:4], figures[4:]):
            for i, (label, _) in enumerate(chunk):
                doc.text(40 + i * 135, label)
            doc.down()
            for i, (_, value) in enumerate(chunk):
                doc.text(40 + i * 135, value)
            doc.down(22)
    else:  # boxes: two columns of label / value pairs
        for i in range(0, len(figures), 2):
            for j, (label, value) in enumerate(figures[i:i + 2]):
                doc.text(40 + j * 270, label)
                doc.text(40 + j * 270 + 250, value, right=True)
            doc.down()


def _table(doc: _Doc, s: Statement, rng: random.Random) -> None:
    st = s.style
    widths = dict(WIDTHS)
    longest = max((_width(_date(r.day, st) + ("| 00:00" if st.time in ("pipe", "pipe-space", "word") else ""), st.size) for r in s.rows), default=0)
    widths["date"] = max(widths["date"], longest + 12)  # a column is as wide as what it holds
    x, starts = 40.0, {}
    for col in st.columns:
        starts[col] = x
        x += widths[col]
    first_page = len(doc.pages)
    headings = {col: rng.choice(HEADINGS["date+time" if col == "date" and st.time != "none" and rng.random() < 0.5 else col])
                for col in st.columns}
    for col, label in headings.items():  # a heading fits over its column: a bank's header cells never run together
        if _width(label, st.size) + 8 > widths[col]:
            headings[col] = min(HEADINGS[col], key=lambda h: _width(h, st.size))

    def at(col: str) -> float:
        x = starts[col] + widths[col] - 6 if col in RIGHT else starts[col]
        return x + (st.shift if len(doc.pages) == first_page else 0.0)

    def header() -> None:
        if st.header == "none":
            return
        for col in st.columns:
            label = headings[col]
            if st.header == "two-lines" and col in ("amount", "debit", "credit") and " (" in label:
                label = label.split(" (")[0]
            doc.text(at(col), label, right=col in RIGHT)
        if st.header == "two-lines":
            doc.down(doc.size * 1.2)
            for col in ("amount", "debit", "credit"):
                if col in st.columns and " (" in headings[col]:
                    doc.text(at(col), "(" + headings[col].split(" (")[1], right=True)
        doc.down()

    sections = [("", s.rows)]
    if st.credits == "section":
        sections = [("Purchases & Other Debits", [r for r in s.rows if not r.credit]),
                    ("Payments & Credits", [r for r in s.rows if r.credit])]
    header()
    balance = s.running_from
    for title, rows in sections:
        if title:
            doc.text(40, title)
            doc.down()
        for r in rows:
            lines = 1 + bool(r.more) + (st.time == "below")
            if not doc.room(lines):
                doc.new_page()
                doc.text(40, "Fake Bank Credit Card Statement")
                doc.down()
                if st.header == "every-page":
                    header()
            if balance is not None:  # what's owed after this row, in the order the rows are printed
                balance = round(balance + (-r.amount if r.credit else r.amount), 2)
            _row(doc, s, r, at, rng, balance)


def _row(doc: _Doc, s: Statement, r: Row, at, rng: random.Random, balance: float | None) -> None:
    st = s.style
    day = _date(r.day, st)
    if st.time == "word" and r.clock:
        day = f"{day} {r.clock}"
    elif st.time == "pipe" and r.clock:
        day = f"{day}|{r.clock}"
    elif st.time == "pipe-space" and r.clock:
        day = f"{day}| {r.clock}"
    doc.text(at("date"), day)
    low = st.amount_low and bool(r.more)  # the amount sits on the row's second line, beside the rest of its description
    for col in st.columns:
        if col == "posted":
            doc.text(at(col), _date(r.day + timedelta(days=rng.randint(0, 2)), st) if st.date_fmt not in YEARLESS else "")
        elif col == "foreign":
            if not r.credit and rng.random() < 0.25:
                doc.text(at(col), f"USD {round(r.amount / 83, 2):.2f}", right=True)
        elif col == "ref":
            doc.text(at(col), f"9{rng.randint(10**11, 10**12 - 1)}")
        elif col == "details":
            doc.text(at(col), r.details[:44])
        elif col == "category":
            doc.text(at(col), rng.choice(["RESTAURANTS", "GROCERY", "TRAVEL", "FUEL", "SHOPPING"]) if not r.credit else "")
        elif col == "points":
            doc.text(at(col), "" if r.credit else rng.choice([f"+ {int(r.amount // 100)}", f"{int(r.amount // 100)}"]), right=True)
        elif col == "amount" and not low:
            doc.text(at(col), money(r.amount, st, r.credit), right=True)
        elif col == "debit" and not r.credit and not low:
            doc.text(at(col), money(r.amount, st, marks=False), right=True)
        elif col == "credit" and r.credit and not low:
            doc.text(at(col), money(r.amount, st, marks=False), right=True)
        elif col == "mark":
            doc.text(at(col), "Cr" if r.credit else "Dr")
        elif col == "pi":
            doc.text(at(col), rng.choice(["l", "•", "R"]))
        elif col == "card":
            doc.text(at(col), f"400000XXXXXX{s.last4}")
        elif col == "balance" and balance is not None:
            doc.text(at(col), money(balance, st, marks=False) + (" Cr" if balance < 0 else ""), right=True)
    doc.down()
    if st.time == "below" and r.clock:
        doc.text(at("date"), r.clock)
        doc.down()
    if r.more:
        doc.text(at("details"), r.more)
        if low:
            for col in ("amount", "debit", "credit"):
                if col in st.columns and (col == "amount" or (col == "credit") == r.credit):
                    doc.text(at(col), money(r.amount, st, r.credit) if col == "amount" else money(r.amount, st, marks=False), right=True)
        doc.down()


def _save(doc: _Doc, path: Path) -> Path:
    pdf = pymupdf.open()
    for items in doc.pages:
        page = pdf.new_page(width=600, height=842)
        fontname = "helv"
        if FONT.exists():
            page.insert_font(fontname="hv", fontfile=str(FONT))
            fontname = "hv"
        for x, y, text, size in items:
            page.insert_text((x, y), text, fontsize=size, fontname=fontname)
    pdf.save(path)
    pdf.close()
    return path
