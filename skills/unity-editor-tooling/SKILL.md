---
name: unity-editor-tooling
description: Create Unity editor tools that make content production safer, faster, and less dependent on tribal knowledge.
origin: everything-game-dev-code
category: unity
---

# Unity Editor Tooling

## Purpose
Create Unity editor tools that make content production safer, faster, and less dependent on tribal knowledge.

## Use When
- content workflows rely on repeated manual steps
- validation is too manual
- artists or designers need safer editor flows

## Inputs
- workflow pain points
- asset and scene patterns
- validation needs
- editor architecture

## Process
1. identify the smallest high-value editor intervention
2. keep tools in editor-only boundaries
3. support safe bulk changes and useful summaries
4. document production-critical tools clearly
5. retire or mark abandoned tools instead of leaving silent clutter

## Outputs
- tooling design
- validation helpers
- editor workflow notes
- maintenance ownership

## Quality Bar
- respects Unity lifecycle, serialization, and content authoring realities
- keeps editor/runtime/test boundaries clean
- prevents scene, prefab, and package complexity from becoming hidden architecture

## Common Failure Modes
- inspector wiring being the only source of truth
- overusing MonoBehaviours or scene setup as architecture
- package or scene drift reaching release without review

## Related Agents
- tools-programmer
- unity-reviewer
- technical-artist

## Related Commands
- unity-review
- tools-pass
- unity-scene-audit

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
