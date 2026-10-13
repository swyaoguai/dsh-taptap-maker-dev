---
name: unity-urp-hdrp
description: Choose and operate Unity render pipelines with clear platform, tooling, shader, and content implications.
origin: everything-game-dev-code
category: unity
---

# Unity URP HDRP

## Purpose
Choose and operate Unity render pipelines with clear platform, tooling, shader, and content implications.

## Use When
- the project is choosing or changing URP/HDRP
- rendering complexity is increasing
- technical art needs stronger pipeline rules

## Inputs
- platform targets
- visual goals
- shader requirements
- team capability

## Process
1. justify the chosen render pipeline by product goals and hardware targets
2. document material, shader, lighting, and post-process constraints
3. identify migration risk before changing pipelines mid-project
4. profile representative content early
5. teach content creators the supported path

## Outputs
- render pipeline decision
- content guardrails
- migration notes
- performance expectations

## Quality Bar
- respects Unity lifecycle, serialization, and content authoring realities
- keeps editor/runtime/test boundaries clean
- prevents scene, prefab, and package complexity from becoming hidden architecture

## Common Failure Modes
- inspector wiring being the only source of truth
- overusing MonoBehaviours or scene setup as architecture
- package or scene drift reaching release without review

## Related Agents
- technical-artist
- unity-reviewer
- performance-reviewer

## Related Commands
- unity-review
- perf-budget
- update-docs

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
