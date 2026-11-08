---
name: cocos-ui-layout
description: Cocos Creator 3.x UI 布局与多分辨率适配：Canvas/fitWidth、Widget 贴边、Layout 容器、Label、ScrollView 列表、Button 与 EventHandler、Graphics 现画 vs Sprite 贴图的分流判据、安全区与 drawcall 控制。
whenToUse: 做主界面/HUD/弹窗/设置页、适配不同比例手机、列表卡顿或错位、按钮点不到、Widget 与 Layout 打架、UI 层级与遮罩设计时；或遇到「要不要加 cc.Button / 换不换 Sprite / cc.Sprite 与 cc.Graphics 冲突」这类选型问题时。
---

# UI 布局与多分辨率（Cocos 3.x）

## 结构先定好

```
Canvas (Canvas + Camera + UITransform)
  ├─ SafeArea
  │    ├─ HUDLayer      血条、摇杆、按钮
  │    ├─ ScreenLayer   弹窗、暂停、结算
  │    └─ TopLayer      提示、飘字、遮罩
```

- 一个 UI 场景通常**一个 Canvas**；多 Canvas = 多相机 + 多渲染批次，除非必要不要加。
- 相机 `clearFlags` 配错会出现 UI 盖住 3D 或整体黑屏：UI 相机只清 UI 层。
- 每个参与显示/点击的节点必须有 `UITransform`，否则不布局、不响应触摸。

## 设计分辨率与适配

- 项目设置 → Project Data：设计分辨率（如竖屏 750×1334）、Canvas 的 `fitWidth` / `fitHeight`。
- 竖屏常用 `fitWidth = ON`（宽度完整，高度多退少补）；横屏反之用 `fitHeight = ON`。
- 适配后多出来的空间靠 **Widget 贴边 + 可拉伸背景**吃掉，不要依赖绝对坐标。
- 自检比例：16:9、19.5:9、4:3（iPad）各截一次图看有没有错位/溢出。

## Widget：对齐比手摆靠谱

- `alignFlags`：上/下/左/右/水平居中/垂直居中；再填四边距离。
- `alignMode`：`ONCE`（只对齐一次）、`ON_WINDOW_RESIZE`（窗口变化时）、`ALWAYS`（每帧，贵，少用）。
- 顶部 HUD 用「上 + 左右」贴边；底部按钮用「下 + 左右」；全屏背景四边都贴。
- Widget 和父级 Layout 同时作用容易互相打架：容器用 Layout 排，子项用 Widget 处理边距。

## Layout：列表与网格

- `type`：HORIZONTAL / VERTICAL / GRID；`resizeMode`：NONE / CONTAINER / CHILDREN。
- 间距 `spacingX/Y`、padding 四边、GRID 的 `startAxis`。
- 动态增删子项后调 `layout.updateLayout()` 立即重排；否则要等下一帧。
- 长列表别一次建几百个节点：做**虚拟列表**，只渲染视口内的项，配合对象池。

## Label 与文字

- `overflow`：NONE（溢出）/ CLAMP（裁切）/ SHRINK（缩字号）/ RESIZE_HEIGHT（自动高）。
- `cacheMode`：NONE、BITMAP（位图缓存，省重绘）、CHAR（字符缓存，适合频繁改的短文本）。
- 系统字最省事；固定风格 UI 用位图字体，注意字号与多语言字符集。
- 描边/阴影组件会增加 drawcall，大量文本慎用。

## ScrollView

- 结构：ScrollView → view（带 Mask）→ content（挂 Layout）。
- 惯性 `inertia`、回弹 `elastic`、`brake` 按手感调；`scrollToPercentVertical` 做定位。
- 触摸拖动与按钮点击冲突时：按钮放在可滚动内容里，靠 Button 的按压阈值区分，别自己拦事件。

## 先分流：这个按钮底是「贴图」还是「现画」？

**这是 UI 改造里最容易踩错的一步。** `cc.Sprite` 与 `cc.Graphics` 在同一个节点上**互斥**
（Cocos 会报 `Can't add component 'cc.Graphics' to X because it conflicts with the existing component 'cc.Sprite'`），
所以按钮底用哪种画法，直接决定你要不要 `cc.Button`、要不要 `cc.Sprite`。

| 按钮底的画法 | 判断依据 | 组件方案 | 点击回调 |
|---|---|---|---|
| **Sprite + SpriteFrame**（九宫格/图集/切图） | 节点上有 `cc.Sprite` 且 `spriteFrame` 已绑定 | 用 `cc.Button`：`transition`(COLOR/SPRITE/SCALE) + `target` 指向外观节点 + `interactable` | `cc.Button` 的 `clickEvents` 挂 **EventHandler**，或代码 `on(Button.EventType.CLICK)` |
| **Graphics 现画**（圆角渐变、描边、柔影、运行时换色） | 节点上有 `cc.Graphics` 且画法在代码里 | **不要加 `cc.Button`**：`Button` 的 COLOR/SPRITE 过渡依赖 `cc.Sprite`，加了要么冲突要么过渡失效 | 自定义组件监听 `TOUCH_START/END/CANCEL` 自己实现按压态；禁用态自己维护 `interactable` |
| **纯色块 / 无底** | 只有 UITransform | `cc.Button` 可用（无过渡，纯当命中区） | 同上 |

