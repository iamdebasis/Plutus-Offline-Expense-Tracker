import logging
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import ledger, logs, storage, userdata, vault
from app.config import settings
from app.imports import importer
from app.llm import llm
from app.routes import ledger as ledger_routes
from app.routes import storage as storage_routes
from app.routes import system, uploads

logs.setup()
log = logs.get("startup")

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
CSP = (
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
    "worker-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; "
    "frame-ancestors 'none'"
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    for sub in ("uploads", "run"):
        userdata.path(sub).mkdir(parents=True, exist_ok=True)
    # Our own log lines say what's happening; keep uvicorn's request lines for changes and errors only.
    logging.getLogger("uvicorn.access").addFilter(logs.quiet_access_log)

    log.info("Plutus · data in %s", userdata.root())
    storage.bring_files_home()
    storage.migrate_legacy_paths()
    if folded := ledger.merge_same_utr():
        log.info("ledger: %d payment(s) listed twice under one UTR folded into one", folded)
    if repaired := ledger.repair_duplicate_ids():
        log.info("ledger: %d transaction(s) shared an id with another; each has its own now", repaired)
    folder = storage.summary()
    log.info("your files: %s", folder["folder"])
    if folder["cloudWarning"]:
        log.warning("%s", folder["cloudWarning"])
    if folder["missing"]:
        log.warning("%d stored file(s) are missing from that folder", folder["missing"])
    log.info(
        "ledger: %d transactions · %d card bill payments · %d cards · %d files",
        len(ledger.load_transactions()), len(ledger.load_card_payments()), len(vault.list_instruments()), len(vault.list_uploads()),
    )
    await llm.reclaim()
    status = await llm.status()
    if not status["installed"]:
        log.info("local AI: not set up (optional). Payees no rule knows wait for you in \"Needs your eyes\"; see Local AI in the README")
    elif status["modelInstalled"] is False:
        log.info("local AI: Ollama found, model %s not downloaded (optional). To use it: ollama pull %s", llm.model, llm.model)
    else:
        log.info("local AI: %s via Ollama, %s%s; wakes for a job, sleeps after %ds idle", llm.model,
                 "in memory" if status["loaded"] else "asleep",
                 " (the Ollama app's own server is running; it stays up, the model doesn't)" if status["server"] == "ollama" else "",
                 int(llm.idle_seconds))

    importer.start()
    log.info("ready on http://127.0.0.1:%d", settings.port)
    yield
    await importer.stop()
    await llm.shutdown()
    log.info("stopped")


# No /docs: Swagger UI loads from a CDN, and this app makes no external requests.
app = FastAPI(title="Expense Tracker", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url="/api/openapi.json")
# Blocks DNS-rebinding: a web page can't reach this server through another hostname.
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])


@app.middleware("http")
async def security_headers(request: Request, call_next):
    # Any web page can send a simple POST to 127.0.0.1 (a form, a fetch without a preflight), or load an image from
    # it to learn whether something exists (a picture of a card). Only pages served from this machine may change
    # anything, and other sites may not ask for anything at all.
    cross_site = request.headers.get("sec-fetch-site") == "cross-site"
    if request.url.path.startswith("/api/") and (cross_site or (request.method not in SAFE_METHODS and not _same_machine(request))):
        log.warning("blocked a %s %s from %s", request.method, request.url.path, request.headers.get("origin") or "another site")
        return JSONResponse({"detail": {"code": "forbidden", "message": "Requests must come from this app"}}, status_code=403)
    response = await call_next(request)
    response.headers.setdefault("Content-Security-Policy", CSP)
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    return response


def _same_machine(request: Request) -> bool:
    if request.headers.get("sec-fetch-site") == "cross-site":
        return False
    origin = request.headers.get("origin")
    if origin is None:  # not a browser page (curl, the tests)
        return True
    return urlsplit(origin).hostname in ("127.0.0.1", "localhost")


app.include_router(uploads.router)
app.include_router(storage_routes.router)
app.include_router(ledger_routes.router)
app.include_router(system.router)

dist = settings.web_dist
if (dist / "index.html").exists():
    app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> FileResponse:
        if path.startswith("api/"):
            raise HTTPException(404)
        candidate = (dist / path).resolve()
        if path and candidate.is_file() and dist.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(dist / "index.html")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=settings.port)
