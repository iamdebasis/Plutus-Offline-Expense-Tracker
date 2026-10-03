"""Positioned lines of text for every page of a PDF, from the most exact source available.

1. "text":    the PDF's own text layer, when it reads normally.
2. "decoded": some exporters (CRED's among them) write text in fonts whose character codes are
              scrambled. The glyphs are still exact, only the code-to-letter table is missing, so we
              rebuild that table by matching the text layer against OCR of the same page, then decode
              the text layer. Amounts come from the PDF itself, not from OCR guesses.
3. "ocr":     on-device OCR, when there is no text layer or decoding doesn't check out.
"""

from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Literal

import pymupdf

from app import logs
from app.ingest import ocr

Method = Literal["text", "decoded", "ocr"]
FontKey = tuple[str, float]

# The share of learning lines whose decoding must match OCR exactly for the decoded text to be trusted.
MIN_AGREEMENT = 0.9

log_read = logs.get("read")
log_ocr = logs.get("ocr")
log_decode = logs.get("decode")


@dataclass
class Line:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    page: int
    ocr: str | None = None  # for decoded lines: what OCR read at the same spot, for cross-checking fields


def page_lines(doc: pymupdf.Document) -> tuple[list[list[Line]], Method]:
    raw = "\n".join(doc[i].get_text() for i in range(min(3, doc.page_count)))
    if ocr.text_is_readable(raw):
        log_read.info("text layer reads normally → using the PDF's own text (no OCR)")
        return [_text_layer_lines(doc[i], i) for i in range(doc.page_count)], "text"
    if not ocr.available():
        log_read.warning("text layer unreadable and on-device OCR isn't available (needs macOS + pyobjc-framework-Vision)")
        return [[] for _ in range(doc.page_count)], "text"

    scrambled = len(raw.strip()) >= 40
    log_read.info("text layer %s → reading the pages with on-device OCR", "is scrambled" if scrambled else "is missing")
    with logs.timed() as t:
        ocr_pages = [[Line(l.text, l.x0, l.y0, l.x1, l.y1, i) for l in ocr.ocr_page(doc[i])] for i in range(doc.page_count)]
    log_ocr.info("Apple Vision · %d pages · %d lines · %.1fs", doc.page_count, sum(map(len, ocr_pages)), t())
    if scrambled:
        decoded = _decode_with_ocr(doc, ocr_pages)
        if decoded is not None:
            return decoded, "decoded"
        log_decode.warning("decoding didn't check out against OCR → using the OCR text as-is")
    return ocr_pages, "ocr"


def _text_layer_lines(page: pymupdf.Page, index: int) -> list[Line]:
    out = []
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            text = "".join(span["text"] for span in line["spans"]).strip()
            if text:
                x0, y0, x1, y1 = line["bbox"]
                out.append(Line(text, x0, y0, x1, y1, index))
    return _reading_order(out)


# ---- decoding scrambled fonts ------------------------------------------------------------


@dataclass
class _Segment:
    """Glyphs that sit next to each other on one baseline, in the same font."""

    glyphs: list[tuple[FontKey, int]]
    x0: float
    y0: float
    x1: float
    y1: float
    page: int


def _segments(page: pymupdf.Page, index: int) -> list[_Segment]:
    segments: list[_Segment] = []
    for span in sorted(page.get_texttrace(), key=lambda s: (round(s["bbox"][1]), s["bbox"][0])):
        if not span["chars"]:
            continue
        key: FontKey = (span["font"], round(span["size"], 1))
        glyphs = [(key, c[1]) for c in span["chars"]]
        x0, y0, x1, y1 = span["bbox"]
        last = segments[-1] if segments else None
        if last and last.page == index and abs(last.y1 - y1) < 2 and 0 <= x0 - last.x1 < 3:
            last.glyphs += glyphs
            last.x1 = x1
        else:
            segments.append(_Segment(glyphs, x0, y0, x1, y1, index))
    return segments


def _best_ocr_match(seg: _Segment, candidates: list[Line]) -> Line | None:
    best, best_overlap = None, 0.0
    height = seg.y1 - seg.y0
    for line in candidates:
        if abs((line.y0 + line.y1) / 2 - (seg.y0 + seg.y1) / 2) > height * 0.7:
            continue
        overlap = min(seg.x1, line.x1) - max(seg.x0, line.x0)
        if overlap > best_overlap:
            best, best_overlap = line, overlap
    return best if best and best_overlap > 0.5 * (seg.x1 - seg.x0) else None


