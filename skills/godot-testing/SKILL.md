---
name: godot-testing
description: Choose effective automated and manual test layers for Godot features without overcomplicating the project.
origin: everything-game-dev-code
category: godot
---

# Godot Testing

## Purpose
Choose effective automated and manual test layers for Godot features without overcomplicating the project.

## Use When
- adding tests to Godot systems
- scene-driven bugs are recurring
- CI and export confidence need improvement

## Inputs
- feature risk profile
- test tools
- scene dependencies
- export targets

## Process
1. cover deterministic logic with fast tests where possible
2. use scene-level tests only where lifecycle or integration risk justifies them
3. stabilize node and signal assumptions in fixtures
4. separate gating from exploratory or informational tests
5. track export and startup smoke coverage

## Outputs
- Godot test strategy
- candidate test cases
- fixture cautions
- CI notes

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
- qa-lead
- build-engineer

## Related Commands
- godot-review
- verify
- qa-plan

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
