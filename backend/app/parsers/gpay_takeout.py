"""Google Pay history from a Google Takeout export: the .zip as Google sends it, or the extracted folder (which
the app packs into a zip first, so both are read the same way).

A Google Pay export holds several folders. What each is, and what becomes of it:

    My Activity/My Activity.html | .json    every Google Pay action, one entry each:
                                              "Paid ₹250.00 to Swiggy using Bank Account XXXXXX1234"
                                              + its date and time, + "Details: Completed" (or Failed, …)
                                              → the main source: one transaction per completed payment
    Money sends and requests/*.csv|json     person-to-person sends and requests, with IDs and memos
                                              → merged into My Activity's entries; ones it lacks are added
    Google transactions/*.csv|json          purchases from Google (Play, YouTube, Google One)
                                              → added, unless My Activity already has the payment
    Rewards earned/*.csv|json               cashback and scratch cards
                                              → cashback (money in), merged with a matching "Received"
    Group expenses/*.json|csv               split-bill notes ("Raj owes ₹400"): not money that moved
                                              → counted in the report, never added
    anything else under Google Pay          → listed as "not read", so nothing is silently dropped

Only completed payments are added; failed, pending, cancelled, declined and refunded ones are counted and
left out. Column names in the CSVs are matched by meaning ("time"/"date", "amount", "status"…), not exactly,
because Google renames them from time to time. Dates come in whatever style the account's language uses
("Sep 4, 2025, 2:30:45 PM IST", "4 Sept 2025, 14:30:45 GMT+05:30", ISO UTC in JSON); all end up in IST.
"""

import csv
import html
import io
import json
import re
from collections import Counter
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from zipfile import BadZipFile, ZipFile

from app.models import NO_NAME, SourceRef, Transaction
from app.parsers import IST, ParseError, ParseResult, stable_id

# ---- one money movement, as one file saw it ----------------------------------------------------


@dataclass
class Entry:
    at: datetime
    amount: float
    direction: str  # debit / credit
    kind: str  # spend / income / refund / cashback / transfer
    payee: str
    paid_from: str | None = None
    refs: dict[str, str] = field(default_factory=dict)
    note: str = ""
    channel: str = "upi"
    source: str = "activity"


@dataclass
class Report:
    """What one kind of file held and what became of it, for the import summary."""

    label: str
    files: int = 0
    read: int = 0
    added: int = 0
    merged: int = 0
    skipped: Counter = field(default_factory=Counter)
    unreadable: list[str] = field(default_factory=list)  # "Rewards earned.json (empty)"

    def line(self) -> str:
        if self.label == "Group expenses":
            return f"Group expenses: {self.read} split-bill note{'' if self.read == 1 else 's'}, not payments (the money that moved is in My Activity)"
        bits = [f"{self.read} {'entry' if self.read == 1 else 'entries'}"]
        if self.added:
            bits.append(f"{self.added} {'payments' if self.label == 'My Activity' else 'added'}")
        if self.merged:
            bits.append(f"{self.merged} already in My Activity")
        bits += [f"{n} {_ONE.get(why, why) if n == 1 else why}" for why, n in self.skipped.most_common()]
        return f"{self.label}: " + " · ".join(bits)


# Reasons are written for many; these read better for one.
_ONE = {"not payments": "not a payment", "requests": "request", "unreadable rows": "unreadable row"}


# ---- reading the zip ---------------------------------------------------------------------------------


