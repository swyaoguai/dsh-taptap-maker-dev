---
name: external-skills-catalog
description: 用户收集的 ~90 个游戏开发 skill 名单的分类与整合说明：哪些已内置、哪些是其它引擎（UrhoX+Lua 不能直接用、仅概念可借鉴）、以及如何把真实 skill 通过更新源拉进来。
whenToUse: 想知道某个点名的 skill（如 pixijs-*、godot-*、unity-*、msw-*）是否可用、要不要用、怎么补进来时。
---

# 外部 skill 名单：整合说明（诚实版）

TapTap Maker 跑在 **UrhoX（Urho3D 衍生）+ Lua 5.4** 上。名单里很多 skill 是**给别的引擎**的（Unity/Godot/Unreal/Roblox/PixiJS/Three.js/Babylon/Phaser/PlayCanvas/A-Frame/SpriteKit/GameKit/Minecraft/Factorio 等），它们的**代码/API 在 Maker 里不能直接用**，只有设计/概念层面可借鉴。

> 说明：本环境联网被禁用，无法抓取并原样内置这些第三方 skill 的正文，也不会编造其内容或下载地址。下面按“能不能在 Maker 用”分类；真实文件可通过更新源补入（见末尾）。

## A. 已内置（本插件，原创并对齐 Maker/通用设计）

- 对应名单里的通用项：`game-engine`/`game-developer`/`game-development`/`design-game` → **`taptap-maker-core` + `game-designer`**
- `game-feel`、`game-designer`、`level-design`、`game-assets`、`character-design-sheet`、`multiplayer-game`、`shader-dev`、`ai-pixel-art-image-generation` → **同名内置**
- `game-ui-design`/`game-ui-ux` → **`game-ui-ux`（+ `taptap-maker-ui`）**
- `ai-game-art-pipeline-skill`、`game-design-skills-bundle` → 由 `game-assets`+`ai-pixel-art-image-generation`+`game-designer`+`level-design`+`game-feel` 覆盖
- 另有 Maker 专属：`taptap-maker-core/ui/rendering-materials/physics/camera/animation-fsm/networking/assets/custom-image-gen`

## B. 其它引擎 —— 概念可借鉴，代码不可直接用

- **PixiJS**（`pixijs`、`pixijs-core-concepts`、`pixijs-scene-*`、`pixijs-performance`、`pixijs-assets`、`pixijs-filters`、`pixijs-ticker`、`pixijs-blend-modes`、`pixijs-color`、`pixijs-math`、`pixijs-events`、`pixijs-accessibility`、`pixijs-migration-v8`、`pixijs-html-source`、`pixijs-2d`…）：Web 2D 渲染库，API 与 Maker 无关；其**场景图/批渲染/图集/性能**理念可参考 → 用 `game-assets`、`taptap-maker-rendering-materials`。
- **Godot**（`godot-master`、`godot-ui`、`godot-gdscript-patterns`、`godot-optimization`、`godot-asset-generator`）、**Unity**（`unity-ecs-patterns`、`unity-developer`、`unity-cli`）、**Unreal**（`unreal-engine-cpp-pro`）：引擎/语言不同；设计模式与优化思路可借鉴。
- **Web 3D**（`threejs-3d-generator`、`threejs-game`、`img2threejs`、`babylonjs-engine`、`playcanvas-engine`、`aframe-webxr`）、**Apple**（`spritekit`、`gamekit`）、`phaser`、`minecraftconsoles-lce`、`factorio-ai-companion`：平台专属，不可直接用。
- **DCC / 管线**（`substance-3d-texturing`、`blender-web-pipeline`、`blender-motion-state-inspection`、`omniverse-usd-performance-tuning`）：外部美术工具流程；产出的贴图/模型可按 `game-assets` 入库。

## C. MapleStory Worlds（`msw-*`）

`msw-scripting/general/defaultplayer/avatar/combat-system/painter/sprite-ruid/behaviourtree/packages/planning`：MSW 平台专属 Lua API，与 UrhoX **不通用**。其中**行为树**、**战斗系统**、**头像/立绘**、**规划**等**设计模式**可借鉴到 Maker（战斗见 `game-designer`，联机权威见 `multiplayer-game`）。

## D. 流程/工具/其它

- `bmad-gds`（BMAD 游戏设计流程）、`game-design-skills-bundle`：**流程方法**，可借鉴 → `game-designer`。
- `mcp-developer`：开发 MCP 插件用，与具体游戏无关。
- `anti-toxicity-chat-moderation-agent-skill`：仅当游戏有聊天时相关。
- `gog-cli`（GOG 商店 CLI）、`murder-mystery-2-analytics-toolkit`、`mm2-roblox-analytics-tracker`（Roblox 专属分析）、`lovgame-skill`、`clawworld-skill`：与 TapTap Maker **无直接关系**或来源不明，不内置。

## 如何把真实 skill 补进来（有网 + 有源时）

本插件的更新器会从 `config.skills.sources` 拉取并缓存，热更新到 skill 列表。源可以是：

```yaml
- id: taptap-maker-dev
  name: dsh-taptap-maker-dev
  config:
    skills:
      sources:
        - 'git:https://github.com/<owner>/<repo>.git'   # 仓库里含 skills/<name>/SKILL.md
        - 'dir:D:\path\to\your\skills'                     # 本地目录
        - 'https://host/path/<name>/SKILL.md'              # 单个 skill
```

拉进来的 skill 直接出现在列表里，可被模型/命令调用。详见 `skill-authoring`。
