import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

LOOPBACK_HOSTS = ("127.0.0.1", "localhost")


def _loopback_only(hostport: str) -> str:
    host = hostport.rsplit(":", 1)[0]
    if host not in LOOPBACK_HOSTS:
        raise ValueError(f"Refusing non-local LLM host {hostport!r}: transaction data must stay on this machine")
    return hostport


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("ET_DATA_DIR", ROOT / "data")).resolve())
    web_dist: Path = ROOT / "web" / "dist"
    port: int = int(os.environ.get("ET_PORT", "8000"))
    max_upload_bytes: int = 50 * 1024 * 1024

    ollama_host: str = _loopback_only(os.environ.get("ET_OLLAMA_HOST", "127.0.0.1:11434"))
    # A model to use whatever is chosen in the Local AI panel; unset, Plutus uses your choice there, else the best
    # model downloaded for this Mac (app/llm/setup.py)
    ollama_model: str | None = os.environ.get("ET_OLLAMA_MODEL") or None
    # How long the model stays loaded after the last job before we unload it / stop the server.
    ollama_idle_seconds: float = float(os.environ.get("ET_OLLAMA_IDLE_SECONDS", "90"))


settings = Settings()
