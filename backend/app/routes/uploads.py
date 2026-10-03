import hashlib
import os
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

import pymupdf
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app import ledger, logs, storage, vault
from app.config import settings
from app.imports import DETECTOR_VERSION, importer
from app.ingest.detect import SUPPORTED_EXTS, detect, folder_for
from app.models import DeclaredKind, Instrument, Model, UploadRecord, UploadResult

router = APIRouter(prefix="/api")
log = logs.get("upload")


@router.get("/uploads")
def list_uploads() -> list[UploadRecord]:
    return sorted(vault.list_uploads(), key=lambda u: u.uploaded_at, reverse=True)


@router.post("/uploads/{upload_id}/reimport")
def reimport(upload_id: str) -> UploadRecord:
    if not vault.find_upload(upload_id):
        raise HTTPException(404, {"code": "not_found", "message": "No such file"})
    importer.enqueue(upload_id)
    return vault.find_upload(upload_id)


@router.post("/uploads")
def upload(
    file: UploadFile = File(...),
    kind: DeclaredKind = Form("auto"),
    password: str | None = Form(None),
) -> UploadResult:
    name = file.filename or "upload"
    ext = Path(name).suffix.lower()
    if ext not in SUPPORTED_EXTS:
        log.warning("%s: rejected, %s files aren't supported", name, ext or "extension-less")
        raise HTTPException(415, {"code": "unsupported", "message": f"{ext or 'This file type'} isn't supported"})

    tmp = storage.incoming_dir() / uuid.uuid4().hex
    try:
        sha, size = _receive(file, tmp)
        unlocked = _unlock_if_needed(tmp, ext, password)
        return _accept(tmp, name, sha, size, kind, file.content_type, unlocked)
    finally:
        tmp.unlink(missing_ok=True)


# What an export folder can hold that's worth reading.
FOLDER_EXTS = {".html", ".htm", ".json", ".csv"}


@router.post("/uploads/folder")
def upload_folder(files: list[UploadFile] = File(...), name: str = Form("Export")) -> UploadResult:
    """An export's extracted folder (Google Takeout), sent as its files, each named by its path inside the folder.
    They're packed into one zip, the same bytes every time for the same files, so from here on it's stored,
    recognised as a repeat, and read exactly like the zip Google sends."""
    kept: list[tuple[str, bytes]] = []
    total = 0
    for f in files:
        rel = _safe_rel(f.filename or "")
        if not rel or PurePosixPath(rel).suffix.lower() not in FOLDER_EXTS:
            continue
        data = f.file.read(settings.max_upload_bytes + 1)
        total += len(data)
        if total > settings.max_upload_bytes:
            raise HTTPException(413, {"code": "too_large", "message": "This folder holds more than 50 MB. Export only Google Pay from Google Takeout."})
        kept.append((rel, data))
    if not kept:
        raise HTTPException(422, {"code": "empty_folder", "message": "There are no export files in this folder (looking for .html, .json and .csv)."})

    tmp = storage.incoming_dir() / uuid.uuid4().hex
    try:
        with ZipFile(tmp, "w") as zf:
            for rel, data in sorted(kept):
                info = ZipInfo(rel, date_time=(1980, 1, 1, 0, 0, 0))  # fixed dates and order: same folder, same zip
                info.compress_type = ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                zf.writestr(info, data, compresslevel=6)
        digest = hashlib.sha256(tmp.read_bytes()).hexdigest()
        log.info("%s: folder of %d file(s) packed into one zip", name, len(kept))
        return _accept(tmp, f"{_safe_name(name).removesuffix('.zip') or 'export'}.zip", digest, tmp.stat().st_size, "auto", "application/zip")
    finally:
        tmp.unlink(missing_ok=True)


def _safe_rel(raw: str) -> str:
    """A path inside the folder, made safe: forward slashes, no leading slash, nothing climbing out of it."""
    parts = [p for p in raw.replace("\\", "/").split("/") if p not in ("", ".")]
    return "" if not parts or ".." in parts else "/".join(parts)


