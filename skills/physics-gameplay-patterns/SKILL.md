---
name: physics-gameplay-patterns
description: Use physics and collision in a way that supports feel, determinism expectations, and performance constraints.
origin: everything-game-dev-code
category: engineering-common
---

# Physics Gameplay Patterns

## Purpose
Use physics and collision in a way that supports feel, determinism expectations, and performance constraints.

## Use When
- movement, projectiles, collisions, or physical interactions are core to the feature
- simulation is causing instability
- feel and correctness are fighting each other

## Inputs
- movement goals
- collision needs
- determinism expectations
- platform performance targets

## Process
1. define what is simulated versus authored or faked
2. establish ownership of collision and response logic
3. control update order and frame-rate sensitivity where needed
4. add debug tools for contact, forces, and state transitions
5. test extreme cases and stress conditions

## Outputs
- physics interaction rules
- debug plan
- edge-case list
- performance notes

## Quality Bar
- makes ownership, state flow, and failure behavior explicit
- improves maintainability without over-abstracting
- supports testing, debugging, and safe iteration

## Common Failure Modes
- coupling systems through hidden globals or timing assumptions
- writing logic that is hard to test or debug
- optimizing the wrong layer before measuring

## Related Agents
- physics-programmer
- gameplay-programmer
- qa-lead

## Related Commands
- tech-design
- verify
- perf-budget

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
