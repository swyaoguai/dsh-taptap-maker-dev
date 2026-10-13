---
name: unity-project-structure
description: Organize Unity project paths so code, content, tests, editor tooling, and build assets stay discoverable and maintainable.
origin: everything-game-dev-code
category: unity
---

# Unity Project Structure

## Purpose
Organize Unity project paths so code, content, tests, editor tooling, and build assets stay discoverable and maintainable.

## Use When
- the Unity project structure is drifting
- new teams or plugins are being added
- content scale is increasing

## Inputs
- current folder layout
- asmdef plan
- content ownership
- tooling and test needs

## Process
1. define folder boundaries for runtime, editor, tests, and content
2. align structure with module ownership and build concerns
3. separate shared, third-party, and deprecated content clearly
4. document non-obvious conventions
5. review merge and reference risk before large moves

## Outputs
- Unity structure map
- folder rules
- migration notes if needed
- ownership boundaries

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
- tools-programmer
- technical-artist

## Related Commands
- unity-setup
- unity-review
- unity-scene-audit

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
