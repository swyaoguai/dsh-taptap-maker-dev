---
name: unreal-testing
description: Choose effective Unreal automation and integration test layers without over-relying on brittle map-level tests.
origin: everything-game-dev-code
category: unreal
---

# Unreal Testing

## Purpose
Choose effective Unreal automation and integration test layers without over-relying on brittle map-level tests.

## Use When
- adding Unreal tests
- automation coverage is weak
- replication and asset integration bugs are recurring

## Inputs
- feature risk profile
- automation support
- map dependencies
- CI capacity

## Process
1. use deterministic tests for C++ logic where possible
2. use automation tests for subsystem and editor validation
3. reserve heavier integration tests for real risk areas
4. stabilize map and asset assumptions
5. label gating versus informational test suites clearly

## Outputs
- Unreal test strategy
- automation opportunities
- fixture cautions
- CI notes

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
- qa-lead
- build-engineer

## Related Commands
- unreal-review
- verify
- qa-plan

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
