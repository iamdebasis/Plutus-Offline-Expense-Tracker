"""Runs Ollama only while the app needs it.

    async with llm.session() as ai:
        text = await ai.chat([{"role": "user", "content": "..."}], schema=MyModel.model_json_schema())

The first session starts `ollama serve` bound to 127.0.0.1 (unless something is already listening).
When the last session ends an idle timer starts; if no new work arrives before it fires, the model
is unloaded from memory and, if this app started the server, the server process is stopped.

An Ollama that was already running (the Ollama app in the menu bar runs its own) is left running: it's
someone else's process. Only the model is unloaded, which is what frees the memory, so the status says
"asleep" whenever the model isn't loaded, whoever runs the server.
"""

import asyncio
import os
import shutil
import signal
import subprocess
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator, Literal

import httpx

from app import logs, userdata

State = Literal["off", "starting", "ready", "busy", "stopping", "external", "unavailable"]
# What the page shows: the model's state, not the server's.
Shown = Literal["unavailable", "asleep", "starting", "working", "awake", "stopping"]
log = logs.get("llm")

_CANDIDATE_BINARIES = [
    "/usr/local/bin/ollama",
    "/opt/homebrew/bin/ollama",
    "/Applications/Ollama.app/Contents/Resources/ollama",
]


class LLMUnavailable(RuntimeError):
    pass


