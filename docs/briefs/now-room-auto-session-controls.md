# Design brief — auto-session controls and clarity, in the Now room

**Surface:** Mission Control → NOW (`#/control`, `web/src/screens/ControlNow.tsx` + `ControlLanes.tsx`)
**Status:** problem statement + data inventory. No solution proposed — the shape is design's call.
**Written after:** an autopilot night on 2 Aug 2026 that had to be stopped from a terminal, because
the room offered no way to stop it.

---

## 1. The ask in one line

The Now room can tell you *that* an autopilot session is running. It cannot tell you **what it is
doing right now**, **how far through the night it is**, or **what stopping it would cost** — and it
offers **no way to stop it at all**.

---

## 2. The incident that prompted this

Real numbers from job #294, a `scheduled` run on the `stack` project. The owner asked a plain
question — "is an auto session running right now?" — and answering it needed a terminal, `tmux ls`,
`ps`, and 30 lines of `~/.stack/autopilot.log`. None of it was in the room built to answer it.

| Time (UTC) | What happened | Was it visible in Now? |
| --- | --- | --- |
| 09:14 | Job #294 starts. Budget: 360 min wall clock, unlimited tokens, unlimited items | Partly — a lane appears |
| 09:14 | Picks item #271, spec pre-pass runs (Gemini quota exhausted → falls back to flash-lite) | No |
| 09:32 | #271 finishes: 4 commits, pushed, 46 turns, ~3018k tokens, **$8.67** | No |
| 09:32 | Checks run: **53 total, 1 failing** | No |
| 09:33 | Architect verdict: aligned. Picks item **#359**, starts a fresh claude session | Lane silently changes item |
| 09:33–09:49 | #359 makes **5 commits**, none pushed | No |
| ~09:48 | Owner asks to pause. **No control exists in the UI** — done by hand via the API | — |
| 09:49:12 | Dispatcher notices, SIGHUPs the tmux session mid-turn | Row flips to "hung up" |

**What that left behind, and what the room still does not show:** five commits on
`auto/item-359-roadmap-require-human-approval` that exist **only on the host**, plus one modified
file and one untracked file (`web/src/lib/approval.ts` — in no commit at all). Nothing was verified;
no build, no typecheck, no checkpoint.

---

## 3. What the Now room shows today

Seven bands, top to bottom, ordered by what a stalled fleet costs:

1. **Arm switch** — armed/off + the fleet status line and its one-click fix
2. **Needs you** — `attention[]`: permission prompts (Approve / Deny / Jump in), paused jobs, review queue
3. **Collisions** — two live sessions writing one file
4. **Sessions** — the merged lane list (autopilot + terminal), grouped by project
5. **Mirror sites** — previews
6. **Up next** — the run queue
7. **Active projects** — the board, each with its branch/merge strip

A **running autopilot lane row** carries: project, item id + title, branch, elapsed, tokens, cost,
tmux name, the exec/advisor role split, and an "attach over tmux" hint. It has **no controls**.

---

## 4. The gaps

Each is stated as a question the room cannot answer, with what it would take to answer it.

### G1 — "Stop it." *(the headline)*
There is **no stop control on a running autopilot lane.** The only ⏸ Hang up button in the room sits
on an attention row for a job that is *already paused* waiting on a usage-limit reset. Stopping a
live run needs a hand-written API call.

The capability exists on every layer except the one the human touches: `PATCH /api/autopilot/jobs/:id
{status:'paused'}` explicitly permits a `running` job, and the dispatcher polls its own job status
mid-run and kills the session when it sees the flip. **Only the button is missing.**

> Related trap for the copy: **turning the arm switch off does not stop a running session.** The
> switch gates *enqueuing*; the dispatcher's mid-run loop only ever checks for the pause flag. In an
> "oh no, stop" moment the switch is the obvious thing to reach for and it does nothing. Whatever
> stop control lands, the arm switch should stop implying it is one.

### G2 — Stop is a kill, and it is the only kind of stop there is
Pausing SIGHUPs the tmux session mid-turn. There is no *"finish this item, then stop"* and no
*"finish this commit, then stop"*. That matters because **the session pushes its own branch** — the
push is an instruction in the director's prompt, not something the runner does on the way out. Kill
it before it gets there and the commits never leave the host.

Design needs to decide whether the room offers one stop or a graduated set, and — either way — the
confirm has to state the true cost: *N commits not yet pushed, M files uncommitted.*

### G3 — The kill takes up to ~30 seconds and the row lies during them
The dispatcher polls every 6 ticks of a 5-second loop. The job flips to `paused` in the database
instantly, so the row reads "hung up" while a claude session is still running, still committing,
still spending. The room needs a **"stopping…" state** — requested, not yet confirmed by the host —
that only resolves when the host says the session is actually down.

### G4 — "What is it doing *right now*?"
The lane shows the item title and a clock. It does not show the last thing that happened. Meanwhile
the director is **ticking off plan steps in the database as it lands them** (`roadmap_items.plan`,
`[{text, done}]`, PATCHed by the session itself) and writing a running commentary to
`~/.stack/autopilot.log`. `plan` is not on the `/api/control` payload today. It is the single
cheapest win here: *step 3 of 6 — "the runner backstops the approval gate"*, live.

### G5 — "How far through the night is it?"
A `scheduled` or `nightly` job is not one item — it picks item after item until the wall clock runs
out. Job #294 had already completed #271 (4 commits, $8.67, 1 failing check) before it started #359,
and the lane never said so. The room shows the current item as if it were the whole job.

