---
name: unreal-replication
description: Implement and review Unreal replication with explicit ownership, relevancy, authority, and failure behavior.
origin: everything-game-dev-code
category: unreal
---

# Unreal Replication

## Purpose
Implement and review Unreal replication with explicit ownership, relevancy, authority, and failure behavior.

## Use When
- the project has replicated gameplay
- bandwidth or authority bugs are appearing
- client/server ownership is unclear

## Inputs
- authority model
- class ownership map
- prediction requirements
- network constraints

## Process
1. define what replicates and why
2. assign ownership across GameState, PlayerState, Controllers, Pawns, and Actors
3. choose relevancy and update strategy intentionally
4. test disconnect, reconnect, and edge latency cases
5. profile bandwidth and churn in realistic sessions

## Outputs
- replication model
- ownership matrix
- failure handling rules
- profiling targets

## Quality Bar
- respects Unreal framework ownership, packaging, and content pipeline realities
- keeps C++, Blueprints, plugins, and content boundaries intentional
- makes replication, map setup, and packaging risk explicit

## Common Failure Modes
- Blueprint graph sprawl hiding ownership
- using Tick where event-driven logic is clearer
- packaging or plugin state changing without documentation

## Related Agents
- network-programmer
- unreal-reviewer
- security-reviewer

## Related Commands
- multiplayer-review
- unreal-review
- verify

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
