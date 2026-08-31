#!/usr/bin/env bash
# run-palette-audit.sh — entry point for the palette audit (#430).
#
# Same shape and the same reasons as run-ui-smoke.sh: scripts/playwright is its
# own package, and chromium on this host needs a rootless private library
# prefix that playwright's own `install-deps` cannot provision without root.
# This wrapper puts that prefix on the path and hands off.
#
# Usage:
#   scripts/run-palette-audit.sh                      # localhost:8787
#   scripts/run-palette-audit.sh --url http://…       # elsewhere
#   scripts/run-palette-audit.sh --screens overview,quality
#   scripts/run-palette-audit.sh --json
#
# Exit code is palette-audit.mjs's: 0 only on a clean pass over screens it
# actually reached.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PW_DIR="$REPO_ROOT/scripts/playwright"

if [ ! -d "$PW_DIR/node_modules" ]; then
  echo "[palette-audit] scripts/playwright/node_modules missing — installing dependencies…"
  (cd "$PW_DIR" && npm install --no-audit --no-fund --silent)
fi

CHROMIUM_DIR="$(cd "$PW_DIR" && npx --no-install playwright install --dry-run chromium 2>/dev/null \
  | grep -m1 'Install location:' | awk '{print $NF}')"
CHROME_BIN="$CHROMIUM_DIR/chrome-linux64/chrome"
if [ "$(uname -s)" = "Linux" ] && [ -x "$CHROME_BIN" ] && ldd "$CHROME_BIN" 2>&1 | grep -q "not found"; then
  "$PW_DIR/setup-browser-deps.sh" >/dev/null
  eval "$("$PW_DIR/setup-browser-deps.sh" --print-env)"
fi

exec node "$PW_DIR/palette-audit.mjs" "$@"
