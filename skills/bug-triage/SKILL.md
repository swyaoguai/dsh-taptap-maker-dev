---
name: bug-triage
description: Classify bugs by player impact, reproducibility, severity, and milestone risk so the team fixes the right things first.
origin: everything-game-dev-code
category: qa-release
---

# Bug Triage

## Purpose
Classify bugs by player impact, reproducibility, severity, and milestone risk so the team fixes the right things first.

## Use When
- defect count is rising
- milestone pressure is increasing
- teams disagree on severity or priority

## Inputs
- bug reports
- current milestone goals
- known risk areas
- repro evidence

## Process
1. separate severity from scheduling priority
2. group by systemic root cause where possible
3. identify blockers, regressions, and duplicates
4. assign owners and verification expectations
5. track waived issues explicitly

## Outputs
- triaged bug list
- priority buckets
- root-cause clusters
- waiver or escalation notes

## Quality Bar
- turns risk into explicit evidence and ownership
- keeps release blockers visible instead of implicit
- connects quality decisions to milestone and platform impact

## Common Failure Modes
- severity inflation or minimization without player-impact context
- treating waived risks as invisible
- submission checklists that are incomplete or stale

## Related Agents
- qa-lead
- producer
- release-manager

## Related Commands
- bug-triage
- verify
- release-check

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