Missing: items done so far this job, minutes used of the cap, what each finished item cost and
whether it landed. `autopilot_runs` holds a row per finished item — the data exists, it is just not
on this surface.

### G6 — Unpushed work is invisible, and it is the work most at risk
The branch strip is built from the host's branch report, which enumerates `refs/remotes/origin` only.
A branch with five local commits and no origin ref **appears nowhere in Stack.** That is the exact
state #359 is in as this brief is written. The room that offers the stop button is the room that owes
you this warning.

### G7 — "Paused" means three different things
A resume job holding for a usage-limit reset; a job hung up by a human; and a project whose status is
`paused`. The lane label for the second is "hung up". Worth one vocabulary pass across the room.

### G8 — No "skip this item"
Hanging up a scheduled job kills the **whole night**, not the item. If one item is going badly at
21:00 there is no way to say "drop this one, move on" — the choice is let it burn or lose the night.
Nothing supports this server-side yet; flagging it as a gap, not a request.

---

## 5. What we are asking design for

| | Ask | Notes / constraints |
| --- | --- | --- |
| **A** | **A stop control on a running autopilot lane**, with a confirm that states the real cost | Unpushed commits + uncommitted files, counted, in the confirm body. Follow the tone of the existing "Kill session" modal in `ControlLanes.tsx` — it already does this well for terminal sessions |
| **B** | **A pending/"stopping…" state** for the ~30 s between request and host confirmation | Must not read as "stopped". Same family as the permission-prompt refusals, which are shown verbatim beside the row rather than swallowed |
| **C** | **A live progress read on the lane** — the plan step it is on, and the last thing it did | Say "no plan recorded" when there is none. Never imply progress that was not reported |
| **D** | **Job-level shape for multi-item nights** — items done, clock used vs cap, per-item outcome and spend | The distinction between *this item* and *this job* is the thing to make legible |
| **E** | **An unpushed-work warning** wherever a stop is offered, and ideally in the branch strip | New data (see §6) |
| **F** | **A vocabulary pass** on paused / hung up / held / stopping | Cheap, and G7 is a live confusion |

Also worth design's opinion: **should the arm switch grow an emergency stop-everything**, or should
stopping stay strictly per-lane? Nothing today stops the whole fleet at once.

---

## 6. Data inventory — what is free and what needs building

Useful for scoping: the first list costs a payload line, the second costs real work.

**Already in the database or on the wire (cheap):**
- Job identity, kind, status, item, branch, elapsed, tokens, cost, tmux name — on `fleet.slots[]` today
- Exec/advisor role split and this session's banked spend — on the slot today
- `roadmap_items.plan` — ordered `[{text, done}]`, ticked live by the running session. **In the DB, not on the payload**
- `autopilot_runs` — one row per finished item: outcome, commits, tokens, cost, `checks_failing`, the session's own summary
- `dispatcher_heartbeat` — whether the host is even listening
- Pause/resume/dismiss — all three endpoints exist and work

**Needs building (more expensive):**
- **Wall-clock budget vs used** for a running job — the cap is computed by the runner and passed to
  claude; it is not stored on the job row
- **Unpushed commits + dirty files** per branch — the host's branch report reads `refs/remotes/origin`
  only, so it would need to report local state too
- **A "stopping" status** distinct from `paused` — today the flip to `paused` is both the request and
  the outcome, which is why G3 exists
- **Graceful stop** (finish item / finish commit) — needs a cooperative signal to the runner, not a SIGHUP
- **Skip this item** — no server support at all
- **Last-action-of-the-session** — lives only in `~/.stack/autopilot.log` on the host; nothing streams it

**Note on capacity:** the fleet is one worker wide today (`FLEET_CAPACITY = 1`). #265 turns it into a
real setting, so **design for N lanes running at once**, not one.

---

## 7. House rules any design here must respect

These are load-bearing in Stack and a design that violates one will not survive review:

- **Absence is never good news.** No data reads as "not known", never as "nothing wrong" — the same
  rule that makes a missing review verdict render NO REVIEW rather than green.
- **A capped or truncated list says so, beside the count.**
- **The refusal is shown, verbatim, beside the row it refused.** "Already answered", "the session
  moved on" are normal outcomes, not errors to swallow.
- **Nothing types into a running session except a human.** Any new control is a job-state change, not
  keystrokes into a pane.
- **The host decides, the server relays.** The UI can request a stop; only the host can confirm one
  happened. That gap is real and the design has to show it rather than paper over it.
- **en-AU spelling.** Palette is the named CSS variables in `styles.css` (Atlas) — no new hexes.
- Dark mode is a token override; anything new must work in both.

---

## 8. Out of scope

- The Nights, Plan, Review and Roles rooms — this is the Now room only
- Terminal-session controls (they already have Jump in / Mirror / Kill)
- The permission-prompt Approve/Deny flow — that one works
- Changing what the autopilot *picks*; this is about watching and stopping it, not steering it

---

## 9. Open questions for design

1. Does the stop live **on the lane row**, or in a detail panel behind it? The row is already dense.
2. Is progress a **step counter**, a **timeline**, or a **last-action line**? Only the first is
   reliably available today.
3. Should a multi-item night render as **one lane that changes item**, or as **a job with items
   inside it**? G5 is really this question.
4. How loud should unpushed work be? It is invisible today, and it is the thing that actually gets
   lost.
5. Is there a **stop-the-whole-fleet** control, or only per-lane?
