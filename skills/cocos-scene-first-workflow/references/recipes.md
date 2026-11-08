# 落地配方：cocos_exec 搭舞台的常用片段

配合 `cocos-scene-first-workflow` 使用。所有片段都在 `cocos_exec`（`context: "scene"`）里跑，
执行完**必须** `cocos_scene action=save` + `cocos_screenshot scope=scene` + `cocos_logs action=recent`。
新写的脚本组件要先等资产库编译（2~5 秒）再 `addComponent`，否则会报找不到类。

## 1. 建 UI 根（Canvas）

已有 Canvas 就别再建；先 `cocos_scene action=hierarchy` 看一眼。

```js
const canvas = new cc.Node('Canvas')
canvas.layer = cc.Layers.Enum.UI_2D
canvas.addComponent(cc.Canvas)
canvas.addComponent(cc.UITransform)          // Canvas 需要，供 Widget 对齐
scene.addChild(canvas)                        // 项目通常已有 Canvas，按实际结构调整
return { uuid: canvas.uuid }
```

## 2. 建一个用 Widget 对齐的容器（不要手摆坐标）

```js
const n = new cc.Node('TopBar')
n.layer = cc.Layers.Enum.UI_2D
const ui = n.addComponent(cc.UITransform)
ui.setContentSize(720, 96)
const w = n.addComponent(cc.Widget)
w.isAlignTop = true; w.top = 24
w.isAlignLeft = true; w.left = 24
w.isAlignRight = true; w.right = 24
w.alignMode = cc.Widget.AlignMode.ON_WINDOW_RESIZE
parent.addChild(n)
return { uuid: n.uuid }
```

## 3. 建按钮（Sprite + Button + 子 Label）

```js
const btn = new cc.Node('BtnStart')
btn.layer = cc.Layers.Enum.UI_2D
btn.addComponent(cc.UITransform).setContentSize(240, 88)
btn.addComponent(cc.Sprite)                   // spriteFrame 之后单独 set，别写死在代码里
const b = btn.addComponent(cc.Button)
b.transition = cc.Button.Transition.SCALE
b.zoomScale = 0.94
const lbl = new cc.Node('Label')
lbl.layer = cc.Layers.Enum.UI_2D
const lt = lbl.addComponent(cc.Label)
lt.string = '开始游戏'
lt.fontSize = 32
lbl.addComponent(cc.UITransform).setContentSize(240, 88)
btn.addChild(lbl)
parent.addChild(btn)
return { uuid: btn.uuid }
```

文字、字号、图片这类**表现数据**都留在场景里给人改；代码只接 `Button.EventType.CLICK`。

## 4. 像素图先定 SpriteFrame

`cc.Sprite.spriteFrame` 只认 `cc.SpriteFrame`，不能直接给图片路径：

```js
// 资源要先进资产库：cocos_asset action=ready target=db://assets/ui/btn.png
const sf = await new Promise((res, rej) =>
  cc.resources.load('ui/btn/spriteFrame', cc.SpriteFrame, (e, a) => e ? rej(e) : res(a)))
btn.getComponent(cc.Sprite).spriteFrame = sf
```

9-slice 按钮记得设 `sprite.type = cc.Sprite.Type.SLICED` 和 `sprite.sizeMode`。

## 5. 物理体 + 碰撞分组

**分组名与碰撞矩阵是项目级配置**，要走编辑器的「项目设置 → 物理 → 碰撞矩阵」建
（3.8 起在项目设置面板里，存进 `settings/`；手改文件会被编辑器覆盖回去）。
先规划好分组清单再动手：`default / player / enemy / bullet / wall / pickup`。

节点上只挂组件、填分组名：

```js
const p = new cc.Node('Player')
p.addComponent(cc.UITransform)                // 2D 物理用
const body = p.addComponent(cc.RigidBody2D)
body.type = cc.RigidBody2D.Type.DYNAMIC
body.gravityScale = 3
body.fixedRotation = true
const col = p.addComponent(cc.BoxCollider2D)
col.size = new cc.Size(48, 96)
col.group = 'player'                          // 必须已在项目设置里存在
// 3D 同理：cc.RigidBody + cc.BoxCollider，group 用 cc.PhysicsGroup 的位掩码
return { uuid: p.uuid }
```

**掩码别在代码里临时改**：分组矩阵是设计数据，改它等于改游戏规则，要写进规划里并在编辑器配。

## 6. 存成 Prefab（可复用实体必须走这步）

```js
// 首选：用编辑器自己的 prefab 创建流程，引用关系与脚本绑定都会被正确序列化
const node = scene.getChildByPath('Canvas/World/Enemy')
Editor.Message.request('scene', 'create-prefab', node.uuid, 'db://assets/prefabs/Enemy.prefab')
```

运行期需要生成多个时，代码里只 `instantiate(prefab)`，**不要 `new Node()` 拼结构**。

## 7. 编辑器连线代替 find

组件上把引用声明成属性，然后在编辑器里把节点拖进去：

```ts
@ccclass('HudView')
export class HudView extends Component {
  @property(Label) scoreLabel: Label = null!
  @property(Button) startButton: Button = null!
}
```

写脚本用 `cocos_exec`（`context: "editor"`）+ `fs.writeFile` 落到 `assets/scripts/`，
再等编译、`addComponent('HudView')`，最后**在编辑器里连引用**（或 `cocos_exec` scene 上下文里
`comp.scoreLabel = node.getComponent(Label)` 赋一次并保存场景）。
`find('Canvas/HUD/Score')` 这类魔法路径只在迁移旧场景时用，新代码不许写。

## 8. 自查闭环（每次都做）

1. `cocos_scene action=save`
2. `cocos_screenshot scope=scene` —— 层级 / 位置 / 遮挡 / 缩放 / 文字是否溢出
3. `cocos_logs action=recent` —— 有没有 missing script、引用丢失、物理告警
4. `cocos_asset action=validate`（预制体）
5. 结构对了再写逻辑；逻辑写完重复 1~3

## 常见失败与处理

| 现象 | 原因 / 处理 |
|---|---|
| `addComponent('Xxx')` 报找不到类 | 脚本刚写入还没编译完，等 2~5 秒重试；确认有 `@ccclass` 且文件名与类名一致 |
| UI 看不见 | 没设 `layer = UI_2D`，或没挂在 Canvas 下，或 UITransform 尺寸为 0 |
| 按钮点不到 | 缺少 UITransform / 被上层透明节点挡住 / `BlockInputEvents` 误加 |
| 物理不碰撞 | 分组名在项目设置里不存在，或碰撞矩阵没勾选；`group` 拼写错会静默不生效 |
| 位置全乱 | 用了绝对坐标而不是 Widget / Layout；父节点锚点与尺寸没设 |
| 预制体引用为空 | 连线是在场景里做的但没保存；或 prefab 内的引用指到了场景节点 |
