"""Your credit card statements (data/card_statements.json): one record per statement you added, with what it
covers, the bank's own figures (previous balance, total due, due date, limit) and whether the rows read from it
add up to them. The rows themselves are transactions in the ledger; which bills pay which statement is worked out
in app/billing.py.
"""

from app import userdata
from app.models import CardStatement


def _file():
    return userdata.json_file("card_statements.json", default=list)


def list_statements() -> list[CardStatement]:
    return sorted((CardStatement.model_validate(r) for r in _file().read()), key=lambda s: s.period_end or "")


def save(statement: CardStatement) -> None:
    """Add or replace (a file read again with a better reader replaces its earlier reading)."""
    _file().update(lambda rows: [*(r for r in rows if r["id"] != statement.id), statement.model_dump(mode="json")])


def forget(upload_id: str) -> bool:
    found = False

    def apply(rows: list[dict]) -> list[dict]:
        nonlocal found
        keep = [r for r in rows if r["id"] != upload_id]
        found = len(keep) != len(rows)
        return keep

    _file().update(apply)
    return found
