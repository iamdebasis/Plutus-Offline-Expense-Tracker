"""The statement reader on statements nobody showed it (fake data only): random layouts from tests/statement_gen.py
must be read exactly and proven by their own arithmetic, or held, never counted wrong. Then the pieces: tokens, the
arithmetic that decides, and what a statement on hold does in the app."""

import time
from datetime import date, datetime

import pytest
from fastapi.testclient import TestClient

from app import imports, ledger, statements, vault
from app.ingest.detect import detect
from app.main import app
from app.parsers import IST, ParseError, card_statement
from app.parsers import statement_reader as rd
from app.parsers.card_statement import Line, Summary, Word
from app.parsers.shape_reader import tokens
from tests import fake_cards
from tests.statement_gen import generate, render


@pytest.mark.parametrize("first", range(0, 150, 25))
def test_any_statement_is_read_exactly_and_proven_or_held(tmp_path, first):
    """Every layout statements come in: one with its figures or a running balance is proven, row for row; an export
    with nothing to check against is held (not counted) with the right rows waiting for you. None fails, and none is
    counted wrong."""
    for seed in range(first, first + 25):
        st = generate(seed)
        path = render(st, tmp_path / f"s{seed}.pdf")
        res = card_statement.parse(path, f"u{seed}", detect(path, path.name))
        rows = res.transactions + [t for s in res.statements for t in s.held]  # counted, and held for you
        got = sorted((t.at.date(), t.amount, t.direction == "credit") for t in rows)
        assert got == st.truth(), f"seed {seed}: {st.style}"
        if st.style.kind == "year":  # its statements' cycles proven; what its list holds past them, held
            assert [s.status for s in res.statements] == ["proven"] + (["on_hold"] if st.after else []), f"seed {seed}: {res.statements[0].proof}"
            continue
        checkable = st.previous is not None or st.running_from is not None or st.style.totals
        assert len(res.statements) == len(st.parts or [st]), f"seed {seed}: one statement each"
        for s in res.statements:
            assert s.status == ("proven" if checkable else "on_hold"), f"seed {seed}: {s.proof}"


@pytest.mark.parametrize("seed", [106, 335, 383, 386, 901])
def test_layouts_that_once_tripped_the_reader(tmp_path, seed):
    """Random layouts that each found a weakness: a page of one row printed to one side, amounts of one width lining up
    on their left edges, a label running into the next one, a figure followed by "INR"."""
    st = generate(seed)
    path = render(st, tmp_path / f"s{seed}.pdf")
    res = card_statement.parse(path, f"u{seed}", detect(path, path.name))
    rows = res.transactions + [t for s in res.statements for t in s.held]
    assert sorted((t.at.date(), t.amount, t.direction == "credit") for t in rows) == st.truth()
    assert all(s.status == "proven" for s in res.statements), [s.proof for s in res.statements]


# ---- tokens --------------------------------------------------------------------------------------------------------


def _line(*texts: str) -> Line:
    x, words = 40.0, []
    for t in texts:
        words.append(Word(t, x, x + 5.0 * len(t), 10, 18))
        x += 5.0 * len(t) + 2.4
    return Line(words, 0)


def _money(*texts: str):
    return [(t.value, t.sign, t.mark, t.lead_c) for t in tokens(_line(*texts)) if t.kind == "money"]


def test_amounts_are_read_however_a_bank_prints_them():
    assert _money("1,23,456.78") == [(123456.78, "", "", False)]
    assert _money("₹1,234.50") == _money("Rs.", "1,234.50") == _money("INR", "1,234.50") == _money("`", "1,234.50") == [(1234.5, "", "", False)]
    assert _money("1,234.50Cr") == _money("1,234.50", "CR") == _money("1,234.50", "C") == [(1234.5, "", "cr", False)]
    assert _money("1,234.50", "Dr") == [(1234.5, "", "dr", False)]
    assert _money("+", "1,234.50") == [(1234.5, "+", "", False)]
    assert _money("(INR", "1,234.50)") == _money("(1,234.50)") == _money("(", "Rs.", "1,234.50", ")") == [(1234.5, "()", "", False)]
    assert _money("+", "C", "1,234.50") == [(1234.5, "+", "", True)]  # a font that draws ₹ as "C"
    assert _money("12") == [] and _money("1,200") == []  # points, not money


