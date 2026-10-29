---
name: zaiduyu-imagegen
description: 调用 pai.zaiduyu.top 的多模型生图服务。用户提出“生图、画图、画一张、生成图片”或显式调用 $zaiduyu-imagegen 时使用；生图前先列出可用模型、每张积分消耗和当前积分余额，让用户选模型；默认生成单张，多张按网站 3 并发分批；支持比例、分辨率档位（1K/2K/4K）、多参考图编辑（最多 16 张）、积分查询、历史记录、签到和补签。
---

# zaiduyu-imagegen

把用户的自然语言提示词提交到 `https://pai.zaiduyu.top/`，保存图片并在对话中展示。
本 skill 服务这个网站，模型列表和价格都从网站接口实时读取，不要自己写死模型名或积分。

## 凭据

脚本只从环境变量读取凭据，不在 skill 文件中保存账号、密码或 Cookie：

```powershell
[Environment]::SetEnvironmentVariable("ZAIDUYU_USER", "你的账号", "User")
[Environment]::SetEnvironmentVariable("ZAIDUYU_PASS", "你的密码", "User")
```

缺少任一变量时，原样向用户转达脚本的配置提示；绝不打印密码，也不要把密码写入命令、文档或输出文件。

用户还没有账号时，把注册入口发给他：https://pai.zaiduyu.top/#/auth?ref=B7F529987DBF（使用邀请码可以额外增加 50 张生图额度）。只给链接，不要代替用户注册。

### 全新安装时的正确处置（重要）

**脚本不会交互式询问账号密码，也不会主动索取。** 缺凭据时它在登录前就 `SystemExit`，
打印一段中文配置指引并以退出码 `1` 结束。所以**不要等它问** —— 全新安装的机器必然是这个状态。

用户第一次要求生图、而脚本报缺凭据时，按这套走：

1. **默认不要让用户把账号密码贴进对话，也不要主动替用户代跑 `SetEnvironmentVariable`**：
   命令会原样落进对话记录、工具调用日志和本机 `audit-log`，等于把密码写进一堆日志文件。
   **例外**：用户已被明确告知该风险，仍直接下令「帮我改成这个账号」并自行给出明文时，
   按要求执行，但必须做到三点 —— 只回显 SHA256 前 8 位指纹、绝不复述明文、
   跑完立刻提醒「明文已进入日志，建议事后轮换密码」。
2. **让用户在自己的终端窗口里**执行那两条 `[Environment]::SetEnvironmentVariable(...)`，
   密码全程不进对话。或引导他用自己惯用的凭据管理方式。
3. 提醒用户：Windows 的用户级环境变量存在注册表 `HKCU\Environment`，是**明文 REG_SZ**，
   非 DPAPI 加密，同账户下任何进程都能读。这不是高安全存储，敏感账号别复用密码。
4. 配完让用户**重开终端 / 重启 WorkBuddy** 使变量生效，然后由 agent 跑一次 `--models` 验证 ——
   验证只看命令成功与否，agent 无需接触密码本身。
5. 不要把账号、密码、Cookie 或带真实余额的输出写进 skill 目录、记忆文件或回复里。

### 更换账号（重要）

换号 = **改注册表 + 重启宿主**，两步缺一不可：

1. 写 `User` 级 `ZAIDUYU_USER` / `ZAIDUYU_PASS`（覆盖旧值，旧凭据无法从本机恢复）。
2. **重启 WorkBuddy / Codex**。宿主启动时抓的环境快照会**遮蔽**注册表新值，
   不重启的话子进程继承的仍是旧号 —— 实测此时跑 `--models` 返回的还是旧号余额，
   极易误判成「没写进去」。详见 `GOTCHAS.md` 第 12 节。

验证时机：**只在重启后**跑 `--models` 才有意义，顺便 `--balance` 报到新号余额。
当前设计是单账号全局，多号切换每次都要走这两步。

## 生图流程

