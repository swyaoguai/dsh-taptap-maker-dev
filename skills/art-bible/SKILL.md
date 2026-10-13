---
name: art-bible
description: Define a visual direction that artists, UI, technical art, and marketing can execute consistently.
origin: everything-game-dev-code
category: art-audio-content
---

# Art Bible

## Purpose
Define a visual direction that artists, UI, technical art, and marketing can execute consistently.

## Use When
- the visual style is still vague
- outsourcing or parallel art production is starting
- art consistency is drifting

## Inputs
- product pillars
- references
- platform targets
- camera and readability constraints

## Process
1. state the style pillars and what they exclude
2. define shape language, color intent, lighting mood, and material logic
3. show readability rules for gameplay-critical visuals
4. align the style with production capacity and technical limits
5. turn the bible into reviewable asset-class guidance

## Outputs
- art bible
- style pillars
- do/dont reference set
- readability rules

## Quality Bar
- is usable by content creators without tribal knowledge
- respects quality bars and runtime constraints together
- defines validation and ownership for content flow

## Common Failure Modes
- style consistency that ignores gameplay readability
- manual pipeline steps that create drift
- content that cannot be validated before release

## Related Agents
- technical-artist
- ui-ux-designer
- producer

## Related Commands
- update-docs
- verify
- vertical-slice

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
