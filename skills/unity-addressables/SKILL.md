---
name: unity-addressables
description: Use Addressables with explicit grouping, loading, update, and fallback rules instead of ad hoc content loading.
origin: everything-game-dev-code
category: unity
---

# Unity Addressables

## Purpose
Use Addressables with explicit grouping, loading, update, and fallback rules instead of ad hoc content loading.

## Use When
- the Unity project uses Addressables
- downloadable or patchable content exists
- memory and content lifetime need stronger structure

## Inputs
- content groups
- platform needs
- patching model
- offline behavior requirements

## Process
1. group content by lifetime, dependency behavior, and update cadence
2. avoid scattered string-based address lookups
3. document environment and catalog strategy
4. test offline, slow-download, cache, and corruption cases
5. review patch-size and duplication risk before release

## Outputs
- Addressables strategy
- group rules
- loading/fallback expectations
- QA scenarios

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
- build-engineer
- technical-artist

## Related Commands
- unity-review
- unity-build-fix
- verify

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
