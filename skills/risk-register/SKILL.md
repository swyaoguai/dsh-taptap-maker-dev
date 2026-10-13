---
name: risk-register
description: Identify, track, and revisit the risks most likely to derail scope, quality, budget, or release readiness.
origin: everything-game-dev-code
category: workflow
---

# Risk Register

## Purpose
Identify, track, and revisit the risks most likely to derail scope, quality, budget, or release readiness.

## Use When
- planning major milestones
- the project depends on new tech or external dependencies
- scope or platform targets have changed

## Inputs
- milestone plan
- technical unknowns
- dependency map
- team and vendor constraints

## Process
1. list risks by domain and owner
2. score probability, impact, and trigger conditions
3. define mitigation, fallback, and review cadence
4. flag risks that require prototype or spike work
5. keep the register visible during milestone reviews

## Outputs
- risk register
- mitigation plan
- trigger checklist
- prototype or spike recommendations

## Quality Bar
- produces a current source of truth, not disconnected notes
- names owners, risks, and next actions explicitly
- separates decisions from assumptions and open questions

## Common Failure Modes
- outdated docs that no longer match reality
- plans with no owner or no exit criteria
- hiding risks until they become schedule blockers

## Related Agents
- producer
- planner
- architect
- release-manager

## Related Commands
- milestone-plan
- plan
- release-check

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
