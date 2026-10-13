---
name: unreal-editor-tooling
description: Create Unreal editor tools, validators, utility widgets, or commandlets that reduce manual work and pipeline risk.
origin: everything-game-dev-code
category: unreal
---

# Unreal Editor Tooling

## Purpose
Create Unreal editor tools, validators, utility widgets, or commandlets that reduce manual work and pipeline risk.

## Use When
- content workflows are too manual
- asset validation is inconsistent
- editor productivity needs safer tooling

## Inputs
- workflow pain points
- asset conventions
- validation needs
- engine/tooling constraints

## Process
1. pick the smallest high-value tooling intervention
2. build safe bulk-edit and validation behavior
3. document how the tool fits the pipeline
4. ensure failures explain how to recover
5. retire or mark obsolete tools instead of leaving hidden clutter

## Outputs
- editor tooling plan
- validator behavior
- workflow notes
- maintenance ownership

## Quality Bar
- respects Unreal framework ownership, packaging, and content pipeline realities
- keeps C++, Blueprints, plugins, and content boundaries intentional
- makes replication, map setup, and packaging risk explicit

## Common Failure Modes
- Blueprint graph sprawl hiding ownership
- using Tick where event-driven logic is clearer
- packaging or plugin state changing without documentation

## Related Agents
- tools-programmer
- unreal-reviewer
- technical-artist

## Related Commands
- tools-pass
- unreal-review
- unreal-blueprint-audit

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
