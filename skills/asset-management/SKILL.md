---
name: asset-management
description: Keep content discoverable, versioned, licensed, budgeted, and safe to move through the pipeline.
origin: everything-game-dev-code
category: engineering-common
---

# Asset Management

## Purpose
Keep content discoverable, versioned, licensed, budgeted, and safe to move through the pipeline.

## Use When
- asset count is growing
- ownership is unclear
- duplicate or stale content is increasing

## Inputs
- asset taxonomy
- naming rules
- budget expectations
- third-party content list

## Process
1. classify assets by purpose and ownership
2. separate source, runtime, third-party, and deprecated content
3. track metadata that matters for maintenance and release
4. remove or archive drift and duplication intentionally
5. validate pipeline assumptions before late production

## Outputs
- asset registry
- ownership notes
- deprecation list
- validation targets

## Quality Bar
- makes ownership, state flow, and failure behavior explicit
- improves maintainability without over-abstracting
- supports testing, debugging, and safe iteration

## Common Failure Modes
- coupling systems through hidden globals or timing assumptions
- writing logic that is hard to test or debug
- optimizing the wrong layer before measuring

## Related Agents
- technical-artist
- producer
- build-engineer

## Related Commands
- tools-pass
- verify
- release-check

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