def test_dates_are_found_glued_to_times_and_words():
    kinds = [(t.kind, t.text) for t in tokens(_line("12/08/2026|14:05", "FAKE", "SHOP"))]
    assert kinds[:3] == [("date", "12/08/2026"), ("time", "14:05"), ("text", "FAKE")]
    kinds = [(t.kind, t.text) for t in tokens(_line("21-May-2026|", "11:22REVERSAL"))]
    assert kinds == [("date", "21-May-2026"), ("time", "11:22"), ("text", "REVERSAL")]
    assert [t.kind for t in tokens(_line("12", "MARKET", "ROAD"))] == ["number", "text", "text"]  # not 12 March
    assert [t.kind for t in tokens(_line("1.12"))] == ["money"]  # an amount, not a date without its year
    # a month and its year (a summary's "May 2025") isn't the 20th of May: a day and its year are set apart
    assert card_statement.parse_date("May 2025") is None and card_statement.parse_date("Aug 14 2026") == date(2026, 8, 14)


# ---- the arithmetic decides ----------------------------------------------------------------------------------------


def _row(day: int, amount: float, **kw) -> rd.Candidate:
    return rd.Candidate(date(2026, 8, day), True, "", kw.pop("description", "FAKE SHOP"), "", amount, **kw)


def test_only_one_set_of_rows_adding_up_is_proof():
    summary = Summary(previous_balance=1000.0, total_due=1500.0)
    # "+" could mean credit or debit; only "debit" adds up here: proven
    plus = rd.Reading("shape", [_row(1, 700.0, sign="+"), _row(2, 200.0, description="PAYMENT RECEIVED", mark="cr")])
    d = rd.decide([plus], summary, date(2026, 8, 31), None)
    assert (d.status, d.credits) == ("proven", [False, True])
    # two different readings, both adding up: which is right isn't known, so neither is counted
    a = rd.Reading("table", [_row(1, 500.0)])
    b = rd.Reading("shape", [_row(2, 500.0)])
    assert rd.decide([a, b], summary, date(2026, 8, 31), None).status == "on_hold"
    # nothing adds up: held, with the nearest reading for you to check
    assert rd.decide([rd.Reading("table", [_row(1, 499.0)])], summary, date(2026, 8, 31), None).status == "on_hold"


def test_a_running_balance_proves_its_rows_either_way_round():
    rows = [_row(1, 100.0, balance=1100.0), _row(2, 40.0, balance=1060.0, description="REFUND FAKE SHOP"), _row(3, 5.0, balance=1065.0)]
    opening = Summary(previous_balance=1000.0)
    assert rd.decide([rd.Reading("shape", rows)], opening, None, None).credits == [False, True, False]
    newest_first = list(reversed([_row(1, 100.0, balance=1100.0), _row(2, 40.0, balance=1060.0), _row(3, 5.0, balance=1065.0)]))
    d = rd.decide([rd.Reading("shape", newest_first)], opening, None, None)
    assert (d.status, d.credits) == ("proven", [False, True, False])
    # no opening balance and nothing about the first row says which way it went: not proof
    unclear = [_row(1, 100.0, balance=1100.0), _row(2, 40.0, balance=1060.0)]
    assert rd.decide([rd.Reading("shape", unclear)], Summary(), None, None).status == "on_hold"


def test_equal_balances_and_no_rows_read_is_not_a_quiet_month(tmp_path):
    """Payments can match purchases to the paisa: a table that wasn't read must never pass for an empty one."""
    page = fake_cards.Page().at(40, "Credit Card Statement").down().at(40, "Card No: 4000 00XX XXXX 3141").down()
    page.at(40, "Statement Date: 12/09/2026").down().at(40, "Previous Balance: 9,000.00").down().at(40, "Total Amount Due: 9,000.00")
    path = fake_cards.save(tmp_path / "s.pdf", [page])
    with pytest.raises(ParseError):
        card_statement.parse(path, "u", detect(path, path.name))


def test_a_statement_that_doesnt_add_up_is_held_with_its_rows(tmp_path):
    path = fake_cards.axis(tmp_path / "axis.pdf", tamper=True)  # one printed amount differs from the totals
    res = card_statement.parse(path, "u", detect(path, path.name))
    assert (res.statement.status, res.statement.check, res.statement.difference) == ("on_hold", "mismatch", 100.0)
    assert any("On hold, not counted yet" in w for w in res.warnings)


# ---- layouts that once hid every row --------------------------------------------------------------------------------


