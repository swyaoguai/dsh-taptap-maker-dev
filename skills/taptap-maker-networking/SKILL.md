---
name: taptap-maker-networking
description: TapTap Maker 联机开发：Lua 服务端权威、客户端/服务端双入口、资源预热与 ServerReady、云变量/排行榜，以及晚加入/重连要点。
whenToUse: 做多人/联机玩法、配 C/S 入口、处理同步与权威判定、排行榜/云存档，或联机构建配置时。
---

# TapTap Maker 联机

权威指南：`engine-docs/recipes/network-game-guide.md`（最全）；体素联机实战 `engine-docs/recipes/voxel-networking.md`。

## 架构

- **C/S 双入口**：`scripts/client_main.lua` + `scripts/server_main.lua`（构建时作为 `entry@client` / `entry@server`）。
- **服务端权威**：关键状态与判定放服务端（Lua 服务端），客户端只做表现与输入上报；防作弊靠这条。
- 构建开启多人：首次多人构建要显式 `multiplayer.enabled=true`，并配 `max_players`、匹配信息或持久世界。

## 关键流程

- **资源预热 + ServerReady**：客户端先预热资源，服务端就绪后发 Ready，再进正式玩法（背景匹配模式下脚本先加载、匹配在后台跑，匹配成功后处理 ServerReady）。
- **晚加入 / 重连**：持久世界/长局要支持中途加入与断线重连，服务端要能把当前世界状态同步给新连接。
- **两域色板等共享数据** 要在双端一致初始化（见 voxel-networking）。

## 云变量 / 排行榜

- `ClientCloud` / `ServerCloud`（云变量）、`Score`（排行榜）。
- 分数要**服务端写**：客户端上报 → 服务端校验 → `ServerCloud`/`Score`，见 `recipes/server-cloud-score.md` / `client-cloud-score.md`。
- 服务端时间：`recipes/server-time.md`。

匹配/房间 vs 持久世界的选型，按玩法（对局制 vs 共享大世界）决定，写进构建的 multiplayer 配置。
