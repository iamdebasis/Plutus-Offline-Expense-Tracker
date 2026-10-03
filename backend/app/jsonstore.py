"""Tiny JSON-file persistence: atomic writes, one lock per file."""

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any, Callable

_locks: dict[Path, threading.RLock] = {}
_locks_guard = threading.Lock()


def _lock_for(path: Path) -> threading.RLock:
    with _locks_guard:
        return _locks.setdefault(path.resolve(), threading.RLock())


class JsonFile:
    def __init__(self, path: Path, default: Callable[[], Any]):
        self.path = path
        self.default = default
        self.lock = _lock_for(path)

    def read(self) -> Any:
        with self.lock:
            if not self.path.exists():
                return self.default()
            return json.loads(self.path.read_text(encoding="utf-8"))

    def write(self, data: Any) -> None:
        """Write to a temp file in the same directory, then rename over the target,
        so a crash mid-write can never leave a half-written file behind."""
        with self.lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=f".{self.path.name}.", suffix=".tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2, default=str)
                    f.write("\n")
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, self.path)
            except BaseException:
                Path(tmp).unlink(missing_ok=True)
                raise

    def update(self, fn: Callable[[Any], Any]) -> Any:
        """Read-modify-write under the file's lock."""
        with self.lock:
            data = fn(self.read())
            self.write(data)
            return data
