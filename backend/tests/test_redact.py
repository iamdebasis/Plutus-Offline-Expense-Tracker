import pymupdf

from app.tools.redact import redact_pdf
from tests.conftest import CRED_TEXT, PHONEPE_TEXT, make_pdf


def _text(path) -> str:
    with pymupdf.open(path) as doc:
        return "\n".join(p.get_text() for p in doc)


def test_masks_personal_data_but_keeps_structure(tmp_path):
    src = make_pdf(tmp_path / "pp.pdf", [PHONEPE_TEXT])
    out = tmp_path / "pp.redacted.pdf"
    stats = redact_pdf(src, out, seed=1)
    text = _text(out)

    for secret in ["Test Person", "FAKEMART", "T2504101000000000000001", "900000000001", "9800000000", "1234.00"]:
        assert secret not in text
    for structure in ["Paid to", "Transaction ID", "UTR No", "Debited from", "Apr", "2025", "10:00", "INR", "Debit"]:
        assert structure in text
    assert "XXXXXXXX" in text  # FAKEMART, masked with the same length
    assert stats["masked"] > 0


def test_same_token_maps_to_same_junk(tmp_path):
    src = make_pdf(tmp_path / "pp.pdf", [PHONEPE_TEXT + "\nRepeat: 900000000001"])
    out = tmp_path / "o.pdf"
    redact_pdf(src, out, seed=3)
    text = _text(out)
    # "900000000001" appears twice in the source; both copies become the same fake number
    words = [w for w in text.split() if len(w) == 12 and w.isdigit()]
    assert len(words) != len(set(words))


def test_keep_amounts_and_bank_names(tmp_path):
    src = make_pdf(tmp_path / "c.pdf", [CRED_TEXT])
    out = tmp_path / "c.redacted.pdf"
    redact_pdf(src, out, keep_amounts=True, seed=2)
    text = _text(out)
    assert "₹4321.50" in text or "4321.50" in text
    assert "YES BANK" in text and "HSBC" in text
    assert "3141" not in text  # card digits are masked


def test_detection_still_works_on_the_redacted_copy(tmp_path):
    from app.ingest.detect import detect

    out = tmp_path / "c.redacted.pdf"
    redact_pdf(make_pdf(tmp_path / "c.pdf", [CRED_TEXT]), out, seed=4)
    det = detect(out, "c.redacted.pdf")
    assert det.kind == "cred_history"
    assert {c.issuer for c in det.cards} == {"Yes Bank", "IDFC FIRST Bank", "RBL Bank", "HSBC"}
    assert all(c.last4 not in {"3141", "8642", "1357", "2468"} for c in det.cards)
