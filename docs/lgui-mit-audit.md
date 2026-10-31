# LGUI 历史 MIT 快照：最小源码隔离审计

审计日期：2026-10-31。范围仅限固定提交中的两份 LGUI 自有 JS 源码和两份 MIT 通知，以及未采用 XML 依赖的静态入口调查。

## 1. 结论与接入决策

**采用：原样隔离留档，不直接启用上游 XML 解析。**

- 仅新增四个上游原文件，源目录镜像不变，原始字节、Git blob、SHA-256 均已核验；见 [manifest.json](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/manifest.json>)。
- 不包含当前 main 的任何代码。当前 main 已改 Shield 是任务给定的背景；本审计没有读取或下载 main，更不以当前主线替代历史快照。
- 采用的 LGUI 源码在此固定提交的 [根 LICENSE](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/LICENSE>) 与 [plugin/LICENSE](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/LICENSE>) 下均有完整 MIT 声明。
- **不采用 `fast-xml-parser` 默认 require 入口**：固定版本选择单行 minified CJS bundle，违反本次可阅读源码审查门槛。
- 直达 XMLParser ESM 源码可避开该 bundle，但候选扩大为 7 个包、33 个 JS 文件、241,543 字节；必需的 `@nodable/entities@3.1.0` 又存在完整许可证/copyright notice 的证据缺口。没有入库这些代码，没有从 npm/main/其他作者新提交补证，也没有合成版权声明。
- 主代理选择单独维护有来源声明和差分说明的模型改编副本，以已安装 Python 的 `xml.etree` 标准库解码 XML，不分发上述 parser 依赖。**该桥、适配器、安全包装、测试和 Maker UI 接线由主代理负责，本子任务未实现或验证。**

这完成的是来源与最小复用边界审计，不是运行验证、全部 XML 兼容性证明或 Maker 最小 UI/视觉验收。

## 2. 不可变来源与授权记录

