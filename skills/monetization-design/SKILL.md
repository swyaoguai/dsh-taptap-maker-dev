---
name: monetization-design
description: Design monetization systems that fit the product, respect player trust, and remain technically and legally manageable.
origin: everything-game-dev-code
category: design
---

# Monetization Design

## Purpose
Design monetization systems that fit the product, respect player trust, and remain technically and legally manageable.

## Use When
- the game includes IAP, battle passes, DLC, ads, or premium upsell
- economy and monetization need alignment
- store or entitlement flows are being added

## Inputs
- business model
- economy rules
- platform requirements
- player trust constraints

## Process
1. define the monetization role in the product
2. map offers to progression and retention without creating unfair pressure
3. document entitlement, UX, and compliance behavior
4. coordinate telemetry and experimentation
5. review long-term inflation, abuse, and messaging risk

## Outputs
- monetization model
- offer matrix
- store UX requirements
- compliance and telemetry notes

## Quality Bar
- supports the core fantasy and player goals
- defines readable rules, edge cases, and feedback
- creates concrete hooks for tuning, telemetry, and QA

## Common Failure Modes
- adding systems that do not serve the core loop
- shipping vague rules that QA and engineering must guess at
- tuning without instrumentation or hypotheses

## Related Agents
- mobile-f2p-analyst
- economy-designer
- liveops-manager

## Related Commands
- economy-balance
- liveops-brief
- cert-check

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
