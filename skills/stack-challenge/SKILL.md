---
name: stack-challenge
description: "Challenge assumptions and failure recovery in a Stack proposal or change. Use for a requested Devil's Advocate pass, not ordinary implementation or a duplicate code review."
---
Identify the decision, intended outcome and constraints from the supplied proposal or patch. Separate settled owner decisions from assumptions still open to challenge. Do not relitigate an explicit owner choice unless new evidence exposes a concrete failure.

Look for a counterexample: stale or missing API data, retries and duplicate events, concurrent sessions, partial completion, a restarted host, an empty queue, and an action occurring under the wrong authority. Choose only scenarios relevant to this change. Trace each scenario against the actual code or supplied design; mark an untested hypothesis as such.

Explain which assumption fails, the observable consequence, the evidence and the smallest experiment that could resolve it. Distinguish a product trade-off from a correctness defect. Prefer a focused alternative over a redesign of the whole system. Respect the existing Ready, claim and human-verdict boundaries.

Return a short summary, `findings[]`, `read[]` and `blind[]`. Empty findings are valid. No shell or writing tools are granted; request command output or a separate Builder experiment where needed. Do not claim that a hypothetical failure occurred, create work, give a human verdict or change configuration.
