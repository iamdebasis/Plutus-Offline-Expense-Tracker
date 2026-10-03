"""Turn a stored upload into transactions / card payments. Each parser is deterministic; the LLM is only
used for screenshots from apps we don't have a layout for."""

import hashlib
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from app.models import CardPayment, CardStatement, Transaction

IST = timezone(timedelta(hours=5, minutes=30), "IST")


class ParseError(Exception):
    pass


@dataclass
class ParseResult:
    method: str
    transactions: list[Transaction] = field(default_factory=list)
    card_payments: list[CardPayment] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    # What the file held and what became of it, line by line, for the import summary (exports with many parts)
    notes: list[str] = field(default_factory=list)
    # A credit card statement's own figures (period, totals) and whether its rows add up to them
    statement: CardStatement | None = None


def money(raw: str) -> float | None:
    m = re.search(r"(\d[\d,]*\.\d{1,2}|\d[\d,]*)\s*$", raw.strip())
    return float(m.group(1).replace(",", "")) if m else None


def stable_id(prefix: str, *parts: object) -> str:
    return f"{prefix}_{hashlib.sha1('|'.join(str(p) for p in parts).encode()).hexdigest()[:16]}"


def local_time(date: datetime, hour: int, minute: int, meridiem: str) -> datetime:
    hour = hour % 12 + (12 if meridiem.upper() == "PM" else 0)
    return date.replace(hour=hour, minute=minute, tzinfo=IST)
