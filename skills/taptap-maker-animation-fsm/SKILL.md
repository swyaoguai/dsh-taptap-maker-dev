---
name: taptap-maker-animation-fsm
description: TapTap Maker 角色动画与状态机：AnimationStateMachine、BlendSpace、AimOffset、Root Motion，以及用 Bone:GetFinalWorldTransform() 做武器/特效骨骼挂点。
whenToUse: 做角色动画、动作切换/混合、瞄准偏移、根运动位移，或要把武器/特效挂到骨骼上时。
---

# TapTap Maker 动画状态机

权威指南：`engine-docs/recipes/state-machine.md`。

## 组成

- `AnimationController` / `AnimationState` —— 播放与权重控制。
- `AnimationStateMachine` —— 状态图（Pose Graph），状态间按条件转移。
- `BlendSpace` —— 按参数（速度/方向）在多个动画间连续混合（如行走/奔跑混合）。
- `AimOffset` —— 瞄准偏移，叠加在基础姿态上。
- **Root Motion** —— 用动画驱动位移/旋转，注意与物理/角色控制器的协调。

## 骨骼挂点（武器 / 特效）

用 `Bone:GetFinalWorldTransform()` 取骨骼最终世界变换，把挂载节点同步到该变换（后处理阶段），实现刀/枪/拖尾跟手。细节见 recipe。

## 流程

1. 先读 `state-machine.md` 确认 API 与装配步骤（可配合 `/setup-fsm` 引导）。
2. 动画资源与骨骼命名对齐；BlendSpace/AimOffset 的参数来源想清楚（输入/速度）。
3. 用 LSP 查 `Animation*`、`BlendSpace`、`AimOffset`、`Skeleton`、`Bone` 的具体签名。
