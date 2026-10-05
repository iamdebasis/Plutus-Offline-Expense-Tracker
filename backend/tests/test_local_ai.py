"""The Local AI panel: which model suits this Mac, what's downloaded, which model Plutus uses, and the steps it shows.
Plutus never downloads a model or installs Ollama: every step is a command or a link for you to use. Fake Macs, fake
Ollama folders and a fake Ollama server only; nothing here asks the Ollama on this Mac."""

import ast
import asyncio
import json
import plistlib
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import preferences, userdata
from app.llm import LLMUnavailable, OllamaManager, advice, llm, setup
from app.main import app


def mac(memory: float = 16, apple: bool = True, free: float = 100.0, macos: str = "15.1") -> advice.Mac:
    return advice.Mac("Apple M-test" if apple else "Intel test chip", apple, memory, free, macos)


def ollama(*models, installed=True, version="0.32.14", app_=True, homebrew=None, running=False, listed=True) -> advice.Ollama:
    found = [m if isinstance(m, advice.Downloaded) else advice.Downloaded(*m) for m in models]
    return advice.Ollama(installed, app_, homebrew, version, running, found if listed else None)


NOTHING = advice.Ollama(installed=False, app=False, homebrew=None, version=None, running=False, models=None)


# ---- what suits a Mac ----------------------------------------------------------------------------------------------


@pytest.mark.parametrize("memory, model", [(8, "qwen3.5:2b"), (12, "qwen3.5:2b"), (15.9, "qwen3.5:4b"), (16, "qwen3.5:4b"),
                                           (18, "qwen3.5:4b"), (24, "qwen3.5:9b"), (64, "qwen3.5:9b")])
def test_the_suggestion_follows_the_macs_memory(memory, model):
    assert advice.suggestion(mac(memory)).name == model


def test_no_suggestion_where_a_model_would_only_slow_the_mac():
    for small in (advice.advise(mac(6), NOTHING, brew=True), advice.advise(mac(32, apple=False), NOTHING, brew=True)):
        assert small.suggestion is None and small.steps == [] and not small.ready
        assert "works fully without" in small.notes[0]
    assert "Intel" in advice.advise(mac(32, apple=False), NOTHING).notes[0]


# ---- the steps -----------------------------------------------------------------------------------------------------


def test_nothing_installed_shows_install_download_and_done():
    a = advice.advise(mac(16), NOTHING, brew=True)
    assert (a.headline, a.ready, a.in_use) == ("Not set up: Ollama isn't installed", False, None)
    install, download, done = a.steps
    assert install.link == "https://ollama.com/download" and install.command == "brew install --cask ollama-app"
    assert download.command == "ollama pull qwen3.5:4b" and not download.optional
    assert done.command is None and "notices it by itself" in done.text
    assert advice.advise(mac(16), NOTHING, brew=False).steps[0].command is None  # no Homebrew: the download page only


def test_an_ollama_too_old_for_plutus_comes_first():
    for homebrew, command in ((None, None), ("cask", "brew upgrade --cask ollama-app"), ("formula", "brew upgrade ollama")):
        a = advice.advise(mac(16), ollama(("qwen3.5:4b", 3.3), version="0.31.2", homebrew=homebrew), brew=True)
        assert not a.ready and a.headline == "Not set up: Ollama 0.31.2 is too old for Plutus"
        assert a.steps[0].text.startswith("Update Ollama to 0.32.7 or newer") and a.steps[0].command == command
    assert advice.advise(mac(16), ollama(("qwen3.5:4b", 3.3), version="0.32.7")).ready


def test_a_model_that_suits_the_mac_needs_nothing_more():
    for downloaded in ("qwen3.5:4b", "qwen3-vl:4b-instruct"):
        a = advice.advise(mac(16), ollama((downloaded, 3.3)))
        assert (a.ready, a.in_use, a.headline, a.steps) == (True, downloaded, f"Using {downloaded}", [])


def test_a_heavy_model_works_and_a_lighter_one_is_offered():
    a = advice.advise(mac(16), ollama(("qwen3-vl:8b", 6.1)))
    assert a.ready and a.in_use == "qwen3-vl:8b" and a.headline == "Using qwen3-vl:8b, heavy for this Mac"
    [lighter] = a.steps  # optional, and nothing to finish
    assert lighter.optional and lighter.command == "ollama pull qwen3.5:4b" and "lighter, faster" in lighter.text


def test_homebrews_ollama_without_the_app_is_started_before_downloading():
    a = advice.advise(mac(16), ollama(app_=False, homebrew="formula"))
    assert [s.command for s in a.steps[:2]] == ["brew services start ollama", "ollama pull qwen3.5:4b"]
    running = advice.advise(mac(16), ollama(app_=False, homebrew="formula", running=True))
    assert running.steps[0].command == "ollama pull qwen3.5:4b"


