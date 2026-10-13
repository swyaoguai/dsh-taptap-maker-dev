---
name: godot-editor-tooling
description: Create Godot editor tools, inspectors, import helpers, and validation flows that reduce manual authoring risk.
origin: everything-game-dev-code
category: godot
---

# Godot Editor Tooling

## Purpose
Create Godot editor tools, inspectors, import helpers, and validation flows that reduce manual authoring risk.

## Use When
- content workflows are repetitive or fragile
- scene and resource validation is too manual
- designers need safer editor support

## Inputs
- workflow pain points
- scene/resource conventions
- validation needs
- addon constraints

## Process
1. identify the smallest useful tooling or validation addition
2. keep production-critical editor tools documented and owned
3. support safe bulk operations with clear summaries
4. make failures explainable and recoverable
5. retire abandoned tools instead of leaving hidden clutter

## Outputs
- editor tooling plan
- validation helpers
- workflow notes
- maintenance ownership

## Quality Bar
- respects scene-tree ownership, autoload boundaries, and resource behavior
- keeps scripts, signals, and resources understandable at scale
- supports export reliability and content iteration without hidden coupling

## Common Failure Modes
- autoloads becoming global dumping grounds
- signal webs with no ownership
- shared resources causing accidental state leakage

## Related Agents
- tools-programmer
- godot-reviewer
- technical-artist

## Related Commands
- tools-pass
- godot-review
- godot-scene-audit

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
