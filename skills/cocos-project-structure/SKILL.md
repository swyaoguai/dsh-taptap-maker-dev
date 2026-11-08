---
name: cocos-project-structure
description: Cocos Creator 3.x 工程结构与目录规范：assets 资源、resources 与 Asset Bundle、脚本分层、settings 项目设置，以及哪些进版本库、哪些必须忽略。
whenToUse: 新建 Cocos 工程、整理现有工程目录、决定资源放 resources 还是 bundle、配置 .gitignore、接入 CI，或发现资源路径与加载方式混乱、提交里夹着 build/library 时。
---

# Cocos 工程结构（3.x）

## 根目录一眼看穿

```
<project>/
  assets/        ← 编辑器唯一追踪的目录；每个文件配同名 .meta
  settings/      ← 项目设置（v2/packages/*.json），要提交
  package.json   ← 带 creator.version，判定是不是 Cocos 工程
  tsconfig.json  ← 通常 extends ./temp/tsconfig.cocos.json（编辑器生成）
  extensions/    ← 项目级编辑器扩展（要提交）
  library/ temp/ local/ build/ profiles/   ← 生成物 / 本机状态，忽略
  native/        ← 原生工程模板与编译产物（看团队约定）
```

- 判定工程：`package.json` 里有 `creator.version` 且存在 `assets/`。
- 本插件只支持 **Creator 3.x**；2.x 场景/预制体格式与扩展 API 都不同，不要套用。
- `settings/` 手改容易随版本失效：能在编辑器界面改就别改 JSON。

## assets 里的特殊目录

- `assets/resources/` → 运行时代码用 `resources.load('path', Type, cb)` 加载；
  路径**相对 resources**、不带扩展名；贴图子资源要带 `/spriteFrame`。
- 任意目录可在属性检查器里勾成 **Asset Bundle**，bundle 名即加载名：
  `assetManager.loadBundle('name')`。适合关卡、皮肤、语言包、大图。
- 经验法则：首屏必用的小资源放 `resources/`；按玩法/关卡切的大资源放 bundle，
  方便分包、远程与热更。**不要把几百 MB 塞 resources**，会全进首包。

## 目录约定（建议直接照抄）

```
assets/
  scenes/            Main.scene、Game.scene
  prefabs/           Player.prefab、Enemy.prefab、ui/…
  scripts/
    core/            纯逻辑（不 import 'cc'，可单测）
    gameplay/        玩家、敌人、关卡
    ui/              界面与 HUD
    data/            配置、存档结构
  textures/          ui/、char/、env/、fx/
  audio/             bgm/、sfx/
  animations/        角色与 UI 动画 clip
  materials/         材质与 effect
  data/              JSON 配置
  fonts/
```

- 命名：预制体/脚本用 PascalCase；贴图/音频用 snake_case；一律避免中文、空格和
  URL/原生平台会出问题的字符。
- 一个组件一个文件，文件名 = 类名；`@ccclass` 名全局唯一（重名会让编辑器挂错组件）。

## 版本库怎么配

- **提交**：`assets/`、`settings/`、`package.json`、`tsconfig.json`、`extensions/`（若用）。
- **忽略**：`library/`、`temp/`、`local/`、`build/`、`profiles/`、`node_modules/`。
- **`.meta` 必须提交**：GUID 靠它，丢一个引用就断一片。
- 多机协作时别让不同版本编辑器同时改 `settings/`：结构随版本变，冲突很难手解。

## settings 里的关键项（改前先截图留底）

| 位置 | 影响 |
|---|---|
| Project → Project Data | 设计分辨率、fitWidth/fitHeight、起始场景 |
| Physics | 2D/3D 开关、重力、**碰撞分组矩阵** |
| Builder | 分包、MD5 缓存、压缩纹理、远程资源地址 |
| Feature Cropping | 裁掉没用的引擎模块（减包体） |

## 用 MCP 确认真实状态

- `cocos_asset action=list target=db://assets/...` 看编辑器眼里的资源树（和磁盘可能不一致）。
- 新写入的文件要等导入：`cocos_asset action=ready target=db://assets/...`。
- 路径/引用可疑：`cocos_asset action=inspect` / `deps` 查 uuid 与依赖。

## 常见坑

- 直接改 `assets/*.meta`：编辑器开着会被覆盖，引用还可能丢。
- 资源放在 `assets/` 外：编辑器完全看不到；放在 `library/` 里更是会被重建。
- 复制资源会带新 GUID，脚本里硬编码 uuid 一律会断，改用路径或 `@property`。
- `resources.load` 路径**大小写敏感**（Android/iOS/小游戏上尤其明显）。
- 构建产物、`profiles/` 进了仓库：体积暴涨，每次构建都冲突。

相关 skill：资源加载与预制体看 `cocos-resource-prefabs`；资源规范看 `game-assets`、`sprite-pipeline`。
