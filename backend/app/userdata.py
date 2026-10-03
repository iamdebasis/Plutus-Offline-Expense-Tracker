"""Everything Plutus keeps about you, and where: the data folder (`data/` in the project, or ET_DATA_DIR).

The code holds only what's the same for everyone: the category tree, the merchant dictionary, card designs and
the rules that read statements. Nothing in it is about a particular person (no names, no account or card digits,
no choices), and nothing about you is kept anywhere but this folder. Every module reaches it through this file,
so the list below is complete:

    settings.json          your settings: whether investments count as spending
    uploads.json           your files: one record each (fingerprint, what it was, how reading it went)
    ledger/<year>.json     your transactions, one file per calendar year
    card_payments.json     your credit card bill payments
    instruments.json       your cards as your statements name them: bank, product, last four digits, network
    card_networks.json     the network you set for a card; kept when the files that found it are deleted
    card_statements.json   your card statements: period, due date, the bank's totals, whether the rows add up
    accounts.json          your own bank accounts (last four digits): money moved between them isn't spending
    payees.json            your payee table: people you pay and what for ("Rent", "Water delivery")
    merchant_memory.json   your corrections per payee name, and the local AI's earlier answers
    state.json             housekeeping: the rules your ledger was last sorted with
    uploads/               your original files (statements, exports, screenshots), sorted by kind
    run/                   files being received, the tools' temporary copies, and the local AI's process id and log
    redacted/              anonymised copies `make redact` makes of a statement, for sharing its layout
    card-art/              pictures of your cards you add, shown on their card faces ("hdfc-bank--fake-rewards.jpg")

A fresh clone has none of it; it's created as you use the app. Deleting the folder with the app stopped is a
complete fresh start.
"""

from pathlib import Path
from typing import Any, Callable

from app.config import settings
from app.jsonstore import JsonFile

FILES = {
    "settings.json": "your settings: whether investments count as spending",
    "uploads.json": "your files: one record each",
    "card_payments.json": "your credit card bill payments",
    "instruments.json": "your cards: bank, product, last four digits, network",
    "card_networks.json": "the network you set for a card",
    "card_statements.json": "your card statements: period, due date, the bank's totals",
    "accounts.json": "your own bank accounts (last four digits)",
    "payees.json": "your payee table",
    "merchant_memory.json": "your corrections, and the local AI's earlier answers",
    "state.json": "which rules your ledger was last sorted with",
}
FOLDERS = {
    "ledger": "your transactions, one file per calendar year",
    "uploads": "your original files (statements, exports, screenshots)",
    "run": "files being received, the tools' temporary copies; the local AI's process id and log",
    "redacted": "anonymised copies of statements made by `make redact`",
    "card-art": "pictures of your cards, shown on their card faces",
}


def root() -> Path:
    return settings.data_dir


def path(name: str, *more: str) -> Path:
    """A path inside the data folder, for one of the entries above. Anything else is refused, so a new kind of
    file about you can't appear without being listed (and documented) here."""
    if name not in FILES and name not in FOLDERS:
        raise ValueError(f"data/{name} isn't a known part of the data folder; list it in app/userdata.py")
    return settings.data_dir.joinpath(name, *more)


def json_file(name: str, default: Callable[[], Any]) -> JsonFile:
    return JsonFile(path(name), default=default)
