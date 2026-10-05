"""Your credit card statements (data/card_statements.json): one record per statement you added, with what it
covers, the bank's own figures (previous balance, total due, due date, limit) and whether the rows read from it
add up to them. The rows themselves are transactions in the ledger, except a statement on hold's: those wait here,
uncounted, until you confirm them. Which bills pay which statement is worked out in app/billing.py.
"""

from app import userdata
from app.models import CardStatement


def _file():
    return userdata.json_file("card_statements.json", default=list)


def list_statements() -> list[CardStatement]:
    return sorted((CardStatement.model_validate(r) for r in _file().read()), key=lambda s: s.period_end or "")


def counted() -> list[CardStatement]:
    """The statements whose rows are in the ledger: every one but those on hold."""
    return [s for s in list_statements() if s.status != "on_hold"]


def get(statement_id: str) -> CardStatement | None:
    return next((s for s in list_statements() if s.id == statement_id), None)


def save(statement: CardStatement) -> None:
    """Add or replace (a file read again with a better reader replaces its earlier reading)."""
    _file().update(lambda rows: [*(r for r in rows if r["id"] != statement.id), statement.model_dump(mode="json")])


def of_upload(statement_id: str) -> str:
    """The file a statement was read from: its id, or the part before "~" for one of several in a file."""
    return statement_id.split("~", 1)[0]


def forget(upload_id: str) -> bool:
    found = False

    def apply(rows: list[dict]) -> list[dict]:
        nonlocal found
        keep = [r for r in rows if of_upload(r["id"]) != upload_id]
        found = len(keep) != len(rows)
        return keep

    _file().update(apply)
    return found
