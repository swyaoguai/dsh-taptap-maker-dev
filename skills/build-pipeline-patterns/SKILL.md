---
name: build-pipeline-patterns
description: Structure build and CI pipelines so builds are reproducible, diagnosable, and release-friendly.
origin: everything-game-dev-code
category: engineering-common
---

# Build Pipeline Patterns

## Purpose
Structure build and CI pipelines so builds are reproducible, diagnosable, and release-friendly.

## Use When
- builds are fragile or manual
- multiple platforms or configurations exist
- release confidence depends on automation

## Inputs
- target platforms
- environment setup
- release process
- test and artifact requirements

## Process
1. define build entry points and environment assumptions
2. separate fast validation from full packaging
3. attach logs, metadata, and artifacts consistently
4. make versioning and configuration drift visible
5. link builds to QA and release gates

## Outputs
- build pipeline model
- artifact policy
- CI stage map
- release integration notes

## Quality Bar
- makes ownership, state flow, and failure behavior explicit
- improves maintainability without over-abstracting
- supports testing, debugging, and safe iteration

## Common Failure Modes
- coupling systems through hidden globals or timing assumptions
- writing logic that is hard to test or debug
- optimizing the wrong layer before measuring

## Related Agents
- build-engineer
- release-manager
- qa-lead

## Related Commands
- release-check
- verify
- plan

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
