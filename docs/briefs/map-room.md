# Design brief — the Map room: a project's structure, health and agent dispatch

**Surface:** Mission Control → MAP (`#/control/map`, new room alongside Now / Plan / Review / Merge)
**Status:** problem statement + data inventory. The shape is design's call.
**Written:** 12 Aug 2026, with live numbers from the `stack` repo itself (683 commits, 7 weeks).

---

## 1. The ask in one line

A room that shows **which parts of the application are in trouble** — churn, size, weak test cover,
open bugs, failing checks, live conflicts — as a structure you can **zoom into**, and from any part of
which you can **send an agent to that context** with the scope already filled in.

---

## 2. Why the room has to exist

There is no surface anywhere in Stack that reads the **code** as a subject. Every existing room reads
*work*: Now reads sessions, Plan reads the queue, Review reads changes, Merge reads branches. The
codebase itself — where it's thick, where it's thrashing, where nothing tests it — is invisible.

The cost of that is concrete. Two structural problems were found in four minutes of ad-hoc analysis
this week, and **neither was visible in the product**:

- **`web/src/styles.css` is one file of 7,848 lines holding 4,952 class rules, touched by 263 of 683
  commits (38% of all history) and 11% of the last fortnight's churn.** Every UI file couples to it at
  78–100% co-change. It is very likely the real reason parallel build lanes collide at merge time.
- **`web/src/types.ts` is the API payload contract**, kept in step with the server by hand —
  `routes/overview.js` co-changes with it 77% of the time, `routes/checks.js` 75%.

Both are the kind of thing an owner should meet on a screen, not discover by writing a one-off script.

---

## 3. The signal that already exists

All of it is derivable from git and the existing database. Nothing below needs new collection.

### Surfaces — live numbers for `stack`, 12 Aug 2026

| Surface | files | lines | commits | last 14d | share of recent churn | test-referenced |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **web · styles** | 1 | 7,848 | 263 | 106 | 11% | 1/1 |
| **web · store** | 1 | 2,829 | 185 | 66 | 7% | 1/1 |
| web · types | 1 | 700 | 80 | 24 | 2% | 1/1 |
| web · mission control | 10 | 8,750 | 159 | 83 | 8% | 3/10 |
| web · screens | 8 | 6,348 | 204 | 68 | 7% | 6/8 |
| **web · project detail** | 14 | 10,319 | 228 | 119 | 12% | 5/14 |
| web · components | 19 | 3,160 | 107 | 26 | 3% | 2/19 |
| web · lib (pure) | 22 | 3,621 | 72 | 52 | 5% | 17/22 |
| **server · routes** | 32 | 11,535 | 357 | 162 | 16% | 28/32 |
| server · core | 23 | 6,462 | 321 | 130 | 13% | 23/23 |
| scripts · autopilot | 2 | 2,437 | 70 | 30 | 3% | 2/2 |
| scripts · lib (pure) | 7 | 864 | 11 | 10 | 1% | 7/7 |
| **scripts · cli** | 29 | 8,125 | 109 | 86 | 9% | 2/29 |
| terminal daemon | 12 | 2,718 | 56 | 20 | 2% | 6/12 |
| hook | 5 | 1,097 | 33 | 7 | 1% | 0/5 |

**The shape those numbers make is the point** — the same way the progression spine's blockage is its
point. Three readings jump out and none of them is currently visible anywhere:

- **One file is 11% of all recent work.** `styles.css` is a surface of one.
- **High churn against thin cover.** `scripts · cli` took 86 commits in a fortnight with 2 of 29 files
  named in any test. `web · project detail` is the single busiest surface (12% of churn) at 5 of 14.
  `hook` has zero test reference and is load-bearing — both hooks must always exit 0 or Claude Code
  won't start.
- **The pure modules are the well-tested ones** (`lib` 17/22, `scripts/lib` 7/7, `server · core` 23/23).
  The discipline is real; it just stops at the UI boundary.

A surface that is **busy and untested** should not look like a surface that is **busy and covered**.

### Coupling — what actually changes together

Co-change over all 683 commits, which reveals the real architecture rather than the intended one:

```
100%   17x   components/CommandDeck.tsx   <->  styles.css
100%   12x   detail/Overview.tsx          <->  styles.css
100%    9x   screens/Dashboard.tsx        <->  styles.css
 93%   14x   App.tsx                      <->  styles.css
 92%   12x   routes/settings.js           <->  settings.js
 91%   10x   terminal/stack-term.mjs      <->  tmux-session.mjs
 82%   41x   detail/Roadmap.tsx           <->  styles.css
 80%   64x   screens/ProjectDetail.tsx    <->  styles.css
 78%  124x   store.ts                     <->  styles.css
 77%   37x   schema.sql                   <->  shape.js
 77%   10x   routes/overview.js           <->  types.ts
```

Two distinct kinds of edge are mixed in there, and design should probably distinguish them:

- **Healthy pairs** — `routes/settings.js ↔ settings.js`, `schema.sql ↔ shape.js`. A route and its
  shape module *should* move together.
- **Gravity wells** — everything ↔ `styles.css`. One node pulling on the whole graph is the finding.

### What else joins on, per surface

| Signal | Where it comes from |
| --- | --- |
| open bugs here | bug fix commits → the paths they touched |
| roadmap items here | an item's landing commits → paths (**retroactively places the 245 of 350 items that carry no `area` tag**) |
| failing checks here | the `checks` table, 77 checks, currently 75 pass / 2 fail |
| spend here | `autopilot_runs` → branch → item → paths; last measured night was 25 runs, 20 landed, $171.62, **$8.58 per landed change** |
| **hot right now** | live `claimed_by` branch claims + registered worktrees → the paths their diffs touch |

