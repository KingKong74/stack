#!/usr/bin/env bash
# Read-only pre-merge conflict advisor.
# Reports: conflicts identified, reason, suggested winning side, proposed resolution.
# Never commits, merges, or modifies the working tree or index.
set -euo pipefail

usage() {
  cat >&2 <<EOF
Usage: $(basename "$0") <branch-a> <branch-b> [--repo <path>]

Options:
  --repo <path>   Repository path (default: current directory)

Outputs a conflict analysis report to stdout. Never modifies the repository.

Example:
  REPO=\$(scripts/create_conflict_repo.sh | tail -1)
  scripts/run_merge_advisor.sh feature/branch-a feature/branch-b --repo "\$REPO"
EOF
  exit 1
}

REPO="."
BRANCH_A=""
BRANCH_B=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      [[ $# -lt 2 ]] && usage
      REPO="$2"
      shift 2
      ;;
    -h|--help) usage ;;
    -*)
      printf 'Unknown option: %s\n' "$1" >&2
      usage
      ;;
    *)
      if   [[ -z "$BRANCH_A" ]]; then BRANCH_A="$1"
      elif [[ -z "$BRANCH_B" ]]; then BRANCH_B="$1"
      else usage
      fi
      shift
      ;;
  esac
done

[[ -z "$BRANCH_A" || -z "$BRANCH_B" ]] && usage

# Gate: git >= 2.38 required for merge-tree --write-tree
_git_ver=$(git version 2>/dev/null | awk '{print $3}')
_git_maj=$(printf '%s' "$_git_ver" | cut -d. -f1)
_git_min=$(printf '%s' "$_git_ver" | cut -d. -f2)
if [[ "$_git_maj" -lt 2 ]] || { [[ "$_git_maj" -eq 2 ]] && [[ "$_git_min" -lt 38 ]]; }; then
  printf 'Error: git >= 2.38 required for merge-tree --write-tree (found git %s)\n' "$_git_ver" >&2
  exit 1
fi

# Validate repository
if ! git -C "$REPO" rev-parse --git-dir > /dev/null 2>&1; then
  printf 'Error: not a git repository: %s\n' "$REPO" >&2
  exit 1
fi

# Validate branches
for _br in "$BRANCH_A" "$BRANCH_B"; do
  if ! git -C "$REPO" rev-parse --verify "$_br" > /dev/null 2>&1; then
    printf 'Error: branch not found: %s\n' "$_br" >&2
    exit 1
  fi
done

# --- Dry-run merge -----------------------------------------------------------
# merge-tree --write-tree writes only to the git object store (gc-able garbage).
# It never touches the working tree, the index, or any branch refs.
# Exit 0 = clean merge, 1 = conflicts, >=2 = git error.
_mt_out=""
_mt_rc=0
_mt_out=$(git -C "$REPO" \
  -c merge.conflictStyle=diff3 \
  merge-tree --write-tree --name-only \
  "$BRANCH_A" "$BRANCH_B") || _mt_rc=$?

if [[ $_mt_rc -ge 2 ]]; then
  printf 'Error: git merge-tree failed (exit %d)\n' "$_mt_rc" >&2
  exit "$_mt_rc"
fi

if [[ $_mt_rc -eq 0 ]]; then
  printf 'Conflicts identified: none — %s and %s merge cleanly.\n' "$BRANCH_A" "$BRANCH_B"
  exit 0
fi

# Parse output: line 1 = result tree OID, remaining lines = conflicted file paths
_result_tree=$(printf '%s\n' "$_mt_out" | head -n1)

# Collect conflicted file paths — skip the status messages git emits alongside the names
_conflict_files=()
while IFS= read -r _f; do
  [[ -z "$_f" ]] && continue
  [[ "$_f" = Auto-merging* ]] && continue
  [[ "$_f" = CONFLICT* ]] && continue
  _conflict_files+=("$_f")
done < <(printf '%s\n' "$_mt_out" | tail -n +2)

