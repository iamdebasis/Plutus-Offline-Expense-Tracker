"""Background import of uploaded files, one at a time: read → ledger → categorize → local AI.

Uploading returns as soon as the file is stored and identified; this worker does the slow part and
records progress on the upload (import_status), which the UI polls.
"""

import asyncio
import shutil
from collections import Counter
from datetime import datetime, timezone

import pymupdf

from app import categorize, ledger, logs, statements, storage, vault
from app.ingest.detect import detect, folder_for
from app.ingest.textlines import page_lines
from app.llm import LLMUnavailable
from app.models import CardStatement, ImportStatus, UploadRecord
from app.parsers import ParseError, ParseResult, card_export, card_statement, cred, gpay_takeout, phonepe, screenshot, statement_ai

log = logs.get("import")
log_parse = logs.get("parse")
log_ledger = logs.get("ledger")
log_cat = logs.get("category")

# Bump when detection gets smarter; older uploads are re-identified at startup (and read again if that changed
# what they are). 3: a card's transactions exported as CSV or Excel.
DETECTOR_VERSION = 4  # 4: a card's transactions exported as a PDF, with no statement's words, are a card's
# Bump when a parser reads more accurately; files read by an older one are read again at startup. Per kind of
# file, so improving one reader doesn't re-read every other file.
# 2: letter case in CRED reference numbers (w/W) repaired.
PARSER_VERSION = 2
# 3: Google Pay Takeout exports are read (ones skipped before a reader existed are read now).
# 4: Takeout JSON in any shape Google writes (empty, guarded, line-per-object, nested); an unreadable file is
#    reported and skipped instead of failing the whole export.
# cc_statement 3: credit card statements are read (any bank), and checked against the bank's own totals.
# cc_statement 4: the lines a statement's table holds that weren't read as rows are kept, to find a missing row.
# cc_statement 5: a purchase paid over UPI with the card is a UPI payment; two rows alike but for their words (same
#                 day and amount, different shops) are two rows; the bank's exports of a span are read (PDF, CSV, Excel).
# cc_statement 6: tables with a column after the amount (cash or reward points) and an ID before the description;
#                 the summary's labels ("Statement Date | … | Total Amount Due") are never taken for the table's header.
# cc_statement 7: columns a few points apart are two; a figure of ₹0.00 is read (not the next label alike); a
#                 "Statement Cycle" dates the statement; the terms' worked examples are never rows or figures.
# cc_statement 8: any layout, read by its shape (where dates and amounts line up) as well as its header, and proven by
#                 the statement's own arithmetic; one that can't be proven is held, uncounted (statement_reader.py).
# cc_statement 9: a note that names the terms in passing hides no rows (only a heading starts them, and a table after
#                 them is read); a table printed a few points to one side on its first page is one column; a summary
#                 with only a due date (no statement date) dates the rows and splits a year's file.
# cc_statement 10: a year's summary with no balances is proven by its printed totals of debits and credits; labels
#                 wrapped over lines are read; a Cr/Dr column with another column after it is read; periods in months.
# cc_statement 11: paying the card is a bill payment however the bank words it (or when it pays the previous balance);
#                 EMI instalments are spending in the bill that charges them; a loan's are not.
# cc_statement 12: a word in a small box beside a row (HDFC's "EMI": eligible to convert) is a tag, not the shop's name;
#                 SmartEMI is a purchase's EMIs, not a cash loan; a card's refund under another name finds its purchase.
# cc_statement 13: a summary of several statements (a year's) is proven over their cycles, its rows past them held; an
#                 undated row under a fee (its GST) is a row; a description wrapped above its row; bold read once;
#                 "May 2025" isn't a date; AmEx's New Credits/Debits; the local AI never takes a summary figure for a row.
PARSER_VERSIONS = {"gpay_takeout": 4, "cc_statement": 13}


def parser_version(kind: str) -> int:
    return PARSER_VERSIONS.get(kind, PARSER_VERSION)

_BY_LABEL = {
    "payee": "your payee table",
    "user": "your corrections",
    "self": "own-account transfers (ignored)",
    "dictionary": "known merchants",
    "learned": "earlier AI answers",
    "heuristic": "keyword rules",
    "llm": "local AI",
    "default": "uncategorized",
}


class NotSupportedYet(Exception):
    pass


