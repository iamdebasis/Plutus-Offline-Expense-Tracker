"""Fake credit card statements in the layouts Indian banks use (fake data only): text placed in columns the way a
bank's PDF does, so the reader meets real layouts without anyone's statement.

Every layout carries the same month of fake activity (ROWS) and prints a summary that adds up to it, so the
reader's check against the bank's totals can pass; `tamper` changes one printed amount so it can fail."""

from dataclasses import dataclass
from datetime import date
from pathlib import Path

import pymupdf

FONT = Path("/System/Library/Fonts/Helvetica.ttc")  # has the ₹ glyph


@dataclass
class Txn:
    day: date
    details: str
    category: str
    amount: float
    credit: bool = False


ROWS = [
    Txn(date(2026, 8, 14), "FAKE FOOD APP,PUNE", "RESTAURANTS", 450.00),
    Txn(date(2026, 8, 16), "PYU*FAKE GROCER BANGALORE", "DEPT STORES", 1234.50),
    Txn(date(2026, 8, 18), "FAKE AIRWAYS MUMBAI IN", "AIRLINES", 8999.00),
    Txn(date(2026, 8, 20), "FOREIGN CURRENCY TRANSACTION FEE", "", 45.30),
    Txn(date(2026, 8, 20), "GST", "", 8.15),
    Txn(date(2026, 8, 22), "PAYMENT RECEIVED - THANK YOU", "", 9000.00, credit=True),
    Txn(date(2026, 8, 25), "REFUND FAKE FOOD APP", "", 200.00, credit=True),
    Txn(date(2026, 8, 26), "FAKE CHAI POINT,PUNE", "RESTAURANTS", 60.00),
    Txn(date(2026, 8, 26), "FAKE CHAI POINT,PUNE", "RESTAURANTS", 60.00),  # the same twice: two cups, two rows
    Txn(date(2026, 9, 1), "CASHBACK CREDIT", "", 50.00, credit=True),
    Txn(date(2026, 9, 2), "WWW.FAKESTREAM.COM", "", 1105.32),
]
PREVIOUS = 9000.00
DEBITS = round(sum(t.amount for t in ROWS if not t.credit), 2)
CREDITS = round(sum(t.amount for t in ROWS if t.credit), 2)
TOTAL_DUE = round(PREVIOUS - CREDITS + DEBITS, 2)
LAST4 = "3141"