def _sum_box(path, pi: list[str] | None = None, header: bool = True, shift: float = 6.0):
    """A summary printed as a sum under its labels, with a due date and no statement date, the total due rounded to the
    rupee; a note that names the Terms and Conditions in passing, and a line that looks like their heading, above the
    table; the time glued to the date, reward points before the amount, "C" for ₹ and "+" before a credit, a one-letter
    column after the amount (`pi`); the first page's table `shift` points to one side of the second's; the terms at the
    end, with a worked example dated inside the statement's period. Without its `header`, only the shape reader can
    read it."""
    from tests.fake_cards import CREDITS, DEBITS, PREVIOUS, ROWS, TOTAL_DUE, Page, _width, inr, save

    def table(page: Page, rows, right: float) -> None:
        page.at(40, "Domestic Transactions", 10).down(16)
        if header:
            page.at(40, "DATE & TIME", 8).at(150, "TRANSACTION DESCRIPTION", 8).at(400, "REWARDS", 8).at(right - 30, "AMOUNT", 8)
            page.at(556, "PI", 8).down()
        for t in rows:
            n = ROWS.index(t)
            amount = f"{'+ ' if t.credit else ''}C {inr(t.amount)}"
            page.at(40, f"{t.day:%d/%m/%Y}| {10 + n % 12:02d}:{5 * n % 60:02d}", 8).at(150, t.details, 8)
            if not t.credit:
                page.at(420, f"+ {int(t.amount // 100)}", 8)
            page.at(right - _width(amount, 8), amount, 8).at(556, (pi or ["l"])[n % len(pi or ["l"])], 8).down(14)

    first = Page()
    first.at(40, "Fake Bank Credit Card Statement", 13).down(20).at(40, "Card No: 4000 00XX XXXX 3141").down(22)
    labels = ["PREVIOUS STATEMENT DUES", "PAYMENTS/CREDITS RECEIVED", "PURCHASES/DEBITS", "FINANCE CHARGES", "TOTAL AMOUNT DUE"]
    for i, label in enumerate(labels):
        first.at(40 + i * 110, label, 6.5)
    first.down(12)
    for i, (value, op) in enumerate(zip([PREVIOUS, CREDITS, DEBITS, 0.0, float(round(TOTAL_DUE))], ["_", "+", "+", "=", ""])):
        first.at(40 + i * 110, f"C{inr(value)}", 8).at(140 + i * 110, op, 8)
    first.down(22)
    for i, (label, value) in enumerate([("TOTAL CREDIT LIMIT", "C3,00,000.00"), ("MINIMUM DUE", "C600.00"), ("DUE DATE", "02 Oct, 2026")]):
        first.at(40 + i * 135, label, 6.5).at(40 + i * 135, value, 8, y=first.y + 12)
    first.down(34).at(40, "Fees and charges on your card are as per the Terms and Conditions on the bank's website, for example a late fee.", 7)
    first.down().at(40, "Terms and Conditions apply.", 7).down(24)
    table(first, ROWS[:4], right=540 + shift)
    second = Page()
    table(second, ROWS[4:], right=540)
    second.down(20).at(40, "Terms and Conditions", 10).down()
    second.at(40, "For example, a purchase made as below is charged interest from the day it was made:", 8).down()
    second.at(40, "20/08/2026| 10:00", 8).at(150, "A PURCHASE OF A FAKE GADGET", 8).at(500, "C 4,000.00", 8).down()
    return save(path, [first, second])


@pytest.mark.parametrize("pi, header, shift", [(None, True, 6.0), (None, False, 6.0), (["C", "D", "l"], False, 6.0), (None, False, -40.0)])
def test_a_statement_laid_out_the_way_that_once_hid_its_rows_is_proven(tmp_path, pi, header, shift):
    """Every row read, proven by the summary's sum (to the rupee the bank rounded its total to), with the due date
    dating it; whatever the column after the amount holds, even a C or a D that isn't a Cr or Dr."""
    from tests.fake_cards import ROWS

    path = _sum_box(tmp_path / "s.pdf", pi, header, shift)
    res = card_statement.parse(path, "u", detect(path, path.name))
    s = res.statement
    assert (s.status, s.check, s.kind, s.due_date) == ("proven", "matched", "statement", "2026-10-02")
    got = sorted((t.at.date(), t.amount, t.direction == "credit") for t in res.transactions)
    assert got == sorted((t.day, t.amount, t.credit) for t in ROWS)
    assert all(t.at.hour or t.at.minute for t in res.transactions)  # the time glued to its date


@pytest.mark.parametrize("header", [True, False])
def test_a_years_summary_with_only_totals_is_proven_by_them(tmp_path, header):
    """A year's statement prints no balances: its totals of debits and of credits (under labels wrapped over two lines)
    prove the rows instead, each to the paisa. The Dr/Cr marks sit in a column with the card's number after it; its
    period is in months."""
    path = fake_cards.year_end(tmp_path / "year.pdf", header)
    res = card_statement.parse(path, "u", detect(path, path.name))
    s = res.statement
    assert (s.status, s.check, s.kind, s.period_start, s.period_end) == ("proven", "matched", "export", "2026-04-01", "2027-03-31")
    assert (s.printed_debits, s.printed_credits) == (s.debits, s.credits)
    got = sorted((t.at.date(), t.amount, t.direction == "credit") for t in res.transactions)
    assert got == sorted((t.day, t.amount, t.credit) for t in fake_cards.YEAR)


