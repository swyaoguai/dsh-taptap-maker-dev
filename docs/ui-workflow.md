# UI 工作台：插件侧 Maker-first 工作流

## 范围与边界

这是一套独立 UI 文档、版本工作区、浏览器编辑预览、受限 FairyGUI XML 导入和 Maker **静态审阅包**工作流。它不是 Unity LGUI 编辑器移植，也没有安装到游戏中。Cocos/Godot 后端尚未实现。

仅采用 [LGUI 历史 MIT 快照](<../third_party/LGUI-MIT/README.md>) 的模型算法与错误定义；固定提交 `e962aa3617aaad5a2fd5ddf2c80ace4bb1551240`，不自动混入许可证已变更的 current-main。详见 [MIT 审计](<lgui-mit-audit.md>)、[完整许可与通知](<../THIRD-PARTY-NOTICES.md>)。原 vendor 文件保持原样；[适配模型](<../src/lgui-model-adapter.mjs>) 注入受限 XML 读取，并投影为无环、字段白名单 DTO，不能 JSON.stringify 原始含 Map/循环引用的模型。

**不自动生成素材、改通道、下载依赖、读登录凭据、生成 UUID、修改游戏配置/入口、导入游戏、启动预览或 build/submit/push。** 文档 SHA256、浏览器行为、Lua mock 与原生引擎验收是不同状态。

## 使用入口

1. 更新代码后重载此插件，刷新**已经运行的 DSH GUI**。
2. 输入框旁点 `▦ UI`，或设置页 → **UI 工作台**。
3. 首次打开会出现四步引导：认识草稿 → 编辑文字 → 体验交互 → 保存新版本。支持上一步/下一步、跳过和顶部 **使用引导** 重看；引导只定位真实控件，不替你点保存、选择游戏或导出。明确跳过/完成后只在本浏览器记住该版本偏好；Escape 仅暂时收起，存储不可用也不妨碍使用。
4. 编辑与交互模式分离：编辑节点文字/矩形/颜色，或在演示中购买药剂、打开背包；交互模拟不写回文档。
5. 创建工作区或追加版本；已保存版本不会覆盖。保存以读取的 base revision 为条件，冲突须重读/合并。**关闭工作台** 位于左上，按钮至少44px高，外层为标题栏预留至少64 CSSpx；关闭 iframe 仍检查草稿，不能仅依赖 beforeunload。
6. 下载独立 JSON，或选择真实目标/字号方法并预检；**ready 只允许审阅包，不表示 native ready**。

工作台使用完整自有明暗配色，跟随宿主明确的主题标记或单一 `color-scheme`，缺失时跟随系统；不逐项复制宿主的背景/文字/输入框颜色。iframe及祖先上的主题标记、class、style变化也会同步；重挂载时更换观测集合，关闭后不再恢复监听。基础与主要控件字号14px，说明文字至少12px。常规/只读/placeholder文字须满足4.5:1对比，disabled至少3:1；这不是对任意用户设计稿或压缩录像中文字的保证。窄屏画布仍等比contain，不会自动改设计尺寸或重排节点。

数值、文字与颜色输入在键入时就校验，不必等失焦。标红的无效输入留在当前字段，不混进合法 IR；它仍计入未保存草稿，并暂时阻止保存、校验、预检、审阅包导出和 JSON 下载，避免把屏幕上的新输入悄悄换成旧值。请修正后再执行。切换节点若会丢弃无效属性须确认，拒绝则保留；读取期间发生新输入（同一无效字段继续键入也算），旧响应不能替换草稿。保存 ACK 只确认发出时的快照。

Tab/Shift+Tab在外层关闭按钮与 iframe 的实际首尾可用控件之间闭合，不跳到浏览器地址栏；子弹窗已经消费的按键不再交给宿主。关闭预览弹窗只在原焦点位于预览内时恢复触发按钮，不抢引导或属性编辑器的焦点。引导回到第一步会把原“上一步”焦点移到“下一步”；存储恢复后清除旧失败提示，重看时写失败不会遗忘此前已存偏好。

当前客户端是手写 ModuleLoader 包，[客户端入口](<../client.js>) 没有单独 build 步骤。不能用另起 Vite/server 假装更新现有 GUI；没有真实运行的构建 watcher 时也不承诺自动 HMR。

## CLI / 斜杠

```powershell
node "D:\dsh-taptap-maker-dev\src\taptap-ui.mjs" help
node "D:\dsh-taptap-maker-dev\src\taptap-ui.mjs" status --json
node "D:\dsh-taptap-maker-dev\src\taptap-ui.mjs" demo --name "营地供给"
node "D:\dsh-taptap-maker-dev\src\taptap-ui.mjs" list
node "D:\dsh-taptap-maker-dev\src\taptap-ui.mjs" create --in "D:\my-ui\camp.json"
node "D:\dsh-taptap-maker-dev\src\taptap-ui.mjs" read --id <UI_ID> --rev <REV_ID>
node "D:\dsh-taptap-maker-dev\src\taptap-ui.mjs" save --id <UI_ID> --base <READ_REV_ID> --in "D:\my-ui\camp-edited.json"
node "D:\dsh-taptap-maker-dev\src\taptap-ui.mjs" import-xml --fairy "D:\my-ui\UI.fairy" --component "Camp/Shop" --rights "D:\my-ui\rights.json"
node "D:\dsh-taptap-maker-dev\src\taptap-ui.mjs" plan --id <UI_ID> --project "D:\explicit-game" --font-size-method pixel
node "D:\dsh-taptap-maker-dev\src\taptap-ui.mjs" export --id <UI_ID> --rev <REV_ID> --project "D:\explicit-game" --font-size-method pixel
```

