---
name: taptap-maker-rendering-materials
description: TapTap Maker 渲染与材质：优先用内置 Technique/材质，做不到的效果写 SurfaceShader（不要手写底层 glsl/Technique XML）；灯光组、天空盒/天空球、后效开关。
whenToUse: 配置材质、灯光、天空、后处理，或要做内置材质覆盖不了的自定义着色效果时。
---

# TapTap Maker 渲染 / 材质

## 材质

- 材质列表与参数：`engine-docs/recipes/materials.md`。
- 内置 Technique 做不到的效果 → **改写 SurfaceShader**，见 `engine-docs/recipes/surface-shader.md`。
- **不要手写底层 `.glsl` / Technique XML**；走 SurfaceShader 这条受支持的路。

## 渲染配置

- 灯光组、天空盒 / 天空球、后效开关：`engine-docs/recipes/rendering.md`。
- 相关类：`Zone`（环境/雾/环境光）、`Skybox`、`Light`、`RenderPath`、`Viewport`、`DepthOfField`。

## 过程化几何 / 离线

- 程序化几何：`engine-docs/recipes/procedural-geometry.md`。
- 用引擎跑一段 Lua 后退出（离线/程序化）：`engine-docs/recipes/procedural-lua-headless.md`，配合 `run-lua-headless` 范式。

查具体类签名走 LSP 或 `.emmylua/`。先读 recipe 再动手，别猜 Technique 名——不存在的 Technique 直接用 materials skill 里列的。