def test_a_years_summary_listing_more_than_its_statements_counts_what_they_prove_and_holds_the_rest(client, tmp_path):
    """Its totals are the eleven statements dated in its year; its list runs to the year's end, past the last of them.
    The rows within those statements' cycles are proven and counted; the month after the last statement waits, held:
    nothing on the file adds it up."""
    from tests.fake_cards import AFTER, YEAR

    upload_id, _ = _upload(client, fake_cards.year_end(tmp_path / "year.pdf", after=True))
    parts = sorted((s for s in client.get("/api/card-statements").json() if s["id"].startswith(upload_id)), key=lambda s: s["id"])
    assert [(s["status"], s["check"]) for s in parts] == [("proven", "matched"), ("on_hold", "unchecked")]
    assert (parts[0]["periodStart"], parts[0]["periodEnd"]) == ("2026-04-02", "2027-03-01")
    counted = sorted((t["at"][:10], t["amount"], t["direction"] == "credit") for t in client.get("/api/transactions").json())
    assert counted == sorted((t.day.isoformat(), t.amount, t.credit) for t in YEAR)
    held = sorted((t["at"][:10], t["amount"], t["direction"] == "credit") for t in parts[1]["held"])
    assert held == sorted((t.day.isoformat(), t.amount, t.credit) for t in AFTER) and parts[1]["outsideCycles"]
    # every row cites the file itself, so its page can be shown, whichever part of the file it's in
    rows = client.get("/api/transactions").json() + parts[1]["held"]
    assert {src["upload"] for t in rows for src in t["sources"]} == {upload_id}
    assert client.get(f"/api/uploads/{upload_id}/file").status_code == 200
    # deleting the file takes all of it, both parts
    client.delete(f"/api/uploads/{upload_id}")
    assert client.get("/api/transactions").json() == [] and not [s for s in client.get("/api/card-statements").json() if s["id"].startswith(upload_id)]


@pytest.mark.parametrize("layout", ["sbi_card", "sbi_card_immediate", "icici_bold", "amex", "hdfc_wrapped"])
def test_each_banks_statement_as_its_made_is_read_exactly_and_proven(tmp_path, layout):
    """Layouts as banks make them (from public parsers of their statements, fake data): SBI Card's undated GST row and
    flattened summary, ICICI's doubled bold headings, American Express's opening and closing balance, HDFC's
    descriptions wrapped above their row."""
    from tests.fake_cards import ROWS

    make = getattr(fake_cards, layout.removesuffix("_immediate"))
    path = make(tmp_path / "s.pdf", immediate=True) if layout.endswith("_immediate") else make(tmp_path / "s.pdf")
    res = card_statement.parse(path, "u", detect(path, path.name))
    s = res.statement
    assert (s.status, s.check) == ("proven", "matched"), s.proof
    got = sorted((t.at.date(), t.amount, t.direction == "credit") for t in res.transactions)
    assert got == sorted((t.day, t.amount, t.credit) for t in ROWS)
    if layout == "sbi_card_immediate":
        assert s.due_date == s.statement_date == "2026-09-12"  # due at once
    if layout == "amex":
        from tests.fake_cards import CREDITS, DEBITS

        assert (s.printed_debits, s.printed_credits, s.minimum_due) == (DEBITS, CREDITS, 1000.0)
    if layout == "hdfc_wrapped":
        assert {t.note for t in res.transactions} >= {"PYU*FAKE GROCER BANGALORE", "FOREIGN CURRENCY TRANSACTION FEE"}


def test_totals_that_dont_match_hold_the_statement():
    rows = [_row(1, 700.0), _row(2, 200.0, description="PAYMENT RECEIVED", mark="cr")]
    totals = Summary(printed_debits=700.0, printed_credits=200.0)
    assert rd.decide([rd.Reading("table", rows)], totals, None, None).status == "proven"
    off = Summary(printed_debits=700.0, printed_credits=250.0)
    d = rd.decide([rd.Reading("table", rows)], off, None, None)
    assert (d.status, d.difference) == ("on_hold", -50.0)
    # with a previous balance and a total due, those decide: a box's "Purchases" can leave out the fees
    both = Summary(previous_balance=100.0, total_due=600.0, printed_debits=650.0, printed_credits=200.0)
    assert rd.decide([rd.Reading("table", rows)], both, None, None).status == "proven"


