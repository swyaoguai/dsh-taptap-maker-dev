---
name: taptap-maker-core
description: TapTap Maker (UrhoX + Lua 5.4) 项目的总入口：工程结构、脚本生命周期、API 查法、构建与额度守则。开始任何 Maker 开发前先读。
whenToUse: 开始一个 TapTap Maker 游戏、搞不清工程结构/脚本入口/文档在哪、或拿不准该不该调用会花额度的工具时。
---

# TapTap Maker 开发总览

TapTap 制造（Maker）游戏运行在 **UrhoX**（Urho3D 衍生引擎）上，脚本语言是 **Lua 5.4**。

## 工程结构（典型）

- `scripts/` — Lua 代码。单机入口 `scripts/main.lua`；联机 C/S 为 `client_main.lua` + `server_main.lua`。
- `assets/` — 游戏资源（图片/音频/模型等）。**运行时资源监听器会给 `assets/` 下任何新文件自动补 `.meta` 并纳入构建**，所以中间产物（未裁的原图等）绝不能落在 `assets/` 里。
- `.project/` — 工程配置（project.json、settings.json、resources.json、i18n.json）。
- `engine-docs/` — 引擎 Lua 开发文档（见下），`.emmylua/` 与 `urhox-libs/` 是 API 真源，LSP 自动加载。

## API 怎么查

1. 优先用 LSP / MCP（hover / goToDefinition / workspaceSymbol，本地 `maker-lua-lsp`）。
2. 类型定义在 `.emmylua/`（每类一个 `.d.lua`），高层库源码在 `urhox-libs/`。
3. 分模块速查见 `engine-docs/api/index.md`。事件回调字段必查 `Events`。

## 脚本与场景

- 场景图：`Scene` → `Node` → `Component`。逻辑组件继承 `LogicComponent`（`Start/Update/FixedUpdate` 等）。
- 全局对象（`cache`、`input`、`renderer` 等）定义在各自 `.d.lua` 底部，见 `engine-docs/api/globals.md`。
- 常见模板在 `templates/`（scaffold-2d、scaffold-2d-physics、scaffold-3d-scene、scaffold-3d-character）。

## 构建 / 预览 / 提交

- 改完 Lua：若 LSP 就绪，**先用 LSP 诊断确认无 Error 再构建**。
- 构建 / 远程 Web 预览 / 提交：走 Maker 构建工具（这会把工作区提交并推送）。
- 本地窗口预览用 `taptap-maker preview --target-dir`，不提交、不远程构建。

## 额度红线（本插件强制）

- **非用户在当前对话明确要求，不要调用消耗内置额度的生成工具**：`generate_image`、`batch_generate_images`、`edit_image`、`create_video_task`、音频/语音/音乐/3D 生成等。
- 需要图片素材优先走自定义生图通道 → 见 `taptap-maker-custom-image-gen` skill。
- 只读/状态/构建/反馈/LSP 类 Maker 工具不花额度，可正常用。

## 子领域 skill 索引

UI → `taptap-maker-ui`；材质/渲染 → `taptap-maker-rendering-materials`；物理 → `taptap-maker-physics`；相机 → `taptap-maker-camera`；动画状态机 → `taptap-maker-animation-fsm`；联机 → `taptap-maker-networking`；资源规范 → `taptap-maker-assets`；自定义生图 → `taptap-maker-custom-image-gen`。
