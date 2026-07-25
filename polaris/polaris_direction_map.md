# Polaris — Direction Map: stack

> Generated 2026-07-22 13:46 UTC

---

## Current State

The 'stack' project is at a critical juncture, with core automation features nearing completion but foundational technical debt and scaling challenges emerging.

**North star:**
> An autonomous software house run from the director’s chair. Polaris plans and designs; executor fleets build overnight in parallel lanes; advisors keep model spend lean (strong minds for judgement, cheap hands for labour); you only steer and give verdicts — from any screen, soon a phone. Every touchpoint that can be automated away is: low-risk work merges itself, reviews arrive pre-briefed, sessions resume themselves past limits. Sophisticated enough for large-scale, multi-branch production systems — previews, mirrors and merge trains handled by the fleet — simple enough to run from one calm screen.

---

## Candidate Next Directions

```
stack
├── **Finalise Core Autopilot & Mission Control** — ✅ PURSUE NOW
│   _These are high-value features directly advancing the North Star, and some work is already in progress or awaiting merge._
│   Branch: Merge `auto/item-224`, complete `Polaris musts`, and push through the Google Calendar sync and merge advisor features.
│   Actions: Human reviews and merges `auto/item-224` for #235.; Complete and push `PolarisTerm.tsx` and `a329e47` for #215/#216/#219.; Implement Google Calendar sync (#222, #230, #231, #232).; Build Merge advisor (#223, #234).
│   Benefit: Delivers key features for autonomous operation and director oversight, improving merge reliability and scheduling.
│   Trade-off: Defers critical bug fixes and architectural scaling, potentially building on shaky ground.

├── **Fortify Core Git Operations & Parallelism** — ✅ PURSUE NOW
│   _Unaddressed critical bugs and architectural flaws will undermine all future feature development and trust in the system._
│   Branch: Immediately address critical bugs and the `git race` issue to ensure foundational stability.
│   Actions: Fix `CRITICAL #BUG-2` (Git `merge-tree` `--name-only`).; Fix `HIGH #BUG-3` (Awk `count_changed` miscounts deletions).; Address `Parallel sessions on one checkout race git` (#229), potentially exploring worktrees.; Resolve `Sensitive GCal credentials exposed` (#233).
│   Benefit: Eliminates critical failure points, prevents data corruption, and enables reliable scaling of parallel operations.
│   Trade-off: Pauses feature development, delaying immediate North Star capabilities.

