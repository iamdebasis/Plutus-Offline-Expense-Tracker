"""Where your uploaded originals (statements, screenshots) are kept: data/uploads, inside the project's data folder
with everything else about you, so a new user starts from nothing and deleting data/ is a complete fresh start.
Stored paths in uploads.json are relative to this folder.

Installs from before this rule could keep originals in a folder chosen elsewhere; `bring_files_home` moves them
into data/uploads once, at startup.
"""

import os
import shutil
import subprocess
from pathlib import Path

from app import logs, userdata
from app.jsonstore import JsonFile

log = logs.get("storage")


def _prefs() -> JsonFile:
    return userdata.json_file("settings.json", default=dict)


def uploads_dir() -> Path:
    return userdata.path("uploads")


def file_path(rec) -> Path:
    return uploads_dir() / rec.stored_path


def incoming_dir() -> Path:
    """Where an upload lands while it's being checked, before it's filed away."""
    d = userdata.path("run", "incoming")
    d.mkdir(parents=True, exist_ok=True)
    return d


def pretty(path: Path | str) -> str:
    """~/Documents/Statements rather than /Users/you/Documents/Statements."""
    p, home = Path(path), Path.home()
    return f"~/{p.relative_to(home)}" if home in p.parents else str(p)


def cloud_sync_warning(path: Path) -> str | None:
    """Folders that quietly copy their contents to someone's servers: your data folder must not be in one."""
    home = Path.home()
    p = path.expanduser().resolve()
    watched = [
        (home / "Library" / "Mobile Documents", "iCloud Drive"),
        (home / "Library" / "CloudStorage", "a cloud drive (Dropbox, Google Drive or OneDrive)"),
        (home / "Dropbox", "Dropbox"),
        (home / "Google Drive", "Google Drive"),
        (home / "OneDrive", "OneDrive"),
    ]
    if (home / "Library" / "Mobile Documents" / "com~apple~CloudDocs" / "Desktop").exists():
        watched += [(home / "Desktop", "iCloud (Desktop & Documents sync is on)"),
                    (home / "Documents", "iCloud (Desktop & Documents sync is on)")]
    for root, what in watched:
        if p == root or root in p.parents:
            return f"Plutus's folder syncs to {what}, so your data leaves this Mac. Move the project to a folder that doesn't sync."
    return None


def bring_files_home() -> int:
    """Originals an older install kept in a folder outside data/ move into data/uploads, and the setting that
    pointed there goes. Returns how many files moved."""
    from app import vault

    elsewhere = _prefs().read().get("uploadsDir")
    if not elsewhere:
        return 0
    old_root, home = Path(elsewhere), uploads_dir()
    moved = 0
    if old_root.resolve() != home.resolve():
        for rec in vault.list_uploads():
            src, dst = old_root / rec.stored_path, home / rec.stored_path
            if src.exists() and not dst.exists():
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(src, dst)
                moved += 1
        _remove_empty_dirs(old_root)
    _prefs().update(lambda prefs: {k: v for k, v in prefs.items() if k not in ("uploadsDir", "storageConfirmed")})
    log.info("your files are kept in %s now, with the rest of your data%s", pretty(home), f" ({moved} moved there)" if moved else "")
    return moved


def migrate_legacy_paths() -> None:
    """Early uploads stored paths relative to data/ ("uploads/cred/…"); make them relative to the folder.
    No kind folder is called "uploads", so this is safe to run every start."""
    from app import vault

    for rec in vault.list_uploads():
        if rec.stored_path.startswith("uploads/"):
            vault.update_upload(rec.id, stored_path=rec.stored_path.removeprefix("uploads/"))
    shutil.rmtree(uploads_dir() / ".incoming", ignore_errors=True)  # the old temp folder; uploads land in run/ now


def summary() -> dict:
    """What the file sheet and the vault show about where your files are."""
    from app import vault

    folder = uploads_dir()
    uploads = vault.list_uploads()
    return {
        "folder": str(folder),
        "display": pretty(folder),
        "cloudWarning": cloud_sync_warning(userdata.root()),
        "files": len(uploads),
        "bytes": sum(u.size for u in uploads),
        "missing": sum(not (folder / u.stored_path).exists() for u in uploads),
    }


def reveal() -> None:
    folder = uploads_dir()
    folder.mkdir(parents=True, exist_ok=True)
    subprocess.run(["open", str(folder)], check=False)


def _remove_empty_dirs(root: Path) -> None:
    if not root.exists():
        return
    for dirpath, _, _ in sorted(os.walk(root), key=lambda w: -len(w[0])):
        d = Path(dirpath)
        if d != root and not any(d.iterdir()):
            d.rmdir()
