---
name: unity-input-system
description: Implement Unity input with explicit action maps, device support, and UI/gameplay separation.
origin: everything-game-dev-code
category: unity
---

# Unity Input System

## Purpose
Implement Unity input with explicit action maps, device support, and UI/gameplay separation.

## Use When
- using Unity Input System or equivalent
- multiple devices are supported
- rebinds or accessibility are required

## Inputs
- action list
- supported devices
- UI flow
- accessibility requirements

## Process
1. define actions and maps by intent
2. coordinate gameplay, UI, pause, and overlay contexts
3. support rebinding and persistence where needed
4. test device switching and focus behavior
5. document platform-specific caveats

## Outputs
- input action model
- context rules
- rebind requirements
- test scenarios

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
- ui-programmer
- accessibility-reviewer

## Related Commands
- unity-review
- ui-flow-review
- verify

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
