# LGUI 历史 MIT 源码隔离区

此目录不是完整 LGUI 插件、安装包或可直接运行的 XML 导入器。

## 固定来源

- 仓库：[LumioGames/LGUI](https://github.com/LumioGames/LGUI)。
- 仅采用提交 [`e962aa3617aaad5a2fd5ddf2c80ace4bb1551240`](https://github.com/LumioGames/LGUI/commit/e962aa3617aaad5a2fd5ddf2c80ace4bb1551240)。
- 仅四个上游原文件，目录镜像不变、原始字节不变，总计 10,231 字节。
- [根 LICENSE](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/LICENSE>) 与 [plugin/LICENSE](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/LICENSE>) 均为此历史提交的 MIT 许可，版权声明为 `Copyright (c) 2026 LumioGames`。
- 不取当前 main，不把历史 MIT 许可扩大到上游编辑器资源、商标、美术或第三方依赖。

## 原文件与记录

| 文件 | 用途 |
| --- | --- |
| [model.mjs](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/tools/lib/generate/model.mjs>) | FairyGUI XML 到包、资源、组件控件树的原始算法；仅留档 |
| [errors.mjs](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/tools/lib/errors.mjs>) | 原模型唯一相对 JS 依赖，错误类 |
| [manifest.json](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/manifest.json>) | 来源提交、源路径、Git blob SHA-1、原始字节 SHA-256、许可证与排除记录 |
| [provenance.json](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/provenance.json>) | 主代理 verifier 约定的 repository/commit/license/files 元数据索引，与原文件 manifest 一致 |
| [dependency-candidates.json](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/dependency-candidates.json>) | 未安装、未分发的 XML 源码依赖候选与阻断证据 |
| [完整审计报告](<D:/dsh-taptap-maker-dev/docs/lgui-mit-audit.md>) | API、行为契约、风险与主代理接入边界 |

## 静态可复用 API

```text
parsePages(pages = '') -> [{id, name}, ...]
findComponent(model, '包名/组件名') -> component | null
readUiModel(fairyPath) -> {fairyPath, packages, byId: Map}
LgCliError / LgCliErrors
```

这些签名来自全文静态阅读；本次没有导入、调用或测试上游代码。`readUiModel` 返回对象含循环引用，不能直接作为 JSON 输出。

## 为什么不直接运行原模型

原 [model.mjs:8–18](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/tools/lib/generate/model.mjs#L8-L18>) 保留 `createRequire` 与 `require('fast-xml-parser')`。固定提交的默认 require 入口是单行 minified CJS bundle；改走纯 ESM 源码又会引入 7 个包、33 个候选 JS 文件，且必需的 `@nodable/entities@3.1.0` 缺少本次可核验的完整 MIT/copyright notice。此处不复制这些依赖，不合成版权声明，不安装 npm 包，不提供上游 vendor 依赖清单。

**目录隔离不等于运行沙箱。** Node 仍可能向祖先目录解析已有的同名依赖。因此不得因机器恰有 `fast-xml-parser` 就直接调用原 `readUiModel`，也不得自动补依赖或自动回退到其他版本。

主代理选择另写有来源声明与明确差分的改编副本，使用已安装 Python 的 `xml.etree` 标准库解码 XML，不分发上述依赖。路径边界、symlink、DOCTYPE/ENTITY、输入预算、兼容测试和 Maker DTO 投影由主代理实现；本隔离审计没有实现或验证该桥。

## 使用边界

- 对原模型的任何改编放在产品代码的单独副本；不要原地修改这四个原文件。
- 分发源码或实质性改编时保留两份原 MIT/copyright/免责通知及来源记录。
- 不包含 Unity/PuerTS/FairyGUI Unity 运行时、编辑器编译资源、品牌 logo、示例图片/字体、上游 skills、命令、测试、安装器或生成器。
- 本目录没有自动安装、生成、删除、覆盖或联网执行入口。
- 结构和哈希核验完成不表示最小 UI 闭环或视觉验收完成。
