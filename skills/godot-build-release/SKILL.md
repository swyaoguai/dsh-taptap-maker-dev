---
name: godot-build-release
description: Run Godot export, CI, and release packaging with reproducible presets and platform-aware checks.
origin: everything-game-dev-code
category: godot
---

# Godot Build Release

## Purpose
Run Godot export, CI, and release packaging with reproducible presets and platform-aware checks.

## Use When
- shipping Godot builds
- export presets are fragile
- platform packaging issues are recurring

## Inputs
- export presets
- target platforms
- addon state
- release checklist

## Process
1. script or standardize export entry points
2. capture Godot version, export preset, platform target, and addon state in logs
3. validate startup, resources, localization, and platform assets before release candidates
4. treat each platform as its own risk surface
5. tie exports to QA and release readiness

## Outputs
- Godot build pipeline notes
- platform risk list
- artifact expectations
- release validation targets

## Quality Bar
- respects scene-tree ownership, autoload boundaries, and resource behavior
- keeps scripts, signals, and resources understandable at scale
- supports export reliability and content iteration without hidden coupling

## Common Failure Modes
- autoloads becoming global dumping grounds
- signal webs with no ownership
- shared resources causing accidental state leakage

## Related Agents
- godot-build-resolver
- build-engineer
- release-manager

## Related Commands
- godot-build-fix
- release-check
- verify

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
