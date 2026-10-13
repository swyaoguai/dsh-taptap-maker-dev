---
name: verification-loop
description: Run a structured verification pass that checks behavior, edge cases, quality bars, and documentation alignment.
origin: everything-game-dev-code
category: workflow
---

# Verification Loop

## Purpose
Run a structured verification pass that checks behavior, edge cases, quality bars, and documentation alignment.

## Use When
- a feature claims to be done
- a risky fix needs confidence
- milestone integration is underway

## Inputs
- implemented change
- acceptance criteria
- test outputs
- docs and known risks

## Process
1. compare the implementation to the intended design and technical behavior
2. verify happy path, edge cases, and failure recovery
3. check docs, telemetry, and QA notes for drift
4. record gaps and assign owners
5. close only when blockers or ambiguities are resolved

## Outputs
- verification summary
- defect list
- doc updates needed
- go/no-go recommendation

## Quality Bar
- produces a current source of truth, not disconnected notes
- names owners, risks, and next actions explicitly
- separates decisions from assumptions and open questions

## Common Failure Modes
- outdated docs that no longer match reality
- plans with no owner or no exit criteria
- hiding risks until they become schedule blockers

## Related Agents
- qa-lead
- code-reviewer
- performance-reviewer

## Related Commands
- verify
- qa-plan
- update-docs

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
