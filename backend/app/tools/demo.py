"""A year of made-up spending, read by Plutus as if it were yours: `make demo` (and the README's screenshots).

Everything in it is invented. Shops are well-known brands (the same for everyone) or plainly fake names; people
are "Mr Fake …"; the cards end in 1111, 2222 and 3333; reference numbers start with 9000. It runs Plutus on a
folder of its own (.demo/data, never data/) and its own port, with the local AI off, so it never touches your data
or your model. Each run starts from nothing.

    ET_DATA_DIR=.demo/data ET_PORT=8001 python -m app.tools.demo      (make demo does this)

With --screenshots it photographs the dashboard for the README (scripts/screenshots.mjs) and stops.
"""

import os
import random
import shutil
import subprocess
import sys
import threading
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

import httpx
import pymupdf
import uvicorn

from app import userdata
from app.config import ROOT, settings

FONT = Path("/System/Library/Fonts/Helvetica.ttc")  # has the ₹ glyph
FIRST, LAST = date(2025, 10, 1), date(2026, 9, 30)
STATEMENT_DAY = 12  # the fake SBI card is billed on the 12th; its last three statements are in the demo


@dataclass
class Payment:
    """A UPI payment as PhonePe lists it."""

    at: datetime
    payee: str
    amount: float
    account: str = "XX1111"  # the fake bank account; "XXXX22" is the fake RuPay card on UPI
    verb: str = "Paid to"  # or "Refund from", "Received from"; cashback has its own wording


@dataclass
class CardRow:
    day: date
    details: str
    category: str
    amount: float
    credit: bool = False


@dataclass
class Bill:
    at: datetime
    card: str  # as CRED titles it: "HDFC BANK 2222"
    amount: float


@dataclass
class Year:
    upi: list[Payment] = field(default_factory=list)
    bills: list[Bill] = field(default_factory=list)
    statements: list[tuple[date, date, list[CardRow], float, float]] = field(default_factory=list)  # from, to, rows, previous, due


def _days():
    d = FIRST
    while d <= LAST:
        yield d
        d += timedelta(days=1)


def _at(rng: random.Random, d: date, early: int = 8, late: int = 22) -> datetime:
    return datetime(d.year, d.month, d.day, rng.randint(early, late), rng.randint(0, 59))


def make_year(seed: int = 7) -> Year:
    rng = random.Random(seed)
    y = Year()
    pay = lambda d, payee, amount, **kw: y.upi.append(Payment(_at(rng, d), payee, round(amount, 2), **kw))  # noqa: E731

    for d in _days():
        summer = d.month in (4, 5, 6)
        if d.day == 3:
            pay(d, "Mr Fake Landlord", 22000 if d < date(2026, 4, 1) else 23500)
        if d.day == 5:
            pay(d, "Airtel", 799)
        if d.day == 7:
            pay(d, "Zerodha Broking", 5000)  # a monthly SIP: an investment, left out of spending unless you count it
        if d.day == 9:
            pay(d, "Netflix", 649)
        if d.day == 12:
            pay(d, "TATA POWER", rng.uniform(2100, 2900) if summer else rng.uniform(900, 1600))
        if d.day == 14:
            pay(d, "Spotify", 119)
        if d.day == 21:
            pay(d, "Jio", 299)
        if d.day == 18 and d.month % 2 == 0:
            pay(d, "DELHI JAL BOARD", rng.uniform(300, 600))
        if d.weekday() == 5:
            pay(d, "BigBasket", rng.uniform(900, 2400), account="XXXX22" if rng.random() < 0.3 else "XX1111")
        if d.day == 26:
            pay(d, "DMart", rng.uniform(1500, 3500))
        if rng.random() < 0.28:
            pay(d, rng.choice(["Blinkit", "Zepto", "Swiggy Instamart"]), rng.uniform(150, 700))
        if rng.random() < 0.42:
            pay(d, rng.choice(["Swiggy", "Zomato"]), rng.uniform(180, 650), account="XXXX22" if rng.random() < 0.25 else "XX1111")
        if rng.random() < 0.07:
            pay(d, "Starbucks", rng.uniform(350, 520))
        if rng.random() < 0.1:
            pay(d, "Chaayos", rng.uniform(120, 260))
        if rng.random() < 0.13:
            pay(d, "Uber", rng.uniform(140, 480))
        if rng.random() < 0.2:
            pay(d, "Rapido", rng.uniform(40, 130))
        if rng.random() < 0.065:
            pay(d, "Indian Oil", rng.uniform(500, 1500))
        if rng.random() < 0.035:
            pay(d, "Apollo Pharmacy", rng.uniform(200, 900))
        if rng.random() < 0.06:
            pay(d, "Amazon", rng.uniform(400, 4000), account="XXXX22" if rng.random() < 0.3 else "XX1111")
        if rng.random() < 0.015:
            pay(d, "Myntra", rng.uniform(900, 2500))
        if rng.random() < 0.06:
            pay(d, "Mr Fake Friend", rng.uniform(200, 1500))
        if rng.random() < 0.012:
            pay(d, "Ms Fake Sister", rng.uniform(1000, 3000))
        if rng.random() < 0.03:
            pay(d, "Sri Fake Provision Store", rng.uniform(80, 400))
        if rng.random() < 0.02:
            pay(d, "Fake Hair Studio", rng.uniform(250, 700))
        if d.day == 15 and rng.random() < 0.6:
            y.upi.append(Payment(_at(rng, d), "Cashback Received", round(rng.uniform(5, 60), 2), account="Gift Card", verb=""))

    # some orders come back: refunded in full a few days later, to where they were paid from
    for p in [p for p in y.upi if p.payee in ("Swiggy", "Zomato", "Amazon")]:
        if rng.random() < 0.05 and p.at.date() + timedelta(days=3) <= LAST:
            y.upi.append(Payment(p.at + timedelta(days=rng.randint(1, 3), hours=1), p.payee, p.amount, account=p.account, verb="Refund from"))

    _cards(y, rng)
    y.upi.sort(key=lambda p: p.at)
    return y


