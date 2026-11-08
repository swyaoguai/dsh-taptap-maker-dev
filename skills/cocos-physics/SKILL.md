---
name: cocos-physics
description: Cocos Creator 3.x 物理：2D Box2D 与 3D Cannon 的刚体/碰撞体、碰撞分组矩阵、接触与触发回调、射线检测、角色控制与稳定性调优。
whenToUse: 做平台跳跃、碰撞伤害、子弹命中、触发器区域、拾取、射线拾取、物理分组、物体抖动穿模，或「明明碰到却不触发」时。
---

# 物理（Cocos 3.x）

- 2D：Box2D（`PhysicsSystem2D`）；3D：Cannon（`PhysicsSystem`）。
- 开关在项目设置 → Physics；2D 还依赖启动时物理系统已启用。
- 物理分组和碰撞矩阵是**项目设置里的数据**，规划阶段就定好，别在代码里临场改。

## 刚体

| | 2D（RigidBody2D） | 3D（RigidBody） |
|---|---|---|
| 类型 | Static / Dynamic / Kinematic / Animated | STATIC / DYNAMIC / KINEMATIC |
| 速度 | `linearVelocity`、`angularVelocity` | `setLinearVelocity()` |
| 施力 | `applyForce`、`applyLinearImpulse` | `applyForce`、`applyImpulse` |
| 常用项 | `fixedRotation`、`gravityScale`、`linearDamping` | `mass`、`useGravity`、`linearDamping`、`angularDamping` |

- 角色用 Dynamic + `fixedRotation`（2D）最常见；平台/墙用 Static；移动平台用 Kinematic。
- 直接改节点位置 = 瞬移，不会带动碰撞；要移动带物理的物体，改刚体速度或力。

## 碰撞体

- 2D：`BoxCollider2D`、`CircleCollider2D`、`PolygonCollider2D`；`sensor = true` 做触发器（不产生物理反应）。
- 3D：`BoxCollider`、`SphereCollider`、`CapsuleCollider`、`MeshCollider`（只支持凸包）。
- 摩擦/弹性：2D 在碰撞体上配；3D 用 `PhysicsMaterial`（friction / restitution）。
- **不要把碰撞体挂在非均匀缩放的节点上**：形状会失真，命中判定不可靠。
- 碰撞体大小随节点缩放变化，调整后要在场景里重新对一遍。

## 分组与矩阵（最高频的坑）

1. 项目设置 → Physics → 分组列表里建组（`player`、`enemy`、`bullet`、`wall`、`pickup`）。
2. 碰撞体的 `group` 选对应组。
3. 碰撞矩阵里把要相撞的组打勾（同组默认勾）。
4. 规划时先写一张「谁撞谁」表，再照着配；代码里不要 `setGroup`。

「碰撞体都在、速度也有，就是不触发」——九成是矩阵没勾或 group 没选。

## 接触与触发回调

```ts
// 2D
import { Contact2DType } from 'cc';
collider.on(Contact2DType.BEGIN_CONTACT, (self, other, contact) => {
  // other 是对方的 Collider2D
}, this);

// 3D
collider.on('onCollisionEnter', (event) => { /* event.otherCollider */ }, this);
collider.on('onTriggerEnter', (event) => { /* ... */ }, this);
```

- 回调里只发事件/改状态，不要直接销毁对方节点（物理步进中销毁会出问题，下一帧再处理）。
- 每帧接触用 STAY / `onCollisionStay`，注意别在里面做重计算。

## 射线检测

```ts
// 2D
PhysicsSystem2D.instance.raycast(from, to, ERaycast2DType.Closest);

// 3D
const results = PhysicsSystem.instance.raycast(ray);
const hit = PhysicsSystem.instance.raycastClosest(ray, mask, 100, result);
```

- 屏幕点 → 世界射线：3D 用相机 `screenPointToRay`；2D 用相机 `screenToWorld`。
- 射线加分组 mask，别把 UI 层/触发器全扫进来。
- 拾取/点击检测优先用射线，比堆触发器省事。

## 角色控制

- 3.8 有 `CharacterController` 组件（以版本为准）；否则用 Kinematic 刚体 + 手动移动 + 射线探测。
- 平台跳跃的 coyote time、jump buffer、可变跳高都在代码层做，物理只负责碰撞与重力。
- 斜坡/台阶：地面检测用向下射线或 Overlap，别用 `onCollisionStay` 每帧猜。

## 稳定性

- 固定步长（2D `fixedTimeStep`，默认 1/60）：逻辑按固定步长算，渲染插值。
- 高速子弹：2D 勾 `bullet`（连续碰撞）或改射线扫掠；3D 提高步进频率或缩短子弹生命。
- 刚体数量控制在几十个；大量静态碰撞体靠空间划分，不要每个瓦片一个刚体。
- 抖动/穿模：检查质量比、碰撞体边缘重叠、是否每帧直接设位置。

## 验收

- 预览里实际撞一遍、跳一遍、打一枪，`cocos_screenshot scope=game` 看效果。
- `cocos_logs` 查物理告警（形状无效、分组不存在）。
- 分组矩阵和「谁撞谁」表要能对上；小游戏平台注意物理 wasm 是否加载成功。

相关 skill：通用物理设计 `physics-gameplay-patterns`；输入手感 `cocos-input`；性能 `cocos-performance`。
