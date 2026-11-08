---
name: cocos-networking
description: Cocos Creator 3.x 联网：HTTP 与 WebSocket 封装、协议与编解码、心跳重连、服务端权威与预测、场景切换保持连接、小游戏与原生平台差异。
whenToUse: 做联机对战、排行榜、云存档、登录、断线重连、消息协议设计，或发现真机/小游戏连不上、重连风暴、切场景连接丢失时。
---

# 联网（Cocos 3.x）

引擎**没有内置联机框架**：传输、协议、重连、状态同步都要自己封装。设计模型先看
`multiplayer-netcode-patterns`、`multiplayer-game`，这一篇只讲 Cocos 落地。

## 传输层

| 场景 | 用什么 | 注意 |
|---|---|---|
| HTTP 请求 | `XMLHttpRequest`（引擎提供）/ web 端 `fetch` | 超时、错误码、JSON 解析 |
| 实时对战 | `WebSocket` | 心跳、重连、消息队列 |
| 小游戏 | 平台 API（如 `wx.request` / `wx.connectSocket`） | 域名白名单、wss |
| 原生 | 引擎的 XHR/WebSocket 实现 | 明文 http 可能被系统拒绝（ATS / cleartext） |

- 统一包一层 `Net` 门面：按平台选实现，上层只用 `request()` / `connect()` / `send()`。
- 传输层不要直接碰业务：消息进 `dispatch(opcode, payload)`，业务模块按 opcode 订阅。

## 协议

- 开发期 JSON 够用；上线用 Protobuf（protobufjs 预编译成静态代码，别运行时反射）。
- 消息格式：`[长度][opcode][payload]`，或 WebSocket 上直接 `{ op, data }`。
- 所有消息带 `seq`（请求序号）与 `id`（幂等键）；重连重发时靠它去重。
- 版本号握手：客户端版本不匹配直接提示更新，别让新旧协议互相猜。

## 连接管理

```ts
// 伪代码：重连是关键
onClose() {
  if (this.manualClose) return;
  this.retry = Math.min(this.retry + 1, 6);
  const delay = Math.min(30000, 500 * 2 ** this.retry) + Math.random() * 500;
  setTimeout(() => this.connect(), delay);   // 指数退避 + 抖动
}
```

- 心跳：固定间隔 ping，超时未 pong 主动断开重连；别用业务消息当心跳。
- 重连风暴：指数退避 + 抖动 + 上限；断网时监听平台网络事件，恢复后再连。
- 连接中发送的消息进队列，连上后按序 flush；重连成功后先同步会话状态。
- 切场景时连接不要断：网络层放纯类单例或常驻节点，场景对象只订阅自己关心的消息，
  离开场景时退订（否则回调打到已销毁节点）。

## 服务端权威

- 位置、伤害、掉落、经济由服务端算；客户端只做输入上报与表现。
- 客户端预测 + 服务器校正（回滚或平滑插值），具体看 netcode skill。
- 反作弊：速度/频率/冷却在服务端校验；客户端不要带密钥。
- 断线续玩：会话 token + 场景快照，重连后按快照恢复，不要重放全部历史。

## 数据与安全

- 登录 token 存 `sys.localStorage`（注意 XSS/明文风险）；不落日志。
- 请求签名/时间戳防重放；HTTPS/WSS 全链路。
- 客户端配置（服务器地址、渠道）走构建参数或远程配置，别硬编码多套。

## 测试

- 本地 mock server（Node/ws）跑通登录、心跳、断线、重连、乱序、重复包。
- 注入延迟/丢包（代理或服务端开关）验证预测与插值。
- 真机 + 小游戏各连一次；`cocos_logs` 打 seq 与状态迁移，便于复盘。

## 常见坑

- 小游戏没配 socket 域名白名单：真机静默失败。
- iOS ATS / Android 明文限制：换 https/wss 或配原生开关。
- 重连后旧连接的回调还在跑：每次连接带会话代次，旧代次消息丢弃。
- 场景切换后监听没退：重复处理、空引用报错。

相关 skill：同步模型 `multiplayer-netcode-patterns`；服务端权威 `multiplayer-game`；
资源与场景 `cocos-resource-prefabs`。
