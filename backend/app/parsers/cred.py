"""CRED "transaction statement": one block per card bill payment.

    21 mar 2025        YES BANK 3141                                  ₹4321.50
    04:00 PM           transaction id : 01J0000000000000000000000A-0000001
                       UTR : CVFAKE0UTR00000000000000000000000001
"""

import re
from datetime import datetime

from app.ingest.issuers import detect_issuer, detect_network, product_name
from app.ingest.textlines import Line
from app.models import CardPayment, CardRef, SourceRef
from app.parsers import ParseResult, local_time, money, stable_id
from app.vault import instrument_id

DATE = re.compile(r"^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$")
TIME = re.compile(r"^(\d{1,2}):(\d{2}) ?([AaPp][Mm])$")
CARD = re.compile(r"^([A-Z][A-Z0-9 &.'\-]*?)\s+(\d{4})$")
AMOUNT = re.compile(r"^\D?\s?([\d,]+\.\d{2})$")


def parse(pages: list[list[Line]], method: str, upload_id: str) -> tuple[ParseResult, list[CardRef]]:
    result = ParseResult(method=method)
    cards: dict[str, CardRef] = {}
    current: dict | None = None
    label: str | None = None

    def finish():
        if not current:
            return
        missing = [k for k in ("date", "card", "amount") if k not in current]
        if missing:
            result.warnings.append(f"page {current['page'] + 1}: skipped an entry without {', '.join(missing)}")
            return
        title, last4 = current["card"]
        ref = CardRef(issuer=detect_issuer(title), product=product_name(title), last4=last4, network=detect_network(title))
        cards.setdefault(instrument_id(ref), ref)
        hour, minute, meridiem = current.get("time", (0, 0, "AM"))
        at = local_time(current["date"], hour, minute, meridiem)
        refs = {k: v for k, v in (("credTxnId", current.get("txn")), ("utr", current.get("utr"))) if v}
        result.card_payments.append(CardPayment(
            id=stable_id("pay", refs.get("credTxnId") or (at, title, current["amount"])),
            at=at, amount=current["amount"], card=instrument_id(ref), card_title=f"{title} {last4}",
            refs=refs, source=SourceRef(upload=upload_id, page=current["page"] + 1), verified=current["verified"],
        ))

    for page in pages:
        for line in page:
            text = line.text
            if (m := DATE.match(text) or (line.ocr and DATE.match(line.ocr))) and line.x0 < 130:
                finish()
                day, mon, year = m.groups()
                current = {"date": datetime.strptime(f"{day} {mon.title()} {year}", "%d %b %Y"), "page": line.page}
                label = None
            elif current is None:
                continue
            elif (m := TIME.match(text)) and line.x0 < 130:
                current["time"] = (int(m.group(1)), int(m.group(2)), m.group(3))
            elif (m := CARD.match(text)) and 130 <= line.x0 < 450 and "card" not in current and detect_issuer(m.group(1)):
                current["card"] = (m.group(1), m.group(2))
            elif (m := AMOUNT.match(text)) and line.x0 >= 450 and "amount" not in current:
                current["amount"], current["verified"] = _checked_amount(m.group(1), line.ocr)
            elif text.lower() in ("transaction id", "utr"):
                label = text.lower()
            elif text.startswith(":") and label:
                current["txn" if label == "transaction id" else "utr"] = text.lstrip(": ").strip()
                label = None
    finish()
    return result, list(cards.values())


def _checked_amount(decoded: str, ocr_text: str | None) -> tuple[float, bool]:
    """Decoded glyphs are exact; OCR is an independent second reading. They must agree on the digits
    (OCR often turns the ₹ sign into '8', '·' or '฿', so only its trailing digits are compared)."""
    value = money(decoded)
    if ocr_text is None:  # plain text layer or plain OCR: nothing to compare against
        return value, True
    digits = decoded.replace(",", "")
    return value, re.sub(r"[^\d.]", "", ocr_text).endswith(digits)
