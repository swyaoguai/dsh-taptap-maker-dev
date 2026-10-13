---
name: game-assets
description: 游戏美术资源通用规范：图集与 draw call、纹理尺寸/压缩、命名与目录、2D 精灵表与 9-slice、风格统一与参考表。配合 taptap-maker-assets 落盘。
whenToUse: 规划/生成美术资源、定命名与目录、优化包体与显存，或要统一视觉风格时。
---

# Game Assets

## 组织与命名

- 语义化小写命名：`icon_coin`、`spr_player_idle`、`bg_forest_01`。
- 分类目录：image / audio / video / model；同系列同前缀便于检索与打包。

## 2D 精灵

- 同角色/同动画进**精灵表（SpriteSheet / AnimationSet）**，减少 draw call 与碎文件。
- 可拉伸 UI 用 **9-slice**（StretchableSprite），避免拉糊。
- 预留 padding 防图集采样溢出。

## 尺寸 / 压缩 / 包体

- 纹理尺寸按用途取够用即可（图标 256 级别），避免整屏贴 4K。
- 控制总包体与运行时显存；大图按需加载/预热（联机见 `taptap-maker-networking`）。

## 风格统一

- 先定**风格基调**（配色板、线条、光影、比例），所有资源对齐同一套。
- 用**参考表 / turnaround**锁定角色设计再出多视图/多动作（见 `character-design-sheet`）。
- AI 生图保持风格一致：固定 seed、固定风格描述词、必要时给参考图（见 `ai-pixel-art-image-generation`、`taptap-maker-custom-image-gen`）。

## 落盘（TapTap Maker）

中间产物隔离在 `assets/` 之外，成品才进 `assets/` 并补 `.meta`——细节见 `taptap-maker-assets`。
