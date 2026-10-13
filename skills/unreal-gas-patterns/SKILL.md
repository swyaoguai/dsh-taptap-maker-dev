---
name: unreal-gas-patterns
description: Use Gameplay Ability System or equivalent ability frameworks with clear ownership, data flow, and tuning hooks.
origin: everything-game-dev-code
category: unreal
---

# Unreal GAS Patterns

## Purpose
Use Gameplay Ability System or equivalent ability frameworks with clear ownership, data flow, and tuning hooks.

## Use When
- abilities, effects, attributes, or tags are central
- GAS complexity is spreading
- combat tuning needs stronger data boundaries

## Inputs
- combat design
- attribute model
- network authority needs
- content authoring model

## Process
1. define where abilities, effects, attributes, and tags live conceptually
2. separate data-driven tuning from hardcoded logic
3. coordinate replication, prediction, and failure handling
4. document tag taxonomies and extension rules
5. add debugging and validation for ability state transitions

## Outputs
- ability framework notes
- tag taxonomy
- data authoring rules
- debug checklist

## Quality Bar
- respects Unreal framework ownership, packaging, and content pipeline realities
- keeps C++, Blueprints, plugins, and content boundaries intentional
- makes replication, map setup, and packaging risk explicit

## Common Failure Modes
- Blueprint graph sprawl hiding ownership
- using Tick where event-driven logic is clearer
- packaging or plugin state changing without documentation

## Related Agents
- combat-designer
- network-programmer
- unreal-reviewer

## Related Commands
- combat-design
- unreal-review
- multiplayer-review

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
