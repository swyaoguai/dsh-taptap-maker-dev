---
name: unreal-cpp-standards
description: Apply C++ standards that fit Unreal lifecycle, reflection, modules, and gameplay framework concerns.
origin: everything-game-dev-code
category: unreal
---

# Unreal CPP Standards

## Purpose
Apply C++ standards that fit Unreal lifecycle, reflection, modules, and gameplay framework concerns.

## Use When
- writing or reviewing Unreal C++
- C++ and Blueprint boundaries are unclear
- module quality needs consistency

## Inputs
- feature scope
- existing modules
- reflection and tooling needs
- performance constraints

## Process
1. keep ownership and responsibility explicit across engine classes
2. minimize leaking implementation details into public reflected APIs
3. document lifecycle-sensitive behavior such as possession, replication, and initialization
4. keep modules and dependencies intentional
5. review performance-heavy Tick and allocation patterns

## Outputs
- C++ guideline application
- API boundary notes
- review findings
- refactor candidates

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
- code-reviewer
- gameplay-programmer

## Related Commands
- unreal-review
- refactor-clean
- verify

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
