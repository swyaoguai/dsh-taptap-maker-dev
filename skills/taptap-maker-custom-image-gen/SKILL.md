---
name: taptap-maker-custom-image-gen
description: 生成 TapTap Maker 游戏图片素材的两条不消耗 Maker 内置额度的通道——首选 ChatGPT 网页生图（含多账号轮询，有 ToS/封号风险），回退为 OpenAI 兼容 /images 中转站；含 CLI 用法、尺寸限制、假 alpha 抠图与 content_policy 退避重试等实测坑。
whenToUse: 需要给游戏生成/补充图片素材（图标、精灵、卡面、UI 元素等），且不应消耗 Maker 内置额度时。
---

# 游戏图片素材：两条通道（都不碰 Maker 内置额度）

## 通道选择

| | 通道 | 何时用 |
|---|---|---|
| **首选** | **ChatGPT 网页生图**（`taptap-gpt`） | 默认走这条。用你自己的 ChatGPT 账号 / 免费额度 |
| **回退** | **中转站**（`taptap-image`，OpenAI 兼容 `/images`） | 网页通道不可用：已关闭、未登录、所有账号都触配额、或网页选择器失效 |

**不要一上来就调中转站。** 也永远不要调 Maker 内置 `generate_image`（消耗额度）。

### ⚠️ 先确认总开关

网页生图有一个**总开关**（设置页「ChatGPT 网页生图」卡右上角，或 `/taptap-gpt lane on|off`）。
开关是 **OFF** 时：`gen` 会直接拒绝执行（返回 `lane_disabled`），应当改走中转站，
而不是反复尝试网页通道，也不要自作主张去改开关状态。

```powershell
node "<plugin>/src/taptap-gpt.mjs" lane status   # 查开关
```

---

## 首选：ChatGPT 网页生图

```powershell
# 首次：登录一次（会开真实浏览器，Google/Apple/手机号/邮箱均可，免费账号即可生图）
node "<plugin>/src/taptap-gpt.mjs" login

# 生成（不给 --out 时自动存到 <项目>/.taptap-images/，跟随项目）
node "<plugin>/src/taptap-gpt.mjs" gen --prompt "一只橙色小猫，扁平矢量风格"
node "<plugin>/src/taptap-gpt.mjs" gen --prompt "蓝色盾牌图标，扁平，居中留白" --out icon.png --downscale 128x128
node "<plugin>/src/taptap-gpt.mjs" status      # 登录状态 + 账号池 + 下载目录
node "<plugin>/src/taptap-gpt.mjs" dir         # 看图片存到哪
```

对话里直接说「生成一个蓝色盾牌图标」即可，模型默认走这条。

### 账号轮询

一个账号触到配额会自动换下一个：

```powershell
node "<plugin>/src/taptap-gpt.mjs" pool add --id a2 --label "小号"
node "<plugin>/src/taptap-gpt.mjs" login --account a2     # 每个账号各登录一次
node "<plugin>/src/taptap-gpt.mjs" pool list              # 看状态：已登录/冷却/封禁
node "<plugin>/src/taptap-gpt.mjs" pool unban --id a2     # 恢复某个冷却/封禁账号
node "<plugin>/src/taptap-gpt.mjs" pool unban             # 不带 id = 恢复全部
```

- 每个账号有**独立浏览器 profile**，一个被封不会污染其他账号。
- 状态：`ok`（可用）/ `cooling`（本次触配额，冷却 6h 后可再用）/ `banned`（人工标记，永不自动选中）。
- **设置页就是账号列表**：主账号那一行常驻（退出登录后行还在，可以再登回去）；
  「+ 添加账号」一步完成"建条目 + 打开登录"（不是空点一下的按钮）。CLI 也可：`pool add --id a2`。
- **登录判定只认会话 cookie**（`__Secure-next-auth.session-token`）。匿名访问 ChatGPT 也能用输入框，
  且匿名访客本身就有 `ajs_anonymous_id` / `oai-dm` / `_puid` 这些统计 cookie —— 都不能当成"已登录"。
  中途关掉登录窗口 = 未登录，如实报告，不要谎报成功。

> ⚠️ **风险（必须知道）**：多账号轮流绕过单账号配额**违反 OpenAI 服务条款**，且可能导致账号被封。
> 这是用户明确要求的功能，风险由用户承担。不要主动鼓励添加账号，也不要向用户隐瞒这一点。

### 实测坑与诚实限制