def parse(path: Path, upload_id: str) -> ParseResult:
    try:
        zf = ZipFile(path)
    except BadZipFile as exc:
        raise ParseError("This zip file is damaged. Download the Takeout export again.") from exc

    with zf:
        files = [i for i in zf.infolist() if not i.is_dir() and not _junk(i.filename)]
        mine = [i for i in files if _is_google_pay(i.filename)]
        if not mine:
            raise ParseError("There's no Google Pay data in this export. On takeout.google.com, choose Google Pay and export again.")

        reports = {k: Report(label) for k, label in _KINDS.items()}
        activity: list[Entry] = []
        others: list[Entry] = []
        not_read: list[str] = []
        for info in mine:
            kind = _route(info.filename)
            if kind is None:
                not_read.append(PurePosixPath(info.filename).name)
                continue
            reports[kind].files += 1
            before = deepcopy(reports[kind])
            try:
                entries = _READERS[kind](zf.read(info), info.filename, reports[kind])
            except Exception as exc:  # noqa: BLE001: one odd file never costs you the rest of the export
                reports[kind] = before  # forget what it counted before it gave up
                before.unreadable.append(f"{PurePosixPath(info.filename).name} ({_why(exc)})")
                continue
            (activity if kind == "activity" else others).extend(entries)
        other_products = len(files) - len(mine)

    entries = _merge(activity, others, reports)
    result = ParseResult(method="export")
    result.transactions = [_to_transaction(e, upload_id) for e in sorted(entries, key=lambda e: e.at)]

    for kind in _KINDS:
        report = reports[kind]
        if report.files > len(report.unreadable):
            result.notes.append(report.line())
        if report.unreadable:
            result.warnings.append(f"{report.label}: couldn't read {', '.join(report.unreadable)}. The rest of the export was read.")
    if not reports["activity"].files:
        result.warnings.append("No My Activity file in this export, so only the other folders were read. Include My Activity next time.")
    if not_read:
        result.notes.append(f"Not read: {', '.join(sorted(set(not_read)))}")
    if other_products:
        result.notes.append(f"{other_products} file(s) from other Google products ignored")
    return result


_KINDS = {
    "activity": "My Activity",
    "sends": "Money sends and requests",
    "google": "Google transactions",
    "rewards": "Rewards earned",
    "groups": "Group expenses",
}


def _junk(name: str) -> bool:
    base = PurePosixPath(name).name
    return name.startswith("__MACOSX/") or base.startswith(".") or base.lower() in ("thumbs.db", "desktop.ini")


def _parts(name: str) -> list[str]:
    return [p.strip().lower() for p in PurePosixPath(name).parts]


def _is_google_pay(name: str) -> bool:
    """Under a "Google Pay" folder, or Google Pay's own page in a whole-account My Activity export."""
    parts = _parts(name)
    return "google pay" in parts or "gpay" in parts or "google pay send" in parts


def _route(name: str) -> str | None:
    parts, ext = _parts(name), PurePosixPath(name).suffix.lower()
    joined = "/".join(parts)
    if ext not in (".html", ".htm", ".json", ".csv"):
        return None
    if "my activity" in parts or "myactivity" in joined:
        return "activity" if ext != ".csv" else None
    if "money sends and requests" in joined or "money sends" in joined:
        return "sends"
    if "google transactions" in joined or "/transactions_" in f"/{parts[-1]}":
        return "google"
    if "rewards" in joined:
        return "rewards"
    if "group expenses" in joined or "group_expenses" in joined:
        return "groups"
    return None


# ---- My Activity ---------------------------------------------------------------------------------------

# "Paid ₹1,250.00 to Swiggy using Bank Account XXXXXX1234", "Received ₹500.00 from Raj", "Added ₹1,000.00 to UPI Lite"
_ACTION = re.compile(
    r"^(?P<verb>paid|sent|received|refunded|recharged|bought|added|transferred|requested|withdrew)\b\s*"
    r"(?:(?:₹|rs\.?|inr)\s*(?P<amount>[\d,]+(?:\.\d{1,2})?))(?P<rest>.*)$",
    re.IGNORECASE,
)
# The same, anywhere in the line, for wording the first pattern doesn't expect ("You paid ₹250.00 to Swiggy").
_ACTION_ANYWHERE = re.compile(
    r"\b(?P<verb>paid|sent|received|refunded|recharged|bought|added|transferred|requested|withdrew)\b[^₹\d]{0,20}?"
    r"(?:₹|rs\.?|inr)\s*(?P<amount>[\d,]+(?:\.\d{1,2})?)(?P<rest>.*)$",
    re.IGNORECASE,
)
_USING = re.compile(r"\s+using\s+(?P<method>.+?)\s*$", re.IGNORECASE)
_PARTY = re.compile(r"^\s*(?P<prep>to|from|for)\s+(?P<name>.+?)\s*$", re.IGNORECASE)
_TXN_ID = re.compile(r"(?:upi\s+)?transaction\s+id\s*[:#]?\s*([A-Za-z0-9-]{6,})", re.IGNORECASE)


