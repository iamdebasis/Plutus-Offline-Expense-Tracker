"""Start over: everything Plutus keeps about you goes to the macOS Trash, and Plutus is as a fresh clone has it.

Nothing is erased. What Plutus keeps (the files and folders listed in app/userdata.py, and nothing else that happens to
be in the data folder) is moved into one folder, "Plutus data (removed 6 Oct 2026, 14.03)", and that folder to the
Trash. Until the Trash is emptied it can all be put back: quit Plutus, then move that folder's contents back into the
data folder.

It runs only while nothing is being read and the local AI isn't working; Ollama is stopped first if Plutus started it
(its process id and log are in data/run); and the move holds the ledger's lock, so no change of yours lands halfway.
An upload arriving meanwhile is turned away (`in_progress`). If anything fails, everything moved so far goes back.
"""

import asyncio
import re
from datetime import datetime
from pathlib import Path

from app import accounts, ledger, logs, payees, statements, userdata, vault
from app.config import ROOT
from app.jsonstore import JsonFile

log = logs.get("reset")
CONFIRM = "start over"
in_progress = False  # while the move runs: an upload arriving then is turned away


class Busy(RuntimeError):
    """Not now: something is still working on your data."""


def _entries(root: Path) -> list[Path]:
    """What Plutus keeps in the data folder, as it is now: the listed files and folders, and the half-written copies a
    crash can leave beside a listed file (".uploads.json.x1y2.tmp"). Nothing else in the folder is touched."""
    known = set(userdata.FILES) | set(userdata.FOLDERS)
    leftover = re.compile(rf"^\.({'|'.join(re.escape(n) for n in userdata.FILES)})\..+\.tmp$")
    if not root.is_dir():
        return []
    return sorted(p for p in root.iterdir() if p.name in known or leftover.match(p.name))


def _check_root(root: Path) -> None:
    """Refuse a data folder that's clearly not Plutus's own (ET_DATA_DIR set to your home folder, say): only listed
    entries ever move, but in such a folder even those names could be someone else's."""
    risky = {Path("/"), Path.home().resolve(), ROOT.resolve(), *ROOT.resolve().parents}
    if root in risky:
        raise Busy(f"The data folder is {root}, which isn't a folder of Plutus's own: nothing was moved. Remove what "
                   "you need to by hand, or point ET_DATA_DIR at Plutus's own folder.")


def busy_reason() -> str | None:
    """Why it can't happen right now, in words; None when it can."""
    from app.llm import llm

    reading = [u for u in vault.list_uploads() if u.import_status and u.import_status.state in ("queued", "running")]
    if reading:
        return f"{len(reading)} file{'s are' if len(reading) != 1 else ' is'} still being read. Try again once reading has finished."
    if llm.busy or llm.state in ("starting", "stopping"):
        return "The local AI is working. Try again once it has finished."
    return None


def what_goes() -> dict:
    """What starting over would move to the Trash, counted, for the page to show before you confirm."""
    root = userdata.root()
    memory = JsonFile(userdata.path("merchant_memory.json"), default=dict).read()
    rows = JsonFile(userdata.path("row_answers.json"), default=dict).read()
    art = userdata.path("card-art")
    return {
        "anything": bool(_entries(root)),
        "transactions": len(ledger.load_transactions()),
        "files": len(vault.list_uploads()),
        "cards": len(vault.list_instruments()),
        "statements": len(statements.list_statements()),
        "answers": len(rows) + sum(1 for m in memory.values() if isinstance(m, dict) and m.get("by") == "user"),
        "payees": len(payees.list_payees()),
        "accounts": len(accounts.list_accounts()),
        "cardPictures": sum(1 for p in art.iterdir() if p.is_file()) if art.is_dir() else 0,
        "folder": str(root),
        "busy": busy_reason(),
    }


def to_trash(folder: Path) -> Path:
    """Moves a folder to the macOS Trash (Finder can put it back) and says where it went."""
    from Foundation import NSURL, NSFileManager

    ok, where, error = NSFileManager.defaultManager().trashItemAtURL_resultingItemURL_error_(
        NSURL.fileURLWithPath_(str(folder)), None, None)
    if not ok or where is None:
        raise OSError(str(error.localizedDescription()) if error is not None else "the Trash refused it")
    return Path(str(where.path()))


def _move(root: Path) -> tuple[int, Path | None]:
    with ledger.editing():
        if reason := busy_reason():  # a file that arrived just before the guard went up
            raise Busy(reason)
        entries = _entries(root)
        if not entries:
            return 0, None
        stamp = datetime.now()
        box = root / f"Plutus data (removed {stamp.day} {stamp:%b %Y, %H.%M})"
        if box.exists():  # twice in one minute
            box = root / f"{box.name[:-1]}.{stamp:%S})"
        box.mkdir()
        moved: list[str] = []
        try:
            for p in entries:
                p.rename(box / p.name)
                moved.append(p.name)
            return len(moved), to_trash(box)
        except BaseException:
            for name in reversed(moved):  # put back everything moved so far
                (box / name).rename(root / name)
            box.rmdir()
            raise


async def start_over() -> dict:
    """Moves everything Plutus keeps about you to the Trash. Raises Busy when it can't happen now, OSError when the
    Trash refused (then nothing has moved)."""
    global in_progress
    from app.llm import llm

    root = userdata.root().resolve()
    _check_root(root)
    if reason := busy_reason():
        raise Busy(reason)
    in_progress = True  # from here, an upload is turned away
    try:
        await llm.shutdown()  # stops an Ollama Plutus started: its process id and log are in data/run
        count, where = await asyncio.to_thread(_move, root)
    finally:
        in_progress = False
    if where is None:
        log.info("start over: nothing to move, the data folder was already empty")
        return {"moved": 0, "trash": None}
    log.info("start over: %d item(s) from %s moved to the Trash as %r; Plutus starts empty", count, root, where.name)
    return {"moved": count, "trash": str(where)}
