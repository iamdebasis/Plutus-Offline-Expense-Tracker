"""Your own lookup table for UPI payments to people ("Mr Fake Payee" -> Water delivery).

Lives in data/payees.json because the names are personal. A payee always wins over the merchant
dictionary and the LLM when categorizing.
"""

import hashlib
import json
import re

from app import userdata
from app.jsonstore import JsonFile
from app.models import Payee

HONORIFICS = {"mr", "mrs", "ms", "miss", "dr", "shri", "sri", "smt", "kum"}
_LEADING_VERBS = re.compile(r"^(paid to|sent to|received from|payment to|transfer to)\s+", re.IGNORECASE)


def _file() -> JsonFile:
    return userdata.json_file("payees.json", default=lambda: {"version": 1, "payees": []})


def list_payees() -> list[Payee]:
    return [Payee.model_validate(p) for p in _file().read()["payees"]]


def fingerprint() -> str:
    """Changes whenever the table does, however it was edited."""
    rows = sorted(_file().read()["payees"], key=lambda p: p["id"])
    return hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()[:16]


def upsert_payee(payee: Payee) -> Payee:
    def apply(doc: dict) -> dict:
        rows = [p for p in doc["payees"] if p["id"] != payee.id]
        doc["payees"] = [*rows, payee.model_dump(mode="json")]
        return doc

    _file().update(apply)
    return payee


def delete_payee(payee_id: str) -> bool:
    found = False

    def apply(doc: dict) -> dict:
        nonlocal found
        before = len(doc["payees"])
        doc["payees"] = [p for p in doc["payees"] if p["id"] != payee_id]
        found = len(doc["payees"]) != before
        return doc

    _file().update(apply)
    return found


def normalize_name(raw: str) -> str:
    """'Paid to Mr. Fake Payee' -> 'fake payee'; "Fakey's" -> 'fakeys'."""
    s = _LEADING_VERBS.sub("", raw.strip())
    s = re.sub(r"['’`]", "", s.lower())
    words = re.sub(r"[^a-z0-9]+", " ", s).split()
    while words and words[0] in HONORIFICS:
        words.pop(0)
    return " ".join(words)


def match_payee(raw_name: str, payees: list[Payee] | None = None) -> Payee | None:
    """Exact match ignoring case, punctuation, spacing and honorifics; or the payee name followed by
    more words ('Fakeys' matches 'FAKEYS CHICKEN CENTRE')."""
    name = normalize_name(raw_name)
    if not name:
        return None
    compact = name.replace(" ", "")
    for payee in payees if payees is not None else list_payees():
        for alias in [payee.name, *payee.aliases]:
            a = normalize_name(alias)
            if not a:
                continue
            if compact == a.replace(" ", "") or name.startswith(a + " "):
                return payee
    return None
