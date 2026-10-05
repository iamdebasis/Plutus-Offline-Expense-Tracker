"""Explain what the detector and the card statement reader see in a PDF, without showing its content.

    python -m app.tools.inspect path/to/file.pdf      (a password-protected PDF asks for its password; not saved)

Prints page and text-layer stats, which marker phrases matched, the *shape* of the first lines, and how the card
statement reader takes each line of every page: a table header, a row's date at the start, its amount at the end.
Only structural words ("Date", "Amount", "Cr"), month names and bank names stay; every other letter becomes X/x
and every digit 9, dates included ("Paid to Mr Xxxxxxxxx X", "YES BANK 9999", "₹9999.99", "99 Aug 9999"). Read it
before pasting it anywhere.
"""

import getpass
import re
import sys
import tempfile
from pathlib import Path

import pymupdf

from app import userdata
from app.ingest import ocr
from app.ingest.detect import BANK_MARKERS, CARD_LINE, CC_MARKERS, _cred_cards, detect
from app.ingest.issuers import ISSUERS
from app.tools.redact import KEEP_WORDS, _PUNCT

LINES_TO_SHOW = 60


def shape(word: str) -> str:
    """A word's shape: kept when it's a structural word, a month or a bank; otherwise letters become X/x and digits
    9, whatever they are (a date's digits too: its format is what matters, not the day)."""
    core = word.strip(_PUNCT)
    letters = re.sub(r"[^A-Za-z]", "", core)
    if letters and letters.lower() in KEEP_WORDS and not re.search(r"\d", core):
        return word
    return "".join("9" if c.isdigit() else ("X" if c.isupper() else "x") if c.isalpha() and not _month_at(word, c) else c
                   for c in word)


def _masked(label: str) -> str:
    """What a file was identified as, without its card's digits ("Axis Bank credit card ••9999")."""
    return re.sub(r"\d", "9", label)


_MONTHS = re.compile(r"(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*", re.IGNORECASE)


def _month_at(word: str, _c: str) -> bool:
    """Inside a date such as "05-Aug-2026", the month name stays (its letters say the format)."""
    letters = re.sub(r"[^A-Za-z]", "", word)
    return bool(letters) and bool(_MONTHS.fullmatch(letters)) and bool(re.search(r"\d", word))


def main(argv: list[str]) -> None:
    if len(argv) != 1:
        sys.exit(__doc__)
    path = Path(argv[0]).expanduser()
    if not path.exists():
        sys.exit(f"Not found: {path}")
    if path.suffix.lower() != ".pdf":
        det = detect(path, path.name)
        print(f"detected       : {det.kind} ({det.confidence:.2f}) · {_masked(det.label)} · cards: {len(det.cards)}")
        return

    userdata.path("run").mkdir(parents=True, exist_ok=True)
    # an unlocked copy, if it needs one, lives in the data folder (never the system's temp) and goes when this ends
    with pymupdf.open(path) as doc, tempfile.TemporaryDirectory(dir=userdata.path("run")) as tmp:
        locked = bool(doc.needs_pass)
        if locked and not _unlock(doc):
            return
        unlocked = path
        if locked:  # what the app sees after you give it the password: an unlocked copy, gone when this ends
            unlocked = Path(tmp) / path.name
            doc.save(unlocked, encryption=pymupdf.PDF_ENCRYPT_NONE)
        det = detect(unlocked, path.name)
        print(f"detected       : {det.kind} ({det.confidence:.2f}) · {_masked(det.label)} · cards: {len(det.cards)}")
        print(f"pages          : {doc.page_count} · password protected: {locked}")
        pages = [doc[i].get_text() for i in range(min(3, doc.page_count))]
        spans = sum(len(l["spans"]) for b in doc[0].get_text("dict")["blocks"] for l in b.get("lines", []))
        images = len(doc[0].get_image_info())
        raw = "\n".join(pages)
        state = "readable" if ocr.text_is_readable(raw) else ("scrambled" if len(raw.strip()) >= 40 else "empty")
        print(f"text layer     : {state} · chars on first pages {[len(p.strip()) for p in pages]} · "
              f"page 1 spans: {spans}, images: {images}")

        # (x, y, text) for page 1, from the text layer or, if that's unusable, from OCR
        if state == "readable":
            text = raw
            rows = [(l["bbox"][0], l["bbox"][1], "".join(s["text"] for s in l["spans"]))
                    for b in doc[0].get_text("dict")["blocks"] for l in b.get("lines", [])]
        elif ocr.available():
            text = ocr.ocr_text(doc, 2)
            rows = [(l.x0, l.y0, l.text) for l in ocr.ocr_page(doc[0])]
            print("               : read the pages with on-device OCR instead")
        else:
            print("               : OCR not available (needs macOS + pyobjc-framework-Vision)")
            return

        low = text.lower()
        print(f"CC markers     : {[m for m in CC_MARKERS if m in low]}")
        print(f"bank markers   : {[m for m in BANK_MARKERS if m in low]}")
        print(f"UPI markers    : phonepe={'phonepe' in low} gpay={'google pay' in low or 'gpay' in low} "
              f"'paid to'={'paid to' in low} 'utr'={'utr' in low}")
        cred_word = bool(re.search(r"\bcred\b", low))
        print(f"CRED markers   : word 'cred'={cred_word} 'transaction id'={'transaction id' in low} "
              f"card lines (NAME 1234)={len(CARD_LINE.findall(text))} → cards recognised={len(_cred_cards(text))}")
        banks = {name: n for name, pattern in ISSUERS if (n := len(pattern.findall(text)))}
        print(f"banks mentioned: {banks or 'none'}")

        print(f"\nfirst {LINES_TO_SHOW} lines of page 1 (x, y in points), shape only:")
        for x, y, line in [r for r in rows if r[2].strip()][:LINES_TO_SHOW]:
            print(f"    x{x:5.0f} y{y:5.0f} | " + " ".join(shape(w) for w in line.split()))

        reader_view(doc)