def test_notes_for_old_macos_low_disk_and_an_unknown_version():
    old = advice.advise(mac(16, macos="13.6"), NOTHING)
    assert old.steps == [] and "needs macOS 14 or later" in old.notes[0]
    full = advice.advise(mac(16, free=2.0), NOTHING)
    assert any(n.startswith("Free up some space first: qwen3.5:4b needs 3.3 GB") for n in full.notes)
    assert any("couldn't read Ollama's version" in n for n in advice.advise(mac(16), ollama(version=None)).notes)


# ---- which model Plutus uses -----------------------------------------------------------------------------------------


def test_the_most_capable_downloaded_model_that_suits_is_used():
    assert advice.model_in_use(32, [advice.Downloaded("qwen3.5:4b", 3.3), advice.Downloaded("qwen3.5:9b", 6.6)]) == "qwen3.5:9b"
    assert advice.model_in_use(16, [advice.Downloaded("qwen3.5:9b", 6.6), advice.Downloaded("qwen3.5:2b", 2.7)]) == "qwen3.5:2b"
    assert advice.model_in_use(16, [advice.Downloaded("qwen3.5:9b", 6.6)]) == "qwen3.5:9b"  # heavy, but it's what there is
    assert advice.model_in_use(16, []) is None


def test_your_choice_counts_while_its_downloaded():
    both = ollama(("qwen3.5:4b", 3.3), ("qwen3-vl:4b-instruct", 3.3))
    assert advice.advise(mac(16), both, chosen="qwen3-vl:4b-instruct").in_use == "qwen3-vl:4b-instruct"
    gone = advice.advise(mac(16), ollama(("qwen3.5:4b", 3.3)), chosen="qwen3.5:9b")
    assert gone.in_use == "qwen3.5:4b" and gone.ready
    assert "You chose qwen3.5:9b, which isn't downloaded any more, so Plutus uses qwen3.5:4b." in gone.notes
    alone = advice.advise(mac(16), ollama(), chosen="qwen3.5:9b")
    assert (alone.in_use, alone.ready, alone.headline) == ("qwen3.5:9b", False, "Not set up: qwen3.5:9b isn't downloaded")
    forced = advice.advise(mac(16), ollama(("qwen3.5:4b", 3.3)), chosen="qwen3.5:4b", override="fake-model:1b")
    assert forced.in_use == "fake-model:1b" and any("ET_OLLAMA_MODEL" in n for n in forced.notes)


def test_models_plutus_doesnt_know_are_listed_but_never_picked_for_you():
    a = advice.advise(mac(16), ollama(("fake-chat:3b", 2.0, False, True), ("fake-embed:1b", 0.3, False, False)))
    assert a.in_use is None and a.headline == "Not set up: Ollama is installed, but no suitable model is downloaded"
    chat, embed = a.models
    assert (chat["fit"], chat["known"], chat["usable"]) == ("suits", False, True)
    assert chat["note"] == "not tested with Plutus; can't read screenshots"
    assert not embed["usable"] and "can't answer questions" in embed["note"]
    assert advice.advise(mac(16), ollama(("fake-embed:1b", 0.3, False, False)), chosen="fake-embed:1b").in_use != "fake-embed:1b"
    picked = advice.advise(mac(16), ollama(("fake-chat:3b", 2.0, False, True)), chosen="fake-chat:3b")
    assert picked.ready and picked.headline == "Using fake-chat:3b (not tested with Plutus)"
    assert picked.steps[0].optional and picked.steps[0].command == "ollama pull qwen3.5:4b"


# ---- Ollama's files --------------------------------------------------------------------------------------------------


def _manifest(root: Path, *parts: str, sizes=(2_650_000_000, 680_000_000)) -> None:
    path = root.joinpath("manifests", *parts)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"layers": [{"size": s} for s in sizes]}))


def test_whats_downloaded_is_read_from_ollamas_folder(tmp_path):
    assert advice.models_on_disk(tmp_path / "nothing") is None
    _manifest(tmp_path, "registry.ollama.ai", "library", "qwen3.5", "4b")
    _manifest(tmp_path, "registry.ollama.ai", "someone", "fake-model", "1b", sizes=(1_000_000_000,))
    _manifest(tmp_path, "hf.co", "someone", "fake-gguf", "q4", sizes=(500_000_000,))
    (tmp_path / "manifests" / "registry.ollama.ai" / "library" / "broken").mkdir()
    (tmp_path / "manifests" / "registry.ollama.ai" / "library" / "broken" / "1b").write_text("not json")
    assert advice.models_on_disk(tmp_path) == [
        advice.Downloaded("hf.co/someone/fake-gguf:q4", 0.5),
        advice.Downloaded("qwen3.5:4b", 3.3),
        advice.Downloaded("someone/fake-model:1b", 1.0),
    ]