def parse_upload(rec: UploadRecord) -> ParseResult:
    """The synchronous part: turn a stored file into records. Raises NeedsVisionModel for unfamiliar
    screenshots, NotSupportedYet for kinds without a parser."""
    path = storage.file_path(rec)
    if not path.exists():
        raise ParseError(f"The original file is missing from {storage.uploads_dir()}. Was it moved or deleted?")
    det = rec.detection
    if det.kind == "screenshot":
        return screenshot.parse(path, rec.id)
    if det.kind == "cred_history":
        with pymupdf.open(path) as doc:
            pages, method = page_lines(doc)
        result, cards = cred.parse(pages, method, rec.id)
        vault.register_cards(cards, rec.id)
        return result
    if det.kind == "upi_statement" and det.source == "phonepe":
        with pymupdf.open(path) as doc:
            pages, method = page_lines(doc)
        return phonepe.parse(pages, method, rec.id)
    if det.kind == "gpay_takeout":
        return gpay_takeout.parse(path, rec.id)
    if det.kind == "cc_statement":
        if path.suffix.lower() in card_export.TABLE_EXTS:
            return card_export.parse(path, rec.id, det)
        return card_statement.parse(path, rec.id, det)
    raise NotSupportedYet({
        "upi_statement": f"{det.label}: only PhonePe statements can be read so far. The file is stored.",
        "bank_statement": "Bank account statements aren't read yet. The file is stored.",
    }.get(det.kind, "This file type isn't recognised, so there's nothing to import from it."))


def needs_reading_again(rec: UploadRecord) -> bool:
    """Read with a better reader than last time: files read before, files skipped before a reader for them existed,
    and files a reader couldn't read (each improvement tries them once more)."""
    tried = rec.import_status is not None and rec.import_status.state in ("done", "skipped", "failed")
    return tried and rec.import_version < parser_version(rec.detection.kind)


