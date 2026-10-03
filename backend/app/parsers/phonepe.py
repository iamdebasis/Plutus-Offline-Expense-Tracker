"""PhonePe transaction statement PDF (text layer), one block per transaction:

    Apr 10, 2025   Paid to Mr Fake Payee                   Debit   INR 111.00
    10:00 AM       Transaction ID : T2504101000000000000001
                   UTR No : 123456789012
                   Debited from XX4321
"""

import re
from datetime import datetime

from app.ingest.textlines import Line
from app.models import SourceRef, Transaction
from app.parsers import ParseResult, local_time, money, stable_id

DATE = re.compile(r"^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$")
TIME = re.compile(r"^(\d{1,2}):(\d{2}) ([AP]M)$")
TXN_ID = re.compile(r"^Transaction ID\s*:\s*(\S+)")
UTR = re.compile(r"^UTR No\s*:\s*(\S+)")
ACCOUNT = re.compile(r"^(Debited from|Credited to)\s+(.+)$")
TYPE = re.compile(r"^(Debit|Credit)$")
AMOUNT = re.compile(r"^INR\s*([\d,]+\.\d{2})?$")
BARE_AMOUNT = re.compile(r"^[\d,]+\.\d{2}$")
NOISE = re.compile(r"^(Page \d+ of \d+|Date|Transaction Details|Type|Amount|Transaction Statement.*|\.|https?://.*)$")


def parse(pages: list[list[Line]], method: str, upload_id: str) -> ParseResult:
    result = ParseResult(method=method)
    current: dict | None = None
    awaiting_amount = False

    def finish():
        if not current:
            return
        missing = [k for k in ("date", "detail", "amount", "type") if k not in current]
        if missing:
            result.warnings.append(f"page {current['page'] + 1}: skipped an entry without {', '.join(missing)}")
            return
        result.transactions.append(_to_transaction(current, upload_id))

    for page in pages:
        for line in page:
            text = line.text.strip()
            if NOISE.match(text) or text.startswith(("This is a", "errors in", "Visit", "Do not fall", "The contents", "received this", "the recipient", "emails and", "so that we", "for Privacy", "for PhonePe", "/privacy")):
                continue
            if m := DATE.match(text):
                finish()
                current = {"date": datetime.strptime(" ".join(m.groups()), "%b %d %Y"), "page": line.page}
                awaiting_amount = False
            elif current is None:
                continue
            elif m := TIME.match(text):
                current["time"] = (int(m.group(1)), int(m.group(2)), m.group(3))
            elif m := TXN_ID.match(text):
                current["txnId"] = m.group(1)
            elif m := UTR.match(text):
                current["utr"] = m.group(1)
            elif m := ACCOUNT.match(text):
                current["account"] = m.group(2).strip()
            elif m := TYPE.match(text):
                current["type"] = m.group(1)
            elif m := AMOUNT.match(text):
                if m.group(1):
                    current["amount"] = money(m.group(1))
                else:
                    awaiting_amount = True
            elif awaiting_amount and BARE_AMOUNT.match(text):
                current["amount"] = money(text)
                awaiting_amount = False
            elif "detail" not in current:
                current["detail"] = text
    finish()
    return result


def _to_transaction(c: dict, upload_id: str) -> Transaction:
    hour, minute, meridiem = c.get("time", (0, 0, "AM"))
    at = local_time(c["date"], hour, minute, meridiem)
    detail: str = c["detail"]
    direction = "debit" if c["type"] == "Debit" else "credit"

    if m := re.match(r"^(Paid to|Received from|Refund from|Sent to)\s+(.+)$", detail):
        verb, payee = m.groups()
    elif m := re.match(r"^Paid\s*-\s*(.+)$", detail):  # "Paid - Mobile Recharge"
        verb, payee = "Paid to", m.group(1)
    else:
        verb, payee = detail, detail

    if "cashback" in detail.lower():
        kind = "cashback"
    elif verb.startswith("Refund"):
        kind = "refund"
    elif direction == "credit":
        kind = "income"
    else:
        kind = "spend"

    account, note = c.get("account"), ""
    if account and "|" in account:  # "XXXX99 INR 140.00 | Gift Card INR 10.00": card and gift-card balance
        parts = [p.strip() for p in account.split("|")]
        note = "Split payment: " + " + ".join(re.sub(r"\s*INR\s*", " ₹", p) for p in parts)
        account = re.sub(r"\s+INR.*$", "", parts[0])

    refs = {k: c[k] for k in ("txnId", "utr") if c.get(k)}
    return Transaction(
        # every reference: a payment, its refund and a second listing can share any one of them
        id=stable_id("txn", refs.get("utr"), refs.get("txnId"), direction, c["amount"], "" if refs else (at, payee)),
        at=at, amount=c["amount"], direction=direction, kind=kind, channel="upi", app="phonepe",
        payee=payee.strip(), paid_from=account, refs=refs, note=note,
        sources=[SourceRef(upload=upload_id, page=c["page"] + 1)],
    )
