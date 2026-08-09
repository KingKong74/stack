# Design brief — the Overview tab as a project's progression spine

**Surface:** Project detail → OVERVIEW (`#/p/<slug>`, `web/src/detail/Overview.tsx`)
**Status:** problem statement + data inventory. The shape is design's call.
**Written:** 9 Aug 2026, with live numbers from the `stack` project itself.

---

## 1. The ask in one line

The Overview tab should show **how a project is progressing through its stages** — from raw idea to
live — and act as the **doorway into whichever stage needs me**, instead of being a wall of
point-in-time panels with no direction of travel.

---

## 2. What the tab shows today

Five bands, top to bottom:

1. **Resume card** — "pick up where you left off": last checkpoint summary, in-progress, suggested next
2. **Needs review** — auto-extracted items awaiting keep/dismiss
3. **Directives** — standing instructions injected into every session start
4. **Three panels** — Deployment · Tech stack · Snapshot (open bugs / roadmap items / pushes this week)
5. **Latest summaries** — the last **2** push cards

Every one of these is a snapshot. Nothing has a second reading to compare against, so the tab can say
*where things stand* but never *which way they are moving*. Two concrete gaps:

- **The progress percentage is not on the tab at all.** It is computed on every project payload and
  shown on the Dashboard, but the project's own page hides its headline number.
- **Latest summaries caps at 2 cards** — a log, not an arc.

---

## 3. The progression that already exists

Stack already has a real pipeline; the tab just doesn't draw it. Every stage below is a live query
today, and each one is **already owned by another tab or room** — which is what makes the spine a
navigation device and not just a chart.

Live numbers for `stack`, 9 Aug 2026:

| Stage | What it means | Now | Its home |
| --- | --- | --- | --- |
| **Idea** | Futures — directional, uncommitted | **102** | Futures tab (Polaris galaxy) |
| **Planned** | Roadmap items, open, unclaimed — bucket + tier + risk set | **38** | Roadmap tab |
| **In flight** | Claimed by a session or a fleet worker | **1** | Mission Control → Now |
| **Built** | Has a `built_note`, awaiting a human verdict | **49** | Mission Control → Review |
| **Landed** | Verdicted and merged | **230** | Activity tab |

Running alongside, not in the funnel: **12 open bugs**, and a Must/Should split of **76/83 Musts** and
**168/191 Shoulds** done (which is exactly what the progress percentage is computed from).

**The shape those numbers make is the point.** A 102-idea intake, one item actually in flight, and 49
changes clogged at the verdict stage. Today you have to visit four screens to learn that. The tab
should make a blockage that obvious in one glance — a stage that is backed up must not look like a
stage that is flowing.

---

## 4. What the tab should answer

In rough priority:

1. **How far through is this project?** The progress number, and the arithmetic behind it — Musts and
   Shoulds done vs total, and the 90% cap stated out loud when an open critical bug is holding it there.
2. **Which way is it moving?** Some sense of trajectory — recent movement per stage, push cadence,
   whether the project is accelerating or has gone quiet. It went dark for a week recently and nothing
   on the page said so.
3. **Where is it stuck?** The fullest stage, named as a blockage rather than left to be inferred.
4. **What's next?** The top of the run queue — the near future, not only the past.
5. **Where do I go from here?** Each stage is a doorway. Clicking "49 built" lands in the Review room;
   clicking "102 ideas" lands in the Futures galaxy.

The resume card ("pick up where you left off") stays — it is the tab's most-used element and the
product's whole premise. It should coexist with the spine, not compete with it.

---

## 5. Data inventory

**Available now**, no new plumbing:

- Every stage count above, per project, per bucket and tier
- Progress percentage + its inputs
- Bug counts by severity and status
- Push/session history with timestamps (so cadence and "days since last push" are derivable)
- Autopilot runs per project: outcome, cost, tokens, dates
- `built_note` text for every built item — the raw material for a readable "what landed" river

**Not available** — worth knowing before designing anything historical:

- **No progress history.** Progress is computed live on read; nothing stores it over time. Any
  sparkline or trend line needs a daily snapshot row added first, and would only start from that day.
- **No completion timestamp.** Items carry `updated_at` only, which is *movement*, not a ledger — so a
  truthful burn-up needs a `done_at` or an event log. Anything charted from `updated_at` today is
  approximate and would have to say so.

Both are small additions if design wants them; flagging so nothing is drawn that the data can't honestly
back.

---

## 6. House constraints

- **Atlas design language.** Colours are the named CSS variables at the top of `:root` in
  `web/src/styles.css` — neutrals, terracotta accent ramp, semantic tones (`--live --building --sage
  --critical --paused`). Never inline hexes. Dark mode is one `[data-theme='dark']` block on the same
  tokens.
- **en-AU spelling** throughout.
- **Absent is not zero.** A stage with no data yet, or a metric that has never been measured, must
  render as *unknown* and never as a green zero or a flat line — this rule holds house-wide.
- Deep links already exist for every jump-off target (tab + highlight), so a stage segment can link
  straight to a specific row.
- The tab is read on a phone as often as a desktop.

---

## 7. What would help most coming back

- A layout for the tab with the spine as its entry point, and the existing bands placed around it
- The spine's visual form, and specifically how a **flowing** stage reads differently from a **backed
  up** one
- How the progress number and its arithmetic are expressed without becoming a dashboard gauge (it is
  deliberately *not* a health score)
- What Deployment / Tech stack become — they are twice-a-year config sitting at the same visual weight
  as live state
- Empty and early states: a brand-new project with 0 in every stage should still look like a beginning,
  not a failure
- The mobile reading of all of it
