import ipaddress
import socket
from pathlib import Path

import pymupdf
import pytest

from app.config import settings

_real_connect = socket.socket.connect
_real_connect_ex = socket.socket.connect_ex


def _check(address) -> None:
    if not isinstance(address, tuple):  # unix sockets
        return
    host = address[0]
    if host == "localhost":
        return
    try:
        if ipaddress.ip_address(host).is_loopback:
            return
    except ValueError:
        pass
    raise RuntimeError(f"Blocked outbound connection to {address!r}: nothing may leave this machine")


def _guarded_connect(self, address):
    _check(address)
    return _real_connect(self, address)


def _guarded_connect_ex(self, address):
    _check(address)
    return _real_connect_ex(self, address)


@pytest.fixture(autouse=True)
def no_egress(monkeypatch):
    """Every test fails if code under test tries to reach anything but localhost."""
    monkeypatch.setattr(socket.socket, "connect", _guarded_connect)
    monkeypatch.setattr(socket.socket, "connect_ex", _guarded_connect_ex)


@pytest.fixture(autouse=True)
def no_real_llm(monkeypatch):
    """Tests never start the real Ollama. Tests that need a model use a fake server (test_ollama_manager)."""
    from contextlib import asynccontextmanager

    from app.llm import LLMUnavailable, llm

    @asynccontextmanager
    async def unavailable():
        raise LLMUnavailable("no LLM in tests")
        yield

    monkeypatch.setattr(llm, "session", unavailable)


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch) -> Path:
    d = tmp_path / "data"
    d.mkdir()
    monkeypatch.setattr(settings, "data_dir", d)
    return d


def make_pdf(path: Path, pages: list[str], password: str | None = None) -> Path:
    """A text PDF with one string per page (fake data only)."""
    doc = pymupdf.open()
    font = Path("/System/Library/Fonts/Helvetica.ttc")
    for text in pages:
        page = doc.new_page()
        fontname = "helv"
        if font.exists():  # has the ₹ glyph
            fontname = "F0"
            page.insert_font(fontname=fontname, fontbuffer=pymupdf.Font(fontfile=str(font)).buffer)
        page.insert_textbox(pymupdf.Rect(40, 40, 560, 800), text, fontsize=9, fontname=fontname)
    doc.subset_fonts()
    kwargs = {}
    if password:
        kwargs = {"encryption": pymupdf.PDF_ENCRYPT_AES_256, "user_pw": password, "owner_pw": password + "-owner"}
    doc.save(path, **kwargs)
    doc.close()
    return path


PHONEPE_TEXT = """Transaction Statement for 9800000000
Apr 01, 2025 - Mar 31, 2026
Date Transaction Details Type Amount
Apr 10, 2025
10:00 AM
Paid to Mr Test Person
Transaction ID : T2504101000000000000001
UTR No : 900000000001
Debited from XX1111
Debit
INR 111.00
Apr 10, 2025
09:00 PM
Paid to FAKEMART
Transaction ID : T2504102100000000000002
UTR No : 100000000002
Debited from XX1111
Debit
INR 1234.00
Apr 12, 2025
12:00 PM
Paid to Another Person
Transaction ID : T2504121200000000000003
UTR No : 000000000003
Debited from XXXX99
Debit
INR 222.00
"""

CRED_TEXT = """date transaction details amount
21 mar 2025
04:00 PM
YES BANK 3141
transaction id : 01J0000000000000000000000A-0000001
UTR : CVFAKE0UTR00000000000000000000000001
₹4321.50
21 mar 2025
11:00 AM
IDFC FIRST FAKEGOLD 8642
transaction id : 01J0000000000000000000000B-0000002
UTR : CVFAKE0UTR00000000000000000000000002
₹1111.00
14 mar 2025
02:00 PM
RBL FAKESHOP 1357
transaction id : 01J0000000000000000000000C-0000003
UTR : CVFAKE0UTR00000000000000000000000003
₹38765.25
07 mar 2025
HSBC FAKE PLUS 2468
₹28765.00
"""

CC_STATEMENT_TEXT = """HSBC Credit Card Statement
Card Number: 4000 12XX XXXX 2468
Statement Date: 12/09/2025
Payment Due Date: 02/10/2025
Statement Period: 13/08/2025 to 12/09/2025
Total Amount Due: 12,345.00
Minimum Amount Due: 620.00
Credit Limit: 3,00,000.00 Available Credit Limit: 2,87,655.00
Domestic Transactions
14/08/2025 FAKE FOOD APP BANGALORE 450.00
20/08/2025 PAYMENT RECEIVED - THANK YOU 9,000.00 Cr
Visa Signature
"""


def make_cred_pdf(path: Path, rows: list[tuple[str, str, str, str, str, str]]) -> Path:
    """A CRED-style statement with real columns: (date, time, card, amount, txn id, utr)."""
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((93, 70), "transaction statement", fontsize=18)
    page.insert_text((93, 98), "01 Apr 2024 - 31 Mar 2025", fontsize=10.8)
    for x, word in ((49, "date"), (142, "transaction details"), (508, "amount")):
        page.insert_text((x, 163), word, fontsize=10.8)
    y = 205
    for date, time, card, amount, txn, utr in rows:
        page.insert_text((49, y), date, fontsize=10.8)
        page.insert_text((142, y), card, fontsize=10.8)
        page.insert_text((508, y), amount, fontsize=10.8)
        page.insert_text((49, y + 20), time, fontsize=9)
        page.insert_text((142, y + 20), "transaction id", fontsize=9)
        page.insert_text((223, y + 20), f": {txn}", fontsize=9)
        page.insert_text((142, y + 35), "UTR", fontsize=9)
        page.insert_text((223, y + 35), f": {utr}", fontsize=9)
        y += 78
    doc.save(path)
    doc.close()
    return path