_file_count=${#_conflict_files[@]}

printf 'Merge Conflict Analysis: %s <-> %s\n' "$BRANCH_A" "$BRANCH_B"
printf '============================================================\n'
printf '\n'
printf 'Conflicts identified: %d file(s)\n' "$_file_count"
for _f in "${_conflict_files[@]}"; do
  printf '  * %s\n' "$_f"
done
printf '\n'

# Analyse each conflicted file
for _file in "${_conflict_files[@]}"; do
  echo '------------------------------------------------------------'
  printf 'File: %s\n' "$_file"
  echo '------------------------------------------------------------'
  printf '\n'

  # Retrieve file content with diff3 conflict markers from the result tree.
  # Reads from git objects only — no working tree or index access.
  _file_content=$(git -C "$REPO" show "$_result_tree:$_file")

  # Single awk pass: parse diff3 markers and emit the four report sections.
  printf '%s\n' "$_file_content" | awk \
    -v branch_a="$BRANCH_A" \
    -v branch_b="$BRANCH_B" \
    '
    # Count lines in `side` that differ from the corresponding line in `base`.
    function count_changed(side, base,   ns, nb, as, ab, n, i) {
      ns = split(side, as, "\n")
      nb = split(base, ab, "\n")
      n  = 0
      for (i = 1; i <= ns; i++) {
        if (i > nb || as[i] != ab[i]) n++
      }
      return n
    }

    # Prefix each line of a multi-line string with pfx.
    function indent(s, pfx,   n, arr, i, out) {
      n = split(s, arr, "\n")
      out = ""
      for (i = 1; i <= n; i++) {
        out = out (i == 1 ? "" : "\n") pfx arr[i]
      }
      return out
    }

    BEGIN { state = "ctx"; ours = ""; base_c = ""; theirs = ""; hunk = 0 }

    /^<<<<<<< /         { state = "ours";   ours = ""; base_c = ""; theirs = ""; next }
    /^\|\|\|\|\|\|\| /  { state = "base";   next }
    /^=======/          { state = "theirs"; next }
    /^>>>>>>> /         {
      state = "ctx"
      hunk++

      n_ours_ch   = count_changed(ours,   base_c)
      n_theirs_ch = count_changed(theirs, base_c)

      if (hunk > 1) print "(Hunk " hunk ")"

      print "Reason for conflict:"
      print "  Both branches modified the same region from their common ancestor."
      if (base_c != "") {
        print "  Common ancestor:"
        print indent(base_c, "    | ")
        print ""
      }
      print "  " branch_a " version:"
      print indent(ours, "    > ")
      print ""
      print "  " branch_b " version:"
      print indent(theirs, "    > ")
      print ""

      if (n_ours_ch > n_theirs_ch) {
        winner    = branch_a
        w_cont    = ours
        rationale = branch_a " changed " n_ours_ch " line(s) from the ancestor vs " \
                    n_theirs_ch " in " branch_b " (more extensive change)"
      } else if (n_theirs_ch > n_ours_ch) {
        winner    = branch_b
        w_cont    = theirs
        rationale = branch_b " changed " n_theirs_ch " line(s) from the ancestor vs " \
                    n_ours_ch " in " branch_a " (more extensive change)"
      } else {
        winner    = branch_a
        w_cont    = ours
        rationale = "equal changes from ancestor (" n_ours_ch " line(s) each); defaulting to " branch_a
      }

      print "Suggested winning side: " winner
      print "  Rationale: " rationale
      print "  [heuristic only — human decides]"
      print ""
      print "Proposed resolution:"
      print indent(w_cont, "    ")
      print ""
      next
    }

    state == "ours"   { ours   = (ours   == "" ? $0 : ours   "\n" $0) }
    state == "base"   { base_c = (base_c == "" ? $0 : base_c "\n" $0) }
    state == "theirs" { theirs = (theirs == "" ? $0 : theirs "\n" $0) }
    '

done
