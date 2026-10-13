---
name: taptap-maker-camera
description: TapTap Maker 相机：正交 orthoSize 的 0.5 因子、GetScreenRay 无缓存、正交投影公式等已验证坑；配相机、拾取、2D 可视范围时必看。
whenToUse: 配置/调试相机，做屏幕坐标↔世界坐标、点选拾取，或 2D 正交可视范围算不对时。
---

# TapTap Maker 相机

详见 `engine-docs/gotchas/camera.md` 与 `engine-docs/recipes/camera.md`。已验证的坑：

1. **orthoSize 的 0.5 因子** —— 正交相机的可视高度与 `orthoSize` 之间有 0.5 关系，算 2D 可视范围/适配屏幕时要带上，否则范围差一倍。
2. **`GetScreenRay` 无缓存** —— 每次调用都重算，做拾取/拖拽时自己缓存结果，别在热路径里反复调。
3. **正交投影公式** —— 按 gotchas 里给的公式做屏幕↔世界换算，别套透视的直觉。

## 常用

- 类：`Camera`、`Viewport`、`Node`（相机挂在 Node 上，位移/朝向改 Node）。
- 跟随/平滑：在 `Update`（渲染帧）里插值相机 Node，物理对象的跟随目标取其渲染位置。
- 2D：正交相机 + 合适 orthoSize；注意上面的 0.5 因子。

API 签名走 LSP / `.emmylua/`。