class Importer:
    def __init__(self) -> None:
        self.queue: asyncio.Queue[str] | None = None  # created in start(), on the server's event loop
        self.task: asyncio.Task | None = None

    def start(self) -> None:
        self.queue = asyncio.Queue()
        redetect_old_uploads()
        if changed := categorize.apply_new_rules():
            log_cat.info("categorization rules or your payee table changed: re-applied to the ledger, %d transactions changed", changed)
        ledger.place_cards()  # what each card bill paid for, with the rules this version has
        fresh = outdated = 0
        for rec in vault.list_uploads():
            unfinished = rec.import_status is None or rec.import_status.state in ("queued", "running")
            stale = needs_reading_again(rec)
            if unfinished or stale:
                fresh += unfinished
                outdated += stale
                self.enqueue(rec.id)
        if fresh:
            log.info("%d file(s) waiting to be read", fresh)
        if outdated:
            log.info("re-reading %d file(s) with an improved reader", outdated)
        self.task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self.task:
            self.task.cancel()
        self.queue, self.task = None, None

    def enqueue(self, upload_id: str) -> None:
        _set_status(upload_id, ImportStatus(state="queued", step="Waiting its turn"))
        if self.queue is not None:
            self.queue.put_nowait(upload_id)

    async def _run(self) -> None:
        assert self.queue is not None
        while True:
            upload_id = await self.queue.get()
            try:
                await self._import(upload_id)
            except Exception as exc:  # never let one bad file stop the worker
                log.exception("reading %s failed unexpectedly", upload_id)
                error = f"Something unexpected stopped this file being read ({type(exc).__name__}). The terminal has the details."
                _set_status(upload_id, ImportStatus(state="failed", error=error, finished_at=_now()))

    async def _ask_ai(self, rec: UploadRecord, held: CardStatement | None, status: ImportStatus) -> ParseResult | None:
        """The local AI reads a statement the rules couldn't prove (or read): its reading counts only if the statement's
        arithmetic proves it, or it matches the rules' reading row for row. Without a local AI, nothing changes."""
        name = rec.original_name
        status.step = "Asking the local AI to read it"
        _set_status(rec.id, status)

        def progress(n: int, total: int) -> None:
            status.step = f"Asking the local AI to read it (page {n} of {total})"
            _set_status(rec.id, status)

        try:
            return await statement_ai.resolve(storage.file_path(rec), rec, held, progress)
        except LLMUnavailable as exc:
            log_parse.info("%s: the local AI isn't available (%s)%s", name, exc, "; it stays on hold" if held else "")
        except Exception:  # never let the AI's trouble lose what the rules read
            log.exception("%s: the local AI's reading failed", name)
        return None

    async def _import(self, upload_id: str) -> None:
        rec = vault.find_upload(upload_id)
        if rec is None:
            return
        name = rec.original_name
        det = rec.detection
        log.info("▸ %s · %s%s", name, det.label, f" · {det.pages} pages" if det.pages else "")
        status = ImportStatus(state="running", step="Reading the file")
        _set_status(upload_id, status)

        with logs.timed() as elapsed:
            try:
                result = await asyncio.to_thread(parse_upload, rec)
            except screenshot.NeedsVisionModel as need:
                log_parse.info("%s: layout not recognised from OCR, asking the local vision model", name)
                status.step = "Reading the screenshot with the local AI"
                _set_status(upload_id, status)
                try:
                    result = await screenshot.parse_with_vision_model(storage.file_path(rec), upload_id, need.ocr_lines)
                except LLMUnavailable as exc:
                    log.error("%s: couldn't read it: %s", name, exc)
                    return _set_status(upload_id, ImportStatus(state="failed", error=str(exc), finished_at=_now()))
            except NotSupportedYet as exc:
                log.warning("%s: skipped. %s", name, exc)
                vault.update_upload(upload_id, import_version=parser_version(det.kind))  # tried with this version; a newer one tries again
                return _set_status(upload_id, ImportStatus(state="skipped", error=str(exc), finished_at=_now()))
            except ParseError as exc:
                read_by_ai = await self._ask_ai(rec, None, status) if _is_pdf_statement(rec) else None
                if read_by_ai is None:
                    log.error("%s: couldn't read it: %s", name, exc)
                    vault.update_upload(upload_id, import_version=parser_version(det.kind))  # a better reader tries it again
                    return _set_status(upload_id, ImportStatus(state="failed", error=str(exc), finished_at=_now()))
                result = read_by_ai
            if _is_pdf_statement(rec):  # a statement the rules couldn't prove: the local AI tries
                for s in [s for s in result.statements if s.status == "on_hold" and not s.outside_cycles]:  # (nothing could prove those)
                    if better := await self._ask_ai(rec, s, status):
                        _replace(result, s, better)
            read_s = elapsed()

        found = len(result.transactions) + len(result.card_payments)
        what = _count(len(result.card_payments), "card bill payment") if result.card_payments else _count(len(result.transactions), "transaction")
        if on_hold := sum(len(s.held) for s in result.statements if s.status == "on_hold"):
            what += f" counted, {on_hold} on hold"
        log_parse.info("%s: %s via %s in %.1fs", name, what, _METHOD.get(result.method, result.method), read_s)
        for note in result.notes:
            log_parse.info("%s: %s", name, note)
        for w in result.warnings:
            log_parse.warning("%s: %s", name, w)
        if result.card_payments:
            unverified = sum(not p.verified for p in result.card_payments)
            if result.method == "decoded":
                log_parse.info("%s: amounts confirmed by two independent readings: %d/%d", name, found - unverified, found)
            if unverified:
                log_parse.warning("%s: %d amount(s) didn't match between readings. Check them in the dashboard", name, unverified)

        yours = 0  # statements you confirmed or corrected, read again by a reader that can't prove its reading: kept as you left them
        for s in result.statements:
            before = statements.get(s.id)
            if s.status == "on_hold" and before and (before.status == "confirmed" or (before.status == "on_hold" and before.edited)):
                log_parse.info("%s: read again without proof; keeping the rows you %s", name,
                               "confirmed" if before.status == "confirmed" else "corrected")
                yours += 1
                continue
            if s.status == "on_hold":
                log_parse.warning("%s: on hold, %d row(s) not counted until you confirm them in Your vault", name, len(s.held))
            statements.save(s)
        status.method = result.method
        status.found = found
        status.details = result.notes + result.warnings
        status.step = "Sorting into categories"
        _set_status(upload_id, status)

        ctx = categorize.build_context(ledger.load_transactions() + result.transactions)
        unknown_ids = {t.id for t in categorize.categorize_offline(result.transactions, ctx)}
        stats, added = ledger.upsert_transactions(result.transactions)
        if det.kind == "cc_statement" and not yours:  # a statement's rows are what its latest reading says, nothing the old reader made up
            if gone := ledger.retract(upload_id, keep={t.id for t in stats.matched} | {t.id for t in added}):
                log_ledger.info("%s: %d row(s) an earlier reading had and this one doesn't: no longer counted", name, gone)
        if stats.refreshed:  # rows read again by a better reader: the rules place them afresh (your answers stay)
            with ledger.editing():
                categorize.recategorize(ledger.load_transactions(), only={t.id for t in stats.refreshed})
        pay_stats = ledger.upsert_card_payments(result.card_payments)
        status.added = stats.added + pay_stats.added
        status.duplicates = stats.duplicates + pay_stats.duplicates
        status.held = sum(len(s.held) for s in result.statements if s.status == "on_hold")
        log_ledger.info("%s: %d new · %d already known%s", name, status.added, status.duplicates,
                        " (updated with the new reading)" if pay_stats.duplicates else "")

        if added:
            stages = Counter(t.categorized_by for t in added if t.id not in unknown_ids)
            placed = " · ".join(f"{n} by {_BY_LABEL.get(k, k)}" for k, n in stages.most_common())
            log_cat.info("%s: %s", name, placed or "nothing new to place")

        ask_ai = [t for t in added if t.id in unknown_ids]
        if ask_ai:
            names = len({categorize.normalize(t.payee) for t in ask_ai})
            log_cat.info("%s: %d payee name(s) not recognised → asking the local AI", name, names)
            status.step = f"Asking the local AI about {names} new payee{'s' if names != 1 else ''}"
            _set_status(upload_id, status)

            def progress(done: int, total: int) -> None:
                status.step = f"Asking the local AI about new payees ({done} of {total})"
                _set_status(upload_id, status)

            try:
                await categorize.categorize_with_llm(ask_ai, on_progress=progress)
            except LLMUnavailable as exc:
                log_cat.warning("%s: local AI unavailable (%s). Using the offline rules; these go to review", name, exc)
                for t in ask_ai:
                    categorize.fallback(t)
            ledger.update_transactions(ask_ai)

        # payees, not payments: the review list asks once per payee
        ledger.relink()
        status.needs_review = len({t.payee for t in added if t.needs_review})
        status.state, status.step, status.finished_at = "done", None, _now()
        _set_status(upload_id, status)
        vault.update_upload(upload_id, import_version=parser_version(det.kind))
        log.info("✓ %s done in %.1fs%s", name, elapsed(),
                 f" · {_count(status.needs_review, 'payee')} to review in the dashboard" if status.needs_review else "")