def test_a_table_header_read_where_its_columns_really_are():
    """A title over the header isn't part of it, and a column after the amount whose values start left of its
    centred heading (the card's number) isn't read into the amount."""
    def line(y: float, *cells: tuple[float, str]) -> Line:
        words = []
        for x, text in cells:
            for w in text.split():
                words.append(Word(w, x, x + 5.0 * len(w), y - 8, y))
                x += 5.0 * len(w) + 2.4
        return Line(words, 0)

    title = line(100, (45, "Transaction Details - Primary Card Holder"))
    header = line(112, (45, "Date"), (200, "Transaction Description"), (470, "Amount"), (518, "DR/CR"), (570, "Card Number"))
    row = line(124, (45, "02-Apr-2026"), (130, "FAKE SHOP"), (470, "1,234.50"), (527, "CR"), (562, "400000XXXXXX3141"))
    assert card_statement._header(title, header) is None
    cols = card_statement._header(header, row)
    assert cols is not None and (cols.details, cols.amount_at) == (200, 470)
    amount = card_statement._amount_in(row, cols)
    assert amount is not None and (amount.value, amount.mark) == (1234.5, "cr")


def test_a_table_printed_a_little_to_one_side_on_one_page_is_one_column():
    from app.parsers import shape_reader as sr

    def row(page: int, right: float, table: int) -> sr.Shaped:
        tok = sr.Tok("money", "1,234.50", right - 30, right, value=1234.5)
        return sr.Shaped(date(2026, 8, 1), True, "", "FAKE SHOP", [tok], 0, page, 100.0, None, False, False, table=table)

    shifted = [row(0, 546.0, 1), row(0, 546.0, 1), row(1, 540.0, 2), row(1, 540.0, 2), row(1, 540.0, 2)]
    columns = sr.money_columns(shifted)
    assert len(columns) == 1 and all(columns[0].holds(r.amounts[0]) for r in shifted)
    alone = [row(0, 540.0, 1) for _ in range(6)] + [row(1, 545.0, 2)]  # a page of one row, printed to one side
    columns = sr.money_columns(alone)
    assert len(columns) == 1 and all(columns[0].holds(r.amounts[0]) for r in alone)
    side_by_side = [row(0, 480.0, 1), row(0, 546.0, 1), row(1, 540.0, 2), row(1, 480.0, 2)]  # two columns in each table
    assert len(sr.money_columns(side_by_side)) == 2


def test_a_summary_label_never_runs_into_the_next_one_and_a_figure_is_never_a_date():
    labels = Line([Word("Payments", 160, 195, 10, 18), Word("&", 197, 202, 10, 18), Word("Credit", 280, 304, 10, 18)], 0)
    text = labels.text.lower()
    start = text.index("payments")
    assert card_statement._across_cells(labels, start, start + len("payments & credit"))  # "Credit" starts "Credit Limit"
    assert not card_statement._across_cells(labels, start, start + len("payments &"))
    # "…67.87 INR 300,000.00": the end of one figure and the start of the next, not the 87th of "INR"
    assert card_statement._value("INR 135,667.87 INR 300,000.00", "printed_credits") == 135667.87


def test_only_a_heading_starts_the_terms_and_a_table_after_them_is_read():
    def lines(*texts: str) -> list[Line]:
        return [Line([Word(w, 40.0 + 30 * k, 40.0 + 30 * k + 25, 10 + 15 * i, 18 + 15 * i) for k, w in enumerate(t.split())], 0)
                for i, t in enumerate(texts)]

    mention = lines("Fees are charged as per the Terms and Conditions on our website.", "12/08/2026 FAKE SHOP 100.00")
    assert card_statement.in_terms(mention) == [False, False]
    footnote = lines("Terms and Conditions apply.", "Date Transaction Details Amount", "12/08/2026 FAKE SHOP 100.00")
    assert card_statement.in_terms(footnote) == [True, False, False]
    terms = lines("Terms and Conditions", "Date Transaction Amount", "20/08/2026 A FAKE EXAMPLE 4,000.00")
    assert card_statement.in_terms(terms) == [True, True, True]  # an example's table names no description column


def test_a_year_of_statements_dated_only_by_their_due_dates_is_split_and_each_proven(tmp_path):
    from tests.statement_gen import Style

    seed = next(k for k in range(2000) if (g := generate(k)).parts and g.style.summary == "sum")
    st = generate(seed)
    assert isinstance(st.style, Style)
    path = render(st, tmp_path / "year.pdf")
    res = card_statement.parse(path, "u", detect(path, path.name))
    assert len(res.statements) == len(st.parts) and all(s.status == "proven" for s in res.statements)
    assert sorted((t.at.date(), t.amount, t.direction == "credit") for t in res.transactions) == st.truth()


