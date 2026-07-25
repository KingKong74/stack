#!/usr/bin/env bash
# Creates a throwaway git repo with a merge conflict for testing run_merge_advisor.sh.
# Prints the repo path as the last line of stdout so callers can capture it:
#   REPO=$(scripts/create_conflict_repo.sh | tail -1)
set -euo pipefail

d=$(mktemp -d "${TMPDIR:-/tmp}/conflict-repo.XXXXXX")

git -C "$d" init -q
# Set explicit default branch name regardless of system git config
git -C "$d" symbolic-ref HEAD refs/heads/main
git -C "$d" config user.name "Stack Test"
git -C "$d" config user.email "stack@local"
git -C "$d" config commit.gpgsign false

# Base commit — server config that both branches will modify
cat > "$d/config.txt" <<'EOF'
[server]
port = 8080
host = localhost
timeout = 30
debug = false
EOF
git -C "$d" add config.txt
git -C "$d" commit -m "Initial server config" -q

# feature/branch-a: staging config — changes port, host AND timeout (3 lines modified)
git -C "$d" checkout -b feature/branch-a -q
cat > "$d/config.txt" <<'EOF'
[server]
port = 9090
host = 0.0.0.0
timeout = 60
debug = false
EOF
git -C "$d" add config.txt
git -C "$d" commit -m "feat(server): staging config (port 9090, open host, longer timeout)" -q

# feature/branch-b: dev port only — changes port only (1 line, same region = conflict)
git -C "$d" checkout -b feature/branch-b main -q
cat > "$d/config.txt" <<'EOF'
[server]
port = 3000
host = localhost
timeout = 30
debug = false
EOF
git -C "$d" add config.txt
git -C "$d" commit -m "feat(server): dev port 3000" -q

git -C "$d" checkout main -q

printf '%s\n' "$d"
