"""Work out what an uploaded file is (and which cards it belongs to) before any transaction parsing.

Detection is deliberately cheap: it reads the text layer of the first few pages and looks for
markers. It never calls the LLM.
"""

import re
import zipfile
from collections import Counter
from datetime import datetime
from pathlib import Path

import pymupdf

from app.models import CardRef, DeclaredKind, Detection, FileKind, PaymentSource, Period
from app.ingest import ocr
from app.ingest.issuers import detect_issuer, detect_network, product_name
from app.parsers import card_export

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".heic", ".heif"}
EXPORT_EXTS = {".zip", ".html", ".htm", ".csv", ".json", ".xlsx", ".xls"}
PDF_EXTS = {".pdf"}
SUPPORTED_EXTS = IMAGE_EXTS | EXPORT_EXTS | PDF_EXTS

PAGES_TO_SNIFF = 3
OCR_PAGES_TO_SNIFF = 2
# Detection wins over what the user picked only when it is at least this sure.
TRUST_DETECTION = 0.6

DECLARED_LABELS: dict[str, str] = {
    "cc_statement": "Credit card statement",
    "cred_history": "CRED bill payments",
    "upi_statement": "UPI statement",
    "screenshot": "Payment screenshot",
}

CC_MARKERS = [
    "credit card", "statement date", "payment due date", "total amount due", "total dues",
    "minimum amount due", "minimum due", "credit limit", "available credit", "reward points",
    "previous balance", "finance charges", "card number",
]
BANK_MARKERS = ["opening balance", "closing balance", "ifsc", "account statement", "account number", "withdrawal"]
# A table of transactions: lines that start with a date, and amounts (a PDF's text often puts each cell on its own line)
_DATED_LINE = re.compile(r"^[ \t]*(?:\d{1,2}[/.\- ](?:\d{1,2}|[A-Za-z]{3,9})[/.\- ,]*\d{2,4}|[A-Za-z]{3,9} \d{1,2},? \d{4}|\d{4}-\d{2}-\d{2})\b",
                         re.MULTILINE)
_AMOUNT = re.compile(r"\d[\d,]*\.\d{2}\b")

# A card as CRED lists it, alone on its line: "HSBC FAKE PLUS 2468".
CARD_LINE = re.compile(r"^[ \t]*([A-Z][A-Z0-9 &.'\-]{1,60}?)[ \t]+(\d{4})[ \t]*$", re.MULTILINE)
# Masked card numbers: "4000 12XX XXXX 2468", "XXXX-XXXX-XXXX-1234", "400000******1234".
MASKED_RUN = re.compile(r"(?<![0-9A-Za-z*•])[0-9Xx*•][0-9Xx*• -]{10,24}[0-9]{4}(?![0-9])")
CARD_ENDING = re.compile(r"(?:card|ending)[^\n]{0,24}?[Xx*•]{2,}[ -]?(\d{4})\b", re.IGNORECASE)
DEBITED_FROM = re.compile(r"Debited from\s+([Xx*]+\d{2,4})")

_DATE = r"(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9},?\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})"
DATE_RANGE = re.compile(rf"({_DATE})\s*(?:-|–|to|TO|To)\s*({_DATE})")
_DATE_FORMATS = ["%d/%m/%Y", "%d-%m-%Y", "%d/%m/%y", "%d-%m-%y", "%d %b %Y", "%d %B %Y", "%b %d %Y", "%B %d %Y"]


def detect(path: Path, filename: str, declared: DeclaredKind = "auto") -> Detection:
    ext = Path(filename).suffix.lower()
    if ext in IMAGE_EXTS:
        return Detection(
            kind="screenshot",
            label="Payment screenshot",
            confidence=0.9,
            notes=["Read with on-device OCR; the local vision model steps in only for unfamiliar layouts"],
        )
    if ext in EXPORT_EXTS:
        return _detect_export(path, ext, declared)
    if ext in PDF_EXTS:
        return _detect_pdf(path, declared)
    return Detection(kind="unknown", label="Unsupported file type", notes=[f"{ext or 'no extension'} is not supported"])