def test_how_ollama_was_installed_and_its_version_come_from_its_files(tmp_path, monkeypatch):
    monkeypatch.setattr(advice.shutil, "which", lambda *_: None)  # not the ollama on this Mac's PATH
    bundle = tmp_path / "Applications" / "Ollama.app"
    (bundle / "Contents").mkdir(parents=True)
    with (bundle / "Contents" / "Info.plist").open("wb") as f:
        plistlib.dump({"CFBundleShortVersionString": "0.32.14"}, f)
    found = advice.find_ollama(binaries=[], apps=[bundle], caskrooms=[], folder=tmp_path / "none")
    assert (found.installed, found.app, found.homebrew, found.version, found.models) == (True, True, None, "0.32.14", None)

    (tmp_path / "Caskroom" / "ollama-app").mkdir(parents=True)
    assert advice.find_ollama(binaries=[], apps=[bundle], caskrooms=[tmp_path / "Caskroom"]).homebrew == "cask"

    cellar = tmp_path / "Cellar" / "ollama" / "0.35.1" / "bin"
    cellar.mkdir(parents=True)
    (cellar / "ollama").write_text("#!/bin/sh\n")
    (tmp_path / "bin").mkdir()
    (tmp_path / "bin" / "ollama").symlink_to(cellar / "ollama")
    formula = advice.find_ollama(binaries=[str(tmp_path / "bin" / "ollama")], apps=[], caskrooms=[])
    assert (formula.installed, formula.app, formula.homebrew, formula.version) == (True, False, "formula", "0.35.1")

    assert not advice.find_ollama(binaries=[], apps=[], caskrooms=[]).installed


# ---- make check ----------------------------------------------------------------------------------------------------


def test_make_check_prints_the_same_advice():
    text = advice.as_text(advice.advise(mac(16), NOTHING, brew=True)).splitlines()
    assert text[0] == "  – Local AI (optional)                      Not set up: Ollama isn't installed"
    assert text[1] == "      For this Mac (16 GB): qwen3.5:4b (3.3 GB), the best balance of speed and accuracy"
    assert text[2].startswith("      1. Install Ollama")
    assert text[3] == "           brew install --cask ollama-app    (or https://ollama.com/download)"
    assert text[4:6] == ["      2. Download qwen3.5:4b (3.3 GB). In Terminal:", "           ollama pull qwen3.5:4b"]
    assert text[6].startswith("      3. That's all") and "Needs your eyes" in text[-1]
    ready = advice.as_text(advice.advise(mac(16), ollama(("qwen3.5:4b", 3.3))))
    assert ready == "  ✓ Local AI (optional)                      Using qwen3.5:4b"


def test_advice_runs_on_the_standard_library_alone(tmp_path):
    """`make check` runs it before Plutus's packages are installed."""
    path = Path(advice.__file__)
    tree = ast.parse(path.read_text())
    imported = {a.name.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.Import) for a in node.names}
    imported |= {node.module.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.module}
    assert imported <= set(sys.stdlib_module_names), imported - set(sys.stdlib_module_names)
    run = subprocess.run([sys.executable, "-I", str(path)], capture_output=True, text=True, timeout=60,
                         env={"PATH": "/usr/bin:/bin", "HOME": str(tmp_path), "OLLAMA_MODELS": str(tmp_path / "m"),
                              "ET_OLLAMA_HOST": "127.0.0.1:9"})
    assert run.returncode == 0, run.stderr
    assert "Local AI (optional)" in run.stdout


# ---- the app: a fake Ollama server ---------------------------------------------------------------------------------


class FakeOllama:
    """Answers like Ollama's server: its version, what's downloaded (with sizes and digests), what each model can do."""

    def __init__(self):
        self.version = "0.33.0"
        self.models: dict[str, tuple[int, list[str]]] = {}
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/api/version":
                    self._json({"version": fake.version})
                elif self.path == "/api/tags":
                    self._json({"models": [{"name": n, "size": s, "digest": f"sha-{n}"} for n, (s, _) in fake.models.items()]})
                elif self.path == "/api/ps":
                    self._json({"models": []})
                else:
                    self.send_error(404)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                if self.path == "/api/show" and body.get("model") in fake.models:
                    self._json({"capabilities": fake.models[body["model"]][1]})
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

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


@pytest.fixture
def fake(monkeypatch):
    server = FakeOllama()
    monkeypatch.setattr(llm, "base_url", server.url)
    monkeypatch.setattr(advice, "this_mac", lambda: mac(16))
    monkeypatch.setattr(advice, "find_ollama", lambda **_: ollama(listed=False, version="0.32.14"))
    yield server
    server.server.shutdown()


