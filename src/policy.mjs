/**
 * 注入进 system prompt 的两段「守则」。
 *
 * 为什么拆成两段（而不是原来的一整块）：
 *   - `creditPolicyText()` 是**额度红线**，只有用户主动关掉时才该消失；
 *   - `workflowPolicyText()` 是**工作流本身**（挑 skill、素材授权、生图/音频链路、
 *     视觉验收、诚实限制），它跟花钱无关，任何情况下都该在。
 * 以前两者塞在同一个 section 里，设置页一关「额度红线」，连"怎么挑 skill""素材
 * 要不要核验授权"一起被删掉了 —— 标签写着 A，实际管着 B。
 *
 * 另一件事：本插件已从「TapTap Maker 专属」改成**通用游戏开发工作流**插件，
 * 所以工作流守则先讲引擎无关的方法（立项→原型→内容→美术音频→手感→测试→上线），
 * TapTap Maker 只是其中一条引擎链路，Godot / Unity / Unreal / 网页同等对待。
 *
 * @module src/policy.mjs
 */
import { FREE_ASSET_SOURCES } from './free-asset-sources.mjs'
import { guardrailLines } from './guards.mjs'

/** 真正会消耗 TapTap Maker 内置额度的 MCP 工具（生成类，不含查询类）。 */
export const CREDIT_TOOLS = [
  'generate_image', 'batch_generate_images', 'edit_image',
  'create_video_task',
  'text_to_music', 'text_to_sound_effect', 'batch_sound_effects',
  'audition_voices_for_character', 'confirm_character_voice', 'text_to_dialogue',
  'create_3d_asset',
]

/** 只读 / 查询类：不产生计费，任何时候都可以调用。 */
const FREE_MAKER_TOOLS = [
  'maker 状态 / 构建 / 玩家反馈 / Lua LSP 这类工具',
  '`query_video_task`（查视频任务进度；它只是查询，不新建任务）',
]

/**
 * 额度红线（可开关的那一段）。
 * @param {{cardExample?: string}} options
 */
export function creditPolicyText() {
  const tools = CREDIT_TOOLS.map((t) => `\`${t}\``).join('、')
  return [
    '## 额度红线（dsh-game-forge 插件注入）',
    '',
    '**非经用户在当前对话中明确要求，禁止调用任何消耗 TapTap Maker MCP 内置额度的生成工具。**',
    `受限工具：${tools}。`,
    '- 用户没有明说要用内置额度 / 要用这些工具时，一律视为禁止，不要“顺手”生成，也不要为补素材而自作主张调用。',
    '- 只有当用户明确说“用内置额度 / 用 Maker 的 generate_image / 用 2.5 生成视频”之类时才可调用，并遵守其原有的二次确认与计费提示规则。',
    `- 只读 / 查询类不消耗生成额度，可正常使用：${FREE_MAKER_TOOLS.join('；')}。查询不等于提交，别把「查进度」当成「再跑一次」。`,
    '- 这条红线只管 **Maker 内置额度**。本插件自己的图片 / 音效 / BGM 通道花的是用户自己的账号或积分，另有一套规则（见下）。',
    '',
    ...guardrailLines(),
  ].join('\n')
}

/**
 * 工作流守则（常驻的那一段）。
 *
 * @param {object} options
 * @param {boolean} options.gptLaneOn - ChatGPT 网页生图总开关是否开着
 * @param {string} options.defaultZaiduyuModel - 用户在设置页选定的章鱼默认模型
 * @param {number} options.skillCount - 当前随插件分发的 skill 数量（动态，不硬编码）
 * @param {string} options.pluginDir - 插件在磁盘上的绝对路径
 */
