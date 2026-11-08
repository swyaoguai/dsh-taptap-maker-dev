---
name: cocos-input
description: Cocos Creator 3.x 输入：全局 input 事件、节点触摸与冒泡、Button/EventHandler、键鼠与多点触控、虚拟摇杆、输入抽象与缓冲、UI 与玩法输入隔离。
whenToUse: 做移动/跳跃/攻击操作、虚拟摇杆、点击拾取、键位设置、触摸不响应、按钮和拖拽冲突、手机手感发飘时。
---

# 输入（Cocos 3.x）

## 两套入口，别混用

1. **全局 `input`**：键盘、鼠标、触摸，与节点无关。
2. **节点触摸事件**：`node.on(Node.EventType.TOUCH_START, ...)`，需要节点有 `UITransform`、
   在 UI 层级里、`active`，且没有被上层挡住。

```ts
import { input, Input, KeyCode, EventKeyboard } from 'cc';

input.on(Input.EventType.KEY_DOWN, (e: EventKeyboard) => {
  if (e.keyCode === KeyCode.KEY_A || e.keyCode === KeyCode.ARROW_LEFT) this.moveX = -1;
}, this);
```

- 鼠标：`MOUSE_DOWN` / `MOUSE_UP` / `MOUSE_MOVE` / `MOUSE_WHEEL`。
- 触摸：`TOUCH_START` / `TOUCH_MOVE` / `TOUCH_END` / `TOUCH_CANCEL`；`e.getID()` 区分手指。
- 坐标：全局事件给屏幕坐标；节点事件用 `e.getUILocation()` 拿 UI 坐标再转本地。
- 局部用 `input.off(...)` / `node.off(...)`，在 `onDisable` 里退干净。

## 节点触摸与冒泡

- 触摸事件会沿父节点冒泡，父容器也能收到；要拦住用 `event.propagationStopped = true`。
- 点不到先查三件事：有没有 `UITransform`、有没有被上层全屏节点挡住、相机的可见层对不对。
- 拖拽：`TOUCH_START` 记录起点 → `TOUCH_MOVE` 算位移 → `TOUCH_END` 结算；
  按住期间用 touch ID 跟踪，避免多指乱序。

## Button 与 EventHandler

- Button 的点击在「按下后仍在按钮内抬起」时触发：`button.node.on(Button.EventType.CLICK, cb, this)`。
- 给策划连线用 **EventHandler**（组件 + 方法名 + 自定义参数），比写死回调灵活。
- `interactable = false` 是禁用态；`transition` 管按下的视觉反馈。
- 想区分长按/双击，自己在 `TOUCH_START/END` 上加计时，Button 只负责单击。

## 输入抽象（必做）

```ts
// 输入层产出「意图」，玩法层只读意图，不直接听键盘
export interface InputState {
  moveX: number;          // -1..1
  jumpPressed: boolean;   // 本帧按下
  attackPressed: boolean;
}
```

- 动作表：键盘/触屏/手柄都映射到同一组动作；换平台只改映射层。
- 每帧采样：held / pressed（本帧新按下）/ released；UI 打开时整层门控（`inputEnabled = false`）。
- 手感缓冲：跳跃缓冲（提前按也算）、土狼时间（离开平台后短时间内仍可跳）、输入合并窗口。
- 移动端摇杆：固定区域或浮动区域，死区（如 0.15）后归一化，`moveX/moveY` 连续值。
- 键位重绑定存 `sys.localStorage`；按平台给默认（手机出摇杆，桌面显示键位提示）。

## 隔离与冲突

- 全局 `input` **不会**因为 UI 打开而停止：必须用状态门控，否则点弹窗时角色还在动。
- 滚动列表里放按钮：靠位移阈值区分点击与拖动，不要两边都硬拦。
- 触摸穿透：全屏弹窗加一个能吃事件的遮罩节点。

## 验收

- `cocos_logs` 打点确认事件是否触发；预览里点、拖、连点各试一次。
- 手机/触屏尺寸下试热区；多指同时按（移动 + 攻击）不能互相取消。
- 切场景、重开、UI 开关后输入状态要复位。

相关 skill：输入架构 `input-abstraction`；物理角色控制 `cocos-physics`；手感 `game-feel`；
UI 热区 `cocos-ui-layout`。
