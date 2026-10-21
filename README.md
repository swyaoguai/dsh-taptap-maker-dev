# dsh-taptap-maker-dev

[English](#english) | 中文

为 **TapTap 制造（Maker）** 本地开发而生的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：
守住「不花冤枉钱」的额度红线，接入可更新的游戏开发 skills，并提供**自建的图片 / 音效 / BGM 素材通道**——
全部走你自己的 Key 或 CC0 素材库，不消耗任何 Maker MCP 内置额度。

## 你会得到什么

| 能力 | 说明 |
|---|---|
| **额度红线** | 注入系统守则：非你在对话中明确要求，禁止调用 12 个消耗 Maker 额度的生成工具。设置页有开关，关闭需二次确认，**即时生效无需重启** |
| **ChatGPT 网页生图（首选）** | 走你自己的 ChatGPT 账号在网页里出图（免费账号即可）。登录一次，之后全自动；支持**多账号轮询**，一个触配额自动换下一个 |
| **中转站生图（回退）** | OpenAI 兼容 `/images/generations`。填 Base URL / Key / Model，支持「获取模型」自动列出可用模型。尺寸按需传，支持高质量缩小做图标 |
| **CC0 音效库** | Kenney 九个包共 **706 个音频**（CC0，可商用免署名），首次使用自动下载；本地没有时回落到 Mixkit / 小森平 / 効果音ラボ |
| **完整 BGM** | 自动生成提示词 + 打开 MiniMax Audio 网页；下载后**自动导入**（转格式 + 装进 `assets/audio/bgm/` + 生成 `.meta`） |
| **BGM 工作台挂件** | 主界面输入框旁的 🎵 挂件：**试听**刚生成的 BGM、**拖波形裁剪**选区间（可加淡入淡出防爆音）、**一键导入**项目；生成完自动亮红点提醒 |
| **音频转换** | ffmpeg 批量转格式 / 压缩 / 响度归一 / 去静音 / 淡入淡出 / 短音拼循环 |
| **视频动作帧** | 视频模型按**首尾帧**出一段动作 → 精确时间点**抽帧** → **本地抠像**（绿/蓝/品红幕，带逐帧自检）→ 对齐合成透明序列帧 → 一键导入 Maker（`.meta` + `seq.json` + Lua 切图）。只有出视频那一步花钱，抽帧/抠像/合成可无限重调 |
| **视频三后端** | MiniMax 官方（订阅 Key / 按量 Key 自动识别）/ **视频中转站**（OpenAI 兼容 / MiniMax 协议 / 自定义路径映射）/ **自选本地视频**（零额度）。`auto` 按可用性挑，也可按作业指定 |
| **分组式设置页** | 十几张卡按「生成通道 / 音频素材 / 治理与工具 / 怎么用」四组收拢，顶部一条通道状态总览（绿点=现在能用），不用再在长页面里翻找 |
| **可更新 skills** | 内置游戏开发 skills + 周期更新检测；设置页可勾选禁用不需要的 |
| **初始化引导** | 直接用中文说「帮我初始化 taptap maker」即可触发，不必记斜杠命令 |

## 视频动作帧（视频 → 序列帧素材）

手里只有一张静帧、想让角色**动起来**，这条链路就是干这个的：

```sh
/taptap-video doctor                            # 自检 ffmpeg / Key / 站点 / 有没有视频额度
/taptap-video new 剑士行走
/taptap-video first ./refs/swordsman.png        # 首帧（绿幕全身图最理想）
/taptap-video last  ./refs/swordsman_end.png    # 尾帧可选（H3 / Hailuo-02 才支持）
/taptap-video prompt 角色原地走三步，全身入镜，相机固定，绿幕背景
/taptap-video run                               # 唯一花钱的一步：提交视频
/taptap-video poll                              # 1~6 分钟，可反复调；重启后也能接着查
/taptap-video frames --count 12 --arrange loop  # 抽帧（本地）
/taptap-video key --chroma auto --tol 40        # 抠像（本地，带逐帧自检报告）
/taptap-video sheet --cell 256                  # 对齐合成整图（本地）
/taptap-video import ../my-game --fps 12        # 导入 Maker
```

零额度路径（没有视频额度时）：

```sh
/taptap-video use ./downloaded.mp4              # 挂本地视频（MiniMax Code 签到积分出的片也行）
/taptap-video frames && /taptap-video key && /taptap-video sheet
```

设计上的几个取舍：

- **抽帧排法可选**：`uniform`（等分取中点，**首尾都不碰** —— 第 0 帧往往是还没动的静帧）、
  `first-last`（首尾帧模式想让两张图都算数）、`loop`（行走/跑步/待机要无缝循环）。
- **抠像主判据是四边洪水填充**，不是绿色优势值 —— 视频模型常把纯色背景重新打光成渐变，
  只认绿色在那类帧上会整片失效。调色板只取背景主色簇，角色贴边时不会被顺着身体吃进去。
- **逐帧自检**：每帧给背景占比与「可信」标记。主体只占画面一小块时占比 > 95%、
  标记不可信是**正确结论**，不是 bug；真素材主体一般占 15%~50%。
- **对齐用同一包围盒**：所有帧共用一个 alpha 包围盒、贴底放在同一基线，上下起伏不会飘。
  包围盒必须在**抠完的帧**上算 —— 在原帧上算等于没裁，主体会被缩成一点。
- **只把成品写进 `assets/`**：中间的视频与原始帧留在作业目录
  （`<项目>/sucai/video/<作业名>-<id>/`），因为 Maker 运行时会给 `assets/` 下任何新文件
  补 `.meta` 并打进构建 —— `sucai/` 整棵是自忽略的，放中间产物正合适。

### 三个后端（与生图中转站同一套思路）

| 后端 | 怎么配 | 计费 | 适合 |
|---|---|---|---|
| **MiniMax 官方** | 设置页填 Key（订阅 `sk-cp-…` 或按量 `sk-api-…`），或直接复用本机 `mmx` 登录态 | 套餐额度 / 账户余额 | 有 Explore+ 档或愿意按量付费 |
| **视频中转站** | 设置页填 Base URL / Key / 模型；三种协议（OpenAI 兼容 / MiniMax 协议 / 自定义路径映射） | 你的中转站 | 官方额度用完、或中转站更便宜 |
| **自选本地视频** | `/taptap-video use <mp4>` | **零额度** | MiniMax Code 签到积分生成的、录屏、别人的素材 |

`auto` 按**设置页里排的顺序**选第一条「开着 + 配好了 + 不是本地文件」的通道（默认顺序即上表顺序）。
你可以在设置页「生成通道优先级」里拖拽调序、逐条开关，并决定**额度不足时要不要自动换下一条**
（默认关；打开后可能在你不知情的情况下动用付费通道）。也可以按作业显式指定：
`/taptap-video backend relay|minimax|local`（显式指定时不回退）。命令行改顺序：
`/taptap-video lanes --order minimax,relay --off local --fallback on`。

### 🚫 模型不会被自动替换（视频按秒计费）

**你在设置页「MiniMax」里选了哪个模型，`/taptap-video` 就用哪个，一个字都不会改。**
这条是硬约束，不是建议：

- 新建作业**继承**你设置的模型（以前会悄悄退回内置的 `MiniMax-H3`）；
- 模型与首尾帧不兼容、或模型为空时，**直接报错并停下**，绝不「顺手挑一个能用的」；
- 报错会给出你自己换的命令（`/taptap-video set --model <模型名>`）和替代方案
  （如 `/taptap-video last --clear` 清掉尾帧），但**换不换由你决定**。

给 AI 助手的同一条规定：即使它认为「换个模型更合适」，也只能停下来把情况讲清楚并
询问你，不能替你改 —— 视频按秒计费，替你选模型就是替你决定花多少钱。

中转站的「OpenAI 兼容」协议只实现**公共约定**，不绑定任何一家：

| 项 | 实现 |
|---|---|
| Base URL | 保留 `/v1`（只剥掉用户多粘的 `/videos`、`/videos/{id}`） |
| 素材 | 本机图片先上传换公网 `url`；上传路径由你自己填（留空则要求直接传公网 URL） |
| 参考素材字段 | 可选两种形态：`metadata.mode` + `first_frame_url` / `last_frame_url`，或 `input_reference` 数组 |
| 画幅 | `metadata.ratio`；全角 `16：9`、`1920x1080`、`9/16` 会自动纠正成 `16:9` |
| 清晰度 | 默认不下发 `size`（很多型号自带清晰度档位） |
| 幂等 | 每个任务带 `Idempotency-Key`（UUID） |
| 状态 | `completed` + `delivery_status=ready` 才算完成；`delivering` 继续等 |
| 下载 | 带 Bearer 下 `/content`，按文件头校验容器；JSON/HTML 不会被当成片 |
| 过期 | `download_expired` 直接报「需要重新生成」，不空转轮询 |

**不内置**任何型号名、价格、能力表（时长范围 / 画幅支持 / 是否支持首尾帧）——
各家中转站不一样，写死一家会误导其他家。型号列表用设置页「获取模型」从你自己的
`/models` 拉，或者手填；超范围时平台返回的 400 原文会直接回显。

各家协议不一样时切到「自定义」，填提交/查询路径与响应字段路径即可 ——
报错会明确说「哪个字段没取到」，不会只给一句「失败」。

### 额度与计费（实情）

| Key / 套餐 | 能否出视频 |
|---|---|
| M Plan **Go**（最低档） | ❌ 官方明确不含视频模型，调用返回 `1008 insufficient balance` / HTTP 402 |
| M Plan **Explore / Build** | ✅ 含 H3，视频只受周窗口限制 |
| 积分包（¥7 / 1000 积分） | ✅ 支持 H3，套餐额度先用、超出扣积分 |
| 按量计费 Key（`sk-api-…`） | ✅ H3 768P ≈ ¥0.5/秒、2K ≈ ¥0.8/秒，4 秒 ≈ ¥2 |

设置页会**自动识别 Key 类型**并说清额度从哪扣，不用你自己判断该填哪一种 ——
两种 Key 打的是同一批接口，区别只在计费来源。

> ⚠️ **别只看前缀判断订阅**（2026-10-21 修）。MiniMax 的 Key 至少有三种形态：
> `sk-cp-…`（订阅）、`sk-api-…`（按量）、以及**控制台签发的 JWT**（`eyJ…`，payload 里带
> `TokenType`，4 = 订阅）。本机用户的 M Plan 订阅 Key 就是最后这种，之前被插件无条件
> 判成「按量 Key，不走 M Plan 套餐额度」—— 明明有订阅额度却提示得像是没有。
>
> 现在 JWT 会解出 payload 看 `TokenType` 判定；解不出来就说「不确定」并引导跑自检，
> **不会**再断言「你不是订阅」（猜错的代价是让用户白充值一次）。
> 最终以 `/taptap-video doctor` 的实测为准 —— 它打的是 `token_plan/remains`，
> 返回 `status_code: 0` 就是有套餐额度，并会报出「本周剩 85% · 本周期剩 94%」这类数字。

⚠️ **MiniMax Code 每日签到积分 ≠ 开放平台积分包**：签到积分只用于 MiniMax Code 应用内
的多模态创作（30 天有效），不能拿来让本插件通过 API 出片。想白嫖就在 MiniMax Code 里
用签到积分生成视频、下载 mp4，再 `/taptap-video use` 挂进来 —— 抽帧/抠像/合成照样全本地。

## BGM 试听 / 裁剪挂件（主界面）

BGM 生成是「用法」不是「配置」，所以它不在设置页，而是主界面**输入框旁的 🎵 BGM 挂件**：

- `/taptap-bgm` 生成完成后，挂件亮红点并弹出提示条，一键打开试听
- 每条 BGM 可播放（流式加载，可拖进度），选中后看波形、**拖两个手柄选区间**、
  「只听选中段」循环试听、可选**淡入淡出**（0.3s/0.5s，防裁剪点爆音）
- 「✂ 裁剪并导入项目」：ffmpeg 按 `-ss/-t` 精确裁剪 → 转 wav → 写 `.meta` →
  落进当前项目 `assets/audio/bgm/`（不覆盖同名，自动加序号）
- 「原样导入」不裁直接用；全程**本地 + 零额度**（不碰 Maker/MiniMax 配额）
- 挂件每 10 秒轮询下载目录（窗口聚焦时立即刷新），挂载在主界面 `conversation.composer.dock`，
  出错只隐藏自己，绝不影响聊天界面

## 安装

```sh
dsh plugin --profile <profile> add dsh-taptap-maker-dev
```

或手动：把仓库克隆到插件目录，在 profile 的 `package.json` 加上依赖，重启 DSH。

> ⚠️ 本插件必须装在 **Maker 工作区之外**。所有持久化（含 API Key）写在 `$DSH_HOME/taptap-maker-dev/` 下。
> 原因：TapTap Maker 运行时会**自动把整个工作区提交并推送**，明文 Key 一旦落进工作区就会泄露。

## 素材存到哪里（`sucai/`）

在 **Maker 项目目录里**执行生图 / 视频 / BGM 命令时，三类素材统一收在项目下：

```
<项目>/sucai/images/          生图（网页生图与中转站生图都落这里）
<项目>/sucai/video/<作业名>-<id>/   一个视频作业一整个目录
                                 refs/ 参考图 · videos/ 成片 · frames/ 抽帧
                                 keyed/ 抠像结果 · out/ 拼好的序列帧
<项目>/sucai/bgm/            背景音乐
```

- **自动忽略提交**：每个目录自带 `.gitignore`（`*` + `!.gitignore`），Maker 自动
  commit 整个工程时不会把它们推上去。只写自己的目录，**不碰你的根 `.gitignore`**。
- **不在项目里就退回 `$DSH_HOME`**：命令可能在任意目录执行；不做这个判断就会在
  盘符根目录凭空造一个 `sucai/`。
- **目录实时可见**：设置页「生成通道优先级」卡顶部会如实显示三类素材此刻的真实路径。
- **视频作业目录带作业名**（如 `奔跑-v7k2p`），资源管理器里一眼认得出。改名**不会**
  搬目录 —— 已生成的帧和视频都靠相对路径关联，搬了会全部失联。
- **换项目 / 换目录也找得到**：作业位置记在 `$DSH_HOME/taptap-maker-dev/video-index.json`，
  不依赖当前工作目录。
- **老作业自动搬迁**：改造前建在 `$DSH_HOME/…/video-jobs/<id>/` 的作业，在首次
  访问时自动搬到项目下的 `sucai/video/`，已生成的视频和帧不会失联。

## 配置

设置 → **TapTap Maker** 页，直接填并保存（存到 `$DSH_HOME/taptap-maker-dev/`，不进任何 Maker 工作区）：

- **额度红线** — 开关，关之前会弹确认
- **生成通道优先级** — 三条链路（生图 / 视频 / 背景音乐）**共用**一张排序表：
  拖拽或用 ↑↓ 调顺序、每条通道一个启用开关、一个「额度不足时自动换下一条通道」总开关。
  每行同时显示**开关**（要不要用它）、**顺序**（第几顺位）、**就绪状态点**（配好没有）——
  「关着」和「开着但没配」分开显示，因为这两件事的下一步完全不同。
  存到 `$DSH_HOME/taptap-maker-dev/lanes.json`，即时生效。
  - 默认顺序与改造前一致（视频：中转站 → MiniMax → 本地视频；生图：网页 → 中转站），升级后行为不突变。
  - **自动切换默认关闭**：打开后可能在你不知情的情况下动用付费通道。
  - 只有**额度 / 配额 / 限流**类失败才换通道；参数写错这类问题换了也一样错，不会白跑一轮。
  - 「自选本地视频」参与排序但**不会**被自动回退选中 —— 它需要你手动挑文件，不该被悄悄代入。
  - 所有通道被全关时系统会自动保留一条，避免把自己锁死。
- **ChatGPT 生图（首选）** — **总开关**（关掉后整条通道停用，模型改走中转站）+ 账号列表（主账号常驻，
  退出后可再登；「+ 添加账号」一步完成"建条目 + 打开登录"）+ 多账号轮询开关
  + **图片下载目录**（默认跟随项目 `<项目>/sucai/images`，可自定义，支持 `{project}` / `{home}`）
- **中转站（回退）** — Base URL / Key / Model（「获取模型」按钮自动拉取）/ 缺省尺寸
- **完整 BGM** — 填风格描述 → 生成提示词 → 一键打开网页 → 下载后自动导入
- **BGM 账号** — 账号列表（主账号常驻，退出后可再登）+ 「+ 添加账号」一步添加并登录
  + 查额度 / 换号 + **额度用完自动轮换**（每个账号独立浏览器 profile）
- **CC0 音效库** — 状态、搜索、「更新库」
- **小资源图标** — 出图 + 缩小的最佳实践
- **Skill 管理** — 勾选禁用不需要的 skill，即时生效

## 命令行

```sh
# 视频通道：查看 / 调整顺序、开关、额度不足是否自动换
/taptap-video lanes
/taptap-video lanes --order minimax,relay --off local --fallback on

# 生图首选：ChatGPT 网页（首次登录一次）
node <plugin-dir>/src/taptap-gpt.mjs login
node <plugin-dir>/src/taptap-gpt.mjs gen --prompt "蓝色盾牌图标，扁平，居中留白" --out icon.png --downscale 128x128

# 出图慢时：把「已经生成好但没下到」的图抓回来（不重新生成，省额度）
node <plugin-dir>/src/taptap-gpt.mjs pending   # 有没有待抓取的对话
node <plugin-dir>/src/taptap-gpt.mjs grab      # 抓 pending 那个对话
node <plugin-dir>/src/taptap-gpt.mjs grab --url https://chatgpt.com/c/xxxx

# 网页生图总开关（关掉后改走中转站）
node <plugin-dir>/src/taptap-gpt.mjs lane status
node <plugin-dir>/src/taptap-gpt.mjs lane off

# 图片存放位置：默认跟随当前项目（<项目>/sucai/images），也可自定义
node <plugin-dir>/src/taptap-gpt.mjs dir                 # 看当前解析结果
node <plugin-dir>/src/taptap-gpt.mjs dir --set "D:\my-images"
node <plugin-dir>/src/taptap-gpt.mjs dir --set "{project}/imgs"
node <plugin-dir>/src/taptap-gpt.mjs dir --reset         # 恢复跟随项目

# 账号轮询：添加账号 → 各登录一次 → 之后自动轮换
node <plugin-dir>/src/taptap-gpt.mjs pool add --id a2 --label "小号"
node <plugin-dir>/src/taptap-gpt.mjs login --account a2
node <plugin-dir>/src/taptap-gpt.mjs pool list          # 看状态
node <plugin-dir>/src/taptap-gpt.mjs pool unban --id a2 # 恢复冷却账号

# 生图回退：中转站（尺寸按需，支持透明底 + 缩小）
node <plugin-dir>/src/taptap-image.mjs --prompt "蓝色盾牌图标" --out icon.png --transparent --downscale 128x128

# BGM 账号池：添加账号 → 各登录一次 → 额度用完自动轮换
node <plugin-dir>/src/taptap-bgm-web.mjs login                      # 主账号
node <plugin-dir>/src/taptap-bgm-web.mjs pool add --id b2 --label "小号"
node <plugin-dir>/src/taptap-bgm-web.mjs login --account b2
node <plugin-dir>/src/taptap-bgm-web.mjs pool list                  # 看状态
node <plugin-dir>/src/taptap-bgm-web.mjs gen --prompt "史诗管弦战斗音乐"  # 自动选可用账号

# 音效：搜索 / 安装 / 查看来源
node <plugin-dir>/src/taptap-audio.mjs search "金币音效"
node <plugin-dir>/src/taptap-audio.mjs add "金币音效" --project <maker-project> --out coin.wav
node <plugin-dir>/src/taptap-audio.mjs sources

# BGM：生成提示词 + 打开网页（对话里用 /taptap-bgm 即可）
/taptap-bgm 史诗管弦战斗音乐，紧张激烈

# 网页下载后，自动导入项目（转格式 + 装进 bgm + 生成 meta）
node <plugin-dir>/src/taptap-audio.mjs import --in "C:\Users\<你>\Downloads" \
  --project <maker-project> --kind bgm --to wav --latest

# 音频转换（需要 ffmpeg）
node <plugin-dir>/src/taptap-audio-convert.mjs --in sfx --out out --to wav --mono --rate 44100 --normalize

# skills 更新
node <plugin-dir>/src/taptap-skills-update.mjs
```

对话里也可直接用斜杠命令：`/taptap-image`、`/taptap-audio`、`/taptap-bgm`、
`/taptap-audio-convert`、`/taptap-skills`、`/taptap-setup`。

## 素材来源与授权（重要）

所有来源都经过**逐个核实官方授权条款**——「免费」不等于「可商用」：

| 来源 | 授权 | 自动获取 |
|---|---|---|
| **Kenney** | **CC0** — 可商用、可修改、无需署名 | ✅ 整包下载 |
| **Mixkit** | Mixkit Free License — 可商用、无需署名 | ⚠️ 索引（安装时单文件下载） |
| **小森平** | 中文页原话：**商业利用、加工、应用或工业产品的使用也可**；禁把音效本身再贩卖 | ✅ 单文件按需 |
| **効果音ラボ** | FAQ 原话：**商用無料、料金発生なし、報告不要、クレジット表記不要**，明写可嵌入游戏有偿销售；禁再配布 | ✅ 单文件按需 |

**未接入（有原因）**：

- **Freesound** — 需要用户自己的 API Key（实测裸请求 401）
- **OpenGameArt** — 授权混杂，含 **CC-BY-NC 等禁止商用** 的协议

## 诚实限制

使用前请读完这几条，我们不假装它们不存在：

1. **没有可无缝循环的完整 BGM**。Kenney 音乐包只有 1~3 秒短 jingle。完整 BGM 要走网页版生成。
2. **完整 BGM 无法全自动**。MiniMax 音乐 API 对新用户账号**直接返回 HTTP 410**（实测：真 key 调 `music-3.0`/`music-2.6`/`music-cover` 全 410，假 key 才 200/1004）；其网页版是需登录的单页应用、没有公开 API（实测 `/api/music` 返回 HTML 页面），脚本无法代你生成/下载。
   所以插件能自动的只有**前后两段**：**生成提示词 + 打开网页**，以及**下载后自动导入项目**。中间「点生成 + 下载」必须你亲手做。不要反复重试 API，也不要据此判断接口故障。
3. **効果音ラボ 的 robots.txt 禁止 AI 爬虫抓 mp3**。它的授权允许你把音效嵌进有偿游戏，但本插件只在你要装**某一个**文件时才下载它，串行 + 限速 + 遇错退避，**绝不整站抓取**。
4. **设置页的保存依赖宿主 web 服务**（`webServer`）。若你的 DSH 组合没启用，卡片会提示改用命令，不会白屏。
5. **生图 / 音乐用的是你自己的 Key**，账单在你那边；本插件不代付、不代理、不上传你的 Key 到任何第三方。
6. **ChatGPT 网页生图依赖界面选择器**。OpenAI 改版频繁，脚本可能失效——失效时它会如实报告卡在第几步（`no_composer` / `no_image` / `download_failed`），不会假装成功；此时回退到中转站。
7. **网页出图要 1~3 分钟**。脚本会等"生成中"结束、只认本次新出现的图再下载（不会把上一轮对话里的旧图当结果）。真等超时会记住那个对话的链接：用 `grab` 抓回来即可，**不要重新生成**（会白烧一次额度）。
7. **多账号轮询违反 OpenAI 服务条款**。轮换账号会绕过单账号配额，可能导致账号被封。这是应要求实现的功能，**风险由你承担**；每个账号用独立浏览器 profile 隔离，且不会自动重试被标记封禁的账号。
8. **视频动作帧有三个诚实限制**：
   - M Plan **Go 档没有视频模型**，订阅 Key 打视频接口会收到 `1008 insufficient balance`。这不是插件 bug，也不是 Key 不对（鉴权是通的）。Explore/Build 档、积分包、按量 Key 才能出片。
   - **M Plan 每日签到积分不能用于 API**：它只在 MiniMax Code 应用内有效。想在插件里出片，只能在 MiniMax Code 里生成后下载视频再导入。
   - 抽帧率的上限由视频本身决定：模型只生成了 4 秒 24fps，就抽不出 60 帧真正不同的画面，**帧数要按动作时长配**，别指望插值。

## 关于「额度红线」

它守的是这 12 个消耗 Maker MCP 内置额度的工具：
`generate_image`、`batch_generate_images`、`edit_image`、`create_video_task`、`query_video_task`、
`text_to_music`、`text_to_sound_effect`、`batch_sound_effects`、`audition_voices_for_character`、
`confirm_character_voice`、`text_to_dialogue`、`create_3d_asset`。

只读 / 状态 / 构建 / 反馈 / LSP 类工具不受限。

## 隐私

- API Key 只写进 `$DSH_HOME/taptap-maker-dev/{image,music,minimax}.json`，**绝不进入会自动提交的 Maker 工作区**。
- 素材落在 `<项目>/sucai/`（图片 / 视频 / BGM 三类分开），每个目录自带 `.gitignore`
  自我忽略，所以即使 Maker 自动提交整个工程也不会把它们推上去。只有最后合成的那一张
  整图会被复制进项目 `assets/image/`。
- 本插件不联网上报任何遥测；联网只发生在你主动下载素材或调用你自己的生图 / 音乐 / 视频端点时。
- 发布前可运行 `node scripts/sanitize-for-release.mjs` 清掉本机路径与密钥残留。

---

## English

A DeepSeek Harness plugin for local **TapTap Maker** game development: enforces a
"don't spend the user's credits" red line, ships updatable game-dev skills, and
provides **self-hosted image / SFX / BGM lanes** — all via your own API keys or
CC0 libraries, never consuming Maker MCP built-in quota.

Highlights: a live-togglable credit red line, ChatGPT web image generation as the
**primary** image lane (login once, with optional multi-account rotation), an
OpenAI-compatible relay lane as the **fallback**, a 706-file CC0 Kenney audio
library with fallbacks to Mixkit / Taira Komori / 効果音ラボ, a BGM helper that
writes the prompt and opens the MiniMax Audio page then auto-imports the
download, ffmpeg-based audio conversion, and checkbox skill management — all
configurable from the Settings page without hand-editing JSON.

See the tables above for verified licenses, and read the **honest limitations**:
there is **no seamless looping BGM** in the CC0 library, and **full BGM cannot be
fully automated** — the MiniMax API answers HTTP 410 to new-user accounts, and
their web page is a login-only SPA with no public API, so "click generate and
download" must be done by hand. The plugin automates the two ends: writing the
prompt and opening the page, then importing the finished file. 効果音ラボ's
robots.txt restricts AI bulk fetching (we fetch one file per install,
sequentially, and never crawl).

## License

MIT. This covers the plugin code only — each downloaded asset carries its own
license (documented above), and you are responsible for complying with those.