class OllamaManager:
    def __init__(
        self,
        host: str,
        model: str,
        idle_seconds: float,
        binary: str | None = None,
        run_dir: Path | None = None,
        start_timeout: float = 30.0,
    ):
        self.host = host
        self.base_url = f"http://{host}"
        self.model = model
        self.idle_seconds = idle_seconds
        self.start_timeout = start_timeout
        self._binary = binary
        self._run_dir = run_dir
        self._proc: subprocess.Popen | None = None
        self._owned_pid: int | None = None
        self._active = 0
        self._lock = asyncio.Lock()
        self._idle_task: asyncio.Task | None = None
        self._idle_since: float | None = None  # when the last job ended, while waiting to go to sleep
        self.state: State = "off"

    # ---- paths ---------------------------------------------------------------------------

    @property
    def run_dir(self) -> Path:
        return self._run_dir or userdata.path("run")

    @property
    def pidfile(self) -> Path:
        return self.run_dir / "ollama.pid"

    @property
    def logfile(self) -> Path:
        return self.run_dir / "ollama.log"

    def _client(self, timeout: float) -> httpx.AsyncClient:
        """A client for Ollama on this machine only. trust_env=False: no HTTP(S)_PROXY or ALL_PROXY variable, nor a
        proxy set in macOS's network settings, can route what's sent to the model (payee names) through another
        computer; a proxy would also stop the local AI working at all."""
        return httpx.AsyncClient(base_url=self.base_url, timeout=timeout, trust_env=False)

    def binary(self) -> str | None:
        if self._binary:
            return self._binary
        for candidate in [shutil.which("ollama"), *_CANDIDATE_BINARIES]:
            if candidate and Path(candidate).exists():
                return candidate
        return None

    @property
    def owns_server(self) -> bool:
        return self._owned_pid is not None

    # ---- public API ----------------------------------------------------------------------

    @asynccontextmanager
    async def session(self) -> AsyncIterator["OllamaManager"]:
        async with self._lock:
            if self._idle_task:
                self._idle_task.cancel()
                self._idle_task = None
            self._idle_since = None
            await self._start()
            await self._require_model()
            self._active += 1
            self.state = "busy"
        try:
            yield self
        finally:
            async with self._lock:
                self._active -= 1
                if self._active == 0:
                    self.state = "ready"
                    log.info("done for now; staying warm %ds in case more work comes, then going to sleep", int(self.idle_seconds))
                    self._idle_since = time.monotonic()
                    self._idle_task = asyncio.create_task(self._stop_when_idle())

    async def chat(self, messages: list[dict], schema: dict | None = None, timeout: float = 300, purpose: str = "a question") -> str:
        """One non-streaming chat call. Pass a JSON schema to force structured output.
        Images go in a message as {"images": [<base64>]}."""
        if self._active == 0:
            raise RuntimeError("chat() must be called inside `async with llm.session()`")
        started = time.monotonic()
        payload: dict = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "think": False,
            "options": {"temperature": 0},
            # Ollama's own unload timer is a backstop; normally we unload explicitly when idle.
            "keep_alive": f"{int(self.idle_seconds) + 60}s",
        }
        if schema:
            payload["format"] = schema
        async with self._client(timeout) as client:
            resp = await client.post("/api/chat", json=payload)
        resp.raise_for_status()
        body = resp.json()
        message = body["message"]
        text = message.get("content") or ""
        if not text.strip() and schema:
            # Thinking-capable models (the default qwen3-vl:8b) put schema-constrained output in
            # `thinking` and leave `content` empty when think=false.
            text = message.get("thinking") or ""
        load_s = body.get("load_duration", 0) / 1e9
        log.info(
            "%s · %s · %.1fs%s · %s tokens in, %s out",
            self.model, purpose, time.monotonic() - started,
            f" (incl. {load_s:.1f}s loading the model into memory)" if load_s > 1 else "",
            body.get("prompt_eval_count", "?"), body.get("eval_count", "?"),
        )
        return text

    async def status(self) -> dict:
        """What the page shows. `state` is the model's: asleep unless it's loaded, whoever runs the server.
        `server` says who does: "plutus" (started for a job, stopped after), "ollama" (the Ollama app or a
        server you started; left running), or None."""
        up = await self.is_up()
        loaded = up and await self._loaded()
        busy = {"starting": "starting", "busy": "working", "stopping": "stopping"}
        if self.state in busy:
            shown: Shown = busy[self.state]  # type: ignore[assignment]
        elif loaded:
            shown = "awake"
        elif not up and not self.binary():
            shown = "unavailable"
        else:
            shown = "asleep"
        sleeps_in = None
        if shown == "awake" and self._idle_since is not None:
            sleeps_in = max(0, round(self.idle_seconds - (time.monotonic() - self._idle_since)))
        return {
            "state": shown,
            "model": self.model,
            "installed": self.binary() is not None,
            "modelInstalled": await self._model_installed(),
            "loaded": loaded,
            "server": ("plutus" if self.owns_server else "ollama") if up else None,
            "sleepsIn": sleeps_in,
            "idleSeconds": self.idle_seconds,
        }

    async def reclaim(self) -> None:
        """At startup: an Ollama that a previous run of this app started and never stopped (the app was killed)
        is stopped now, instead of running until the next job."""
        self._adopt_orphan()
        if not self.owns_server:
            return
        log.info("stopping the Ollama a previous run left behind (pid %d)", self._owned_pid)
        async with self._lock:
            await self._stop_locked()

    async def shutdown(self) -> None:
        """Called when the app exits. A no-op if we never used the LLM."""
        if self._idle_task:
            self._idle_task.cancel()
            self._idle_task = None
        if self.state == "off" and not self.owns_server:
            return
        async with self._lock:
            await self._stop_locked()

    async def is_up(self) -> bool:
        try:
            async with self._client(1.0) as client:
                return (await client.get("/api/version")).status_code == 200
        except httpx.HTTPError:
            return False

    # ---- lifecycle -----------------------------------------------------------------------

    async def _start(self) -> None:
        if await self.is_up():
            if self.owns_server:
                log.info("Ollama still awake from the last job → reusing it")
                return
            self._adopt_orphan()
            if self.owns_server:
                log.info("found the Ollama a previous run of this app left behind (pid %d) → using it, will stop it after", self._owned_pid)
            else:
                log.info("Ollama is already running on its own (e.g. the menu-bar app) → using it; it will be left running")
            return
        binary = self.binary()
        if not binary:
            self.state = "unavailable"
            log.error("Ollama is not installed, so the local AI can't run")
            raise LLMUnavailable("Ollama is not installed. Get it from https://ollama.com")

        self.state = "starting"
        log.info("starting Ollama for %s (ollama serve, 127.0.0.1 only)…", self.model)
        started = time.monotonic()
        self.run_dir.mkdir(parents=True, exist_ok=True)
        with self.logfile.open("ab") as server_log:
            self._proc = subprocess.Popen(
                [binary, "serve"],
                env={**os.environ, "OLLAMA_HOST": self.host},
                stdin=subprocess.DEVNULL,
                stdout=server_log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        self._owned_pid = self._proc.pid
        self.pidfile.write_text(str(self._proc.pid))

        deadline = time.monotonic() + self.start_timeout
        while time.monotonic() < deadline:
            if self._proc.poll() is not None:
                code = self._proc.returncode
                self._forget_process()
                self.state = "off"
                log.error("ollama serve exited with code %s. Its log: %s", code, self.logfile)
                raise LLMUnavailable(f"`ollama serve` exited with code {code}. See {self.logfile}")
            if await self.is_up():
                self.state = "ready"
                log.info("Ollama ready in %.1fs (pid %d)", time.monotonic() - started, self._owned_pid)
                return
            await asyncio.sleep(0.25)
        await self._stop_process()
        self.state = "off"
        log.error("Ollama didn't start within %.0fs. Its log: %s", self.start_timeout, self.logfile)
        raise LLMUnavailable(f"Ollama did not start within {self.start_timeout:.0f}s. See {self.logfile}")

    async def _require_model(self) -> None:
        installed = await self._model_installed()
        if installed is False:
            log.error("model %s isn't installed. Run: ollama pull %s", self.model, self.model)
            raise LLMUnavailable(f"Model {self.model} is not installed. Run: ollama pull {self.model}")

    async def _loaded(self) -> bool:
        """Whether the model is in memory right now (Ollama's own list of loaded models)."""
        try:
            async with self._client(2.0) as client:
                resp = await client.get("/api/ps")
            names = {m.get("name") or m.get("model") for m in resp.json().get("models", [])}
            return self.model in names or f"{self.model}:latest" in names
        except (httpx.HTTPError, ValueError, AttributeError):
            return False

    async def _model_installed(self) -> bool | None:
        """True/False when the server can tell us; otherwise fall back to Ollama's manifest folder."""
        try:
            async with self._client(2.0) as client:
                resp = await client.get("/api/tags")
            names = {m["name"] for m in resp.json().get("models", [])}
            return self.model in names or f"{self.model}:latest" in names
        except (httpx.HTTPError, ValueError, KeyError):
            name, _, tag = self.model.partition(":")
            models_dir = Path(os.environ.get("OLLAMA_MODELS", Path.home() / ".ollama" / "models"))
            manifest = models_dir / "manifests" / "registry.ollama.ai" / "library" / name / (tag or "latest")
            return manifest.exists() if models_dir.exists() else None

    async def _stop_when_idle(self) -> None:
        try:
            await asyncio.sleep(self.idle_seconds)
        except asyncio.CancelledError:
            return
        async with self._lock:
            if self._active == 0:
                log.info("no work for %ds → going to sleep", int(self.idle_seconds))
                await self._stop_locked()

    async def _stop_locked(self) -> None:
        self.state = "stopping"
        self._idle_since = None
        owned = self.owns_server
        if await self.is_up():
            await self._unload_model()
            log.info("%s unloaded from memory", self.model)
        await self._stop_process()
        self.state = "external" if await self.is_up() else "off"
        if owned:
            log.info("Ollama stopped" if self.state == "off" else "Ollama still answering after stop; check `ollama ps`")
        elif self.state == "external":
            log.info("Ollama left running: it was running before the app needed it")

    async def _unload_model(self) -> None:
        try:
            async with self._client(10.0) as client:
                await client.post("/api/generate", json={"model": self.model, "keep_alive": 0})
        except httpx.HTTPError:
            pass

    async def _stop_process(self) -> None:
        pid = self._owned_pid
        if pid is None:
            return
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        for _ in range(50):
            if not self._alive(pid):
                break
            await asyncio.sleep(0.1)
        else:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        self._forget_process()

    def _forget_process(self) -> None:
        if self._proc is not None:
            try:
                self._proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
        self._proc = None
        self._owned_pid = None
        self.pidfile.unlink(missing_ok=True)

    def _alive(self, pid: int) -> bool:
        if self._proc is not None and self._proc.pid == pid:
            return self._proc.poll() is None  # poll() also reaps our own child
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

    def _adopt_orphan(self) -> None:
        """If a previous run of this app started the server and crashed, take ownership back
        so it still gets shut down."""
        if self._owned_pid is not None or not self.pidfile.exists():
            return
        try:
            pid = int(self.pidfile.read_text().strip())
        except ValueError:
            self.pidfile.unlink(missing_ok=True)
            return
        if not self._alive(pid):
            self.pidfile.unlink(missing_ok=True)
            return
        cmd = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True).stdout
        if "ollama" in cmd:
            self._owned_pid = pid
        else:
            self.pidfile.unlink(missing_ok=True)
