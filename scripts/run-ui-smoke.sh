#!/usr/bin/env bash
# run-ui-smoke.sh — the one-command entry point for the UI smoke harness (#291).
#
# scripts/playwright is its own package (its own package.json, pinned to
# playwright 1.62.1 so the chromium build it wants — revision 1234 — is
# already cached on this host and the install downloads no browser). This
# wrapper installs that package's dependencies on first run, makes sure the
# chromium build is actually present, then hands off to smoke.mjs.
#
# Usage:
#   scripts/run-ui-smoke.sh                                   # smoke stack.<yourhost>, from ~/.stack/env
#   scripts/run-ui-smoke.sh --url http://localhost:5173        # against a local `npm run dev`
#   scripts/run-ui-smoke.sh --screens dashboard --viewport desktop
#   scripts/run-ui-smoke.sh --help
#
# Every argument passes straight through to smoke.mjs; the exit code is
# smoke.mjs's exit code (0 = clean pass, 1 = findings or a hard failure).
set -euo pipefail

# Resolve the repo root from this script's own location, not the caller's cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PW_DIR="$REPO_ROOT/scripts/playwright"

if [ ! -d "$PW_DIR/node_modules" ]; then
  echo "[run-ui-smoke] scripts/playwright/node_modules missing — installing dependencies…"
  (cd "$PW_DIR" && npm install --no-audit --no-fund --silent)
else
  echo "[run-ui-smoke] dependencies already installed."
fi

# playwright 1.62.1 wants a specific chromium build (revision 1234 on this
# host). `--dry-run` prints where that build WOULD install without touching
# the network or the disk, which is how we tell "missing" from "cached"
# without ever calling the real installer unless we have to.
CHROMIUM_DIR="$(cd "$PW_DIR" && npx --no-install playwright install --dry-run chromium 2>/dev/null \
  | grep -m1 'Install location:' | awk '{print $NF}')"

if [ -n "$CHROMIUM_DIR" ] && [ -d "$CHROMIUM_DIR" ] && [ -n "$(ls -A "$CHROMIUM_DIR" 2>/dev/null)" ]; then
  echo "[run-ui-smoke] chromium already cached at $CHROMIUM_DIR — skipping install."
else
  echo "[run-ui-smoke] chromium not found — installing (this host normally has it cached already)…"
  (cd "$PW_DIR" && npx --yes playwright install chromium)
fi

# Chromium needs a handful of shared libraries this host may not have
# system-wide, and playwright's own `install-deps` needs root, which an
# unattended session does not have. Probe first — most hosts already have
# them — and only provision the rootless private prefix (#291,
# scripts/playwright/setup-browser-deps.sh) when something is actually
# missing.
CHROME_BIN="$CHROMIUM_DIR/chrome-linux64/chrome"
if [ "$(uname -s)" != "Linux" ]; then
  echo "[run-ui-smoke] not Linux — skipping the shared-library probe."
elif [ ! -x "$CHROME_BIN" ]; then
  echo "[run-ui-smoke] chromium binary not found at $CHROME_BIN — skipping the shared-library probe."
elif ldd "$CHROME_BIN" 2>&1 | grep -q "not found"; then
  echo "[run-ui-smoke] chromium is missing shared libraries — provisioning a rootless private prefix…"
  "$SCRIPT_DIR/playwright/setup-browser-deps.sh"
  eval "$("$SCRIPT_DIR/playwright/setup-browser-deps.sh" --print-env)"
  echo "[run-ui-smoke] using the private library prefix at ${STACK_UI_SMOKE_DEPS:-$HOME/.stack/ui-smoke-deps}."
else
  echo "[run-ui-smoke] chromium can already resolve all its shared libraries — no provisioning needed."
fi

exec node "$REPO_ROOT/scripts/playwright/smoke.mjs" "$@"
