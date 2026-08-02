#!/usr/bin/env bash
# setup-browser-deps.sh — a rootless, private library prefix for chromium (#291).
#
# WHY THIS EXISTS: playwright's own `npx playwright install-deps` needs root
# (it shells out to `apt install`), and an unattended overnight session has no
# password to give it. A harness that cannot launch a browser is a harness
# that reports "nothing found" when it did not look — exactly the failure
# mode #291 exists to prevent (CLAUDE.md, "Fail-safe direction": zero findings
# because it could not look is the same lie as a NULL verdict rendering
# green). `apt-get download` and `dpkg-deb -x` need no root: they fetch and
# extract .deb files into an ordinary directory. This script builds chromium's
# missing shared libraries that way, into a PRIVATE prefix under the user's
# home — nothing is installed system-wide and nothing outside that prefix is
# ever touched or modified.
#
# Usage:
#   scripts/playwright/setup-browser-deps.sh              # provision (idempotent)
#   scripts/playwright/setup-browser-deps.sh --force       # re-provision from scratch
#   scripts/playwright/setup-browser-deps.sh --print-env    # print the two export lines and exit
set -euo pipefail

PREFIX="${STACK_UI_SMOKE_DEPS:-$HOME/.stack/ui-smoke-deps}"

# The package set this script provisions. Discovered iteratively against the
# `ldd` output for chromium revision 1234 on Debian 13 (trixie) amd64 — add to
# this list (and re-run with --force) if a future chromium revision reports a
# soname not covered here.
PACKAGES=(
  libnspr4
  libnss3
  libasound2t64
  libatk1.0-0t64
  libatk-bridge2.0-0t64
  libatspi2.0-0t64
  libdrm2
  libgbm1
  libxcomposite1
  libxdamage1
  libxfixes3
  libxi6
  libxkbcommon0
  libxrandr2
  libxrender1
  fonts-dejavu-core
  libcairo2
  libpango-1.0-0
  libpangocairo-1.0-0
  libpangoft2-1.0-0
  # transitive deps of cairo/pango that ldd only reveals once cairo/pango
  # themselves resolve — discovered iteratively against the launch probe.
  libfontconfig1
  libxcb-render0
  libxcb-shm0
  libpixman-1-0
  libfribidi0
  libthai0
  libharfbuzz0b
  libdatrie1
  libgraphite2-3
)

FORCE=0
PRINT_ENV=0
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    --print-env) PRINT_ENV=1 ;;
    *) echo "setup-browser-deps.sh: unknown argument: $a" >&2; exit 1 ;;
  esac
done

DEBS_DIR="$PREFIX/debs"
LIBS_DIR="$PREFIX/libs"
FCCACHE_DIR="$PREFIX/fccache"
FONTS_CONF="$PREFIX/fonts.conf"
MARKER="$PREFIX/.provisioned"
KEY_LIB="$LIBS_DIR/usr/lib/x86_64-linux-gnu/libnspr4.so"

print_env_lines() {
  echo "export LD_LIBRARY_PATH=\"$LIBS_DIR/usr/lib/x86_64-linux-gnu:$LIBS_DIR/usr/lib/x86_64-linux-gnu/gbm:\${LD_LIBRARY_PATH:-}\""
  echo "export FONTCONFIG_FILE=\"$FONTS_CONF\""
}

package_list_matches() {
  [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "${PACKAGES[*]}" ]
}

if [ "$PRINT_ENV" -eq 1 ]; then
  print_env_lines
  exit 0
fi

if [ "$FORCE" -ne 1 ] && package_list_matches && [ -f "$KEY_LIB" ]; then
  echo "already provisioned — ${#PACKAGES[@]} packages at $PREFIX"
  exit 0
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "setup-browser-deps.sh: apt-get is not available on this host — cannot fetch .deb files." >&2
  echo "Alternatives: run 'sudo npx playwright install-deps' on this host, or run the harness" >&2
  echo "inside 'mcr.microsoft.com/playwright:v1.62.1-noble' with --network host." >&2
  exit 1
