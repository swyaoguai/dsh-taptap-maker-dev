---
name: shader-dev
description: 游戏着色器通用思路（表面着色模型、常见效果配方、性能注意），并指明在 TapTap Maker 里要走 SurfaceShader 而非手写底层 glsl。
whenToUse: 要做自定义视觉效果（溶解、描边、水、能量护盾、顶点动画等），或内置材质满足不了时。
---

# Shader Dev

## 在 TapTap Maker 里的硬约束

- 内置 Technique/材质能做的就用材质（见 `taptap-maker-rendering-materials`）。
- 做不到的效果 → **写 SurfaceShader**（`engine-docs/recipes/surface-shader.md`），**不要**手写底层 `.glsl` / Technique XML。

## 常见效果配方（思路）

- **描边**：法线外扩背面 / 后处理边缘检测。
- **溶解**：噪声图 + 阈值 clip，边缘发光。
- **护盾 / 能量**：菲涅尔（边缘亮）+ 流动 UV + 叠加。
- **水**：法线扰动 + 反射/折射 + 深度淡化。
- **顶点动画**：风吹草木、旗帜用顶点偏移（时间 + 噪声）。
- **卡通**：光照分档（ramp）+ 描边。

## 性能

- 片元里避免分支与高次运算；能预计算就挪到顶点或贴图。
- 采样次数、overdraw、透明排序是移动端大头；半透明特效克制使用。
- 实机目标机型测帧率，别只看编辑器。

具体 SurfaceShader 的写法、可用输入/输出以 recipe 为准，不要臆造语法。
