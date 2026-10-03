from app.models import Payee
from app.payees import match_payee, normalize_name

PAYEES = [
    Payee(id="water", name="Mr Test Kumar", label="Water delivery", category="bills.water"),
    Payee(id="rent", name="N V TESTNAME", label="Rent", category="home.rent"),
    Payee(id="shop", name="Fakeys", aliases=["Fakey's"], label="Fakeys", category="groceries"),
]


def test_normalize():
    assert normalize_name("Paid to Mr. Test  Kumar") == "test kumar"
    assert normalize_name("FAKEY'S") == "fakeys"


def test_match_ignores_case_honorifics_and_spacing():
    assert match_payee("Paid to MR TEST KUMAR", PAYEES).id == "water"
    assert match_payee("Test Kumar", PAYEES).id == "water"
    assert match_payee("NV TESTNAME", PAYEES).id == "rent"
    assert match_payee("n v testname", PAYEES).id == "rent"


def test_match_payee_followed_by_more_words():
    assert match_payee("FAKEYS CHICKEN CENTRE", PAYEES).id == "shop"
    assert match_payee("Fakey's", PAYEES).id == "shop"


def test_no_false_positives():
    assert match_payee("Test Kumari", PAYEES) is None  # different person
    assert match_payee("Fakeysree", PAYEES) is None
    assert match_payee("", PAYEES) is None
