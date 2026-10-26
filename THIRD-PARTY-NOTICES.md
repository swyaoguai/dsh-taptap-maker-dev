# 第三方开源致谢与许可

本插件整合了部分第三方开源项目的**方法论、判据与规范**。感谢这些项目的作者
公开他们的工作，让本地游戏开发工具链能少走弯路。

整合原则（重要）：

- **只整合与引擎无关的部分**：方法论、视觉判据、QA 清单、流程规范。
- **不搬运引擎专属代码**：本插件面向 TapTap Maker（UrhoX + Lua），
  与 UE5 / Unity / Godot / Blender / three.js 的 API 完全不通用。
  硬搬过来会误导 agent 调用不存在的接口，那比没有更糟。
- 重写为中文并适配本项目语境，而非逐字复制；因此本仓库对这些内容自负文责。

---

## 3AGameFactory（OpenDCAI）

- 仓库：https://github.com/OpenDCAI/GameFactory-3A
- 许可证：**Apache License 2.0**
- 版权：Copyright OpenDCAI
- 引用：
  ```
  @misc{gamefactory3a,
    title        = {3AGameFactory: Open-Source 3A Game Generation Skills and Asset Framework},
    author       = {OpenDCAI},
    year         = {2026},
    howpublished = {\url{https://github.com/OpenDCAI/GameFactory-3A}},
    note         = {Open-source software repository}
  }
  ```

### 本插件用到它的哪些部分

| 来源（GameFactory-3A） | 在本插件的落地 | 整合方式 |
|---|---|---|
| `agent_skills/asset_qa/3d_object/orientation_review.md`（朝向审查） | `skills/asset-orientation-qa/` | 取其**核心洞见**：朝向无法由几何计算得出，边界框相同的 +Z/−Z 两个模型字节级一致，只能靠"看"；以及各题材的朝向判据表、"不要用 gameplay 代码补偿旋转"的硬规则。改写为 TapTap Maker 的 Node 旋转与 `assets/` 流程 |
| `agent_skills/asset_qa/README.md`（资产视觉 QA 总纲） | `skills/asset-visual-qa/` | 取"结构检查 ≠ 视觉可用"的分工，与它列出的游戏内复核维度（朝向/附着/穿模/尺度/风格） |
| `agent_skills/setting_overview.md`（端到端流程与验收） | `skills/asset-visual-qa/references/acceptance-gate.md` | 取"编译通过 / 能启动 / 日志无错 ≠ 验证完成"这一条，以及 build→launch→play→record→review 的迭代闭环 |
| 付费云端后端须先征求同意 | 本插件既有的额度红线（更强，已是硬拦截） | 仅作印证，未改动 |

### 未采用的部分及原因

- `engine_adapters/`（UE5/Unity/Godot/Blender/three.js 参考实现）：引擎不兼容。
- `models/`、`operators/`、`pipeline/`：绑定其自有模型栈与 `paths.py` 输出约定，
  与本插件的生成通道（ChatGPT 网页 / OpenAI 兼容中转站 / MiniMax）是两套体系。
- 其 `agent_skills/engine_context/*`：同上，且本插件已有 `taptap-maker-core` 等
  经过实测的 UrhoX API 文档。

### Apache-2.0 合规说明

Apache-2.0 要求保留版权声明、许可证文本与修改说明。本仓库：

- 在上表逐项写明来源文件路径与仓库地址；
- 明确说明是**改写而非原样复制**（已重写为中文并适配 UrhoX+Lua 语境）；
- 本插件整体仍以其自身 `LICENSE`（MIT）发布；上述被整合的**方法论内容**
  按 Apache-2.0 的条款使用。

如原作者认为某处整合方式不妥，请提 issue，我们会调整或移除。
