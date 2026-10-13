---
name: taptap-maker-ui
description: TapTap Maker 游戏 UI 开发：用 urhox-libs/UI（Yoga Flexbox + NanoVG，40+ 控件），不要用已废弃的原生 Urho UIElement/Button；并先查风格主题 skill。
whenToUse: 做游戏内 UI、HUD、菜单、大厅界面，或要套某种 UI 风格时。
---

# TapTap Maker UI

游戏 UI 使用 **`urhox-libs/UI`**：Yoga（Flexbox 布局）+ NanoVG（矢量绘制），40+ 控件。

- 指南：`engine-docs/recipes/ui.md`；源码即 API 参考：`urhox-libs/UI/`。
- 自定义大厅：`engine-docs/recipes/custom-lobby.md`（模板换皮 / 完全自建）。
- 界面里嵌 3D 预览：`engine-docs/recipes/scene-to-nanovg.md`（`nvgCreateVideo` 等）。
- NanoVG 发光/Bloom：`engine-docs/recipes/nanovg_bloom_glow_guide.md`。
- 分辨率自适应写法：参考项目的 `nvg-resolution-mode` 范式/skill。

## 硬规则

- **不要用** `.emmylua/` 里的原生 Urho3D C++ UI 组件（`UIElement`、`Button`、`Text` …）——**已废弃**，仅向后兼容。
- **风格化 UI 禁止凭空编造**：用户要带风格特征的 UI 时，先查是否有对应风格 skill（引擎预置多套，如 `ui-astroon`、`ui-brawlforge`、`ui-pixelforge` 等，含配色/字体/圆角/阴影规范与模板），选合适的再做。

## 布局要点

- 用 Flexbox 思路搭：容器方向、主轴/交叉轴对齐、flex-grow、padding/margin。
- 文本与矢量图形走 NanoVG；注意分辨率缩放因子，别写死像素。
