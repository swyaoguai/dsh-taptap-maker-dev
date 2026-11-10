/**
 * 参考图叠加：在 Cocos Creator 的场景视图上叠一张设计稿，让 AI 照着设计稿搭界面。
 *
 * ## 为什么自己实现，而不是接另一个 MCP
 *
 * Creator 3.8 **没有**官方的「参考图」功能（实测：`Editor.Message` 的各个命名空间里
 * 没有任何 overlay / reference 相关方法）。业界现有做法只有一条：在场景面板的 DOM 上
 * 挂一层自己的覆盖层。本模块就是这么做的。
 *
 * ## 场景视图的 DOM 结构（Creator 3.8.8 实测）
 *
 * ```
 * <panel-frame name="scene">          ← 面板外壳
 *   <engine-view class="scene">
 *     <div class="float-window">      ← Creator 自己的浮层（工具条等）
 *     <webview src="packages://scene/.../3d-webview.html">
 *       └─ 内部：#GameCanvas          ← 真正的 3D 渲染画面
 * ```
 *
 * 场景画面本身在 **`<webview>` 里**（独立渲染帧）。webview 是「嵌在页面里的一块视频」，
 * HTML 元素盖不到它上面 —— 所以覆盖层不能挂在 webview 内部，只能：
 *
 *  1. 在**主窗口**里盖一层覆盖层，位置/尺寸严格对齐 webview 的 `getBoundingClientRect()`；
 *  2. webview 本身设为 `opacity` 降低（让底下透出来）——
 *     但 webview 不透明，要看到它下层的东西，只能靠降低 webview 自身的不透明度。
 *
 * 实际上更简单可靠的做法：**降低 webview 的 opacity**，然后在主窗口里把参考图
 * 画在一个绝对定位、尺寸与 webview 完全一致的 div 里（位于 webview 之上）。
 * webview 半透明 → 场景若隐若现，参考图清晰可见。
 *
 * ## 为什么走 Electron 而不是 Editor.Message
 *
 * 覆盖层是 DOM 操作，只有渲染进程能做。`cocos_exec`（editor 上下文）里
 * `require('electron')` 可用（Funplay 扩展的 browser.js 自己就这么用），
 * 于是可以：`BrowserWindow.getAllWindows()` 找到主窗口 →
 * `main.webContents.executeJavaScript()` 往主渲染进程注入 DOM。
 *
 * ## ⚠️ 路径必须在工程内（上游安全检查的硬约束）
 *
 * Funplay 的 `execute_javascript` 会扫描代码里的**字符串字面量**，
 * 发现指向工程外的绝对路径就整个拒绝执行（`javascript-safety.js`）。
 * 所以参考图**必须放在 Cocos 工程目录内**（推荐 `<工程>/temp/dsh-ref/`，不污染 assets）。
 * 本模块因此接受工程内路径，并一律转成 `file://` URL 交给渲染进程。
 *
 * ## ⚠️ 只做视觉叠加，绝不碰场景数据
 *
 * 覆盖层是 `pointer-events: none` 的纯展示层：它不改变节点树、组件或资源，
 * 场景该是什么样还是什么样。用户也能照常在场景视图里点节点、拖 gizmo。
 *
 * @module src/cocos/reference-image.mjs
 */
import path from 'node:path'
import fs from 'node:fs'

/** 覆盖层的 DOM id（用于幂等替换与清理）。 */
export const OVERLAY_ID = 'dsh-cocos-reference-overlay'

/** 推荐放置参考图的工程内目录（不进 assets，不参与导入/提交）。 */
export const REF_DIR_SEGMENTS = ['temp', 'dsh-ref']

/**
 * 在**主窗口渲染进程**里执行的函数（会被 `toString()` 后注入）。
 *
 * 约定：
 *  - `mode: 'set'`   → 挂/换参考图
 *  - `mode: 'clear'` → 移除
 *  - `mode: 'list'`  → 返回当前叠加状态
 */