def _accept(tmp: Path, name: str, sha: str, size: int, kind: DeclaredKind, media_type: str | None, unlocked: bool = False) -> UploadResult:
    """Identify a received file, keep it in your files folder (unless it's a repeat) and queue it for reading."""
    detection = detect(tmp, name, declared=kind)

    root = storage.uploads_dir()
    dest = root / folder_for(detection.kind) / f"{sha[:10]}-{_safe_name(name)}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    record = UploadRecord(
        id=f"upl_{sha[:12]}",
        original_name=name,
        stored_path=str(dest.relative_to(root)),
        sha256=sha,
        size=size,
        media_type=media_type,
        declared_kind=kind,
        detection=detection,
        uploaded_at=datetime.now(timezone.utc),
        unlocked=unlocked,
        detector_version=DETECTOR_VERSION,
    )
    stored, created = vault.add_upload(record)
    if not created:
        log.info("%s (%s): same file as %s, already in the vault; nothing to do", name, logs.size(size), stored.original_name)
        return UploadResult(**stored.model_dump(), duplicate=True)
    shutil.move(tmp, dest)  # the folder you chose may be on another disk
    log.info("%s (%s) → %s%s · confidence %.0f%%%s", name, logs.size(size), detection.label,
             f" · {detection.pages} pages" if detection.pages else "", detection.confidence * 100,
             " · unlocked with your password (not stored)" if unlocked else "")
    for note in detection.notes:
        log.info("%s: %s", name, note)
    new_cards = [c for c in detection.cards if vault.instrument_id(c) not in {i.id for i in vault.list_instruments()}]
    vault.register_cards(detection.cards, record.id)
    if new_cards:
        log.info("%s: %d new card(s) found: %s", name, len(new_cards),
                 ", ".join(f"{c.issuer or 'card'} ••{c.last4}" for c in new_cards))
    importer.enqueue(record.id)
    return UploadResult(**(vault.find_upload(record.id) or record).model_dump())


@router.delete("/uploads/{upload_id}", status_code=204)
def delete_upload(upload_id: str) -> None:
    removed = vault.remove_upload(upload_id)
    if not removed:
        raise HTTPException(404, {"code": "not_found", "message": "No such file"})
    ledger.forget_upload(upload_id)
    log.info("%s deleted, with everything only it contributed", removed.original_name)


@router.get("/instruments")
def list_instruments() -> list[Instrument]:
    return vault.list_instruments()


NETWORKS = {"Visa", "Mastercard", "RuPay", "Diners Club", "American Express"}


class InstrumentChanges(Model):
    network: str | None = None


@router.put("/instruments/{instrument_id}")
def update_instrument(instrument_id: str, changes: InstrumentChanges) -> Instrument:
    """Statements rarely say which network a card is on; let the owner say so."""
    if changes.network is not None and changes.network not in NETWORKS:
        raise HTTPException(400, {"code": "bad_network", "message": f"Network must be one of {sorted(NETWORKS)}"})
    updated = vault.update_instrument(instrument_id, network=changes.network)
    if updated is None:
        raise HTTPException(404, {"code": "not_found", "message": "No such card"})
    logs.get("cards").info("%s ••%s: network set to %s", updated.name, updated.last4, changes.network or "unknown")
    ledger.place_cards()  # a RuPay card is the one a card on UPI ("XXXX99") can be
    return updated


def _receive(file: UploadFile, dest: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with dest.open("wb") as out:
        while chunk := file.file.read(1 << 20):
            size += len(chunk)
            if size > settings.max_upload_bytes:
                raise HTTPException(413, {"code": "too_large", "message": "Files must be under 50 MB"})
            digest.update(chunk)
            out.write(chunk)
    return digest.hexdigest(), size


def _unlock_if_needed(path: Path, ext: str, password: str | None) -> bool:
    """Password-protected statements are decrypted once, on arrival. The password is never stored."""
    if ext != ".pdf":
        return False
    try:
        doc = pymupdf.open(path)
    except Exception:
        raise HTTPException(422, {"code": "unreadable", "message": "This PDF looks damaged"})
    with doc:
        if not doc.needs_pass:
            return False
        if not password:
            log.info("%s: password protected; asking for the password", path.name)
            raise HTTPException(422, {"code": "password_required", "message": "This PDF is password protected"})
        if not doc.authenticate(password):
            log.warning("wrong password for a protected PDF")
            raise HTTPException(422, {"code": "wrong_password", "message": "That password didn't work"})
        decrypted = path.with_suffix(".dec")
        doc.save(decrypted, encryption=pymupdf.PDF_ENCRYPT_NONE)
    os.replace(decrypted, path)
    return True


def _safe_name(name: str) -> str:
    stem, ext = os.path.splitext(name)
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._")[:80] or "file"
    return f"{stem}{ext.lower()}"
