---
name: memory-budgeting
description: Define residency and memory budgets so content, streaming, and runtime systems fit target platforms.
origin: everything-game-dev-code
category: engineering-common
---

# Memory Budgeting

## Purpose
Define residency and memory budgets so content, streaming, and runtime systems fit target platforms.

## Use When
- the project has constrained hardware targets
- memory spikes cause instability
- large content sets are growing

## Inputs
- target platforms
- asset classes
- streaming model
- system residency assumptions

## Process
1. budget memory by asset and system class
2. define who owns loading and unloading decisions
3. measure peak and steady-state memory in representative flows
4. flag accidental hard references or pinned content
5. connect fixes to content and architecture owners

## Outputs
- memory budget sheet
- residency rules
- peak-memory review notes
- ownership map

## Quality Bar
- makes ownership, state flow, and failure behavior explicit
- improves maintainability without over-abstracting
- supports testing, debugging, and safe iteration

## Common Failure Modes
- coupling systems through hidden globals or timing assumptions
- writing logic that is hard to test or debug
- optimizing the wrong layer before measuring

## Related Agents
- performance-reviewer
- technical-artist
- build-engineer

## Related Commands
- memory-budget
- verify
- release-check

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
