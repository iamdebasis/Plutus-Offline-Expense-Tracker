"""The demo's made-up year (app/tools/demo.py) is a year that could happen: its files agree with one another the way
real ones do."""

from datetime import timedelta

from app.categorize import POSTED_WITHIN
from app.tools import demo


def test_a_card_receives_its_payment_on_or_after_the_day_it_was_paid():
    """The statement's "PAYMENT RECEIVED" posts the day the bill was paid, or a few days later, never before: so without
    the CRED history, the UPI payment that paid it is still linked to it, as a real one would be."""
    y = demo.make_year()
    received = [(r.day, r.amount) for _, _, rows, _, _ in y.statements for r in rows if r.details.startswith("PAYMENT RECEIVED")]
    assert len(received) >= 3
    for day, amount in received:
        paid = [b.at.date() for b in y.bills if b.card == "SBI CARD 1111" and abs(b.amount - amount) < 0.005]
        assert any(timedelta(0) <= day - p <= POSTED_WITHIN for p in paid), (day, amount, paid)