# ---- what each row is ----------------------------------------------------------------------------------------------


def test_paying_the_card_is_a_bill_payment_however_the_bank_words_it():
    classify = card_statement.classify
    assert classify("FAKEPAY CC PAYMENT FK0000000000 (Ref# FK0000000000000000)", True) == "bill_payment"
    assert classify("PAYMENT RECEIVED - THANK YOU", True) == "bill_payment"
    assert classify("REFUND OF PAYMENT FAKE SHOP", True) == "refund"
    assert classify("FAKE SHOP", True) == "refund"
    assert classify("FAKE PAYMENTS PVT LTD", True) == "refund"  # a shop's name, not a payment to the card


def test_a_badge_on_a_row_is_a_tag_not_part_of_what_it_says(client, tmp_path):
    """A bank tags a purchase it would turn into EMIs with "EMI" in a small pill before the shop's name: the purchase
    is an ordinary one, under the shop's own name. The same word in the description itself still reads."""
    from tests.fake_cards import Page, inr, save

    p = Page().at(40, "Fake Bank Credit Card Statement", 13).down(20).at(40, "Card No: 4000 00XX XXXX 3141").down()
    p.at(40, "Statement Date: 01/10/2026").at(320, "Payment Due Date: 21/10/2026").down()
    p.at(40, f"Previous Balance: {inr(0)}").at(320, f"Total Amount Due: {inr(15555.67)}").down(24)
    p.at(40, "Date").at(150, "Transaction Details").at(480, "Amount (Rs.)").down()
    p.at(40, "15/09/2026").badge(120, "EMI").at(150, "FAKEPHONESTORE").at(480, inr(12345.67)).down()
    p.at(40, "25/09/2026").badge(120, "EMI").at(150, "FAKE LAPTOP STORE MUMBAI").at(480, inr(3210.00)).down()
    path = save(tmp_path / "s.pdf", [p])
    upload_id, _ = _upload(client, path)
    assert statements.get(upload_id).status == "proven"
    txns = client.get("/api/transactions").json()
    assert sorted(t["payee"] for t in txns) == ["FAKE LAPTOP STORE", "FAKEPHONESTORE"]
    assert all(t["kind"] == "spend" and "EMI" not in t["note"] for t in txns)


def test_an_emis_instalments_are_spending_and_a_loans_are_not():
    classify = card_statement.classify
    assert classify("SMARTEMI LOAN 1 OF 12 PRINCIPAL FAKE PHONE", False) == "spend"  # a purchase turned into EMIs: banks call it a loan too
    assert classify("SMARTEMI BOOKING FAKE PHONE", True) == "refund"  # the purchase, credited back as its instalments begin
    assert classify("INSTA JUMBO LOAN EMI 2/24", False) == "transfer"  # cash lent to your bank account
    assert classify("EMI FAKEPHONESTORE", False) == "spend"  # what you pay for the purchase, bill by bill
    assert classify("FAKE PHONE EMI 3/12", False) == "spend"
    assert classify("EMI INTEREST FAKE PHONE", False) == "spend"
    assert classify("FAKE INSTA LOAN EMI 2/12", False) == "transfer"  # the loan went to your bank account
    assert classify("EMI CONVERSION FAKE PHONE", True) == "refund"  # the purchase, credited back as EMIs begin
    assert card_statement.clean_merchant("EMI FAKEPHONESTORE") == "FAKEPHONESTORE"


def _a_bill(path, payment: str = "FAKEPAY CC PAYMENT FK0000000000 (Ref# FK0000000000000000)"):
    """A month on a card: last month's bill paid (in the bank's own words), purchases, a refund, two EMI instalments;
    a previous balance a little more than was paid, and a total due the bank rounded."""
    from tests.fake_cards import Page, inr, save

    previous, paid = 5000.71, 5000.00
    rows = [("05/09/2026", payment, paid, True), ("06/09/2026", "FAKE FOOD APP", 333.33, True),
            ("03/09/2026", "FAKE FOOD APP", 650.00, False), ("10/09/2026", "UPI-FAKE GROCER-grocer@okfake", 1234.50, False),
            ("15/09/2026", "EMI FAKEPHONESTORE", 1111.11, False), ("25/09/2026", "EMI FAKE-LAPTOPSTORE MUMBAI", 2222.22, False)]
    debits = round(sum(a for *_, a, c in rows if not c), 2)
    credits = round(sum(a for *_, a, c in rows if c), 2)
    due = float(round(previous - credits + debits))
    p = Page().at(40, "Fake Bank Credit Card Statement", 13).down(20).at(40, "Card No: 4000 00XX XXXX 3141").down()
    p.at(40, "Statement Date: 01/10/2026").at(320, "Payment Due Date: 21/10/2026").down()
    p.at(40, f"Previous Balance: {inr(previous)}").at(320, f"Total Amount Due: {inr(due)}").down(24)
    p.at(40, "Date").at(120, "Transaction Details").at(480, "Amount (Rs.)").down()
    for day, details, amount, credit in rows:
        p.at(40, day).at(120, details).at(480, f"{inr(amount)}{' Cr' if credit else ''}").down()
    return save(path, [p]), due, round(previous - paid, 2)


