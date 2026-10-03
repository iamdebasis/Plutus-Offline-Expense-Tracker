#!/usr/bin/env bash
# What Plutus needs on this Mac, and how to get what's missing. `make setup` runs it first.
#   scripts/check.sh            the report; exits 1 if something required is missing
#   scripts/check.sh --python   only the path of a Python 3.12+ (macOS's own python3 is older), or nothing
set -uo pipefail

find_python() {
  for c in python3.14 python3.13 python3.12 python3; do
    p=$(command -v "$c" 2>/dev/null) || continue
    "$p" -c 'import sys; sys.exit(sys.version_info < (3, 12))' 2>/dev/null && { echo "$p"; return; }
  done
}

if [ "${1:-}" = "--python" ]; then
  find_python
  exit 0
fi

missing=0
row() { printf '  %-3s %-40s %s\n' "$1" "$2" "${3:-}"; }

echo "Checking what Plutus needs on this Mac"
if [ "$(uname)" != "Darwin" ]; then
  echo "  Plutus runs on macOS: it reads screenshots and scanned PDFs with Apple's on-device OCR."
  exit 1
fi
row "✓" "macOS $(sw_vers -productVersion)"

py=$(find_python)
if [ -n "$py" ]; then
  row "✓" "Python $("$py" -c 'import platform; print(platform.python_version())')" "$py"
else
  row "✗" "Python 3.12 or newer" "brew install python@3.13   (macOS's own python3 is too old)"
  missing=1
fi

if command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' 2>/dev/null; then
  row "✓" "Node $(node --version | tr -d v)"
else
  row "✗" "Node 22.18+ (builds and tests the UI)" "brew install node"
  missing=1
fi

if command -v pnpm >/dev/null 2>&1; then
  row "✓" "pnpm $(pnpm --version)"
else
  row "✗" "pnpm (installs the UI's packages)" "brew install pnpm   (or: npm install -g pnpm)"
  missing=1
fi

# Optional: the local AI. Plutus works without it; see "Local AI" in the README.
ollama=$(command -v ollama 2>/dev/null || ls /Applications/Ollama.app/Contents/Resources/ollama 2>/dev/null || true)
if [ -n "$ollama" ]; then
  row "✓" "Ollama (optional local AI)" "found"
else
  row "–" "Ollama (optional local AI)" "not installed: fine. Without it, new payees wait for you in \"Needs your eyes\"."
fi

if [ "$missing" = 1 ]; then
  echo
  echo "Install what's marked ✗, then run make setup again."
  command -v brew >/dev/null 2>&1 || echo "No Homebrew? Get it from https://brew.sh, or use the installers on python.org and nodejs.org."
  exit 1
fi
