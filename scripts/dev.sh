#!/usr/bin/env bash
# Backend with reload on :8000 and Vite on :5173 (proxies /api). Ctrl+C stops both,
# and the backend's shutdown hook stops Ollama if it started it.
set -euo pipefail
cd "$(dirname "$0")/.."
trap 'kill 0' EXIT
backend/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload --reload-dir backend/app &
(cd web && pnpm dev) &
wait
