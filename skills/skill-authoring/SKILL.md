---
name: skill-authoring
description: 怎么给本插件加/更新 skill：SKILL.md 的 frontmatter 格式、放哪个目录、通过 config.skills.sources 配置更新源，以及更新检测如何工作。
whenToUse: 要新增一个本地 skill、把外部 skill 仓库接进来，或搞不清 skill 为什么没出现/没更新时。
---

# 给本插件加/更新 skill

## SKILL.md 格式

每个 skill 一个目录，内含 `SKILL.md`：

```markdown
---
name: my-skill                 # 小写短横命名，需与目录名一致最稳
description: 一句话说清这个 skill 干什么（必填，非空）
whenToUse: 什么情况下该用它（可选但强烈建议）
disable-model-invocation: false  # 可选，true=不让模型自动调用
user-invocable: true             # 可选
---

正文：具体做法、步骤、坑、指向 engine-docs 的路径。
```

也支持扁平单文件 `my-skill.md`（无目录）。

## 放哪里

- **插件内置**：`<plugin>/skills/<name>/SKILL.md`（随插件分发，优先级 rank 360）。
- **更新缓存**：`$DSH_HOME/taptap-maker-dev/skills-cache/`（更新器写入，rank 350，略高于内置，便于用新版覆盖同名）。
- 两者都不在任何 Maker 工作区内，不会被 Maker 运行时自动提交。

> 项目级 `.dsh/skills`、`.agents/skills` 由 dsh 自带的文件 skill 提供器负责，优先级更高（100/200），会盖过本插件同名 skill——需要项目特供时放那里。

## 配更新源

在插件 config 里：

```yaml
config:
  skills:
    autoUpdate: true          # 默认开；无源时是安全空操作
    updateIntervalHours: 24
    sources:
      - 'git:https://github.com/<owner>/<repo>.git'
      - 'dir:D:\local\skills'
      - 'https://host/<name>/SKILL.md'
```

源目录约定：仓库/目录里若有 `skills/` 子目录则取之，否则取根；每个子目录含 `SKILL.md` 视为一个 skill，根下 `*.md`（除 README）视为扁平 skill。

## 更新检测怎么工作

- 插件启动 5s 后跑一次，之后每 `updateIntervalHours` 跑一次（定时器 unref，不挡退出）。
- 更新器对每个 skill 存 sha256 到 `skills-cache/.update-manifest.json`，对比得出**新增/变更**，有变化就让 skill 注册表失效、热刷新。
- 单个源失败不影响其它源；离线/无源时只记录一次 `lastChecked`。
- 手动触发：`/taptap-skills` 命令，或 `node <plugin>/src/taptap-skills-update.mjs --source <spec> [--cache-dir <dir>]`。
