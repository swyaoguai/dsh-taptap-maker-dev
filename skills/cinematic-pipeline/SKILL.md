---
name: cinematic-pipeline
description: Plan and implement cinematic content without breaking gameplay flow, performance, or content maintainability.
origin: everything-game-dev-code
category: art-audio-content
---

# Cinematic Pipeline

## Purpose
Plan and implement cinematic content without breaking gameplay flow, performance, or content maintainability.

## Use When
- cutscenes or in-engine cinematics are being added
- camera and sequencing complexity is growing
- cinematic content risks blocking production

## Inputs
- narrative beats
- animation content
- camera goals
- performance limits

## Process
1. define what is authored as cinematic versus emergent gameplay
2. coordinate camera, animation, audio, subtitles, and transitions
3. plan skip, failover, and replay behavior
4. validate memory and streaming impact for heavy sequences
5. document ownership of edits, timelines, and dependencies

## Outputs
- cinematic implementation plan
- transition rules
- skip/fallback behavior
- content dependency list

## Quality Bar
- is usable by content creators without tribal knowledge
- respects quality bars and runtime constraints together
- defines validation and ownership for content flow

## Common Failure Modes
- style consistency that ignores gameplay readability
- manual pipeline steps that create drift
- content that cannot be validated before release

## Related Agents
- narrative-designer
- animation-programmer
- audio-designer

## Related Commands
- update-docs
- verify
- perf-budget

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