├── **Empower Director's Chair with Project Insights** — ⏳ PURSUE LATER
│   _While crucial for the North Star, this relies on a stable and functional core, which needs to be addressed first._
│   Branch: Develop Polaris's self-reporting and strategic planning capabilities.
│   Actions: Build `Polaris: full project report + direction mind map` (#225).; Implement `Tier list — rank what I want done across the board` (#227).; Explore `Structured output (e.g., JSON) for programmatic consumption of conflict reports` (Idea Funnel).
│   Benefit: Provides the 'director' with the necessary data and tools for steering, fulfilling the 'run from the director’s chair' vision.
│   Trade-off: Less direct impact on automated execution, relies on a stable underlying system.

├── **Expand to Large-Scale, Multi-Branch Production** — ⏳ PURSUE LATER
│   _This is a major strategic pivot that requires the current core system to be robust and bug-free before attempting such an expansion._
│   Branch: Architect and implement the framework for managing multiple repositories and complex production pipelines.
│   Actions: Initiate `Multi-repo production mode` (on-course idea).; Develop `Fan-out nights — parallel lanes with an integrator` (on-course idea).; Design `Workflow templates — reusable production pipelines` (on-course idea).; Address `WIP limit on unmerged branches` (on-course idea).
│   Benefit: Unlocks the full potential of 'large-scale, multi-branch production systems' and 'executor fleets build overnight in parallel lanes'.
│   Trade-off: Significant architectural effort, requires a highly stable and reliable single-repo foundation first.

└── **Optimise Claude's Capabilities & Skillset** — ⏳ PURSUE LATER
    _While important for long-term AI capability, this is an optimisation that can follow after core functionality and stability are secured._
    Branch: Focus on managing and refining the AI's operational skills and knowledge base.
    Actions: Build `Claude skill tree — manage the skills that shape Claude` (#228).; Explore `Advanced conflict analysis, including type detection or language-aware parsing` (Idea Funnel).; Develop `Claude mastery loop — learn from every session` (on-course idea).
    Benefit: Enhances the intelligence and effectiveness of the autopilot fleet, making it more capable and adaptable.
    Trade-off: Less immediate impact on core automation infrastructure or director oversight, could be seen as an optimisation.
```

---

## Detail

### 1. Finalise Core Autopilot & Mission Control

**✅ PURSUE NOW** — These are high-value features directly advancing the North Star, and some work is already in progress or awaiting merge.

Merge `auto/item-224`, complete `Polaris musts`, and push through the Google Calendar sync and merge advisor features.

**Key actions:** Human reviews and merges `auto/item-224` for #235.; Complete and push `PolarisTerm.tsx` and `a329e47` for #215/#216/#219.; Implement Google Calendar sync (#222, #230, #231, #232).; Build Merge advisor (#223, #234).

**Benefit:** Delivers key features for autonomous operation and director oversight, improving merge reliability and scheduling.

**Trade-off:** Defers critical bug fixes and architectural scaling, potentially building on shaky ground.

---

### 2. Fortify Core Git Operations & Parallelism

**✅ PURSUE NOW** — Unaddressed critical bugs and architectural flaws will undermine all future feature development and trust in the system.

Immediately address critical bugs and the `git race` issue to ensure foundational stability.

**Key actions:** Fix `CRITICAL #BUG-2` (Git `merge-tree` `--name-only`).; Fix `HIGH #BUG-3` (Awk `count_changed` miscounts deletions).; Address `Parallel sessions on one checkout race git` (#229), potentially exploring worktrees.; Resolve `Sensitive GCal credentials exposed` (#233).

**Benefit:** Eliminates critical failure points, prevents data corruption, and enables reliable scaling of parallel operations.

**Trade-off:** Pauses feature development, delaying immediate North Star capabilities.

---

### 3. Empower Director's Chair with Project Insights

**⏳ PURSUE LATER** — While crucial for the North Star, this relies on a stable and functional core, which needs to be addressed first.

Develop Polaris's self-reporting and strategic planning capabilities.

**Key actions:** Build `Polaris: full project report + direction mind map` (#225).; Implement `Tier list — rank what I want done across the board` (#227).; Explore `Structured output (e.g., JSON) for programmatic consumption of conflict reports` (Idea Funnel).

**Benefit:** Provides the 'director' with the necessary data and tools for steering, fulfilling the 'run from the director’s chair' vision.

**Trade-off:** Less direct impact on automated execution, relies on a stable underlying system.

---

### 4. Expand to Large-Scale, Multi-Branch Production

**⏳ PURSUE LATER** — This is a major strategic pivot that requires the current core system to be robust and bug-free before attempting such an expansion.

Architect and implement the framework for managing multiple repositories and complex production pipelines.

**Key actions:** Initiate `Multi-repo production mode` (on-course idea).; Develop `Fan-out nights — parallel lanes with an integrator` (on-course idea).; Design `Workflow templates — reusable production pipelines` (on-course idea).; Address `WIP limit on unmerged branches` (on-course idea).

**Benefit:** Unlocks the full potential of 'large-scale, multi-branch production systems' and 'executor fleets build overnight in parallel lanes'.

**Trade-off:** Significant architectural effort, requires a highly stable and reliable single-repo foundation first.

---

### 5. Optimise Claude's Capabilities & Skillset

**⏳ PURSUE LATER** — While important for long-term AI capability, this is an optimisation that can follow after core functionality and stability are secured.

Focus on managing and refining the AI's operational skills and knowledge base.

**Key actions:** Build `Claude skill tree — manage the skills that shape Claude` (#228).; Explore `Advanced conflict analysis, including type detection or language-aware parsing` (Idea Funnel).; Develop `Claude mastery loop — learn from every session` (on-course idea).

**Benefit:** Enhances the intelligence and effectiveness of the autopilot fleet, making it more capable and adaptable.

**Trade-off:** Less immediate impact on core automation infrastructure or director oversight, could be seen as an optimisation.


---

## Recommended Next Arc

The immediate recommended arc is to concurrently 'Fortify Core Git Operations & Parallelism' and 'Finalise Core Autopilot & Mission Control'. Addressing critical bugs and architectural flaws (Direction 2) is paramount to ensure the stability and reliability of the system, preventing future failures. Simultaneously, completing the in-progress and high-value features (Direction 1) will deliver tangible progress towards the North Star, building on a newly stabilised foundation.

---

_Generated by `scripts/polaris_analysis.sh` · Stack Polaris (#225)_
