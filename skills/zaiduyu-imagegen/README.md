# zaiduyu-imagegen 3.2

一个专门调用 `https://pai.zaiduyu.top/` 的 Codex Skill。用自然语言描述图片，skill 先列出网站当前支持的模型、每张积分消耗和账号余额，选定模型后再生成图片，保存到本地并返回路径。

本包不含任何账号、密码或 Cookie。安装后需要各自配置自己的账号环境变量。

## 功能

- 生图前先列出网站实时支持的**全部生图模型**、每张积分消耗和当前积分余额，可选模型后再出图。
- 提交前打印本次预检：模型、单张消耗、张数、预计总消耗、当前总积分、预计剩余、调用接口。
- 模型和积分从站点 `/api/config` 与 `/api/credits` 动态读取，站点上新模型或改价后无需改脚本。
- `--model` 支持模型 ID 和显示名，大小写、空格不敏感。
- 自动区分两种调用链：GPT 系列走 Images 接口（站点异步任务接口已下线，脚本默认直接同步请求上游），Gemini / Grok / Z-image 等走 Chat 接口（同步调用）。
- 支持 `1:1`、`3:2`、`2:3`、`4:3`、`3:4`、`4:5`、`5:4`、`16:9`、`9:16` 比例，可用 `--resolution 1K|2K|4K` 放大到高清，或用 `--size 宽x高` 指定像素。
- 默认生成 1 张；需要多张时利用网站 3 并发，超过 3 张自动分批提交，最多 12 张。
- 支持本地图片编辑（换背景、改服装、扩图），**可同时传多张参考图**（最多 16 张，首张为主图）：单图走 `image`、多图走 `image[]` 的 multipart，自定义路由模型自动改用 JSON `images` 数组。
- 支持 `--quality` 质量档位与 `--makeup` 补签，签到前先查状态避免重复提交。
- 支持查询总积分、永久积分、限时积分、到期时间、积分历史和模型用量。
- 支持显式手动签到，普通生图不会自动签到。
- 自动保存到当前工作目录的 `codex生图`，同名文件不覆盖。
- 只使用 Python 标准库，无需安装第三方依赖。

## 环境要求

- 已安装 Codex（桌面版或 CLI）
- Python 3.10 及以上，命令行中 `python` 可用
- 一个 `https://pai.zaiduyu.top/#/auth?ref=3E848A69E0F3` 账号；使用邀请码可以额外增加 50 张生图额度

## 安装

### 第 1 步：放入 skills 目录

把包内的 `zaiduyu-imagegen` 整个文件夹复制到 Codex 的 skills 目录：

| 系统 | 目录 |
|---|---|
| Windows | `C:\Users\<用户名>\.codex\skills\zaiduyu-imagegen` |
| macOS / Linux | `~/.codex/skills/zaiduyu-imagegen` |

完成后的结构：

```text
.codex/skills/zaiduyu-imagegen/
├── SKILL.md
├── README.md
├── CHANGELOG.md
├── agents/
│   └── openai.yaml
└── scripts/
    └── generate.py
```

### 第 2 步：配置账号（只需一次）

脚本不保存凭据，账号密码只从环境变量读取。

还没有账号时，先用浏览器打开注册入口：https://pai.zaiduyu.top/#/auth?ref=3E848A69E0F3（使用邀请码可以额外增加 50 张生图额度）。

Windows PowerShell（永久生效，设置后重开终端）：

```powershell
[Environment]::SetEnvironmentVariable("ZAIDUYU_USER", "你的账号", "User")
[Environment]::SetEnvironmentVariable("ZAIDUYU_PASS", "你的密码", "User")
```

macOS / Linux（写入 `~/.zshrc` 或 `~/.bashrc` 后 `source`）：

```bash
export ZAIDUYU_USER="你的账号"
export ZAIDUYU_PASS="你的密码"
```

验证是否设置成功：

```powershell
$env:ZAIDUYU_USER
```

