---
name: progression-design
description: Structure long-term and short-term progression so players experience growth, goals, and retention without uncontrolled complexity.
origin: everything-game-dev-code
category: design
---

# Progression Design

## Purpose
Structure long-term and short-term progression so players experience growth, goals, and retention without uncontrolled complexity.

## Use When
- adding unlocks, levels, upgrades, or mastery layers
- players lack motivation between sessions
- content cadence needs stronger reward structure

## Inputs
- core loop
- content cadence
- session goals
- economy assumptions

## Process
1. define progression layers and how they reinforce the core loop
2. set reward timing, pacing, and gating rules
3. prevent front-loaded complexity and dead progression lanes
4. identify reset, catch-up, and balance risks
5. map telemetry needed to monitor progression health

## Outputs
- progression model
- reward pacing rules
- gating logic
- progression metrics

## Quality Bar
- supports the core fantasy and player goals
- defines readable rules, edge cases, and feedback
- creates concrete hooks for tuning, telemetry, and QA

## Common Failure Modes
- adding systems that do not serve the core loop
- shipping vague rules that QA and engineering must guess at
- tuning without instrumentation or hypotheses

## Related Agents
- systems-designer
- economy-designer
- telemetry-analyst

## Related Commands
- gdd
- economy-balance
- telemetry-plan

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
