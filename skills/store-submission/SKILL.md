---
name: store-submission
description: Prepare store-facing assets, metadata, compliance paperwork, and packaging details for submission.
origin: everything-game-dev-code
category: qa-release
---

# Store Submission

## Purpose
Prepare store-facing assets, metadata, compliance paperwork, and packaging details for submission.

## Use When
- approaching launch or major update submission
- store requirements are not yet consolidated
- platform and marketing dependencies are diverging

## Inputs
- release candidate build
- store requirements
- screenshots and metadata
- age rating and legal needs

## Process
1. build a submission checklist for each platform/store
2. validate asset and metadata completeness
3. check versioning, entitlement, and region requirements
4. coordinate with localization and support information
5. track platform-specific blockers through submission

## Outputs
- store submission checklist
- metadata package
- asset-completeness report
- submission blocker list

## Quality Bar
- turns risk into explicit evidence and ownership
- keeps release blockers visible instead of implicit
- connects quality decisions to milestone and platform impact

## Common Failure Modes
- severity inflation or minimization without player-impact context
- treating waived risks as invisible
- submission checklists that are incomplete or stale

## Related Agents
- release-manager
- producer
- doc-updater

## Related Commands
- release-check
- patch-notes
- cert-check

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
