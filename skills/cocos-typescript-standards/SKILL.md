---
name: cocos-typescript-standards
description: Cocos Creator 3.x 的 TypeScript 写法规范：cc 模块导入、@ccclass/@property 声明、组件生命周期、事件注册、空值与异步、目录与依赖方向。
whenToUse: 写或改 Cocos 组件脚本、声明可序列化属性、排查「属性面板不显示槽位」「missing script」、统一团队 TS 风格，或组件脚本报类型错误时。
---

# Cocos TypeScript 规范（3.x）

## 导入与类声明

```ts
import { _decorator, Component, Node, Vec3, tween, CCInteger, CCFloat, Enum } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('PlayerController')     // 名字全局唯一
export class PlayerController extends Component {
  @property(Node) target: Node = null!;
  @property({ type: CCInteger, min: 0, max: 10, step: 1, tooltip: '移动速度' })
  speed: number = 5;
}
```

- 3.x 用 ES Module，**不要 `require`**；引擎 API 全部从 `'cc'` 导入。
- JS 也能写，但新项目优先 TS：属性槽位、类型提示、重构都靠它。

## @property 怎么写

| 需求 | 写法 |
|---|---|
| 单个节点/组件 | `@property(Node) target: Node = null!;` |
| 基础数值 | `@property({ type: CCInteger, min: 0, max: 100 }) hp = 100;` |
| 浮点 | `@property({ type: CCFloat, step: 0.1 }) speed = 3.5;` |
| 数组 | `@property({ type: [Node] }) waypoints: Node[] = [];` |
| 资源 | `@property(Prefab) bullet: Prefab = null!;`、`@property(SpriteFrame) icon: SpriteFrame = null!;` |
| 枚举 | `enum State { Idle, Run }` + `@property({ type: Enum(State) }) state = State.Idle;` |

- 不写 `type` 且是数组/对象时，编辑器不会给槽位；`Enum`、`CCInteger` 这些都要从 `'cc'` 导入。
- `null!` 只用于「编辑器里一定会连线」的引用；运行期可能为空的引用必须判空。

## 生命周期顺序

```
onLoad → onEnable → start → update(dt) → lateUpdate → onDisable → onDestroy
```

- `onLoad`：抓引用、初始化自身数据（此时父节点可能还没 start）。
- `start`：依赖其他节点/组件的初始化。
- `onEnable` / `onDisable`：注册与反注册事件，成对出现。
- `onDestroy`：退事件、停 tween、清定时器、取消异步回调。
- `update(dt)` 只做每帧必须做的事；移动乘 `dt`，物理相关走固定步长。

## 事件与回调

```ts
onEnable() { this.node.on(Node.EventType.TOUCH_END, this.onTap, this); }
onDisable() { this.node.off(Node.EventType.TOUCH_END, this.onTap, this); }
```

- 事件三件套：`node.on(type, fn, this)`、`off`、`once`；漏 `off` 是内存泄漏和重复回调的头号原因。
- 异步加载/延时里回引用节点前先 `isValid(this.node)`，否则销毁后回调报错。

## 空值、类型与风格

- 开启 `"strict": true` 要在**项目** `tsconfig.json` 里开，别改 `temp/` 下编辑器生成的文件。
- 不用 `any` 兜底：数据用 interface，组件引用用具体组件类。
- 配置数值统一放 `data/` 的 JSON 或 `@property`，别散落魔法数字。
- 访问修饰符：内部状态 `private`，给子类留的 `protected`，只读配置 `readonly`。
- 日志：`console.log` 会进编辑器控制台；正式包用统一 Logger 开关，别每帧打日志。

## 编译与常见报错

- `missing script`：脚本编译失败或类名重复。先看 `cocos_logs` 的编译错误，
  修好等导入完成再重新挂组件；不要在报错状态下反复 addComponent。
- 属性面板没有槽位：`@property` 漏了 `type`（尤其数组、枚举）。
- `Cannot find module 'cc'`：工程不是 3.x，或文件被放到了 `assets/` 外。
- 改完脚本必须等编辑器编译：`cocos_logs` 无错 + 属性面板出现槽位，才算就位。

## 分层依赖

- `core/` 不 import `'cc'`（纯 TS，可单测）；`gameplay/` 依赖 core；`ui/` 依赖 gameplay，
  反向依赖用事件/回调，不要让 core 认识 UI。

相关 skill：架构分工看 `cocos-component-architecture`；纯逻辑单测看 `cocos-testing`。
