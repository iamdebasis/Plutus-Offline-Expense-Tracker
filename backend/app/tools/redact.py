"""Make a layout-preserving, anonymised copy of a statement PDF.

    python -m app.tools.redact path/to/statement.pdf [--keep-amounts]

Every word keeps its position on the page, but names, merchants, IDs and amounts are replaced with
look-alike junk ("FAKEMART" -> "XXXXXXXX", "INR 1234.00" -> "INR 8302.61"). Structural words
("Paid to", "UTR No", "Total Amount Due"), month names, dates, times and bank names are kept so a
parser can still be written against the copy. All images (logos, QR codes) are removed.

Open the output and check it before sharing it with anyone.
"""

import argparse
import random
import re
import sys
from pathlib import Path

import pymupdf

from app import userdata

KEEP_WORDS = set(
    """
    paid to received from sent debit credit debited credited transaction transactions id utr no ref reference
    statement date dates time details type amount amounts inr rs total due minimum payment payments card cards
    number limit available cash balance opening closing previous purchase purchases fee fees charges charge gst
    igst cgst sgst interest finance reward rewards points cashback refund reversal reversed emi upi neft imps
    rtgs bbps autopay mandate for of the and on at by in via with a an is this page summary account bank
    period billing cycle cr dr mr mrs ms thank you spends spend value new customer name address mobile email
    transferred self wallet merchant description narration particulars withdrawal deposit domestic
    international foreign currency markup late annual joining renewal tax invoice membership surcharge fuel
    waiver adjustment outstanding unbilled billed installment conversion principal tenure rate sno sr serial
    status success successful failed pending txn category categories other others net gross overdue
    """.split()
) | set(
    """
    jan feb mar apr may jun jul aug sep sept oct nov dec january february march april june july august
    september october november december am pm
    """.split()
) | set(
    """
    hdfc icici axis sbi kotak idfc first indusind yes rbl au hsbc amex american express dbs citi onecard
    federal baroda bob standard chartered rupay visa mastercard diners club phonepe gpay google pay paytm cred
    """.split()
)

DATE_OR_TIME = re.compile(
    r"^(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}:\d{2}(:\d{2})?|\d{4}-\d{2}-\d{2})$"
)
_PUNCT = ".,:;()[]{}\"'"


def _looks_like_date_part(core: str) -> bool:
    if DATE_OR_TIME.match(core):
        return True
    if core.isdigit() and len(core) <= 2:  # day of month, hour
        return True
    if core.isdigit() and len(core) == 4 and 2000 <= int(core) <= 2039:  # year
        return True
    return False


class Redactor:
    def __init__(self, keep_amounts: bool, seed: int | None = None):
        self.keep_amounts = keep_amounts
        self.rng = random.Random(seed)
        self.memo: dict[str, str] = {}  # the same token always maps to the same junk, so cross-references survive

    def replacement(self, word: str) -> str | None:
        """None means keep the word as-is."""
        core = word.strip(_PUNCT)
        if not core:
            return None
        if core.lower() in KEEP_WORDS or _looks_like_date_part(core):
            return None
        if self.keep_amounts and re.fullmatch(r"[₹]?-?[\d,]+\.\d{2}(Cr|Dr|CR|DR)?", core):
            return None
        if word not in self.memo:
            self.memo[word] = "".join(self._scramble(ch) for ch in word)
        return self.memo[word]

    def _scramble(self, ch: str) -> str:
        if ch.isdigit():
            return str(self.rng.randint(0, 9))
        if ch.isalpha():
            return "X" if ch.isupper() else "x"
        return ch


_SYSTEM_FONT = Path("/System/Library/Fonts/Helvetica.ttc")  # has the ₹ glyph; the built-in PDF fonts don't


def _font() -> pymupdf.Font:
    return pymupdf.Font(fontfile=str(_SYSTEM_FONT)) if _SYSTEM_FONT.exists() else pymupdf.Font("helv")


def redact_pdf(src: Path, dest: Path, keep_amounts: bool = False, seed: int | None = None) -> dict:
    """Remove all text and images, then redraw every span of text at its original position (masked
    where needed), so text extraction on the copy yields the same lines as the original."""
    redactor = Redactor(keep_amounts, seed)
    font = _font()
    kept = masked = images = 0
    with pymupdf.open(src) as doc:
        if doc.needs_pass:
            raise SystemExit("This PDF is password protected. Unlock it first (open in Preview → Export as PDF).")
        for page in doc:
            # Redraw span by span at the original baseline and size, so lines extract exactly as before.
            writer = pymupdf.TextWriter(page.rect)
            for block in page.get_text("dict")["blocks"]:
                for line in block.get("lines", []):
                    for span in line["spans"]:
                        if not span["text"].strip():
                            continue
                        parts = []
                        for part in re.split(r"(\s+)", span["text"]):
                            new = None if not part or part.isspace() else redactor.replacement(part)
                            if part and not part.isspace():
                                kept, masked = (kept + 1, masked) if new is None else (kept, masked + 1)
                            parts.append(part if new is None else new)
                        text = "".join(parts)
                        x0, _, x1, _ = span["bbox"]
                        size = min(span["size"], (x1 - x0) / max(font.text_length(text, fontsize=1), 0.01))
                        writer.append(span["origin"], text, font=font, fontsize=size)
            images += len(page.get_image_info())
            # One redaction over the whole page drops every glyph and image but keeps lines and fills.
            page.add_redact_annot(page.rect, fill=False)
            page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_REMOVE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE)
            writer.write_text(page)
        doc.set_metadata({})
        doc.subset_fonts()
        doc.save(dest, garbage=4, deflate=True)
    return {"kept": kept, "masked": masked, "images_removed": images}


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--out", type=Path, help="default: data/redacted/<name>.redacted.pdf (with the rest of your data)")
    parser.add_argument("--keep-amounts", action="store_true", help="leave amounts untouched (lets totals reconcile)")
    args = parser.parse_args(argv)

    src: Path = args.pdf.expanduser().resolve()
    if not src.exists():
        sys.exit(f"Not found: {src}")
    dest = args.out or userdata.path("redacted") / f"{src.stem}.redacted.pdf"
    dest.parent.mkdir(parents=True, exist_ok=True)

    stats = redact_pdf(src, dest, keep_amounts=args.keep_amounts)
    if stats["kept"] + stats["masked"] == 0:
        dest.unlink(missing_ok=True)
        sys.exit("This PDF has no text layer (the pages are images), so there is nothing to redact. "
                 "It will be read by the local vision model instead.")
    print(f"Wrote {dest}")
    print(f"  words kept: {stats['kept']}, masked: {stats['masked']}, images removed: {stats['images_removed']}")
    print("  Open it and check nothing personal is left before sharing it.")


if __name__ == "__main__":
    main()