1. **必须 headed（有头）浏览器**：chatgpt.com 有 Cloudflare，无头会被挡、裸请求 403。
2. **选择器是尽力而为**：OpenAI 界面改版频繁。失败时 `steps` 会写明卡在哪一步（如 `no_composer` / `no_image` / `download_failed`），**如实报告，不要假装成功**；确认失效后再回退到中转站。
3. **配额信号**：页面出现「达到上限 / rate limit / 稍后再试」等即判定该账号触配额，自动轮换。若所有账号都触配额，如实告知并给选项，不要反复重试。
4. **尺寸由 ChatGPT 决定**，需要特定比例就在提示词里写明（如「1:1 方形构图」）。
5. **目视验收每一张**，脚本不报错不代表画面对。
6. **`lane_disabled` 不是故障**：那是用户在设置里关掉了通道，按回退走中转站即可。
7. **出图慢（1~3 分钟），超时别重新生成**：脚本现在会等"生成中"状态结束、只认本次新出现的图再下载；
   真等超时会返回 `pendingUrl`（那个对话的链接）。此时**先用 `grab` 把已生成好的图抓回来**：
   ```powershell
   node "<plugin>/src/taptap-gpt.mjs" pending        # 看有没有待抓取的对话
   node "<plugin>/src/taptap-gpt.mjs" grab           # 抓 pending 里那个对话（不重新生成）
   node "<plugin>/src/taptap-gpt.mjs" grab --url <对话链接>
   ```
   `gen` 自己也会先尝试续抓上一轮未完成的图（`--no-resume` 可关闭）。**重复 `gen` 会白烧一次生成额度。**

---

## 回退：中转站（OpenAI 兼容 /images）

配置在 `$DSH_HOME/taptap-maker-dev/image.json`（在 Maker 工作区之外，避免被运行时自动提交泄露 key）：

```json
{ "baseURL": "https://your-endpoint/v1", "apiKey": "sk-...", "model": "gpt-image-2.5", "size": "1024x1024" }
```

也可用环境变量 `TAPTAP_IMAGE_BASE_URL` / `TAPTAP_IMAGE_API_KEY` / `TAPTAP_IMAGE_MODEL`，或 `credentialsFile`。优先级：credentialsFile > env > image.json。

```powershell
node "<plugin>/src/taptap-image.mjs" --prompt "一只橙色小猫，扁平矢量风格" --out D:\tmp\cat.png
node "<plugin>/src/taptap-image.mjs" --config    # 查看生效配置（key 掩码）
```

接口：`POST {baseURL}/images/generations`，`Authorization: Bearer <key>`，body `{model,prompt,size,n}`；优先读响应 `b64_json`。

### 实测坑

1. **尺寸只认** `1024x1024` / `1024x1536` / `1536x1024`。要 256×256 图标就出大图再缩放。
2. **没有真 alpha**：prompt 写 "transparent" 会得到假棋盘格、`A=255`。要透明素材 → 让它出**纯色底**（美术里几乎不出现的洋红 `#FF00FF`）再自己抠。
3. **抠底只能用“边缘泛洪”**：从四条边 BFS 删与边缘连通的底色像素，主体内部再接近底色也不碰；别做全局色相删除（深紫/洋红主体会被抠穿）。参数参考：`BG_TOL=0.16`、`ss>0.45`、`vv>0.25`，裁到不透明外接框留 4% padding 再缩。
4. **`content_policy_error` 多是随机误伤**：遇 400 且 body 含 `content_policy` 就原样退避重试（15s 起、每次 +8s，最多 6 次），**不要改提示词**。CLI 已内置该重试。
5. **提示词只留一个核心主体**，删掉易冲突修饰（金边/魔法/宝石），显式写“主体占满画面”。

---

## 落盘规范（Maker 工作区，两条通道通用）

- **图片落点默认跟随项目**：在项目根执行 `gen` 时存到 `<项目>/.taptap-images/`，不再丢到 C 盘。
  该目录自带一个 `.gitignore`（内容 `*`），避免被 Maker 运行时自动提交。
  - 看当前解析：`node "<plugin>/src/taptap-gpt.mjs" dir`
  - 自定义：`dir --set "D:\my-images"` 或 `dir --set "{project}/imgs"`（支持 `{project}` / `{home}`）
  - 恢复跟随项目：`dir --reset`；单次覆盖：`gen --dir <目录>`
  - 设置页「ChatGPT 网页生图」卡里也有同样的输入框
- 生成/抠图全程在 `assets/` **之外**的临时目录做（`.taptap-images/` 就是现成的）。
- 裁好的成品才搬进 `assets/image/...`，并**补同名 `.meta`**：`{"uuid":"<27位随机串>"}`。
- 两条通道都无远程映射，后续改图只能重新生成（`edit_image` 对它们无效）。
- 小资源（图标 / 小 UI）：出干净大图（构图留白、主体居中），再用 `--downscale <宽>x<高>`（128x128 / 64x64）高质量缩小，切忌直接让模型出极小尺寸。

## 安全

只把 `prompt` 发给端点；不要发项目源码、内部路径或 key。明文 key 只存在仓库外的凭据文件，**绝不拷进 Maker 工作区任何路径**。
