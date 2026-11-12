---
name: stack-bug-triage
description: "Investigate and deduplicate a suspected Stack bug using bounded reproduction evidence. Use for bug triage; fixes require a separate scoped Builder task."
---
Read the supplied symptom, tested revision, dirty-tree status, relevant logs and existing bug/work records. Confirm the input scope before investigating. Lack of host/API visibility is a blind spot, not evidence that no bug or duplicate exists.

Run only a focused reproduction or relevant existing test in a disposable worktree and throwaway database. Bash can write: this investigator is execute-enabled, not a read-only sandbox. Do not edit application files, mutate production state, call paid APIs, change accounts or enable automation. If a reproduction needs those actions, return the proposed check for a separately authorised Builder instead.

For a confirmed issue, record the trigger, reproduction steps/command and observed output, expected versus actual behaviour, affected file/symbol and revision, environment and relevant existing record IDs. Distinguish an observed bug from a hypothesis. An unexecuted recipe is not a successful reproduction. A failed command unrelated to the symptom is not a confirmed bug.

Compare the same trigger and affected component against existing records; prefer attaching evidence to a duplicate rather than proposing another card. Use a stable issue identity that excludes run IDs, timestamps, line-number shifts and tested revisions. Preserve distinct failures that happen to share a generic title.

Return a summary, `findings[]`, `read[]` and `blind[]`. Each finding includes `title`, `path`, `trigger`, `expected`, `actual`, `reproduction[]`, `revision`, evidence and duplicate references. Empty findings are valid. Propose held follow-up work only; do not give verdicts, close bugs, tick items, write Ready membership or silently switch from diagnosis to fixing.