async function overlayRunner(__dshPayload) {
  const { mode, imageUrl, opacity, scale, label, zIndex, dimScene } = __dshPayload;

  const OVERLAY_ID = '__DSH_OVERLAY_ID__';

  function collectAll(root, bucket) {
    if (!root) return bucket;
    for (const node of root.querySelectorAll ? root.querySelectorAll('*') : []) {
      bucket.push(node);
      if (node.shadowRoot) collectAll(node.shadowRoot, bucket);
    }
    return bucket;
  }

  // 找到场景视图的 <webview>：Creator 3.8 的场景画面就渲染在它里面。
  function findSceneWebview() {
    const all = collectAll(document, []);
    return all.find((n) =>
      String(n.tagName || '').toLowerCase() === 'webview'
      && String(n.getAttribute('src') || '').startsWith('packages://scene/')) || null;
  }

  function removeExisting() {
    const old = document.getElementById(OVERLAY_ID);
    if (old) old.remove();
    const wv = findSceneWebview();
    // 还原 webview 的不透明度（set 时可能被调低过）。
    if (wv) wv.style.opacity = '';
    const holder = document.getElementById(OVERLAY_ID + '-holder');
    if (holder) holder.remove();
  }

  function currentState() {
    const el = document.getElementById(OVERLAY_ID);
    if (!el) return { present: false, imageUrl: null, opacity: null, scale: null };
    return {
      present: true,
      imageUrl: el.dataset.imageUrl || null,
      opacity: Number(el.dataset.opacity || '1'),
      scale: Number(el.dataset.scale || '1'),
      label: el.dataset.label || null,
    };
  }

  if (mode === 'list') return currentState();

  if (mode === 'clear') {
    removeExisting();
    return { cleared: true, present: false };
  }

  if (mode !== 'set') return { error: 'mode 必须是 set / clear / list' };

  const webview = findSceneWebview();
  if (!webview) {
    return { error: '场景面板里没有找到 scene webview（编辑器可能还没打开场景视图面板）' };
  }

  removeExisting();

  // webview 是独立渲染帧，HTML 盖不住它；只能降低它自己的不透明度，
  // 让下面的场景「若隐若现」，参考图再单独画在上层。
  if (typeof dimScene === 'number' && dimScene < 1) {
    webview.style.opacity = String(dimScene);
  }

  // 覆盖层挂到 body 下，尺寸严格对齐 webview 的可视矩形。
  const rect = webview.getBoundingClientRect();
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.dataset.imageUrl = String(imageUrl);
  overlay.dataset.opacity = String(opacity);
  overlay.dataset.scale = String(scale);
  if (label) overlay.dataset.label = label;

  Object.assign(overlay.style, {
    position: 'fixed',
    left: rect.left + 'px',
    top: rect.top + 'px',
    width: rect.width + 'px',
    height: rect.height + 'px',
    pointerEvents: 'none',
    zIndex: String(zIndex),
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  });

  const img = document.createElement('img');
  img.src = imageUrl;
  img.alt = label || 'reference';
  img.draggable = false;
  Object.assign(img.style, {
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain',
    opacity: String(opacity),
    transform: scale === 1 ? 'none' : 'scale(' + String(scale) + ')',
    filter: 'drop-shadow(0 2px 10px rgba(0,0,0,0.5))',
  });
  overlay.appendChild(img);

  if (label) {
    const tag = document.createElement('div');
    tag.textContent = label;
    Object.assign(tag.style, {
      position: 'absolute',
      left: '8px',
      top: '8px',
      padding: '2px 8px',
      font: '12px/1.6 system-ui, sans-serif',
      color: '#fff',
      background: 'rgba(0,0,0,0.6)',
      borderRadius: '4px',
      pointerEvents: 'none',
    });
    overlay.appendChild(tag);
  }

  document.body.appendChild(overlay);

  // 等图片真的解码完再回报，避免「调用成功但图还没出来」。
  const loaded = await new Promise((resolve) => {
    if (img.complete && img.naturalWidth > 0) { resolve(true); return; }
    img.addEventListener('load', () => resolve(true), { once: true });
    img.addEventListener('error', () => resolve(false), { once: true });
    setTimeout(() => resolve(img.complete && img.naturalWidth > 0), 4000);
  });

  return {
    present: true,
    mounted: true,
    imageLoaded: loaded,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    viewSize: { width: Math.round(rect.width), height: Math.round(rect.height) },
    imageUrl: String(imageUrl),
    opacity: Number(opacity),
    scale: Number(scale),
    dimScene: typeof dimScene === 'number' ? dimScene : null,
    label: label || null,
    note: loaded
      ? '参考图已叠加到场景视图。'
      : '覆盖层已挂载，但图片没加载成功（路径不对或格式不支持）。',
  };
}