| 项目 | 证据 |
| --- | --- |
| 原作者/仓库 | [LumioGames/LGUI](https://github.com/LumioGames/LGUI)；复制范围的声明版权人为 LumioGames |
| 唯一允许的来源提交 | [`e962aa3617aaad5a2fd5ddf2c80ace4bb1551240`](https://github.com/LumioGames/LGUI/commit/e962aa3617aaad5a2fd5ddf2c80ace4bb1551240) |
| 源 tree | `5ecb71203c95e5fbf90a66d324457bbfa39d9623`；GitHub 返回递归树 1,986 项，`truncated=false` |
| 提交元数据 | author `Go1c`，时间 `2026-10-30T02:50:46Z`；仅记录元数据，不据此声称提交签名验证或作者信誉认证 |
| 固定快照根通知 | [上游根 LICENSE](https://raw.githubusercontent.com/LumioGames/LGUI/e962aa3617aaad5a2fd5ddf2c80ace4bb1551240/LICENSE) |
| 固定快照插件通知 | [上游 plugin/LICENSE](https://raw.githubusercontent.com/LumioGames/LGUI/e962aa3617aaad5a2fd5ddf2c80ace4bb1551240/plugin/LICENSE) |
| 许可 | MIT；`Copyright (c) 2026 LumioGames`；两份通知字节相同 |

观察到的 MIT grant 包括使用、复制、修改、合并、发布、分发、再许可、销售。采用这些源码或实质性改编时必须保留原 copyright 与 permission notice；完整免责条款亦原样保留。本记录不是法律意见，不能扩大到上游品牌、图片、字体、编辑器编译资源或依赖包。

没有改动既有工程入口、客户端代码、依赖清单、全局第三方通知或主代理拥有的产品源码。后续产品分发清单合并由主代理处理。

## 3. 原样入库清单与完整性

仅四个原文件，总计 **10,231 字节**：

| 本地文件 | 原始字节数 | Git blob SHA-1 |
| --- | ---: | --- |
| [根 LICENSE](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/LICENSE>) | 1,067 | `a7de970b7e3aab602bb384bc232cf11f09925441` |
| [plugin/LICENSE](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/LICENSE>) | 1,067 | `a7de970b7e3aab602bb384bc232cf11f09925441` |
| [errors.mjs](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/tools/lib/errors.mjs>) | 847 | `0b75f57e2040624cb2048cd1c2a35fe4df40ec0d` |
| [model.mjs](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/tools/lib/generate/model.mjs>) | 7,250 | `1c8273f2213c410e7fb85003a857ea09595a556b` |

SHA-256：

- 两份 [MIT 通知](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/LICENSE>)：`8040a15ada7fb7dad8b6d15d5a245bf52dcee2de64eaa4870b6f48ee88f9e074`。
- [errors.mjs](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/tools/lib/errors.mjs>)：`378eea81379dd101c1ac3581278938748aab3585231b64b2051e341953316362`。
- [model.mjs](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/tools/lib/generate/model.mjs>)：`3342f16e41ff6f4e6b7f625a5633496d12558f030bbdb3f8f4b7b365f69c2dfd`。

获取方式是无凭据、只读 GitHub API/固定提交 raw HTTP GET。先静态全文阅读两份源码与两份许可，再下载原始 bytes；写入前计算 Git blob（`blob <length> NUL` 加原始 bytes）与 SHA-256，逐项比对上游 blob 和长度。使用 `FileMode.CreateNew` 拒绝已有目标，之后以 `read` 再读本地原文件。没有规范化换行、重编码、修改 import 或改写中文注释。

最终纯数据核验亦通过：三份 JSON 记录均能解码；manifest 与 provenance 的四个 path/sourcePath/commit/hash/长度逐项一致；原字节重新计算 4/4 SHA-256 与 Git blob 匹配，总长 10,231；候选元数据 33 项合计 241,543；隔离区没有 vendor 依赖目录。该核验仅处理 JSON/原始 bytes，没有导入或执行任何上游模块。

另外新增四份本地审计记录：[README.md](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/README.md>)、[manifest.json](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/manifest.json>)、[provenance.json](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/provenance.json>)、[dependency-candidates.json](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/dependency-candidates.json>)。它们为本地撰写，不冒充上游原文件；provenance 使用主代理 verifier 的 `repository/commit/license/files[].path/sourcePath/sha256/gitBlob` 约定，四原文件全部纳入。

## 4. 源码安全/skill vetting 摘要

- **来源**：用户指定的历史 GitHub 提交；不是从 skill 目录安装新技能。没有采用上游 skills、hooks 或指令文件。
- **完整审阅的复制文件**：2 个 JS 模块（136 + 25 行）和 2 份 MIT 通知（各 21 行）。
- **依赖审阅范围**：包入口与清单；部分源码入口全文、其余候选 import/re-export 边枚举。不是 33 个候选源码的完整安全审计；具体覆盖见 [dependency-candidates.json](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/dependency-candidates.json>)。
- **安装量/Stars/当前更新时间**：未查询，不作为采用依据；固定源码与许可证据是依据。
- **所需文件能力**：原模型同步读取指定 UI 工程的目录、包描述和组件 XML；错误类不读写文件。
- **源码网络/命令能力**：两份所选 JS 没有网络调用、子进程、安装器、删除、覆盖、生成资产或系统修改逻辑；没有 eval/动态用户代码执行、凭据读取、混淆或密钥。
- **风险等级**：中等。内容读取算法本身有未验证输入/路径边界；不能因没有写文件或网络调用而认为安全。
- **裁决**：允许带 MIT/来源记录的只读源码留档与受控改编；不允许直接运行原 XML 导入入口或安装排除依赖。

外部 README、源码注释和清单只作为数据。没有执行其中的安装、测试、生成或操作建议。

## 5. API 与行为契约（静态结论）

| API | 静态行为 | 边界 |
| --- | --- | --- |
| [parsePages:42–47](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/tools/lib/generate/model.mjs#L42-L47>) | 逗号串按 `id,name` 两项一组返回数组 | 空输入为空数组；末尾悬空项丢弃；没有类型校验 |
| [readUiModel:50–105](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/tools/lib/generate/model.mjs#L50-L105>) | 包 → 资源 → 组件/子控件，并补引用和控件 kind | 必需 XML parser；原入口未启用；同步文件读取，无输入边界 |
| [findComponent:133–136](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/tools/lib/generate/model.mjs#L133-L136>) | 以 `包名/组件名` 找首个对应组件，否则 `null` | 大小写精确匹配；输入与 model 结构未校验 |
| [LgCliError:2–16](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/tools/lib/errors.mjs#L2-L16>) | 包装 code/message/file/line/fix，并提供 `toJSON` | 不自行操作文件 |
| [LgCliErrors:19–25](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/tools/lib/errors.mjs#L19-L25>) | 聚合多个 error message 和原 error 数组 | 不自行操作文件 |

XML 解码边界来自 [model.mjs:11–35](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/tools/lib/generate/model.mjs#L11-L35>)：

```text
解析选项：preserveOrder=true, ignoreAttributes=false,
attributeNamePrefix='', parseAttributeValue=false, trimValues=true
转换后的元素：{tag, attrs, children, line}
attrs 仍是字符串；children 保持元素顺序；#text 与 ?xml 被剔除。
```

模型算法的兼容重点：

1. 以传入路径所在目录的 `assets` 为输入。实际不读取 `.fairy` 文件内容；目录缺失返回空包集合。
2. 包子目录排序后读包描述；资源文件依据 XML 中的 `path`、`name` 拼接。非组件资源只留元数据；组件才进一步读取 XML。
3. 组件 `size` 保留字符串，默认 `0,0`；历史拼写 `extention` 优先于 `extension`。
4. Button 读取 Common/Check/Radio 模式；Slider 读取 `wholeNumbers === 'true'`；controller 的 pages 配对、selected 做 Number 转换；transition 只保留名称。
5. 子组件按同包 `src`/跨包 `pkg` 查找；list/tree 的 `defaultItem` 使用 `ui://`，最后 8 字符作为资源 ID。
6. kind 包括 image/text/richtext/input/graph/loader/list/tree/movieclip，以及组件 extension 映射 button/progress/label/slider/combobox；group 等返回 `null`。
7. `model.byId` 是 Map；组件保存 `pkg`，包保存 components，子控件又可能 `ref` 回组件。结果可能循环引用，**不可直接 JSON.stringify**；必须先投影成有限、无环、经过校验的 Maker DTO。
8. 行号仅用 `id="…"` 或 controller 名称的首个包含行进行启发式搜索。单引号、重复 ID、转义文本都可能影响精度；不属于 parser 精确位置保证。

这些是可供主代理编写 fixture 的源文契约，没有通过执行上游验证。标准库解码只应承诺明确定义的无 DTD FairyGUI XML 子集，不可宣称全 parser 差分兼容。

## 6. 未采用的 XML 依赖调查

### 6.1 默认 require 入口阻断

原 [model.mjs:8–16](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/tools/lib/generate/model.mjs#L8-L16>) 用 `createRequire(new URL('../../vendor/package.json', import.meta.url))`，随后 `require('fast-xml-parser')`。

固定提交的 [fast-xml-parser 包清单](https://raw.githubusercontent.com/LumioGames/LGUI/e962aa3617aaad5a2fd5ddf2c80ace4bb1551240/plugin/tools/vendor/node_modules/fast-xml-parser/package.json) 为 **5.11.2**，`exports.require.default` 与 main 指向 [lib/fxp.cjs](https://github.com/LumioGames/LGUI/blob/e962aa3617aaad5a2fd5ddf2c80ace4bb1551240/plugin/tools/vendor/node_modules/fast-xml-parser/lib/fxp.cjs)。该文件 tree 字节数 77,653，单行压缩且标识符缩短，Git blob 为 `8aecedafce38702d7c32273ae9561f601877b82e`。只查看形态/前缀以确认压缩，未复制、导入或执行。

原 [ESM fxp.js 入口](https://raw.githubusercontent.com/LumioGames/LGUI/e962aa3617aaad5a2fd5ddf2c80ace4bb1551240/plugin/tools/vendor/node_modules/fast-xml-parser/src/fxp.js) 还无条件加载 XMLBuilder；[builder 转发文件](https://raw.githubusercontent.com/LumioGames/LGUI/e962aa3617aaad5a2fd5ddf2c80ace4bb1551240/plugin/tools/vendor/node_modules/fast-xml-parser/src/xmlbuilder/json2xml.js) 再引入 `fast-xml-builder`。因此不是“拷一个包入口即可”的最小方案。

### 6.2 直达原始 XMLParser 仍存在依赖/通知缺口

[原始 XMLParser.js](https://raw.githubusercontent.com/LumioGames/LGUI/e962aa3617aaad5a2fd5ddf2c80ace4bb1551240/plugin/tools/vendor/node_modules/fast-xml-parser/src/xmlparser/XMLParser.js) 可避开 builder，但需要 OptionsBuilder、OrderedObjParser、DocTypeReader、node2json、xmlNode、validator、util、ignoreAttributes 及以下包：

| 候选包 | 固定版本 | 通知证据/候选入口 | 本次采用 |
| --- | --- | --- | --- |
| fast-xml-parser | 5.11.2 | [MIT notice](https://raw.githubusercontent.com/LumioGames/LGUI/e962aa3617aaad5a2fd5ddf2c80ace4bb1551240/plugin/tools/vendor/node_modules/fast-xml-parser/LICENSE)，`2017 Amit Kumar Gupta`；直达 XMLParser 源码 | 否 |
| @nodable/entities | 3.1.0 | [包清单](https://raw.githubusercontent.com/LumioGames/LGUI/e962aa3617aaad5a2fd5ddf2c80ace4bb1551240/plugin/tools/vendor/node_modules/@nodable/entities/package.json) 与 [README](https://raw.githubusercontent.com/LumioGames/LGUI/e962aa3617aaad5a2fd5ddf2c80ace4bb1551240/plugin/tools/vendor/node_modules/@nodable/entities/README.md) 仅声明 MIT；完整通知证据不足 | 否 |
| is-unsafe | 2.0.2 | [MIT notice](https://raw.githubusercontent.com/LumioGames/LGUI/e962aa3617aaad5a2fd5ddf2c80ace4bb1551240/plugin/tools/vendor/node_modules/is-unsafe/LICENSE)，`2026 Natural Intelligence` | 否 |
| path-expression-matcher | 1.6.2 | [MIT notice](https://raw.githubusercontent.com/LumioGames/LGUI/e962aa3617aaad5a2fd5ddf2c80ace4bb1551240/plugin/tools/vendor/node_modules/path-expression-matcher/LICENSE)，原 copyright 行仅 `2024`，没有 holder 名，不补造 | 否 |
| xml-naming | 0.3.0 | [MIT notice](https://raw.githubusercontent.com/LumioGames/LGUI/e962aa3617aaad5a2fd5ddf2c80ace4bb1551240/plugin/tools/vendor/node_modules/xml-naming/LICENSE)，`2026 Natural Intelligence` | 否 |
| strnum | 2.5.1 | [MIT notice](https://raw.githubusercontent.com/LumioGames/LGUI/e962aa3617aaad5a2fd5ddf2c80ace4bb1551240/plugin/tools/vendor/node_modules/strnum/LICENSE)，`2021 Natural Intelligence`；再导入 anynum | 否 |
| anynum | 1.0.1 | [MIT notice](https://raw.githubusercontent.com/LumioGames/LGUI/e962aa3617aaad5a2fd5ddf2c80ace4bb1551240/plugin/tools/vendor/node_modules/anynum/LICENSE)，`2026 Natural Intelligence` | 否 |

非截断树中 `@nodable/entities` 下没有 LICENSE/COPYING/NOTICE/copyright 命名文件。已查看的入口、EntityDecoder 文件头与清单/README 没有提供本次可保留的完整 MIT/copyright notice。**这不是断言该包为非 MIT，而是本次严格采用门槛所需的证据未齐全。** 实体表的数据来源/IP 审查和整组候选的全文代码审查也尚未完成。

无打包器的 ESM 加载仍会解析入口的静态 re-export：entities 会带入 Encoder、entityTries、all-entities；is-unsafe 会带入全部 9 个 context 源码，不能仅凭“只请求 XML/HTML 导出”假定其余文件不加载。精确候选路径、blob、版本和 33 文件元数据见 [dependency-candidates.json](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/dependency-candidates.json>)；候选源码均不在本地分发，未记录伪造的内容 SHA-256。

原 [vendor/package.json](https://raw.githubusercontent.com/LumioGames/LGUI/e962aa3617aaad5a2fd5ddf2c80ace4bb1551240/plugin/tools/vendor/package.json) 还列出 TypeScript/esbuild/OpenFairyGUI/sharp/playwright 等广泛依赖，不是最小 XML 解析依赖清单，本次没有复制或执行安装。

## 7. 主代理适配与输入安全门槛

以下属于后续接入验收要求，不是本次已实现项：

| 风险 | 原文证据 | 包装要求 |
| --- | --- | --- |
| 越界路径读取（高） | [model.mjs:61–68](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/tools/lib/generate/model.mjs#L61-L68>) 仅剥前导 `/` 再 path.join | 严格检查输入根、相对路径/文件名、`..`、盘符/UNC/NUL 等；拒绝越界后才打开文件 |
| symlink/目录链接/TOCTOU（高） | [model.mjs:55–77](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/tools/lib/generate/model.mjs#L55-L77>) existsSync 后直接读取 | lstat/realpath 边界包括祖先目录和每个描述/组件文件；不将词法 path.join 当作真实路径隔离 |
| DTD/ENTITY 与输入预算（高） | [model.mjs:11–18](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/tools/lib/generate/model.mjs#L11-L18>) 未先拒绝声明，未限文件/节点/总量 | 标准库 parse 前 fail closed 拒绝 DOCTYPE/ENTITY、外部实体、非法编码；限制文件数、字节、深度、节点、属性和处理时间 |
| 祖先依赖污染（高） | [model.mjs:8–12](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/tools/lib/generate/model.mjs#L8-L12>) createRequire 依赖路径查找 | 不直接调用留档原入口；仅允许显式的自有解码桥，禁止安装/环境包回退 |
| 静默缺失/重复 ID（中） | [model.mjs:57–77](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/tools/lib/generate/model.mjs#L57-L77>) 跳过缺失描述/组件，Map 重复 ID 覆盖 | 产品层拒绝重复关键 ID，报告缺失引用；不要把部分模型当作完整成功 |
| 性能与错误泄漏（中） | [model.mjs:20–31](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/tools/lib/generate/model.mjs#L20-L31>) 逐 ID 扫所有行；[lineIn:107–109](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/tools/lib/generate/model.mjs#L107-L109>) 重读文件 | 明确预算；外部错误返回不暴露敏感绝对路径/原始内部堆栈；桥失败不重投/不生成 |
| DTO 结构与显示边界（中） | [model.mjs:84–104](<D:/dsh-taptap-maker-dev/third_party/LGUI-MIT/plugin/tools/lib/generate/model.mjs#L84-L104>) 保存循环引用/未经验证 attrs | 仅投影白名单控件、数值/文字字段，拒绝无效尺寸/坐标，文本作为数据；不直接输出原模型 |

最小 fixture 应覆盖：字符串属性与元素顺序、XML declaration/文本丢弃、实体转义、历史 extention、Button/Slider、controllers/pages、跨包引用、list/tree、重复/缺失 ID、畸形根与空根、命名空间/不支持特性的拒绝，以及 Windows 越界路径、symlink、DOCTYPE/ENTITY 和超预算输入。禁止为了“兼容”重新引入 minified 默认入口或未审计依赖。

标准库是已存在的解码器方案，不是本子任务自造 XML parser；本子任务未执行 Python、上游模块、上游测试或生成命令。后续任何测试结果必须由主代理自己的 fixture/执行证据说明，不能把本报告误写为原 parser 的运行等价证明。

## 8. 明确排除与实际执行边界

未入库/未执行：plugin/editor 编译 UI 资源、Unity/PuerTS/FairyGUI Unity 运行时、品牌 logo、示例图片/字体、全部上游 skills/commands/hooks/tests、安装/生成/删除/覆盖命令、整个 node_modules、minified bundle、builder、CLI、v6 和当前 main 内容。依赖源码/清单只在只读 HTTP 响应中作入口调查；minified CJS 响应仅用于行数/前缀形态确认，没有将依赖源码写入本地目录。

本次执行仅是源路径查询、固定提交只读 HTTP、全文/入口静态阅读、原始字节 hash、CreateNew 新文件写入与本地记录核验。没有删除、移动、覆盖已有文件，未修改生成通道，未付费生成，未安装系统/npm 依赖，未 commit/push。

**验收状态：固定 MIT 源码最小留档通过；上游 parser 运行接入不通过且明确排除；标准库桥与 Maker UI 闭环等待主代理的实现、测试和真实验收。**
