---
name: ai-behavior-patterns
description: Design maintainable AI behavior structures for decision-making, navigation, combat, and systemic interaction.
origin: everything-game-dev-code
category: engineering-common
---

# Ai Behavior Patterns

## Purpose
Design maintainable AI behavior structures for decision-making, navigation, combat, and systemic interaction.

## Use When
- NPC behavior needs structure
- AI tuning is opaque
- behavior authoring is hard to debug

## Inputs
- enemy or NPC roles
- world rules
- combat or systemic constraints
- performance targets

## Process
1. define behavior goals and state or decision model
2. separate sensing, decision, and action execution
3. create tuning hooks and readable debug outputs
4. handle fail states, navigation issues, and fallback behavior
5. profile high-density scenarios early

## Outputs
- AI behavior model
- tuning hooks
- debugging checklist
- performance risk notes

## Quality Bar
- makes ownership, state flow, and failure behavior explicit
- improves maintainability without over-abstracting
- supports testing, debugging, and safe iteration

## Common Failure Modes
- coupling systems through hidden globals or timing assumptions
- writing logic that is hard to test or debug
- optimizing the wrong layer before measuring

## Related Agents
- ai-programmer
- combat-designer
- performance-reviewer

## Related Commands
- tech-design
- verify
- playtest-report

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
