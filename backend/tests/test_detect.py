import os
import zipfile

import pytest

import pymupdf

from app.ingest import ocr
from app.ingest.detect import detect
from tests.conftest import CRED_TEXT, CC_STATEMENT_TEXT, PHONEPE_TEXT, make_pdf


def test_phonepe_statement(tmp_path):
    det = detect(make_pdf(tmp_path / "s.pdf", [PHONEPE_TEXT]), "statement.pdf")
    assert det.kind == "upi_statement"
    assert det.source == "phonepe"
    assert det.period and (det.period.start, det.period.end) == ("2025-04-01", "2026-03-31")
    assert [(s.mask, s.count) for s in det.payment_sources] == [("XX1111", 2), ("XXXX99", 1)]


def test_cred_history_discovers_every_card(tmp_path):
    det = detect(make_pdf(tmp_path / "c.pdf", [CRED_TEXT]), "cred.pdf")
    assert det.kind == "cred_history"
    cards = {(c.issuer, c.product, c.last4) for c in det.cards}
    assert cards == {
        ("Yes Bank", None, "3141"),
        ("IDFC FIRST Bank", "Fakegold", "8642"),
        ("RBL Bank", "Fakeshop", "1357"),
        ("HSBC", "Fake Plus", "2468"),
    }


def test_credit_card_statement(tmp_path):
    det = detect(make_pdf(tmp_path / "h.pdf", [CC_STATEMENT_TEXT]), "aug.pdf")
    assert det.kind == "cc_statement"
    assert det.label == "HSBC credit card ••2468"
    assert det.cards[0].last4 == "2468"
    assert det.cards[0].network == "Visa"
    assert det.period and det.period.start == "2025-08-13"


def test_encrypted_pdf_falls_back_to_declared_kind(tmp_path):
    det = detect(make_pdf(tmp_path / "e.pdf", [CC_STATEMENT_TEXT], password="1234"), "e.pdf", declared="cc_statement")
    assert det.encrypted
    assert det.kind == "cc_statement"


def test_scanned_pdf_has_no_text_layer(tmp_path):
    doc = pymupdf.open()
    doc.new_page().draw_rect(pymupdf.Rect(50, 50, 200, 200), fill=(0.5, 0.5, 0.5))
    doc.save(tmp_path / "scan.pdf")
    det = detect(tmp_path / "scan.pdf", "scan.pdf", declared="upi_statement")
    assert det.text_layer is False
    assert det.kind == "upi_statement"


def test_screenshot_and_takeout(tmp_path):
    (tmp_path / "shot.png").write_bytes(b"\x89PNG fake")
    assert detect(tmp_path / "shot.png", "IMG_0001.PNG").kind == "screenshot"

    with zipfile.ZipFile(tmp_path / "takeout.zip", "w") as zf:
        zf.writestr("Takeout/Google Pay/My Activity/My Activity.html", "<html></html>")
    assert detect(tmp_path / "takeout.zip", "takeout.zip").kind == "gpay_takeout"


def test_unknown_pdf(tmp_path):
    det = detect(make_pdf(tmp_path / "x.pdf", ["A recipe for dal makhani, nothing financial here at all."]), "x.pdf")
    assert det.kind == "unknown"


def test_cred_history_wins_even_when_added_through_the_credit_card_tile(tmp_path):
    det = detect(make_pdf(tmp_path / "c.pdf", [CRED_TEXT]), "c.pdf", declared="cc_statement")
    assert det.kind == "cred_history"
    assert len(det.cards) == 4


def _image_only(src, dest):
    """The same pages as pictures: no text layer at all, like a scan."""
    out = pymupdf.open()
    with pymupdf.open(src) as doc:
        for page in doc:
            pix = page.get_pixmap(dpi=200)
            out.new_page(width=page.rect.width, height=page.rect.height).insert_image(page.rect, pixmap=pix)
    out.save(dest)
    return dest


@pytest.mark.skipif(not ocr.available(), reason="needs macOS Vision")
@pytest.mark.skipif(os.environ.get("GITHUB_ACTIONS") == "true",
                    reason="GitHub's macOS machines are virtual and lack the hardware Apple Vision reads with; `make test` runs it")
def test_unreadable_pdf_is_read_with_ocr(tmp_path):
    pdf = _image_only(make_pdf(tmp_path / "c.pdf", [CRED_TEXT]), tmp_path / "scan.pdf")
    det = detect(pdf, "scan.pdf")
    assert det.kind == "cred_history"
    assert det.text_layer is False
    assert {c.last4 for c in det.cards} == {"3141", "8642", "1357", "2468"}
    assert any("on-device OCR" in n for n in det.notes)


def test_scrambled_text_is_not_readable():
    # the shape of what CRED's exported PDF yields from its text layer
    scrambled = '-X"XX"X-X*XX-"-XXXX-\nXX 9XX\nXXXX\nXXXXXXXXXXXXXXXXXX\nXXXXXX\n:9\n99\n"!\n-#9! "9999 #9\n>"X@\n' * 5
    assert not ocr.text_is_readable(scrambled)
    assert ocr.text_is_readable(CRED_TEXT)
