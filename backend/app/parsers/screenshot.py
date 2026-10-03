"""A single UPI payment receipt screenshot (PhonePe, Google Pay, Paytm, …).

Fast path: on-device OCR plus label-based rules ("Paid to" → next line is the payee, "UTR:" → reference).
If the rules can't find the essentials (unknown app layout), the local vision model reads the image,
and its amount must also appear in the OCR text before we accept it.
"""

import base64
import json
import re
from datetime import datetime
from pathlib import Path

from app.models import SourceRef, Transaction
from app.parsers import IST, ParseError, ParseResult, local_time, stable_id

WHEN = re.compile(
    r"(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})(?:\s*(?:at|,)?\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm]))?"
)
WHEN_TIME_FIRST = re.compile(r"(\d{1,2}):(\d{2})\s*([AaPp][Mm])\s*(?:on|,)?\s*(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})")
AMOUNT = re.compile(r"^(\D)?\s?(\d[\d,]*(?:\.\d{1,2})?)$")
UTR = re.compile(r"(?:UTR|UPI Ref(?:erence)?(?: No\.?)?|UPI transaction ID)\s*[:.]?\s*([A-Za-z0-9]{10,})", re.IGNORECASE)
MASKED_ACCOUNT = re.compile(r"^[0-9Xx*•]{4,}\d{2,4}$")
FAILED = re.compile(r"\b(failed|declined|pending|cancelled)\b", re.IGNORECASE)


def parse(path: Path, upload_id: str) -> ParseResult:
    from app import logs
    from app.ingest import ocr

    log = logs.get("ocr")
    if not ocr.available():
        log.warning("on-device OCR isn't available; the screenshot goes to the local vision model")
        raise NeedsVisionModel([])
    with logs.timed() as t:
        lines = [l.text.strip() for l in ocr.ocr_image(path)]
    fields = _rules(lines)
    found = [k for k in ("amount", "payee", "at", "utr", "txnId", "paid_from") if fields and fields.get(k)]
    log.info("Apple Vision · screenshot · %d lines · %.1fs · %s receipt · read: %s",
             len(lines), t(), (fields or {}).get("app") or "unknown-app", ", ".join(found) or "nothing usable")
    if fields and _complete(fields):
        return ParseResult(method="ocr", transactions=[_transaction(fields, upload_id)])
    raise NeedsVisionModel(lines)


class NeedsVisionModel(Exception):
    """The rules couldn't read this receipt; the caller should try the local vision model."""

    def __init__(self, ocr_lines: list[str]):
        super().__init__("receipt layout not recognised")
        self.ocr_lines = ocr_lines


def _complete(f: dict) -> bool:
    return all(f.get(k) for k in ("amount", "at", "payee"))


def _rules(lines: list[str]) -> dict | None:
    text = "\n".join(lines)
    if not lines:
        return None
    if any(FAILED.search(l) for l in lines[:4]):
        raise ParseError("This screenshot shows a failed or pending payment")

    f: dict = {"app": _app(text)}
    for i, line in enumerate(lines):
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        low = line.lower()
        if "at" not in f and (m := WHEN.search(line)) and m.group(4):
            f["at"] = _when(m.group(1), m.group(2), m.group(3), m.group(4), m.group(5), m.group(6))
        elif "at" not in f and (m := WHEN_TIME_FIRST.search(line)):
            f["at"] = _when(m.group(4), m.group(5), m.group(6), m.group(1), m.group(2), m.group(3))
        if low in ("paid to", "to", "sent to", "paid successfully to") and nxt:
            f["payee"] = nxt
            if i + 2 < len(lines) and "@" in lines[i + 2]:
                f["handle"] = lines[i + 2]
        if "@" in line and "handle" not in f and " " not in line:
            f["handle"] = line
        if "amount" not in f and (value := _currency_amount(line)) is not None:
            f["amount"] = value
        if low in ("debited from", "paid from", "from") and MASKED_ACCOUNT.match(nxt.replace(" ", "")):
            f["paid_from"] = nxt.replace(" ", "")
        if m := UTR.search(line):
            f["utr"] = m.group(1)
        if ("transaction id" in low and "upi" not in low) and re.fullmatch(r"[A-Z0-9]{12,}", nxt):
            f["txnId"] = nxt
    # the same amount usually appears twice (next to the payee and next to the account)
    amounts = [v for l in lines if (v := _currency_amount(l)) is not None]
    if amounts and len(set(amounts)) > 1:
        f["amount_conflict"] = amounts
    return f


