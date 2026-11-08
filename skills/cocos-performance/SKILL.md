---
name: cocos-performance
description: Cocos Creator 3.x 性能优化：drawcall 与合批、图集与纹理压缩、节点与对象池、每帧分配、资源释放、帧率与包体，以及真机验证方法。
whenToUse: 掉帧、发热、内存上涨、drawcall 过高、包体超限、启动慢，或准备上线前做性能体检时。
---

# 性能（Cocos 3.x）

## 先量化，再动手

- 编辑器菜单 **Developer → Show Stats** 看 FPS、drawcall、三角形、内存；开发构建里能看到。
- 真机才是真相：编辑器 60fps 不代表手机不卡；小游戏用平台性能面板，原生用 Xcode / Android 工具。
- 定预算：60fps ≈ 16.6ms/帧；移动端 UI 多的项目先保 30fps 稳定，再谈 60。
- 每次优化只改一件事，前后同场景同设备对比数字。

## drawcall 与合批

- 合批条件：**同材质 + 同贴图 + 渲染顺序连续**。
- UI 降 drawcall 三板斧：打图集、按图集调整层级、减少 Mask/独立 Canvas。
- 会打断批次的东西：不同贴图、`Mask`、`Label` 的独立材质、混合模式、描边/阴影组件。
- 3D：材质变体越多、光源/阴影越多，drawcall 越高；静态场景可以合并网格。
- 目标参考：2D 手游 UI + 场景 30~80 个 drawcall 是常见区间，超过 150 先查图集和 Mask。

## 纹理与资源

- 尺寸按展示大小定：1024 够用就别上 2048/4096（4096² 未压缩约 64MB）。
- 移动端用压缩格式（ETC2/ASTC），按平台出不同变体；mipmap 只在 3D 需要。
- UI 图进图集；同一界面的图放同一张图集。
- 切场景后释放不再用的 bundle / 贴图；常驻资源只保留必要部分。

## 节点与每帧开销

- 节点数量是隐形杀手：几千个节点光是遍历就掉帧；UI 列表做虚拟化，
  重复元素用对象池，静态装饰合并。
- 每帧禁止：`find`、`getComponent`、`new Vec3`、拼接字符串、匿名闭包。
  临时向量用模块级复用对象，引用在 `onLoad` 缓存。
- `update` 里只放必须每帧运行的事；计时、状态切换放事件或定时器。
- 大量 tween 同时跑也会吃 CPU：持续动效合并，或改成着色器/动画。

## 对象池

```ts
import { NodePool, instantiate } from 'cc';
const pool = new NodePool();
// 取：pool.size() ? pool.get() : instantiate(prefab)
// 还：node.removeFromParent(); pool.put(node);
```

- 池里的节点不要 `destroy`；退出场景时统一清池（`pool.clear()` 并销毁）。
- 归还前重置状态（位置、透明度、监听），否则下次取出带着旧状态。

## 资源释放与内存

- 代码加载的资源手动释放（见 `cocos-resource-prefabs`）：`releaseAsset` / `resources.release` /
  `bundle.release` / `removeBundle`。
- 泄漏排查：反复进出同一界面，看内存是否回落；不回落多半是监听/tween/贴图没清。
- `onDestroy` 里退事件、停 tween、清定时器；全局事件总线上的常驻监听手动清。

## 「Graphics 太多」要不要换贴图？先分类

很多工程界面是 **Graphics 现画**的（圆角渐变底、描边、柔影、运行时按主题换色）。
看到「Graphics 数量高」先别急着换成 Sprite——**`cc.Sprite` 与 `cc.Graphics` 在同一节点上互斥**，
换过去要么报组件冲突，要么丢掉渐变/描边能力。

先按这三类分，只有第 3 类值得动：

| 类别 | 特征 | 处置 |
|---|---|---|
| **一次性绘制** | `onEnable`/`build` 时画一次，之后不变 | **保留 Graphics**。每节点 1 个 drawcall 是静态 UI 的正常成本，不值得为它引入贴图管线 |
| **视觉重复** | 同一视觉出现 N 次（22 个棋子的落地影、同一款空槽位） | **换共享贴图** —— 一次贴图、一个材质，可合批，收益最大 |
| **每帧重画** | 动态血条、拖拽预览、逐帧轨迹、粒子 | **性能坑，优先处理** —— 但要**量化后再重画**：颜色/长度不变就跳过重画，别每帧重建 Graphics 指令 |

**换贴图前先算合批收益**：Sprite 只有「同贴图 + 同材质 + 层级连续」才能合批。
如果换过去变成一堆不同图集的变体（每个 variant 一张、每个圆角尺寸一张），drawcall 反而上升。

**动态换色是 Graphics 路线的重要优势**：主题 token 一改，全部界面跟着变，不用重出图。
Sprite 方案要准备一堆贴图变体或改材质实例 —— 这是它最大的隐性成本。

## 帧率与画质设置

- 帧率上限按品类定（休闲 30 也够，动作 60）；设置项在不同版本位置不同，以构建/项目设置为准。
- 分辨率与适配策略影响填充率：全屏大图 + 多层半透明叠加最容易在低端机掉帧。
- 后效、阴影、抗锯齿按平台分级开关，不要全平台一套。

## 包体与启动

- 首包只放启动必需；大图/音频/关卡进 bundle 分包或远程。
- 小游戏注意主包上限与分包规则（以平台官方文档为准）。
- 启动打点：从 `game.on(Game.EVENT_GAME_INITED)` 到首帧、到主界面各记时间。
- 裁掉没用的引擎模块（Feature Cropping）能显著减包体。

## 验收清单

- [ ] 目标机型跑目标场景 5 分钟，FPS 稳定、无明显发热
- [ ] drawcall / 内存有前后对比数字
- [ ] 反复进出界面内存能回落
- [ ] 包体在平台限制内，首屏加载时间可接受
- [ ] 正式包关闭调试日志与 Stats

相关 skill：预算方法 `performance-budgeting`、`memory-budgeting`；资源加载 `cocos-resource-prefabs`；
构建包体 `cocos-build-release`。
