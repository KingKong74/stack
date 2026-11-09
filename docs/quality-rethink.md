# Reconsidering Quality

Status: proposal, not approved work. The Quality page is retired; old Quality,
Bugs and Audit links open the project home. Existing bugs, checks, results and
run history remain intact, along with the runner, API and CLI.

## The decision a replacement should support

“What needs attention before I trust this change?” A project-wide severity
count cannot answer that without showing which change was checked, when,
what ran and what remains unknown.

Start by checking whether this belongs in the existing board review flow.
Build another page only if it makes a distinct, recurring decision easier.

## Proposed first scope

- **Failures to investigate:** show the actual failure, last observation,
  affected work where known, and a link to its evidence. Distinguish a failed
  check from a runner that could not execute it.
- **Evidence for the change:** show the branch/commit checked, commands or
  checks run, outcome and time. Older or unattributed results cannot establish
  that the current change passes.
- **A next action:** inspect evidence, reproduce, rerun a supported check,
  or open existing work. Link a known bug rather than making another copy.
- **Missing evidence:** say untested, stale or unknown explicitly. Keep
  agent advice separate from a human verdict.

## What to establish before building

Walk through one real failed change and one real review. Identify the decision
the owner needed to make, the evidence available and the action that would have
helped. Inspect stored provenance: do not promise commit-level verification
until the data can support it. Scope any missing collection separately.

Acceptance: an owner can identify the failed or missing verification, see what
it applies to, and take the next action without comparing several trackers.
An empty, unreachable or stale result must never look like a clean pass.

Avoid a replacement health score, another bug tracker, inferred coverage from
bug/check links, automatic verdicts, or a dashboard built from sample rows.
