---
name: godot-resource-management
description: Manage Godot resources, scenes, and imported assets so references, loading, and sharing behavior remain safe and efficient.
origin: everything-game-dev-code
category: godot
---

# Godot Resource Management

## Purpose
Manage Godot resources, scenes, and imported assets so references, loading, and sharing behavior remain safe and efficient.

## Use When
- resource count is rising
- shared resources are causing side effects
- loading and duplication behavior are unclear

## Inputs
- resource types
- scene usage
- loading rules
- memory targets

## Process
1. define how shared resources are authored and consumed
2. separate mutable runtime state from reusable resource data
3. watch for accidental global changes through shared resources
4. document loading and duplication expectations
5. test resource-heavy flows under representative usage

## Outputs
- resource usage rules
- loading strategy notes
- shared-state cautions
- validation targets

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
- technical-design-lead
- technical-artist

## Related Commands
- godot-review
- perf-budget
- verify

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