```bash
echo $ZAIDUYU_USER
```

没有配置就调用时，脚本会直接退出并打印设置方法，不会静默失败。

### 第 3 步：重启 Codex

让 Codex 重新扫描 skills 目录并读取新的环境变量。

## 使用方法

### 先看模型和积分

生图前先跑一次，确定用哪个模型：

```powershell
python "<skill目录>/scripts/generate.py" --models
```

输出示例（价格随网站实时变化，以下仅为格式示意）：

```text
当前总积分：123456
永久积分：120000
限时积分：3456
最近到期：2026-12-31T23:59:59.000Z

生图模型：
- gpt-image-2 | 100 积分/张 | images | image2-生图模型
- grok-imagine-image-2.0 | 100 积分/张 | chat | 马斯克生图模型（快速出图）
- gpt-image-2.5-flare | 150 积分/张 | images | 最新 image-2.5 生图模型（快速）
- Z-image | 200 积分/张 | chat
- gpt-image-2-2k | 300 积分/张 | images
- gemini-3.1-flash-image-preview | 400 积分/张 | chat | Banana 4k
- gpt-image-2-4k | 450 积分/张 | images
- gemini-3.1-flash-image | 500 积分/张 | chat | 大香蕉-4K
- gemini-3-pro-image-preview | 700 积分/张 | chat | Banana pro 4k
```

上面数字全是**占位示例**，不是任何真实账号的余额；实际值以你自己运行 `--models` 的输出为准。模型和价格同样只作格式示意，站点随时会增删模型。

`--models` 只读接口，不生成图片、不消耗积分。列表按「启用状态 → 单张积分 → 模型名」排序，方便先挑便宜的。

### 只看预检，不扣积分

确定模型后可以先预演一次，看这次要花多少：

```powershell
python "<skill目录>/scripts/generate.py" `
  --plan `
  --model "gpt-image-2" `
  --prompt "test" `
  --n 2
```

```text
模型：gpt-image-2
单张消耗：100
图片数量：2
预计总消耗：200
当前总积分：123456
预计剩余：123256
调用接口：Images
```

`--plan` 不提交任何生图请求，零积分消耗。

### 方式 1：直接对话

```text
画一个古风美女，9:16
用 Banana 4k 生成3张黑白风格冷峻人物特写
生成一张赛博朋克城市夜景，16:9，先用便宜模型
```

也可以显式调用：

```text
$zaiduyu-imagegen 画一张日系甜妹头像
```

未指定张数时只生成 1 张；说“生成 3 张”“生成 5 张”“生成 6 张”时按要求执行，超过 3 张会按 3 并发分批（5 张为 3+2，6 张为 3+3）。

### 方式 2：命令行调用

生图：

```powershell
python "<skill目录>/scripts/generate.py" `
  --model "gpt-image-2" `
  --prompt "电影级野生动物摄影，一只老虎在草原上奔跑" `
  --ratio "9:16" `
  --n 3 `
  --description "老虎奔跑"
```

图片编辑（支持多参考图，首张为主图）：

```powershell
python "<skill目录>/scripts/generate.py" `
  --image "C:/图片/原图.png" `
  --prompt "保留人物姿势，将背景改成樱花庭院" `
  --ratio "3:4" `
  --description "樱花换景"

python "<skill目录>/scripts/generate.py" `
  --image "C:/图片/主图.png" "C:/图片/人物.png" `
  --prompt "把图 2 的人物放进主图左侧，光影贴合主图" `
  --resolution "2K" `
  --description "多图合成"
