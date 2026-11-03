---
name: cocos-creator-mcp
description: 用 cocos MCP 工具操作本机 Cocos Creator 工程（场景/节点/预制体/资源/构建/预览），并保证多项目并行时不写错工程。
whenToUse: 要给 Cocos Creator 项目加 UI、改场景、查资源、跑构建预览；或本机同时开着 2~3 个 Cocos 项目、担心改动打到错误工程时。
---

# Cocos Creator（MCP 集成）

本机可以同时打开多个 Cocos Creator 项目。工具命名空间统一是 `cocos`，**项目是参数**，不是命名空间。

## 开工三步

1. `cocos_projects` —— 看现在有几个项目、哪个在跑、端口、构建槽位占用。
2. 选定 `project`（slug / 目录名 / 完整路径）。**多个项目在跑时这一步不能省**：省略会直接报错，工具不会替你猜。
3. `cocos_status` 确认这个项目的 MCP 身份（端口上报的 `project_path` 就是它）。

## 工具怎么选

| 要做的事 | 用 |
|---|---|
| 场景信息 / 层级 / 找节点 / 打开保存场景 | `cocos_scene`（`action` 区分） |
| 资源列表 / 详情 / 依赖 / 导入就绪 / 刷新 | `cocos_asset` |
| 改节点、挂组件、写脚本、批量操作 | `cocos_exec`（`context: "scene"`） |
| 调编辑器自身（写文件、跑 Editor.Message） | `cocos_exec`（`context: "editor"`） |
| 看日志 / 搜日志 | `cocos_logs` |
| 截图验证 | `cocos_screenshot` |
| 命令行构建 | `cocos_build` |
| 预览 | `cocos_preview` |
| 上游有但上面没包 | `cocos_raw`（只读要显式 `mutating: false`） |

`cocos_exec` 是主力：上游工具档位（core/full）可能缺你要的那个工具，缺的时候**别反复试不存在的工具名**，直接用 JS 做。`scene` 上下文有 `scene` / `cc` / `context`；`editor` 上下文有 `Editor` / `fs` / `path` / `require`。

## 多项目并行的硬规则

- **一个项目同一时间只有一个写操作。** 拿不到写锁不是 bug，是保护：说明另一个会话/另一个任务正在写同一个场景。等它结束，不要换项目「重试」。
- **构建期间该项目也是锁住的。** 构建会一直写 `build/`、`library/`，所以从启动到进程退出都占着项目写锁，这期间改场景会被拒绝（`PROJECT_BUSY`）。构建槽位满则是 `BUILD_BUSY`（全机上限，默认 1）。
- **构建全机串行**（默认 1 个槽位）。多个项目同时构建会把机器拖垮、还容易抢 Cocos 自己的缓存。构建排队时等，别并行硬上。
- **看到 `PROJECT_MISMATCH` 就停手。** 意思是端口上的服务自报的项目和你要操作的不一致（常见于编辑器重启后端口回退）。重新 `cocos_projects` 刷新，不要绕过。
- 命令行构建实例（`--build`）不是交互目标，别把场景操作打过去。

## 改完必须验证

「调用返回成功」不等于「场景对了」：

1. `cocos_scene action=save` 保存；
2. `cocos_screenshot scope=scene`（或 `game` / `preview`）看一眼层级、位置、遮挡、缩放；
3. `cocos_logs action=recent` 查报错与脚本诊断；
4. 预制体改动要额外确认引用没丢（`cocos_asset action=validate`）。

## 常见坑

- **资源要等导入**：写完图片/预制体立刻用，可能还没进资源库；`cocos_asset action=ready target=db://assets/...` 等到稳定再引用。
- **别绕过编辑器直接改工程文件**：编辑器开着时手改 `assets/*.meta` 会被它覆盖。要走 `cocos_exec` / `cocos_asset`。
- **预览端口自己会递增**（7456、7457…），不要写死。
- **2.x 项目**不支持这套扩展（只支持 Creator 3.x）。
- 扩展没装时：`/game-cocos install <项目目录> --yes`，然后 `/game-cocos register --yes` 登记服务。
