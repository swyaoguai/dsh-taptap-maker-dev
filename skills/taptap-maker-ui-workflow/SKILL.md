---
name: taptap-maker-ui-workflow
description: 插件侧独立 UI 文档、受限历史 MIT FairyGUI 导入、静态编辑预览、追加版本保存与 Maker 审阅包工作流；不接管游戏、不自动导入或构建。
---

# UI 工作台 · Maker-first

用户要可编辑游戏 UI、FairyGUI 导入、UI JSON/版本、或 Maker 静态审阅包时使用。实际开发前同时查 taptap-maker-core、taptap-maker-ui 与相符主题技能。

## 安全边界

- 只采用固定 LGUI 历史 MIT `e962aa3617aaad5a2fd5ddf2c80ace4bb1551240` 的已审计模型/错误文件；不要合并 current-main。MIT 不授权上游示例图片或未核验依赖。
- 独立 IR 不等于原生 UI.json。IR `x/y` 已相对 parent；Maker 的 flat props/children 不能再减 parent 坐标。
- 默认工作区在宿主 `$DSH_HOME`，不是游戏 cwd。保存追加版本，base 不符重读合并。禁止 force/覆盖已有资产、删文件/锁、删除作业或吞掉已提交版本损坏后回退。
- 不自动生成图片/音频/3D、使用额度、改模型/通道、安装依赖、处理明文密码或读取账号凭据。
- `plan.ready=true` 只允许尝试 staged review，不允许导入、修改游戏配置/入口、生成 UUID、启动 preview/build/submit/push，也不证明 native 验收。

## 实际操作

1. 用现有 GUI 输入框旁 `▦ UI` 或设置 → UI 工作台打开；无法加载时先查当前宿主是否重载新插件。不要开另一 server、重启停止的游戏或承诺无 watcher 的自动 HMR。
2. `/taptap-ui help`、`status`、`demo`、`list`；创建/导入由用户明确输入源文件，不能猜候选游戏路径。
3. 本机入口是 `node "D:\dsh-taptap-maker-dev\src\taptap-ui.mjs"`；flags 可从 help 查。`save` 必须传读取的 `--base`，`export` 必须指定保存的 `--id/--rev` 和明确目标。
4. XML 用已安装 Python stdlib 隔离桥，不自动下载 parser。仅静态矩形/文字、不缩放普通组件、窄 Common Button；unknown、namespace、DTD、关系、控制器、gears、声音/下压效果或丢失子图层状态应阻断，不伪装可用。
5. 图片先逐项核实作者/零费用/商用/修改/游戏分发/通知/IP；明确 SHA 与 verifiedAt。LGUI MIT 不涵盖图片。MIT/OFL 本地通知安装前读为完整文本并保留；缺失时不能先复制素材。当前 H5 图片明确占位，不是真图视觉复核。
6. 明确 `pixel` 字号和方向；SDK 11文件指纹不符阻断。px-to-pt 实际公式为 `px / ((96/72)*fontScale)`，scale 用 `UI.Theme.SetFontScale`，不是 Init option；char 不猜等价。
7. 审阅包输出路径必须真实回报，保持 stagedOnly、nativeVerified=false、metadata pending。不写选定或未选定 Maker 祖先工程。
8. 后续真实导入/运行须另获用户授权。官方 generate_resource_meta 才能生成 UUID；不得编造。原生试玩、字体/安全区/资源/触控/模态/多次关闭监听及截图录像完成前，不宣布 nativeVerified。

## 参考

- [完整用法](<../../docs/ui-workflow.md>)
- [MIT 审计](<../../docs/lgui-mit-audit.md>)
- [Maker 实际源码契约](<../../docs/maker-ui-source-audit.md>)
- [第三方通知](<../../THIRD-PARTY-NOTICES.md>)

浏览器 preview、静态 checker、Lua5.4 mock、native acceptance 是独立状态。既有 UI 编辑不会触发重新生成。
