---
name: unity-gameplay-patterns
description: Use common Unity gameplay architecture patterns without hiding ownership inside scenes or inspector wiring.
origin: everything-game-dev-code
category: unity
---

# Unity Gameplay Patterns

## Purpose
Use common Unity gameplay architecture patterns without hiding ownership inside scenes or inspector wiring.

## Use When
- building Unity gameplay systems
- scene and prefab complexity is growing
- system lifetime is unclear

## Inputs
- feature behavior
- scene flow
- data needs
- performance constraints

## Process
1. define runtime ownership and initialization order
2. keep authored data, runtime state, and view behavior distinct
3. use prefabs and ScriptableObjects intentionally
4. avoid accidental singleton sprawl and broad Find usage
5. document scene and system lifetime rules

## Outputs
- Unity gameplay architecture notes
- lifecycle map
- pattern choices
- anti-pattern warnings

## Quality Bar
- respects Unity lifecycle, serialization, and content authoring realities
- keeps editor/runtime/test boundaries clean
- prevents scene, prefab, and package complexity from becoming hidden architecture

## Common Failure Modes
- inspector wiring being the only source of truth
- overusing MonoBehaviours or scene setup as architecture
- package or scene drift reaching release without review

## Related Agents
- unity-reviewer
- technical-design-lead
- gameplay-programmer

## Related Commands
- unity-review
- tech-design
- unity-scene-audit

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