def _read_activity(raw: bytes, name: str, report: Report) -> list[Entry]:
    text = raw.decode("utf-8", errors="replace")
    items = _activity_json(text) if name.lower().endswith(".json") else _activity_html(text)
    out = []
    for lines, when, status, product in items:
        if product and "google pay" not in product.lower():
            continue  # another product's activity in a whole-account export
        report.read += 1
        entry = _from_action(lines, when, status, report, source="activity")
        if entry:
            out.append(entry)
    return out


def _activity_html(text: str):
    """Each entry is an `outer-cell` div: a title cell (the product), a body cell with the action and its time
    on separate lines, and a caption cell with "Products:" and "Details:" sections."""
    for chunk in re.split(r'<div class="[^"]*\bouter-cell\b', text)[1:]:
        product = _cell(chunk, "mdl-typography--title")
        body = _lines(_cell(chunk, "mdl-typography--body-1"))
        caption = _lines(_cell(chunk, "mdl-typography--caption"))
        when = next((d for d in (_when(line) for line in reversed(body)) if d), None)
        lines = [line for line in body if not _when(line)]
        yield lines, when, _caption_status(caption), (_lines(product) or [""])[0]


def _cell(chunk: str, cls: str) -> str:
    """The inside of the element with this class (a <div>, or the <p> Takeout uses for the title)."""
    m = re.search(rf'<(div|p)\s+class="[^"]*{re.escape(cls)}[^"]*"[^>]*>(.*?)</\1>', chunk, re.DOTALL)
    return m.group(2) if m else ""


def _lines(fragment: str) -> list[str]:
    fragment = re.sub(r"<br\s*/?>", "\n", fragment, flags=re.IGNORECASE)
    fragment = re.sub(r"<[^>]+>", "", fragment)
    return [ln for ln in (_clean(x) for x in html.unescape(fragment).split("\n")) if ln]


def _caption_status(lines: list[str]) -> str | None:
    """The words under "Details:" ("Completed", "Failed", …); None when there's no Details section."""
    if not any(ln.rstrip(":").lower() == "details" or ln.lower().startswith("details:") for ln in lines):
        return None
    after, out = False, []
    for ln in lines:
        low = ln.lower()
        if low.startswith("details:"):
            after = True
            rest = ln.split(":", 1)[1].strip()
            if rest:
                out.append(rest)
        elif low.endswith(":"):
            after = False
        elif after:
            out.append(ln)
    return " ".join(out) or None


def _activity_json(text: str):
    for item in _records(_json(text)):
        products = item.get("products") or [item.get("header", "")]
        lines = [item.get("title", "")] + [s.get("name", "") for s in item.get("subtitles", []) if isinstance(s, dict)]
        details = [d.get("name", "") for d in item.get("details", []) if isinstance(d, dict)]
        yield [ln for ln in map(_clean, lines) if ln], _when(item.get("time", "")), " ".join(details) or None, " ".join(products)


