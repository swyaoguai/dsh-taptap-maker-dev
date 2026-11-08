---
name: cocos-animation
description: Cocos Creator 3.x 动画与补间：Animation 组件与 clip、tween API、缓动与清理、Spine/龙骨/3D 骨骼、序列帧、动画事件与手感联动。
whenToUse: 做角色动作、UI 弹窗动画、受击反馈、连招节奏、Spine 骨骼播放、序列帧切换，或动画播完不回调、tween 泄漏、切场景报错时。
---

# 动画与补间（Cocos 3.x）

## 先选路线

| 需求 | 用什么 |
|---|---|
| UI 弹窗、按钮、飘字、简单位移/缩放/透明度 | `tween`（代码补间） |
| 角色多轨动画、序列帧、材质属性动画 | `Animation` 组件 + clip（编辑器里做） |
| 2D 骨骼（Spine / 龙骨） | `sp.Skeleton` / `dragonBones.ArmatureDisplay` |
| 3D 骨骼 | `SkeletalAnimation` 组件 |

## Animation 组件

- 组件的 `clips` 里拖入 clip；代码 `animation.play('run')`、`animation.crossFade('idle', 0.15)`。
- `wrapMode`：Loop / Normal / Reverse；`speed` 调播放速率。
- 动画事件：在动画编辑器里给 clip 加事件帧，回调方法是**挂 Animation 的节点上**的组件方法；
  或运行期监听 `animation.on(Animation.EventType.FINISHED, cb, this)`。
- 轨道能驱动节点位置/缩放/透明度、SpriteFrame（序列帧）、材质属性——但**不要驱动核心玩法状态**，
  掉帧或跳过时动画事件会漏，逻辑用代码时间轴。

## tween

```ts
import { tween, Vec3, Tween } from 'cc';

tween(node)
  .to(0.12, { scale: new Vec3(1.12, 1.12, 1) }, { easing: 'quadOut' })
  .to(0.08, { scale: Vec3.ONE }, { easing: 'quadIn' })
  .call(() => this.onPopDone())
  .start();
```

- 常用：`.to()` `.by()` `.delay()` `.call()` `.set()` `.union()` `.repeatForever()` `.stop()`。
- 缓动字符串：`linear`、`sineOut`、`quadOut`、`cubicInOut`、`backOut`、`elasticOut`、`bounceOut`。
- 清理：`Tween.stopAllByTarget(node)`；切场景/`onDestroy` 必停，否则回调打到已销毁节点。
- 不要每帧 `new` tween；持续动画（呼吸、滚动）用 `repeatForever` 或 update 里算。
- 时间缩放（顿帧）用 `tween(node).set({ ... })` 不行，得统一走自己的时间倍率或暂停动画组件。

## 2D 骨骼

```ts
import { sp } from 'cc';

this.skeleton.setAnimation(0, 'run', true);
this.skeleton.addAnimation(0, 'attack', false);
this.skeleton.setMix('idle', 'run', 0.1);
this.skeleton.node.on(sp.Skeleton.EventType.COMPLETE, this.onAnimDone, this);
```

- 骨骼数据版本必须和运行时匹配（Spine 导出设置里选对版本），否则黑屏/错位。
- `sp.Skeleton` 的 `premultipliedAlpha`、`timeScale` 按素材调；换装用 `setSkin` + attachment。
- DragonBones 用 `dragonBones.ArmatureDisplay` 的 `playAnimation(name, times)`。

## 3D 骨骼

- `SkeletalAnimation` 组件挂 clip，`play` 同上；根运动要自己处理（位移写回父节点）。
- 蒙皮网格与动画资源导入时确认骨骼、材质、动画都在同一模型资源下。

## 序列帧

- SpriteFrame 数组 + 间隔切换（用 `schedule` 或自己的帧计时），或 Animation 轨道驱动 SpriteFrame。
- 大图集注意内存；同屏多个序列帧角色优先共用一张图集。

## 手感联动

- 打击反馈：动画 + 粒子 + 音效**同一帧**触发；顿帧实现为全局时间倍率或局部动画 `speed = 0` 后延时恢复。
- 受击闪白：材质/颜色乘算，不要克隆整张贴图。
- 连招/取消窗口用代码时间轴控制，动画只做表现。

## 验收

- 预览里真的播一遍：`cocos_preview action=run` + `cocos_screenshot scope=game`。
- `cocos_logs` 查 clip 缺失、骨骼版本、资源未导入。
- 打包后确认动态加载的 clip 在包内（`cocos_asset action=deps`）。
- 改过节点路径要注意：clip 轨道按路径找节点，路径变了动画就静默失效。

相关 skill：动画状态机设计 `animation-state-patterns`、`2d-animation-pipeline`、`3d-animation-pipeline`；
Spine 绑骨 `spine-rig`；手感 `game-feel`。
