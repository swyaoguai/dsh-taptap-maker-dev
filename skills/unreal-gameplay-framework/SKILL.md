---
name: unreal-gameplay-framework
description: Use the Unreal gameplay framework intentionally so authority, ownership, and system lifetime are understandable.
origin: everything-game-dev-code
category: unreal
---

# Unreal Gameplay Framework

## Purpose
Use the Unreal gameplay framework intentionally so authority, ownership, and system lifetime are understandable.

## Use When
- building systems around GameMode, GameState, PlayerController, Pawn, subsystems, or GameInstance
- framework responsibilities are overlapping
- networking complicates ownership

## Inputs
- feature behavior
- single-player or multiplayer model
- state ownership needs
- map or travel flow

## Process
1. assign responsibilities to framework classes deliberately
2. separate authoritative logic, replicated state, and cosmetic behavior
3. document map travel, spawn, and persistence behavior
4. avoid broad hidden dependencies across framework classes
5. review test and debug visibility for framework-heavy features

## Outputs
- framework ownership map
- travel and persistence notes
- class responsibility boundaries
- implementation cautions

## Quality Bar
- respects Unreal framework ownership, packaging, and content pipeline realities
- keeps C++, Blueprints, plugins, and content boundaries intentional
- makes replication, map setup, and packaging risk explicit

## Common Failure Modes
- Blueprint graph sprawl hiding ownership
- using Tick where event-driven logic is clearer
- packaging or plugin state changing without documentation

## Related Agents
- unreal-reviewer
- technical-design-lead
- network-programmer

## Related Commands
- unreal-review
- tech-design
- multiplayer-review

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