1. 用户要求生图时，先执行 `--models`，拿到当前可用模型、每张积分消耗和账号积分余额。
2. 用一张简短表格把关键信息给用户，至少包含：模型 ID、单张积分、当前余额（必要时给每个模型的预计剩余）。模型多时按积分从低到高排列，并标注哪些适合快速出图、哪些是高分辨率模型。
3. 让用户选模型，或按用户已有偏好/明示的模型直接选定；用户没指定时用网站默认模型（脚本自身也会回落到 `gpt-image-2`）。
4. 将用户的简短描述扩充为清晰的生图提示词；用户已经给出完整提示词时不要擅自改写语义。
5. 根据用户要求选择比例：`1:1`、`3:2`、`2:3`、`4:3`、`3:4`、`4:5`、`5:4`、`16:9` 或 `9:16`。需要高清时再加 `--resolution 1K|2K|4K`（按比例整数倍放大，例如 `--ratio 16:9 --resolution 4K` → `3840x2160`）。
6. 用户未指定数量时只生成 1 张，不要自行加量。用户明确要求多张时用 `--n` 传入对应张数，最多 12 张。
7. 生图命令带上选定的 `--model`。脚本会在提交前打印本次预检：模型、单张消耗、张数、预计总消耗、当前总积分、预计剩余、调用接口（Images 或 Chat）。把这几行转达给用户，再读脚本打印的每个绝对路径，用绝对路径逐张展示图片。
8. 默认走**同步**生图接口直接请求上游（站点异步任务接口 `/api/image-jobs` 已下线，会返回 409）。`--n` 大于 1 时按网站 3 并发分批，超过 3 张自动分成多批（5 张为 3+2，6 张为 3+3）。Chat 类模型本来就同步。只有用户明确要试旧异步任务时才加 `--async`，它失败会自动回退同步。
9. 脚本遇到临时性 503、429、502 等错误会有限重试；`image_capacity_limit` 会按服务端提示或至少等待约 20 秒后重试。
10. 脚本会在生图前查询余额并在余额低于预检消耗时提醒；只有用户明确要求严格余额保护时才加 `--strict-balance`。

选择模型的建议：

- 先看积分：同样需求优先选积分低的模型，除非用户要高分辨率或指定效果。
- 名称带 `4k` / `2k` 的是高分辨率或高价位版本，单张积分明显高于基础版。
- 模型 ID 和显示名都能传给 `--model`，大小写和空格不敏感，例如 `gpt-image-2`、`Z-image`、`Banana 4k`。
- 未标价的模型会显示「未标价」，不要当成 0 积分，也不要对它使用 `--strict-balance`。

比例和尺寸映射：

| 比例 | 默认尺寸 | 1K 档 | 2K 档 | 4K 档 |
|---|---|---|---|---|
| `1:1` | `1024x1024` | `1024x1024` | `2048x2048` | `4096x4096` |
| `3:2` | `1536x1024` | `1008x672` | `2016x1344` | `4032x2688` |
| `2:3` | `1024x1536` | `672x1008` | `1344x2016` | `2688x4032` |
| `4:3` | `1280x960` | `1024x768` | `2048x1536` | `4096x3072` |
| `3:4` | `960x1280` | `768x1024` | `1536x2048` | `3072x4096` |
| `4:5` | `1024x1280` | `816x1020` | `1632x2040` | `3264x4080` |
| `5:4` | `1280x1024` | `1020x816` | `2040x1632` | `4080x3264` |
| `16:9` | `1536x864` | `960x540` | `1920x1080` | `3840x2160` |
| `9:16` | `864x1536` | `540x960` | `1080x1920` | `2160x3840` |

不带 `--resolution` 时用「默认尺寸」列；`--size` 也可以直接给 `宽x高`（边长 64-8192）。

默认调用示例：

```powershell
python "<skill-dir>/scripts/generate.py" `
  --model "gpt-image-2" `
  --prompt "电影级野生动物摄影，一只孟加拉虎在草原上奔跑" `
  --ratio "9:16" `
  --description "老虎奔跑"
```

输出目录固定为当前工作目录下的 `codex生图`。文件名格式为 `YYMMDD-简短描述.png`，描述最多 10 个字符；多张图片按顺序追加 `-1`、`-2` 等序号。若目标已存在，脚本自动追加序号，绝不覆盖旧图。

## 图片编辑

用户提供本地图片并要求修改时，使用 `--image` 和 `--prompt`。`--image` 可以一次给多张（最多 16 张，单张 ≤20 MiB，合计 ≤64 MiB），**首张是待编辑主图，其余是素材参考图**：

```powershell
# 单图编辑
python "<skill-dir>/scripts/generate.py" `
  --image "C:/图片/原图.png" `
  --prompt "保留人物姿势，将背景改成樱花庭院" `
  --ratio "3:4" `
  --description "樱花换景"

# 多图合成：第 1 张主图 + 人物/道具素材参考
python "<skill-dir>/scripts/generate.py" `
  --image "C:/图片/主图.png" "C:/图片/人物.png" "C:/图片/道具.png" `
  --prompt "把人物 2 放进主图左侧，手持道具 3，光影贴合主图" `
  --resolution "2K" `
  --description "多图合成"
```

路由规则（与网站前端一致，脚本自动判断，无需手动指定）：

