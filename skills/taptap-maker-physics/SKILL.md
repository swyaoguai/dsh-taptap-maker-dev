---
name: taptap-maker-physics
description: TapTap Maker 物理（3D RigidBody/CollisionShape 与 2D Box2D）常见坑：Rolling Friction 不兼容、Collision Margin 过大；角色控制器与载具入口。
whenToUse: 加物理、碰撞、角色移动或载具，或物理表现异常（抖动、穿透、滚动不对）时。
---

# TapTap Maker 物理

## 已验证的坑（务必先看）

见 `engine-docs/gotchas/physics.md`，核心两条：

1. **Rolling Friction 不兼容** —— 别依赖它来止滚，用其他方式（阻尼/约束）处理。
2. **Collision Margin 过大** 会导致碰撞体视觉与实际不符 / 穿插异常 —— 按坑里给的量级设置。

## 3D 物理

- 类：`PhysicsWorld`、`RigidBody`、`CollisionShape`、`CollisionLayer`、`Constraint`。
- 角色：`KinematicCharacterController` / `CharacterComponent`。
- 载具：`RaycastVehicle`。
- 刚体用 `FixedUpdate` 做力/速度，别在渲染帧里改物理状态。

## 2D 物理（Box2D）

- 类：`PhysicsWorld2D`、`RigidBody2D`、`CollisionBox2D/Circle2D/Edge2D/Chain2D/Polygon2D`、各种 `Constraint2D`。
- 模板：`templates/scaffold-2d-physics.lua`。

## 体素破坏物理（Teardown 风格）

可破坏世界/爆炸挖掘/碎块/浮力/抓取/铰链/载具：`engine-docs/recipes/voxel-physics.md`；联网版 `engine-docs/recipes/voxel-networking.md`。

遇到没列到的类/字段用 LSP 查，不要猜 API 名。
