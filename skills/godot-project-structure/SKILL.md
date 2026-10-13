---
name: godot-project-structure
description: Organize Godot project files so scenes, scripts, resources, addons, tests, and export assets stay predictable.
origin: everything-game-dev-code
category: godot
---

# Godot Project Structure

## Purpose
Organize Godot project files so scenes, scripts, resources, addons, tests, and export assets stay predictable.

## Use When
- the Godot project layout is drifting
- addons and scene count are increasing
- ownership is becoming unclear

## Inputs
- current layout
- autoload plan
- resource usage
- addon and export needs

## Process
1. separate core scenes, scripts, addons, resources, and tests intentionally
2. organize by feature or stable domain rather than catch-all folders
3. keep generated or imported content distinct from authored runtime assets
4. document naming and scene ownership rules
5. review move and rename risk before broad restructuring

## Outputs
- Godot structure map
- folder rules
- ownership notes
- migration cautions

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
- tools-programmer
- technical-artist

## Related Commands
- godot-setup
- godot-review
- godot-scene-audit

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
