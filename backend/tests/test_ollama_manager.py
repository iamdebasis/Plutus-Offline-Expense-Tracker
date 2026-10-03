"""Exercises start / reuse / idle-stop against a fake `ollama` binary, so tests never touch the real one."""

import asyncio
import os
import socket
import subprocess
import sys
import textwrap
import time

import pytest

from app.llm.ollama import LLMUnavailable, OllamaManager

FAKE_SERVER = textwrap.dedent(
    """
    import json, os, socketserver
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    host, port = os.environ["OLLAMA_HOST"].rsplit(":", 1)
    LOADED = set()  # models in memory: a chat loads one, keep_alive 0 unloads it

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/api/version":
                self._json({"version": "fake"})
            elif self.path == "/api/tags":
                self._json({"models": [{"name": "fake-model:1b"}]})
            elif self.path == "/api/ps":
                self._json({"models": [{"name": m, "model": m} for m in sorted(LOADED)]})
            else:
                self.send_error(404)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            if self.path == "/api/chat":
                LOADED.add(body["model"])
                self._json({"message": {"role": "assistant", "content": json.dumps({"echo": body["messages"][-1]["content"], "think": body.get("think")})}})
            elif self.path == "/api/generate":
                if body.get("keep_alive") == 0:
                    LOADED.discard(body["model"])
                with open(os.environ["FAKE_UNLOAD_LOG"], "a") as f:
                    f.write(json.dumps(body) + "\\n")
                self._json({"done": True})
            else:
                self.send_error(404)

        def _json(self, obj):
            data = json.dumps(obj).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    class Server(ThreadingHTTPServer):
        def server_bind(self):  # without HTTPServer's look-up of this machine's name, which can take half a minute on CI
            socketserver.TCPServer.server_bind(self)
            self.server_name, self.server_port = "localhost", self.server_address[1]

    Server((host, int(port)), Handler).serve_forever()
    """
)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def fake_ollama(tmp_path, monkeypatch):
    script = tmp_path / "fake_ollama.py"
    script.write_text(FAKE_SERVER)
    binary = tmp_path / "ollama"
    binary.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n')
    binary.chmod(0o755)
    unload_log = tmp_path / "unloads.log"
    monkeypatch.setenv("FAKE_UNLOAD_LOG", str(unload_log))
    return binary, unload_log


def _manager(binary, tmp_path, port, idle=0.3, model="fake-model:1b"):
    # a new process can take a while to start on a busy CI machine; the wait ends as soon as the server answers
    return OllamaManager(host=f"127.0.0.1:{port}", model=model, idle_seconds=idle,
                         binary=str(binary), run_dir=tmp_path / "run", start_timeout=60)


async def _until_up(m: OllamaManager, seconds: float = 60) -> None:
    deadline = time.monotonic() + seconds
    while not await m.is_up():
        assert time.monotonic() < deadline, "the fake Ollama never came up"
        await asyncio.sleep(0.1)


def test_starts_on_demand_and_stops_when_idle(fake_ollama, tmp_path):
    binary, unload_log = fake_ollama
    m = _manager(binary, tmp_path, _free_port())

    async def scenario():
        assert not await m.is_up()
        async with m.session() as ai:
            assert m.state == "busy" and ai.owns_server
            assert m.pidfile.exists()
            out = await ai.chat([{"role": "user", "content": "hi"}], schema={"type": "object"})
            assert '"echo": "hi"' in out and '"think": false' in out
        assert m.state == "ready" and await m.is_up()  # stays warm for back-to-back work
        await asyncio.sleep(1.0)
        assert m.state == "off"
        assert not await m.is_up()
        assert not m.pidfile.exists()

    asyncio.run(scenario())
    assert '"keep_alive": 0' in unload_log.read_text()  # model was unloaded before stopping


def test_back_to_back_sessions_reuse_the_server(fake_ollama, tmp_path):
    binary, _ = fake_ollama
    m = _manager(binary, tmp_path, _free_port(), idle=0.5)

    async def scenario():
        async with m.session():
            pid = m._owned_pid
        await asyncio.sleep(0.1)  # well inside the idle window
        async with m.session():
            assert m._owned_pid == pid
        await m.shutdown()
        assert not await m.is_up()

    asyncio.run(scenario())


def test_leaves_an_already_running_ollama_alone(fake_ollama, tmp_path):
    binary, unload_log = fake_ollama
    port = _free_port()
    external = subprocess.Popen([str(binary), "serve"], env={**os.environ, "OLLAMA_HOST": f"127.0.0.1:{port}"})
    try:
        m = _manager(binary, tmp_path, port, idle=0.1)

        async def scenario():
            await _until_up(m)
            async with m.session() as ai:
                assert not ai.owns_server
            await asyncio.sleep(0.5)
            assert await m.is_up()  # still running
            assert m.state == "external"

        asyncio.run(scenario())
        assert external.poll() is None
        assert '"keep_alive": 0' in unload_log.read_text()  # but the model was unloaded
    finally:
        external.terminate()
        external.wait()


