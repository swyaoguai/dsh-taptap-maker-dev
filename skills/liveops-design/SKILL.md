---
name: liveops-design
description: Design seasonal, event, or post-launch content that extends engagement without destabilizing the core product.
origin: everything-game-dev-code
category: design
---

# Liveops Design

## Purpose
Design seasonal, event, or post-launch content that extends engagement without destabilizing the core product.

## Use When
- the game has post-launch events, cadence, shops, or rotating content
- retention needs event support
- live content needs safer design rules

## Inputs
- economy model
- retention goals
- content cadence
- telemetry signals

## Process
1. define the event or season purpose
2. set entry requirements, rewards, and economy impact
3. plan live tuning and rollback options
4. coordinate messaging, store, and content dependencies
5. specify analytics needed to judge success

## Outputs
- liveops brief
- reward plan
- operational guardrails
- monitoring requirements

## Quality Bar
- supports the core fantasy and player goals
- defines readable rules, edge cases, and feedback
- creates concrete hooks for tuning, telemetry, and QA

## Common Failure Modes
- adding systems that do not serve the core loop
- shipping vague rules that QA and engineering must guess at
- tuning without instrumentation or hypotheses

## Related Agents
- liveops-manager
- economy-designer
- telemetry-analyst

## Related Commands
- liveops-brief
- telemetry-plan
- patch-notes

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
