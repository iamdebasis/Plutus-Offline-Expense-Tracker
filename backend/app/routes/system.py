import json
import re
from importlib import resources

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app import categorize, ledger, logs, payees, preferences, userdata, vault
from app.llm import llm
from app.models import Model, Payee

router = APIRouter(prefix="/api")


@router.get("/status")
def status() -> dict:
    return {
        "transactions": len(ledger.load_transactions()),
        "cardPayments": len(ledger.load_card_payments()),
        "uploads": len(vault.list_uploads()),
        "cards": len(vault.list_instruments()),
        "dataDir": str(userdata.root()),
    }


class PreferencesChange(Model):
    count_investments: bool | None = None


@router.get("/preferences")
def get_preferences() -> preferences.Preferences:
    return preferences.get()


@router.put("/preferences")
def put_preferences(change: PreferencesChange) -> preferences.Preferences:
    saved = preferences.update(change.model_dump(by_alias=True, exclude_none=True))
    logs.get("category").info("your settings: investments %s", "count as spending" if saved.count_investments else "are left out")
    return saved


# "hdfc-bank.jpg", "hdfc-bank--fake-rewards.png": letters, digits and dashes, one picture extension; never a path
_CARD_ART = re.compile(r"^[a-z0-9][a-z0-9-]*\.(?:jpe?g|png|webp)$", re.IGNORECASE)


@router.get("/card-art")
def card_art() -> list[str]:
    """The pictures of your cards in data/card-art/, by file name (web/src/lib/cardArt.ts matches them to cards)."""
    folder = userdata.path("card-art")
    return sorted(p.name for p in folder.iterdir() if p.is_file() and _CARD_ART.match(p.name)) if folder.is_dir() else []


@router.get("/card-art/{name}")
def card_art_file(name: str) -> FileResponse:
    if not _CARD_ART.match(name) or not (path := userdata.path("card-art", name)).is_file():
        raise HTTPException(404, {"code": "not_found", "message": "No such card picture"})
    return FileResponse(path, headers={"Cache-Control": "no-cache"})


@router.get("/llm/status")
async def llm_status() -> dict:
    return await llm.status()


@router.get("/categories")
def categories() -> list[dict]:
    return json.loads(resources.files("app.seed").joinpath("categories.json").read_text(encoding="utf-8"))


@router.get("/payees")
def list_payees() -> list[Payee]:
    return payees.list_payees()


@router.put("/payees/{payee_id}")
def put_payee(payee_id: str, payee: Payee) -> Payee:
    if payee.id != payee_id:
        raise HTTPException(400, {"code": "id_mismatch", "message": "Payee id in the URL and body differ"})
    saved = payees.upsert_payee(payee)
    updated = categorize.recategorize(ledger.load_transactions())
    logs.get("category").info("payee table: %s → %s (%s); %d transaction(s) updated", payee.name, payee.label, payee.category, updated)
    return saved


@router.delete("/payees/{payee_id}", status_code=204)
def delete_payee(payee_id: str) -> None:
    if not payees.delete_payee(payee_id):
        raise HTTPException(404, {"code": "not_found", "message": "No such payee"})
    updated = categorize.recategorize(ledger.load_transactions())
    logs.get("category").info("payee table: %s removed; %d transaction(s) updated", payee_id, updated)
