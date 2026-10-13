---
name: godot-performance
description: Profile Godot runtime, scene, rendering, and resource behavior based on representative builds and content.
origin: everything-game-dev-code
category: godot
---

# Godot Performance

## Purpose
Profile Godot runtime, scene, rendering, and resource behavior based on representative builds and content.

## Use When
- performance targets are at risk
- scene and resource complexity is rising
- platform exports are diverging

## Inputs
- target hardware
- representative scenes
- current metrics
- content and architecture assumptions

## Process
1. profile representative exported builds or representative runtime conditions
2. separate script, rendering, memory, and scene-tree costs
3. review signal churn, node count, resource loading, and draw behavior together
4. prioritize changes by measured impact
5. track baseline metrics through milestones

## Outputs
- profiling summary
- bottleneck map
- optimization priorities
- baseline notes

## Quality Bar
- respects scene-tree ownership, autoload boundaries, and resource behavior
- keeps scripts, signals, and resources understandable at scale
- supports export reliability and content iteration without hidden coupling

## Common Failure Modes
- autoloads becoming global dumping grounds
- signal webs with no ownership
- shared resources causing accidental state leakage

## Related Agents
- godot-reviewer
- performance-reviewer
- technical-artist

## Related Commands
- godot-review
- perf-budget
- verify

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
