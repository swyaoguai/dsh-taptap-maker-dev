# 第三方开源致谢与许可

本插件整合了部分第三方开源项目的**方法论、判据与规范**，以及两个**作为服务脚本
原样分发**的第三方 skill（见下文 zaiduyu-imagegen 与 Stable Audio Open）。
感谢这些项目的作者公开他们的工作，让本地游戏开发工具链能少走弯路。

整合原则（重要）：

- **只整合与引擎无关的部分**：方法论、视觉判据、QA 清单、流程规范。
- **不搬运引擎专属代码**：本插件面向 TapTap Maker（UrhoX + Lua），
  与 UE5 / Unity / Godot / Blender / three.js 的 API 完全不通用。
  硬搬过来会误导 agent 调用不存在的接口，那比没有更糟。
- 重写为中文并适配本项目语境，而非逐字复制；因此本仓库对这些内容自负文责。

---

## zaiduyu-imagegen（章鱼多模型生图 skill）

- 来源：他人编写的 Codex Skill（`pai.zaiduyu.top` 积分制多模型生图站的服务脚本），
  由用户本人提供并要求整合进本插件。
- 许可证：**上游包内未附带许可证声明**（其 README/SKILL 均未写明）。
  本插件按用户提供材料的原样分发处理，不对其做再授权；如原作者对分发方式
  有异议，请提出，我们会调整或移除。
- 落地：`skills/zaiduyu-imagegen/`（`generate.py` 原样保留，未改动逻辑；
  仅 `SKILL.md` 的本机安装一节改写为通用集成说明）+ `src/taptap-zaiduyu.mjs`
  （Node 包装层：Python 探测、凭据检查、输出解析，为本插件自写）。
- 凭据模型：设置页验证后保存在本机 `$DSH_HOME/taptap-maker-dev/zaiduyu.json`，
  环境变量 `ZAIDUYU_USER` / `ZAIDUYU_PASS` 只作兼容兜底；运行上游脚本时只注入
  子进程环境，不进命令行参数、不回显密码、不放入 Maker 工作区。

## Stable Audio Open 1.0（本地音效模型）

- 模型：`stabilityai/stable-audio-open-1.0`（Stability AI）。
- 许可证：**Stability AI Community License** —— 个人与年营收 < 100 万美元的
  团队可免费商用；完整条款以用户下载包内的 `LICENSE.md` 为准。
- **本插件不分发模型权重**：约 5.3GB 权重由用户依 `taptap-sfx guide` 的指引
  **自行手动下载**（ModelScope / HuggingFace 官方渠道），并且先做硬件体检。
- 落地：`skills/taptap-maker-local-sfx/scripts/`（sfx_env.py 环境管理 +
  generate.py 推理脚本，为整合编写）+ `src/taptap-sfx.mjs`（编排与落盘，本插件自写）。

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
- 原样附带上游 `LICENSE` 全文：`third_party/GameFactory-3A/LICENSE`，并纳入 npm 包；
- 两个改写技能在 frontmatter 明确标注 `thirdPartyLicense: Apache-2.0` 和
  `thirdPartyModified: true`，同时注明来源；
- 明确说明是**改写而非原样复制**（已重写为中文并适配 UrhoX+Lua 语境）；
- 本插件整体仍以其自身 `LICENSE`（MIT）发布；上游许可证文件单独保留，
  不改变其他原有文件的许可证。实际分发时请一并保留本文件和上游 LICENSE。

如原作者认为某处整合方式不妥，请提 issue，我们会调整或移除。
