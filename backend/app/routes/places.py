"""Where you were: GET /api/places, POST /api/places (a stay, or one put back by Undo), PUT /api/places/{stay_id},
DELETE /api/places/{stay_id}. They read and write data/places.json only, never the ledger (app/places.py). Writes come
only from this machine's own pages, like every write (app/main.py), and wait for Start over, never cross it."""

from datetime import date, datetime

from fastapi import APIRouter, HTTPException

from app import ledger, logs, places, reset
from app.models import Model, Stay

router = APIRouter(prefix="/api")
log = logs.get("places")


class StayRequest(Model):
    place: str
    region: str | None = None  # its state: a number-plate code ("WB"), or none
    start: date
    end: date
    # Undo after removing a stay: it goes back with its own id and the time it was told (which decides shared days)
    id: str | None = None
    added_at: datetime | None = None


def _refused(exc: places.BadStay) -> HTTPException:
    return HTTPException(409 if exc.code == "exists" else 400, {"code": exc.code, "message": str(exc)})


def _not_now() -> None:
    if reset.in_progress:
        raise HTTPException(409, {"code": "in_progress", "message": "Plutus is starting over; try again in a moment"})


@router.get("/places")
def list_places() -> list[Stay]:
    return places.list_stays()


@router.post("/places")
def add_place(req: StayRequest) -> Stay:
    _not_now()
    with ledger.editing():  # the same lock as Start over: a stay is written whole before, or after, it
        try:
            stay = places.add(req.place, req.start, req.end, req.region, stay_id=req.id, added_at=req.added_at)
        except places.BadStay as exc:
            raise _refused(exc) from None
    log.info("a place %s: %d day(s)", "put back" if req.id else "added", (stay.end - stay.start).days + 1)
    return stay


@router.put("/places/{stay_id}")
def change_place(stay_id: str, req: StayRequest) -> Stay:
    _not_now()
    with ledger.editing():
        try:
            stay = places.change(stay_id, req.place, req.start, req.end, req.region)
        except places.BadStay as exc:
            raise _refused(exc) from None
    if stay is None:
        raise HTTPException(404, {"code": "not_found", "message": "No such place"})
    log.info("a place changed: %d day(s)", (stay.end - stay.start).days + 1)
    return stay


@router.delete("/places/{stay_id}")
def remove_place(stay_id: str) -> Stay:
    _not_now()
    with ledger.editing():
        stay = places.remove(stay_id)
    if stay is None:
        raise HTTPException(404, {"code": "not_found", "message": "No such place"})
    log.info("a place removed")
    return stay