def _from_action(lines: list[str], when: datetime | None, status: str | None, report: Report, source: str) -> Entry | None:
    action = next(((ln, m) for ln in lines if (m := _ACTION.match(ln))), None) or next(
        ((ln, m) for ln in lines if (m := _ACTION_ANYWHERE.search(ln))), None)
    if action is None:
        report.skipped["not payments"] += 1
        return None
    line, m = action
    verb = m["verb"].lower()
    if verb == "requested":
        report.skipped["requests"] += 1
        return None
    state = _status(status)
    if state != "completed":
        report.skipped[state] += 1
        return None
    if when is None:
        report.skipped["without a date"] += 1
        return None

    amount = float(m["amount"].replace(",", ""))
    rest = m["rest"]
    method = None
    if u := _USING.search(rest):
        method, rest = u["method"], rest[: u.start()]
    party = _PARTY.match(rest)
    name = party["name"] if party else ""
    text = " ".join(lines).lower()
    paid_from = _account(method)

    if verb in ("received", "refunded"):
        direction = "credit"
        kind = "refund" if verb == "refunded" or "refund" in text else "cashback" if "cashback" in text or "reward" in text else "income"
    else:
        direction = "debit"
        kind = "spend"
    if verb in ("added", "withdrew") and "upi lite" in (name + " " + (method or "")).lower():
        kind, name = "transfer", "UPI Lite"  # moving your own money into (or out of) your UPI Lite wallet
    elif verb == "transferred":
        kind = "transfer"

    refs = {"txnId": t[1]} if (t := _TXN_ID.search(" ".join(lines))) else {}
    report.added += 1
    return Entry(at=when, amount=amount, direction=direction, kind=kind, payee=name or NO_NAME, paid_from=paid_from, refs=refs, source=source)


# ---- the CSV / JSON folders -------------------------------------------------------------------------------

# Column names by meaning: the first header containing any of these words wins.
_COLUMNS = {
    "time": ("time", "date", "created", "completed on", "rewarded on"),
    "id": ("transaction id", "transaction_id", "id"),
    "description": ("description", "details", "title", "merchant", "recipient", "name", "reward"),
    "memo": ("memo", "note", "message"),
    "type": ("type", "direction", "kind"),
    "status": ("status", "state"),
    "amount": ("amount", "value", "total"),
    "method": ("payment method", "paid with", "instrument", "source", "funding"),
    "product": ("product",),
}


class _Unreadable(Exception):
    """A file the reader can't make sense of. Its message says why, in words that hold none of its content."""


def _rows(raw: bytes, name: str) -> list[dict[str, str]]:
    text = raw.decode("utf-8-sig", errors="replace")
    if name.lower().endswith((".html", ".htm")):
        return []
    if name.lower().endswith(".json"):
        try:
            return [_flat(row) for row in _records(_json(text))]
        except _Unreadable:
            if not _csv_like(text):
                raise
    return list(csv.DictReader(io.StringIO(text.strip())))


def _json(text: str) -> object:
    """A JSON file as Takeout may write it: empty, behind Google's `)]}'` guard, or one object per line."""
    text = re.sub(r"^\s*\)\]\}'\s*,?", "", text.lstrip("﻿")).strip()
    if not text:
        return []
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    try:
        return [json.loads(line) for line in text.splitlines() if line.strip()]
    except json.JSONDecodeError:
        raise _Unreadable("an HTML page, not JSON" if text.startswith("<") else "not valid JSON") from None


def _records(data: object) -> list[dict]:
    """The rows in parsed JSON: a list of objects, or the first such list inside an object, however deep."""
    if isinstance(data, list):
        return [row for row in data if isinstance(row, dict)]
    if isinstance(data, dict):
        for value in data.values():
            if rows := _records(value):
                return rows
    return []


def _flat(row: dict, prefix: str = "") -> dict[str, str]:
    """One JSON object as CSV-like columns: nested objects become "amount units"-style columns, except money,
    which Google writes as {"currencyCode": "INR", "units": "15", "nanos": 500000000} and becomes "₹15.50"."""
    out: dict[str, str] = {}
    for k, v in row.items():
        key = f"{prefix}{k}"
        if isinstance(v, dict):
            if (money := _money(v)) is not None:
                out[key] = money
            else:
                out.update(_flat(v, f"{key} "))
        elif isinstance(v, list):
            out[key] = ", ".join(str(x) for x in v if not isinstance(x, (dict, list)))
        else:
            out[key] = "" if v is None else str(v)
    return out


