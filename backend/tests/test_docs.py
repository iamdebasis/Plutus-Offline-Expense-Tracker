"""The docs stay true to the code: every backend module, API route, data file and web file has its line in
docs/ARCHITECTURE.md; every agent's instruction file points to AGENTS.md (one source for all of them); and no doc links
to a file that isn't there. Whoever adds a module, a route or a data file adds its line to the map."""

import importlib
import pkgutil
import re
from pathlib import Path

from app import userdata

REPO = Path(__file__).resolve().parents[2]
MAP = (REPO / "docs" / "ARCHITECTURE.md").read_text(encoding="utf-8")
DOCS = [REPO / "AGENTS.md", REPO / "README.md", *sorted((REPO / "docs").glob("*.md"))]


def test_every_backend_module_is_on_the_map():
    app = REPO / "backend" / "app"
    modules = sorted(p.relative_to(REPO / "backend").as_posix() for p in app.rglob("*.py")
                     if p.name != "__init__.py" and "seed" not in p.parts)
    assert modules, "no modules found"
    missing = [m for m in modules if f"`{m}`" not in MAP]
    assert not missing, f"add these to docs/ARCHITECTURE.md: {missing}"


def test_every_api_route_is_on_the_map():
    import app.routes

    routes = []
    for info in pkgutil.iter_modules(app.routes.__path__):
        router = getattr(importlib.import_module(f"app.routes.{info.name}"), "router", None)
        for r in getattr(router, "routes", []):
            routes += [f"{method} {r.path}" for method in sorted(r.methods)]
    assert len(routes) > 30
    missing = [r for r in routes if f"`{r}`" not in MAP]
    assert not missing, f"add these routes to docs/ARCHITECTURE.md: {missing}"


def test_every_data_file_is_on_the_map():
    missing = [n for n in [*userdata.FILES, *userdata.FOLDERS] if f"`data/{n}" not in MAP]
    assert not missing, f"add these data files to docs/ARCHITECTURE.md: {missing}"


def test_every_web_file_is_on_the_map():
    src = REPO / "web" / "src"
    files = sorted(p.relative_to(src).as_posix() for p in [*src.rglob("*.ts"), *src.rglob("*.tsx")]
                   if p.name != "vite-env.d.ts")
    assert files, "no web files found"
    missing = [f for f in files if f"`{f}`" not in MAP]
    assert not missing, f"add these web files to docs/ARCHITECTURE.md: {missing}"


def test_every_agent_reads_the_same_instructions():
    agents = REPO / "AGENTS.md"
    assert agents.is_file() and agents.stat().st_size < 32 * 1024  # Codex reads up to 32 KiB by default
    for name in ("CLAUDE.md", "GEMINI.md"):
        assert (REPO / name).read_text(encoding="utf-8").strip().splitlines()[0] == "@AGENTS.md", name
    assert "Core values" in agents.read_text(encoding="utf-8")


def test_doc_links_lead_somewhere():
    broken = []
    for doc in DOCS:
        for target in re.findall(r"\]\(([^)\s]+)\)", doc.read_text(encoding="utf-8")):
            if re.match(r"^(https?:|mailto:|#)", target):
                continue
            path = (doc.parent / target.split("#")[0]).resolve()
            if not path.exists():
                broken.append(f"{doc.relative_to(REPO)} → {target}")
    assert not broken, f"links to files that aren't there: {broken}"
