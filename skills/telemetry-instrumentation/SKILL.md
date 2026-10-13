---
name: telemetry-instrumentation
description: Implement analytics and observability hooks that answer product questions without creating noise or privacy risk.
origin: everything-game-dev-code
category: engineering-common
---

# Telemetry Instrumentation

## Purpose
Implement analytics and observability hooks that answer product questions without creating noise or privacy risk.

## Use When
- a system needs monitoring
- design wants funnels or tuning data
- release needs stronger operational visibility

## Inputs
- telemetry plan
- feature boundaries
- privacy constraints
- dashboard or alert consumers

## Process
1. instrument stable behavioral boundaries rather than random low-value clicks
2. version event schemas and document payloads
3. route events by environment and consent rules
4. validate event timing and duplication behavior
5. connect instrumentation to dashboards or analysis consumers

## Outputs
- instrumented events
- schema notes
- validation checklist
- consumer mapping

## Quality Bar
- makes ownership, state flow, and failure behavior explicit
- improves maintainability without over-abstracting
- supports testing, debugging, and safe iteration

## Common Failure Modes
- coupling systems through hidden globals or timing assumptions
- writing logic that is hard to test or debug
- optimizing the wrong layer before measuring

## Related Agents
- telemetry-analyst
- gameplay-programmer
- liveops-manager

## Related Commands
- telemetry-plan
- verify
- learn

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
