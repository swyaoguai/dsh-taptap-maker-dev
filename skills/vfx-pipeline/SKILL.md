---
name: vfx-pipeline
description: Create VFX authoring and integration rules that preserve readability, style fit, and performance.
origin: everything-game-dev-code
category: art-audio-content
---

# VFX Pipeline

## Purpose
Create VFX authoring and integration rules that preserve readability, style fit, and performance.

## Use When
- combat or interaction effects are being built
- VFX cost is escalating
- readability is poor

## Inputs
- art bible
- combat readability needs
- engine constraints
- performance budget

## Process
1. define effect categories and quality bars
2. separate gameplay-critical clarity from decorative layers
3. set cost expectations for particles, materials, lights, and post-process
4. create review checkpoints for style and readability
5. test effects under combat or stress conditions

## Outputs
- VFX guide
- cost tiers
- readability checklist
- integration notes

## Quality Bar
- is usable by content creators without tribal knowledge
- respects quality bars and runtime constraints together
- defines validation and ownership for content flow

## Common Failure Modes
- style consistency that ignores gameplay readability
- manual pipeline steps that create drift
- content that cannot be validated before release

## Related Agents
- technical-artist
- combat-designer
- performance-reviewer

## Related Commands
- combat-design
- verify
- perf-budget

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
