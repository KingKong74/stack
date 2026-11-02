# Stack — goals and delivery outline

Refreshed 2 November 2026 from the repository and its current operating rules. This is the
working project direction; live priorities, claims and completion stay in Stack's board.

## North star

Open Stack, understand where each project stands, and resume the right work with enough context
to act. Carry that context through planning, implementation and human review, including when
the person switches coding agents.

## Product goals

| Goal | What success looks like |
| --- | --- |
| Frictionless resume | A useful summary, current work, next moves and blockers survive between sessions. |
| Deliberate planning | Ideas stay distinct from approved work; the active sprint is the planning lane and Ready is the unattended build lane. |
| Reviewable delivery | Built work has a branch, an account of the change and verification evidence; missing reviews never look green. |
| A board for the owner | Organising tasks and clusters stays understandable and hands-on; automation respects the owner's choices. |
| Honest visibility | Activity, usage, host presence and checks show what was observed; unknown or disconnected never means healthy or free. |
| Agent continuity | Claude and Codex can follow the same project rules and leave useful handoffs without copying secrets or inventing telemetry. |

## Current baseline

The repository contains the React frontend, Express/Postgres API, host terminal daemon, CLI,
Claude hooks, checkpoint poster and continuous automation runner. It has Ready and active-sprint
lanes, approval and claim gates, worktrees, a review workflow and runtime launch support.

The Terminal page offers native Claude and Codex sessions, with Shell as a utility. Both agent
sessions use tmux persistence; the gateway picker and provider fallback have been removed.
Codex still lacks Claude's lifecycle hooks, transcript-based usage and edit watching. Repository
instructions and the manual handoff workflow cover those gaps; runtime parity remains future work.

The README's original four-tab description and the August Overview brief predate the current
navigation. In particular, `web/CLAUDE.md` records the removal of the Roadmap tab. Treat that brief
as historical design context, not the current implementation specification.

## Delivery outline

1. **Establish a shared workspace contract.** Give Codex a short AGENTS.md entry point, reuse
   existing package rules, and document context reads and authored checkpoints. Acceptance:
   a fresh Codex session can find the rules and explain what Stack can and cannot observe.
2. **Exercise the manual Codex round-trip.** On an owner-chosen task, read current directives
   and claims, use an isolated branch where needed, verify the change and post a checkpoint.
   Acceptance: Stack shows the actual work and a subsequent session can resume from it.
   This requires configured Stack access and is not established by documentation checks alone.
3. **Add runtime integration where it earns its place.** Scope a separate implementation for
   Codex context delivery, lifecycle recording and reliable usage provenance. Acceptance:
   startup, resume, failure, duplicate events and concurrent sessions have tested behaviour;
   missing usage stays unknown and existing Claude behaviour still passes.
4. **Reconcile the product documentation.** Update navigation and feature descriptions against
   the running app, replacing stale outlines with verified behaviour. Acceptance: setup and screen
   descriptions match the app; mock surfaces and historical briefs are labelled accurately.

These are proposed work stages, not approved Ready items or a promise to run unattended.

## Boundaries

- Keep Postgres/API as the application source of truth; Markdown is direction and guidance.
- Preserve existing human approval and verdict gates, including their documented narrow exceptions.
- Keep the no-paid-external-AI-API policy; this work does not select a model or authorise spend.
- Keep host services dialling out, secrets local, previews isolated and destructive automation safe
  when the API is unavailable.
- Do not add a new task system, rewrite the runner or assume all runtimes share Claude's hooks.

## Decisions still open

The next product priority and the desired depth of Codex integration remain the owner's choices.
The owner has selected native Claude and Codex for the Terminal page. Account and model
configuration remain each CLI's responsibility; automatic Codex lifecycle capture is still open.