- 自定义路由模型（`modelImageRouting` 里 `mode=custom`，如 gemini 系列、nano-banana、grok-imagine）和 `gpt-image-2-2k/4k`、`gpt-image-2.5-flare/sunburst` 走 **JSON `images: [{image_url}]`**，图片以 data URL 内联。
- 其余 Images 模型走 **multipart**：单图字段名 `image`，多图字段名重复 `image[]`。
- 接口不是图片端点（配置成 `chat/completions` 且无自定义路由）时走 Chat 多模态 `messages`，多图就是多条 `image_url`。
- 多图时脚本自动补一段角色说明（图 1 是主图、素材图不得覆盖主图构图与身份），单图不改写用户原话。
- 编辑固定按 `n=1` 并发发起多次请求（网站就是这么做的），每个请求带唯一 `Idempotency-Key`，避免重试导致重复扣费。

编辑同样会先打印预检（模型、单张消耗、预计总消耗、余额、画面尺寸、参考图张数）。

## 账户功能

这些功能必须由用户明确要求时调用，不要在普通生图时自动执行：

```powershell
python "<skill-dir>/scripts/generate.py" --models
python "<skill-dir>/scripts/generate.py" --balance
python "<skill-dir>/scripts/generate.py" --history
python "<skill-dir>/scripts/generate.py" --checkin
python "<skill-dir>/scripts/generate.py" --makeup 2026-10-20
```

- `--models` 列出实时生图模型、每张积分消耗和当前余额，不生成图片、不消耗积分。生图前固定先跑这个。
- `--plan` 只展示所选模型和本次积分预检（模型、单张消耗、张数、预计总消耗、当前积分、预计剩余），不提交任何生图请求。
- `--balance` 显示总积分、永久积分、限时积分和最近到期时间。
  **读余额必须区分两者**：永久积分不是固定地板（曾观察到 7500，2026-10-23 实测降到 2894），
  一律按接口 `permanentBalance` 实时读；签到和兑换码给的都是
  **1 天有效**的限时积分，服务端每天在 UTC 03:00 前后（北京时间 11:00 前后）自动清零，
  类型 `credit_expired`。所以**别按 `balance` 总额规划跨天采购**，限时那部分今天不用就归零。
  见 `GOTCHAS.md` 第 14 节。
- `--history` 输出是 `/api/credits` 全量响应，**含不受 `--history-limit` 约束的定价全表**，
  且那份表里还有非生图模型（deepseek / gpt-5.x / mimo 等），与 `--models` 对不上是正常的。
  实测一次 2.6 万字符级，**不要原样贴进对话**。见 `GOTCHAS.md` 第 15 节。
- `--history` 显示积分交易和模型用量记录，可用 `--history-limit` 限制条数。
- `--checkin` 只执行一次手动签到：先读 `GET /api/checkin` 状态，已签到直接返回，不重复提交。
  签到奖励进的是**限时积分**（实测 `validityDays: 1`，只活 1 天），到期时刻看 `--balance`
  的「最近到期」（值是 UTC，+8 才是北京时间）。**签到分当天就得用掉**，别计入长期额度。
- `--makeup YYYY-MM-DD` 补签：先用 `GET /api/checkin?month=` 校验 `makeupEnabled` 与剩余
  `makeupChances`，已签到的日期直接拦下，不会白耗补签次数。详见 `GOTCHAS.md` 第 13 节。

## 其他参数

- `--model`：模型 ID 或显示名，例如 `gpt-image-2`、`Z-image`、`Banana 4k`；先用 `--models` 查看可用值。
- `--n`：生成数量，默认 `1`，最多 `12`；超过 3 张按网站 3 并发自动分批。
- `--image`：本地参考图，可多张（`--image a.png b.png` 或重复 `--image`），最多 16 张；首张为主图。
- `--ratio`：优先使用比例；不要和 `--size`、`--resolution` 同时传入。
- `--size`：固定尺寸或 `宽x高`（如 `2048x2048`）；与 `--ratio`、`--resolution` 三选一。
- `--resolution`：`1K`/`2K`/`4K` 档位，按比例整数倍放大；未指定比例时按 `1:1`。
- `--quality`：`auto`/`low`/`medium`/`high`/`standard`/`hd`，不传则由上游决定。
- `--makeup`：补签日期（`YYYY-MM-DD`）。
- `--timeout`：默认 300 秒。
- `--retries`：临时 HTTP 错误最大重试次数，默认 3。
- `--warn-balance`：自定义余额提醒阈值。
- `--strict-balance`：预计消耗超过当前积分时不提交生图请求；未标价模型会直接停止。
- `--sync`：兼容旧参数，脚本默认就走同步接口，加不加都一样。
- `--async`：强制走旧异步任务接口，仅在需要兼容旧行为时使用；失败会自动回退同步。

