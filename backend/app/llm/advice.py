"""Which local model suits this Mac for Plutus, and the steps to get it. Plutus never downloads a model or installs
Ollama: it reads what's here, suggests one, and shows the steps; you run them, and it notices by itself.

Everything is read on this Mac and nothing is started: macOS for the chip, memory, free space and version; Ollama's
app or Homebrew's folders for Ollama's version; its models folder for what's downloaded. When Ollama's server is
running, the app asks it instead (app/llm/setup.py). The standard library only, so `make check` can run it before
Plutus's packages are installed:

    python3 backend/app/llm/advice.py
"""

import json
import os
import platform
import plistlib
import re
import shutil
import subprocess
import urllib.request
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path

MIN_MACOS = (14, 0)  # Ollama's app (and its Homebrew cask) needs macOS 14 or later
# The first Ollama that holds a model to the JSON form Plutus asks for while the model's thinking is off
# (github.com/ollama/ollama/pull/15901). An older one lets Qwen 3.5 answer in prose, which Plutus can't use.
MIN_OLLAMA = (0, 32, 7)
DOWNLOAD = "https://ollama.com/download"
# Where Ollama's command can be besides the PATH: Homebrew on Apple silicon and on Intel, and inside the app
BINARIES = ["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama", "/Applications/Ollama.app/Contents/Resources/ollama"]
APPS = [Path("/Applications/Ollama.app"), Path.home() / "Applications" / "Ollama.app"]
CASKROOMS = [Path("/opt/homebrew/Caskroom"), Path("/usr/local/Caskroom")]
BREW = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]


@dataclass(frozen=True)
class Fit:
    """A model that does Plutus's three jobs well: sorting payees and reading statements the rules couldn't prove
    (text), and reading payment screenshots (images). `suits`: the memory (GB) it runs in comfortably beside a browser;
    `runs`: the least it runs in at all, slowing the Mac while it works."""

    name: str
    size_gb: float  # the download, as Ollama's library lists it
    suits: int
    runs: int
    why: str


# What Plutus suggests, the most accurate first: the first that suits this Mac's memory.
SUGGESTED = [
    Fit("qwen3.5:9b", 6.6, 24, 16, "the most accurate, for 24 GB or more"),
    Fit("qwen3.5:4b", 3.3, 16, 8, "the best balance of speed and accuracy"),
    Fit("qwen3.5:2b", 2.7, 8, 8, "light enough for 8 GB, a little less accurate"),
]
# Also good for Plutus when they're already downloaded: no need to fetch another.
ALSO_FINE = [
    Fit("qwen3-vl:8b-instruct", 6.1, 24, 16, "reads documents very well; heavier"),
    Fit("qwen3-vl:8b", 6.1, 24, 16, "works (its thinking edition); heavier and slower"),
    Fit("qwen3-vl:4b-instruct", 3.3, 16, 8, "reads documents well"),
    Fit("qwen3-vl:2b-instruct", 1.9, 8, 8, "light; less accurate"),
]
KNOWN = {f.name: f for f in SUGGESTED + ALSO_FINE}
# Among the models already downloaded, Plutus uses the most capable that suits this Mac
PREFERENCE = ["qwen3.5:9b", "qwen3-vl:8b-instruct", "qwen3-vl:8b", "qwen3.5:4b", "qwen3-vl:4b-instruct", "qwen3.5:2b",
              "qwen3-vl:2b-instruct"]


@dataclass
class Mac:
    chip: str  # "Apple M2", or an Intel processor's name
    apple_silicon: bool
    memory_gb: float
    free_gb: float  # free space where Ollama keeps its models
    macos: str  # "15.1"


@dataclass
class Downloaded:
    """A model Ollama has downloaded."""

    name: str
    size_gb: float
    vision: bool | None = None  # reads images (screenshots); None: can't tell without Ollama running
    chat: bool | None = None  # answers questions (an embedding model doesn't); None: can't tell


@dataclass
class Ollama:
    installed: bool
    app: bool  # the Ollama app, the llama in the menu bar
    homebrew: str | None  # "cask" or "formula" when Homebrew installed it
    version: str | None
    running: bool
    models: list[Downloaded] | None  # None: can't tell (no models folder, server not running)


@dataclass
class Step:
    text: str
    command: str | None = None  # for Terminal, with a copy button
    link: str | None = None
    optional: bool = False


@dataclass
class Advice:
    headline: str  # one line: what the local AI is doing on this Mac, or why it isn't
    ready: bool  # Plutus can use a model now
    in_use: str | None
    chosen: str | None
    override: str | None  # ET_OLLAMA_MODEL
    mac: Mac
    ollama: Ollama
    suggestion: Fit | None
    models: list[dict] = field(default_factory=list)  # each downloaded model, how it fits this Mac, a note
    notes: list[str] = field(default_factory=list)
    steps: list[Step] = field(default_factory=list)


