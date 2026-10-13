---
name: combat-design
description: Design combat verbs, enemy pressure, resource economy, readability, and tuning hooks.
origin: everything-game-dev-code
category: design
---

# Combat Design

## Purpose
Design combat verbs, enemy pressure, resource economy, readability, and tuning hooks.

## Use When
- building a combat game or combat-heavy feature
- combat feels unreadable or shallow
- balance changes need stronger structure

## Inputs
- player fantasy
- weapon or ability roster
- enemy roster
- target pace and difficulty

## Process
1. define player verbs, counters, risk/reward, and pacing
2. design enemy roles and pressure patterns
3. specify feedback, resource use, and fail states
4. identify tuning variables and telemetry needs
5. test clarity, fairness, and skill expression

## Outputs
- combat spec
- tuning variable list
- enemy-role matrix
- playtest questions

## Quality Bar
- supports the core fantasy and player goals
- defines readable rules, edge cases, and feedback
- creates concrete hooks for tuning, telemetry, and QA

## Common Failure Modes
- adding systems that do not serve the core loop
- shipping vague rules that QA and engineering must guess at
- tuning without instrumentation or hypotheses

## Related Agents
- combat-designer
- systems-designer
- ui-ux-designer

## Related Commands
- combat-design
- playtest-report
- verify

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