def _cards(y: Year, rng: random.Random) -> None:
    """Three fake cards: a RuPay card used on UPI (••2222, bills only), a Visa card (••3333, bills only) and a card
    with monthly statements for its last three cycles (••1111). Each bill is paid in CRED, from the bank account
    over UPI (the same minute), as people do."""
    month_starts = [date(FIRST.year + (FIRST.month - 1 + i) // 12, (FIRST.month - 1 + i) % 12 + 1, 1) for i in range(13)]

    for start in month_starts[1:]:
        # the RuPay card: what was paid with it on UPI in the month before, plus purchases with its number
        paid = start.replace(day=20)
        if paid <= LAST:
            cycle = (paid - timedelta(days=40), paid - timedelta(days=10))
            on_upi = sum(p.amount for p in y.upi if p.account == "XXXX22" and cycle[0] <= p.at.date() <= cycle[1] and p.verb == "Paid to")
            y.bills.append(Bill(_at(rng, paid, 9, 20), "HDFC BANK 2222", round(on_upi + rng.uniform(1500, 5000), 2)))
        visa = start.replace(day=6)
        if visa <= LAST:
            y.bills.append(Bill(_at(rng, visa, 9, 20), "ICICI BANK 3333", round(rng.uniform(3000, 12000), 2)))

    # the statement card: a cycle from the 13th to the 12th, its bill paid on the 25th
    shops = [("AMAZON PAY INDIA", "ONLINE SHOPPING"), ("FLIPKART INTERNET", "ONLINE SHOPPING"), ("MAKEMYTRIP INDIA", "TRAVEL"),
             ("INDIGO AIRLINES", "AIRLINES"), ("CROMA RETAIL", "ELECTRONICS"), ("DECATHLON SPORTS", "SPORTS"),
             ("BOOKMYSHOW", "ENTERTAINMENT"), ("STARBUCKS COFFEE", "RESTAURANTS"), ("IKEA INDIA", "HOME FURNISHING"),
             ("UBER INDIA", "TRANSPORT")]
    previous = 0.0
    for i, start in enumerate(month_starts[:-1]):
        frm = start.replace(day=STATEMENT_DAY + 1)
        nxt = month_starts[i + 1]
        to = nxt.replace(day=STATEMENT_DAY)
        if to > LAST:
            break
        rows = []
        for _ in range(rng.randint(5, 10)):
            name, category = rng.choice(shops)
            rows.append(CardRow(frm + timedelta(days=rng.randint(0, (to - frm).days)), f"{name} MUMBAI", category, round(rng.uniform(300, 8000), 2)))
        if rng.random() < 0.4:
            fee = round(rng.uniform(20, 120), 2)
            rows += [CardRow(to - timedelta(days=2), "FOREIGN CURRENCY TRANSACTION FEE", "", fee), CardRow(to - timedelta(days=2), "GST", "", round(fee * 0.18, 2))]
        if rng.random() < 0.5:
            back = rng.choice([r for r in rows if r.category])
            rows.append(CardRow(min(to, back.day + timedelta(days=3)), f"REFUND {back.details}", "", back.amount, credit=True))
        if previous:
            rows.append(CardRow(frm + timedelta(days=11), "PAYMENT RECEIVED - THANK YOU", "", previous, credit=True))
        if rng.random() < 0.5:
            rows.append(CardRow(to - timedelta(days=1), "CASHBACK CREDIT", "", round(rng.uniform(25, 150), 2), credit=True))
        rows.sort(key=lambda r: r.day)
        due = round(previous - sum(r.amount for r in rows if r.credit) + sum(r.amount for r in rows if not r.credit), 2)
        y.statements.append((frm, to, rows, previous, due))
        paid = to + timedelta(days=13)
        if paid <= LAST:
            y.bills.append(Bill(_at(rng, paid, 9, 20), "SBI CARD 1111", due))
        previous = due

    for b in y.bills:  # the UPI side of each bill: paid to CRED from the bank account, the same minute
        y.upi.append(Payment(b.at, "CRED Club", b.amount))


# ---- the files, the way the apps and banks print them ------------------------------------------------------


def _pdf(path: Path, pages: list[list[tuple[float, float, str, float]]]) -> Path:
    doc = pymupdf.open()
    for items in pages:
        page = doc.new_page(width=600, height=842)
        font = "helv"
        if FONT.exists():
            page.insert_font(fontname="hv", fontfile=str(FONT))
            font = "hv"
        for x, y, text, size in items:
            page.insert_text((x, y), text, fontsize=size, fontname=font)
    doc.save(path)
    doc.close()
    return path


def phonepe_statement(path: Path, upi: list[Payment]) -> Path:
    pages: list[list] = []
    items: list = [(40, 50, "Transaction Statement for 9800000000", 11), (40, 66, f"{FIRST:%b %d, %Y} - {LAST:%b %d, %Y}", 9),
                   (40, 86, "Date", 9), (150, 86, "Transaction Details", 9), (420, 86, "Type", 9), (500, 86, "Amount", 9)]
    y = 110
    for n, p in enumerate(sorted(upi, key=lambda p: p.at, reverse=True)):
        if y > 780:
            pages.append(items)
            items, y = [], 50
        credit = p.verb in ("Refund from", "Received from") or p.payee == "Cashback Received"
        detail = p.payee if p.payee == "Cashback Received" else f"{p.verb} {p.payee}"
        utr = f"{900000000000 + n}"
        items += [(40, y, f"{p.at:%b %d, %Y}", 9), (40, y + 12, p.at.strftime("%I:%M %p"), 8), (150, y, detail, 9),
                  (150, y + 12, f"Transaction ID : T{p.at:%y%m%d%H%M}{n:08d}", 7),
                  (420, y, "Credit" if credit else "Debit", 9), (500, y, f"INR {p.amount:,.2f}", 9)]
        if p.payee != "Cashback Received":
            items.append((150, y + 22, f"UTR No : {utr}", 7))
        items.append((150, y + 32, f"{'Credited to' if credit else 'Debited from'} {p.account}", 7))
        y += 48
    pages.append(items)
    return _pdf(path, pages)


def cred_history(path: Path, bills: list[Bill]) -> Path:
    pages: list[list] = []
    items: list = [(93, 70, "transaction statement", 18), (93, 98, f"{FIRST:%d %b %Y} - {LAST:%d %b %Y}", 10.8),
                   (49, 163, "date", 10.8), (142, 163, "transaction details", 10.8), (508, 163, "amount", 10.8)]
    y = 205
    for n, b in enumerate(sorted(bills, key=lambda b: b.at, reverse=True)):
        if y > 780:
            pages.append(items)
            items, y = [], 70
        items += [(49, y, b.at.strftime("%d %b %Y").lower(), 10.8), (142, y, b.card, 10.8), (508, y, f"₹{b.amount:.2f}", 10.8),
                  (49, y + 20, b.at.strftime("%I:%M %p"), 9), (142, y + 20, "transaction id", 9), (223, y + 20, f": 01FAKE{n:020d}-1", 9),
                  (142, y + 35, "UTR", 9), (223, y + 35, f": CVFAKE{n:018d}", 9)]
        y += 78
    pages.append(items)
    return _pdf(path, pages)


def inr(v: float) -> str:
    """Indian grouping, the way statements print it: 1,23,456.78."""
    whole, paise = f"{abs(v):.2f}".split(".")
    head, tail = whole[:-3], whole[-3:]
    groups = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    return ",".join([g for g in [head, *groups] if g] + [tail]) + f".{paise}"


def card_statement(path: Path, frm: date, to: date, rows: list[CardRow], previous: float, due: float) -> Path:
    credits = sum(r.amount for r in rows if r.credit)
    debits = sum(r.amount for r in rows if not r.credit)
    items = [(40, 60, "SBI Card", 14), (40, 78, "Credit Card Statement", 9), (40, 93, "Card No: 4000 00XX XXXX 1111", 9),
             (40, 108, f"Statement Period: {frm:%d/%m/%Y} To {to:%d/%m/%Y}", 9),
             (40, 123, f"Statement Generation Date: {to:%d/%m/%Y}", 9), (300, 123, f"Payment Due Date: {to + timedelta(days=20):%d/%m/%Y}", 9),
             (40, 138, "Credit Limit: 2,00,000.00", 9), (300, 138, f"Minimum Amount Due: {inr(max(0.0, due) * 0.05)} Dr", 9)]
    mark = lambda v: f"{inr(v)} {'Cr' if v < 0 else 'Dr'}"  # noqa: E731
    for x, label, value in ((40, "Previous Balance", mark(previous)), (150, "Payments & Credits", inr(credits)),
                            (270, "Purchases & Charges", inr(debits)), (430, "Total Payment Due", mark(due))):
        items += [(x, 160, label, 8), (x, 173, value, 8)]
    items += [(40, 201, "DATE", 9), (110, 201, "TRANSACTION DETAILS", 9), (330, 201, "MERCHANT CATEGORY", 9), (470, 201, "AMOUNT (Rs.)", 9)]
    y = 216
    for r in rows:
        items += [(40, y, r.day.strftime("%d/%m/%Y"), 9), (110, y, r.details, 9), (330, y, r.category, 9),
                  (480, y, f"{inr(r.amount)} {'Cr' if r.credit else 'Dr'}", 9)]
        y += 15
    items.append((220, y + 10, "**** End of Statement ****", 9))
    return _pdf(path, [items])


def write_files(folder: Path, y: Year) -> list[Path]:
    folder.mkdir(parents=True, exist_ok=True)
    files = [phonepe_statement(folder / "PhonePe_Statement.pdf", y.upi), cred_history(folder / "CRED_payment_history.pdf", y.bills)]
    for frm, to, rows, previous, due in y.statements[-3:]:
        files.append(card_statement(folder / f"SBI_Card_Statement_{to:%b_%Y}.pdf", frm, to, rows, previous, due))
    return files


# ---- running it ------------------------------------------------------------------------------------------------

# The answers a person would give in "Needs your eyes" in their first minutes.
ANSWERS = [{"payee": "Mr Fake Landlord", "category": "home.rent", "label": "Rent"},
           {"payee": "Ms Fake Sister", "category": "transfers.p2p", "label": "Sister"}]
NETWORKS = {"card-hdfc-bank-2222": "RuPay", "card-icici-bank-3333": "Visa", "card-sbi-card-1111": "Mastercard"}


def _feed(base: str, files: list[Path]) -> None:
    with httpx.Client(base_url=base, timeout=30, trust_env=False) as client:  # this machine only, never via a proxy
        for _ in range(100):
            try:
                if client.get("/api/uploads").status_code == 200:
                    break
            except httpx.TransportError:
                time.sleep(0.2)
        for path in files:
            with path.open("rb") as f:
                upload = client.post("/api/uploads", files={"file": (path.name, f, "application/pdf")}, data={"kind": "auto"}).json()
            for _ in range(600):
                status = next(u for u in client.get("/api/uploads").json() if u["id"] == upload["id"]).get("importStatus") or {}
                if status.get("state") in ("done", "failed", "skipped"):
                    print(f"  {path.name}: {status['state']}", flush=True)
                    break
                time.sleep(0.2)
        for card, network in NETWORKS.items():
            client.put(f"/api/instruments/{card}", json={"network": network})
        client.post("/api/categorize/bulk", json={"items": ANSWERS})
    print(f"\nThe demo is ready: {base}  (made-up data in {userdata.root()}; Ctrl+C stops it)\n", flush=True)


def main() -> None:
    data = userdata.root().resolve()
    if data == (ROOT / "data").resolve() or data.parent.name != ".demo":
        sys.exit("The demo runs only on .demo/data, never on your data folder. Use `make demo`.")
    shutil.rmtree(data.parent, ignore_errors=True)  # a fresh demo every time
    files = write_files(data.parent / "files", make_year())

    from app.llm import LLMUnavailable, llm
    from app.main import app

    @asynccontextmanager
    async def off():
        raise LLMUnavailable("the demo runs without the local AI")
        yield

    llm.session = off  # payees no rule knows wait in "Needs your eyes", as they would without Ollama
    base = f"http://127.0.0.1:{settings.port}"
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=settings.port, log_level="warning"))
    code = 0

    def run() -> None:
        nonlocal code
        _feed(base, files)
        if "--screenshots" in sys.argv[1:]:
            code = subprocess.run(["node", str(ROOT / "scripts" / "screenshots.mjs")], env={**os.environ, "DEMO_URL": base}).returncode
            server.should_exit = True

    print(f"Making a year of made-up spending and reading it in, at {base} …", flush=True)
    threading.Thread(target=run, daemon=True).start()
    server.run()
    sys.exit(code)


if __name__ == "__main__":
    main()
