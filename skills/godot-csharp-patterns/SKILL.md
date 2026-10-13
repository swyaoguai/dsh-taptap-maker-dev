---
name: godot-csharp-patterns
description: Use C# in Godot with clear interop boundaries, node ownership, and engine lifecycle awareness.
origin: everything-game-dev-code
category: godot
---

# Godot Csharp Patterns

## Purpose
Use C# in Godot with clear interop boundaries, node ownership, and engine lifecycle awareness.

## Use When
- the Godot project uses C#
- interop with scenes and resources is growing
- architecture needs stronger reviewability

## Inputs
- feature scope
- node structure
- interop points
- testing and performance needs

## Process
1. define where C# owns logic versus where scene authoring owns structure
2. keep node and resource assumptions explicit
3. separate reusable logic from scene-specific code
4. handle signal wiring and lifecycle intentionally
5. review C# tooling, export, and build implications

## Outputs
- C# boundary notes
- interop rules
- review findings
- build considerations

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
- technical-design-lead
- tools-programmer

## Related Commands
- godot-review
- tech-design
- verify

## Notes
- Keep this skill aligned with the relevant rules layer and current project documentation.
- If engine-specific constraints materially change the workflow, hand off to the matching engine skill or engine-specific reviewer.
