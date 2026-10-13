---
name: unity-build-release
description: Run Unity builds, CI, and release packaging with reproducible configuration and platform-aware checks.
origin: everything-game-dev-code
category: unity
---

# Unity Build Release

## Purpose
Run Unity builds, CI, and release packaging with reproducible configuration and platform-aware checks.

## Use When
- shipping Unity builds
- CI is fragile
- platform-specific build issues are frequent

## Inputs
- target platforms
- build configs
- package state
- release checklist

## Process
1. script build entry points and environment setup
2. capture Unity version, platform target, defines, and package state in logs
3. validate scenes, Addressables, localization, and platform assets before release candidates
4. treat each platform as its own risk surface
5. tie build output to release readiness

## Outputs
- Unity build pipeline notes
- platform risk list
- artifact and log expectations
- release validation targets

## Quality Bar
- respects Unity lifecycle, serialization, and content authoring realities
- keeps editor/runtime/test boundaries clean
- prevents scene, prefab, and package complexity from becoming hidden architecture

## Common Failure Modes
- inspector wiring being the only source of truth
- overusing MonoBehaviours or scene setup as architecture
- package or scene drift reaching release without review

## Related Agents
- unity-build-resolver
- build-engineer
- release-manager

## Related Commands
- unity-build-fix
- release-check
- verify

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