def test_missing_model_is_reported(fake_ollama, tmp_path):
    binary, _ = fake_ollama
    m = _manager(binary, tmp_path, _free_port(), model="not-pulled:8b")

    async def scenario():
        with pytest.raises(LLMUnavailable, match="ollama pull not-pulled:8b"):
            async with m.session():
                pass
        await m.shutdown()

    asyncio.run(scenario())


def test_missing_binary(tmp_path):
    m = OllamaManager(host=f"127.0.0.1:{_free_port()}", model="x", idle_seconds=1,
                      binary=str(tmp_path / "nope"), run_dir=tmp_path / "run")
    m._binary = None
    m.binary = lambda: None  # type: ignore[method-assign]

    async def scenario():
        with pytest.raises(LLMUnavailable, match="not installed"):
            async with m.session():
                pass

    asyncio.run(scenario())


def test_adopts_server_left_behind_by_a_crashed_run(fake_ollama, tmp_path):
    binary, _ = fake_ollama
    port = _free_port()
    first = _manager(binary, tmp_path, port, idle=60)

    async def crash():
        async with first.session():
            pass
        first._idle_task.cancel()  # simulate the app dying without cleanup

    asyncio.run(crash())
    orphan_pid = first._owned_pid
    assert orphan_pid

    second = _manager(binary, tmp_path, port, idle=0.1)

    async def recover():
        async with second.session() as ai:
            assert ai.owns_server  # recognised via the pid file
        await asyncio.sleep(0.6)
        assert not await second.is_up()

    asyncio.run(recover())
    # The orphan is our own child in this test, so reap it here (in real life launchd does).
    assert first._proc.wait(timeout=3) is not None


def test_status_follows_the_model_not_the_server(fake_ollama, tmp_path):
    """Asleep until a job, awake with a countdown after it, asleep again once the model is unloaded."""
    binary, _ = fake_ollama
    m = _manager(binary, tmp_path, _free_port(), idle=0.6)

    async def scenario():
        before = await m.status()
        assert (before["state"], before["loaded"], before["server"]) == ("asleep", False, None)
        async with m.session() as ai:
            await ai.chat([{"role": "user", "content": "hi"}])
            assert (await m.status())["state"] == "working"
        after = await m.status()
        assert (after["state"], after["loaded"], after["server"]) == ("awake", True, "plutus")
        assert 0 <= after["sleepsIn"] <= 1
        await asyncio.sleep(1.2)
        slept = await m.status()
        assert (slept["state"], slept["loaded"], slept["server"], slept["sleepsIn"]) == ("asleep", False, None, None)

    asyncio.run(scenario())


def test_with_the_ollama_app_running_the_model_still_goes_to_sleep(fake_ollama, tmp_path):
    """The Ollama app keeps its own server up; that's not the model being awake."""
    binary, _ = fake_ollama
    port = _free_port()
    external = subprocess.Popen([str(binary), "serve"], env={**os.environ, "OLLAMA_HOST": f"127.0.0.1:{port}"})
    try:
        m = _manager(binary, tmp_path, port, idle=0.2)

        async def scenario():
            await _until_up(m)
            assert (await m.status())["state"] == "asleep"
            async with m.session() as ai:
                await ai.chat([{"role": "user", "content": "hi"}])
            assert (await m.status())["state"] == "awake"
            await asyncio.sleep(0.8)
            slept = await m.status()
            assert (slept["state"], slept["loaded"], slept["server"]) == ("asleep", False, "ollama")

        asyncio.run(scenario())
        assert external.poll() is None  # someone else's server: left running
    finally:
        external.terminate()
        external.wait()


def test_a_server_left_behind_is_stopped_at_startup(fake_ollama, tmp_path):
    binary, _ = fake_ollama
    port = _free_port()
    first = _manager(binary, tmp_path, port, idle=60)

    async def crash():
        async with first.session():
            pass
        first._idle_task.cancel()  # the app dies without cleaning up

    asyncio.run(crash())
    assert first._owned_pid

    second = _manager(binary, tmp_path, port, idle=60)

    async def startup():
        await second.reclaim()
        assert not await second.is_up()
        assert not second.pidfile.exists()

    asyncio.run(startup())
    assert first._proc.wait(timeout=3) is not None


def test_proxy_settings_never_see_what_goes_to_the_local_ai(fake_ollama, tmp_path, monkeypatch):
    """Payee names go to the model on this machine, never through a proxy someone set (here: one that answers nothing)."""
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.setenv(name, "http://127.0.0.1:9")
    binary, _ = fake_ollama
    m = _manager(binary, tmp_path, _free_port())

    async def scenario():
        async with m.session() as ai:
            assert '"echo": "a payee"' in await ai.chat([{"role": "user", "content": "a payee"}])
        await m.shutdown()

    asyncio.run(scenario())

