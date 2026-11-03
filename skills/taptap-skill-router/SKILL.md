---
name: taptap-skill-router
description: 本插件自带的一百多个游戏开发 skill 的查阅目录：按游戏开发进度和用户当前这句话的需求，挑出这一步该加载的 1~3 个 skill。不确定该用哪个 skill、开始一个新阶段、或用户换了话题时先读它。
pinned: true  # 治理类：路由目录必须和内置 skill 集合一致
---

# Skill 查阅目录（给 AI 用）

> 这是**你自己查**的目录，不是给用户挑的清单。别把这张表念给用户听，
> 也别问「你想用哪个 skill」—— 你按当前情况判断，直接加载、直接照做。

skill 列表里只有名字和一句话简介，正文要用 `skill` 工具加载后才进上下文。
这份目录的作用是让你**少加载、加载准**：每一步只加载和当前任务直接相关的 1~3 个，
做完这一步、换到下一个话题时再按需加载别的。不要一次把一整类都加载进来。

## 怎么用

1. 先判断**引擎**（TapTap Maker / Godot / Unity / Unreal / 网页 —— 看下面「其他引擎」一节的线索）。
2. 再判断**项目进度**（看下面「按进度」）和**用户这句话要干什么**（看「按需求」）。
3. 两张表交叉，挑最贴近的 1~3 个加载；**当前引擎专属的优先**（Maker 项目就是 `taptap-maker-*`，Godot 项目就是 `godot-*`），
   通用设计 skill（`game-designer`、`level-design`、`game-feel` 等）补方法论。
4. 用户没要求、当前步骤也用不上的 skill，不加载。
5. 不用告诉用户「我加载了哪个 skill」，除非他问。

判断进度的线索：有没有 `.project/project.json`、`scripts/main.lua` 写了多少、
`assets/` 里有没有正式素材、有没有 GDD / GAME_RULES.md、用户说的是「想做个…」还是「这里有 bug」还是「准备上线」。

## 按进度

| 进度 | 典型线索 | 常用 skill |
|---|---|---|
| 刚起步 / 定玩法 | 空目录、只有想法 | `taptap-maker-core`、`game-designer`、`core-loop-design`、`vertical-slice-planning`、`gdd-writing` |
| 搭原型 | main.lua 刚开始写 | `taptap-maker-core`、`gameplay-architecture`、`input-abstraction`、`placeholder-asset-pipeline` |
| 做内容 | 玩法跑通，开始加关卡/敌人/系统 | `level-design`、`combat-design`、`progression-design`、`economy-balancing`、`quest-design`、`narrative-design`、`procgen-design` |
| 做美术和音频 | 要换掉占位素材 | `taptap-maker-assets`、`taptap-maker-free-assets`、`game-assets`、`art-bible`、`audio-implementation` |
| 打磨手感 | 「不够爽」「没打击感」 | `game-feel`、`game-feel-design`、`vfx-pipeline`、`ui-animation-pipeline` |
| 测试和修 bug | 报错、卡顿、玩家反馈 | `bug-triage`、`crash-triage`、`verification-loop`、`playtest-analysis`、`performance-budgeting` |
| 准备上线 | 「要发布」「提审」 | `release-readiness`、`store-submission`、`compliance-checklists`、`localization-pipeline`、`liveops-design`、`monetization-design` |

## 按需求

| 用户在说 | 先加载 | 需要时再加 |
|---|---|---|
| 新建 / 初始化 Maker 项目、不知道从哪开始 | `taptap-maker-core` | `game-designer` |
| 做 UI、菜单、HUD、按钮 | `taptap-maker-ui` | `game-ui-ux`、`ui-hud-patterns`、`ui-asset-pipeline` |
| 物理、碰撞、刚体、2D Box2D | `taptap-maker-physics` | `physics-gameplay-patterns` |
| 相机、视野、点击拾取 | `taptap-maker-camera` | — |
| 角色动画、状态机、骨骼挂点 | `taptap-maker-animation-fsm` | `animation-state-patterns`、`3d-animation-pipeline` / `2d-animation-pipeline` |
| 2D 骨骼、部件绑骨、Spine | `spine-rig` | `2d-animation-pipeline` |
| 让角色动起来、视频转序列帧 | `taptap-maker-video-frames` | `sprite-pipeline` |
| 材质、光照、着色器、天空盒 | `taptap-maker-rendering-materials` | `shader-dev`、`materials-shading-pipeline`、`lighting-lod-pipeline` |
| 联机、多人、排行榜、云存档 | `taptap-maker-networking` | `multiplayer-game`、`multiplayer-netcode-patterns` |
| 存档 | `save-system-patterns` | — |
| 敌人 AI、寻路、行为树 | `ai-behavior-patterns` | — |
| 要图片素材 | `taptap-maker-free-assets` | `taptap-maker-custom-image-gen`、`ai-pixel-art-image-generation`、`generated-raster-asset-pipeline` |
| 章鱼生图 | `zaiduyu-imagegen` | — |
| 角色设定图、三视图 | `character-design-sheet` | `art-bible` |
| 3D 模型导入、朝向不对、比例不对 | `asset-orientation-qa` | `3d-asset-pipeline`、`asset-visual-qa` |
| 素材做完了要验收 | `asset-visual-qa` | — |
| 音效 / BGM | （按插件守则直接走 CC0 库和 BGM 命令） | `audio-implementation`、`taptap-maker-local-sfx` |
| 瓦片地图 | `tilemap-pipeline` | `level-design` |
| 新手引导 | `onboarding-tutorial-design` | `accessibility-design` |
| 掉帧、内存 | `performance-budgeting` | `memory-budgeting`、`lighting-lod-pipeline` |
| 埋点、数据统计 | `telemetry-instrumentation` | — |
| 排期、风险 | `milestone-planning` | `risk-register` |
| 给插件加 / 改 skill | `skill-authoring` | `external-skills-catalog` |

## 其他引擎的 skill 什么时候用

Maker 是 UrhoX + Lua，`godot-*`、`unity-*`、`unreal-*`、`pixijs-*`、`web-*` 的 API 不能直接搬进 Maker。
但它们**不是废的**，下面这些情况就加载对应的：

- 用户的项目本身就是那个引擎（看到 `project.godot`、`*.unity`/`Assets/`、`*.uproject`、`package.json` 里有 `pixi.js`）。
- 用户问「这个在 Unity / Godot 里怎么做，Maker 里怎么对应」——加载那边的 skill 看思路，再用 `taptap-maker-*` 落地。
- 做网页小游戏、网页版工具或 H5 预览——用 `web-*` 和 `pixijs-*`。
- Maker 的 skill 没覆盖、而别的引擎 skill 里有可借鉴的通用做法（比如 `unreal-gas-patterns` 的技能系统拆法、`godot-signals-patterns` 的事件解耦思路）。借思路，别抄 API。

## 不要做的

- 不要为了「保险」把一整类 skill 全加载。
- 不要加载了 skill 却不照着做；加载了就按它的步骤来。
- skill 和插件守则（额度红线、不自动花钱、不自动下载大模型）冲突时，守则优先。
