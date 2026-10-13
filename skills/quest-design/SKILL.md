---
name: quest-design
description: Design objective structure, gating, branching, and player guidance for mission-like content.
origin: everything-game-dev-code
category: design
---

# Quest Design

## Purpose
Design objective structure, gating, branching, and player guidance for mission-like content.

## Use When
- building quests, objectives, or mission chains
- objective logic is hard to follow
- branching or failure states need clarity

## Inputs
- narrative intent
- level flow
- system dependencies
- reward or progression hooks

## Process
1. define quest goals, states, triggers, and transitions
2. specify optionality, branching, fail conditions, and recovery paths
3. coordinate objective communication with UI and narrative
4. ensure logic is testable and debuggable
5. flag telemetry needed for drop-off or confusion points

## Outputs
- quest flow spec
- state map
- UI communication notes
- test cases

## Quality Bar
- supports the core fantasy and player goals
- defines readable rules, edge cases, and feedback
- creates concrete hooks for tuning, telemetry, and QA

## Common Failure Modes
- adding systems that do not serve the core loop
- shipping vague rules that QA and engineering must guess at
- tuning without instrumentation or hypotheses

## Related Agents
- narrative-designer
- level-designer
- ui-ux-designer

## Related Commands
- quest-design
- gdd
- verify

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
