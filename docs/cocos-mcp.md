# Cocos Creator MCP 集成（多项目并行安全）

一台机器上同时开 2~3 个 Cocos Creator 项目，是很容易把活干到错误工程里去的场景。
这份文档说明这套集成**怎么避免那件事**，以及怎么用。

## 1. 为什么是「一个 MCP 服务 + project 参数」

DSH 的 MCP 客户端用 `serverName` 做工具命名空间（`mcp__<serverName>__<tool>`），
同一个作用域里重名会加载失败；而且每个服务都会把自己**全部**工具的 schema
塞进每一次请求。

于是「每个项目一个 server」的代价是：

- 3 个项目 = 3 倍工具 schema 的 token，而且每个 server 背后还有几十个上游工具；
- 项目是随时开关的，端口也是动态的 → 每次都要改 DSH 配置并等重载；
- 一旦配置没跟上（项目关了、端口回退了），工具还在，地址却指向别人。

所以这里只登记**一个** `cocos` 服务，所有需要项目的工具都带 `project` 参数：

```
mcp__cocos__cocos_projects     → 有哪些项目、谁在跑、端口多少
mcp__cocos__cocos_exec         → { project, context, code } 跑 JS
mcp__cocos__cocos_scene        → { project, action: info|hierarchy|find|open|save... }
mcp__cocos__cocos_asset        → { project, action: list|inspect|deps|ready|refresh }
mcp__cocos__cocos_logs         → { project, action: recent|search|clear }
mcp__cocos__cocos_screenshot   → { project, scope: editor|scene|preview|game }
mcp__cocos__cocos_build        → { project, platform, debug, wait_ms }
mcp__cocos__cocos_preview      → { project, action: run|mode|set_mode }
mcp__cocos__cocos_open         → { project } 启动编辑器并等 MCP 就绪
mcp__cocos__cocos_status       → { project } 单项目详情
mcp__cocos__cocos_raw          → 直接调上游任意工具（高级）
```

工具数量**不随项目数量增长**，token 成本是常数。

## 2. 并发冲突到底有哪几层，各自怎么解

### ① 编辑器侧：端口

Cocos 的每个编辑器实例是独立进程（`CocosCreator.exe --project <dir>`），
预览端口自己会递增（7456 → 7457）。MCP 端口由扩展按项目路径派生，
被占用时回退到下一个可用端口。

**解法**：不假设任何固定端口。扩展配置固定写 `portMode: "project"`
（端口跟项目走），安装时由插件写入，不给「所有项目抢 8765」的机会。

### ② 客户端侧：端口 → 项目 的映射

端口会变（重启、回退），所以端口**不是身份**。

**解法**：进程表 → 项目 → 监听端口 → 握手验身份这条链：

1. 扫 `CocosCreator.exe` 主进程（命令行带 `--project`、且不含 `--type=`，
   后者是 Electron 的渲染/GPU 子进程）；
2. 取这些 pid 的 LISTEN 端口；
3. 逐端口 `GET /health`，读回 `project_path` / `project_id`；
4. 建立连接后再用 `initialize` 的 `funplay.context.project_path` 复核一次。

路径对不上 → **直接中止并报 `PROJECT_MISMATCH`**，不「尽力而为」地打过去。

### ③ 写操作：两个会话同时改一个项目

两个会话各自「读层级 → 加节点」，后写的覆盖先写的；预制体/场景 JSON 会静默丢改动。

**解法**：每项目一把写锁（`$DSH_HOME/game-forge/cocos/locks/<slug>.write.lock`）。

- 写操作（`cocos_exec`、保存场景、刷新资源、`cocos_raw` 默认）先拿锁；
- 拿不到就报错，并把**持有者**写清楚（谁、pid、多久前）；
- 锁带 TTL + 心跳，进程崩了会被回收；释放校验 owner，避免 A 超时后删掉 B 的锁。

### ④ 构建：多个项目同时构建