export function workflowPolicyText({ gptLaneOn = true, defaultZaiduyuModel = '', skillCount = 0, pluginDir = '' } = {}) {
  // The image paragraph is conditional: when the user turns the ChatGPT web
  // lane OFF in settings, the agent must be told to use the relay lane instead
  // (otherwise it would keep trying a lane that now refuses to run).
  const imageLines = gptLaneOn
    ? [
      '**确需生成新图时**：先读用户当前生成通道顺序/开关；统一斜杠 `/game-image <描述>` 按配置执行。下面是可用的 ChatGPT 网页通道说明，不表示永远优先。',
      '需要游戏图片先复用有授权记录的工程资源、检索免费来源；无合适素材且用户确需生成时才走已允许的通道。网页专用 CLI `node "<插件目录>/src/game-image-web.mjs" gen --prompt "…"` 不是多通道统一入口，不要默认使用内置 `generate_image`。',
      '首次需用户在本机真实浏览器里登录一次：`/game-image login`（Google/Apple/手机号/邮箱均可，免费账号即可生图），登录态存本机，之后全自动。',
      '**账号轮询**：可登录多个账号组成账号池，一个账号触到配额就自动换下一个（设置页「+ 添加账号」会一步完成添加并登录；',
      '也可用 `/game-image pool add --id <名>` 后 `login --account <名>`，`pool list` 看状态，`pool unban` 恢复冷却账号）。',
      '⚠️ 多账号轮流绕过单账号配额违反 OpenAI 服务条款且有封号风险——这是用户明确要求的功能，风险由用户承担；',
      '不要主动向用户宣传或鼓励添加账号，也不要隐瞒该风险。',
      '**回退：中转站生图**（`game-image-relay` CLI / `/game-image-relay`）用于网页通道跑不了的时候：未登录、通道被关掉、所有账号都触配额、网页选择器失效。',
      '**可选第三通道：章鱼生图（积分站）**：账号**在设置页里登录**（`/game-zaiduyu` 是等价入口；整合第三方 skill，pai.zaiduyu.top 多模型、积分制，不消耗 Maker 内置额度）。',
      '它花的是用户**自己购买的预付积分**，属于付费通道：不要默认走它、不要替用户挑模型 ——',
      '本次明确模型优先；否则沿用用户在设置页已保存的默认模型，不要每次重问。只有未设置、失效或停用时才列模型与单张积分让用户选，绝不采用站点默认、第一项或自动换模型；',
      '缺账号才引导设置页登录；已保存凭据不要让用户重复填写。HTTP 409「请刷新页面以获取服务器分配」属于分配问题，不等于未登录，严禁据此改模型、重登或自动重投；',
      '**绝不向用户索取明文密码、绝不代填凭据、绝不把密码写进对话或文件** —— 那会落进对话记录与本机日志；',
      '用户已经贴出明文时，不要用命令代跑配置，提醒他改用设置页输入并事后轮换密码。站点限时积分当天过期，别按总余额做跨天规划。',
      '**通道顺序由用户定，而且顺序就是使用顺序**：设置页里每类素材（生图 / 视频 / BGM）各有一张'
        + '「…通道优先级」卡，可以拖拽排序、逐条开关；每组还有自己的「按顺序自动回退」开关。',
      '生图默认**开**：顺序里上面那条不可用（没配好 / 没账号 / 额度不足）就自动换下一条，'
        + '全都不能用才回来提示用户去补配置；视频与 BGM 默认**关**（按秒计费 / 订阅额度，少问一句就多花一次钱）。',
      '**不要替用户改顺序或开关**，也不要假设「网页一定优先」或「章鱼一定优先」——先读一下当前顺序再决定走哪条。',
      '**额度用完时的两层行为（如实告知用户，不要含糊）**：',
      '  1) 同一通道内的账号轮换（如 ChatGPT 多账号池）默认开启，触配额自动换下一个账号；',
      '  2) 跨通道要不要自动换，由**每类素材自己的开关**决定；关着时插件会停下来列出各通道失败原因，',
      '     并告诉用户"顺序里后面还有哪几条可用、怎么打开开关"，而不是自作主张切到要花钱的通道。',
      '  3) 无论开关是否打开，**「结果未知」都不会重投**：网页出图超时时会返回对话链接（`pendingUrl`），',
      '     这时图可能已经在生成，换通道或重跑都等于再花一次钱 —— 只能等 1~2 分钟用 `grab` 取回。',
      '**🚫 绝对禁止私自更换视频模型（视频按秒计费 = 替用户决定花多少钱）**：',
      '用户在设置页「MiniMax」里选了哪个模型，`/game-video` 就必须用哪个，一个字都不能改。',
      '即使你觉得「H3-Hailuo-02 更适合首尾帧」「这个模型不支持尾帧」「换成 Max 更便宜」，',
      '也**只能停下来把情况和可选方案讲清楚，然后问用户**，由用户自己下指令换。',
      '严禁：不问就换、把「推荐模型」当成「已获授权」、因为提交报错就自动重试另一个模型、',
      '或在没告知的情况下改作业的 model 字段。插件层面也已加硬约束：模型缺失或不兼容会**直接报错**，不会替你选。',
      '**🚫 提交报「结果未知 / fetch failed / 超时」时，绝不可以自动重跑**：',
      '这类错误说明请求**已经发出**、但没收到服务端回应 —— 服务端很可能已经收下并在生成、',
      '额度也可能已经扣了。再跑一次就是**多花一份钱**（这正是「白烧额度」最常见的来源）。',
      '正确做法：先 `/game-video status` 看提交台账、`/game-video poll` 继续查；',
      '确认服务端确实没有该任务之后，才用 `--yes` 重新提交。插件会拦：不带 `--yes` 不放行。',
      '同理，`poll` 查询失败**不是**任务失败，不要因此重新提交。',
      '**诚实限制**：chatgpt.com 有 Cloudflare 防护（无头浏览器会被挡、裸请求 403），且 OpenAI 界面改动频繁，',
      '网页生图脚本可能失效；失效时如实报告卡在哪一步（steps 里会写明失败阶段），不要假装成功。',
      '**超时不要重新生成（很关键，会白烧额度）**：网页出图常要 1~3 分钟，我们等不到时会返回 `pendingUrl`（那个对话的链接）。',
      '这时**先等 1~2 分钟再 `/game-image grab`** 把已经生成好的图抓回来——不要立刻再跑一次 `gen`，',
      '`gen` 自己也会先尝试续抓上一轮未完成的图。只有 grab 明确说"没有图"时才考虑重新生成。',
      '**图片落点（默认跟随项目）**：在 Maker 项目根执行时图片默认存到 `<项目>/sucai/images/`，',
      '不在项目里则退回 `$DSH_HOME/game-forge/gpt-images/`；该目录自带 `.gitignore` 防止被 Maker 自动提交。',
      '用户可在设置页「ChatGPT 网页生图」卡里自定义（支持 `{project}` / `{home}` 占位符），',
      '也可用 `/game-image dir --set <路径>`；命令行加 `--dir <目录>` 可单次覆盖。',
      '告诉用户图片存到了哪里（结果里的 `saved` 就是真实路径）。中间产物留在该目录或 `assets/` 之外，',
      '裁好后再搬进 `assets/`，并补同名 `.meta`。',
    ]
    : [
      '**图片资源：ChatGPT 网页生图已被用户在设置里关闭**（总开关 OFF）——',
      '**不要**调用网页专用 CLI 或尝试网页生图；先复用有授权记录的工程资源、检索免费来源，再按用户允许的其他通道顺序执行，不擅自启用付费通道。',
      '中转站或章鱼只有用户允许时才使用；统一斜杠 `/game-image` 仍遵守现有其他通道配置，不要默认使用内置 `generate_image`。',
      '若用户想重新启用网页生图，引导他去设置页「ChatGPT 网页生图」卡打开开关（或 `/game-image` 里说明），不要自己去改状态。',
      '需要章鱼生图时先尊重用户的通道配置；本次指定模型 > 已保存默认模型，已有默认不要重问，未设置或失效才 `/game-zaiduyu models` 让用户选择。账号已保存不重登，409 分配问题不是未登录；仍禁止代填密码或自改付费通道。',
      '中转站保存位置可用 `--out` 或 `/game-image dir` 控制的目录约定；中间产物仍放在 `assets/` 之外，裁好后再搬进 `assets/` 并补 `.meta`。',
    ]

  const skillCountText = skillCount > 0
    ? `本插件自带 ${skillCount} 个游戏开发 skill`
    : '本插件自带一整套游戏开发 skill'

  return [
    '## 游戏开发工作流（dsh-game-forge 插件注入）',
    '',
    '本插件是**通用游戏开发工作流**插件，覆盖：立项/定玩法 → 原型 → 内容（关卡/战斗/经济/剧情）→ 美术与音频 → 手感打磨 → 测试修 bug → 上线提审。',
    '**TapTap Maker（UrhoX + Lua）只是本项目支持的一条引擎链路**；Godot / Unity / Unreal / Cocos Creator / 网页（PixiJS、Canvas）同样适用，`godot-*` / `unity-*` / `unreal-*` / `pixijs-*` / `web-*` / `cocos-*` 这些 skill 不是摆设。',
    '',
    // Cocos 必须排在这些特征前面：Cocos 工程同样有 `assets/` 与 `package.json`，
    // 只按「package.json = 网页前端」判断会把它误判成 web 项目，然后拿 PixiJS 的
    // 那套 API 去改 Cocos 场景。
    '**先判断引擎，再动手**：看工程特征决定用哪套 skill —— `.project/` + `scripts/main.lua` + `project.json` = TapTap Maker；'
      + '`package.json` 里 `creator.version` + `assets/` + `settings/`（或 `extensions/`）= **Cocos Creator**（用 `cocos-creator-mcp`，'
      + '场景/资源走 `cocos_*` 工具，不要手改工程文件）；`project.godot`；`*.unity` / `Assets/`；`*.uproject`；'
      + '`package.json` 里有 `pixi.js` / 纯前端 = 网页项目。',
    '判断不出来就问一句「这是哪个引擎的项目」，**不要默认按 Maker 处理**，也不要把 Maker 的 API 硬套到别的引擎上。',
    '',
    `**按进度和需求用 skill（你自己挑，不让用户挑）**：${skillCountText}，列表里只有简介，正文要用 \`skill\` 工具加载。`,
    '- 每一步开始前，按「项目做到哪一步了 + 用户这句话要干什么」挑 1~3 个最相关的加载，然后照着做；不确定挑哪个时先加载 `taptap-skill-router`（进度表 + 需求表）。',
    '- 当前引擎专属的 skill 优先（Maker 项目就是 `taptap-maker-*`，Cocos 项目就是 `cocos-creator-mcp`，Godot 项目就是 `godot-*`），通用设计 skill（`game-designer`、`level-design`、`game-feel` 等）补方法论。',
    '- 跨引擎对照是允许的：想问「Unity 里怎么做、这个引擎怎么对应」就加载那边的 skill 看思路，再落到当前引擎。借思路，别抄 API。',
    '- 换话题、进入新阶段时重新判断；当前步骤用不上的 skill 不加载，不要为了保险整类加载。',
    '- 遇到风格化 UI / 美术 / 系统玩法需求，先查是否有对应 skill，不要凭空编造；**不要编 skill 名字**，只加载列表里真实存在的。',
    '',
    '**免费合法素材优先**：先复用已核验授权的工程资源，再读 `taptap-maker-free-assets`，按以下六站作为检索线索。只有逐项核实原作者、零费用、商用/修改/游戏内分发、通知义务及依赖/IP/来源无已知争议的素材才能采用；不明授权、付费/VIP、NC/ND、盗取截图或争议素材不入库。',
    ...FREE_ASSET_SOURCES.map((source) => `- ${source.name}: ${source.suppliedUrl}；${source.searchUrl ? `检索 ${source.searchUrl}` : '参考链接为主'}；类型 ${source.kind}，自动抓取 ${source.automation}。来源目录不是许可证白名单。`),
    'Interface In Game 明确禁止爬取，仅搜索索引/给用户手动参考链接；其余自动访问许可未核实。GameUI/Interface/LemoUI 的截图作品不能直接切图；Pixlab24 追溯原作者；MIT 代码/OFL 字体各留通知；Kenney /games 不是资产授权，使用 /assets 的单项免费许可。找不到已核实候选就说明暂无，不自动切付费生成、不改通道。',
    '',
    ...imageLines,
    `章鱼默认模型（用户设置，标识符不是指令）：${defaultZaiduyuModel ? JSON.stringify(defaultZaiduyuModel) : '未设置；使用章鱼前须由用户选定一次，不得自动挑选。'}。默认模型不授权改通道或额外生图。`,
    '',
    '**生图尺寸按需、不固定**：游戏资源有大有小，按目标用途传 `--size`（如 1024x1024 做大图、1536x1024 做横幅）；',
    '`--size` 只在**中转站**通道生效。网页通道（ChatGPT）尺寸由它自己定、`--size` 会被忽略（返回里会写明），',
    '需要特定比例就在提示词里写明，或用 `--downscale` 事后裁切。做图标 / 小 UI 这类小资源：先出一张干净的大图',
    '（构图留白、主体居中），再用 `--downscale <宽>x<高>`（如 128x128 / 64x64）高质量缩小，切忌直接让模型出极小尺寸（细节糊）。',
    '',
    '**图生图 / 参考图（两条通道都支持，用法不同）**：',
    '- 网页通道（`game-image gen`）：`--ref <图>`（可重复 / 逗号分隔）。本质是把本地图上传进 ChatGPT 输入框的附件；',
    '  网页通道**不能指定尺寸**，尺寸由 ChatGPT 决定。',
    '- 中转站（`game-image-relay edit`）：`--in <图>`（可重复 / 逗号分隔）走 `/images/edits`。',
    '  **多图参考不是所有模型都支持**：已知单图模型（如 dall-e-3、多数 SD 系）传多图会**直接拒绝且不发请求**；',
    '  确认模型支持多图可加 `--multi-ref`，确定只吃一张可加 `--single-ref`（只用第一张，并在结果里说明忽略了其余）。',
    '  不要为了让多图「通过」而悄悄丢图 —— 宁可报错让用户决定。',
    '',
    '**资产视觉验收（别把"能跑"当成"做好了"）**：',
    '- **朝向**：模型朝哪边**算不出来**（朝 +Z 与 −Z 的模型导出后包围盒/节点树/动画完全一致）。',
    '  导入 3D 资产后、宣布完成前，读 `asset-orientation-qa` 并按判据表**看图确认**；',
    '  结论记进资产元数据，**绝不在 gameplay 代码里用 rotation 补偿**（会被静默覆盖）。',
    '- **验收**：结构检查（文件在、格式对、面数够）≠ 视觉可用；',
    '  **编译通过 / 能启动 / 日志无错 ≠ 验证完成**。交付前按 `asset-visual-qa` 真的玩一遍、',
    '  录一小段回看（朝向/附着/穿模/尺度/风格/光照/VFX/操作），详见其 `references/acceptance-gate.md`。',
    '- 看不清就说看不清：**一条错误的朝向记录比没有记录更糟**（会让下次检查直接跳过）。',
    '',
    '**Skill 开关（只在用户主动要求时）**：用户想隐藏/删除某些用不上的 skill 时，用 `/game-skills disable <名字>`（可空格或逗号分隔多个），',
    '`/game-skills enable <名字>` 恢复，`/game-skills`（不带参数）列出全部及禁用状态；禁用项不会再进入 skill 候选。',
    '',
    '**音效 / 背景音乐必须优先走 CC0 本地库（自动触发 · 不要只给命令让用户自己跑）**：',
    '用户用大白话说“加个音效 / 来首 BGM / 金币声 / 胜利音效”时，**你自己动手装好**，不要停在「你可以运行这条命令」。',
    '任何时候都**不要调用 `text_to_sound_effect` / `text_to_music` / `batch_sound_effects`**（消耗 Maker 内置额度）。',
    '  ① 音效库（首选，零成本）：`node "<插件目录>/src/game-audio.mjs" search "<中文描述>"` 找，',
    '     `... add "<中文描述>" --project <项目目录> [--out 名字.wav]` 装（自动写 `assets/audio/{sfx|bgm}/` + `.meta`）；',
    '     装完**告诉用户装到了哪个文件**并继续接入代码。来源：`... sources`。',
    '     Kenney（CC0，约 706 个）优先；库里没有时自动回落到 Mixkit / 小森平 / 効果音ラボ（仅在用户真要装时单文件下载，绝不整站抓取）。',
    '     **未接入**：Freesound（需用户自己的 Key）、OpenGameArt（授权混杂，含禁商用 CC-BY-NC）。',
    '  ①-b 本地音效生成（库里没有才用，零额度但要用户自己装模型）：`/game-sfx`（`node "<插件目录>/src/game-sfx.mjs"`）。',
    '     🛡️ **绝不自动下载模型**（权重 5.3GB + 依赖 3GB）：先 `check`，硬件不够就停下并回退 CC0 库；',
    '     用户同意部署才把 `guide` 给他自己跑，之后 `verify` / `deps --yes` / `doctor`。',
    '     `gen "<英文描述>" --project <项目目录>` 才写入 `assets/audio/sfx/`；返回 `model_missing` / `venv_missing` / `hardware_insufficient` 时如实转达，**不重试、不替他下载**。',
    '  ② 完整 BGM（用户说「要背景音乐」走这条，全程在对话里完成，不指路设置页）：`/game-bgm <中文风格描述>`。',
    '     - 未登录时**你直接跑** `node "<插件目录>/src/game-bgm-web.mjs" login`（弹浏览器让用户登一次，之后自动）；',
    '       换号 / 登出用 `/game-bgm logout` 再 login；多账号：`pool add --id <名>` → `login --account <名>`，`pool list` / `ban` / `unban`。',
    '       生成时不要手挑账号（自动轮询），报告结果时说明用了哪个账号；查额度用 `/game-bgm credits`。',
    '     - 站点自动选 minimax.cn / minimax.io；**提示词必须中文**，优先套内置场景模板（战斗/BOSS/胜利/失败/主菜单/探索/紧张/悲伤/商店/升级），',
    '       也可先读项目文档（GAME_RULES.md 等）推断要哪些场景。',
    '     - **决定有没有人声的是站点那个「纯音乐」开关，不是提示词**：默认开、插件会设好并校验，设不上直接中止报 `instrumental_unset`（不花额度）；',
    '       用户明确要人声才加 `--lyrics`。',
    '     - 下载后 `node "<插件目录>/src/game-audio.mjs" import --in <下载目录> --project <项目目录> --kind bgm --to wav --latest` 导入并补 `.meta`，',
    '       然后**告诉用户文件在哪**，并提示可点右下角 🎵 挂件试听 / 拖波形裁剪 / 一键导入（纯本地零额度）。网页结构变了拿不到文件就如实报告，让他手动下载后 import。',
    '  ③ 音频转格式 / 压缩（本地 ffmpeg，零成本）：`node "<插件目录>/src/game-audio-convert.mjs" --in <源> --out <目标> '
      + '[--to wav|mp3|ogg|flac] [--mono] [--rate 44100] [--normalize] [--trim] [--fade-in 0.1] [--fade-out 0.2] [--loop 8]`，'
      + '也可直接说需求（`/game-audio-convert` 同义）。缺 ffmpeg 就如实说。',
    '**诚实限制（必须如实告知）**：Kenney 音乐包只有 1~3 秒短 jingle，没有可无缝循环的完整 BGM；完整 BGM 得用用户的 MiniMax 账号走网页',
    '（官方自 2026-08-20 起不再对新用户开放音乐 API，返回 410 —— 不是接口故障，别反复重试）；自部署 MiniMax-Music3 要 24GB+ 显存，别推荐。',
    '网页也拿不到满意结果时给选项（短 jingle 凑 / 找 CC0 曲目 / 由用户决定是否动用 Maker 内置额度），绝不擅自调用消耗额度的工具。',
    '',
    '**TapTap Maker 链路专属（只在项目确实是 Maker 工程时适用）**：',
    '- 初始化/安装只需在用户确认后做两步：`npx -y @taptap/maker install --ide codex,cursor,claude`，再在空白目录 `npx -y @taptap/maker init`（等价斜杠命令 `/taptap-setup`）。',
    '- 用户用中文说“安装/初始化/搭建 TapTap Maker”时不必让他记命令，直接给出这两步并说明风险（联网 + 装包），确认后再执行。',
    '- 其它引擎不适用这两条：Godot / Unity / Unreal / 网页项目直接按各自 skill 的工程结构走。',
    '',
    `**插件目录**：\`${pluginDir}\`——上面所有 \`<插件目录>\` 都指这个真实路径，`,
    '调 CLI 时直接把它拼进命令（PowerShell 里路径加引号），不要让用户自己去猜路径。',
  ].join('\n')
}