def _currency_amount(line: str) -> float | None:
    """'₹30', '·30', '₹ 1,250.00': a number led by a symbol. OCR reads ₹ as all sorts of symbols, but a
    letter in front ('T2609…') means it's an ID, not an amount."""
    m = AMOUNT.match(line)
    if not m or not m.group(1) or m.group(1).isalnum():
        return None
    return float(m.group(2).replace(",", ""))


def _app(text: str) -> str | None:
    low = text.lower()
    if "phonepe" in low:
        return "phonepe"
    if "google pay" in low or "google transaction id" in low or "gpay" in low:
        return "gpay"
    if "paytm" in low and "paytm." not in low:
        return "paytm"
    return None


def _when(day, month, year, hour, minute, meridiem) -> datetime:
    fmt = "%d %B %Y" if len(month) > 3 else "%d %b %Y"
    date = datetime.strptime(f"{int(day)} {month.title()} {year}", fmt)
    return local_time(date, int(hour), int(minute), meridiem)


def _transaction(f: dict, upload_id: str, method_note: str | None = None) -> Transaction:
    refs = {k: f[k] for k in ("txnId", "utr") if f.get(k)}
    return Transaction(
        id=stable_id("txn", refs.get("utr"), refs.get("txnId"), "debit", f["amount"], "" if refs else (f["at"], f["payee"])),
        at=f["at"], amount=f["amount"], direction="debit", kind="spend", channel="upi", app=f.get("app"),
        payee=f["payee"], payee_handle=f.get("handle"), paid_from=_statement_mask(f.get("paid_from")), refs=refs,
        sources=[SourceRef(upload=upload_id)], needs_review=bool(f.get("amount_conflict")),
        note=method_note or "",
    )


def _statement_mask(mask: str | None) -> str | None:
    """'400000XXXXXXXX99' → 'XXXX99', the way PhonePe statements print the same card."""
    if not mask:
        return None
    digits = re.search(r"(\d+)$", mask)
    return f"XXXX{digits.group(1)}" if digits and len(mask) >= 12 else mask


# ---- vision-model fallback -------------------------------------------------------------------

VISION_SCHEMA = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["success", "failed", "pending"]},
        "amount": {"type": "number"},
        "payee": {"type": "string"},
        "payee_handle": {"type": "string"},
        "date": {"type": "string", "description": "YYYY-MM-DD"},
        "time": {"type": "string", "description": "HH:MM, 24-hour"},
        "utr": {"type": "string"},
        "app_transaction_id": {"type": "string"},
        "paid_from": {"type": "string"},
    },
    "required": ["status", "amount", "payee", "date", "time"],
}

VISION_PROMPT = (
    "This is a screenshot of a UPI payment receipt from an Indian payments app. Extract the payment. "
    "amount is in rupees as a number. payee is who was paid (the name shown, not the UPI id). "
    "payee_handle is the UPI id if shown (contains @). utr is the UTR / UPI reference number. "
    "paid_from is the masked bank account or card number it was paid from. Leave a field empty if not shown."
)


async def parse_with_vision_model(path: Path, upload_id: str, ocr_lines: list[str]) -> ParseResult:
    from app import logs
    from app.llm import llm

    image = base64.b64encode(path.read_bytes()).decode()
    async with llm.session() as ai:
        raw = await ai.chat([{"role": "user", "content": VISION_PROMPT, "images": [image]}], schema=VISION_SCHEMA,
                            purpose="read a payment screenshot")
    data = json.loads(raw)
    if data.get("status") != "success":
        raise ParseError(f"The screenshot shows a {data.get('status', 'unknown')} payment")

    amount = float(data["amount"])
    ocr_text = " ".join(ocr_lines)
    # Don't trust a number the model may have invented: it has to be visible in the image too.
    shown = {float(n.replace(",", "")) for n in re.findall(r"\d[\d,]*(?:\.\d{1,2})?", ocr_text)}
    verified = not ocr_lines or amount in shown
    if verified:
        logs.get("llm").info("vision model's amount also appears in the OCR text ✓")
    else:
        logs.get("llm").warning("vision model's amount isn't visible in the OCR text; flagged for review")

    hour, minute = (int(x) for x in data["time"].split(":")[:2])
    at = datetime.strptime(data["date"], "%Y-%m-%d").replace(hour=hour, minute=minute, tzinfo=IST)
    f = {
        "at": at, "amount": amount, "payee": data["payee"].strip(), "handle": data.get("payee_handle") or None,
        "utr": data.get("utr") or None, "txnId": data.get("app_transaction_id") or None,
        "paid_from": data.get("paid_from") or None, "app": _app(ocr_text),
    }
    txn = _transaction(f, upload_id, method_note="" if verified else "Amount not confirmed by OCR")
    txn.needs_review = txn.needs_review or not verified
    return ParseResult(method="vision-model", transactions=[txn])