def _money(value: dict) -> str | None:
    if "units" not in value and "nanos" not in value:
        return None
    try:
        amount = int(value.get("units") or 0) + int(value.get("nanos") or 0) / 1e9
    except (TypeError, ValueError):
        return None
    sign = "-" if amount < 0 else ""
    currency = str(value.get("currencyCode") or "INR").upper()
    return f"{sign}{'₹' if currency == 'INR' else currency + ' '}{abs(amount):.2f}"


def _csv_like(text: str) -> bool:
    first = text.strip().split("\n", 1)[0]
    return "," in first and not first.lstrip().startswith(("{", "[", "<"))


def _why(exc: Exception) -> str:
    """Why a file couldn't be read, without quoting any of it."""
    return str(exc) if isinstance(exc, _Unreadable) else f"unexpected layout: {type(exc).__name__}"


def _pick(row: dict[str, str], what: str) -> str:
    """The value under the first column whose name has one of `what`'s words as a whole word ("Transaction
    ID" has "id"; "Paid with" doesn't)."""
    headers = [(_words(k), k) for k in row if k]
    for word in _COLUMNS[what]:
        for low, original in headers:
            if re.search(rf"(?<![a-z]){re.escape(word)}(?![a-z])", low):
                return _clean(row[original] or "")
    return ""


def _words(header: str) -> str:
    """A column name as plain words: "rewardedOn" and "rewarded_on" read as "rewarded on"."""
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", header).replace("_", " ").strip().lower()


def _read_sends(raw: bytes, name: str, report: Report) -> list[Entry]:
    out = []
    for row in _rows(raw, name):
        report.read += 1
        kind_word = _pick(row, "type").lower()
        description = _pick(row, "description")
        if "request" in kind_word or description.lower().startswith("request"):
            report.skipped["requests"] += 1
            continue
        entry = _from_row(row, report, source="sends")
        if entry is None:
            continue
        if "receiv" in kind_word or "receiv" in description.lower():
            entry.direction, entry.kind = "credit", "income"
        entry.payee = _counterparty(description) or entry.payee
        out.append(entry)
    return out


def _read_google(raw: bytes, name: str, report: Report) -> list[Entry]:
    out = []
    for row in _rows(raw, name):
        report.read += 1
        entry = _from_row(row, report, source="google")
        if entry is None:
            continue
        entry.payee = _pick(row, "description") or _pick(row, "product") or "Google"
        method = _pick(row, "method")
        entry.paid_from = _account(method) or entry.paid_from
        if re.search(r"visa|mastercard|rupay|amex|card", method, re.IGNORECASE) and "upi" not in method.lower():
            entry.channel = "card"
        out.append(entry)
    return out


def _read_rewards(raw: bytes, name: str, report: Report) -> list[Entry]:
    out = []
    for row in _rows(raw, name):
        report.read += 1
        if _amount(_pick(row, "amount")) is None:
            report.skipped["without a cash amount (vouchers, offers)"] += 1
            continue
        entry = _from_row(row, report, source="rewards", default_status="completed")
        if entry is None:
            continue
        entry.direction, entry.kind = "credit", "cashback"
        entry.payee = "Google Pay rewards"
        entry.note = _pick(row, "description")
        out.append(entry)
    return out


def _read_groups(raw: bytes, name: str, report: Report) -> list[Entry]:
    """Split-bill notes. The money that moved because of them is in My Activity; these only get counted."""
    data = _json(raw.decode("utf-8-sig", errors="replace")) if name.lower().endswith(".json") else None
    known = data.get("Group_expenses") if isinstance(data, dict) else None
    groups = known if isinstance(known, list) else _rows(raw, name)
    report.read += len(groups)
    if groups:
        report.skipped["split-bill notes, not payments"] += len(groups)
    return []


