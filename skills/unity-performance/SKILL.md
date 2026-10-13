---
name: unity-performance
description: Profile and optimize Unity projects based on player-build evidence, not editor intuition.
origin: everything-game-dev-code
category: unity
---

# Unity Performance

## Purpose
Profile and optimize Unity projects based on player-build evidence, not editor intuition.

## Use When
- frame time, GC, memory, or load issues appear
- content scale is rising
- release targets are approaching

## Inputs
- target hardware
- representative scenes
- current metrics
- content and architecture assumptions

## Process
1. profile player builds on target or representative hardware
2. separate CPU, GPU, GC, loading, and memory issues
3. review scene, prefab, asset, and code contributors together
4. prioritize fixes by measured impact
5. track performance baselines over time

## Outputs
- profiling summary
- optimization backlog
- baseline metrics
- owner-by-problem map

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
- performance-reviewer
- technical-artist

## Related Commands
- unity-review
- perf-budget
- verify

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
