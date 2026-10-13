"""Where you were (data/places.json): stays you told Plutus about, a place and its days ("Goa, 1 Jan – 5 Mar 2026").

A stay never touches a payment or the ledger: the page works out each payment's place from its day, the stay you told
most recently that covers it (web/src/lib/places.ts). So a statement for those days added later gets the place too,
re-reading a file can't lose it, and removing a stay leaves everything as it was. Stays are told in Ask Plutus and
confirmed with a button, or added in Places; changed or removed there; and go with everything else on Start over.
Everything here is checked again, whoever asks: a place is a short plain name, the days real and in order.
"""

import re
import secrets
from datetime import date, datetime, timedelta, timezone

from pydantic import ValidationError

from app import userdata
from app.models import Stay

# India's 28 states and 8 union territories, by the codes people write: the number-plate codes (Telangana's TG since
# March 2024; the merged Dadra and Nagar Haveli and Daman and Diu's DD since January 2020). The same for everyone, like
# the category tree; web/src/lib/places.ts has the same table (a test holds the two the same).
STATES = {
    "AN": "Andaman and Nicobar Islands", "AP": "Andhra Pradesh", "AR": "Arunachal Pradesh", "AS": "Assam", "BR": "Bihar",
    "CH": "Chandigarh", "CG": "Chhattisgarh", "DD": "Dadra and Nagar Haveli and Daman and Diu", "DL": "Delhi", "GA": "Goa",
    "GJ": "Gujarat", "HR": "Haryana", "HP": "Himachal Pradesh", "JK": "Jammu and Kashmir", "JH": "Jharkhand", "KA": "Karnataka",
    "KL": "Kerala", "LA": "Ladakh", "LD": "Lakshadweep", "MP": "Madhya Pradesh", "MH": "Maharashtra", "MN": "Manipur",
    "ML": "Meghalaya", "MZ": "Mizoram", "NL": "Nagaland", "OD": "Odisha", "PY": "Puducherry", "PB": "Punjab", "RJ": "Rajasthan",
    "SK": "Sikkim", "TN": "Tamil Nadu", "TG": "Telangana", "TR": "Tripura", "UP": "Uttar Pradesh", "UK": "Uttarakhand",
    "WB": "West Bengal",
}
# The official (ISO 3166-2:IN) codes where they differ, and the old ones, taken as the codes above.
ALIASES = {"CT": "CG", "UT": "UK", "TS": "TG", "OR": "OD", "DN": "DD", "DH": "DD"}

MAX_STAYS = 1000
MAX_DAYS = 3660  # ten years
EARLIEST, LATEST = date(2000, 1, 1), date(2100, 12, 31)
_PLACE = re.compile(r"^\w[\w .,'&()/-]*$")
_ID = re.compile(r"^stay-[0-9a-f]{12}$")


class BadStay(ValueError):
    """Why a stay can't be kept, in words; `code` for the page."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _file():
    return userdata.json_file("places.json", default=lambda: {"version": 1, "stays": []})


def list_stays() -> list[Stay]:
    """Your stays, as told; a damaged row is skipped, not the whole list."""
    out = []
    for row in _file().read().get("stays", []):
        try:
            out.append(Stay.model_validate(row))
        except ValidationError:
            continue
    return out


def region_code(raw: str | None) -> str | None:
    """A state's code as kept ("wb" → "WB", "TS" → "TG"); None for none; refused if it isn't one of India's."""
    if raw is None:
        return None
    code = raw.strip().upper()
    code = ALIASES.get(code, code)
    if code not in STATES:
        raise BadStay("bad_region", "A state is one of India's, as its two-letter code, like “WB” or “KA”")
    return code


def place_name(raw: str | None) -> str:
    """A place's name with its spaces tidied; refused unless it's a short plain name."""
    raw = raw or ""
    name = " ".join(raw.split())  # spaces tidied; a line break or other control character is refused, not tidied
    if not name or len(name) > 40 or not _PLACE.match(name) or any(ord(c) < 32 or ord(c) == 127 for c in raw):
        raise BadStay("bad_place", "A place is a short name, up to 40 letters, like “Goa” or “North Goa”")
    return name


def checked(place: str, start: date, end: date) -> tuple[str, date, date]:
    """The place tidied (spaces), and the stay refused unless it's a short plain name and real days in order."""
    name = place_name(place)
    if not (EARLIEST <= start <= end <= LATEST):
        raise BadStay("bad_days", "The days must be real dates, the first on or before the last")
    if (end - start).days + 1 > MAX_DAYS:
        raise BadStay("bad_days", "A stay can be up to ten years long")
    return name, start, end


def add(place: str, start: date, end: date, region: str | None = None, *, stay_id: str | None = None,
        added_at: datetime | None = None) -> Stay:
    """A new stay; or, with its id and when it was told, one put back exactly as it was (Undo after removing it)."""
    name, start, end = checked(place, start, end)
    region = region_code(region)
    now = datetime.now(timezone.utc)
    if stay_id is not None or added_at is not None:
        if not (stay_id and _ID.match(stay_id) and added_at and added_at.tzinfo and added_at <= now + timedelta(minutes=1)):
            raise BadStay("bad_restore", "That isn't a stay that can be put back")
    stay = Stay(id=stay_id or f"stay-{secrets.token_hex(6)}", place=name, region=region, start=start, end=end, added_at=added_at or now)

    def apply(doc: dict) -> dict:
        rows = doc.setdefault("stays", [])
        if len(rows) >= MAX_STAYS:
            raise BadStay("too_many", f"Plutus keeps up to {MAX_STAYS} places; remove some you no longer need")
        if any(r.get("id") == stay.id for r in rows):
            raise BadStay("exists", "That stay is already there")
        rows.append(stay.model_dump(mode="json"))
        return doc

    _file().update(apply)
    return stay


def change(stay_id: str, place: str, start: date, end: date, region: str | None = None) -> Stay | None:
    """A stay's place, state or days changed: told again now, so it wins any day it shares with another."""
    name, start, end = checked(place, start, end)
    region = region_code(region)
    changed: Stay | None = None

    def apply(doc: dict) -> dict:
        nonlocal changed
        for i, row in enumerate(doc.get("stays", [])):
            if row.get("id") == stay_id:
                changed = Stay(id=stay_id, place=name, region=region, start=start, end=end, added_at=datetime.now(timezone.utc))
                doc["stays"][i] = changed.model_dump(mode="json")
        return doc

    _file().update(apply)
    return changed


def remove(stay_id: str) -> Stay | None:
    removed: Stay | None = None

    def apply(doc: dict) -> dict:
        nonlocal removed
        keep = []
        for row in doc.get("stays", []):
            if row.get("id") == stay_id and removed is None:
                removed = Stay.model_validate(row)
            else:
                keep.append(row)
        doc["stays"] = keep
        return doc

    _file().update(apply)
    return removed
