# Reconsidering Quality

Status: proposal, not approved work. The Quality page is retired; old Quality,
Bugs and Audit links open the project home. Existing bugs, checks, results and
run history remain intact, along with the runner, API and CLI.

## Purpose

Help the owner answer **“What needs attention before I trust this change?”**
without piecing together a session summary, check history and several board cards.

The old page grouped bugs and checks into severity counts. Those counts did not
establish whether a particular change was tested, whether a failure affected
that change, or what to do next. A replacement should organise evidence around
a decision, rather than calculate another project health score.

## Where it belongs

Start with a **Verification section in the existing work review flow**, opened
from the board item being reviewed. This keeps the change, its evidence and the
human's decision together. Development remains the place to see running sessions
and their history; Verification links to those records rather than reproducing
the ledger.

A separate project page is a later option, justified only if the owner regularly
needs to investigate failures across several changes. A live-site incident and
a branch awaiting review are different contexts; do not mix their results into
one green/red indicator.

“Verification” is a working name. The useful promise is evidence for a specific
change, with its limits visible.

## The three jobs

| When | Question | Useful outcome |
| --- | --- | --- |
| Reviewing built work | What was checked, and does it apply to this version? | Inspect the evidence, request missing verification, then use the existing review controls. |
| A check fails | What failed, where, and is there already work tracking it? | Read the failure, reproduce it where supported, or open the existing bug/work item. |
| Resuming a project | What remains unresolved from the last verification? | Find the concrete next action without reading every historical run. |

The first version serves the first two jobs for one selected change. Project-wide
triage can follow if real use shows it is needed.

## Proposed first version

### 1. Establish the thing being reviewed

Lead with the board item and the exact revision under review: branch and commit
where available. Identify the tested target separately: local checkout, preview,
or live site. A branch name can move, and a URL alone does not identify the code
running behind it.

If Stack cannot establish the revision or target, say so. Do not silently use the
latest project check as evidence for the selected work.

### 2. Show evidence as readable rows

Each row answers: **what ran, what happened, where, when, and who recorded it?**
Show the command/check name, result, target, revision if known, time and source.
Open the row to read the failure/output and the original run or report.

Keep a session's “I ran the tests” statement labelled as session-reported
verification. Keep a stored runner result labelled as a runner result. Neither
should imply that Stack independently observed more than it did.

Show the failure excerpt first, with full available evidence one click away.
If logs are missing or were truncated, state that alongside the result.

### 3. Separate outcome from applicability

A check can pass and still be unsuitable evidence for the change being reviewed.
Use two separate facts rather than one overloaded status:

| Fact | Proposed values | Meaning |
| --- | --- | --- |
| Outcome | Passed, Failed, Could not run, Not run | What happened during execution. |
| Applies to this change | Matches revision, Earlier revision, Unknown | Whether the evidence identifies the revision being reviewed. |

For live-site checks, show the target and observation time; revision matching
requires deployment evidence. An old result remains useful history, but cannot
establish the current version passes. A recent timestamp alone does not fix that.

A new commit makes earlier evidence visibly belong to the earlier revision.
Do not invent a universal “stale after 24 hours” threshold: code changes and the
kind of observation matter more than one arbitrary age limit.

### 4. Put the next action beside the finding

Offer only actions the evidence and integration actually support:

- **Inspect evidence:** open the report, log or run that produced the finding.
- **Open related work:** link an explicitly associated bug or board item.
- **Request verification:** use the existing refinement/handoff path, carrying
  the missing check and revision as context.
- **Rerun:** offer only when Stack has a supported runner and a known target.
  Explain the target before execution. Existing HTTP checks can include writes;
  a rerun must not be treated as a harmless refresh.

External reports get an evidence link or instructions for recording another run,
not a button suggesting Stack can execute their original command. Free-form
command execution is outside the first version.

If no related work exists, an explicit human action may file it through the
existing tracker. No automatic bug creation, duplicate tracker or invented
association based on a similar title.

## What this would look like