@pytest.fixture
def client():
    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


VISION = ["completion", "vision"]


def test_the_panel_and_your_choice(fake, client):
    fake.models = {"qwen3-vl:8b": (6_140_000_000, [*VISION, "thinking"]), "qwen3.5:4b": (3_320_000_000, VISION),
                   "fake-embed:1b": (300_000_000, ["embedding"])}
    panel = client.get("/api/llm/setup").json()
    assert panel["inUse"] == "qwen3.5:4b" and panel["ready"] and panel["chosen"] is None
    assert panel["ollama"] == {"installed": True, "app": True, "homebrew": None, "version": "0.33.0",  # the server's
                                    "minVersion": "0.32.7", "running": True, "versionOk": True}
    assert panel["suggestion"] == {"model": "qwen3.5:4b", "sizeGb": 3.3, "why": "the best balance of speed and accuracy",
                                   "downloaded": True}
    assert {m["name"]: m["fit"] for m in panel["models"]} == {"fake-embed:1b": "suits", "qwen3-vl:8b": "heavy", "qwen3.5:4b": "suits"}
    assert panel["steps"] == [] and panel["hintSeen"] is False

    chose = client.put("/api/llm/model", json={"model": "qwen3-vl:8b"})
    assert chose.status_code == 200 and chose.json()["inUse"] == "qwen3-vl:8b" and chose.json()["chosen"] == "qwen3-vl:8b"
    assert llm.model == "qwen3-vl:8b"
    assert json.loads(userdata.path("settings.json").read_text())["aiModel"] == "qwen3-vl:8b"
    for name, why in (("not-here:1b", "isn't downloaded"), ("fake-embed:1b", "can't answer questions"), ("../etc", "isn't a model")):
        refused = client.put("/api/llm/model", json={"model": name})
        assert refused.status_code == 400 and why in refused.json()["detail"]["message"]
    assert llm.model == "qwen3-vl:8b"

    back = client.put("/api/llm/model", json={"model": None}).json()
    assert back["inUse"] == "qwen3.5:4b" and back["chosen"] is None and llm.model == "qwen3.5:4b"
    assert "aiModel" not in json.loads(userdata.path("settings.json").read_text())


def test_a_model_downloaded_meanwhile_is_picked_up(fake, client):
    status = client.get("/api/llm/status").json()
    assert (status["state"], status["model"]) == ("unavailable", None)  # "not set up": nothing downloaded
    fake.models = {"qwen3.5:4b": (3_320_000_000, VISION)}  # you ran ollama pull
    status = client.get("/api/llm/status").json()
    assert (status["state"], status["model"]) == ("asleep", "qwen3.5:4b")


def test_the_one_time_hint(fake, client):
    assert client.get("/api/llm/status").json()["hintSeen"] is False
    assert client.post("/api/llm/hint-seen").status_code == 204
    assert client.get("/api/llm/status").json()["hintSeen"] is True
    assert preferences.ai_hint_seen()


def test_the_choice_waits_for_a_job_to_finish(fake, monkeypatch):
    fake.models = {"qwen3.5:4b": (3_320_000_000, VISION), "qwen3-vl:8b": (6_140_000_000, VISION)}
    monkeypatch.setattr(llm, "model", "qwen3-vl:8b")
    monkeypatch.setattr(llm, "_active", 1)  # a job is using it
    asyncio.run(setup.choose())
    assert llm.model == "qwen3-vl:8b"
    monkeypatch.setattr(llm, "_active", 0)
    asyncio.run(setup.choose())
    assert llm.model == "qwen3.5:4b"


def test_with_no_model_nothing_is_started(tmp_path):
    marker = tmp_path / "started"
    binary = tmp_path / "ollama"
    binary.write_text(f"#!/bin/sh\ntouch {marker}\n")
    binary.chmod(0o755)

    async def nothing_downloaded():
        pass

    m = OllamaManager(host="127.0.0.1:9", model=None, idle_seconds=1, binary=str(binary), run_dir=tmp_path / "run",
                      choose=nothing_downloaded)

    async def scenario():
        with pytest.raises(LLMUnavailable, match="No local model is set up"):
            async with m.session():
                pass
        assert (await m.status())["state"] == "unavailable"

    asyncio.run(scenario())
    assert not marker.exists()


def test_settings_keep_your_other_choices():
    preferences.update({"countInvestments": True})
    preferences.set_ai_model("qwen3.5:4b")
    preferences.see_ai_hint()
    preferences.set_ai_model(None)
    saved = json.loads(userdata.path("settings.json").read_text())
    assert saved == {"countInvestments": True, "aiHintSeen": True}
