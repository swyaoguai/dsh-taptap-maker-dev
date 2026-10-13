---
name: unreal-blueprint-patterns
description: Use Blueprints for iteration and authored behavior without letting graph sprawl become hidden architecture.
origin: everything-game-dev-code
category: unreal
---

# Unreal Blueprint Patterns

## Purpose
Use Blueprints for iteration and authored behavior without letting graph sprawl become hidden architecture.

## Use When
- Blueprint usage is growing
- graph readability is poor
- ownership between Blueprints and C++ is unclear

## Inputs
- feature behavior
- designer iteration needs
- C++ boundaries
- performance constraints

## Process
1. decide what belongs in Blueprints versus C++
2. keep graphs readable and bounded by clear responsibility
3. avoid hidden coupling through map and asset setup alone
4. watch Tick usage, casts, and event sprawl
5. document the contract between C++ and Blueprint layers

## Outputs
- Blueprint boundary rules
- graph hygiene notes
- review checklist
- performance cautions

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
- ui-ux-designer
- tools-programmer

## Related Commands
- unreal-blueprint-audit
- unreal-review
- verify

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
