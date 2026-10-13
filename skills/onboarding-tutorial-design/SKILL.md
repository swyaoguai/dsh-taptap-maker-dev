---
name: onboarding-tutorial-design
description: Teach the player the game clearly, gradually, and in a way that supports retention rather than overload.
origin: everything-game-dev-code
category: design
---

# Onboarding Tutorial Design

## Purpose
Teach the player the game clearly, gradually, and in a way that supports retention rather than overload.

## Use When
- new players churn early
- systems are hard to learn
- a feature needs tutorialization

## Inputs
- core loop
- player friction points
- UI flows
- failure states

## Process
1. identify what players must know immediately versus later
2. sequence learning by relevance and readiness
3. teach through action whenever possible
4. design revisitable help for complex systems
5. test whether onboarding creates understanding or just compliance

## Outputs
- onboarding flow
- tutorial beat list
- help-system requirements
- first-session improvement targets

## Quality Bar
- supports the core fantasy and player goals
- defines readable rules, edge cases, and feedback
- creates concrete hooks for tuning, telemetry, and QA

## Common Failure Modes
- adding systems that do not serve the core loop
- shipping vague rules that QA and engineering must guess at
- tuning without instrumentation or hypotheses

## Related Agents
- ui-ux-designer
- systems-designer
- level-designer

## Related Commands
- onboarding
- playtest-report
- ui-flow-review

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
