---
name: cocos-build-release
description: Cocos Creator 3.x 构建与发布：cocos_build 参数与排队、Web/小游戏/原生平台、分包与远程资源、构建后验收、原生热更新（AssetsManager）与版本管理。
whenToUse: 要打测试包/上线包、配分包和远程资源、发布微信小游戏、编 Android/iOS、做热更新，或构建失败、包体超限、构建锁冲突时。
---

# 构建与发布（Cocos 3.x）

## 用 MCP 构建

`cocos_build { project, platform, debug, wait_ms }`

- 构建**全机串行**（默认 1 个槽位），构建期间该项目写锁一直被占：这期间改场景会被拒绝（`PROJECT_BUSY`）。
- 等待超时但进程还在跑时锁**不会**释放，先 `cocos_status` 看持有者，别换项目重试。
- 命令行等价：`CocosCreator.exe --project <dir> --build "platform=web-mobile;debug=false"`。

## 平台

| 平台 | 产物 | 要点 |
|---|---|---|
| web-mobile / web-desktop | `build/web-mobile` | 必须用 HTTP 服务打开，不能双击 index.html |
| 微信/字节等小游戏 | `build/<platform>` | 主包体积上限、分包、域名白名单 |
| Android | `build/android/proj` | SDK/NDK + Gradle，再出 APK/AAB |
| iOS | `build/ios/proj` | Xcode + 证书 + 描述文件 |
| HarmonyOS 等 | 见构建面板 | 以当前版本支持列表为准 |

## 构建前检查

- 起始场景、设计分辨率、适配策略（见 `cocos-ui-layout`）已在项目设置里定好。
- 动态加载的资源都在 `resources/` 或某个 bundle 里；代码里拼的路径逐条核对。
- 分包：把大关卡/皮肤/音频放进独立 bundle，构建面板里勾分包。
- 版本号：项目版本、原生 `versionCode`/`versionName` 一起改。
- 关掉调试开关：日志、Stats、debug 构建标记。

## Web 发布

- 静态服务器部署，配好 wasm 的 MIME 与 gzip/brotli。
- 文件名带 hash（构建面板的 MD5 Cache），可以长缓存。
- 首屏可以加 loading 页，避免白屏。

## 小游戏发布

- 主包只放启动必需资源；其余分包或远程 CDN。
- 平台体积上限与分包规则**以官方文档为准**（会变），构建前先看构建面板的提示。
- 网络域名、下载域名都要在平台后台配白名单。
- 审核素材（图标、截图、隐私说明）单独准备。

## 原生发布

- 构建生成 `build/<platform>/proj`，再用 Android Studio / Xcode 编译签名。
- 权限、包名、图标、启动图、竖横屏在原生工程里配。
- `native/` 与 `build/` 不进版本库（除非团队明确要锁模板）。

## 原生热更新（仅 App）

```ts
import { native } from 'cc';

const am = new native.AssetsManager(manifestUrl, storagePath, versionCompare);
am.setEventCallback((event, code, msg) => { /* UPDATE_PROGRESS / SUCCESS / FAILED */ });
am.update();
```

- 构建面板开启 Hot Update，会生成 `project.manifest` / `version.manifest`。
- 服务端放版本目录（CDN），manifest 地址与资源相对路径要对得上；MIME 正确。
- 事件里区分「已是最新」「更新完成需重启」「失败」；失败回退到整包更新，**不要死循环重试**。
- 热更只改资源与脚本，不改引擎/原生代码；大版本升级仍要发整包。
- 小游戏用平台自带更新机制（如微信的 UpdateManager），不走这套。

## 构建后验收

- Web：起本地静态服务打开产物，看 console 有无 404 / 脚本错误。
- 小游戏：用平台开发者工具导入 `build/<platform>`，真机预览。
- 原生：装到真机，冷启动、切后台、弱网各跑一遍。
- 用 `cocos_screenshot scope=preview` / `game` 和 `cocos_logs` 辅助确认，但**最终以目标平台为准**。

## 常见坑

- 构建缓存导致旧资源：清 `build/` 与 `temp/` 后重试（先确认目录再删）。
- 动态 `import` 的脚本没被打包：改成静态引用，或在 bundle 里显式包含。
- 平台宏（`sys.platform`）分支写错，导致某平台走了另一套逻辑。
- 构建排队时并行改场景：撞 `PROJECT_BUSY`，等构建结束再动。

相关 skill：构建流水线方法 `build-pipeline-patterns`；发布检查 `release-readiness`、`store-submission`；
性能与包体 `cocos-performance`。
