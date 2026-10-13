---
name: orchestration-patterns
description: Coordinate multiple agents and disciplines so complex tasks are broken down cleanly and handed off without ambiguity.
origin: everything-game-dev-code
category: workflow
---

# Orchestration Patterns

## Purpose
Coordinate multiple agents and disciplines so complex tasks are broken down cleanly and handed off without ambiguity.

## Use When
- a task crosses design, engineering, QA, and production boundaries
- ownership is unclear
- parallel work must be sequenced safely

## Inputs
- goal statement
- current state of docs and code
- roles involved
- deadline or milestone context

## Process
1. name the owning role and desired outputs
2. split the work into sequential and parallel tracks
3. define handoff contracts and done criteria
4. surface dependency and escalation points early
5. close the loop with verification and documentation updates

## Outputs
- orchestration plan
- handoff map
- owner-by-output matrix
- review checkpoints

## Quality Bar
- produces a current source of truth, not disconnected notes
- names owners, risks, and next actions explicitly
- separates decisions from assumptions and open questions

## Common Failure Modes
- outdated docs that no longer match reality
- plans with no owner or no exit criteria
- hiding risks until they become schedule blockers

## Related Agents
- planner
- producer
- architect

## Related Commands
- orchestrate
- plan
- verify

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
