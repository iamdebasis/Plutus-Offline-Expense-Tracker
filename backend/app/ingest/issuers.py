"""Indian card issuers and how they show up in statement text."""

import re
from collections import Counter

ISSUERS: list[tuple[str, re.Pattern[str]]] = [
    (name, re.compile(pattern, re.IGNORECASE))
    for name, pattern in [
        ("HDFC Bank", r"\bhdfc\b"),
        ("ICICI Bank", r"\bicici\b"),
        ("Axis Bank", r"\baxis\b"),
        ("SBI Card", r"\bsbi\b|\bstate bank of india\b"),
        ("Kotak", r"\bkotak\b"),
        ("IDFC FIRST Bank", r"\bidfc\b"),
        ("IndusInd Bank", r"\bindusind\b"),
        ("Yes Bank", r"\byes bank\b"),
        ("RBL Bank", r"\brbl\b"),
        ("AU Bank", r"\bau small finance\b|\bau bank\b"),
        ("HSBC", r"\bhsbc\b"),
        ("Standard Chartered", r"\bstandard chartered\b"),
        ("American Express", r"\bamerican express\b|\bamex\b"),
        ("Federal Bank", r"\bfederal bank\b"),
        ("Bank of Baroda", r"\bbank of baroda\b|\bbobcard\b"),
        ("OneCard", r"\bonecard\b"),
        ("DBS Bank", r"\bdbs\b"),
        ("Union Bank", r"\bunion bank\b"),
        ("Canara Bank", r"\bcanara\b"),
        ("Punjab National Bank", r"\bpunjab national\b|\bpnb\b"),
        ("Bank of India", r"(?<!state )\bbank of india\b"),
        ("Citi", r"\bciti ?bank\b"),
    ]
]

# Words that belong to the issuer rather than the card product ("HSBC FAKE PLUS" -> "Fake Plus").
_ISSUER_WORDS = {
    "hdfc", "icici", "axis", "sbi", "kotak", "idfc", "first", "indusind", "yes", "rbl", "au", "hsbc",
    "standard", "chartered", "american", "express", "amex", "federal", "baroda", "bob", "bobcard",
    "onecard", "dbs", "union", "canara", "pnb", "punjab", "national", "citi", "citibank", "bank", "of",
    "india", "card", "credit", "mahindra",
}

NETWORKS: list[tuple[str, re.Pattern[str]]] = [
    ("RuPay", re.compile(r"\brupay\b", re.IGNORECASE)),
    ("Visa", re.compile(r"\bvisa\b", re.IGNORECASE)),
    ("Mastercard", re.compile(r"\bmaster ?card\b", re.IGNORECASE)),
    ("Diners Club", re.compile(r"\bdiners\b", re.IGNORECASE)),
    ("American Express", re.compile(r"\bamerican express\b|\bamex\b", re.IGNORECASE)),
]


def _most_mentioned(text: str, table: list[tuple[str, re.Pattern[str]]]) -> str | None:
    counts = Counter({name: len(pattern.findall(text)) for name, pattern in table})
    name, hits = counts.most_common(1)[0]
    return name if hits else None


def detect_issuer(text: str) -> str | None:
    return _most_mentioned(text, ISSUERS)


def detect_network(text: str) -> str | None:
    return _most_mentioned(text, NETWORKS)


def product_name(card_title: str) -> str | None:
    """'IDFC FIRST FAKEGOLD' -> 'Fakegold'; 'YES BANK' -> None."""
    words = [w for w in re.split(r"\s+", card_title.strip()) if w and w.lower() not in _ISSUER_WORDS]
    return " ".join(w.capitalize() for w in words) or None