```

查询积分：

```powershell
python "<skill目录>/scripts/generate.py" --balance
```

查询历史：

```powershell
python "<skill目录>/scripts/generate.py" --history --history-limit 10
```

手动签到：

```powershell
python "<skill目录>/scripts/generate.py" --checkin
```

签到只在使用 `--checkin` 时执行，不会随生图自动触发。

## 参数

| 参数 | 说明 | 默认值 |
|---|---|---|
| `--models` | 列出实时生图模型、单张积分和当前余额，不生图 | 无 |
| `--plan` | 只展示所选模型和本次积分预检，不提交生图 | 无 |
| `--model` | 模型 ID 或显示名，如 `gpt-image-2`、`Z-image`、`Banana 4k` | 站点默认模型 |
| `--prompt` | 文生图或编辑提示词 | 无 |
| `--image` | 本地参考图，可多张（最多 16 张，单张 ≤20 MiB）；与 `--prompt` 同用时执行编辑，首张为主图 | 无 |
| `--ratio` | `1:1`、`3:2`、`2:3`、`4:3`、`3:4`、`4:5`、`5:4`、`16:9`、`9:16` | `1:1` |
| `--size` | 固定尺寸，或 `宽x高`（如 `2048x2048`）；与 `--ratio`、`--resolution` 三选一 | 无 |
| `--resolution` | `1K`、`2K`、`4K` 档位，按比例整数倍放大 | 无 |
| `--quality` | `auto`、`low`、`medium`、`high`、`standard`、`hd` | 上游默认 |
| `--makeup` | 补签指定日期（`YYYY-MM-DD`），需站点启用且剩余机会 >0 | 无 |
| `--n` | 生成 1 到 12 张，超过 3 张自动分批 | `1` |
| `--out` | 输出文件路径 | 当前目录 `codex生图` |
| `--description` | 文件名描述，最多 10 个字符 | 由提示词截取 |
| `--timeout` | 单次请求或异步任务总超时秒数 | `300` |
| `--retries` | 临时 HTTP 错误最大重试次数 | `3` |
| `--warn-balance` | 余额提醒阈值 | `0` |
| `--strict-balance` | 预计消耗超过余额时停止提交 | 关闭 |
| `--history-limit` | 每类历史记录显示条数 | `10` |
| `--sync` | 兼容旧参数：站点异步任务接口已下线，脚本本来就默认走同步接口 | 关闭 |
| `--async` | 强制走网站异步任务接口，仅在需要兼容旧行为时使用 | 关闭 |

模型不再写死：`--models` 输出什么就能用什么，缺省时用站点 `defaultModel`，站点没配置时回落 `gpt-image-2`。

## 积分与调用链

- 单张积分来自 `/api/credits` 的 `pricing.models[].creditsPerRequest`，只统计站点标记为生图的模型。
- 预计总消耗 = 单张积分 × 张数；`--plan` 和生图预检都会显示「当前总积分 / 预计剩余」。
- 未标价模型显示「未标价」，不会被当成 0，也不适合 `--strict-balance`。
- 调用接口：
  - `images`：GPT 系列，走 `/api/openai/v1/images/generations`，脚本默认直接同步请求上游；旧异步任务接口（`/api/image-jobs`）站点已下线，仅在显式传 `--async` 时才尝试，失败会自动回退同步。
  - `chat`：Gemini / Grok / Z-image 等，走 Chat 多模态接口，同步返回，脚本自动识别。

## 比例与尺寸

| 比例 | 默认尺寸 | 1K | 2K | 4K | 常见用途 |
|---|---|---|---|---|---|
| `1:1` | `1024x1024` | `1024x1024` | `2048x2048` | `4096x4096` | 头像、图标、方图 |
| `3:2` | `1536x1024` | `1008x672` | `2016x1344` | `4032x2688` | 横版图片 |
| `2:3` | `1024x1536` | `672x1008` | `1344x2016` | `2688x4032` | 竖版人物 |
| `4:3` | `1280x960` | `1024x768` | `2048x1536` | `4096x3072` | 常规横图 |
| `3:4` | `960x1280` | `768x1024` | `1536x2048` | `3072x4096` | 竖版海报 |
| `4:5` | `1024x1280` | `816x1020` | `1632x2040` | `3264x4080` | 社交竖图 |
| `5:4` | `1280x1024` | `1020x816` | `2040x1632` | `4080x3264` | 社交横图 |
| `16:9` | `1536x864` | `960x540` | `1920x1080` | `3840x2160` | 横版封面、视频画面 |
| `9:16` | `864x1536` | `540x960` | `1080x1920` | `2160x3840` | 手机壁纸、短视频封面 |

`--resolution` 只是把比例基准尺寸整数倍放大后再作为 `size` 发给站点（前端同款算法），不是独立字段。

## 输出命名

不指定 `--out` 时保存到：

```text
<当前工作目录>/codex生图/<YYMMDD>-<描述>.png
```

例如：

```text
codex生图/260829-古风美女.png
```

生成多张时按顺序编号：

```text
codex生图/260829-古风美女-1.png
codex生图/260829-古风美女-2.png
codex生图/260829-古风美女-3.png
```

同名文件已存在时自动追加 `-2`、`-3` 等序号，不覆盖历史结果。

## 故障处理

- `503 image_capacity_limit`：网站队列繁忙，脚本按 `Retry-After` 或至少等待约 20 秒后有限重试。
- `401 / 403`：登录失败，请确认环境变量中的账号密码，脚本不会盲目重试登录。
- 异步任务接口报 `409`：站点已把生图改为直接请求上游，脚本会自动回退同步接口，一般无需手动干预（详见 `GOTCHAS.md`）。
- 异步任务超时：任务可能仍在网站后台运行，可到网站任务页查看；同步接口耗时更可预期，默认就走同步。
- 积分为 0 或不足：脚本会先提醒；需要阻止提交时使用 `--strict-balance`。
- 缺少环境变量：脚本打印配置方法，不会猜测或保存凭据。
- 终端中文乱码：脚本已强制 UTF-8 输出；若仍异常，可在 PowerShell 执行 `chcp 65001`。

## 生图的坑

完整清单见 [`GOTCHAS.md`](GOTCHAS.md)，先记住最要命的几条：

- **站点异步任务接口已下线**：`/api/image-jobs` 现在返回 `409`（提示改为直接请求上游）。本脚本 3.1 起默认走同步接口，并在异步报错时自动回退同步，别再照旧文档去等异步任务。
- **同步出图慢**：单张 1:1 实测约 60 秒起，命令超时别低于 300 秒。
- **未标价模型别配 `--strict-balance`**：会直接被挡下。
- **生图前先跑 `--models` / `--plan`**：先看模型、单价、余额，再决定用哪个，避免拿高价位模型试错。

## 安全说明

- 本包不含账号、密码、Cookie 或任何个人积分数据。
- 请勿把账号密码写进脚本或文档后再转发他人。
- 每人使用自己注册的账号，避免额度互相消耗。
- **脚本不会交互式询问凭据。** 环境变量缺失时它直接退出并打印配置方法（退出码 1），
  所以全新安装后必须先手动配好环境变量，第一次生图才不会失败。
- **不要把自己的账号密码贴进 AI 对话**，也不要让 AI 代跑配置命令 —— 命令会落进对话记录、
  工具调用日志和本机 audit-log，等于把密码散布到多个日志文件里。请在**自己的终端窗口**执行。
- **Windows 用户级环境变量是明文存储**：`HKCU\Environment` 下为明文 `REG_SZ`，
  不经 DPAPI 加密，同账户下任何进程都可读取。不要在这里放重要密码，也别复用主密码。

## 文件说明

| 文件 | 作用 |
|---|---|
| `SKILL.md` | Codex 触发规则和执行流程 |
| `scripts/generate.py` | 登录、模型目录、积分、签到、任务、生图和编辑实现 |
| `agents/openai.yaml` | Codex 界面展示配置 |
| `README.md` | 安装与使用说明 |
| `CHANGELOG.md` | 版本更新日志 |
| `GOTCHAS.md` | 生图的坑与避坑清单 |
