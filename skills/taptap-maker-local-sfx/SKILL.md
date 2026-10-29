---
name: taptap-maker-local-sfx
description: 用本地 Stable Audio Open 1.0 模型生成游戏音效（零额度、不联网付费），作为 CC0 音效库找不到合适素材时的兜底。模型约 5.3GB 权重**绝不自动下载**——必须先硬件体检、由用户手动下载。触发词：想要一个库里没有的定制音效、"本地生成音效"、"自己跑模型做音效"。
whenToUse: CC0 音效库（taptap-audio）搜不到合适素材、且用户机器有 NVIDIA 显卡（建议 8GB 显存）时的本地音效兜底；普通音效需求一律先用 CC0 库。
---

# taptap-maker-local-sfx — 本地音效生成（Stable Audio Open 1.0）

在自己机器上跑文生音效，**不消耗任何 Maker 内置额度、不需要任何 API Key**。
模型：`stabilityai/stable-audio-open-1.0`（Stability AI Community License：
个人与年营收 < 100 万美元的团队免费商用）。

## 🛡️ 第一红线：绝不自动下载模型

模型权重约 **5.3GB**、依赖（torch CUDA 版）约 **3GB**。用户的机器可能根本没有
独显——所以本 skill 和配套 CLI **永远不会替你下载**：

- 任何一步都先 `check` 体检；结论是「不建议」就**停下**，回退到 CC0 音效库，
  不要劝用户安装。
- `guide` 只**打印**逐条的手动下载命令（断点续传、可反复跑），由用户自己在
  终端执行。agent 不要把整段 curl 逐条代跑，除非用户明确说「帮我下」。
- `deps` 默认也只打印安装命令；加 `--yes` 才真正安装。

## 标准流程（用 pwsh 真正执行，不要只打印指引）

```powershell
$cli = "<插件目录>/src/taptap-sfx.mjs"

# 1) 硬件体检：NVIDIA 显卡 + 建议 8GB 显存；不够就止步于此
node $cli check

# 2) 够格才把下载指引交给用户（约 5.3GB，ModelScope 国内直连镜像）
node $cli guide          # 用户在自己的终端逐条执行 curl.exe ...
node $cli verify         # 全部下完后校验 SHA256（17 个文件）

# 3) 依赖：先看要装什么，用户确认后加 --yes（约 3GB）
node $cli deps
node $cli deps --yes

# 4) 体检确认 torch/CUDA 就绪
node $cli doctor

# 5) 生成（英文提示词！模型只用英文数据训练）
node $cli gen "coin pickup, bright arcade blip" --project <Maker项目目录> -s 3
```

`gen` 带 `--project` 时自动写入 `assets/audio/sfx/` 并补同名 `.meta`（uuid），
Maker 直接可用；不带则落在临时目录，之后用 `/taptap-audio import` 导入。

## 失败码怎么处理（不要盲目重试）

| code | 含义 | 正确动作 |
|---|---|---|
| `hardware_insufficient` | 无独显 / 显存不足 | 停下，回退 CC0 库（`/taptap-audio add`），如实告知 |
| `model_missing` | 权重还没下载 | 把 `guide` 输出交给用户，等用户下完再 `verify` |
| `venv_missing` | 依赖没装 | `deps` 给用户看，确认后 `deps --yes` |
| `gen_failed` | torch 运行期报错 | 转达 stderr 摘要；先 `doctor` 定位，不要连着重跑生成 |

## 提示词经验

- **英文**效果最好（模型是英文数据训练的）：`sword swing whoosh, fast metallic swoosh`。
- 时长用 `-s` 秒（最长 47s；游戏音效一般 0.5-3 秒，`audio_end_in_s` 会钳制）。
- `--steps` 60~200：越高越好越慢；默认 100。8GB 显存实测约 35-55 秒/条（低显存流式模式）。
- `-n 3` 同提示词出 3 个不同 seed 备选，比反复重跑单条省时间。
- 生成后通常需要裁剪/淡入淡出/转 wav 统一：用 `/taptap-audio-convert`
  （`--trim --fade-out 0.1 --normalize`）。

## 与其它链路的边界

- **音效优先级**：CC0 库（taptap-audio）→ 本地生成（本 skill）→ 用户明确同意才动用 Maker 内置额度。
- **BGM 不走这里**：Stable Audio Open 做不出可无缝循环的完整配乐；完整 BGM 走 `/taptap-bgm`。
- 短 jingle 可以拿本 skill 生成（如 3 秒胜利音），但库里大概率已有现成的。
- 环境目录解析顺序：`TAPTAP_SFX_HOME` > 现成安装（如 `D:\stable-audio`）> `%LOCALAPPDATA%\taptap-maker-sfx`。

## 已知坑（实测）

- 显存 < 10GB 会自动开低显存流式模式（组件轮流上 GPU）；关掉吃显存的程序能明显提速。
- `--lowvram` / `--no-lowvram` 可手动覆盖自动判断。
- Windows 上 `python` 可能解析到 Microsoft Store stub；CLI 会逐条 `-c` 验活再采用。
- PowerShell 里 Python 的 stderr 进度条可能显示成 `NativeCommandError`，不是失败，看最终 JSON。
