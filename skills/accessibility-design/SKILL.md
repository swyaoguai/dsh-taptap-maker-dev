---
name: accessibility-design
description: Build accessibility into design decisions instead of treating it as late-stage options work.
origin: everything-game-dev-code
category: design
---

# Accessibility Design

## Purpose
Build accessibility into design decisions instead of treating it as late-stage options work.

## Use When
- designing new mechanics, UI, or content
- features rely on reaction speed, color, audio, or precision input
- accessibility scope must be planned

## Inputs
- feature spec
- input model
- UI requirements
- audio and narrative needs

## Process
1. identify likely barriers early
2. design equivalent outcomes rather than identical inputs
3. specify settings, fallbacks, and persistence behavior
4. coordinate with QA and UI for verification
5. document limitations explicitly when they cannot be fully solved

## Outputs
- accessibility requirements
- option set
- verification targets
- known limitation log

## Quality Bar
- supports the core fantasy and player goals
- defines readable rules, edge cases, and feedback
- creates concrete hooks for tuning, telemetry, and QA

## Common Failure Modes
- adding systems that do not serve the core loop
- shipping vague rules that QA and engineering must guess at
- tuning without instrumentation or hypotheses

## Related Agents
- accessibility-reviewer
- ui-ux-designer
- systems-designer

## Related Commands
- verify
- onboarding
- ui-flow-review

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