**A UI change is ready for review.** Its build passed for commit A, but the
branch is now at commit B. Show “Passed · earlier revision”, alongside “No UI
smoke evidence recorded for B”. The owner can inspect A's result and request
verification of B. The old pass never becomes a green badge on B.

**Smoke finds a mobile editing failure.** Show the failed interaction, viewport,
tested target and available report/screenshot. If a baseline was also checked,
show that result separately. “Also fails on baseline” is context, not a reason
to mark the candidate run passing or close a bug automatically.

**Verification cannot start.** A missing browser dependency means “Could not
run”, with the setup error and next action. It does not mean the application
failed its checks. Likewise, no recorded result means “No evidence recorded”,
not “No problems found”.

## Existing data and the gaps

The repository currently provides useful building blocks, but not the complete
contract needed for the proposed view:

| Existing source | Useful evidence | Limit to address |
| --- | --- | --- |
| `checks`, `check_results` | Check definitions, outcomes, errors, durations and observation times. | Result rows do not currently record the tested commit or environment as structured provenance. |
| `check_runs` | Whole-suite or partial-run totals and timing. | Run scope matters; one check or one feature cannot represent a full suite. No commit binding is established by these rows. |
| External `/checks/report` | A named check's externally reported result and history. | It does not create a suite-run record. A report cannot establish that a whole suite ran. |
| Automation run ledger | Item/branch context, a summary, failing-check count and agent review information. | A summary/count is not per-check evidence for an exact revision. Missing review remains “no review”. |
| Authored session checkpoints | A handoff and, where supplied, commit context. | Verification claims remain session-authored; Codex does not have automatic lifecycle/check capture here. |
| Existing bugs and board items | Tracked problems and work to resolve them. | A bug/check link is an association, not proof of test coverage or a fix. |

Before implementation, trace one real run through storage and the API. Agree a
small evidence contract: project, source/run identity, check or command label,
outcome, observed time, revision, target and an evidence reference. Unknown fields
stay unknown. Distinguish a committed tree from a working tree with uncommitted
changes; merely recording HEAD must not imply that HEAD alone was tested.

Choose the smallest place to add missing provenance after this trace. Do not
introduce another copy of check outcomes or backfill historical commit links by
guessing from timestamps. Any route/payload changes require matching checks;
this document does not approve a schema or adapter implementation.

## Delivery sequence

1. **Validate the decision.** Walk through one real failed change and one real
   review with the owner. Confirm what evidence would have changed the next
   action, and whether the existing review surface is the right home.
2. **Establish provenance.** Capture the minimum missing context for one existing
   verification path. Check revision changes, uncommitted work, duplicate reports,
   partial runs and unavailable sources before widening collection.
3. **Ship a small read view.** Show evidence for one selected work item, its
   applicability and links to existing actions. Use real records and explicit
   empty/unknown states. Keep the existing human review controls.
4. **Add actions where useful.** Integrate one supported rerun or verification
   request after the read view proves helpful. Reuse runner and approval rules.
5. **Revisit a project-wide view.** Build it only if recurring investigation
   across changes cannot be handled well by the board and Development.

These are proposed stages, not roadmap cards or Ready membership.

## Acceptance and limits

The first version earns its place if, on representative real changes, the owner
can identify a failed or missing verification, see what it applies to and take
the next action without comparing several trackers. Evaluate that directly in a
short walkthrough; do not invent a new telemetry project to measure it.

Before shipping, demonstrate that:

- A matching pass and an earlier-revision pass are visibly different.
- Partial runs and external reports never look like passing whole suites.
- A missing result, an execution problem and an application failure are distinct.
- An unavailable source reads as unavailable; previously loaded evidence retains
  its observation time and is not presented as a fresh observation.
- Opening existing evidence makes no writes, and reruns name their actual target.
- Related work opens its existing record; agent advice stays separate from the
  human verdict and existing machine-verdict rules are not widened.

No replacement health score, automatic verdicts, inferred test coverage,
paid model calls or sample dashboard data. A project-wide incident console,
new test runner and comprehensive test-management system are outside this scope.
