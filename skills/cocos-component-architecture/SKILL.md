---
name: cocos-component-architecture
description: Cocos Creator 3.x 的组件与场景架构：组件职责划分、@property 连线、事件总线、管理器与常驻节点、场景切换、对象生命周期与反模式。
whenToUse: 设计玩法系统骨架、划分组件职责、组件之间要通信、要做场景切换/常驻管理器、发现 find 满天飞或万能 GameManager 时；搭完舞台、准备写逻辑前。
---

# Cocos 组件与场景架构

先搭舞台再写逻辑（`cocos-scene-first-workflow`）；这一篇解决「舞台搭好后，代码怎么分层」。

## 一条主线

**场景/预制体是组装，组件是行为。** 节点树负责「有什么、摆哪、连什么引用」；
组件只负责「这个节点会做什么」。两者混在一起，就会出现「改个位置要改代码」。

## 组件怎么切

- 一个组件一个职责：`PlayerMove`（输入→位移）、`PlayerHealth`（血量/受击）、
  `PlayerAnim`（状态→动画）。不要 `PlayerController` 什么都干。
- 组件之间能通过节点拿到就通过节点拿（`getComponent` 缓存到 `onLoad`），拿不到就发事件。
- 每个组件只暴露必要的 `@property`，方便策划在面板里调；不要暴露一堆内部节点。

## 引用怎么连

1. **首选编辑器连线**：`@property(Node)` / `@property(PlayerMove)`，面板里拖。
2. **同节点/子节点**：`onLoad` 里 `getComponent` / `getChildByName`，缓存成字段。
3. **`find` 只允许出现在一个 Bootstrap 里**，集中把引用注入各系统；禁止散落在 update。

## 通信怎么选

| 范围 | 方式 | 注意 |
|---|---|---|
| 父子、同一实体 | 直接引用调方法 | 最直接，别绕事件 |
| 兄弟系统（血量→UI） | 全局 `EventTarget` 事件总线 | 事件名定义成常量，参数用对象 |
| 只读数据（配置/存档） | 单例数据对象 + 变更事件 | 别让各处直接改 |
| 玩家输入 → 角色 | 输入层产出动作状态，角色采样 | 不要各自监听键盘 |

```ts
import { EventTarget } from 'cc';
export const bus = new EventTarget();
export const GameEvent = { HpChanged: 'hp-changed', GameOver: 'game-over' } as const;
bus.emit(GameEvent.HpChanged, { hp, maxHp });
```

- 事件要在 `onEnable` 订阅、`onDisable` 退订；切场景时全局总线不会自动清，常驻监听要手动清。

## 管理器与常驻节点

- 纯逻辑管理器（计时、存档、音频）用普通类单例，**不要为了单例建节点**。
- 确实需要跨场景存活的表现（BGM、转场遮罩）：`director.addPersistRootNode(node)`，
  放在场景根下；切场景前手动清理监听，否则会重复触发。
- 场景切换：`director.loadScene('Game', cb)`；大数据场景先 `director.preloadScene`，
  加载期间给个 loading 界面，别让黑屏。

## 对象生命周期

- `instantiate(prefab)` 得到节点，**先注入数据再 `setParent`**：挂到场景那一刻就会走 `onLoad`，
  先挂再设数据会让组件读到空值。
- `node.destroy()` 是帧末销毁；销毁后判断用 `isValid(node)`。
- `onDestroy` 里：`off` 事件、`Tween.stopAllByTarget`、清 `schedule`、关定时器。
- 频繁生成/销毁的（子弹、飘字、格子）走 `NodePool`，不要每次 instantiate。

## 状态与数据流

- 角色状态机用枚举 + 明确转移表；动画、音效、输入响应都由状态驱动，
  不要让动画帧事件反过来驱动核心逻辑（掉帧/跳过会不一致）。
- UI 只读状态 + 发命令（`bus.emit('attack')`），不直接改 gameplay 内部字段。

## 反模式（看到就改）

- 万能 `GameManager` 上帝类：拆成计时/存档/音频/关卡几个小管理器。
- `update` 里 `find` / `getComponent` / `new Vec3`：全部提到 `onLoad` 或复用临时对象。
- 用 `window.xxx` 挂全局：用模块单例，方便清理和测试。
- 组件互相 `getComponent` 成环：抽事件或抽数据层。
- 预制体引用场景节点：预制体必须能独立实例化，反向依赖会断。

## 验收

- 节点树和引用关系能画成一张表（节点 → 组件 → 暴露属性），写进计划里。
- 改完保存场景 + `cocos_screenshot` + `cocos_logs`；预制体 `cocos_asset action=validate`。
- 单测覆盖 core 层；组件层用预览 + 截图冒烟（`cocos-testing`）。

相关 skill：场景搭建 `cocos-scene-first-workflow`；TS 写法 `cocos-typescript-standards`；
资源与预制体 `cocos-resource-prefabs`；通用架构方法 `gameplay-architecture`。
