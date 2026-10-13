---
name: localization-pipeline
description: Prepare the project for translation, cultural adaptation, text expansion, and voice or subtitle variability.
origin: everything-game-dev-code
category: art-audio-content
---

# Localization Pipeline

## Purpose
Prepare the project for translation, cultural adaptation, text expansion, and voice or subtitle variability.

## Use When
- the game will ship in multiple languages
- text is growing fast
- UI is not resilient to expansion

## Inputs
- text inventory
- supported locales
- UI constraints
- narrative and subtitle requirements

## Process
1. separate localizable text from hardcoded content
2. define key naming and source-of-truth rules
3. plan export/import and review flow with vendors or internal localization
4. identify screens and systems sensitive to expansion or RTL
5. test fonts, truncation, and fallback behavior

## Outputs
- localization workflow
- key management rules
- locale risk list
- QA localization checklist

## Quality Bar
- is usable by content creators without tribal knowledge
- respects quality bars and runtime constraints together
- defines validation and ownership for content flow

## Common Failure Modes
- style consistency that ignores gameplay readability
- manual pipeline steps that create drift
- content that cannot be validated before release

## Related Agents
- narrative-designer
- ui-ux-designer
- doc-updater

## Related Commands
- update-docs
- verify
- release-check

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
