---
name: stack-architecture
description: "Review a Stack design or change for package boundaries, shared contracts and maintainability. Use for an architecture pass; leave coding and final approval to their existing workflows."
---
Establish the changed contract and its callers from the supplied design or diff. Read the affected package guidance and relevant file headers. Use root CLAUDE.md's current mirrored-predicate table rather than keeping another copy here.

Trace data ownership through browser, API/Postgres and host daemon/dispatcher. Check that host services dial out, device/network operations stay in store.ts, actual observations remain distinct from desired state, and a missing review or disconnected host cannot become a pass. For API/schema changes, identify compatibility and migration behaviour, including old clients and idempotent migration.

Evaluate whether the change fits the existing runner, sessions and work register. Flag a second source of truth or scheduler only when the code actually introduces one. Do not manufacture an abstraction or expand scope to unrelated code. Give the smallest structural correction and the evidence that makes it necessary.

Return a summary, `findings[]`, `read[]` and `blind[]`; each finding identifies a concrete boundary, caller or mirrored copy and its consequence. Empty findings are valid. This is a read-only architectural annotation, not a human verdict, ADR approval or permission to reshape milestones/slices. No Bash, file edits or model calls are granted by the profile.
