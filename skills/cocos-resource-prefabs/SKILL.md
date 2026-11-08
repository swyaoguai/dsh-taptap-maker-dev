---
name: cocos-resource-prefabs
description: Cocos Creator 3.x 的资源与预制体：resources/bundle/远程加载、子资源路径、引用计数与释放、Prefab 实例化与嵌套、纹理图集与导入设置、常见内存泄漏。
whenToUse: 要动态加载贴图/预制体/音频、做 bundle 分包或远程资源、内存一直涨、预制体改完不生效、或规划资源目录与释放策略时。
---

# 资源与预制体（Cocos 3.x）

## 先认清资源类型

`Asset` → `ImageAsset`（原始图）→ `Texture2D` → `SpriteFrame`（Sprite 真正用的）；
还有 `AudioClip`、`Prefab`、`AnimationClip`、`Material`、`JsonAsset`、`TextAsset`、`Font`。

- 编辑器里连线的资源由场景/预制体持有引用，随场景加载释放，不用手动管。
- 代码里加载的资源**归你管**：不释放就一直驻留。

## 加载方式

```ts
import { resources, assetManager, SpriteFrame, Prefab, instantiate } from 'cc';

// resources：路径相对 assets/resources，不带扩展名
resources.load('textures/hero/spriteFrame', SpriteFrame, (err, sf) => {
  if (err) { console.warn(err); return; }
  sprite.spriteFrame = sf;
});

// 目录批量
resources.loadDir('textures/ui', SpriteFrame, (err, list) => { /* ... */ });

// bundle（分包/远程）
assetManager.loadBundle('level-1', (err, bundle) => {
  bundle.load('enemies/boss/prefab', Prefab, (e, prefab) => { /* ... */ });
});

// 远程图片/音频/文本（小游戏要配域名白名单）
assetManager.loadRemote('https://cdn.example.com/a.png', { ext: '.png' }, (err, tex) => { /* ... */ });
```

- 图片子资源：`load('path/spriteFrame', SpriteFrame)`；预制体直接 `load('path/prefab', Prefab)`。
- 想用 `await` 就自己包一层 Promise，别假设 loader 一定返回 Promise。
- 加载失败先看路径大小写和 `.meta` 是否进了资源库。

## 释放与引用计数

```ts
spriteFrame.addRef();          // 长期持有
spriteFrame.decRef();          // 不再用
assetManager.releaseAsset(asset);   // 直接释放（确认没人再用）
resources.release('textures/hero/spriteFrame');
bundle.release('enemies/boss/prefab');
assetManager.removeBundle(bundle);  // 整包卸载
```

- 常见泄漏：load 完不 release、bundle 只加不减、切场景后贴图还在。
- 常见黑块：release 了还在显示的 SpriteFrame。释放前确认没有任何节点/材质引用。
- 内存估算：纹理 ≈ 宽 × 高 × 4 字节（未压缩），4096² 一张就 64MB。

## 预制体

- **编辑**：双击预制体进编辑模式；改完保存，场景里所有实例一起变。
- **嵌套**：预制体里放预制体实例可行，但层级别太深，引用链会难查。
- **实例化**：`const node = instantiate(prefab); node.setParent(this.node);`
  运行期临时对象（子弹、飘字、格子）一律这样来，不要 `new Node()`（见 `cocos-scene-first-workflow`）。
- **数据注入**：实例化后、`setParent` 前调 `init(data)`（挂进场景就会走 `onLoad`）。
- **覆盖**：实例上改属性会变成「覆盖」，预制体更新时容易打架；要长期改就回预制体里改。
- **复用**：`NodePool` 获取/归还，归还前 `removeFromParent`，不要 destroy 池里的节点。

## 导入设置（决定包体与画质）

| 资源 | 关键项 |
|---|---|
| 纹理 | 压缩格式（ETC2/ASTC/PVR）、packable（进图集）、filter、mipmap（仅 3D 需要） |
| SpriteFrame | 九宫格 border、trim、originalSize |
| 音频 | 加载模式（Web Audio / Download）、预加载；BGM 用压缩格式 |
| 模型 | scale、材质、动画拆分 |

- UI 图尽量进**同一张图集**：同图集同材质才能合批，drawcall 直接降。
- 首包只放启动必需资源；其余走 bundle 分包或远程。

## 用 MCP 验收

- 资源树/存在性：`cocos_asset action=list|inspect target=db://assets/...`。
- 新文件等导入：`cocos_asset action=ready`；预制体引用：`cocos_asset action=validate`。
- 依赖关系：`cocos_asset action=deps`，确认动态加载的资源确实被打进包。

## 常见坑

- 路径大小写、扩展名、子资源后缀（`/spriteFrame`）三件事最容易错。
- load 回调里直接用节点：节点可能已销毁，先 `isValid`。
- 场景里连线的资源被 `releaseAsset` 释放 → 画面变黑/报错。
- bundle 名和目录名不同：加载用**bundle 名**，不是文件夹名。
- 打包后资源丢失：代码里拼路径动态加载的，要确认它在 `resources/` 或某个 bundle 里。

相关 skill：目录规划 `cocos-project-structure`；图集与贴图规范 `game-assets`、`sprite-pipeline`；
性能与内存 `cocos-performance`。