@pytest.mark.parametrize("payment", ["FAKEPAY CC PAYMENT FK0000000000 (Ref# FK0000000000000000)", "FAKEBANK TRANSFER FK0000000000"])
def test_a_months_spending_comes_to_the_bill_less_what_was_left_from_the_last(client, tmp_path, payment):
    """Spending (purchases and EMI instalments, the refund taken off) and the bill reconcile: last month's payment is a
    card bill payment, never income, whether it says so or only pays the previous balance; nothing is left out."""
    path, due, carried = _a_bill(tmp_path / "bill.pdf", payment)
    upload_id, status = _upload(client, path)
    assert statements.get(upload_id).status == "proven"
    txns = client.get("/api/transactions").json()
    payment = next(t for t in txns if t["kind"] == "bill_payment")
    assert (payment["category"], payment["amount"]) == ("transfers.card_bill", 5000.0)
    emis = [t for t in txns if "EMI" in t["note"]]
    assert len(emis) == 2 and all(t["category"] != "ignored" for t in emis)
    spent = sum(-t["amount"] if t["direction"] == "credit" else t["amount"] for t in txns
                if t["category"] != "transfers.card_bill" and (t["direction"] == "debit" or t.get("refundOf")))
    assert abs(due - (spent + carried)) <= 0.5  # the bank rounded its total due


def test_a_statement_read_by_the_old_rules_is_put_right_when_read_again(client, tmp_path, monkeypatch):
    """Added before a payment in the bank's own words was known, and when EMIs were left out: read again by the newer
    reader, the payment becomes a card bill payment and the instalments spending."""
    def old_rules(description: str, credit: bool) -> str:
        if credit:
            return "bill_payment" if card_statement._PAYMENT.search(description) else "refund"
        return "transfer" if card_statement._EMI.search(description) else "spend"

    path, _, _ = _a_bill(tmp_path / "bill.pdf")
    with monkeypatch.context() as m:
        m.setattr(card_statement, "classify", old_rules)
        m.setattr(card_statement, "pays_the_last_bill", lambda amount, summary: False)
        m.setattr(card_statement, "is_emi", lambda d: False)
        upload_id, _ = _upload(client, path)
        before = client.get("/api/transactions").json()
        assert any(t["category"] == "income.refund" and t["amount"] == 5000.0 for t in before)
        assert sum(t["category"] == "ignored" for t in before) == 2
    vault.update_upload(upload_id, import_version=imports.parser_version("cc_statement") - 1)
    client.post(f"/api/uploads/{upload_id}/reimport")
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline and (next(u for u in client.get("/api/uploads").json() if u["id"] == upload_id).get("importStatus") or {}).get("state") not in ("done", "failed"):
        time.sleep(0.1)
    after = client.get("/api/transactions").json()
    assert next(t for t in after if t["amount"] == 5000.0)["category"] == "transfers.card_bill"
    assert len(after) == len(before) and not any(t["category"] == "ignored" for t in after)


def test_a_purchase_turned_into_emis_is_counted_once():
    """Credited back when its EMIs begin: netted against the purchase it was (same card, same amount), so only the
    instalments count; with that purchase not in the ledger, the credit is left out, not taken for income."""
    from datetime import timedelta

    from app import categorize
    from app.models import Transaction

    def row(n: int, note: str, amount: float, direction: str, days: int) -> Transaction:
        return Transaction(id=f"t{n}", at=datetime(2026, 8, 1, tzinfo=IST) + timedelta(days=days), amount=amount, direction=direction,
                           kind="refund" if direction == "credit" else "spend", channel="card", payee=note, note=note,
                           card="card:fake", category="income.refund" if direction == "credit" else "shopping")

    purchase, other = row(1, "FAKE PHONE STORE", 24000.0, "debit", 0), row(2, "FAKE GROCER", 24000.0, "debit", 2)
    other.card = "card:another"
    credit = row(3, "EMI CONVERSION 0000", 24000.0, "credit", 5)
    txns = [purchase, other, credit]
    categorize.link_refunds(txns)
    assert credit.refund_of == "t1"  # the same card's purchase of that amount
    alone = row(4, "EMI CONVERSION 0001", 9999.0, "credit", 5)
    smart = row(7, "SMARTEMI BOOKING 0002", 5555.0, "credit", 5)
    categorize.link_refunds([alone, smart])
    assert (alone.refund_of, alone.category, smart.category) == (None, "ignored", "ignored")
    # a refund under another name than its purchase: the same card's purchase of exactly that much
    shop = row(5, "FAKE SHOE STORE", 2499.0, "debit", 0)
    back = row(6, "FAKE PAY INDIA REVERSAL", 2499.0, "credit", 3)
    categorize.link_refunds([shop, back])
    assert back.refund_of == "t5"


