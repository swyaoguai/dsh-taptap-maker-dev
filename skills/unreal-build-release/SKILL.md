---
name: unreal-build-release
description: Run Unreal builds, packaging, CI, and release packaging with reproducible configuration and platform-aware checks.
origin: everything-game-dev-code
category: unreal
---

# Unreal Build Release

## Purpose
Run Unreal builds, packaging, CI, and release packaging with reproducible configuration and platform-aware checks.

## Use When
- shipping Unreal builds
- packaging is fragile
- engine or plugin state creates release risk

## Inputs
- target platforms
- build configs
- plugin/module state
- release checklist

## Process
1. script build and packaging entry points
2. capture engine version, config, and plugin state in logs
3. validate packaged content, map lists, online config, and platform assets before release candidates
4. treat each platform as its own risk surface
5. tie build output to QA and release readiness

## Outputs
- Unreal build pipeline notes
- platform risk list
- artifact expectations
- release validation targets

## Quality Bar
- respects Unreal framework ownership, packaging, and content pipeline realities
- keeps C++, Blueprints, plugins, and content boundaries intentional
- makes replication, map setup, and packaging risk explicit

## Common Failure Modes
- Blueprint graph sprawl hiding ownership
- using Tick where event-driven logic is clearer
- packaging or plugin state changing without documentation

## Related Agents
- unreal-build-resolver
- build-engineer
- release-manager

## Related Commands
- unreal-build-fix
- release-check
- verify

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
