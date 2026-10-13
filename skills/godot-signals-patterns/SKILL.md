---
name: godot-signals-patterns
description: Use signals for decoupling without creating hidden event webs, ownership confusion, or lifecycle bugs.
origin: everything-game-dev-code
category: godot
---

# Godot Signals Patterns

## Purpose
Use signals for decoupling without creating hidden event webs, ownership confusion, or lifecycle bugs.

## Use When
- signal usage is growing
- scene communication is brittle
- callbacks and node dependencies are hard to debug

## Inputs
- scene architecture
- system boundaries
- signal producers and consumers
- lifecycle notes

## Process
1. define which signals are stable contracts
2. document who connects, disconnects, and owns signal lifetime
3. avoid using signals when direct ownership is clearer
4. prevent scene-tree timing assumptions from becoming hidden requirements
5. add debug support for signal-heavy flows

## Outputs
- signal contract list
- ownership notes
- debugging guidance
- anti-pattern warnings

## Quality Bar
- respects scene-tree ownership, autoload boundaries, and resource behavior
- keeps scripts, signals, and resources understandable at scale
- supports export reliability and content iteration without hidden coupling

## Common Failure Modes
- autoloads becoming global dumping grounds
- signal webs with no ownership
- shared resources causing accidental state leakage

## Related Agents
- godot-reviewer
- tools-programmer
- gameplay-programmer

## Related Commands
- godot-review
- godot-scene-audit
- refactor-clean

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