---

## 4. What the room should answer

In rough priority:

1. **Where is this application in trouble?** Not one score — the specific surfaces, and *why* each is
   flagged (thick / thrashing / untested / failing / conflicted are different problems and should read
   differently).
2. **What does this thing even look like?** There is no diagram of Stack anywhere. A first-time or
   returning read should convey the shape: web, server, scripts, hook, terminal daemon, and their real
   dependencies.
3. **What is coupled to what?** Especially: what is the gravity well, and is it getting worse.
4. **Where is work happening right now?** Live claims and worktrees over the map — so the owner can see
   that three sessions are all in `web · project detail` and therefore heading for a collision.
5. **Where should I not send an agent?** The inverse of 4, and the thing that makes the room
   operational rather than decorative.
6. **Send an agent here.** Pick a surface → dispatch a read against exactly that scope.

---

## 5. The agent-dispatch half

This is the interaction that makes the room a **workspace** rather than a chart, and it needs a design.

The unit of the map is a **path glob** — deliberately, because a path glob is exactly what an agent
takes as its scope. The map's unit and the agent's context are the same object.

Selecting a surface (or a file, or a multi-select of surfaces) should offer a small closed set of reads.
Working names:

- **Survey** — what is wrong here, ranked
- **Debt** — what to repay, in what order, and what each repayment unblocks
- **Explain** — how does this part work (for a surface the owner hasn't touched in weeks)

Design considerations specific to this:

- The reads are **slow** — they run Claude on the host and take tens of seconds to minutes. The room
  needs a genuine pending state, not a spinner that implies a second's wait, and results should persist
  so a read isn't lost by navigating away.
- A read **annotates; it never mutates**. Nothing here ticks an item, closes a bug or queues a merge.
  Its output should look like advice, never like a verdict — this is a hard house rule and the Review
  room's verdict colours must not be borrowed.
- Every answer carries **what it could not see** (the existing Foreman pattern). A read scoped to a glob
  is blind by construction, and the blind list should be rendered hardest when the read is reassuring.
- The obvious next affordance is **promote to a roadmap item** — a finding becoming a card. Worth
  designing, since it's the loop that makes the room feed the board.

---

## 6. Data inventory

**Available now**, no new plumbing:

- Everything in §3 — surfaces, size, churn, churn trend, coupling, per-surface bugs / items / checks /
  spend, live claims
- Full commit history with paths (683 commits, from 26 June 2026)
- The existing check suite and its pass/fail per target
- Branch and worktree state on the host

**Needs a small addition:**

- **Test coverage is currently a name-match proxy** — "does any test file mention this module's name".
  It is directional, not truth: it over-counts (a name mentioned in passing) and under-counts (a module
  exercised through another). Real per-file coverage means instrumenting the test run. **Design should
  assume the number is approximate and label it as such** rather than presenting it as a coverage
  percentage.
- **No history for any of these metrics.** Churn trend is computable retroactively from git, but
  per-surface bug counts, check status and spend are point-in-time. A sparkline on those needs a daily
  snapshot row added first and would only start from that day.

**Deliberately absent:**

- There is **no hand-drawn architecture diagram and there must not be one.** The house rule is
  *derived, never drawn* — the same rule that governs feature stage, branch merge state, the Polaris
  galaxy's shape and the merge waves. A diagram that is authored drifts from the code within a
  fortnight; one that is computed cannot. Whatever design produces has to be renderable from the data
  above, with no human-maintained layout.

---

## 7. House constraints

- **Atlas design language.** Colours are the named CSS variables at the top of `:root` in
  `web/src/styles.css` — neutrals, terracotta accent ramp, semantic tones (`--live --building --sage
  --critical --paused`). Never inline hexes. Dark mode is one `[data-theme='dark']` block on the same
  tokens.
- **en-AU spelling** throughout.
- **Absent is not zero, and unprobed is not clean.** A surface with no checks, or one whose read has
  never run, must render as *unknown* — never as a green zero. This holds house-wide and it is the
  single rule most likely to be violated by a map that wants every node coloured.
- **This must not become a health score.** Stack already refuses to call its progress percentage a
  health score, deliberately. A map that reduces a surface to one number invites exactly the
  false confidence the house rules keep rejecting. Prefer several honest readings over one composite.
- **Mission Control's room is part of the URL**, and rooms write it back without a history push. A
  selected surface should be deep-linkable on the same terms.
- **Multi-project.** The map is keyed on paths, so it generalises to any repo Stack tracks. Design for
  one project's map, but assume a project switcher above it.
- **Read on a phone as often as a desktop** — including, specifically, deciding *"can I send an agent at
  this while I'm out"*.

---

## 8. What would help most coming back

- **The map's visual form.** Treemap, graph, packed circles, something else — the open question is how
  to show *size, churn, and confidence* at once without three separate charts or one composite score.
- **How the five trouble kinds read differently** — thick / thrashing / untested / failing / conflicted.
  These are genuinely different problems and flattening them to a red gradient loses the whole point.
- **How to draw coupling without a hairball.** 683 commits produce a dense graph; the interesting part
  is the handful of gravity wells and the healthy pairs, not the full edge set.
- **The zoom.** Repo → surface → file, and what each level shows that the one above didn't. The
  Timeline's free zoom (#401) is the nearest precedent in the app and worked well.
- **The dispatch affordance** — selecting scope, choosing a read, waiting, and reading a result that has
  to look like advice and never like a verdict.
- **Live work overlaid on structure** — sessions, claims and worktrees sitting on the map, and how "this
  area is hot" reads without looking like an alarm.
- **Empty and early states.** A brand-new project with 3 commits and no checks should look like a
  beginning, not a failure — and should not render as a uniformly healthy green map either.
