---
name: crash-triage
description: Handle crashes as high-severity defects with reproducibility, symbol quality, clustering, and release impact in mind.
origin: everything-game-dev-code
category: qa-release
---

# Crash Triage

## Purpose
Handle crashes as high-severity defects with reproducibility, symbol quality, clustering, and release impact in mind.

## Use When
- crashes are reported in QA or live builds
- stack traces are noisy
- the team needs root-cause prioritization

## Inputs
- crash dumps or logs
- build symbols
- repro steps if any
- frequency and environment data

## Process
1. group crashes by likely signature and root cause
2. separate deterministic repros from low-signal incidents
3. check if symbols and build metadata are sufficient
4. identify release blockers and likely owner systems
5. track verification once fixes land

## Outputs
- crash cluster report
- owner assignment
- repro notes
- release impact summary

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
- build-engineer
- release-manager

## Related Commands
- bug-triage
- release-check
- verify

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
