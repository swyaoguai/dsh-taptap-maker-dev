---
name: godot-gdscript-standards
description: Apply GDScript standards that keep scene-driven projects readable, maintainable, and safe to refactor.
origin: everything-game-dev-code
category: godot
---

# Godot Gdscript Standards

## Purpose
Apply GDScript standards that keep scene-driven projects readable, maintainable, and safe to refactor.

## Use When
- writing or reviewing Godot gameplay code in GDScript
- scene scripts are taking on too much responsibility
- consistency is slipping

## Inputs
- feature scope
- scene architecture
- team conventions
- performance constraints

## Process
1. keep scripts focused on clear scene or system responsibility
2. avoid hidden coupling through node paths and implicit scene assumptions
3. separate data, scene orchestration, and reusable logic where practical
4. watch signal lifecycle and autoload dependence
5. review allocations and expensive work in frequent callbacks

## Outputs
- GDScript guideline application
- review findings
- refactor candidates
- scene coupling warnings

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
- code-reviewer
- gameplay-programmer

## Related Commands
- godot-review
- refactor-clean
- verify

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