def _from_row(row: dict[str, str], report: Report, source: str, default_status: str | None = None) -> Entry | None:
    state = _status(_pick(row, "status") or default_status)
    if state != "completed":
        report.skipped[state] += 1
        return None
    when = _when(_pick(row, "time"))
    amount_text = _pick(row, "amount")
    amount = _amount(amount_text)
    if when is None or amount is None:
        report.skipped["unreadable rows"] += 1
        return None
    report.added += 1
    refs = {"txnId": i} if (i := _pick(row, "id")) else {}
    direction = "credit" if amount_text.strip().startswith("+") else "debit"
    return Entry(at=when, amount=abs(amount), direction=direction, kind="income" if direction == "credit" else "spend",
                 payee="", refs=refs, note=_pick(row, "memo"), source=source)


def _counterparty(description: str) -> str:
    m = re.search(r"\b(?:to|from)\s+(.+)$", description, re.IGNORECASE)
    return _clean(m.group(1)) if m else _clean(description)


_READERS = {"activity": _read_activity, "sends": _read_sends, "google": _read_google, "rewards": _read_rewards, "groups": _read_groups}


# ---- one payment, many files -------------------------------------------------------------------------------


def _merge(activity: list[Entry], others: list[Entry], reports: dict[str, Report]) -> list[Entry]:
    """My Activity is the master list. A row from another folder that's the same payment (same direction and
    amount, close in time, and a compatible name or no name) adds its ID and memo to the entry; anything else
    is a payment My Activity didn't have, and is added."""
    out = list(activity)
    taken: set[int] = set()
    for e in sorted(others, key=lambda e: e.at):
        window = timedelta(days=2) if e.source == "rewards" else timedelta(minutes=5)
        candidates = [
            (abs((a.at - e.at).total_seconds()), i)
            for i, a in enumerate(out)
            if i not in taken and a.source == "activity" and a.direction == e.direction and abs(a.amount - e.amount) < 0.005
            and abs(a.at - e.at) <= window and _same_party(a, e)
        ]
        if candidates:
            _, i = min(candidates)
            a = out[i]
            a.refs = {**e.refs, **a.refs}
            a.note = a.note or e.note
            if e.source == "rewards":
                a.kind, a.payee = "cashback", a.payee if a.payee not in ("Google Pay", NO_NAME) else e.payee
            taken.add(i)
            reports[{"sends": "sends", "google": "google", "rewards": "rewards"}[e.source]].added -= 1
            reports[{"sends": "sends", "google": "google", "rewards": "rewards"}[e.source]].merged += 1
        else:
            out.append(e)
    return out


def _same_party(a: Entry, b: Entry) -> bool:
    x, y = _key(a.payee), _key(b.payee)
    return not x or not y or x in y or y in x or b.source == "rewards" or {x, y} & {"google pay", "unknown"} != set()


