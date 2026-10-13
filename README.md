# dsh-taptap-maker-dev

[English](#english) | 中文

为 **TapTap 制造（Maker）** 本地开发而生的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：
守住「不花冤枉钱」的额度红线，接入可更新的游戏开发 skills，并提供**自建的图片 / 音效 / BGM 素材通道**——
全部走你自己的 Key 或 CC0 素材库，不消耗任何 Maker MCP 内置额度。

## 你会得到什么

| 能力 | 说明 |
|---|---|
| **额度红线** | 注入系统守则：非你在对话中明确要求，禁止调用 12 个消耗 Maker 额度的生成工具。设置页有开关，关闭需二次确认，**即时生效无需重启** |
| **自定义生图** | OpenAI 兼容 `/images/generations`。填 Base URL / Key / Model，支持「获取模型」自动列出端点可用模型。尺寸按需传，支持透明底 + 高质量缩小做图标 |
| **CC0 音效库** | Kenney 九个包共 **706 个音频**（CC0，可商用免署名），首次使用自动下载；本地没有时回落到 Mixkit / 小森平 / 効果音ラボ |
| **MiniMax 音乐** | 用你自己的 MiniMax Key 生成完整 BGM（端点固定，只填 Key 与模型） |
| **音频转换** | ffmpeg 批量转格式 / 压缩 / 响度归一 / 去静音 / 淡入淡出 / 短音拼循环 |
| **可更新 skills** | 内置游戏开发 skills + 周期更新检测；设置页可勾选禁用不需要的 |
| **初始化引导** | 直接用中文说「帮我初始化 taptap maker」即可触发，不必记斜杠命令 |

## 安装

```sh
dsh plugin --profile <profile> add dsh-taptap-maker-dev
```

或手动：把仓库克隆到插件目录，在 profile 的 `package.json` 加上依赖，重启 DSH。

> ⚠️ 本插件必须装在 **Maker 工作区之外**。所有持久化（含 API Key）写在 `$DSH_HOME/taptap-maker-dev/` 下。
> 原因：TapTap Maker 运行时会**自动把整个工作区提交并推送**，明文 Key 一旦落进工作区就会泄露。

## 配置

设置 → **TapTap Maker** 页，直接填并保存（存到 `$DSH_HOME/taptap-maker-dev/`，不进任何 Maker 工作区）：

- **额度红线** — 开关，关之前会弹确认
- **自定义生图** — Base URL / Key / Model（「获取模型」按钮自动拉取）/ 缺省尺寸
- **MiniMax 音乐** — Key / 模型 / 格式
- **CC0 音效库** — 状态、搜索、「更新库」
- **小资源图标** — 出图 + 缩小的最佳实践
- **Skill 管理** — 勾选禁用不需要的 skill，即时生效

## 命令行

```sh
# 生图（尺寸按需，支持透明底 + 缩小）
node <plugin-dir>/src/taptap-image.mjs --prompt "蓝色盾牌图标" --out icon.png --transparent --downscale 128x128

# 音效：搜索 / 安装 / 查看来源
node <plugin-dir>/src/taptap-audio.mjs search "金币音效"
node <plugin-dir>/src/taptap-audio.mjs add "金币音效" --project <maker-project> --out coin.wav
node <plugin-dir>/src/taptap-audio.mjs sources

# BGM（用你自己的 MiniMax Key）
node <plugin-dir>/src/taptap-music.mjs --prompt "史诗管弦战斗音乐" --out bgm.mp3 --instrumental

# 音频转换（需要 ffmpeg）
node <plugin-dir>/src/taptap-audio-convert.mjs --in sfx --out out --to wav --mono --rate 44100 --normalize

# skills 更新
node <plugin-dir>/src/taptap-skills-update.mjs
```

对话里也可直接用斜杠命令：`/taptap-image`、`/taptap-audio`、`/taptap-music`、`/taptap-audio-convert`、`/taptap-skills`、`/taptap-setup`。

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

1. **没有可无缝循环的完整 BGM**。Kenney 音乐包只有 1~3 秒短 jingle。完整 BGM 要走你的 MiniMax Key。
2. **MiniMax 音乐接口可能对你不可用**。厂商文档公示：自 2026-08-20 起付费音乐接口不再面向新用户开放，三个 `*-free` 模型已停服。历史付费 / M Plan 用户可继续用。失败时错误原文会如实返回，不会被吞掉。
3. **効果音ラボ 的 robots.txt 禁止 AI 爬虫抓 mp3**。它的授权允许你把音效嵌进有偿游戏，但本插件只在你要装**某一个**文件时才下载它，串行 + 限速 + 遇错退避，**绝不整站抓取**。
4. **设置页的保存依赖宿主 web 服务**（`webServer`）。若你的 DSH 组合没启用，卡片会提示改用命令，不会白屏。
5. **生图 / 音乐用的是你自己的 Key**，账单在你那边；本插件不代付、不代理、不上传你的 Key 到任何第三方。

## 关于「额度红线」

它守的是这 12 个消耗 Maker MCP 内置额度的工具：
`generate_image`、`batch_generate_images`、`edit_image`、`create_video_task`、`query_video_task`、
`text_to_music`、`text_to_sound_effect`、`batch_sound_effects`、`audition_voices_for_character`、
`confirm_character_voice`、`text_to_dialogue`、`create_3d_asset`。

只读 / 状态 / 构建 / 反馈 / LSP 类工具不受限。

## 隐私

- API Key 只写进 `$DSH_HOME/taptap-maker-dev/{image,music}.json`，**绝不进入会自动提交的 Maker 工作区**。
- 本插件不联网上报任何遥测；联网只发生在你主动下载素材或调用你自己的生图 / 音乐端点时。
- 发布前可运行 `node scripts/sanitize-for-release.mjs` 清掉本机路径与密钥残留。

---

## English

A DeepSeek Harness plugin for local **TapTap Maker** game development: enforces a
"don't spend the user's credits" red line, ships updatable game-dev skills, and
provides **self-hosted image / SFX / BGM lanes** — all via your own API keys or
CC0 libraries, never consuming Maker MCP built-in quota.

Highlights: a live-togglable credit red line, an OpenAI-compatible image lane with
model auto-discovery, a 706-file CC0 Kenney audio library with fallbacks to
Mixkit / Taira Komori / 効果音ラボ, MiniMax background music on your own key,
ffmpeg-based audio conversion, and checkbox skill management — all configurable
from the Settings page without hand-editing JSON.

See the tables above for verified licenses, and read the **honest limitations**:
there is **no seamless looping BGM** in the CC0 library, the MiniMax music
endpoint may be unavailable to new users per vendor notice, and 効果音ラボ's
robots.txt restricts AI bulk fetching (we fetch one file per install,
sequentially, and never crawl).

## License

MIT. This covers the plugin code only — each downloaded asset carries its own
license (documented above), and you are responsible for complying with those.
