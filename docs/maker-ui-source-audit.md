# Maker 静态 UI 发射契约：本机源码审计

审计日期：2026-10-31。范围为插件侧静态适配与独立 Lua 绑定，**不是选定游戏的安装、构建或原生验收**。实现见 [契约与只读预检](<D:/dsh-taptap-maker-dev/src/ui-maker-contract.mjs>)、[发射器与审阅包](<D:/dsh-taptap-maker-dev/src/ui-maker-export.mjs>)、[回归测试](<D:/dsh-taptap-maker-dev/tests/ui-maker-export.test.mjs>)。

## 1. 证据范围与版本门禁

只读检查了三个本机 SDK 树：`D:\ftjx`、`D:\tapyx`、`D:\taplryx`。下列十一文件在三处分别计算 SHA256，结果全部一致。门禁标签为 `dev-kit20260922-133551`、MCP 文档 `0.0.39`；UI 自报版本为 `1.1.0`（[入口版本定义](<D:/ftjx/urhox-libs/UI/init.lua#L281>)）。

这证明的是**指定本机文件字节一致**，不是原始 dev-kit ZIP 认证，也不覆盖整个 SDK、所有传递依赖、现有进程中被修改的 Theme、字体与资源索引。目标文件缺失或哈希不同均阻断，不自动更新 SDK、改游戏文件或继续猜兼容性。

| 相对 `urhox-libs/UI/` 的源文件 | SHA256 |
| --- | --- |
| [init.lua](<D:/ftjx/urhox-libs/UI/init.lua>) | `41a44475e29a1172bca0f415f1608ae5e8260e4d7337fa72ea6bdc5caa13c58c` |
| [Core/UI.lua](<D:/ftjx/urhox-libs/UI/Core/UI.lua>) | `71f48aaa663adbce0b3b12c7d0753da4c7642383dcb03ec965bc9c3c829865e5` |
| [Core/UILoader.lua](<D:/ftjx/urhox-libs/UI/Core/UILoader.lua>) | `9bb93883e134058220702d490c7b07375d5d4f471e58b6dd4a135ad522e11447` |
| [Core/UISerializer.lua](<D:/ftjx/urhox-libs/UI/Core/UISerializer.lua>) | `3f71dc2d3135f38a2e1ad115af01220ca9e9d87b1e14dcef861b090fc449c9cd` |
| [Core/Widget.lua](<D:/ftjx/urhox-libs/UI/Core/Widget.lua>) | `aa4f6e9b667f0681ccb9c0df4a7e727c1ac204afb5f8fb4ec6eeb57f62e4128d` |
| [Core/Style.lua](<D:/ftjx/urhox-libs/UI/Core/Style.lua>) | `7ace494a67f881d98886e58d1219aef3a482a7cb22dcd4a13798d9ef6ca086bd` |
| [Core/Theme.lua](<D:/ftjx/urhox-libs/UI/Core/Theme.lua>) | `311c3fb128a90a838a7e951baa3968bf720f030721adbc3bbec7bcd9896bc2a4` |
| [Widgets/Panel.lua](<D:/ftjx/urhox-libs/UI/Widgets/Panel.lua>) | `0519b7b27605210069735a2a07530b7d74fc02ae6cca45e888e59aa09b1f4e26` |
| [Widgets/Label.lua](<D:/ftjx/urhox-libs/UI/Widgets/Label.lua>) | `c04904aae6257963685b94b273f23ce343848d92b85252002c653475ed25cc03` |
| [Widgets/Button.lua](<D:/ftjx/urhox-libs/UI/Widgets/Button.lua>) | `4841a1871db8ef78c557b2ee65d0c5f3c3fe877bc92f82feb7842d67c7bac6ef` |
| [Widgets/SafeAreaView.lua](<D:/ftjx/urhox-libs/UI/Widgets/SafeAreaView.lua>) | `22c0f9a9cc706e57c6c5366598c64bb24b42344780a957dad9c23a7bdf407472` |

预检复用 [工程检查器](<D:/dsh-taptap-maker-dev/src/ui-workflow.mjs#L199-L227>) 的十文件/主配置检查，补查决定字号转换的第十一项 Theme。必须显式传目标目录，读取成功的主配置包含 `taptap_publish.screen_orientation = landscape | portrait`，并与 IR 方向匹配。它不证明完整设置 Schema、账号身份、远端绑定或资源 metadata 就绪。

## 2. 原生格式与映射决策

真实入口导出 `UI.Panel`、`UI.Label`、`UI.Button`，但没有 `UI.Image`（[控件导出表](<D:/ftjx/urhox-libs/UI/init.lua#L95-L165>)）。[UILoader](<D:/ftjx/urhox-libs/UI/Core/UILoader.lua#L189-L265>) 按 `UI_[typeName]` 构造类，未知且未注册的类型会抛错；除 `type/animation/children` 等特殊项外，节点属性平铺传入构造器。不是 `{type, props:{...}, layout:{...}}`。

| IR | 首版原生结果 | 边界/证据 |
| --- | --- | --- |
| panel | Panel | 固定设计尺寸；中性 padding/margin/border/radius 明示为零，避免默认 Theme 改坐标。 |
| label | Label | `fontColor`、`textAlign`、`verticalAlign="middle"`、字符串 `fontWeight`；[Label 字段定义](<D:/ftjx/urhox-libs/UI/Widgets/Label.lua#L17-L34>)。 |
| button | Button | `textColor`、字符串 `fontWeight`、作者 disabled；[真实绘制](<D:/ftjx/urhox-libs/UI/Widgets/Button.lua#L611-L656>) 用 `Theme.FontFace(fontFamily,fontWeight)`，固定 center/middle。非居中 IR Button 明确阻断，不伪造 `textAlign`。 |
| image | 背景图 Panel | `backgroundImage/backgroundFit`；IR `stretch` 转为 native `fill`。不输出未经注册的 `Image`。 |
| sliced image | 背景图 Panel | `backgroundSlice=[top,right,bottom,left]`；[运行期实际索引](<D:/ftjx/urhox-libs/UI/Core/Widget.lua#L3696-L3712>) 为准。 |
| list | 固定内容 Panel | 不是 VirtualList；没有动态模板、虚拟化、存档或网络。 |
| modal | 自定义 Panel | 独立 binder 阻挡本加载实例中声明的背景 Button；不是 native Modal、焦点 trap、嵌套 portal 或宿主全局遮罩。 |

Button 的 `fontWeight` 不只是一条未消费的元数据：其 [intrinsic measure](<D:/ftjx/urhox-libs/UI/Widgets/Button.lua#L122-L126>) 与 [绘制取 face](<D:/ftjx/urhox-libs/UI/Widgets/Button.lua#L611-L644>) 都调用 `Theme.FontFace(props.fontFamily,props.fontWeight)`；[Theme 的真实映射](<D:/ftjx/urhox-libs/UI/Core/Theme.lua#L235-L266>) 对 normal 返回 baseFamily，对 bold 返回 `baseFamily.."-bold"`。这证明字段/slot被消费，**不证明宿主已注册不同的粗体字形、字体有授权，或视觉粗体等价**；相应 face alias 与字体资源仍由宿主核验，本包不扩大字体资产。

特别注意：[Widget 头部注释](<D:/ftjx/urhox-libs/UI/Core/Widget.lua#L135-L140>) 曾将切边顺序写为 `{left,top,right,bottom}`，与实际执行代码不同；不能从该注释倒推实现。sliced 绘制还明确忽略 radius，不声称完整 CSS 视觉等价。

[IR](<D:/dsh-taptap-maker-dev/src/ui-document.mjs>) 的 `layout.x/y` 已是父相对值。发射为 `left/top` 时不再次减父节点；保持实际父子树。普通可视样式仍为原生平铺属性，不把状态、动作、事件、编辑器字段或动态代码混入原生 UI JSON。未提供文字字号时使用明示的 16px 发射器默认值并给警告，字体家族/字库由宿主负责。

### 字号不能只透传

[Theme 实现](<D:/ftjx/urhox-libs/UI/Core/Theme.lua#L269-L318>) 表明：

```text
pixel: Theme.FontSize(pt) = pt * (96/72) * fontScale
IR px -> native pt = px / ((96/72) * fontScale)
char: sizeRatio = 1；不证明它与浏览器 px 等价
```

必须显式选择 `fontSizeMethod`；首版 `char` 阻断。`fontScale` 允许显式有限值 `0.1..4`，省略为 `1`，显式 `null` 非法。有效 setter 是 `UI.Theme.SetFontScale(...)`，不是被忽略的 `UI.Init({fontScale=...})`。`UI.Init.scale` 是另一个视口/分辨率缩放概念，不得混淆。

## 3. 官方脚本的兼容缺口：不能把静态无错当成可运行

所读文档：[转换边界](<C:/Users/wen/.taptap-maker/mcp-runtime/0.0.39/skills/lua-ui-to-json/references/conversion.md>)、[诊断与未检项目](<C:/Users/wen/.taptap-maker/mcp-runtime/0.0.39/skills/lua-ui-to-json/references/diagnostics.md>)。

- [通用 assemble 校验](<C:/Users/wen/.taptap-maker/mcp-runtime/0.0.39/skills/maker-ui-workflow/scripts/assemble-ui.mjs#L2213-L2227>) 允许 `Image`，并在 [构造输出](<C:/Users/wen/.taptap-maker/mcp-runtime/0.0.39/skills/maker-ui-workflow/scripts/assemble-ui.mjs#L2314-L2332>) 保留 `item.type`。这不能证明该类型已在目标原生库注册。
- 同脚本的 [Bbox 分支](<C:/Users/wen/.taptap-maker/mcp-runtime/0.0.39/skills/maker-ui-workflow/scripts/assemble-ui.mjs#L2432-L2447>) 则实际选择 Button/Panel；两条路径不能等同。其 rect 还是绝对坐标输入，本 IR 是父相对坐标，不能照搬父坐标减法。
- [共享 checker](<C:/Users/wen/.taptap-maker/mcp-runtime/0.0.39/skills/lua-ui-to-json/scripts/ui-json-check.cjs#L114-L126>) 的未预览类型主要为 warning；其 [skipped 列表](<C:/Users/wen/.taptap-maker/mcp-runtime/0.0.39/skills/lua-ui-to-json/scripts/ui-json-check.cjs#L193-L200>) 明确包括 runtime-equivalence、layout-and-fonts、lua-bindings、image-decoding、meta-and-font-resources、source-coverage 等。
- [CLI checker 的方向检查](<C:/Users/wen/.taptap-maker/mcp-runtime/0.0.39/skills/lua-ui-to-json/scripts/check-ui.cjs#L120-L128>) 在此版本**仅对 `assets/ui/pages/*` 应用**。本包建议 `ui/<workspaceId>/<revisionId>/main.ui.json`，因此插件预检必须独立核方向，不能依赖该 CLI 的退出码。

本发射器没有修改官方脚本、借它们直接装入游戏，或为未知类型默默降级。它只对本 IR 已定义的类型，按已审计接口构造新的独立静态输出。

## 4. 独立 Lua binder 与事务边界

[真实 LoadJSON](<D:/ftjx/urhox-libs/UI/Core/UI.lua#L918-L936>) 返回 Instance，而不是 root。查找使用该实例的 `GetRoot()/Find(id)`，不使用全局 `UI.FindById`。注意 [root/idMap 为弱值](<D:/ftjx/urhox-libs/UI/Core/UILoader.lua#L385-L404>)：binder 在分配 options/state 表前捕获 root，并由 controller 保持强引用。

行为接口：

```lua
local controller, err = Binder.Load(resourceId, state, {
    Attach = hostOwnedAttachCallback, -- 可省略；默认不挂根
    onToast = hostOwnedToastCallback, -- 可省略；默认只记录 lastToast
})
-- 或 Binder.Bind(alreadyLoadedInstance, state, options)
controller:Refresh()
controller:Dispatch("declared-action")
controller:Dispose()
```

- 同实例重复 Bind 幂等，不追加监听，也不偷偷替换原 state/options。
- [OnEvent/OffEvent](<D:/ftjx/urhox-libs/UI/Core/Widget.lua#L4289-L4320>) 按**同一个 handler 身份**订阅/退订。绝不传 nil 清空他人监听、不覆盖 `props.onClick`。
- 只允许声明的 `set/increment/show/hide/toggle/toast` 与 `gte/gt/lte/lt/eq/ne`；没有表达式求值或任意 Lua/JS 注入。
- Dispatch 先复制和预验所有有限 state 更新，全部通过才提交状态并更新控件。`show / set numeric key=false / increment` 末步失败时，旧 state、visibility、toast 均不部分更新。宿主 widget 或 onToast 的任意外部异常不被当作可自动回滚事务。
- 数值用浮点字面量并对声明值/动作快照作浮点归一，保留 JS IEEE-double 语义，避免 Lua 5.4 int64 算术或环绕改变结果；极端数字的**文字排版表现**仍不宣称与浏览器/引擎完全等价。
- Lua 字符串独立转义引号、反斜杠与全部 ASCII 控制字节；不拿 JSON escaping 冒充 Lua escaping。模板语法与 IR 同为 `{[A-Za-z][A-Za-z0-9_-]*}`；合法字面 `{0}`、`{__}` 不被误替换。
- 模态层可见时，背景声明 Button 被 disabled，强制调用本 binder callback 也不能执行背景点击动作；关闭/Dispose 恢复捕获的作者 disabled 基线，不影响其它实例与未声明控件。
- Load 的 nil/抛错/未知 type 被安全返回；Dispose 只清理自己的监听和 disabled 状态，不初始化 UI、不挂全局根、不销毁树。宿主仍负责移除自己的树、释放 controller 引用与唯一输入/更新/渲染转发。

示例只展示宿主**首次初始化**的明确 font method/Theme setter。已有初始化不被重写；安全区使用实际 `UI.SafeAreaView({...})` 或宿主已有 padding，不能重复包裹，不存在 `SafeAreaView.Wrap`。不调用 `UI.SetRoot(...,true)` 销毁旧界面。

## 5. Append-only 审阅包与资产门禁

公开 API：

```js
planMakerExport(document, explicitProjectDirectory, { fontSizeMethod, fontScale, assetRoot })
compileMakerUi(document, { fontSizeMethod, fontScale, assetPaths })
createMakerBindings(document)
createMakerReview(root, workspaceId, explicitRevisionId, explicitProjectDirectory, options)
```

`plan` 只读；`ready` 只代表可生成静态审阅。`createMakerReview` 重读 SHA256 验证过的不可变 revision，重新预检，不用未保存状态或偷偷选最新 revision；物理目录由参数与安全路径函数重新计算，不信 metadata 中的 directory 字段。

输出仅在已保存 UI workspace 的 `exports/<fresh-review-id>/`：`main.ui.json`、`bindings.lua`、`host-example.lua`、`usage.md`、最后提交的 `manifest.json`，按需加图片/NOTICE。目录新建，文件 `wx` 独占，失败留为隔离的不完整尝试，不删除、不复用、不覆盖旧审阅。UI workspace 位于任意 Maker 工程祖先下也拒绝 staging，即使该工程不是本次 selected target。

图片必须来自**显式且已确认归属的同一 UI workspace**，不是游戏 `assets` 回退或任意路径。检查普通文件、所有祖先 symlink/junction、路径穿越、单图不超过 10 MiB、扩展名/文件签名一致、与记录 SHA256 一致。准备输出时再次读取验证。**signature ≠ decode ≠ visual**：文件签名通过，不等于完整图片解码通过，更不等于原生视觉可用。

资产的 `own/CC0/MIT/OFL` 许可必须已有非空作者/来源/核验日期；MIT/OFL 保留大小受限的文本或本地通知。工具核对已有记录与内容，不自动下载，也不代替原作者/商业修改分发权/依赖/IP争议的事先逐项法律核验。没有已核验记录就阻断，不转付费生成。

manifest 保存 IR SHA256、十一源码 SHA256、每个 payload SHA256、许可/警告/建议安装路径，固定 `targetAccess="read-only"`、`stagedOnly=true`、`nativeVerified=false`。安装落点仅建议，**不是已经安装**：

```text
assets/ui/<workspaceId>/<revisionId>/main.ui.json
scripts/ui/<workspaceId>/<revisionId>/bindings.lua
resourceId = ui/<workspaceId>/<revisionId>/main.ui.json
```

不生成 UUID/.meta。metadata 固定 pending。另获明确安装授权后，才可由宿主核对真实 scriptsPath/工程状态，将资源放入实际 assets 并显式调用官方 `generate_resource_meta`；完整后缀为 `main.ui.json.meta`。官方工具应保留已有合法 metadata，不手造 UUID、不复用别的工程 metadata。本任务没有调用它、Maker build/submit/push/preview、测试二维码或额度生成工具。

## 6. 复核层级与可复现测试

测试只写全新的临时 fixture，复制上述十一只读源文件；不复制真实游戏配置/资源，不把任何真实 SDK/游戏当安装目标。临时产物保留，不删除。可显式设置测试 SDK 根：

```powershell
$env:TAPTAP_UI_TEST_SDK = 'D:\ftjx'
node --check src/ui-maker-contract.mjs
node --check src/ui-maker-export.mjs
node --test tests/ui-maker-export.test.mjs
node --test --experimental-test-coverage --test-coverage-include=src/ui-maker-*.mjs --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80 tests/ui-maker-export.test.mjs
```

包括有效 implementation-missing RED、源码/font/orientation 阻断、父相对坐标、图片/许可、immutable/fresh staging、目标字节未改、目录联接、实例内 modal/监听归属。真实安装的 Python `lupa.lua54` 执行生成 Lua 5.4 语法与纯 widget mock，验证六类动作、六类比较、严格标量类型、事务失败、浮点边界与控制字符/字面模板。缺该 runtime 就明确 `LUA_NOT_TESTED`/skip，不安装依赖、不把其它 Lua 版本冒充 5.4。

本次实际复核：两模块 `node --check` exit 0；发射专项 **22/22、0 skipped**，line **98.96%** / branch **85.77%** / function **95.56%**，三项 80% 门禁通过；IR + workspace + export 联合回归 **46/46、0 skipped**。已安装 `lupa.lua54` 实际输出 `LUA_MOCK_GREEN: (5, 4); nativeVerified=false`。这里的 JS 覆盖率不等于生成 Lua 的分支覆盖率，更不是原生引擎覆盖率。无单独 TS/构建/lint 脚本；客户端/API/GUI 接线不在本次发射器子任务范围。

**完成的是插件侧静态门禁/审阅与可用时 Lua mock；原生验收没有完成。** 没有打开引擎、改游戏入口、真实资源索引、字体/安全区/触控截图或试玩录像。Godot/Cocos/Unity 后端也未实现。未来另获原生运行授权后，必须按 asset-visual-qa 真的试玩/截图/录像复核；编译、静态无错、浏览器预览或 Lua mock 通过都不能把 `nativeVerified` 改为 true。
