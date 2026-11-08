---
name: cocos-testing
description: Cocos Creator 3.x 测试策略：纯逻辑 Jest/Vitest 单测、cc 依赖隔离、预览冒烟与 MCP 截图/日志验证、组件逻辑直调、真机与平台验收清单。
whenToUse: 要给玩法逻辑加单测、改完想快速回归、复现偶发 bug、规划测试矩阵，或「编辑器能跑真机不行」时。
---

# 测试（Cocos 3.x）

引擎不自带测试框架，按三层来：**纯逻辑单测 → 场景冒烟 → 真机验收**。

## 第一层：纯逻辑单测（最有性价比）

- 目标：数值、状态机、伤害公式、协议编解码、存档迁移、关卡生成。
- 前提：这些代码**不 import `'cc'`**，放 `assets/scripts/core/`，用纯 TS 写。
- 测试放工程根的 `tests/`（**不要放 assets 下**，否则编辑器会导入并编译）：
  `tests/*.test.ts` + `jest.config`（ts-jest）或 Vitest，`npx jest` 直接跑。
- 需要引擎类型时抽接口（如 `Vec2Like`），让 core 不依赖引擎。

```ts
// core/damage.ts —— 无 cc 依赖
export function calcDamage(atk: number, def: number, crit: boolean) {
  const base = Math.max(1, atk - def);
  return crit ? Math.round(base * 1.5) : base;
}
```

- 组件尽量薄：输入 → core 计算 → 表现；这样核心规则都有测试。

## 第二层：场景冒烟（MCP 快速跑）

1. `cocos_scene action=open target=...` 打开测试场景。
2. `cocos_preview action=run` 起预览。
3. `cocos_screenshot scope=game`（或 `preview`）看画面是否符合预期。
4. `cocos_logs action=recent` 抓报错；复现前 `action=clear` 清一次更干净。
5. 逻辑分支不依赖 UI 的，用 `cocos_exec`（scene）直接调组件方法，比如开战、结算、受伤，
   比手点快且可重复。

冒烟清单：

- [ ] 启动无报错，主界面可交互
- [ ] 主循环能进能出，结算正确
- [ ] 输入：点击、拖拽、连点、多点触控
- [ ] UI：三种比例不错位，按钮可点，弹窗可关
- [ ] 物理：碰撞、触发、边界
- [ ] 存档：读写、异常数据、清档
- [ ] 切场景/重开/切后台再回来
- [ ] 失败路径：资源缺失、网络断开（有网就测）

## 第三层：真机/平台验收

- 构建产物装到真机：冷启动、切后台、弱网、低电量模式各跑一遍。
- 小游戏用平台开发者工具 + 真机预览；原生注意权限、音频、返回键。
- 编辑器里能跑 ≠ 真机能跑：平台 API、音频策略、文件系统、字体都可能不同。
- 性能回归：同机型同场景，改前改后 FPS/内存对比（`cocos-performance`）。

## 回归习惯

- 每修一个 bug：先写能复现的单测/步骤，再修；修完跑一遍单测 + 冒烟清单。
- 偶发问题先怀疑时序：`start` 顺序、异步加载回调、物理步进中销毁节点。
- bug 单里写清：场景、操作步骤、预期/实际、日志片段。

## 常见坑

- 测试文件放进了 `assets/`：编辑器把它当游戏脚本编译，报错或打进包。
- 组件里写死逻辑导致无法单测：把计算抽到 core。
- 只测 happy path：数值边界、空引用、重复点击、断线要覆盖。
- 只靠截图验收：画面对了逻辑也可能错；关键数值用单测兜。

相关 skill：纯逻辑分层 `cocos-component-architecture`；MCP 操作 `cocos-creator-mcp`；
通用验证流程 `verification-loop`、`qa-test-matrix`。