# ---- this Mac -------------------------------------------------------------------------------------------------------


def _sysctl(name: str) -> str:
    try:
        return subprocess.run(["/usr/sbin/sysctl", "-n", name], capture_output=True, text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


@cache
def _hardware() -> tuple[str, bool, float, str]:
    chip = _sysctl("machdep.cpu.brand_string") or platform.machine()
    memory = int(_sysctl("hw.memsize") or 0) / 2**30  # 16 GB Macs have 16 GiB
    return chip, _sysctl("hw.optional.arm64") == "1", round(memory, 1), platform.mac_ver()[0]


def models_folder() -> Path:
    return Path(os.environ.get("OLLAMA_MODELS") or Path.home() / ".ollama" / "models")


def free_space(folder: Path) -> float:
    for p in [folder, *folder.parents]:
        if p.exists():
            return round(shutil.disk_usage(p).free / 1e9, 1)  # GB as Finder counts them, like model sizes
    return 0.0


def this_mac() -> Mac:
    chip, apple_silicon, memory, macos = _hardware()
    return Mac(chip, apple_silicon, memory, free_space(models_folder()), macos)


# ---- Ollama, from its files -----------------------------------------------------------------------------------------


def version_tuple(v: str | None) -> tuple[int, ...] | None:
    m = re.match(r"v?(\d+(?:\.\d+)*)", v or "")
    return tuple(int(x) for x in m[1].split(".")) if m else None


def _app_version(app: Path) -> str | None:
    try:
        with (app / "Contents" / "Info.plist").open("rb") as f:
            v = plistlib.load(f).get("CFBundleShortVersionString")
    except (OSError, plistlib.InvalidFileException, ValueError):
        return None
    return v if isinstance(v, str) and version_tuple(v) else None


def find_ollama(binaries: list[str] = BINARIES, apps: list[Path] = APPS, caskrooms: list[Path] = CASKROOMS,
                folder: Path | None = None) -> Ollama:
    """Whether Ollama is installed, how, which version and what it has downloaded, from its files alone."""
    binary = next((b for b in [shutil.which("ollama"), *binaries] if b and Path(b).exists()), None)
    app = next((a for a in apps if a.exists()), None)
    real = str(Path(binary).resolve()) if binary else ""
    formula = re.search(r"/Cellar/ollama/(\d+(?:\.\d+)+)/", real)
    cask = any((room / token).exists() for room in caskrooms for token in ("ollama-app", "ollama"))
    return Ollama(
        installed=bool(binary or app),
        app=app is not None,
        homebrew="formula" if formula else "cask" if cask and (app or binary) else None,
        version=formula[1] if formula else _app_version(app) if app else None,
        running=False,
        models=models_on_disk(folder),
    )


def models_on_disk(folder: Path | None = None) -> list[Downloaded] | None:
    """The models in Ollama's folder (~/.ollama/models, or OLLAMA_MODELS): one manifest per model, host/owner/name/tag."""
    root = (folder or models_folder()) / "manifests"
    if not root.is_dir():
        return None
    found = []
    for manifest in root.glob("*/*/*/*"):
        if not manifest.is_file():
            continue
        host, owner, model, tag = manifest.relative_to(root).parts
        try:
            size = sum(layer.get("size", 0) for layer in json.loads(manifest.read_text())["layers"])
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            continue
        if host == "registry.ollama.ai":
            name = f"{model}:{tag}" if owner == "library" else f"{owner}/{model}:{tag}"
        else:
            name = f"{host}/{owner}/{model}:{tag}"
        found.append(Downloaded(name, round(size / 1e9, 1)))
    return sorted(found, key=lambda d: d.name)


def server_version(host: str = "127.0.0.1:11434") -> str | None:
    """The running server's version, for `make check`; None if none answers. This Mac only, never through a proxy."""
    if host.rsplit(":", 1)[0] not in ("127.0.0.1", "localhost"):
        return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"http://{host}/api/version", timeout=1) as resp:
            return json.load(resp).get("version")
    except (OSError, ValueError):
        return None


def has_brew(paths: list[str] = BREW) -> bool:
    return bool(shutil.which("brew")) or any(Path(p).exists() for p in paths)


# ---- what to suggest ------------------------------------------------------------------------------------------------


