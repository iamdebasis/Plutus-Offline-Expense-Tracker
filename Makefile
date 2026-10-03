PY := backend/.venv/bin/python

.DEFAULT_GOAL := help
.PHONY: help check setup ready dev start demo screenshots build test llm-check redact inspect inspect-takeout

help:             ## this list
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/^([a-z-]+):[^#]*## /  make \1\t/' | expand -t 24

check:            ## what Plutus needs on this Mac, and how to get what's missing
	@scripts/check.sh

setup:            ## once: checks your Mac, then installs the Python and web packages
	@scripts/check.sh
	@PY=$$(scripts/check.sh --python); echo "Python environment: backend/.venv ($$PY)"; "$$PY" -m venv backend/.venv
	$(PY) -m pip install -q --upgrade pip
	$(PY) -m pip install -q -e 'backend[dev]'
	cd web && pnpm install --frozen-lockfile
	@if git rev-parse --git-dir >/dev/null 2>&1; then git config core.hooksPath scripts/git-hooks; echo "Commit guard on: your data and statements can't be committed"; fi
	@echo; echo "Ready. Run: make start   then open http://127.0.0.1:8000"

ready:
	@[ -x $(PY) ] && [ -d web/node_modules ] || { echo "Run make setup first (once)."; exit 1; }

dev: ready        ## backend :8000 + Vite :5173 with hot reload
	./scripts/dev.sh

build: ready
	cd web && pnpm build

start: build      ## build the UI and serve everything at http://127.0.0.1:8000
	$(PY) -m app.main

demo: build       ## a year of made-up spending, in its own folder (.demo/, never data/), at http://127.0.0.1:8001
	ET_DATA_DIR=$(CURDIR)/.demo/data ET_PORT=8001 ET_OLLAMA_HOST=127.0.0.1:9 $(PY) -m app.tools.demo

screenshots: build  ## the README's pictures (docs/screenshots/), taken from the demo with Chrome, Brave or Edge
	ET_DATA_DIR=$(CURDIR)/.demo/data ET_PORT=8001 ET_OLLAMA_HOST=127.0.0.1:9 $(PY) -m app.tools.demo --screenshots

test: ready       ## backend tests (no network allowed) + the dashboard's money checks + TypeScript check
	cd backend && .venv/bin/python -m pytest -q
	cd web && pnpm test
	cd web && pnpm typecheck

llm-check: ready  ## optional local AI: start Ollama, ask a few test questions, stop it again
	$(PY) -m app.llm --prompt

redact: ready     ## FILE="~/Downloads/statement.pdf"  → data/redacted/
	$(PY) -m app.tools.redact "$(FILE)"

inspect: ready    ## FILE="~/Downloads/statement.pdf"  → what the detector sees, no content
	@$(PY) -m app.tools.inspect "$(FILE)"

inspect-takeout: ready  ## FILE="~/Downloads/takeout.zip"  → a Google Pay export's structure, masked
	@$(PY) -m app.tools.inspect_takeout "$(FILE)"
