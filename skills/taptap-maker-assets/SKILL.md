---
name: taptap-maker-assets
description: TapTap Maker 资源落盘规范：assets/ 自动补 .meta 的陷阱、中间产物隔离、命名/图集/尺寸预算，以及不花内置额度的补素材顺序。
whenToUse: 要往工程里加/改图片、音频、模型等资源，或规划资源目录与命名时。
---

# TapTap Maker 资源规范

## 核心陷阱：assets/ 会自动纳入构建

Maker 运行时的资源监听器会给 `assets/` 下**任何新出现的文件**自动补 `.meta` 并纳入资源表与构建。后果：

- 一张没人引用的原图/中间产物会变成资源表里的脏条目，删文件也未必清得掉索引。
- 明文密钥等敏感文件一旦落进工作区就可能被运行时自动提交并推送。

**规则**：所有生成/处理的中间产物放在 `assets/` 之外（如 `<project>/.tmp/`）；只有裁好、确认要用的成品才搬进 `assets/`。

## 落盘

- 成品分类放：`assets/image/`、`assets/audio/`、`assets/video/`、`assets/model/`。
- 成品补同名 `.meta`：`{ "uuid": "<27位随机串>" }`（Maker 工具生成的素材会自带 `.meta` 与远程映射）。
- 命名用小写短横或下划线、语义化：`icon_coin.png`、`sprite_player_idle.png`。

## 补素材的优先顺序（不花内置额度）

1. 复用项目内已有素材 / `engine-docs/recipes/built-in-models.md` 的内置模型。
2. 走自定义生图通道（`taptap-maker-custom-image-gen` skill）。
3. 仅当用户明确要求用内置额度时，才用 Maker `generate_image` 等。

## 预算与性能

- 图标/UI 元素尽量进图集（atlas），减少 draw call。
- 控制纹理尺寸：图标 256 级别，大图按需；移动端注意显存与包体。
- 2D 精灵用 `SpriteSheet2D` / `AnimationSet2D`；避免每帧一张独立大图。
