---
name: unreal-project-structure
description: Organize Unreal code, plugins, content, and config so ownership and build behavior stay clear.
origin: everything-game-dev-code
category: unreal
---

# Unreal Project Structure

## Purpose
Organize Unreal code, plugins, content, and config so ownership and build behavior stay clear.

## Use When
- the Unreal project layout is drifting
- plugins and modules are increasing
- content organization is becoming inconsistent

## Inputs
- current project layout
- module strategy
- content ownership
- build and plugin constraints

## Process
1. define boundaries for source, plugins, content, config, and tests
2. organize content by feature or stable domain rather than chaos folders
3. plan redirector cleanup and rename discipline
4. align module boundaries with ownership
5. document non-obvious structure choices

## Outputs
- Unreal structure map
- content boundary rules
- module ownership notes
- migration cautions

## Quality Bar
- respects Unreal framework ownership, packaging, and content pipeline realities
- keeps C++, Blueprints, plugins, and content boundaries intentional
- makes replication, map setup, and packaging risk explicit

## Common Failure Modes
- Blueprint graph sprawl hiding ownership
- using Tick where event-driven logic is clearer
- packaging or plugin state changing without documentation

## Related Agents
- unreal-reviewer
- build-engineer
- technical-artist

## Related Commands
- unreal-setup
- unreal-review
- unreal-blueprint-audit

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
