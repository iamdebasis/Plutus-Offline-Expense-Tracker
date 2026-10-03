"""Readable terminal output: one line per meaningful event, tagged by area, coloured where it matters.

    18:42:05  ocr       Apple Vision · 11 pages · 690 lines · 3.1s
    18:42:05  llm       starting Ollama (qwen3-vl:8b)…

Use `log = logs.get("ocr")` in a module; the area is the part after "plutus.".
Logs name files, counts and timings. They never print your transactions.
"""

import logging
import sys
import time
from contextlib import contextmanager

ROOT = "plutus"

# ANSI colours, only when the terminal can show them
_COLORS = {
    "ocr": "36",  # cyan
    "decode": "36",
    "llm": "35",  # magenta
    "startup": "1",  # bold
    "upload": "34",  # blue
    "import": "34",
}
_LEVEL_COLORS = {logging.WARNING: "33", logging.ERROR: "31", logging.CRITICAL: "31"}


class _Formatter(logging.Formatter):
    def __init__(self, color: bool):
        super().__init__()
        self.color = color

    def format(self, record: logging.LogRecord) -> str:
        area = record.name.removeprefix(ROOT + ".") if record.name.startswith(ROOT + ".") else record.name
        stamp = time.strftime("%H:%M:%S", time.localtime(record.created))
        message = record.getMessage()
        if record.exc_info:
            message += "\n" + self.formatException(record.exc_info)
        tag = f"{area:<9}"
        if self.color:
            code = _LEVEL_COLORS.get(record.levelno) or _COLORS.get(area)
            dim = "\033[2m"
            reset = "\033[0m"
            if code:
                tag = f"\033[{code}m{tag}{reset}"
            if record.levelno >= logging.WARNING:
                message = f"\033[{_LEVEL_COLORS[record.levelno]}m{message}{reset}"
            return f"{dim}{stamp}{reset}  {tag} {message}"
        return f"{stamp}  {tag} {message}"


def setup() -> None:
    """Idempotent: safe to call from every entry point."""
    root = logging.getLogger(ROOT)
    if root.handlers:
        return
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(_Formatter(color=sys.stderr.isatty()))
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    root.propagate = False


def get(area: str) -> logging.Logger:
    return logging.getLogger(f"{ROOT}.{area}")


@contextmanager
def timed():
    """with timed() as t: ...; then t() gives the seconds elapsed so far."""
    start = time.monotonic()
    yield lambda: time.monotonic() - start


def quiet_access_log(record: logging.LogRecord) -> bool:
    """Keep uvicorn's request lines only for errors; our own log lines already say what happened."""
    try:
        _, _, _, _, status = record.args  # type: ignore[misc]
    except (TypeError, ValueError):
        return True
    return int(status) >= 400


def size(n: int) -> str:
    return f"{n / 1024:.0f} KB" if n < 1024 * 1024 else f"{n / 1024 / 1024:.1f} MB"