命令路径是本插件已存在的 [CLI 入口](<../src/taptap-ui.mjs>)；示例中的输入/游戏路径和 ID 必须由用户自行选定，不能据此操作任何候选游戏。斜杠 `/taptap-ui` 用相同参数，不把 rawInput 拼进 shell；`--force`、删除、生成和其它引擎 flags 均拒绝。

默认工作区是 `$DSH_HOME/taptap-maker-dev/ui-workspaces`，没有环境值时 CLI 使用用户 `.dsh`，**不是 cwd/game**。宿主 API/斜杠使用宿主实际 home；独立 CLI 若处于其它 profile，可按 `/status` 返回目录显式加 `--root`，不要指向 Maker 游戏目录。

## 文档与版本

[共享 IR 验证器](<../src/ui-document.mjs>)：`format=taptap-ui`、`version=1`，显式尺寸/方向，flat stable nodes，坐标相对直接 parent。首版六类为 panel/label/button/image/static list/custom modal。六类有限动作为 increment/set/show/hide/toggle/toast；不允许代码字符串、eval、任意 Lua 回调、动态列表或未知 props。文档最多 1 MB/1000 nodes/200 actions/每 action 32 steps。

[工作区存储](<../src/ui-workflow.mjs>) 采用新 ID、exclusive create、文档 SHA256、最后提交记录及永久 base claim；崩溃中间文件保留，不通过删 lock 重试。只有没有提交记录的未完成 revision 可略过；有提交记录的损坏不可静默退回旧版。提交元数据使用字段白名单，目录和文件路径从 root/ID 算出。历史必须是一条有唯一 root、无分叉/环/孤链的提交链；latest 沿链确定，不凭时钟/目录名推测。哈希检查不等于数字签名，也不证明恶意本机写入者没有同时改所有记录。

## XML 与图片

[Python stdlib 桥](<../src/ui-xml-bridge.py>) 使用已安装解释器 `-I -S -X utf8`，不安装 parser。stdin 单文件 1 MB、2048 元素、深度32、256属性/元素；拒绝 DTD/ENTITY/namespace，包括未使用声明。项目总预算8MB/256 XML。源码路径、重复 ID、失效引用、递归、控制器、gears、relations、动效、富文本、未知属性与无法保留的 Button 状态 fail closed。

XML 导入只展开明确的静态矩形、纯文字、不缩放普通 component 与极窄 Common Button；不是像素级还原认证。图片需要用户逐项核实作者、许可、商业/修改/分发/通知/IP 条件，并提供按包/资源 ID 的授权记录：

```json
{
  "PKG00001/ICON0001": {
    "sha256": "<real-file-sha256>",
    "license": {
      "kind": "own",
      "author": "真实作者",
      "source": "真实授权来源",
      "verifiedAt": "2026-10-31T00:00:00Z"
    }
  }
}
```

只接受已核验的 own/CC0/MIT/OFL 本地 PNG/JPEG/WebP，不从截图切图，不因 LGUI MIT 许可推定项目图片可用。MIT/OFL 要附完整 notice；本地 notice 路径相对输入 JSON 或 rights manifest 目录，安装前读为完整文本保存在文档中，缺失/越界/过大即中止，不先复制图片。SHA 与 PNG/JPEG/WebP 签名检查不是完整解码或视觉验收。**当前 H5 图片是清楚标注的占位显示，不读取实际图片。**

## Maker 静态审阅包

真实源码证据与11文件指纹见 [Maker 审计](<maker-ui-source-audit.md>)。只接受匹配的 SDK、已初始化主配置、显式匹配方向及 `fontSizeMethod=pixel`；字号转换 `IR px / ((96/72) * fontScale)`，实际 scale setter 是 `UI.Theme.SetFontScale`，不是 Init option。char 不能验证等价关系，明确阻断。

原生 UI 是 flat props/children 单一根对象，不是 IR。image 下沉为 Panel.backgroundImage，stretch → fill；Button textColor、Label fontColor；静态 list/custom overlay 不是 VirtualList/native Modal。Lua binder 使用 LoadJSON 返回 Instance 的 GetRoot/Find，保留强 root、精确 own click handler、事务式有限动作；不接管宿主 Init/SetRoot/Destroy，不删其他监听。custom modal 只阻挡本实例的背景 Button，不等于宿主全局焦点/输入遮罩。

每次只在保存工作区中新建 `exports` 下的审阅目录；不写任何 Maker 工程，包括未选目标工程的祖先目录。输出原生 JSON、独立 Lua、宿主示例、manifest、使用说明及获授权图片/notice。`stagedOnly=true`、`nativeVerified=false`、metadata pending。宿主示例不是自动执行/入口修改。

未来用户明确授权导入已初始化真实工程后，才使用官方 `generate_resource_meta` 生成资源 UUID，保留完整文件后缀的 companion meta；不得自行编 UUID。随后另获运行授权做实际字体、坐标、触控、安全区、资源/模态/多次关闭监听验收，并试玩截图录像；现在没有这一验收。

## 验证与 HTTP

```powershell
npm run test:ui
npm run test:ui:coverage
```

专项包括 IR、版本/并发、安全边界、stdlib XML、CLI、同源 HTTP、客户端注册/关闭、静态 SDK 检查、发射及 Lua5.4 mock。浏览器用本机已安装 Playwright，测试中拦截 HTTP的 renderer 验收与当前 GUI 验收必须分开。未安装的依赖不自动补装。

HTTP 只挂到原宿主 `/api/taptap-maker-dev/ui`：固定静态 allowlist、loopback Host、same-Origin/Sec-Fetch-Site、JSON POST 与体积/字段/ID限制。没有任意文件端点、删除/覆盖/生成/构建端点。具体状态与限制不得从 UI 显示 ready 推定为原生验收通过。