def _detect_pdf(path: Path, declared: DeclaredKind) -> Detection:
    with pymupdf.open(path) as doc:
        if doc.needs_pass:
            return _fallback(declared, encrypted=True, pages=None, note="Password protected")
        pages = doc.page_count
        text = "\n".join(doc[i].get_text() for i in range(min(PAGES_TO_SNIFF, pages)))
        had_text = len(text.strip()) >= 40
        read_by_ocr = False
        if not ocr.text_is_readable(text) and ocr.available():
            from app import logs

            with logs.timed() as t:
                text = ocr.ocr_text(doc, OCR_PAGES_TO_SNIFF)
            logs.get("ocr").info("Apple Vision · identifying a PDF whose text is %s · %d pages · %.1fs",
                                 "scrambled" if had_text else "missing", min(OCR_PAGES_TO_SNIFF, pages), t())
            read_by_ocr = True

    if not ocr.text_is_readable(text):
        det = _fallback(declared, pages=pages, note="Couldn't read the text. The local vision model will read it")
        det.text_layer = False
        return det

    det = classify_text(text)
    det.pages = pages
    det.text_layer = not read_by_ocr
    if read_by_ocr:
        det.notes.append(("Text layer is scrambled" if had_text else "No text layer") + ", read with on-device OCR")
    if det.confidence < TRUST_DETECTION and declared != "auto":
        det.kind = declared
        det.label = DECLARED_LABELS[declared]
        det.confidence = 0.5
    return det


def classify_text(text: str) -> Detection:
    low = text.lower()
    candidates: list[Detection] = []

    # UPI apps
    if "phonepe" in low or ("transaction statement for" in low and "utr no" in low and ("paid to" in low or "received from" in low)):
        candidates.append(Detection(
            kind="upi_statement", label="PhonePe statement", source="phonepe",
            confidence=0.95 if "phonepe" in low else 0.8,
            period=_period(text), payment_sources=_payment_sources(text),
        ))
    if "google pay" in low or "gpay" in low:
        candidates.append(Detection(kind="upi_statement", label="Google Pay statement", source="gpay", confidence=0.85,
                                    period=_period(text), payment_sources=_payment_sources(text)))
    if "paytm" in low and "upi" in low:
        candidates.append(Detection(kind="upi_statement", label="Paytm statement", source="paytm", confidence=0.75,
                                    period=_period(text)))

    # CRED lists one line per card paid: "YES BANK 3141"
    # The CRED logo is an image, so the word "CRED" often isn't in the text. Several different cards,
    # each alongside transaction IDs and UTRs, is the real signature.
    cred_cards = _cred_cards(text)
    cred_score = (0.5 if re.search(r"\bcred\b", low) else 0.0) + 0.2 * min(len(cred_cards), 3)
    if len(cred_cards) >= 2 and "transaction id" in low and "utr" in low:
        cred_score += 0.3
    if cred_cards and cred_score >= 0.5:
        candidates.append(Detection(
            kind="cred_history", source="cred", confidence=min(cred_score, 0.95), cards=cred_cards,
            label=f"CRED bill payments · {len(cred_cards)} card{'s' if len(cred_cards) != 1 else ''}",
        ))

    # Bank credit card statement
    cc_hits = sum(marker in low for marker in CC_MARKERS)
    if cc_hits >= 2:
        issuer = detect_issuer(text)
        last4 = _card_last4(text)
        network = detect_network(text)
        cards = [CardRef(issuer=issuer, last4=last4, network=network)] if last4 else []
        name = f"{issuer} credit card" if issuer else "Credit card statement"
        candidates.append(Detection(
            kind="cc_statement", source=issuer, confidence=min(0.2 * cc_hits, 0.95), cards=cards,
            label=f"{name} ••{last4}" if last4 else name, period=_period(text),
            notes=[] if last4 else ["Couldn't find the card number on the first pages"],
        ))

    bank_hits = sum(marker in low for marker in BANK_MARKERS)
    if cc_hits < 2 and bank_hits < 3 and ("credit card" in low or MASKED_RUN.search(text)) \
            and len(_DATED_LINE.findall(text)) >= 3 and len(_AMOUNT.findall(text)) >= 3:
        # a card's transactions exported from the bank's site ("Credit Card Transactions", "Card No", a table of
        # dated amounts): no statement's words, but a card and its transactions
        issuer, last4 = detect_issuer(text), _card_last4(text)
        candidates.append(Detection(
            kind="cc_statement", source=issuer, confidence=0.5, cards=[CardRef(issuer=issuer, last4=last4, network=detect_network(text))] if last4 else [],
            label=f"{issuer or 'Credit card'} transactions" + (f" ••{last4}" if last4 else ""), period=_period(text),
        ))
    if bank_hits >= 3:
        issuer = detect_issuer(text)
        candidates.append(Detection(kind="bank_statement", source=issuer, confidence=min(0.15 * bank_hits, 0.8),
                                    label=f"{issuer} account statement" if issuer else "Bank account statement",
                                    period=_period(text)))

    if not candidates:
        return Detection(kind="unknown", label="Unrecognised PDF", confidence=0.0)
    return max(candidates, key=lambda d: d.confidence)