_METHOD = {
    "text": "the PDF's own text (no OCR)",
    "decoded": "decoded text, checked against on-device OCR",
    "ocr": "on-device OCR",
    "vision-model": "the local vision model",
    "export": "the export's own data (no OCR)",
}


def redetect_old_uploads() -> None:
    """Files added before detection improved get identified again, moved to the right folder, and
    their cards registered."""
    for rec in vault.list_uploads():
        if rec.detector_version >= DETECTOR_VERSION:
            continue
        path = storage.file_path(rec)
        if not path.exists():
            continue
        det = detect(path, rec.original_name, rec.declared_kind)
        root = storage.uploads_dir()
        dest = root / folder_for(det.kind) / path.name
        if dest != path:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(path, dest)
        changed = (det.kind, det.source) != (rec.detection.kind, rec.detection.source)
        vault.update_upload(rec.id, detection=det, stored_path=str(dest.relative_to(root)), detector_version=DETECTOR_VERSION,
                            **({"import_status": None} if changed else {}))  # read again only when it's something else now
        vault.register_cards(det.cards, rec.id)
        if changed:
            log.info("re-identified %s → %s", rec.original_name, det.label)


def _count(n: int, noun: str) -> str:
    return f"{n} {noun}{'' if n == 1 else 's'}"


def _set_status(upload_id: str, status: ImportStatus) -> None:
    vault.update_upload(upload_id, import_status=status)


def _now() -> datetime:
    return datetime.now(timezone.utc)


importer = Importer()


def confirm_statement(statement_id: str) -> CardStatement | None:
    """You looked at a statement on hold and said its rows are right: they're counted from now on, placed in
    categories like any file's (names no rule knows wait in Needs your eyes)."""
    s = statements.get(statement_id)
    if s is None or s.status != "on_hold":
        return s
    txns = s.held
    ctx = categorize.build_context(ledger.load_transactions() + txns)
    for t in categorize.categorize_offline(txns, ctx):
        categorize.fallback(t)
    stats, _ = ledger.upsert_transactions(txns)
    s.status, s.proof, s.held, s.edited = "confirmed", "you checked its rows and confirmed them", [], False
    statements.save(s)
    ledger.relink()  # its rows are counted now, and it covers the bill that paid it
    log_ledger.info("statement %s confirmed by you: %d row(s) counted (%d new)", statement_id, len(txns), stats.added)
    return s


def _is_pdf_statement(rec: UploadRecord) -> bool:
    return rec.detection.kind == "cc_statement" and rec.stored_path.lower().endswith(".pdf")


def _replace(result: ParseResult, old: CardStatement, better: ParseResult) -> None:
    """A statement of the file read better (by the local AI): its new record in place of the old, its rows counted."""
    assert better.statement is not None
    if result.statement is old:
        result.statement = better.statement
    else:
        result.more_statements = [better.statement if s is old else s for s in result.more_statements]
    result.transactions += better.transactions
    result.notes += better.notes
    result.warnings = [w for w in result.warnings if not (better.statement.status != "on_hold" and w.startswith("On hold"))] + better.warnings

