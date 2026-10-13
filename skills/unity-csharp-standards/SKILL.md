---
name: unity-csharp-standards
description: Apply Unity-specific C# standards that preserve readability, testability, and safe engine integration.
origin: everything-game-dev-code
category: unity
---

# Unity Csharp Standards

## Purpose
Apply Unity-specific C# standards that preserve readability, testability, and safe engine integration.

## Use When
- starting or refactoring Unity gameplay code
- MonoBehaviours are becoming too large
- code review needs consistent expectations

## Inputs
- feature scope
- existing architecture
- performance constraints
- team conventions

## Process
1. keep gameplay logic testable outside Unity where practical
2. limit MonoBehaviour responsibility to composition and engine-facing glue
3. separate runtime, editor, and test code cleanly
4. control serialization and inspector exposure intentionally
5. watch allocation-heavy patterns in hot paths

## Outputs
- coding guideline application
- review notes
- refactor targets
- safer engine integration

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
- code-reviewer
- gameplay-programmer

## Related Commands
- unity-review
- refactor-clean
- verify

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
