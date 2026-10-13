---
name: tools-pipeline-patterns
description: Design internal tools and content pipelines that reduce manual work and make authoring safer.
origin: everything-game-dev-code
category: engineering-common
---

# Tools Pipeline Patterns

## Purpose
Design internal tools and content pipelines that reduce manual work and make authoring safer.

## Use When
- repeated manual steps create errors
- content scale is growing
- editor or import workflows need structure

## Inputs
- current workflow pain points
- content ownership
- automation opportunities
- team skill profile

## Process
1. identify repeatable pain and error sources
2. define the smallest useful tool or pipeline intervention
3. build safe validation and rollback into the workflow
4. document ownership and onboarding
5. measure whether the tool actually saves time or defects

## Outputs
- tooling proposal
- pipeline workflow notes
- validation behavior
- ownership and maintenance notes

## Quality Bar
- makes ownership, state flow, and failure behavior explicit
- improves maintainability without over-abstracting
- supports testing, debugging, and safe iteration

## Common Failure Modes
- coupling systems through hidden globals or timing assumptions
- writing logic that is hard to test or debug
- optimizing the wrong layer before measuring

## Related Agents
- tools-programmer
- technical-artist
- producer

## Related Commands
- tools-pass
- tech-design
- verify

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
