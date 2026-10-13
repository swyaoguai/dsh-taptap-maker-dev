---
name: economy-balancing
description: Design and tune currencies, sinks, rewards, prices, and inflation control so the economy supports progression and retention.
origin: everything-game-dev-code
category: design
---

# Economy Balancing

## Purpose
Design and tune currencies, sinks, rewards, prices, and inflation control so the economy supports progression and retention.

## Use When
- the game has currencies, crafting, shop systems, or upgrade economies
- reward pacing feels too generous or too punishing
- live tuning is required

## Inputs
- progression model
- reward sources
- sink list
- target session and retention goals

## Process
1. define currency roles and allowed flows
2. map sources, sinks, and exchange paths
3. set baseline values and anti-inflation controls
4. identify abuse cases, softlocks, and over-reward loops
5. instrument economy-critical events for monitoring

## Outputs
- economy model
- balance sheet
- source/sink matrix
- tuning plan

## Quality Bar
- supports the core fantasy and player goals
- defines readable rules, edge cases, and feedback
- creates concrete hooks for tuning, telemetry, and QA

## Common Failure Modes
- adding systems that do not serve the core loop
- shipping vague rules that QA and engineering must guess at
- tuning without instrumentation or hypotheses

## Related Agents
- economy-designer
- systems-designer
- mobile-f2p-analyst

## Related Commands
- economy-balance
- telemetry-plan
- liveops-brief

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
