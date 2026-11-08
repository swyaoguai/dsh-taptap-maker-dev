---
name: cocos-scene-first-workflow
description: Cocos Creator 舞台优先（stage-first）开发铁律：做场景、节点树、UI/HUD/主界面/菜单/按钮、预制体、物理分组、组件挂载前先加载。要求 AI 像人一样在编辑器里建节点、挂组件、配碰撞分组、保存并截图验证，之后才规划代码；禁止用代码动态 new 节点拼 UI 或场景。
whenToUse: 在 Cocos Creator 项目里做任何玩法/UI/场景开发时先加载：主界面/HUD/菜单、按钮与弹窗、场景搭建、预制体制作、物理体与碰撞分组、相机灯光布置、节点树调整；或发现 AI 打算用代码动态创建节点、动态挂载 UI、用 find 拼场景时立刻加载，强制走「先搭舞台 → 再规划代码」的顺序。
---

# Cocos 场景优先工作流（Stage-First）

灵感来源：pink-automation-bridge（PinK/Cocos 编辑器 MCP 桥）的工作流 —— AI 通过
`scene_query_node_tree → scene_create_node → scene_add_component → scene_set_property → scene_save → scene_capture_screenshot`
形成「像人一样搭场景 → 截图自查 → 再改」的闭环。落到本插件，对应的是 `cocos-creator-mcp` 那套 `cocos_*` 工具。

## 铁律：为什么不能动态写

1. **场景是资产，代码是逻辑。** 节点树、组件、引用、物理分组都摆在编辑器里，策划/美术/人才能看见、才能调。代码里 `new Node()` + `addComponent` 动态拼 UI/舞台，等于把「美术资产」藏进代码，后期没法拖拽调整、没法复用预制体、没法给策划改数值。
2. **AI 动态写节点 = 把场景结构变成一次性代码。** 下次要改一个按钮位置，就得改代码重新跑；人搭的节点拖一下就行。
3. **组件引用要在编辑器里连线**（`@property(Node)` 拖引用）。动态创建的引用链 AI 自己都记不住。

因此：**凡是会长期存在的 UI、舞台、实体、相机、灯光，一律在编辑器里建节点挂组件；代码只写行为逻辑。** 允许动态创建的只有：子弹/飘字/粒子这类纯运行期临时对象（用 Prefab 实例化，仍然不能 new 出裸节点）。

## 标准流程（照顺序，不许跳）

### 第 0 步：先看现场
- `cocos_projects` / `cocos_status` 定工程（多项目并行必带 `project`）。
- `cocos_scene`（query/info + 层级）看当前场景结构；没有舞台场景就先新建/打开目标场景。
- **禁止在不看节点树的情况下开始写任何代码。**

### 第 1 步：搭舞台（像人一样点）
按人在编辑器里的顺序操作 `cocos_exec`（scene 上下文）：
1. 建 UI 根：Canvas → 依次建 Panel / 容器（用 Widget 对齐，别手摆坐标）。
2. 建 HUD 元素：Label（Label 组件 + 字体）、Sprite/Button（Sprite + Button + 可选 Label 子节点）、ProgressBar/Slider 等，每个都按「建节点 → 挂组件 → 设属性 → 设布局」走。
3. 建游戏舞台：世界根节点 → 玩家/敌人/相机（Camera 先配好 clearFlags、正交尺寸）/ 灯光。
4. **每个有行为的节点都挂上业务组件**（先 `assets_write_file` 写脚本等编译导入，再 addComponent；新脚本加不上时等 2~5 秒重试）。
5. 有复用价值的（玩家、敌人、弹窗）`prefab` 化存盘。

### 第 2 步：物理与分组
- 物理体在编辑器里配：RigidBody + Collider 挂在节点上，形状/大小/摩擦弹性摆清楚。
- **碰撞分组/掩码在项目设置里建好**（Group 列表 + 矩阵），别在代码里临场 `setGroup`。AI 规划时先列出分组清单（default / player / enemy / bullet / wall / ui…）和谁撞谁，然后在编辑器里配好。
- 回调约定写进组件属性（还是编辑器里连线），不要代码里到处 `find("xxx")`。

### 第 3 步：保存 + 视觉验收（编译通过 ≠ 完成）
1. `cocos_scene action=save`。
2. `cocos_screenshot scope=scene` 真的看：层级对不对、位置/缩放/遮挡、按钮热区。
3. `cocos_logs action=recent` 查报错和脚本诊断。
4. 预制体再 `cocos_asset action=validate` 确认引用没丢。

### 第 4 步：场景稳了，才规划代码
舞台节点树 + 组件清单确认后，再写代码计划：
- 组件职责划分（每个业务组件管哪个节点、暴露哪些 `@property`）。
- 引用获取方式：优先编辑器连线 `@property`，其次是 `find` 兜底，禁止魔法字符串散落。
- 事件流：输入 → 业务组件 → UI 反馈，谁发谁收。
把「节点路径 → 组件 → 属性」写成一张对照表放进计划里，然后按组件逐个实现。改完重复第 3 步验收。

## 落地配方

具体怎么建 UI 根、按钮、Widget 容器、物理体、存 Prefab、配分组与自查，见
`references/recipes.md`（可直接抄的 `cocos_exec` 片段 + 常见失败对照表）。**动手前先读它。**

## 产出检查表（宣布完成前自问）

- [ ] 节点树是编辑器里搭的、可拖拽调整的，不是代码 `new` 出来的
- [ ] 每个交互元素有 Button/Widget/Label 等标准组件，布局用 Widget 而非硬编码坐标
- [ ] 物理分组在项目设置里配好，碰撞矩阵明确
- [ ] 代码里的节点引用全部通过 `@property` 连线（或集中一处 find）
- [ ] 场景已保存，截图看过，日志无错
- [ ] 临时对象全部从 Prefab 实例化

舞台搭好、开始写逻辑之后，按任务加载专题 skill（目录见 `taptap-skill-router` 的
「Cocos Creator 项目按需求加载」）：TS 写法 `cocos-typescript-standards`、组件分工
`cocos-component-architecture`、资源与预制体 `cocos-resource-prefabs`、UI 适配 `cocos-ui-layout`、
动画 `cocos-animation`、物理 `cocos-physics`、输入 `cocos-input`、性能 `cocos-performance`、
音频 `cocos-audio`、联网 `cocos-networking`、构建发布 `cocos-build-release`、编辑器扩展
`cocos-editor-tooling`、测试 `cocos-testing`。**一次只挑 1~2 个直接相关的，不要全加载。**
