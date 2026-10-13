---
name: unreal-performance
description: Profile packaged Unreal builds on target hardware and connect fixes to the real bottleneck domain.
origin: everything-game-dev-code
category: unreal
---

# Unreal Performance

## Purpose
Profile packaged Unreal builds on target hardware and connect fixes to the real bottleneck domain.

## Use When
- performance targets are at risk
- rendering and streaming are scaling up
- multiplayer or open world systems are growing

## Inputs
- target hardware
- representative maps
- current metrics
- content and module assumptions

## Process
1. profile packaged builds instead of relying only on editor sessions
2. separate CPU, GPU, memory, streaming, and replication costs
3. review Blueprint, Tick, actor lifetime, and rendering contributors together
4. prioritize fixes by measured player impact
5. track benchmark baselines through milestones

## Outputs
- profiling summary
- bottleneck map
- optimization priorities
- baseline tracking notes

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
- performance-reviewer
- technical-artist

## Related Commands
- unreal-review
- perf-budget
- verify

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