/**
 * 拼出「在渲染进程里注入这段脚本」的完整 JS（交给 `execute_javascript` 的 editor 上下文）。
 *
 * 分成「代码 + 数据」两半是必要的：
 *  - `executeJavaScript` 的入参只能是**字符串**；
 *  - 上游安全检查会扫**字符串字面量**里的绝对路径 —— 所以路径不能出现在代码字面量里，
 *    必须作为**数据**（变量）传进去；
 *  - editor 上下文的执行环境已经有 `args` 这个名字，不能重复声明。
 */
export function buildInjectCode({
  mode, imageUrl, opacity = 0.9, scale = 1, label = '', zIndex = 9999, dimScene = 0.25,
}) {
  const payload = {
    mode,
    imageUrl: imageUrl ?? '',
    opacity: Number(opacity),
    scale: Number(scale),
    label: label ?? '',
    zIndex: Number(zIndex),
    dimScene: Number(dimScene),
  }
  const runnerSource = overlayRunner.toString().replace(/__DSH_OVERLAY_ID__/g, OVERLAY_ID)
  return `
const electron = require('electron');
const wins = electron.BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
// 主窗口 = 标题里带 "Cocos Creator" 的那个；找不到就退回标题里带 .scene 的。
let main = wins.find((w) => /Cocos Creator/i.test(w.getTitle()));
if (!main) main = wins.find((w) => /\\.scene\\s*-\\s/.test(w.getTitle()));
if (!main) {
  return { error: '找不到 Cocos Creator 主窗口（当前窗口：' + wins.map((w) => w.getTitle()).join(' | ') + '）' };
}
const runner = ${runnerSource};
// payload 直接内联进注入脚本：编辑器上下文和渲染进程是两个作用域，
// 中间变量传不过去 —— 只能拼进字符串（数据来自 JSON.stringify，不是拼接字面量）。
return await main.webContents.executeJavaScript('(' + runner.toString() + ')(' + ${JSON.stringify(JSON.stringify(payload))} + ')', true);
`
}

/** 把工程内的绝对路径变成 `file://` URL（Windows 上要转正斜杠并加前导斜杠）。 */
export function toFileUrl(absolutePath) {
  const normalized = path.resolve(absolutePath).replace(/\\/g, '/')
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${encodeURI(withLeadingSlash)}`
}

/**
 * 解析用户给的参考图路径 → 工程内的绝对路径。
 *
 * 允许三种写法：
 *  - `temp/dsh-ref/ui.png`（工程相对，推荐）
 *  - `db://assets/ui.png`（资源库 URL）
 *  - 绝对路径（**必须在工程内**，否则拒绝并说明原因）
 *
 * @returns {{ok: true, absolutePath: string, fileUrl: string} | {ok: false, error: string}}
 */
export function resolveReferenceImage(projectPath, input) {
  const project = path.resolve(projectPath)
  const raw = String(input ?? '').trim()
  if (raw === '') return { ok: false, error: '参考图路径为空。' }

  let candidate = raw
  if (raw.startsWith('db://')) {
    // 资源库 URL → 工程内绝对路径
    candidate = path.join(project, raw.slice('db://'.length).replace(/^\/+/, ''))
  } else if (!path.isAbsolute(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) {
    candidate = path.join(project, raw.replace(/^\/+/, ''))
  }

  const absolute = path.resolve(candidate)
  const relative = path.relative(project, absolute)
  // 必须在工程内：上游安全检查会拦工程外的绝对路径，与其被拦不如这里说清楚。
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return {
      ok: false,
      error: '参考图必须放在 Cocos 工程目录内（上游 execute_javascript 的安全检查会拒绝工程外的绝对路径）。'
        + ` 收到：${raw}。请改用工程相对路径，例如 ${REF_DIR_SEGMENTS.join('/')}/ui.png。`,
    }
  }
  if (!fs.existsSync(absolute)) {
    return { ok: false, error: `参考图不存在：${absolute}` }
  }
  return { ok: true, absolutePath: absolute, fileUrl: toFileUrl(absolute) }
}