fi
if ! command -v dpkg-deb >/dev/null 2>&1; then
  echo "setup-browser-deps.sh: dpkg-deb is not available on this host — cannot extract .deb files." >&2
  echo "Alternatives: run 'sudo npx playwright install-deps' on this host, or run the harness" >&2
  echo "inside 'mcr.microsoft.com/playwright:v1.62.1-noble' with --network host." >&2
  exit 1
fi

echo "[setup-browser-deps] provisioning a private library prefix at $PREFIX …"
rm -rf "$DEBS_DIR" "$LIBS_DIR"
mkdir -p "$DEBS_DIR" "$LIBS_DIR" "$FCCACHE_DIR"

FAILED_PACKAGES=()
for pkg in "${PACKAGES[@]}"; do
  echo "[setup-browser-deps] downloading $pkg …"
  if ! (cd "$DEBS_DIR" && apt-get download "$pkg" >/dev/null 2>"$DEBS_DIR/.err-$pkg"); then
    echo "[setup-browser-deps] FAILED to download: $pkg" >&2
    cat "$DEBS_DIR/.err-$pkg" >&2 || true
    FAILED_PACKAGES+=("$pkg")
  fi
  rm -f "$DEBS_DIR/.err-$pkg"
done

if [ ! -n "$(ls -A "$DEBS_DIR"/*.deb 2>/dev/null)" ]; then
  echo "setup-browser-deps.sh: no .deb files were downloaded at all — apt-get could not reach a" >&2
  echo "mirror, or every package name failed to resolve. Cannot provision." >&2
  echo "Alternatives: run 'sudo npx playwright install-deps' on this host, or run the harness" >&2
  echo "inside 'mcr.microsoft.com/playwright:v1.62.1-noble' with --network host." >&2
  exit 1
fi

for deb in "$DEBS_DIR"/*.deb; do
  echo "[setup-browser-deps] extracting $(basename "$deb") …"
  dpkg-deb -x "$deb" "$LIBS_DIR"
done

if [ ${#FAILED_PACKAGES[@]} -gt 0 ]; then
  echo "[setup-browser-deps] package names that did not resolve: ${FAILED_PACKAGES[*]}" >&2
  echo "[setup-browser-deps] continuing with the rest — the launch probe is the judge of whether" >&2
  echo "[setup-browser-deps] the remaining set is sufficient." >&2
fi

echo "[setup-browser-deps] generating fontconfig ($FONTS_CONF) …"
cat > "$FONTS_CONF" <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
<dir>$LIBS_DIR/usr/share/fonts</dir>
<cachedir>$FCCACHE_DIR</cachedir>
<match target="pattern"><test qual="any" name="family"><string>sans-serif</string></test><edit name="family" mode="prepend" binding="same"><string>DejaVu Sans</string></edit></match>
</fontconfig>
EOF

if [ ! -f "$KEY_LIB" ]; then
  echo "setup-browser-deps.sh: extraction finished but the key library ($KEY_LIB) is still" >&2
  echo "missing — the libnspr4 package likely failed to download or extract. Not marking" >&2
  echo "this prefix as provisioned." >&2
  echo "Alternatives: run 'sudo npx playwright install-deps' on this host, or run the harness" >&2
  echo "inside 'mcr.microsoft.com/playwright:v1.62.1-noble' with --network host." >&2
  exit 1
fi

# Write the marker LAST, only once every extraction succeeded — a half-built
# prefix must never look provisioned to the idempotence check above.
printf '%s' "${PACKAGES[*]}" > "$MARKER"

echo "[setup-browser-deps] provisioned ${#PACKAGES[@]} packages at $PREFIX"
if [ ${#FAILED_PACKAGES[@]} -gt 0 ]; then
  echo "[setup-browser-deps] (${#FAILED_PACKAGES[@]} package name(s) did not resolve and were skipped: ${FAILED_PACKAGES[*]})"
fi
print_env_lines
