---
name: audio-implementation
description: Integrate music, SFX, VO, mixing, and reactive audio behavior so audio supports gameplay and UX.
origin: everything-game-dev-code
category: art-audio-content
---

# Audio Implementation

## Purpose
Integrate music, SFX, VO, mixing, and reactive audio behavior so audio supports gameplay and UX.

## Use When
- audio content is entering implementation
- mixing is unclear
- audio cues matter for gameplay or accessibility

## Inputs
- audio design goals
- event map
- platform constraints
- subtitle or accessibility requirements

## Process
1. define event-driven audio behaviors and ownership
2. set category mixing and ducking rules
3. handle looping, transitions, and interrupt behavior deliberately
4. ensure critical information is not audio-only without backup
5. test audio in representative gameplay contexts

## Outputs
- audio implementation map
- mixing rules
- event-trigger notes
- accessibility follow-up items

## Quality Bar
- is usable by content creators without tribal knowledge
- respects quality bars and runtime constraints together
- defines validation and ownership for content flow

## Common Failure Modes
- style consistency that ignores gameplay readability
- manual pipeline steps that create drift
- content that cannot be validated before release

## Related Agents
- audio-designer
- ui-ux-designer
- accessibility-reviewer

## Related Commands
- audio-pass
- verify
- update-docs

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
