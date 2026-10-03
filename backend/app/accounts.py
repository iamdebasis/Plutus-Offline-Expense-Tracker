"""Your own bank accounts (data/accounts.json): money moved between them is left out of every total.

Accounts you pay from are recognised from your statements ("Debited from XX1234") and need no record. Any other
account of yours (the one you pay rent from, the one your SIPs go out of) becomes yours when you say so: answer
its payee with Ignored in "Needs your eyes", or ignore a transfer to it in the transactions list and confirm
it's yours. From then on every transfer to or from it is left out, whichever way a statement names it:
"Bank Account XXXXXX1234", "XXXX1234", or the UPI address "…1234@HDFC0001234.ifsc.npci".

Only the last four digits are kept, with the name it was marked from and your label ("Rent account"): enough to
recognise the account, never the account number.
"""

import re
from datetime import datetime, timezone

from app import userdata
from app.models import OwnAccount

_MASKED = re.compile(r"[xX*•]{2,}\s*(\d{4,})$")
_ADDRESS = re.compile(r"^(\d{6,})@[a-z0-9]+\.ifsc\.npci$", re.IGNORECASE)


def _file():
    return userdata.json_file("accounts.json", default=lambda: {"version": 1, "accounts": []})


def digits_of(raw: str | None) -> str | None:
    """The account number a name or UPI address shows, as far as it shows it: "Bank Account XXXXXX1234" → "1234",
    "500000001234@HDFC0001234.ifsc.npci" → "500000001234". None for anything that isn't a bank account."""
    s = (raw or "").strip()
    m = _MASKED.search(s) or _ADDRESS.match(s)
    return m.group(1) if m else None


def masked(name: str) -> str:
    """A name with any account number cut to its last four digits: "500000001234@HDFC0001234.ifsc.npci" →
    "XXXXXXXX1234@HDFC0001234.ifsc.npci". Names that show no number stay as they are."""
    return re.sub(r"(?<![A-Za-z0-9])\d{6,}", lambda m: "X" * (len(m.group()) - 4) + m.group()[-4:], name)  # not an IFSC's digits


def last4(*raw: str | None) -> str | None:
    """The last four digits of the first of these (a payee name, a UPI address) that names a bank account."""
    return next((d[-4:] for r in raw if (d := digits_of(r))), None)


def list_accounts() -> list[OwnAccount]:
    return [OwnAccount.model_validate(a) for a in _file().read()["accounts"]]


def is_yours(digits: str) -> bool:
    return any(a.last4 == digits for a in list_accounts())


def add(digits: str, seen_as: str, label: str = "") -> OwnAccount:
    """Mark an account as yours. Marking it again keeps your earlier label unless you give a new one."""
    now = datetime.now(timezone.utc)
    result: OwnAccount | None = None

    def apply(doc: dict) -> dict:
        nonlocal result
        rows = [OwnAccount.model_validate(a) for a in doc["accounts"]]
        old = next((a for a in rows if a.last4 == digits), None)
        result = OwnAccount(last4=digits, label=label.strip() or (old.label if old else ""),
                            seen_as=old.seen_as if old and old.seen_as else masked(seen_as), added_at=old.added_at if old else now)
        doc["accounts"] = [*(a.model_dump(mode="json") for a in rows if a.last4 != digits), result.model_dump(mode="json")]
        return doc

    _file().update(apply)
    assert result is not None
    return result


def remove(digits: str) -> OwnAccount | None:
    removed: OwnAccount | None = None

    def apply(doc: dict) -> dict:
        nonlocal removed
        keep = []
        for a in doc["accounts"]:
            if a["last4"] == digits:
                removed = OwnAccount.model_validate(a)
            else:
                keep.append(a)
        doc["accounts"] = keep
        return doc

    _file().update(apply)
    return removed