def _key(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()


def _to_transaction(e: Entry, upload_id: str) -> Transaction:
    refs = dict(e.refs)
    return Transaction(
        id=stable_id("txn", refs.get("utr"), refs.get("txnId"), e.direction, e.amount, "" if refs else (e.at, e.payee)),
        at=e.at, amount=e.amount, direction=e.direction, kind=e.kind, channel=e.channel, app="gpay",
        payee=e.payee, paid_from=e.paid_from, refs=refs, note=e.note, sources=[SourceRef(upload=upload_id)],
    )


# ---- small readers ------------------------------------------------------------------------------------------


def _clean(text: str) -> str:
    # Takeout uses narrow and non-breaking spaces ("2:30:45 PM"), and emsp indents in captions
    return re.sub(r"[\s     ]+", " ", text or "").strip()


def _amount(text: str) -> float | None:
    m = re.search(r"(\d[\d,]*(?:\.\d{1,2})?)", (text or "").replace(" ", " "))
    return float(m.group(1).replace(",", "")) if m else None


def _account(method: str | None) -> str | None:
    """How a payment was paid, in the masks the rest of the app uses: bank account ••1234 → "XX1234",
    a credit card on UPI → "XXXX" + its last two digits (as PhonePe writes it), UPI Lite as is."""
    if not method:
        return None
    low = method.lower()
    if "upi lite" in low:
        return "UPI Lite"
    digits = re.findall(r"\d+", method)
    last = digits[-1] if digits else ""
    if last and ("card" in low or re.search(r"visa|mastercard|rupay|amex|diners", low)):
        return f"XXXX{last[-2:]}"  # a card, written the way PhonePe writes one on UPI, so it's matched to your cards
    if ("bank" in low or "account" in low or "a/c" in low) and len(last) >= 4:
        return f"XX{last[-4:]}"
    return _clean(method)


# Checked in this order: "Unpaid" must read as not paid before "paid" can read as completed.
_STATUS = [
    ("failed", ("fail", "declin", "reject", "expired", "error")),
    ("pending", ("pending", "progress", "processing", "awaiting", "initiated", "unpaid", "not paid")),
    ("cancelled", ("cancel",)),
    ("refunded", ("refund", "revers")),
    ("completed", ("complete", "success", "paid", "credited", "debited", "done")),
]


def _status(raw: str | None) -> str:
    """Completed, or why not. No status at all counts as completed: My Activity lists money that moved."""
    low = (raw or "").lower()
    return next((state for state, words in _STATUS if any(w in low for w in words)), "completed")


_TZ = {
    "ist": timedelta(hours=5, minutes=30), "utc": timedelta(0), "gmt": timedelta(0), "z": timedelta(0),
    "bst": timedelta(hours=1), "cet": timedelta(hours=1), "cest": timedelta(hours=2), "gst": timedelta(hours=4),
    "sgt": timedelta(hours=8), "est": timedelta(hours=-5), "edt": timedelta(hours=-4), "pst": timedelta(hours=-8), "pdt": timedelta(hours=-7),
}
_FORMATS = [
    "%b %d, %Y, %I:%M:%S %p", "%b %d, %Y, %I:%M %p", "%b %d, %Y, %H:%M:%S", "%b %d, %Y, %H:%M",
    "%d %b %Y, %H:%M:%S", "%d %b %Y, %H:%M", "%d %b %Y, %I:%M:%S %p", "%d %b %Y, %I:%M %p",
    "%B %d, %Y, %I:%M:%S %p", "%d %B %Y, %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%d/%m/%Y %H:%M:%S",
    "%d/%m/%Y %H:%M", "%d-%m-%Y %H:%M:%S", "%Y-%m-%d", "%b %d, %Y", "%d %b %Y",
]


def _when(text: str) -> datetime | None:
    """A timestamp in any of the styles Takeout writes, as IST. Times without a zone are taken as IST."""
    s = _clean(text)
    if not s or not re.search(r"\d", s):
        return None
    if re.fullmatch(r"\d{10}(\d{3})?", s):  # seconds or milliseconds since 1970, as some JSON has it
        return datetime.fromtimestamp(int(s[:10]), tz=timezone.utc).astimezone(IST)
    iso = re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$", s)
    if iso:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return (dt if dt.tzinfo else dt.replace(tzinfo=IST)).astimezone(IST)
    s = re.sub(r"\bSept\b", "Sep", s)
    offset: timedelta | None = None
    if m := re.search(r"\s*(?:GMT|UTC)\s*([+-])(\d{1,2}):?(\d{2})?\s*$", s):
        sign = 1 if m[1] == "+" else -1
        offset = sign * timedelta(hours=int(m[2]), minutes=int(m[3] or 0))
        s = s[: m.start()]
    elif m := re.search(r"\s+([A-Za-z]{1,5})$", s):
        if m[1].lower() in _TZ:
            offset, s = _TZ[m[1].lower()], s[: m.start()]
        elif m[1].upper() not in ("AM", "PM"):
            s = s[: m.start()]  # some other zone name: read the clock time as written
    s = s.strip().rstrip(",")
    for fmt in _FORMATS:
        try:
            dt = datetime.strptime(s, fmt)
        except ValueError:
            continue
        tz = timezone(offset) if offset is not None else IST
        return dt.replace(tzinfo=tz).astimezone(IST)
    return None
