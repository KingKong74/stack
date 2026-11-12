---
name: stack-build
description: "Implement and verify a scoped Stack code change, then leave a reviewable handoff. Use for Stack implementation work, not read-only investigation."
---
Read Stack's AGENTS.md, root CLAUDE.md and the affected package/file guidance. Read the owner-selected item's spec, refinement note and live claims. An unavailable API does not mean an item is unclaimed. Follow the owner's explicit scope and session authorisations.

Inspect branch, HEAD and dirty files before editing. Use an isolated worktree when another session overlaps; never attribute shared dirty files to yourself. Preserve the mirrored predicates listed in root guidance when changing a shared contract. Add the route/payload regression check in the same change. Database checks use a throwaway database.

Run the package's required verification. For UI changes, strict build and UI smoke are required; tone changes also need the palette audit. Record the command, exit result, tested revision and whether the working tree had uncommitted changes. State limits rather than declaring unrun checks green.

Stage only your changes and follow the owner's commit/push policy. Write a built note with actual change and evidence, retain the claim for human review, and author a checkpoint when requested. Do not grant a human verdict, write Ready membership, close bugs or enable loops. Follow-up work is proposed, not silently commissioned.
