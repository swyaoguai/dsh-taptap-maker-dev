---
name: taptap-maker-custom-image-gen
description: 用用户自备的 OpenAI 兼容 /images 接口生成 TapTap Maker 游戏图片素材，完全不消耗 Maker 内置额度；含 taptap-image CLI 用法、尺寸限制、假 alpha 抠图与 content_policy 退避重试等实测坑。
whenToUse: 需要给游戏生成/补充图片素材（图标、精灵、卡面、UI 元素等），且不应消耗 Maker 内置额度时。
---

# 自定义生图通道（OpenAI 兼容 /images）

本插件提供一条独立生图通道，走用户自己的 base URL + key + model，**不碰 Maker 内置额度**。

## 配置

配置文件在 `$DSH_HOME/taptap-maker-dev/image.json`（在 Maker 工作区之外，避免被运行时自动提交泄露 key）：

```json
{ "baseURL": "https://your-endpoint/v1", "apiKey": "sk-...", "model": "gpt-image-2.5", "size": "1024x1024" }
```

也可用环境变量 `TAPTAP_IMAGE_BASE_URL` / `TAPTAP_IMAGE_API_KEY` / `TAPTAP_IMAGE_MODEL`，或 `credentialsFile` 指向仓库外的凭据 JSON。优先级：credentialsFile > env > image.json。

## 调用

CLI 在本插件 `src/taptap-image.mjs`：

```powershell
node "<plugin>/src/taptap-image.mjs" --prompt "一只橙色小猫，扁平矢量风格" --out D:\tmp\cat.png
node "<plugin>/src/taptap-image.mjs" --config    # 查看生效配置（key 掩码）
```

接口：`POST {baseURL}/images/generations`，`Authorization: Bearer <key>`，body `{model,prompt,size,n}`；优先读响应 `b64_json`。

## 实测坑（务必遵守）

1. **尺寸只认** `1024x1024` / `1024x1536` / `1536x1024`。要 256×256 图标就出大图再缩放。
2. **没有真 alpha**：prompt 写 "transparent" 会得到假棋盘格、`A=255`。要透明素材 → 让它出**纯色底**（美术里几乎不出现的洋红 `#FF00FF`）再自己抠。
3. **抠底只能用“边缘泛洪”**：从四条边 BFS 删与边缘连通的底色像素，主体内部再接近底色也不碰；别做全局色相删除（深紫/洋红主体会被抠穿）。参数参考：`BG_TOL=0.16`、`ss>0.45`、`vv>0.25`，裁到不透明外接框留 4% padding 再缩。
4. **`content_policy_error` 多是随机误伤**：遇 400 且 body 含 `content_policy` 就原样退避重试（15s 起、每次 +8s，最多 6 次），**不要改提示词**。CLI 已内置该重试。
5. **提示词只留一个核心主体**，删掉易冲突修饰（金边/魔法/宝石），显式写“主体占满画面”。
6. **目视验收每一张**，脚本不报错不代表画面对。

## 落盘规范（Maker 工作区）

- 生成/抠图全程在 `assets/` **之外**的临时目录（如 `<project>/.tmp/`）做。
- 裁好的成品才搬进 `assets/image/...`，并**补同名 `.meta`**：`{"uuid":"<27位随机串>"}`。
- 本通道无远程映射，后续改图只能重新生成（`edit_image` 对它无效）。

## 安全

只把 `prompt` 发给端点；不要发项目源码、内部路径或 key。明文 key 只存在仓库外的凭据文件，**绝不拷进 Maker 工作区任何路径**。