def _unlock(doc: pymupdf.Document) -> bool:
    """Ask for a protected PDF's password, here in the terminal. It isn't printed or saved."""
    if not sys.stdin.isatty():
        print("password protected: run this in a terminal to be asked for its password")
        return False
    if not doc.authenticate(getpass.getpass("This PDF is password protected. Its password (not shown, not saved): ")):
        print("That password didn't open it.")
        return False
    return True


# ---- what the card statement reader makes of it ------------------------------------------------------------

READER_LINES = 320


def _cells(line) -> str:
    """A line's words grouped into the cells they sit in (a gap wider than a few spaces starts a new one), each with
    where it starts: "x40 99/99/9999 | x110 XXXXX XXXX | x480 9,999.99 Dr"."""
    cells: list[tuple[float, list[str]]] = []
    last_end = None
    for w in line.words:
        if last_end is None or w.x0 - last_end > 6:
            cells.append((w.x0, []))
        cells[-1][1].append(shape(w.text))
        last_end = w.x1
    return " | ".join(f"x{x:.0f} {' '.join(words)}" for x, words in cells)


def reader_view(doc: pymupdf.Document) -> None:
    from app.parsers import card_statement as cs

    lines, method = cs.read_lines(doc)
    summary = cs.read_summary(lines)
    found = [k for k in ("previous_balance", "total_due", "minimum_due", "credit_limit", "statement_date", "due_date", "period")
             if getattr(summary, k, None) is not None]
    anchor = summary.statement_date or (summary.period[1] if summary.period else None)
    year = anchor.year if anchor else None
    rows, from_table, unread = cs.read_rows(lines, year, None)
    headers = [i for i, ln in enumerate(lines) if cs._header(ln, lines[i + 1] if i + 1 < len(lines) else None)]
    print(f"\ncard statement reader: {len(lines)} lines on {doc.page_count} page(s), read as {method}")
    print(f"summary figures found : {', '.join(found) or 'none'}")
    print(f"table headers found   : {len(headers)}" + (f" (on page {', '.join(sorted({str(lines[i].page + 1) for i in headers}))})" if headers else ""))
    dated = sum(1 for ln in lines if cs._date_at_start(ln.words, year))
    priced = sum(1 for ln in lines if cs.amount_at_end(ln))  # at the very end of the line
    print(f"lines starting with a date: {dated} · ending with an amount: {priced} · rows read: {len(rows)}"
          f" · table lines not read: {len(unread)}")

    # the reader by shape and arithmetic (app/parsers/statement_reader.py): what it decided, and why; never a figure
    from app.parsers import shape_reader as sr
    from app.parsers import statement_reader as rd

    parts = rd.segments(rd.Statement(lines, method, summary, None, None, None, summary.period, anchor))
    spans = ", ".join(f"pages {p.lines[0].page + 1}–{p.lines[-1].page + 1}" for p in parts if p.lines)
    print(f"\nstatements in this file: {len(parts)}" + (f" ({spans})" if len(parts) > 1 else ""))
    for k, part in enumerate(parts, 1):
        readings = rd.readings_of(part)
        d = rd.decide(readings, part.summary, part.anchor, part.period)
        # why, in words, with every digit masked: a reason can quote the statement's figures
        print(f"  statement {k}: {d.status.replace('_', ' ')}: {re.sub(r'[0-9]', '9', d.proof)}")
        print("    readings: " + " · ".join(f"{r.name} {len(r.rows)} rows" for r in readings))
        if part.summary.months:  # a summary of several statements (a year's): what it covers, and what it lists past that
            span = rd.covered(part.summary)
            print(f"    sums up {len(part.summary.months)} statements · the day they're dated: "
                  f"{'found' if part.summary.statement_day else 'not found'} · their totals: "
                  f"{'found' if part.summary.printed_debits is not None and part.summary.printed_credits is not None else 'not found'}"
                  f" · rows within their cycles: {len(d.rows) if span else '?'} · rows outside: {len(d.beyond) if span else '?'}")
    shaped, _ = sr.find_rows(lines, None)
    by_shape = {r.line for r in shaped if not r.after_terms}
    columns = sr.money_columns([r for r in shaped if not r.after_terms])
    print(f"rows by their shape: {len(by_shape)} · amounts line up at x " + (", ".join(f"{c.edge:.0f}" for c in columns) or "nowhere"))
    print("\neach line with a digit, as the reader takes it  [H] table header  [D] starts with a date  "
          "[A] ends with an amount (its Dr/Cr)  [S] a row by its shape  [E] the table ends here:")
    shown = 0
    cols = None
    for i, ln in enumerate(lines):
        flags = ""
        if i in headers:
            flags += "H"
            cols = cs._header(ln, lines[i + 1] if i + 1 < len(lines) else None)
        if cs._date_at_start(ln.words, year):
            flags += "D"
        if amount := cs._amount_in(ln, cols):  # with the table's columns: a points column after the amount is skipped
            flags += f"A{('(' + amount.mark + ')') if amount.mark else ''}"
        if i in by_shape:
            flags += "S"
        if cs._END.search(ln.text):
            flags += "E"
        if not flags and not re.search(r"\d", ln.text):
            continue
        print(f"  p{ln.page + 1} y{ln.y:4.0f} [{flags:<7}] {_cells(ln)}")
        shown += 1
        if shown >= READER_LINES:
            print(f"  … {len(lines) - i - 1} more lines not shown")
            break


if __name__ == "__main__":
    main(sys.argv[1:])
