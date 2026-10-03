"""Where uploaded originals are kept (always data/uploads): see app/storage.py."""

from fastapi import APIRouter

from app import storage

router = APIRouter(prefix="/api/storage")


@router.get("")
def get_storage() -> dict:
    return storage.summary()


@router.post("/reveal", status_code=204)
def reveal() -> None:
    storage.reveal()
