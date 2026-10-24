---
name: spine-rig
description: 把分离好的人物部件 PNG 自动绑骨、生成 Spine 4.2 骨骼 JSON 与 idle/walk/run/wave/jump/attack 动画预设，并可打包图集、出 HTML 预览；含布局微调回写与 TapTap Maker 落地指引。
whenToUse: 用户说「绑骨 / 骨骼动画 / Spine / 把部件拼成角色 / 做 walk cycle / 让这个角色动起来」，或已有一组身体部件 PNG（头/躯干/四肢）+ 整体参考图，想生成骨骼与动画时。
---

# Spine 绑骨管线（spine-rig）

把一组分离的人物部件 PNG 变成带骨骼、带动画的 Spine 4.2 资产。脚本来自
[GenielabsOpenSource/spine-animation-ai](https://github.com/GenielabsOpenSource/spine-animation-ai)
（Ⓒ GenieLabs，**PolyForm NC 1.0.0 许可，仅限非商业用途**，全文见本目录
`LICENSE-spine-animation-ai`）——已适配 DSH：路径、命令、调用方式全部按本机
Windows/PowerShell + 本插件目录重写，算法未改动。

## 脚本在哪（不需要拷贝、不需要粘贴）

全部在本 skill 目录下（即本文件所在的 `spine-rig\` 目录）的 `scripts\` 子目录，
共 6 个：`position_parts.py`、`build_spine_json.py`、`make_atlas.py`、
`generate_spine_player.py`、`split_character.py`、`reskin_atlas.py`（换皮切回，
本插件补充）。

调用时用「本 skill 目录 + `scripts\`」拼出的绝对路径（skill 的 `source` 就是
本文件的完整路径，取其目录即可）。本机当前插件目录下即：

```powershell
# <skill-dir> = 本 SKILL.md 所在目录；下文 <scripts> = <skill-dir>\scripts
D:\dsh-taptap-maker-dev\skills\spine-rig\scripts\
```

（PowerShell 里路径含空格时记得加引号。）

> 原版 skill 要求「把内嵌脚本先写到 /home/claude/spine-scripts/ 再跑」——那是
> Claude Projects 的机制。**DSH 里不需要**：脚本已经随 skill 落盘，直接调用即可。

## 依赖（只在工作目录跑，不动插件目录）

| 脚本 | 依赖 |
|---|---|
| `build_spine_json.py`、`make_atlas.py`、`generate_spine_player.py` | 仅 Python 3.9+ 标准库 |
| `position_parts.py`（自动摆放） | `opencv-python`、`Pillow`、`numpy` |
| `split_character.py`（整图拆件，可选） | 同上 + `google-generativeai` + `GEMINI_API_KEY` |

检测与安装（**装在用户环境，不要往插件目录装**）：

```powershell
python -c "import cv2, PIL, numpy" 2>$null; if ($LASTEXITCODE -ne 0) {
  python -m pip install opencv-python Pillow numpy
}
```

## 管线总览

```
部件 PNG（+可选整图参考） → position_parts.py 自动摆放 → build_spine_json.py 骨骼+动画
                                → make_atlas.py 图集        → generate_spine_player.py HTML 预览
```

### 第 0 步：准备工作目录与素材约定

**绝不在 Maker 项目 `assets/` 里跑管线**（运行时资源监听器会给任何新文件自动补
`.meta` 并纳入构建——中间产物会污染工程）。用 `<项目>/sucai/spine/<角色名>/` 作为
工作目录（`sucai/` 自带 `.gitignore`），产物确认后再按 `taptap-maker-assets` 的
规范搬进 `assets/`。

部件命名直接决定骨骼映射，**必须用英文连字符命名**（脚本按
`left-upper-arm` 这类模式匹配）：

```
head.png  torso.png  hip.png
left-upper-arm.png  left-lower-arm.png  left-hand.png
right-upper-arm.png right-lower-arm.png right-hand.png
left-upper-leg.png  left-lower-leg.png  left-foot.png
right-upper-leg.png right-lower-leg.png right-foot.png
```

（可以只提供子集——动画预设按「有哪些骨骼」自动跳过缺失项。）

### 第 1 步：自动摆放（有整图参考时）

```powershell
python "<scripts>\position_parts.py" `
  --reference assembled_character.png `
  --parts parts/ `
  --output layout.json `
  --debug debug/
```

- 算法：SIFT + RANSAC 相似变换（对风格化游戏美术更稳），小部件自动回退模板匹配，
  并通过两两遮挡分析推导 z-order（draw order）。
- **必查 `debug\bboxes.png` 与 `debug\comparison.png`**：确认每个部件框对了位置。
  单个部件的 SIFT 匹配可视化在 `debug\sift_<部件名>.jpg`。
- 部件被严重遮挡（如腰带挡住大腿根）时可能摆错——对照参考图手工改 `layout.json`
  里的 `x/y/rotation`，或在下一步的 config 里写 `manual_adjustments`。
- 没有 cv2 时如实报告（见「依赖」），不要假装跑过。

### 第 2 步：生成骨骼 + 动画

先写 config（模板见下），再跑：

```powershell
python "<scripts>\build_spine_json.py" --config config.json --output skeleton.json
```

config.json 模板（骨骼层级按 humanoid 约定）：

```json
{
  "skeleton": { "name": "hero", "width": 400, "height": 600 },
  "bones": [
    { "name": "root" },
    { "name": "hip", "parent": "root", "x": 0, "y": 200, "length": 30 },
    { "name": "torso", "parent": "hip", "length": 120 }
  ],
  "slots": [
    { "name": "torso", "bone": "torso", "attachment": "torso" }
  ],
  "attachments": {
    "torso": { "width": 120, "height": 200, "x": 0, "y": 60 }
  },
  "animations": ["idle", "walk", "run", "wave", "jump", "attack"],
  "custom_animations": {}
}
```

要点：

- **坐标系**：Spine Y 轴向上、原点在角色脚底中心。`spine_x = 像素x - 画布宽/2`，
  `spine_y = 画布高 - 像素y`。骨骼 `x/y` 是**相对父骨骼**的；attachment 的
  `x/y` 是相对所属骨骼。
- **slots 顺序 = 绘制顺序**（第一个在最底层）。
- 动画预设（6 种，全部可循环回起点）：

| 预设 | 时长 | 要点 |
|---|---|---|
| idle | 1.6s 循环 | 髋 ±1.5px 起伏、躯干 ±1.5°、头部反相摇摆 |
| walk | 0.8s 循环 | 对侧手脚摆动、髋部 ±3px 弹跳 |
| run | 0.5s 循环 | 夸张 walk + 8° 前倾 + ±6px 弹跳 |
| wave | 1.2s | 右臂举至 -130°、小臂 ±20° 振荡 |
| jump | 1.0s | 蓄力下蹲 → 起跳 → 滞空 → 落地缓冲 |
| attack | 0.6s | 后拉 → 挥击 → 随势 |

关键帧格式（`curve` 为归一化三次贝塞尔 `[cx1,cy1,cx2,cy2]`，脚本会转成 Spine
4.2 的绝对控制点线格式；`[0.25,0,0.75,1]` = ease-in-out）：

```json
{ "time": 0.0, "angle": 0, "curve": [0.25, 0, 0.75, 1] }
```

### 第 3 步：打包图集

```powershell
python "<scripts>\make_atlas.py" --parts parts/ --output . --name hero
# 产物：hero.png（精灵图集）+ hero.atlas（区域元数据）
```

### 第 4 步：HTML 预览（自包含，本地可开）

```powershell
python "<scripts>\generate_spine_player.py" `
  --skeleton skeleton.json --atlas hero.atlas --atlas-image hero.png `
  --output preview.html --animation idle
```

打开 `preview.html` 即可看动画、切动画、换皮（零额度、纯本地）。给用户看效果
优先用这个，别截图浪费生成额度。

### 第 5 步（可选）：整图拆件

用户只有一张完整角色图时，`split_character.py` 用 Gemini 生成拆解图后自动分割：

```powershell
# 需要 GEMINI_API_KEY（https://aistudio.google.com/app/apikey，免费）
$env:GEMINI_API_KEY = "<key>"
python "<scripts>\split_character.py" character.png --output-dir parts/
```

⚠️ 这是**唯一联网的步骤**（调 Gemini API，走用户自己的 Key，与 Maker 内置额度
无关）。没有 Key 就跳过，让用户手工拆件或用生图通道出部件图。

## 布局微调回写（adjustments）

编辑器/用户手工调完位置后导出的修正格式（完整规范见
`references\adjustment-format.md`）：

```json
{
  "adjustments": {
    "right-arm": {
      "original_offset": { "x": -1.5, "y": 0 },
      "user_offset": { "dx": -29.4, "dy": -84.1, "drot": 0 },
      "final_offset": { "x": -30.9, "y": -84.1 }
    }
  },
  "draw_order": ["right-arm", "left-leg", "...", "head"]
}
```

收到这类 JSON 时：`final_offset = original_offset + user_offset`，直接改
config.json 对应 attachment 的 `x/y`（`drot` 加到骨骼 rotation 或 slot 上），
重跑第 2 步即可；`draw_order` 数组重排 slots 顺序。

## 换皮工作流（图生图 → 切回部件 → 骨骼复用）

参考原仓库 Reskin Studio 的思路：**骨骼和动画是资产里最贵的部分，换风格不该
重新绑骨**。流程是「整图换皮 → 按原包围盒切回 → 复用骨骼」：

```
parts/ ──合成整图──> composite.png ──图生图──> reskin.png
                                                    │ reskin_atlas.py
                                                    ▼
                              parts/（新皮） + hero-reskin.atlas/.png + skeleton.json（原样）
```

**第 R1 步：合成整图**。用 `make_atlas.py` 打包 parts/ 得到的图集就是现成的
「部件都在原位」的整图（或用 position_parts 的 debug/comparison.png）。

**第 R2 步：图生图换皮**（两条通道，都不花 Maker 额度）：

- **通道 A：中转站 `/images/edits`**（本插件 `taptap-image edit`，已支持）：

```powershell
node "<插件目录>\src\taptap-image.mjs" edit `
  --in composite.png `
  --prompt "保持构图与每个部件的位置完全不变，把角色重绘为翡翠绿银色皇家礼服风格，扁平游戏美术" `
  --out reskin.png
```

  走用户配置的中转站（image.json 的 baseURL/Key/model），先 multipart 再回退
  JSON+base64；传输层失败**不自动重试**（可能已扣费）。需要先在设置页配好中转站。

- **通道 B：Gemini Nano Banana**（原仓库同款验证路径，`reskin-character` 思路）：
  需要 `GEMINI_API_KEY`（免费额度即可）。要点是**严格 1:1 像素映射**（pad 到
  支持的宽高比 → 编辑 → 缩回 → 裁回原区域），构图不漂，包围盒才能对上。
  没装 `google-generativeai`/`google-genai` 或没有 Key 就走通道 A，如实说明。

**第 R3 步：切回部件 + 重打包**（本 skill 自带）：

```powershell
python "<scripts>\reskin_atlas.py" `
  --reskin reskin.png --atlas hero.atlas `
  --out-dir reskin1/ --name hero-reskin --keep-skeleton skeleton.json
```

  会把 reskin.png 按原 atlas 区域切开 → 新 `parts/` + 新图集 + 原样拷贝
  `skeleton.json`。**区域超界/全透明的块会打警告**——构图漂移时如实报告，
  让用户重出图，不要硬编成功。

**第 R4 步：预览 + 落地**：用新图集 + 原 skeleton 重新
`generate_spine_player.py` 出预览（动画原样都在）；进 Maker 的路径见下一节。

诚实限制：
- 图生图**必须选保构图的编辑模型**（edits 类）；文生图模型会重新构图，
  切回的部件全是错的。提示词里要显式写「保持构图与部件位置完全不变」。
- 换皮模型的输出分辨率若和输入不一致，先等比缩放回原尺寸再切。
- 多套皮共存：`--prefix skin2-` 防止部件互相覆盖；每套皮一个子目录。

## 落进 TapTap Maker

Spine JSON/atlas/PNG **不能直接丢进 Maker**（UrhoX 没有原生 Spine 运行时）。两条落地路径：

1. **序列帧化（推荐，引擎无感）**：用官方 Spine Web Player 渲染各动画逐帧导出
   （或直接用本插件的 `/taptap-video` 抽帧管线处理预览视频），再按
   `taptap-maker-video-frames` 的规范切图进 `assets/`，游戏里用 AnimatedSprite
   式的序列帧播放。优点：零运行时依赖；缺点：文件体积大于骨骼数据。
2. **骨骼运行时自实现（进阶）**：Maker 有 `AnimationStateMachine` / 骨骼
  （`Bone`）能力（见 `taptap-maker-animation-fsm`）。可把 Spine JSON 的
   bones/slots/animations 转换成 Maker 的骨骼+动画组件装配（解析 JSON →
   Node 层级 → 每骨骼 LogicComponent 驱动关键帧插值），挂点用
   `Bone:GetFinalWorldTransform()`。适合愿意写一层 Lua 适配的项目。

无论哪条：中间产物留在 `sucai/spine/<角色名>/`，**确认后才搬 `assets/`** 并补
同名 `.meta`（详见 `taptap-maker-assets`）。

## 诚实限制

- 被遮挡部件（腰带下的胯、背后的手）自动摆放可能出错——`--debug` 图必查，
  错了就手工修 layout.json，别硬编。
- 非人形骨架（动物、载具）没有现成预设，需要写 custom_animations。
- split_character 依赖 Gemini，Key 无效/网络不通时如实报错，不要重试烧钱。
- **PolyForm NC 许可：本 skill 的脚本仅限非商业用途**。用户做商业游戏时应改用
  自研/其它许可的绑骨方案——这条要主动告知用户。