端口不冲突了，但 CPU/内存被抢空，还容易互相踩 Cocos 自己的缓存。

**解法**：全局构建槽位（默认 1 个，`config.cocos.buildSlots` 可调）。
`cocos_build` 走 `CocosCreator.exe --project <dir> --build "platform=...;debug=..."`，
槽位满了就明确报「谁在构建」，不排队到天荒地老。

### ⑤ 同一项目开两个实例（交互 + 无头构建）

`--build` 启动的是无头实例。发现阶段会把它们分开标记，
交互操作只挑非 `--build` 的实例。

### ⑥ 插件自己的状态文件

注册表、锁、截图都在 `$DSH_HOME/game-forge/cocos/` 下：

- 注册表写入 = 临时文件 + rename（原子），进程内串行化读-改-写；
- 锁文件用 `wx` 独占创建；
- 全都不进 Cocos 工程目录（工程会被 import、被提交）。

## 3. 装什么、怎么装

编辑器侧用的是 MIT 开源的 **Funplay MCP for Cocos**（编辑器内嵌 HTTP MCP 服务，
支持项目级端口、项目绑定 URL、写操作身份令牌）。

```bash
# 装到工程自己的 extensions/（推荐：天然按项目隔离）
node src/cocos/cli.mjs install "D:\wxzj-cocos" --yes

# 或者装到全局（同一 Creator 版本的所有项目共用）
node src/cocos/cli.mjs install "D:\wxzj-cocos" --global --yes

# 体检
node src/cocos/cli.mjs doctor "D:\wxzj-cocos"

# 把 cocos 服务登记给 DSH（写 profile 的 cordis.patch.yml）
node src/cocos/cli.mjs register --yes
```

对话里等价：`/game-cocos install <目录> --yes`、`/game-cocos register --yes`。

登记写的是 profile 的 `cordis.patch.yml`（只增删 `id: mcp-cocos` 这一条，自动备份）。
启用了配置热加载的宿主会在几秒内生效；**桌面端实测通常要重启一次桌面端**，
之后 agent 的工具列表里才会出现 `cocos_*`。

安装只做「下载官方 release + 校验 SHA256 + 解压」，不执行第三方脚本，
也不改全局 npm。已有的 `funplay-cocos-mcp.config.json` 不会被覆盖
（除非你明确 `--force`）。

## 4. 运行模型与错误码

| 错误码 | 含义 | 该怎么办 |
|---|---|---|
| `NO_EDITOR` | 没有正在运行的 Cocos Creator | 先 `cocos_open` 或手动打开 |
| `AMBIGUOUS_PROJECT` | 多个项目在跑但没指定 `project` | 按提示里的 slug 指定 |
| `NO_ENDPOINT` | 项目在跑，但没探到 MCP | 扩展没装/没启动、端口被占 |
| `PROJECT_MISMATCH` | 端口上的服务是另一个项目 | **停手**，重新 `cocos_projects` |
| `UNVERIFIED_IDENTITY` | 服务没上报项目路径 | 换支持身份上报的扩展版本 |
| `UPSTREAM_TOOL_MISSING` | 扩展档位里没这个工具 | 切 full 档，或用 `cocos_exec` |
| `BUILD_BUSY` | 构建槽位已满 | 等当前构建结束 |

## 5. 限制（如实说明）

- 进程/端口发现：Windows 上是完整实现（CIM + `Get-NetTCPConnection`）；
  macOS/Linux 是 `ps` + `lsof` 的最佳努力版本，拿不到就报「未探测到」，不猜。
- 只支持 Cocos Creator **3.x**（2.x 的场景格式与扩展 API 不同）。
- 上游是第三方 MIT 项目，工具名与返回结构可能随其版本变化；
  `cocos_raw` 是逃生口，`cocos_exec` 是兜底。
- 身份校验能防「配置过期/端口回退导致写错工程」，但**不是鉴权**：
  本机上任何进程都能访问那个 HTTP 端口，别把它绑到 `0.0.0.0`。
