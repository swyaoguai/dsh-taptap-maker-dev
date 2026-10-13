---
name: technical-art-pipeline
description: Align content creation, shaders, import settings, runtime presentation, and performance constraints.
origin: everything-game-dev-code
category: art-audio-content
---

# Technical Art Pipeline

## Purpose
Align content creation, shaders, import settings, runtime presentation, and performance constraints.

## Use When
- art production needs stronger technical guardrails
- visual features are causing instability
- tooling or shader workflow is scaling up

## Inputs
- art style
- engine constraints
- platform budgets
- asset pipeline

## Process
1. define the supported content and shader path
2. set import and material standards by asset class
3. document validation and troubleshooting flow
4. coordinate with build, performance, and rendering owners
5. flag high-risk features before they spread across the project

## Outputs
- technical art pipeline
- shader/material rules
- validation checklist
- production guardrails

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
- build-engineer
- performance-reviewer

## Related Commands
- tools-pass
- verify
- perf-budget

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
