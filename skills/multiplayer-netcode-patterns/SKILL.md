---
name: multiplayer-netcode-patterns
description: Define ownership, authority, replication, prediction, rollback or reconciliation strategy for multiplayer systems.
origin: everything-game-dev-code
category: engineering-common
---

# Multiplayer Netcode Patterns

## Purpose
Define ownership, authority, replication, prediction, rollback or reconciliation strategy for multiplayer systems.

## Use When
- the project has multiplayer or networked state sync
- lag and authority issues are emerging
- a feature could break under latency

## Inputs
- game rules
- authority model
- platform/network constraints
- security assumptions

## Process
1. define trusted authority and client responsibilities
2. choose replication and prediction strategy by system
3. document disconnect, reconnect, and failure handling
4. profile bandwidth and state churn
5. plan cheat resistance, QA coverage, and telemetry

## Outputs
- netcode model
- ownership matrix
- latency/failure handling rules
- test and telemetry targets

## Quality Bar
- makes ownership, state flow, and failure behavior explicit
- improves maintainability without over-abstracting
- supports testing, debugging, and safe iteration

## Common Failure Modes
- coupling systems through hidden globals or timing assumptions
- writing logic that is hard to test or debug
- optimizing the wrong layer before measuring

## Related Agents
- network-programmer
- security-reviewer
- qa-lead

## Related Commands
- multiplayer-review
- tech-design
- verify

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