### 为什么 Graphics 路线不加 `cc.Button`

- `cc.Button` 的默认 `transition = COLOR` 要改 **Sprite 的 `color`**；没有 Sprite 就什么都不发生。
- 圆形渐变底、描边、柔影在 Graphics 里画的，加 Sprite 只能二选一。
- 运行时按主题 token 换色（`Theme` 色板）时，Sprite 方案要备一堆贴图变体，图集碎片化反而**降低**合批率。

### `cc.EventHandler` 与 `cc.Button` 是两回事

**`cc.EventHandler` 是独立组件，可以挂在任何节点上，不需要 `cc.Button`。**

- 想让策划在属性检查器里连线（选 target 组件 + 填方法名 + 自定义参数），
  挂 `cc.EventHandler` 就行，**不必**为了连线去引入 `cc.Button`。
- 所以「Graphics 现画」的项目照样能拿到策划连线的能力：自己写一个组件消费
  `EventHandler.emit('click', ...)`，或直接用 `cc.EventHandler` 的 `emit` 机制。
- 反过来，如果项目用 Sprite 底，`cc.Button` + `clickEvents`（EventHandler 列表）才是标准路径。

### 通用交互规范（两条路线都适用）

- 热区至少 44×44 逻辑像素；相邻按钮留间距。
- 禁用态要有**视觉**（变灰底/灰字）和**行为**（不触发回调）两半，只有行为没有视觉玩家会以为能点。
- 弹窗要有半透明遮罩 + 关闭方式（点遮罩/返回键），并确保遮罩能拦截下层点击。
- 触摸事件会沿父节点冒泡；全屏遮罩要吃掉事件，否则点弹窗时底下的按钮也会响应。

## Graphics 现画 vs Sprite 贴图：整体取舍

| 维度 | Graphics 现画 | Sprite 贴图 |
|---|---|---|
| 圆角/渐变/描边 | 任意、代码可控 | 受限于素材（九宫格只能圆角矩形） |
| 运行时换色 | 改参数即可 | 要贴图变体或改材质 |
| drawcall | **每节点 1 个** | 同图集可合批；不同图集各 1 个 |
| 每帧重画 | 会（`Graphics` 指令重建） | 不会 |
| 包体 | 无贴图成本 | 贴图 + 图集成本 |
| 策划可调 | 改组件参数 | 换图/调导入设置 |

**Graphics 路线不是「落后」，是「不依赖美术资源管线」的方案。** 没有图集、没有美术出图排期、
界面配色还要跟主题 token 联动时，Graphics 往往是更省事的选择。

**但要盯着 drawcall**：一次性画的（`onEnable` 画一次）问题不大；
**每帧重画**的 Graphics（动态血条、拖拽预览、粒子）才是性能坑。

**换贴图的时机**：同一视觉重复出现很多次（如 22 个棋子的落地影）→ 换一张共享贴图最划算；
视觉各不相同的（每个按钮不同渐变）→ 换贴图反而更贵，保留 Graphics。

## 安全区与刘海

- 根节点挂 `SafeArea` 组件；需要动态算就用 `sys.getSafeAreaRect()`。
- 状态栏/刘海区域不要放关键按钮；底部手势条区域留白。

## 性能与层级

- 同图集 + 同材质 + 连续层级才能合批；Label、Mask、不同贴图都会打断批次。
- `Mask` 至少多两个 drawcall，能换九宫格底板就别用 Mask。
- 淡入淡出用 `UIOpacity`，不要每帧改节点 active。
- 层级越扁平越好；同一个弹窗不要拆成十几个 Canvas。
- **Graphics 路线**：一次性画的节点各占 1 个 drawcall 是可接受的；每帧重画的是性能坑。
- **Sprite 路线**：图集碎片化会让「本来能合批的」变多批次 —— 换 Sprite 前先算合批收益。

## 验收

- `cocos_scene action=save` → `cocos_screenshot scope=scene`（或 `preview` / `game`）看：
  对齐、溢出、遮挡、热区、三种比例。
- `cocos_logs action=recent` 查布局告警、缺图、脚本错误。

相关 skill：先搭舞台 `cocos-scene-first-workflow`；通用 UI 方法 `game-ui-ux`、`ui-hud-patterns`；
动画反馈 `cocos-animation`；性能 `cocos-performance`。