def _aligned(seg: _Segment, text: str) -> str | None:
    """OCR text with one character per glyph, or None if they can't be lined up."""
    if len(text) == len(seg.glyphs):
        return text
    # Currency signs are often drawn separately, so OCR sees one leading character more ("₹4321.50").
    if len(text) == len(seg.glyphs) + 1 and not text[0].isalnum():
        return text[1:]
    if len(text) == len(seg.glyphs) + 1 and text[1:2].isdigit() and "." in text:
        return text[1:]
    return None


def repair_case(table: dict[tuple[FontKey, int], str]) -> dict[tuple[FontKey, int], str]:
    """OCR mixes up letters whose capital looks like the small one (w/W, o/O, x/X…), and the table learns
    it. These subset fonts number glyphs in character order, so a glyph numbered after the small letters
    can't be a capital: flip the case of any letter that only fits between its neighbours the other way."""
    fixed = dict(table)
    by_font: dict[FontKey, list[tuple[int, str]]] = defaultdict(list)
    for (font, gid), char in table.items():
        by_font[font].append((gid, char))
    for font, pairs in by_font.items():
        pairs.sort()
        for i, (gid, char) in enumerate(pairs):
            if not char.isalpha() or char.swapcase() == char:
                continue
            before = pairs[i - 1][1] if i else None
            after = pairs[i + 1][1] if i + 1 < len(pairs) else None

            def fits(c: str) -> bool:
                return (before is None or before < c) and (after is None or c < after)

            if not fits(char) and fits(char.swapcase()):
                fixed[(font, gid)] = char.swapcase()
    return fixed


def _decode_with_ocr(doc: pymupdf.Document, ocr_pages: list[list[Line]]) -> list[list[Line]] | None:
    pairs: list[tuple[_Segment, str]] = []
    all_segments: list[list[_Segment]] = []
    for i in range(doc.page_count):
        segs = _segments(doc[i], i)
        all_segments.append(segs)
        for seg in segs:
            match = _best_ocr_match(seg, ocr_pages[i])
            if match and (text := _aligned(seg, match.text)) is not None:
                pairs.append((seg, text))
    if not pairs:
        return None

    votes: dict[tuple[FontKey, int], Counter] = defaultdict(Counter)
    for seg, text in pairs:
        for glyph, char in zip(seg.glyphs, text):
            votes[glyph][char] += 1
    learned = {glyph: counter.most_common(1)[0][0] for glyph, counter in votes.items()}
    table = repair_case(learned)
    case_fixes = sum(table[g] != learned[g] for g in learned)

    def decode(seg: _Segment) -> str | None:
        chars = [table.get(g) for g in seg.glyphs]
        return None if any(c is None for c in chars) else "".join(chars)  # type: ignore[arg-type]

    agree = sum(decode(seg) == text for seg, text in pairs)
    log_decode.info(
        "scrambled font decoded, with OCR as the key: %d characters learned from %d lines · %.0f%% identical to OCR line for line%s",
        len(table), len(pairs), 100 * agree / len(pairs),
        f" · {case_fixes} letter-case fix{'es' if case_fixes != 1 else ''} (OCR's w/W-type slips)" if case_fixes else "",
    )
    if agree / len(pairs) < MIN_AGREEMENT:
        return None

    pages: list[list[Line]] = []
    for i, segs in enumerate(all_segments):
        lines = []
        for seg in segs:
            match = _best_ocr_match(seg, ocr_pages[i])
            text = decode(seg)
            if text is None:  # a glyph OCR never showed us: take OCR's reading for this spot
                text = match.text if match else ""
            if text.strip():
                lines.append(Line(text.strip(), seg.x0, seg.y0, seg.x1, seg.y1, i, match.text.strip() if match else None))
        pages.append(_reading_order(lines))
    return pages


def _reading_order(lines: list[Line]) -> list[Line]:
    rows: list[list[Line]] = []
    for line in sorted(lines, key=lambda l: (l.y0 + l.y1) / 2):
        centre = (line.y0 + line.y1) / 2
        if rows:
            row = rows[-1]
            row_centre = sum((l.y0 + l.y1) / 2 for l in row) / len(row)
            if abs(centre - row_centre) < (line.y1 - line.y0) * 0.5:
                row.append(line)
                continue
        rows.append([line])
    return [line for row in rows for line in sorted(row, key=lambda l: l.x0)]