def _detect_export(path: Path, ext: str, declared: DeclaredKind) -> Detection:
    if ext in card_export.TABLE_EXTS:
        card_like, last4, issuer = card_export.looks_like_card_export(path)
        if card_like or declared == "cc_statement":
            label = f"{issuer or 'Credit card'} transactions (export)" + (f" ••{last4}" if last4 else "")
            return Detection(kind="cc_statement", label=label, source=issuer, confidence=0.8 if card_like else 0.5,
                             cards=[CardRef(issuer=issuer, last4=last4)] if last4 else [])
        if ext in (".xlsx", ".xls"):
            return Detection(kind="unknown", label="Unrecognised spreadsheet", confidence=0.0,
                             notes=["Only credit card transaction exports are read from spreadsheets so far"])
    if ext == ".zip":
        try:
            with zipfile.ZipFile(path) as zf:
                haystack = "\n".join(zf.namelist())
        except zipfile.BadZipFile:
            return Detection(kind="unknown", label="Damaged ZIP file")
    else:
        with path.open("r", encoding="utf-8", errors="ignore") as f:
            haystack = f.read(512_000)

    if re.search(r"google\s?pay|gpay", haystack, re.IGNORECASE):
        return Detection(kind="gpay_takeout", label="Google Pay history (Takeout)", source="gpay", confidence=0.9)
    if declared == "upi_statement":
        return Detection(kind="gpay_takeout", label="UPI history export", source="gpay", confidence=0.5)
    return Detection(kind="unknown", label="Unrecognised export", confidence=0.0)


def _fallback(declared: DeclaredKind, *, pages: int | None, note: str, encrypted: bool = False) -> Detection:
    if declared == "auto":
        return Detection(kind="unknown", label="PDF", pages=pages, encrypted=encrypted, notes=[note])
    return Detection(kind=declared, label=DECLARED_LABELS[declared], confidence=0.5,
                     pages=pages, encrypted=encrypted, notes=[note])


def _cred_cards(text: str) -> list[CardRef]:
    seen: dict[str, CardRef] = {}
    for title, last4 in CARD_LINE.findall(text):
        issuer = detect_issuer(title)
        if not issuer:
            continue
        key = f"{issuer}:{last4}"
        if key not in seen:
            seen[key] = CardRef(issuer=issuer, product=product_name(title), last4=last4, network=detect_network(title))
    return list(seen.values())


def _card_last4(text: str) -> str | None:
    found: list[str] = []
    for run in MASKED_RUN.findall(text):
        compact = re.sub(r"[ -]", "", run)
        masks = sum(ch in "Xx*•" for ch in compact)
        if masks >= 4 and 14 <= len(compact) <= 19:
            found.append(compact[-4:])
    found += CARD_ENDING.findall(text)
    return Counter(found).most_common(1)[0][0] if found else None


def _payment_sources(text: str) -> list[PaymentSource]:
    counts = Counter(DEBITED_FROM.findall(text))
    return [PaymentSource(mask=mask, count=n) for mask, n in counts.most_common()]


def _parse_date(raw: str) -> str | None:
    cleaned = re.sub(r"\s+", " ", raw.replace(",", "")).strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(cleaned, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def _period(text: str) -> Period | None:
    for start_raw, end_raw in DATE_RANGE.findall(text):
        start, end = _parse_date(start_raw), _parse_date(end_raw)
        if start and end and start <= end:
            return Period(start=start, end=end)
    return None


def folder_for(kind: FileKind) -> str:
    return {
        "cc_statement": "credit-card-statements",
        "cred_history": "cred",
        "upi_statement": "upi",
        "gpay_takeout": "upi",
        "screenshot": "screenshots",
        "bank_statement": "bank",
    }.get(kind, "other")
