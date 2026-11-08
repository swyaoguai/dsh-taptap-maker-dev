---
name: cocos-editor-tooling
description: Cocos Creator 3.x 编辑器扩展开发：扩展目录与 package.json、菜单与消息、scene/asset-db/builder 钩子、Editor.Message API、调试与重载，以及什么时候该写扩展而不是用 cocos_exec。
whenToUse: 要批量处理资源、做策划配置工具、加自定义菜单/面板、构建前后钩子、团队要固化流程，或扩展装了不生效、改了要重启时。
---

# 编辑器扩展（Cocos 3.x）

## 先判断要不要写扩展

- **一次性/调研性操作**：用 `cocos_exec`（editor 或 scene 上下文）直接跑 JS，别写扩展。
- **团队反复用、要给非程序员用、要进构建流程**：才写扩展。
- 扩展能读写工程文件，装第三方扩展前审一遍代码。

## 扩展结构

```
extensions/<name>/
  package.json      // name / version / main / contributions
  source/           // TypeScript 源码
  dist/             // 构建产物（main 指向这里）
  i18n/             // 菜单与面板文案（可选）
```

- 最稳的起点是 Creator 自带的扩展模板（扩展管理器里新建），字段结构以当前 3.x 版本为准。
- `package.json` 的 `name` 全局唯一；`main` 指到构建后的入口文件。
- `contributions` 里声明菜单、消息处理、场景脚本、资源库与构建钩子、自定义面板。
- 没构建出 `dist/` 的扩展不会加载——先 `npm install && npm run build`。

## 常用 API

```ts
// 请求（有返回值）
const tree = await Editor.Message.request('scene', 'query-node-tree');
// 发送（不关心返回值）
Editor.Message.send('asset-db', 'refresh-asset', 'db://assets');
```

- `scene`：节点树、创建节点、设置属性、保存场景（方法名随版本变化，用 `Editor.Message.request` 前先查当前版本）。
- `asset-db`：查询资源、刷新、导入。
- `builder`：构建前/后钩子。
- `Editor.Selection` 拿当前选中；`Editor.App` 拿编辑器信息。
- 面板/菜单文案走 i18n，别硬编码中文。

## 场景脚本

- 在 `contributions.scene` 里挂一个脚本，编辑器加载场景时执行；适合给场景加辅助显示、
  监听选中变化、注册快捷键。
- 场景脚本里拿不到 DOM，操作场景统一走路 `scene` 消息或 `Editor` 提供的 API。
- 卸载时把注册的监听、快捷键全部清掉。

## 调试

- 改完在扩展面板里**重载**扩展；`package.json` 结构改了通常要重载编辑器。
- 主进程日志在编辑器的控制台/日志文件；面板里的前端逻辑用开发者工具调。
- 版本兼容：TS 编译目标、Node 版本跟编辑器一致，别用编辑器不支持的新语法。
- 发布：打包 `extensions/<name>`（含 dist），或走扩展商店；不要带上 `node_modules` 里的开发依赖。

## 与 MCP 配合

- 日常让 AI 干活：`cocos_exec` 的 `editor` 上下文能直接 `Editor.Message`、`fs`、`path`、`require`，
  比现场写扩展快得多。
- 只有当某套操作要被反复执行、或必须给策划一个界面时，才固化成扩展。
- 扩展改完记得让 AI 验证：编辑器重载后 `cocos_logs` 看有没有加载错误。

## 常见坑

- `dist` 缺失 / `main` 路径写错：扩展静默不加载。
- contributions 字段与当前版本不匹配：菜单不出现，日志里才有报错。
- 在场景脚本里直接改节点后不 `save`：重开场景改动丢失。
- 扩展里硬编码绝对路径：换机器就崩，用 `Editor.Project.path` 拼。

相关 skill：MCP 操作 `cocos-creator-mcp`；工程结构 `cocos-project-structure`；
批量资源规范 `cocos-resource-prefabs`。