def fit(memory_gb: float, name: str, size_gb: float) -> str:
    """"suits", "heavy" or "too_big" for this much memory. A model Plutus doesn't know is judged by its size."""
    known = KNOWN.get(name)
    suits, runs = (known.suits, known.runs) if known else (size_gb * 3.5, size_gb * 2.4)
    memory = memory_gb + 0.5  # a "16 GB" Mac may report a little under
    return "suits" if memory >= suits else "heavy" if memory >= runs else "too_big"


def suggestion(mac: Mac) -> Fit | None:
    """The model for this Mac, or None where a local model would only slow it down (Intel, under 8 GB)."""
    if not mac.apple_silicon or mac.memory_gb + 0.5 < 8:
        return None
    return next(f for f in SUGGESTED if mac.memory_gb + 0.5 >= f.suits)


def model_in_use(memory_gb: float, models: list[Downloaded] | None, chosen: str | None = None,
                 override: str | None = None) -> str | None:
    """ET_OLLAMA_MODEL when set; else your choice, while it's downloaded; else the most capable downloaded model that
    suits this Mac (or, failing that, one that runs on it); else your choice anyway, so the page can say it's gone."""
    if override:
        return override
    if models is None:  # can't tell what's downloaded
        return chosen
    usable = {m.name for m in models if m.chat is not False}
    if chosen and chosen in usable:
        return chosen
    for wanted in ("suits", "heavy"):
        for name in PREFERENCE:
            if name in usable and fit(memory_gb, name, 0) == wanted:
                return name
    return chosen if chosen not in {m.name for m in models} else None  # a choice that can't answer is never used


def _v(t: tuple[int, ...]) -> str:
    return ".".join(map(str, t))


def advise(mac: Mac, ollama: Ollama, chosen: str | None = None, override: str | None = None,
           brew: bool | None = None) -> Advice:
    brew = has_brew() if brew is None else brew
    pick = suggestion(mac)
    listed = {m.name: m for m in ollama.models or []}
    in_use = model_in_use(mac.memory_gb, ollama.models, chosen, override)
    downloaded = ollama.models is None or in_use in listed
    version = version_tuple(ollama.version)
    outdated = version is not None and version < MIN_OLLAMA
    macos = version_tuple(mac.macos)
    macos_old = macos is not None and macos < MIN_MACOS
    ready = ollama.installed and not outdated and in_use is not None and downloaded
    in_use_fit = fit(mac.memory_gb, in_use, listed[in_use].size_gb) if in_use in listed else None

    models = []
    for m in ollama.models or []:
        note = KNOWN[m.name].why if m.name in KNOWN else "not tested with Plutus"
        if m.chat is False:
            note = "can't answer questions (it only compares texts)"
        elif m.vision is False:
            note += "; can't read screenshots"
        models.append({"name": m.name, "sizeGb": m.size_gb, "fit": fit(mac.memory_gb, m.name, m.size_gb),
                       "known": m.name in KNOWN, "vision": m.vision, "usable": m.chat is not False, "note": note,
                       "inUse": m.name == in_use})

    notes: list[str] = []
    if not mac.apple_silicon:
        notes.append("This Mac has an Intel processor: a local model would run on the processor alone, slowly. "
                     "Plutus works fully without one.")
    elif pick is None:
        notes.append(f"With {mac.memory_gb:g} GB of memory, a local model would slow this Mac down too much. "
                     "Plutus works fully without one.")
    if macos_old and not ollama.installed:
        notes.append(f"Ollama needs macOS 14 or later, and this Mac has macOS {mac.macos}. Plutus works fully without it.")
    if override:
        notes.append(f"ET_OLLAMA_MODEL is set, so Plutus uses {override} whatever is chosen here.")
    elif chosen and ollama.models is not None and chosen not in listed:
        notes.append(f"You chose {chosen}, which isn't downloaded any more"
                     + (f", so Plutus uses {in_use}." if in_use and in_use != chosen else "."))
    if ollama.installed and ollama.version is None:
        notes.append(f"Plutus couldn't read Ollama's version: it needs {_v(MIN_OLLAMA)} or newer.")

    steps: list[Step] = []
    possible = pick is not None and not (macos_old and not ollama.installed)
    if not ollama.installed and possible:
        steps.append(Step("Install Ollama, the free app that runs models on this Mac (macOS 14 or later): download it "
                          "from ollama.com" + (", or install it with Homebrew" if brew else ""),
                          command="brew install --cask ollama-app" if brew else None, link=DOWNLOAD))
    elif outdated:
        steps.append(Step(f"Update Ollama to {_v(MIN_OLLAMA)} or newer (this Mac has {ollama.version}): Plutus's "
                          "questions need it. Get the latest from ollama.com",
                          command={"cask": "brew upgrade --cask ollama-app", "formula": "brew upgrade ollama"}.get(ollama.homebrew or ""),
                          link=DOWNLOAD))
    if possible and pick.name not in listed and (not ready or in_use_fit != "suits" or in_use not in KNOWN):
        optional = ready  # something works already; this one suits the Mac better
        if ollama.installed and ollama.homebrew == "formula" and not ollama.app and not ollama.running and not optional:
            steps.append(Step("Start Ollama in the background", command="brew services start ollama"))
        why = ("For a lighter, faster model on this Mac, download" if in_use_fit in ("heavy", "too_big")
               else "For a model tested with Plutus, download") if optional else "Download"
        steps.append(Step(f"{why} {pick.name} ({pick.size_gb:g} GB). In Terminal:", command=f"ollama pull {pick.name}",
                          optional=optional))
        if mac.free_gb < pick.size_gb + 1:
            notes.append(f"Free up some space first: {pick.name} needs {pick.size_gb:g} GB, and this Mac has "
                         f"{mac.free_gb:g} GB free.")
    if steps and not all(s.optional for s in steps):
        steps.append(Step("That's all: Plutus notices it by itself, no restart. You can quit Ollama afterwards; "
                          "Plutus starts it when a job needs it."))

    if not ollama.installed:
        headline = "Not set up: Ollama isn't installed"
    elif outdated:
        headline = f"Not set up: Ollama {ollama.version} is too old for Plutus"
    elif in_use is None:
        headline = "Not set up: Ollama is installed, but no suitable model is downloaded"
    elif not downloaded:
        headline = f"Not set up: {in_use} isn't downloaded"
    else:
        headline = f"Using {in_use}" + {"heavy": ", heavy for this Mac", "too_big": ", too big for this Mac"}.get(in_use_fit or "", "")
        if in_use not in KNOWN and in_use in listed:
            headline += " (not tested with Plutus)"
    return Advice(headline, ready, in_use, chosen, override, mac, ollama, pick, models, notes, steps)


