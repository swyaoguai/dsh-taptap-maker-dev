# 变更记录

只记**用户能感知**的行为变化与修过的坑；格式参考 Keep a Changelog，版本号跟随 `package.json`。

## 未发布

### Cocos：参考图叠加（照着设计稿搭界面）

- 新增工具 `cocos_reference`：`set` 把一张 UI 设计稿叠到场景视图上，
  `clear` 移除，`list` 看当前叠加状态。
  有设计稿时 AI 照着图摆节点，比照着文字描述摆准得多。
- 覆盖层是 `pointer-events: none` 的纯展示层：**不碰节点树、不改组件、不动资源**，
  用户在场景视图里照样能点节点、拖 gizmo。
- 实现走 `cocos_exec`（editor 上下文）的 `require('electron')` →
  `BrowserWindow` → `webContents.executeJavaScript()` 往渲染进程注入 DOM。
  Creator 3.8 **本身没有**官方的参考图功能（`Editor.Message` 各命名空间里
  都没有 overlay / reference 相关方法），这是唯一可行路径。
- **参考图必须放在 Cocos 工程目录内**（推荐 `<工程>/temp/dsh-ref/`）：
  上游 `execute_javascript` 的安全检查会扫描代码里的字符串字面量，
  碰到工程外的绝对路径就整个拒绝执行。工具会提前拦下并给出可操作的提示。
- 相关文档：`cocos-scene-first-workflow` 第 1 步加了「先看设计稿」，
  `references/recipes.md` 第 8 节是完整用法与失败对照表。

### Cocos：修 `cocos_open` 起不来编辑器

- `spawnCreator` 现在会显式清掉 `ELECTRON_RUN_AS_NODE` 环境变量。
  该变量存在时 CocosCreator.exe 会退化成纯 Node：把 `--project` 当成 Node 的未知参数
  （`bad option: --project`）或把工程目录当模块路径（`Cannot find module 'D:\wxzj-cocos'`），
  两种都在几秒内退出 —— 表现是「编辑器起不来」，但错误信息完全看不出是环境变量的问题。
  本机 DSH 运行时该变量为 1，实测踩过。

### Cocos：写清楚「为什么不用 Cocos MCP Server」