## 注意

- 模型和积分都从站点接口实时读取，不要在文档、脚本或回复里写死某张价格；站点改价后以 `--models` 输出为准。
- 生图前必须展示模型、单张积分、预计总消耗和当前余额；用户没选模型时给出可选清单或按默认模型继续，不要把选型这一步跳过。
- 不要自动签到、自动兑换或自动执行其他账户操作。
- 生成通常需要几十秒到数分钟（实测单张 1:1 同步约 60 秒起），命令执行超时应至少设置为 300 秒；分批生成多张时耗时按批次累加。
- 站点异步任务接口已下线（`/api/image-jobs` 返回 409，提示改为直接请求上游）：本 skill 默认走同步接口，异步报错会自动回退同步，不要照旧等异步任务。
- 未标价模型在 `--models` 里显示「未标价」，不要配 `--strict-balance`。
- **比例只在 Images 链路真正生效**：Chat 链路（grok / gemini / Z-image 等）的站点接口不接受 `size` 参数，脚本只能把比例作为**文字提示**追加到 prompt 末尾，模型可能不遵守（实测 `--ratio "16:9"` 出过 768x1152 竖图）。需要**确定的比例或尺寸**时，必须选 `--models` 里标 `images` 的模型，`--size` 才会真正下发给上游。
- **上游安全策略会拒 IP 形象**：`gpt-image-2` / `gpt-image-2-*` 等 OpenAI 系模型对知名动漫、影视、游戏角色会返回 HTTP 400 `rejected by the upstream safety policy`。**被拒不扣积分**。遇到这个报错直接换 Chat 链路模型（grok / gemini / Z-image）重试，那条链路宽松得多；不要原地重试同一个模型浪费轮次。若既要保比例又要过 IP，选 `gemini-3-pro-image`（`images` 链路，`--models` 里显示未标价，别配 `--strict-balance`）。
- **扩展名按魔数自动纠正**：接口常返回 JPEG，`save_images()` 会嗅探文件头写正确后缀（`.jpg` / `.webp` / `.png`），不再一律存成 `.png`。向用户展示前可先量一次真实尺寸，别把竖图当横图报。
- 多参考图的字段名、张数上限、JSON/multipart 分流见 `GOTCHAS.md` 5.1；分辨率档位怎么换算成 `size` 见 5.2。
- 更多踩坑记录见同目录 `GOTCHAS.md`。
- 失败时向用户转达可读错误，不要盲目重试登录。
- 脚本只使用 Python 标准库，无需额外安装依赖。

## 本机安装说明（WorkBuddy）

- 技能位置：`%USERPROFILE%\.workbuddy\skills\zaiduyu-imagegen`（用户级，全局可用）。
- 凭据已配置在用户环境变量 `ZAIDUYU_USER` / `ZAIDUYU_PASS`，无需重复设置；不要打印或回显密码。
- 非交互环境下 `python` 可能解析到 Microsoft Store 的 WindowsApps 别名。推荐显式使用受管解释器：
  `C:\Users\43833\.workbuddy\binaries\python\versions\3.13.12\python.exe`
- **Windows PowerShell 中文编码**：脚本自身已强制 UTF-8 输出，但 PowerShell 5.1 默认按 GBK 解码子进程输出，会显示成乱码。执行前加一行：
  `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`
- **预检横幅走 stderr**：「模型 / 单张消耗 / 预计总消耗 / 当前总积分 / 预计剩余 / 调用接口」这几行由脚本写到 stderr。PowerShell 会把 stderr 包装成 `NativeCommandError` 报错记录，这是**预期行为，不是命令失败**，照常读取内容即可。
- **输出目录**：本机工作区本身就是 `E:\Codex Work\codex生图`。脚本已做兼容处理——当前工作目录名恰为 `codex生图` 时直接写入当前目录，不会再套一层。若显式指定 `--out`，则以 `--out` 为准。
- 建议命令形态：

  ```powershell
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  & "C:\Users\43833\.workbuddy\binaries\python\versions\3.13.12\python.exe" `
    "$env:USERPROFILE\.workbuddy\skills\zaiduyu-imagegen\scripts\generate.py" `
    --model "gpt-image-2" --prompt "..." --ratio "9:16" --description "老虎奔跑"
  ```

- 生图是同步接口，单张实测 1 分钟起步，命令执行超时必须设到 300 秒以上，不要用默认短超时。
