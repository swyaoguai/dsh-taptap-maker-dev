---
name: unity-testing
description: Choose the right mix of plain C#, edit mode, play mode, and smoke testing for Unity features.
origin: everything-game-dev-code
category: unity
---

# Unity Testing

## Purpose
Choose the right mix of plain C#, edit mode, play mode, and smoke testing for Unity features.

## Use When
- adding Unity tests
- test suites are slow or brittle
- engine-specific regressions are slipping through

## Inputs
- feature risk profile
- test harness availability
- scene dependencies
- CI limits

## Process
1. push deterministic logic into plain C# tests where possible
2. use edit mode for engine-integrated but non-playmode logic
3. reserve play mode for lifecycle and integration-sensitive behavior
4. stabilize fixtures and scene assumptions
5. mark gating versus informational suites explicitly

## Outputs
- test-layer strategy
- candidate test cases
- CI coverage notes
- flakiness reduction plan

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
- qa-lead
- gameplay-programmer

## Related Commands
- unity-review
- verify
- qa-plan

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
