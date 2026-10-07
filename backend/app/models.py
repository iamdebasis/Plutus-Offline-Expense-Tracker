from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class Model(BaseModel):
    """Stored and served as camelCase JSON."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, serialize_by_alias=True)


FileKind = Literal[
    "cc_statement",
    "cred_history",
    "upi_statement",
    "gpay_takeout",
    "screenshot",
    "bank_statement",
    "unknown",
]
DeclaredKind = Literal["auto", "cc_statement", "cred_history", "upi_statement", "screenshot"]


class CardRef(Model):
    issuer: str | None = None
    product: str | None = None
    last4: str
    network: str | None = None


class PaymentSource(Model):
    mask: str
    count: int


class Period(Model):
    start: str
    end: str


class Detection(Model):
    kind: FileKind
    label: str
    source: str | None = None
    confidence: float = 0.0
    pages: int | None = None
    text_layer: bool | None = None
    encrypted: bool = False
    period: Period | None = None
    cards: list[CardRef] = []
    payment_sources: list[PaymentSource] = []
    notes: list[str] = []


ImportState = Literal["queued", "running", "done", "failed", "skipped"]


class ImportStatus(Model):
    state: ImportState = "queued"
    step: str | None = None  # what's happening right now, for the UI
    method: str | None = None  # text / decoded / ocr / vision-model
    found: int = 0
    added: int = 0
    duplicates: int = 0
    needs_review: int = 0  # payees to review
    held: int = 0  # rows of a statement on hold: read, not counted until you confirm them
    error: str | None = None
    details: list[str] = []  # per part of a many-part export: what it held and what became of it
    finished_at: datetime | None = None


class UploadRecord(Model):
    id: str
    original_name: str
    stored_path: str
    sha256: str
    size: int
    media_type: str | None = None
    declared_kind: DeclaredKind = "auto"
    detection: Detection
    uploaded_at: datetime
    unlocked: bool = False
    detector_version: int = 1
    import_version: int = 0  # the reader version (imports.parser_version) the file was last read with
    import_status: ImportStatus | None = None


class UploadResult(UploadRecord):
    duplicate: bool = False


class Instrument(Model):
    id: str
    type: Literal["credit_card"] = "credit_card"
    issuer: str | None = None
    product: str | None = None
    last4: str
    network: str | None = None
    name: str
    first_seen: datetime
    sources: list[str] = []


class OwnAccount(Model):
    """One of your own bank accounts, which you said is yours (data/accounts.json)."""

    last4: str
    label: str = ""  # yours, e.g. "Rent account"
    seen_as: str = ""  # the name it was marked from, e.g. "Bank Account XXXXXX1234"
    added_at: datetime


class Payee(Model):
    id: str
    name: str
    aliases: list[str] = []
    label: str
    category: str
    notes: str = ""


class SourceRef(Model):
    upload: str
    page: int | None = None
    y: float | None = None  # a statement row: where on its page, in points from the top (to show it to you)


# A payment whose source shows no payee name. One placeholder for many different payees, so nothing is ever
# decided for the name itself: no answer, correction or AI guess for "Unknown" applies to them all.
NO_NAME = "Unknown"

TxnKind = Literal["spend", "refund", "cashback", "income", "transfer", "bill_payment"]
CategorizedBy = Literal["payee", "rule", "self", "dictionary", "learned", "heuristic", "llm", "user", "refund", "default"]


class Transaction(Model):
    """One money movement. Stored flat in data/ledger/<year>.json; views group it by year/card/month."""

    id: str
    at: datetime  # local time (IST) with offset
    amount: float  # always positive; see direction
    direction: Literal["debit", "credit"]
    kind: TxnKind = "spend"
    channel: Literal["upi", "card", "other"] = "upi"
    app: str | None = None  # phonepe / gpay / ...
    payee: str  # as shown by the source: "Mr Fake Payee", "FAKEMART"
    payee_handle: str | None = None  # UPI id when known
    paid_from: str | None = None  # masked account/card: "XX4321", "XXXX99"
    category: str = "uncategorized"
    categorized_by: CategorizedBy = "default"
    confidence: float = 0.0
    needs_review: bool = False
    refs: dict[str, str] = {}  # txnId, utr, ...
    sources: list[SourceRef] = []
    note: str = ""
    # For a refund: the payment it gives money back for (its id). Such a refund is filed where that payment
    # is and subtracted from it; one whose payment isn't in the ledger stays under Refunds in money in.
    refund_of: str | None = None
    # For a UPI payment to CRED or a card biller: the card bill in your CRED history it is (its id). The same
    # payment seen from the bank account's side; it's counted once, as that card's bill, never as spending.
    settles: str | None = None
    # For a row of a credit card statement: the card it was charged to (instrument id), and the bank's own
    # category for it ("RESTAURANTS"), a hint when the merchant isn't known. A RuPay card used on UPI is seen
    # by both statements; the two readings are one transaction that knows its card.
    card: str | None = None
    merchant_category: str | None = None


class CardPayment(Model):
    """A credit card bill payment. Settles card spend; never counted as spend itself."""

    id: str
    at: datetime
    amount: float
    card: str  # instrument id
    card_title: str
    refs: dict[str, str] = {}
    source: SourceRef
    # Where it was read: a payment app's history (CRED and similar), or a card statement's (or bank export's) own row
    # for it, when no app recorded that payment (app/billing.py: `statement_bills`, made again whenever bills are placed).
    origin: Literal["app", "statement"] = "app"
    verified: bool = True  # amount confirmed by two independent readings
    # The card statement this bill pays (its id), when you've added that statement: its purchases are counted
    # one by one, so the bill adds no estimate of its own.
    covered_by: str | None = None
    # The billing cycle it pays for (app/billing.py): that statement's period, the card's cycle as its statements
    # show it, or a guess for a card with none. Purchases in it already counted one by one (the card used on UPI)
    # come off; what's left is the card purchases this bill is taken to pay for.
    pays_from: date | None = None
    pays_to: date | None = None
    cycle: Literal["statement", "card", "guess"] | None = None
    counted: float = 0.0
    estimate: float = 0.0


StatementCheck = Literal["matched", "mismatch", "unchecked"]
# proven: the statement's own arithmetic accounts for every row (its totals, or a running balance). exact: read from a
# file's own cells (a CSV or Excel export). agreed: nothing to check against, but the rules and the local AI read the
# same rows. confirmed: you looked and said so. on_hold: none of those; its rows aren't counted until one is.
# None: read before statements had a status, counted as they always were.
StatementStatus = Literal["proven", "exact", "agreed", "confirmed", "on_hold"]


class CardStatement(Model):
    """One credit card statement you added (data/card_statements.json): what it covers, the bank's own figures,
    and whether the rows read from it add up to them."""

    id: str  # the upload's id
    # "statement": the bank's monthly statement, one billing cycle, with its totals. "export": the card's purchases
    # over a span you chose, from the bank's app or net banking (no cycle, usually no totals).
    kind: Literal["statement", "export"] = "statement"
    card: str | None = None  # instrument id
    issuer: str | None = None
    last4: str | None = None
    period_start: str | None = None  # YYYY-MM-DD
    period_end: str | None = None
    statement_date: str | None = None
    due_date: str | None = None
    previous_balance: float | None = None
    total_due: float | None = None
    minimum_due: float | None = None
    credit_limit: float | None = None
    # Its totals of debits and of credits, as printed: what a year's summary, with no balances, is checked against.
    printed_debits: float | None = None
    printed_credits: float | None = None
    debits: float = 0.0  # the rows read: purchases, fees, cash
    credits: float = 0.0  # payments, refunds, cashback
    rows: int = 0
    check: StatementCheck = "unchecked"
    difference: float | None = None  # by how much the rows miss the bank's figures, when they do
    status: StatementStatus | None = None
    proof: str = ""  # how its rows were proven, or why they couldn't be, in words
    # The rows of a statement on hold: read, shown in Your vault, not in the ledger until you confirm them.
    held: list[Transaction] = []
    edited: bool = False  # you corrected its held rows: a reader that can't prove its own reading leaves yours alone
    # Rows a summary of several statements lists outside their cycles (a year's file listing the month after its last
    # statement): no figure on the file covers them, so they wait for you, or for that month's statement.
    outside_cycles: bool = False
    # The file's pages it was read from, when the file holds several statements (a year's download); empty: all of them.
    pages: list[int] = []
    # Lines inside the transactions table that weren't read as rows though they carry an amount (a total, or a row
    # in a shape the reader didn't expect): where a missing row is, when the rows don't add up. Yours, kept in data/.
    unread: list[str] = []