# ---- a statement on hold in the app --------------------------------------------------------------------------------


@pytest.fixture
def client():
    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def _upload(client, path):
    with path.open("rb") as f:
        upload_id = client.post("/api/uploads", files={"file": (path.name, f, "application/pdf")}, data={"kind": "auto"}).json()["id"]
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        rec = next(u for u in client.get("/api/uploads").json() if u["id"] == upload_id)
        if (rec.get("importStatus") or {}).get("state") in ("done", "failed", "skipped"):
            return upload_id, rec["importStatus"]
        time.sleep(0.1)
    raise AssertionError("import didn't finish")


def test_a_held_statement_counts_nothing_until_you_confirm_it(client, tmp_path):
    upload_id, status = _upload(client, fake_cards.axis(tmp_path / "axis.pdf", tamper=True))
    assert (status["state"], status["held"], status["added"]) == ("done", len(fake_cards.ROWS), 0)
    assert client.get("/api/transactions").json() == []  # nothing counted
    held = next(s for s in client.get("/api/card-statements").json() if s["id"] == upload_id)
    assert (held["status"], len(held["held"])) == ("on_hold", len(fake_cards.ROWS))
    assert upload_id not in {s.id for s in statements.counted()}  # and it covers no bill

    # you fix the misread row: it adds up now, and still waits for you
    rows = [{"at": t["at"], "amount": 8999.00 if t["amount"] == 8899.00 else t["amount"], "direction": t["direction"],
             "description": t["note"] or t["payee"]} for t in held["held"]]
    fixed = client.put(f"/api/card-statements/{upload_id}/held", json=rows).json()
    assert (fixed["status"], fixed["check"], fixed["edited"]) == ("on_hold", "matched", True)
    assert client.get("/api/transactions").json() == []

    confirmed = client.post(f"/api/card-statements/{upload_id}/confirm").json()
    assert (confirmed["status"], confirmed["held"]) == ("confirmed", [])
    assert len(client.get("/api/transactions").json()) == len(fake_cards.ROWS)

    # read again by a reader that still can't prove it: what you confirmed stays
    vault.update_upload(upload_id, import_version=imports.parser_version("cc_statement") - 1)
    client.post(f"/api/uploads/{upload_id}/reimport")
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline and (next(u for u in client.get("/api/uploads").json() if u["id"] == upload_id).get("importStatus") or {}).get("state") not in ("done", "failed"):
        time.sleep(0.1)
    assert statements.get(upload_id).status == "confirmed"
    assert len(ledger.load_transactions()) == len(fake_cards.ROWS)


def test_only_a_statement_on_hold_can_be_corrected_or_confirmed(client, tmp_path):
    upload_id, _ = _upload(client, fake_cards.axis(tmp_path / "axis.pdf"))
    assert statements.get(upload_id).status == "proven"
    assert client.post(f"/api/card-statements/{upload_id}/confirm").status_code == 409
    assert client.put("/api/card-statements/nope/held", json=[]).status_code == 404
    bad = [{"at": datetime(2026, 8, 1, tzinfo=IST).isoformat(), "amount": -5, "direction": "debit", "description": "X"}]
    assert client.put(f"/api/card-statements/{upload_id}/held", json=bad).status_code == 422


def test_a_rows_place_on_its_page_and_the_file_itself_only_for_this_app(client, tmp_path):
    """To check a row against the statement, the app shows the page it's on with the row marked: the file comes from
    data/, to this app's own page only."""
    path = fake_cards.axis(tmp_path / "axis.pdf", tamper=True)
    upload_id, _ = _upload(client, path)
    row = statements.get(upload_id).held[0]
    assert row.sources[0].page == 1 and row.sources[0].y and 0 < row.sources[0].y < 842
    served = client.get(f"/api/uploads/{upload_id}/file")
    assert served.status_code == 200 and served.content == path.read_bytes()
    assert client.get("/api/uploads/nope/file").status_code == 404
    assert client.get(f"/api/uploads/{upload_id}/file", headers={"sec-fetch-site": "cross-site"}).status_code == 403