def inr(v: float) -> str:
    whole, paise = f"{v:.2f}".split(".")
    n = whole
    if len(n) > 3:  # Indian grouping: 1,23,456.78
        head, tail = n[:-3], n[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        n = ",".join(groups) + "," + tail
    return f"{n}.{paise}"


class Page:
    def __init__(self) -> None:
        self.items: list[tuple[float, float, str, float]] = []
        self.y = 60.0

    def at(self, x: float, text: str, size: float = 9, y: float | None = None) -> "Page":
        self.items.append((x, self.y if y is None else y, text, size))
        return self

    def down(self, by: float = 15) -> "Page":
        self.y += by
        return self


def save(path: Path, pages: list[Page], password: str | None = None) -> Path:
    doc = pymupdf.open()
    for p in pages:
        page = doc.new_page(width=600, height=842)
        fontname = "helv"
        if FONT.exists():
            page.insert_font(fontname="hv", fontfile=str(FONT))
            fontname = "hv"
        for x, y, text, size in p.items:
            page.insert_text((x, y), text, fontsize=size, fontname=fontname)
    kwargs = {"encryption": pymupdf.PDF_ENCRYPT_AES_256, "user_pw": password, "owner_pw": password + "-o"} if password else {}
    doc.save(path, **kwargs)
    doc.close()
    return path


def _rows(rows: list[Txn], tamper: bool) -> list[Txn]:
    out = [Txn(t.day, t.details, t.category, t.amount, t.credit) for t in rows]
    if tamper:
        out[2].amount = 8899.00  # one printed amount differs from what the summary adds up to
    return out


def axis(path: Path, tamper: bool = False, password: str | None = None, undated_credit: bool = False,
         rows: list[Txn] | None = None) -> Path:
    """Summary labels in a row with the figures beneath; DATE | TRANSACTION DETAILS | MERCHANT CATEGORY | AMOUNT
    with Dr / Cr; '**** End of Statement ****'; the card number again in the footer. `rows`: other activity than
    ROWS (the summary adds up to it)."""
    rows = ROWS if rows is None else rows
    debits = round(sum(t.amount for t in rows if not t.credit), 2)
    credits = round(sum(t.amount for t in rows if t.credit), 2)
    paid = round(sum(t.amount for t in rows if t.credit and t.details.startswith("PAYMENT")), 2)
    due = round(PREVIOUS - credits + debits, 2)
    p = Page()
    p.at(40, "Axis Bank", 14).down(18).at(40, "Credit Card Statement").down()
    p.at(40, "Card No: 4000 00XX XXXX 3141").down()
    p.at(40, "Statement Period: 13/08/2026 To 12/09/2026").down()
    p.at(40, "Statement Generation Date: 12/09/2026").at(300, "Payment Due Date: 02/10/2026").down()
    p.at(40, "Credit Limit: 3,00,000.00").at(300, "Minimum Amount Due: 1,000.00 Dr").down(22)
    labels = [(40, "Previous Balance"), (120, "Payments"), (180, "Credits"), (235, "Purchase"), (295, "Cash Advance"),
              (370, "Other Debit & Charges"), (480, "Total Payment Due")]
    for x, label in labels:
        p.at(x, label, 8)
    p.down(13)
    for (x, _), v in zip(labels, [f"{inr(PREVIOUS)} Dr", inr(paid), inr(credits - paid), inr(debits - 79.00), "0.00", inr(79.00),
                                  f"{inr(due)} Dr"]):
        p.at(x, v, 8)
    p.down(28)
    p.at(40, "DATE").at(110, "TRANSACTION DETAILS").at(330, "MERCHANT CATEGORY").at(470, "AMOUNT (Rs.)").down()
    for t in _rows(rows, tamper):
        if undated_credit and t.details == "CASHBACK CREDIT":
            p.down(6).at(110, t.details).at(480, f"{inr(t.amount)} Cr").down()  # a row in a shape the reader doesn't expect
            continue
        p.at(40, t.day.strftime("%d/%m/%Y")).at(110, t.details).at(330, t.category).at(480, f"{inr(t.amount)} {'Cr' if t.credit else 'Dr'}").down()
    p.down(10).at(220, "**** End of Statement ****").down(30)
    p.at(40, "Your cheque should be payable to Axis Bank Card No.400000******3141 .", 7).down()
    p.at(40, "IMPORTANT MESSAGE", 8).down().at(40, "Some terms will change w.e.f. 15-07-2026. Visit the bank's site.", 7)
    return save(path, [p], password)


def hdfc(path: Path) -> Path:
    """Domestic and international sections; 'Amount (in Rs.)' with Cr after credits; a description that wraps; a
    reward points table after the transactions."""
    p = Page()
    p.at(40, "HDFC Bank Credit Card Statement", 13).down(20)
    p.at(40, "Card No: 4000 12XX XXXX 3141").at(320, "Statement Date: 12/09/2026").down()
    p.at(40, "Payment Due Date: 02/10/2026").at(320, "Credit Limit: 3,00,000").down(22)
    labels = [(40, "Opening Balance"), (140, "Payment/Credits"), (250, "Purchase/Debits"), (360, "Finance Charges"), (470, "Total Dues")]
    for x, label in labels:
        p.at(x, label, 8)
    p.down(13)
    for (x, _), v in zip(labels, [inr(PREVIOUS), inr(CREDITS), inr(DEBITS), "0.00", inr(TOTAL_DUE)]):
        p.at(x, v, 8)
    p.down(28).at(40, "Domestic Transactions", 10).down(16)
    p.at(40, "Date").at(120, "Transaction Description").at(480, "Amount (in Rs.)").down()
    domestic = [t for t in ROWS if "FAKESTREAM" not in t.details]
    for t in domestic:
        details = "FAKE AIRWAYS BOOKING REF" if "AIRWAYS" in t.details else t.details
        p.at(40, t.day.strftime("%d/%m/%Y")).at(120, details).at(480, f"{inr(t.amount)}{' Cr' if t.credit else ''}").down()
        if "AIRWAYS" in t.details:
            p.down(-3).at(120, "MUMBAI IN").down()  # the description wraps onto a second line
    p.down(12).at(40, "International Transactions", 10).down(16)
    p.at(40, "Date").at(120, "Transaction Description").at(480, "Amount (in Rs.)").down()
    p.at(40, "02/09/2026").at(120, "WWW.FAKESTREAM.COM USD 12.99").at(480, inr(1105.32)).down(24)
    p.at(40, "Reward Points Summary", 10).down(14)
    p.at(40, "Opening Balance").at(160, "Earned").at(260, "Redeemed").at(360, "Closing Balance").down()
    p.at(40, "1,200").at(160, "340").at(260, "0").at(360, "1,540")
    return save(path, [p])


def icici(path: Path) -> Path:
    """Labels beside their figures; Date | SerNo. | Transaction Details | Reward Points | Intl.# amount | Amount (in ₹)
    with CR after credits and long serial numbers that aren't amounts."""
    p = Page()
    p.at(40, "ICICI Bank Credit Card Statement", 13).down(20)
    p.at(40, "Card Number 4000 XXXX XXXX 3141").down()
    p.at(40, "Statement Date September 12, 2026").at(320, "Payment Due Date October 2, 2026").down()
    p.at(40, f"Previous Balance ₹{inr(PREVIOUS)}").at(320, f"Total Amount due ₹{inr(TOTAL_DUE)}").down()
    p.at(40, "Minimum Amount due ₹1,000.00").at(320, "Credit Limit ₹3,00,000.00").down(24)
    p.at(40, "Date").at(100, "SerNo.").at(170, "Transaction Details").at(370, "Reward Points").at(440, "Intl.# amount").at(510, "Amount (in ₹)").down()
    for n, t in enumerate(ROWS):
        p.at(40, t.day.strftime("%d/%m/%Y")).at(100, f"{8800000000 + n}").at(170, t.details)
        p.at(370, "0" if t.credit else str(int(t.amount // 100))).at(510, f"{inr(t.amount)}{' CR' if t.credit else ''}").down()
    return save(path, [p])


def sbi(path: Path) -> Path:
    """Dates like '14 Aug 26'; amounts followed by D or C as a word of their own."""
    p = Page()
    p.at(40, "SBI Card", 13).down(18).at(40, "Credit Card Statement").down()
    p.at(40, "Credit Card Number XXXX XXXX XXXX 3141").down()
    p.at(40, "Statement Date 12 Sep 2026").at(320, "Payment Due Date 02 Oct 2026").down()
    p.at(40, f"Previous Balance {inr(PREVIOUS)}").down().at(40, f"Total Amount Due {inr(TOTAL_DUE)}").down(24)
    p.at(40, "Date").at(120, "Transaction Details").at(480, "Amount (₹)").down()
    for t in ROWS:
        p.at(40, t.day.strftime("%d %b %y")).at(120, t.details).at(480, inr(t.amount)).at(545, "C" if t.credit else "D").down()
    return save(path, [p])


def plus_signs(path: Path) -> Path:
    """A bank the reader has no profile for: 'Txn Date | Particulars | Amount', dates like 'Aug 14, 2026', credits
    shown as '+ 9,000.00'."""
    p = Page()
    p.at(40, "Federal Bank Credit Card Statement", 13).down(20)
    p.at(40, "Card XXXX XXXX XXXX 3141").down()
    p.at(40, "Statement Date: 12/09/2026").down()
    p.at(40, f"Opening Balance: {inr(PREVIOUS)}").at(320, f"Total Amount Due: {inr(TOTAL_DUE)}").down(24)
    p.at(40, "Txn Date").at(140, "Particulars").at(490, "Amount").down()
    for t in ROWS:
        p.at(40, t.day.strftime("%b %d, %Y")).at(140, t.details).at(480, f"{'+ ' if t.credit else ''}{inr(t.amount)}").down()
    return save(path, [p])


def no_header(path: Path) -> Path:
    """No table header at all: each transaction is a line that starts with a date and ends with an amount."""
    p = Page()
    p.at(40, "Kotak Credit Card Statement", 13).down(20)
    p.at(40, "Card XXXX XXXX XXXX 3141").down()
    p.at(40, "Statement Date: 12/09/2026   Payment Due Date: 02/10/2026").down()
    p.at(40, f"Previous Balance: {inr(PREVIOUS)}   Total Amount Due: {inr(TOTAL_DUE)}").down(24)
    for t in ROWS:
        p.at(40, f"{t.day.strftime('%d/%m/%Y')}  {t.details}  {inr(t.amount)}{' Cr' if t.credit else ''}").down()
    return save(path, [p])


def two_pages(path: Path) -> Path:
    """The Axis layout over two pages: page 2 starts with the bank's own heading lines, then the header again."""
    first, second = Page(), Page()
    first.at(40, "Axis Bank", 14).down(18).at(40, "Credit Card Statement").down()
    first.at(40, "Card No: 4000 00XX XXXX 3141").down()
    first.at(40, "Statement Generation Date: 12/09/2026").at(300, "Payment Due Date: 02/10/2026").down()
    first.at(40, f"Previous Balance: {inr(PREVIOUS)} Dr").at(300, f"Total Payment Due: {inr(TOTAL_DUE)} Dr").down(24)
    for page, rows in ((first, ROWS[:6]), (second, ROWS[6:])):
        if page is second:
            page.at(40, "MR FAKE CARDHOLDER", 9).down().at(40, "Page 2 of 2").down(20)
        page.at(40, "DATE").at(110, "TRANSACTION DETAILS").at(330, "MERCHANT CATEGORY").at(470, "AMOUNT (Rs.)").down()
        for t in rows:
            page.at(40, t.day.strftime("%d/%m/%Y")).at(110, t.details).at(330, t.category).at(480, f"{inr(t.amount)} {'Cr' if t.credit else 'Dr'}").down()
    second.down(10).at(220, "**** End of Statement ****")
    return save(path, [first, second])


def datetime_rewards(path: Path) -> Path:
    """DATE & TIME | TRANSACTION DESCRIPTION | REWARDS | AMOUNT: each row's time beside its date, the points it earned
    before its amount, credits marked Cr."""
    p = Page()
    p.at(40, "Fake Bank Credit Card Statement", 13).down(20)
    p.at(40, "Card Number XXXX XXXX XXXX 3141").down()
    p.at(40, "Statement Date 12/09/2026").at(320, "Payment Due Date 02/10/2026").down()
    p.at(40, f"Opening Balance {inr(PREVIOUS)}").at(320, f"Total Amount Due {inr(TOTAL_DUE)}").down(24)
    p.at(40, "DATE & TIME").at(150, "TRANSACTION DESCRIPTION").at(400, "REWARDS").at(480, "AMOUNT").down()
    for n, t in enumerate(ROWS):
        p.at(40, f"{t.day:%d/%m/%Y} {9 + n % 9:02d}:{(7 * n) % 60:02d}").at(150, t.details).at(405, "0" if t.credit else f"+ {int(t.amount // 150)}")
        p.at(470, f"₹ {inr(t.amount)}{' Cr' if t.credit else ''}").down()
    return save(path, [p])


def addon_card(path: Path) -> Path:
    """The main card's transactions, then an add-on card's, each section headed by its own card number."""
    p = Page()
    p.at(40, "Fake Bank Credit Card Statement", 13).down(20)
    p.at(40, "Card No: XXXX XXXX XXXX 3141").down()
    p.at(40, "Statement Date: 12/09/2026").at(300, "Payment Due Date: 02/10/2026").down()
    p.at(40, f"Previous Balance: {inr(PREVIOUS)} Dr").at(300, f"Total Amount Due: {inr(TOTAL_DUE)} Dr").down(24)
    p.at(40, "Date").at(110, "Transaction Details").at(470, "Amount (Rs.)").down()
    p.at(40, "MR FAKE CARDHOLDER  XXXX XXXX XXXX 3141").down()
    for t in ROWS[:7]:
        p.at(40, t.day.strftime("%d/%m/%Y")).at(110, t.details).at(480, f"{inr(t.amount)} {'Cr' if t.credit else 'Dr'}").down()
    p.at(40, "MS FAKE ADDON  XXXX XXXX XXXX 2718").down()
    for t in ROWS[7:]:
        p.at(40, t.day.strftime("%d/%m/%Y")).at(110, t.details).at(480, f"{inr(t.amount)} {'Cr' if t.credit else 'Dr'}").down()
    return save(path, [p])


def debit_credit_columns(path: Path) -> Path:
    """Date | Description | Debit | Credit: which column an amount sits in says what it is."""
    p = Page()
    p.at(40, "Fake Bank Credit Card Statement", 13).down(20)
    p.at(40, "Card Number XXXX XXXX XXXX 3141").down()
    p.at(40, "Statement Date 12/09/2026").at(320, "Payment Due Date 02/10/2026").down()
    p.at(40, f"Previous Balance {inr(PREVIOUS)}").at(320, f"Total Amount Due {inr(TOTAL_DUE)}").down(24)
    p.at(40, "Date").at(120, "Description").at(400, "Debit").at(490, "Credit").down()
    for t in ROWS:
        p.at(40, t.day.strftime("%d-%m-%Y")).at(120, t.details).at(490 if t.credit else 400, inr(t.amount)).down()
    return save(path, [p])


def yearless_new_year(path: Path) -> Path:
    """Dates without their year ("28 Dec", "05 Jan") on January's statement: December's purchases are last year's."""
    p = Page()
    p.at(40, "Fake Bank Credit Card Statement", 13).down(20)
    p.at(40, "Card Number XXXX XXXX XXXX 3141").down()
    p.at(40, "Statement Date 12 Jan 2027").at(320, "Payment Due Date 01 Feb 2027").down()
    p.at(40, "Previous Balance 0.00").at(320, "Total Amount Due 1,350.00").down(24)
    p.at(40, "Date").at(120, "Transaction Details").at(480, "Amount (Rs.)").down()
    for day, details, amount in (("16 Dec", "FAKE GROCER", "600.00"), ("28 Dec", "FAKE AIRWAYS", "500.00"), ("05 Jan", "FAKE FOOD APP", "250.00")):
        p.at(40, day).at(120, details).at(480, amount).down()
    return save(path, [p])


def _width(text: str, size: float) -> float:
    return pymupdf.Font(fontfile=str(FONT)).text_length(text, fontsize=size) if FONT.exists() else 0.5 * size * len(text)


def points_after_amount(path: Path, raised: float = 2.5) -> Path:
    """Summary boxes with labels over their figures, and a cash points box beside the money one with a "Previous
    Balance" of its own on the same line; the statement dated by its "Statement Cycle"; boxes side by side above the
    table (messages, a GST summary with a little table of its own, the bank's app); a section title; Date |
    Transaction ID | Transaction Description | Amount in INR | Cash Points, the last two headings only 8pt apart, a long
    transaction ID after each date, the amount and its Dr / Cr apart, and the points a little higher than their row
    (`raised` points; a lot higher puts them on a line of their own). A second page of fees and terms has worked
    examples: tables with dates, amounts and a statement date of their own, none of them yours."""
    p = Page()
    p.at(40, "Credit Card Statement", 14).down(18).at(40, "MR FAKE CARDHOLDER").down()
    p.at(40, "Card Number: 4000 00XX XXXX 3141").at(300, "Statement Cycle: 12 September 2026").down()
    p.at(300, "Payment Due Date: 02 October 2026").down(22)
    for x, label in ((40, "Previous Balance:"), (300, "Previous Balance"), (400, "+42")):
        p.at(x, label if x != 40 else f"{label} ` {inr(PREVIOUS)}", 8)
    p.down(12)
    p.at(40, f"Payments/Credits: {inr(CREDITS)}", 8).at(300, "Earned Cash Points", 8).at(400, "+12", 8).down(12)
    p.at(40, f"Purchases/Debits: {inr(DEBITS)}", 8).at(300, "Closing Balance", 8).at(400, "54", 8).down(12)
    p.at(40, f"Minimum Amount Due: ` 1,000.00", 8).down(12).at(40, f"Total Amount Due: ` {inr(TOTAL_DUE)}", 8).down(26)
    p.at(40, "IMPORTANT MESSAGES", 10).at(250, "GST SUMMARY", 10).at(430, "DOWNLOAD THE CARD APP", 9).down(16)
    p.at(40, "Visit example.com/fake", 8).at(250, "Total GST", 8).at(300, "CGST", 8).at(340, "SGST", 8).at(380, "IGST", 8).at(430, "to spend", 8).down(12)
    p.at(40, "Paying only the minimum due every month", 8).at(250, "0.00", 8).at(300, "0.00", 8).at(340, "0.00", 8).at(380, "0.00", 8).down(12)
    p.at(40, "means paying interest on the rest.", 8).at(250, "PAYMENT OPTIONS", 10).down(12)
    p.at(40, "Place of supply: as your address", 8).at(250, "Netbanking", 8).at(340, "Debit Card", 8).down(24)
    p.at(230, "DOMESTIC TRANSACTIONS", 11).down(18)
    points_x = 445 + _width("Amount in INR", 9) + 8
    p.at(40, "Date").at(105, "Transaction ID").at(215, "Transaction Description").at(445, "Amount in INR").at(points_x, "Cash Points").down()
    for n, t in enumerate(ROWS):
        details = t.details.replace(",", ", ") + ("" if t.credit else ", IN")
        amount = inr(t.amount)
        p.at(40, t.day.strftime("%d-%m-%Y"), 8).at(105, f"{900000000000000000000 + n}", 8).at(215, details, 8)
        p.at(points_x - 30 - _width(amount, 8), amount, 8).at(points_x - 22, "Cr" if t.credit else "Dr", 8)
        p.at(points_x, str(int(t.amount // 100)), 7, y=p.y - raised).down()
    p.down(20).at(40, "DOWNLOAD THE CARD APP", 12).down().at(40, "Rewards · Offers · Statements", 8)

    terms = Page()
    terms.at(40, "Fees and Charges", 11).down()
    terms.at(40, "Late payment fee", 8).at(250, "` 100 for Total Amount Due up to ` 500", 8).down()
    terms.at(40, "Illustration of how interest is charged", 10).down()
    terms.at(40, "Sr. No.").at(80, "Date").at(140, "Transaction").at(260, "Amount").down()
    terms.at(40, "A").at(80, "05-Jan-20").at(140, "Purchase of a fake gadget").at(260, "` 4,000.00").down()
    terms.at(40, "B").at(80, "20-Jan-20").at(140, "Statement date").at(260, "` 4,000.00").down()
    terms.at(40, "For an account whose Statement Date is 20/01/2020 and Total Amount Due is ` 4,000.00").down()
    terms.at(40, "Interest Calculation Transaction Details", 10).down()
    terms.at(40, "Transaction Amount").at(140, "Period").at(200, "Date").at(260, "Transaction").at(360, "Amount").down()
    terms.at(40, "` 4,000").at(140, "05-Jan-20 - 20-Feb-20").at(260, "Late Payment Fees").at(360, "` 100.00").down()
    return save(path, [p, terms])


# ---- the bank's exports of a span (CSV, Excel, an HTML table saved as .xls) -------------------------------------

EXPORT_EXTRA = [  # a month either side of the statement's: the export spans more than one cycle
    Txn(date(2026, 7, 20), "FAKE BOOKSTORE MUMBAI", "BOOKS", 640.00),
    Txn(date(2026, 9, 20), "FAKE PETROL PUMP", "FUEL", 2000.00),
]


def _export_rows(rows: list[Txn], posted: int) -> list[Txn]:
    """The export's view of the rows: dated when they posted (`posted` days later), shops named its own way."""
    from datetime import timedelta

    return [Txn(t.day + timedelta(days=posted), t.details.replace(",", " "), t.category, t.amount, t.credit) for t in rows]


def csv_export(path: Path, style: str = "drcr", posted: int = 0, card: bool = True, rows: list[Txn] | None = None) -> Path:
    """A card's transactions as the bank's site exports them. `style`: "drcr" (an amount and a Dr/Cr column),
    "signed" (one amount, payments and refunds negative), "columns" (separate debit and credit columns)."""
    import csv

    rows = _export_rows(ROWS + EXPORT_EXTRA if rows is None else rows, posted)
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Axis Bank Credit Card Transactions" if style == "drcr" else "Credit Card Transactions"])
        if card:
            w.writerow(["Card Number", "4000 00XX XXXX 3141"])
        w.writerow(["From 15/07/2026 To 25/09/2026"])
        w.writerow([])
        if style == "drcr":
            w.writerow(["Sr No", "Transaction Date", "Posting Date", "Description", "Amount (INR)", "Dr/Cr"])
            for i, t in enumerate(rows, 1):
                w.writerow([i, t.day.strftime("%d/%m/%Y"), t.day.strftime("%d/%m/%Y"), t.details, f"{t.amount:.2f}", "Cr" if t.credit else "Dr"])
        elif style == "signed":
            w.writerow(["Date", "Transaction Details", "Merchant Category", "Amount"])
            for t in rows:
                w.writerow([t.day.strftime("%d-%b-%Y"), t.details, t.category, f"{-t.amount if t.credit else t.amount:.2f}"])
        else:
            w.writerow(["Date", "Narration", "Debit", "Credit"])
            for t in rows:
                w.writerow([t.day.isoformat(), t.details, "" if t.credit else inr(t.amount), inr(t.amount) if t.credit else ""])
        w.writerow([])
        w.writerow(["", "Total", f"{sum(t.amount for t in rows):.2f}"])
    return path


def html_xls_export(path: Path) -> Path:
    """The HTML table some banks download as ".xls"."""
    rows = _export_rows(ROWS + EXPORT_EXTRA, 0)
    body = "".join(f"<tr><td>{t.day:%d/%m/%Y}</td><td>{t.details}</td><td>{inr(t.amount)} {'Cr' if t.credit else 'Dr'}</td></tr>" for t in rows)
    path.write_text(f"<html><body><table><tr><td>Card No: 4000 00XX XXXX 3141</td></tr>"
                    f"<tr><th>Date</th><th>Transaction Details</th><th>Amount</th></tr>{body}</table></body></html>")
    return path


def xlsx_export(path: Path) -> Path:
    """An Excel workbook: dates as Excel stores them (day numbers in a date format), amounts as numbers, text in its
    shared-strings table."""
    import zipfile
    from xml.sax.saxutils import escape

    rows = _export_rows(ROWS + EXPORT_EXTRA, 0)
    strings: list[str] = []

    def s(text: str) -> str:
        if text not in strings:
            strings.append(text)
        return str(strings.index(text))

    def cell(ref: str, value, kind: str) -> str:
        if kind == "s":
            return f'<c r="{ref}" t="s"><v>{s(value)}</v></c>'
        if kind == "date":
            return f'<c r="{ref}" s="1"><v>{(value - date(1899, 12, 30)).days}</v></c>'
        return f'<c r="{ref}"><v>{value}</v></c>'

    sheet = [f'<row r="1">{cell("A1", "Card Number: 4000 00XX XXXX 3141", "s")}</row>',
             f'<row r="3">{cell("A3", "Transaction Date", "s")}{cell("B3", "Details", "s")}{cell("C3", "Amount", "s")}{cell("D3", "Type", "s")}</row>']
    for i, t in enumerate(rows, 4):
        sheet.append(f'<row r="{i}">{cell(f"A{i}", t.day, "date")}{cell(f"B{i}", t.details, "s")}{cell(f"C{i}", t.amount, "n")}'
                     f'{cell(f"D{i}", "Credit" if t.credit else "Debit", "s")}</row>')
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    rel = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        z.writestr("xl/workbook.xml", f'<?xml version="1.0"?><workbook {ns} {rel}><sheets><sheet name="Transactions" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr("xl/styles.xml", f'<?xml version="1.0"?><styleSheet {ns}><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>')
        z.writestr("xl/worksheets/sheet1.xml", f'<?xml version="1.0"?><worksheet {ns}><sheetData>{"".join(sheet)}</sheetData></worksheet>')
        z.writestr("xl/sharedStrings.xml", f'<?xml version="1.0"?><sst {ns}>' + "".join(f"<si><t>{escape(x)}</t></si>" for x in strings) + "</sst>")
    return path
