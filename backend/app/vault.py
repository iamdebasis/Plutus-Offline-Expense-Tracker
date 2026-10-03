"""Uploaded files and the cards discovered in them (data/uploads.json, data/instruments.json).

Card networks you set are also kept in data/card_networks.json, which outlives the cards: a card rediscovered
after a fresh start gets its network back."""

import re
from datetime import datetime, timezone

from app import storage, userdata
from app.jsonstore import JsonFile
from app.models import CardRef, Instrument, UploadRecord


def _uploads() -> JsonFile:
    return userdata.json_file("uploads.json", default=list)


def _instruments() -> JsonFile:
    return userdata.json_file("instruments.json", default=list)


def _networks() -> JsonFile:
    return userdata.json_file("card_networks.json", default=dict)


def list_uploads() -> list[UploadRecord]:
    return [UploadRecord.model_validate(r) for r in _uploads().read()]


def find_upload(upload_id: str) -> UploadRecord | None:
    return next((u for u in list_uploads() if u.id == upload_id), None)


def add_upload(record: UploadRecord) -> tuple[UploadRecord, bool]:
    """Returns (record, created). If the same file (by sha256) is already stored, returns the existing one."""
    existing: UploadRecord | None = None

    def apply(rows: list[dict]) -> list[dict]:
        nonlocal existing
        for row in rows:
            if row["sha256"] == record.sha256:
                existing = UploadRecord.model_validate(row)
                return rows
        return [*rows, record.model_dump(mode="json")]

    _uploads().update(apply)
    return (existing, False) if existing else (record, True)


def update_upload(upload_id: str, **changes) -> None:
    def apply(rows: list[dict]) -> list[dict]:
        for i, row in enumerate(rows):
            if row["id"] == upload_id:
                rec = UploadRecord.model_validate(row).model_copy(update=changes)
                rows[i] = rec.model_dump(mode="json")
        return rows

    _uploads().update(apply)


def remove_upload(upload_id: str) -> UploadRecord | None:
    removed: UploadRecord | None = None

    def apply(rows: list[dict]) -> list[dict]:
        nonlocal removed
        keep = []
        for row in rows:
            if row["id"] == upload_id:
                removed = UploadRecord.model_validate(row)
            else:
                keep.append(row)
        return keep

    _uploads().update(apply)
    if removed:
        storage.file_path(removed).unlink(missing_ok=True)
        _forget_source(upload_id)
    return removed


def list_instruments() -> list[Instrument]:
    return [Instrument.model_validate(r) for r in _instruments().read()]


def update_instrument(instrument_id_: str, **changes) -> Instrument | None:
    updated: Instrument | None = None

    def apply(rows: list[dict]) -> list[dict]:
        nonlocal updated
        for i, row in enumerate(rows):
            if row["id"] == instrument_id_:
                updated = Instrument.model_validate(row).model_copy(update=changes)
                rows[i] = updated.model_dump(mode="json")
        return rows

    _instruments().update(apply)
    if updated is not None and "network" in changes:
        network = changes["network"]
        _networks().update(lambda m: {**{k: v for k, v in m.items() if k != instrument_id_}, **({instrument_id_: network} if network else {})})
    return updated


def instrument_id(card: CardRef) -> str:
    issuer = re.sub(r"[^a-z0-9]+", "-", (card.issuer or "card").lower()).strip("-")
    return f"card-{issuer}-{card.last4}"


def register_cards(cards: list[CardRef], upload_id: str) -> None:
    """Every card we see in a statement is a card the user owns. Upsert by issuer + last 4 digits."""
    if not cards:
        return
    now = datetime.now(timezone.utc)
    chosen = _networks().read()

    def apply(rows: list[dict]) -> list[dict]:
        by_id = {row["id"]: Instrument.model_validate(row) for row in rows}
        for card in cards:
            iid = instrument_id(card)
            inst = by_id.get(iid)
            if inst is None:
                inst = Instrument(id=iid, issuer=card.issuer, last4=card.last4, name="", first_seen=now, network=chosen.get(iid))
            inst.product = inst.product or card.product
            inst.network = inst.network or card.network
            inst.name = " ".join(p for p in [inst.issuer, inst.product] if p) or "Credit card"
            if upload_id not in inst.sources:
                inst.sources.append(upload_id)
            by_id[iid] = inst
        return [inst.model_dump(mode="json") for inst in by_id.values()]

    _instruments().update(apply)


def _forget_source(upload_id: str) -> None:
    def apply(rows: list[dict]) -> list[dict]:
        keep = []
        for row in rows:
            row["sources"] = [s for s in row.get("sources", []) if s != upload_id]
            if row["sources"]:
                keep.append(row)
        return keep

    _instruments().update(apply)
