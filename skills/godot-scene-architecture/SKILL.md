---
name: godot-scene-architecture
description: Structure scenes, nodes, autoloads, and resources so Godot projects remain scalable and understandable.
origin: everything-game-dev-code
category: godot
---

# Godot Scene Architecture

## Purpose
Structure scenes, nodes, autoloads, and resources so Godot projects remain scalable and understandable.

## Use When
- scene nesting is growing
- autoloads are becoming global dumping grounds
- node ownership is unclear

## Inputs
- feature behavior
- scene tree patterns
- autoload list
- resource and signal usage

## Process
1. define what belongs in scenes, autoloads, and reusable resources
2. keep node hierarchy and responsibility understandable
3. avoid brittle hardcoded node path dependencies
4. control signal ownership and scene lifetime carefully
5. document scene composition patterns for the team

## Outputs
- scene architecture notes
- autoload boundary rules
- signal and ownership guidance
- anti-pattern warnings

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
- gameplay-programmer
- ui-programmer

## Related Commands
- godot-review
- godot-scene-audit
- tech-design

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
