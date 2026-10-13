---
name: tdd-workflow
description: Apply test-driven development or test-first thinking to gameplay, tooling, and high-risk technical work.
origin: everything-game-dev-code
category: workflow
---

# TDD Workflow

## Purpose
Apply test-driven development or test-first thinking to gameplay, tooling, and high-risk technical work.

## Use When
- logic is deterministic enough to test
- a bug is likely to recur
- a feature has brittle edge cases or integration boundaries

## Inputs
- feature spec
- acceptance criteria
- known failure cases
- test harness constraints

## Process
1. write or define expected behavior before implementation
2. add a small failing test or validation case
3. implement the minimum change to satisfy behavior
4. refactor while preserving the safety net
5. capture any remaining manual or integration tests still required

## Outputs
- failing then passing tests
- codified acceptance criteria
- regression protection
- updated technical notes

## Quality Bar
- produces a current source of truth, not disconnected notes
- names owners, risks, and next actions explicitly
- separates decisions from assumptions and open questions

## Common Failure Modes
- outdated docs that no longer match reality
- plans with no owner or no exit criteria
- hiding risks until they become schedule blockers

## Related Agents
- gameplay-programmer
- tools-programmer
- code-reviewer

## Related Commands
- tdd
- verify
- refactor-clean

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
