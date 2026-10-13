---
name: event-bus-patterns
description: Use events and messaging without creating hidden coupling, ordering bugs, or impossible debugging paths.
origin: everything-game-dev-code
category: engineering-common
---

# Event Bus Patterns

## Purpose
Use events and messaging without creating hidden coupling, ordering bugs, or impossible debugging paths.

## Use When
- systems need indirect communication
- direct references are creating brittle architecture
- event usage is becoming chaotic

## Inputs
- system boundary map
- ownership notes
- runtime lifecycle

## Process
1. define which events are domain events and who owns them
2. limit event payloads to stable contracts
3. document subscription lifecycle and ordering assumptions
4. avoid using events where direct ownership is clearer
5. add diagnostics for event-heavy systems

## Outputs
- event contract list
- subscription ownership notes
- debugging guidance
- anti-pattern warnings

## Quality Bar
- makes ownership, state flow, and failure behavior explicit
- improves maintainability without over-abstracting
- supports testing, debugging, and safe iteration

## Common Failure Modes
- coupling systems through hidden globals or timing assumptions
- writing logic that is hard to test or debug
- optimizing the wrong layer before measuring

## Related Agents
- architect
- gameplay-programmer
- tools-programmer

## Related Commands
- tech-design
- verify
- refactor-clean

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