- `docs/cocos-mcp.md` 补了一节选型说明，回答「要不要把
  [DaxianLee/cocos-mcp-server](https://github.com/DaxianLee/cocos-mcp-server) 接进来」：
  结论是**不接**，三条硬理由 ——
  ① 它明确禁止商用（含衍生代码），而 Cocos 项目要上商店；
  ② 它的 `initialize` 不上报 `project_path` / `project_id`，
     本套「写操作必须打在正确工程上」的安全层会当场失效，且端口是固定的 3000；
  ③ 开源版 50 个工具是 Funplay 上游（106 个 + resources + prompts + 输入模拟）的子集，
     README 宣传的 231 项操作是商业闭源 Pro 版。
- 它唯一值得吸收的「参考图叠加」已经自己实现了（见上），不必为它换掉整个上游。

### Cocos：补上「Graphics 现画 vs Sprite 贴图」的分流判据

- `cocos-ui-layout` 新增「先分流：这个按钮底是贴图还是现画？」一节：
  `cc.Sprite` 与 `cc.Graphics` 在同一节点上**互斥**，按钮底的画法直接决定要不要 `cc.Button`；
  并写清 `cc.EventHandler` 是独立对象（不需要 `cc.Button`），
  Graphics 路线照样能拿到「策划在属性检查器里连线」的能力。
- `cocos-performance` 新增「『Graphics 太多』要不要换贴图？先分类」：
  按「一次性绘制 / 视觉重复 / 每帧重画」三类分流，只有「视觉重复」才值得换共享贴图。
- 这两条是实测踩出来的：有个工程（界面全 Graphics 现画）被"缺 `cc.Button`、该换 Sprite"的
  通用最佳实践误导，加 `cc.Button` 后撞组件冲突报错。

### Cocos：补齐 14 个专题 skill

- 在 `cocos-creator-mcp` / `cocos-scene-first-workflow` 之外，新增 14 个 Cocos Creator 3.x 专题 skill：
  工程结构 `cocos-project-structure`、TS 规范 `cocos-typescript-standards`、
  组件架构 `cocos-component-architecture`、资源与预制体 `cocos-resource-prefabs`、
  UI 与适配 `cocos-ui-layout`、动画 `cocos-animation`、物理 `cocos-physics`、输入 `cocos-input`、
  性能 `cocos-performance`、音频 `cocos-audio`、联网 `cocos-networking`、
  构建发布 `cocos-build-release`、编辑器扩展 `cocos-editor-tooling`、测试 `cocos-testing`。
- `taptap-skill-router` 增加「Cocos Creator 项目按需求加载」对照表，按任务挑 1~2 个，
  不再需要模型自己猜。
- Cocos MCP 守则（`src/cocos/policy.mjs`）补一条：专题内容按需加载，不凭记忆写 3.x API。
- 全部按 Creator 3.x 写并明确 2.x 不适用；每篇都带「验收」与「常见坑」，
  和 MCP 的「保存 → 截图 → 看日志」闭环对齐。

### Cocos：先搭舞台，再规划代码

- 新增 skill `cocos-scene-first-workflow`：要求 AI 先在编辑器里像人一样建节点树、
  挂组件（Button/Widget/Label 等标准组件）、配好物理分组与碰撞矩阵、存盘截图验收，
  **之后**才规划并编写逻辑代码；禁止用代码 `new Node()` 动态拼 UI / 场景，
  运行期临时对象只能从 Prefab 实例化。
- Cocos MCP 守则注入加了一条硬约束：涉及场景/UI/玩法开发时必须加载这个 skill
  （`src/cocos/policy.mjs`），新会话开场即生效，不依赖模型自行匹配。
- `taptap-skill-router` 同步登记（Cocos 行的必读补充 + 独立触发条件行）。
- 配套 `references/recipes.md`：可直接抄的 `cocos_exec` 片段（Canvas / Widget 容器 / 按钮 /
  SpriteFrame / 2D 物理体 / 存 Prefab / 编辑器连线）与「UI 看不见、按钮点不到、物理不碰撞」
  等常见失败对照表。

## 0.7.0 — 2026-11-05

### 生图通道：顺序就是使用顺序

- 设置页「图片 / 视频 / 音频」各自有一张**通道优先级**卡（「开始」页另有总览）：
  从上到下就是使用顺序，上面那条不可用（没配好 / 没账号 / 额度不足）就自动换下一条。
  **全都不行时才提示你去补配置**，并逐条列出缺什么。
- 「要不要往下换」从**一个全局开关**改成**每类素材一个**：生图默认**开**，
  视频 / BGM 默认**关**（按秒计费 / 订阅额度，不替用户连续花钱）。
- 生图默认顺序改为 **章鱼生图 → ChatGPT 网页 → 中转站**。
- 新增对话入口 `/game-image lanes`（中文别名 `通道` / `顺序`）：
  看顺序 / 开关 / 就绪 / 「现在会走哪条」；改顺序、开关、回退需自己带 `--yes`。
- 配置升级到 `lanes.json` v2：旧文件自动换算（原来全局开着 → 三类都开；
  原来关着 → 生图按新默认开、视频/BGM 保持关），**你排过的顺序原样保留**。

### 修掉的问题

- **顺序从来没被执行**：统一入口用的是 `runWithFallback`，而各通道的失败是返回值
  `ok:false`，执行器把「没抛异常」当成成功 —— 于是排了顺序、开了自动切换也照样
  一失败就结束。现在改成显式顺序循环，并把「能不能换」收敛成一处判据：
  确认被拒的额度 / 没账号没模型 / 缺 Python → 换；结果未知、已提交、人机验证、
  参数写错 → **绝不换**（换了是再花一次钱）。
- **只试一条通道时**失败会被汇总成 `lane=null` 的「全部失败」，丢掉该通道自己的
  原因、`pendingUrl` 与登录指引；现在原样返回那条通道的结果。
- **网页生图每次必挂**：注入给 Python 的片段里 `split("\n")` 写在 JS 模板字面量中，
  `\n` 先被 JS 吃成真换行 → Python 跨行字符串字面量 → `SyntaxError`（连浏览器都没打开）。
  改为双反斜杠，并加源码级护栏测试（`node --check` 看不出这类错误）。
- **机器忙时误报「没装 Python / Pillow」**：满负载下 python 冷启动实测 3~6.5 秒，
  探测超时被当成「未安装」，叫人去装他已经装好的东西。现在探测超时会重试一次，
  仍超时则明说「探测超时、稍后重试」，不再谎报未安装；参考图预处理同样区分两者。
- 文案：清掉所有「网页生图是首选 / 默认走网页」的旧说法（`/game-image status`
  会直接打出当前顺序）；面向 AI 的 skill 说明同步改成「按顺序自动选通道」。

### 自查

- 全套离线自测脚本（`scripts/verify-*.mjs`）覆盖：通道归一化与迁移、顺序路由、
  设置页 ↔ 路由往返渲染、护栏、参考图预处理、生图分派等。

## 0.6.0 — 2026-11-04

- 从「TapTap Maker 专用」改成**通用游戏开发工作流**插件：Godot / Unity / Unreal /
  Cocos Creator / 网页（PixiJS、Canvas）与 TapTap Maker 并列支持。
- 分组式设置页（开始 / 图片 / 视频 / 音频 / 其他）；Cocos Creator MCP 集成
  （多项目并发安全：项目参数路由、握手验身份、每项目写锁、构建全机串行）。
