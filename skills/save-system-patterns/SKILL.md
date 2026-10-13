---
name: save-system-patterns
description: Define reliable persistence boundaries, save formats, recovery behavior, and migration policy.
origin: everything-game-dev-code
category: engineering-common
---

# Save System Patterns

## Purpose
Define reliable persistence boundaries, save formats, recovery behavior, and migration policy.

## Use When
- the game needs persistent progress or settings
- save corruption risk exists
- schema changes are likely

## Inputs
- state ownership map
- progression model
- platform limits
- backward-compatibility expectations

## Process
1. identify what must persist and when
2. design versioning and migration strategy
3. handle partial writes, invalid data, and fallback behavior
4. separate runtime objects from persistent data representation
5. define tests and release gates for save compatibility

## Outputs
- save model
- migration strategy
- error-handling policy
- save QA checklist

## Quality Bar
- makes ownership, state flow, and failure behavior explicit
- improves maintainability without over-abstracting
- supports testing, debugging, and safe iteration

## Common Failure Modes
- coupling systems through hidden globals or timing assumptions
- writing logic that is hard to test or debug
- optimizing the wrong layer before measuring

## Related Agents
- technical-design-lead
- gameplay-programmer
- qa-lead

## Related Commands
- save-system-review
- tech-design
- verify

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
