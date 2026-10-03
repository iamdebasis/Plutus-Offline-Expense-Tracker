"""On-device OCR with Apple's Vision framework, for PDFs whose text layer is missing or scrambled.

Some exporters (CRED's among them) embed fonts with a private encoding: the page looks normal but the
extracted text is gibberish. Rendering the page and recognising it with Vision fixes that. Vision runs
locally on the Neural Engine; nothing leaves the machine.
"""

import re
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path

import pymupdf

RENDER_DPI = 200

# Words any readable statement will contain some of. Scrambled text has essentially none.
_COMMON_WORDS = set(
    """
    date amount total transaction transactions payment payments paid card bank inr rs statement details id utr
    debit credit debited credited to from the of and for on balance due account number time type limit upi
    jan feb mar apr may jun jul aug sep sept oct nov dec am pm
    """.split()
)


@dataclass
class OcrLine:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    confidence: float


def available() -> bool:
    if sys.platform != "darwin":
        return False
    try:
        import Vision  # noqa: F401
    except ImportError:
        return False
    return True


def text_is_readable(text: str) -> bool:
    words = re.findall(r"[a-z]{2,}", text.lower())
    if len(words) < 8:
        return False
    hits = sum(w in _COMMON_WORDS for w in words)
    return hits >= 5 or hits / len(words) >= 0.05


def ocr_page(page: pymupdf.Page, dpi: int = RENDER_DPI) -> list[OcrLine]:
    """Lines in reading order (top to bottom, then left to right), in PDF points with a top-left origin."""
    png = page.get_pixmap(dpi=dpi).tobytes("png")
    return _recognize(png, page.rect.width, page.rect.height)


def ocr_image(path: Path) -> list[OcrLine]:
    """Lines of a screenshot in reading order, positions as fractions of the image size."""
    return _recognize(path.read_bytes(), 1.0, 1.0)


def _plain(text: str) -> str:
    """OCR sometimes hangs an accent on a capital ("FIRSȚ"); statements here never use accented letters."""
    return "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))


def _recognize(image: bytes, width: float, height: float) -> list[OcrLine]:
    import Vision
    from Foundation import NSData

    handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(NSData.dataWithBytes_length_(image, len(image)), None)
    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    request.setUsesLanguageCorrection_(False)  # "correcting" IDs and amounts does more harm than good
    ok, error = handler.performRequests_error_([request], None)
    if not ok:
        raise RuntimeError(f"Vision OCR failed: {error}")

    lines: list[OcrLine] = []
    for observation in request.results() or []:
        candidate = observation.topCandidates_(1)[0]
        box = observation.boundingBox()  # normalised, origin bottom-left
        x0, w = box.origin.x * width, box.size.width * width
        y1 = (1 - box.origin.y) * height
        y0 = y1 - box.size.height * height
        lines.append(OcrLine(_plain(str(candidate.string())), x0, y0, x0 + w, y1, float(candidate.confidence())))
    return _reading_order(lines)


def ocr_text(doc: pymupdf.Document, max_pages: int) -> str:
    return "\n".join(line.text for i in range(min(max_pages, doc.page_count)) for line in ocr_page(doc[i]))


def _reading_order(lines: list[OcrLine]) -> list[OcrLine]:
    """Group lines whose vertical centres are close into rows, then sort rows top-down and each row left-right."""
    rows: list[list[OcrLine]] = []
    for line in sorted(lines, key=lambda l: (l.y0 + l.y1) / 2):
        centre = (line.y0 + line.y1) / 2
        if rows:
            last = rows[-1]
            last_centre = sum((l.y0 + l.y1) / 2 for l in last) / len(last)
            if abs(centre - last_centre) < (line.y1 - line.y0) * 0.5:
                last.append(line)
                continue
        rows.append([line])
    return [line for row in rows for line in sorted(row, key=lambda l: l.x0)]
