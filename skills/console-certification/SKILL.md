---
name: console-certification
description: Prepare the project for console platform requirements, TRCs/TCRs/XRs, and first-party submission expectations.
origin: everything-game-dev-code
category: qa-release
---

# Console Certification

## Purpose
Prepare the project for console platform requirements, TRCs/TCRs/XRs, and first-party submission expectations.

## Use When
- shipping to consoles
- platform-specific UX and entitlement flows are being added
- submission planning is underway

## Inputs
- platform requirements
- current build behavior
- entitlement flow
- save and online behavior

## Process
1. map product behavior to platform requirement categories
2. identify compliance-sensitive areas such as suspend/resume, user accounts, storage, network, and commerce
3. plan targeted compliance testing
4. document known waivers or uncertainty
5. coordinate fixes with release planning

## Outputs
- certification checklist
- platform risk list
- compliance test plan
- submission blockers

## Quality Bar
- turns risk into explicit evidence and ownership
- keeps release blockers visible instead of implicit
- connects quality decisions to milestone and platform impact

## Common Failure Modes
- severity inflation or minimization without player-impact context
- treating waived risks as invisible
- submission checklists that are incomplete or stale

## Related Agents
- console-compliance-reviewer
- qa-lead
- release-manager

## Related Commands
- cert-check
- release-check
- verify

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
