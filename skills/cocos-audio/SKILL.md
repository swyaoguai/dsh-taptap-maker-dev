---
name: cocos-audio
description: Cocos Creator 3.x 音频：AudioSource 与 AudioClip、BGM/SFX 管理、音量与静音持久化、Web 自动播放限制、移动端与后台切换、音频内存与格式。
whenToUse: 加 BGM/音效、做音量设置、切场景音乐断掉、手机上没声音、音效叠太多炸音、或规划音频资源格式与加载方式时。
---

# 音频（Cocos 3.x）

## 基础

```ts
import { _decorator, Component, AudioSource, AudioClip, game, Game } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('Sfx')
export class Sfx extends Component {
  @property(AudioSource) source: AudioSource = null!;
  @property(AudioClip) hit: AudioClip = null!;

  playHit() { this.source.playOneShot(this.hit, 0.8); }
}
```

- `AudioSource`：`clip`、`loop`、`playOnAwake`、`volume`、`play()` / `pause()` / `stop()` / `playOneShot(clip, scale)`。
- `playOneShot` 不会打断当前播放，适合短音效；BGM 用独立 `AudioSource` + `loop = true`。
- 音频资源导入时可设加载模式（Web Audio / Download）与预加载；首屏 BGM 要提前加载。

## 管理结构（建议）

- 一个 `AudioManager` 单例：`master` / `music` / `sfx` 三档音量，相乘后生效。
- 音量与静音存 `sys.localStorage`，启动时读回；设置页改完立即生效。
- 按场景切 BGM：淡出旧曲 → 换 clip → 淡入；切场景前先停，避免常驻节点和场景节点抢。
- 音效并发上限（如 8 个）+ 同名音效 30ms 内合并，防止叠音炸裂。

## Web 自动播放限制

- 浏览器/小游戏要求**用户手势之后**才能出声：主界面放「点击开始」，第一次点击时初始化音频并播放。
- 切后台：`game.on(Game.EVENT_HIDE, ...)` 暂停 BGM，`game.on(Game.EVENT_SHOW, ...)` 恢复；
  回来时用户可能已经静音，按设置处理。
- 别在 `onLoad` 里直接 `play()` 当 BGM，多数平台会被静音策略拦掉。

## 移动端与原生

- iOS 静音开关、音频会话类别（原生工程里配）；Android 音频焦点丢失要暂停。
- 切场景/重开：确认 BGM 不会重头播（用常驻节点，或记录播放位置再恢复）。
- 耳机拔出、来电中断：监听平台事件（原生侧），回到前台按状态恢复。

## 素材与格式

- BGM：长音频用压缩格式（mp3/ogg），控制码率；不要整段 WAV。
- SFX：短音效用 wav/ogg，单文件小、解码快；大量音效进 bundle 按需加载。
- 内存：解码后 PCM ≈ 采样率 × 时长 × 声道 × 2 字节；一分钟 44.1k 立体声约 10MB，
  长 BGM 别同时驻留多首。
- 素材来源：优先插件 `/game-audio`（CC0 库，零额度）与 `/game-bgm`；
  **不要调用 Maker 内置 `text_to_sound_effect` / `text_to_music`**（消耗内置额度）。

## 与玩法/手感

- 打击音与动画、粒子同一帧触发；音效延迟通常来自未预加载。
- 关键提示音留出音量余量；BGM 在人声/剧情时 duck 降音量。
- 随机音高/多段变体避免重复感（`AudioSource` 本身没有 pitch，靠多 clip 或后期处理）。

## 验收

- 预览里真的听：BGM 循环无缝、音效不叠爆、切场景不断、静音/音量生效。
- `cocos_logs` 查 404、解码失败、未加载就播放。
- 目标平台各试一次（Chrome、手机浏览器、小游戏、原生），自动播放策略差异最大。

相关 skill：音频设计 `audio-implementation`；通用资源规范 `game-assets`；
缓存与释放 `cocos-resource-prefabs`。