# ---- for the page and for `make check` ------------------------------------------------------------------------------


def as_json(a: Advice) -> dict:
    """The Local AI panel's data (camelCase, like the rest of the API)."""
    return {
        "headline": a.headline,
        "ready": a.ready,
        "inUse": a.in_use,
        "chosen": a.chosen,
        "override": a.override,
        "mac": {"chip": a.mac.chip, "appleSilicon": a.mac.apple_silicon, "memoryGb": a.mac.memory_gb,
                "freeGb": a.mac.free_gb, "macos": a.mac.macos},
        "ollama": {"installed": a.ollama.installed, "app": a.ollama.app, "homebrew": a.ollama.homebrew,
                   "version": a.ollama.version, "minVersion": _v(MIN_OLLAMA), "running": a.ollama.running,
                   "versionOk": None if version_tuple(a.ollama.version) is None else version_tuple(a.ollama.version) >= MIN_OLLAMA},
        "suggestion": None if a.suggestion is None else {
            "model": a.suggestion.name, "sizeGb": a.suggestion.size_gb, "why": a.suggestion.why,
            "downloaded": any(m["name"] == a.suggestion.name for m in a.models)},
        "models": a.models,
        "notes": a.notes,
        "steps": [{"text": s.text, "command": s.command, "link": s.link, "optional": s.optional} for s in a.steps],
    }


def as_text(a: Advice) -> str:
    """For `make check`, in its columns (its printf pads the 3-byte ✓ to no width at all)."""
    lines = [f"  {'✓' if a.ready else '–'} {'Local AI (optional)':<40} {a.headline}"]
    if a.suggestion and not (a.ready and any(m["inUse"] and m["fit"] == "suits" and m["known"] for m in a.models)):
        lines.append(f"      For this Mac ({a.mac.memory_gb:g} GB): {a.suggestion.name} ({a.suggestion.size_gb:g} GB), "
                     f"{a.suggestion.why}")
    for n, s in enumerate(a.steps, 1):
        lines.append(f"      {'' if s.optional else f'{n}. '}{s.text}" + (f": {s.link}" if s.link and not s.command else ""))
        if s.command:
            lines.append(f"      {'' if s.optional else '   '}  {s.command}" + (f"    (or {s.link})" if s.link else ""))
    lines += [f"      {note}" for note in a.notes]
    if not a.ready:
        lines.append('      Without it, payees no rule knows wait for you in "Needs your eyes"; everything else works.')
    return "\n".join(lines)


def main() -> None:
    ollama = find_ollama()
    if version := server_version(os.environ.get("ET_OLLAMA_HOST", "127.0.0.1:11434")):
        ollama.running, ollama.version = True, version
    print(as_text(advise(this_mac(), ollama, override=os.environ.get("ET_OLLAMA_MODEL") or None)))


if __name__ == "__main__":
    main()
