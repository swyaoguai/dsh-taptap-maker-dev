/**
 * Browser half of dsh-taptap-maker-dev — hand-written ModuleLoader bundle.
 *
 * The web shell serves this file and executes it as a script: it must call
 * `window.__ModuleLoader__.load({ id, factory })` exactly once, where `id` is
 * the package name and `factory(require)` returns a Cordis client plugin
 * (`{ name, inject, apply }`). `require('react')` is the only dependency the
 * shell provides. There is NO build step and NO top-level require/exports —
 * doing require/exports at module top level is what crashed host startup
 * before; everything must live inside the factory.
 *
 * The page registers a dedicated "TapTap Maker" settings section. Persisting
 * config back to the host needs the Typert remote compiler or an embedded web
 * server (neither available to a hand-written bundle), so the form turns its
 * fields into the exact `image.json` text with one-click copy instead.
 *
 * @module client.js
 */
window.__ModuleLoader__.load({
  id: 'dsh-taptap-maker-dev',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { useState, useMemo, useCallback, useEffect, useRef } = React

    const inject = ['slots']
    const SIZES = ['1024x1024', '1024x1536', '1536x1024', '512x512', '768x768']
    const API_BASE = '/api/taptap-maker-dev'

    /**
     * 不再内置已知型号表 —— 型号各家中转站不同，会很快过时。
     * 让用户从自己端点的 /models 拉，或手填。
     */
   /** sentinel */
    const S = {
      page: { padding: '20px 24px', maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 20 },      h1: { fontSize: 18, fontWeight: 600, margin: 0 },
      sub: { fontSize: 13, opacity: 0.7, margin: '4px 0 0', lineHeight: 1.6 },
      card: { border: '1px solid var(--dsh-border, rgba(128,128,128,0.25))', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 },
      cardTitle: { fontSize: 14, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8 },
      row: { display: 'flex', flexDirection: 'column', gap: 6 },
      label: { fontSize: 12, opacity: 0.8 },
      input: { padding: '8px 10px', borderRadius: 8, border: '1px solid var(--dsh-border, rgba(128,128,128,0.35))', background: 'var(--dsh-input-bg, rgba(128,128,128,0.08))', color: 'inherit', font: 'inherit', outline: 'none' },
      hint: { fontSize: 11, opacity: 0.55, margin: 0 },
      outputWrap: { display: 'flex', flexDirection: 'column', gap: 8 },
      textarea: { width: '100%', minHeight: 150, padding: 12, borderRadius: 8, border: '1px solid var(--dsh-border, rgba(128,128,128,0.35))', background: 'var(--dsh-code-bg, rgba(128,128,128,0.1))', color: 'inherit', font: '12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', resize: 'vertical' },
      btnRow: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
      btn: { padding: '8px 14px', borderRadius: 8, border: '1px solid var(--dsh-border, rgba(128,128,128,0.35))', background: 'var(--dsh-accent, #4f7cff)', color: '#fff', font: 'inherit', fontWeight: 600, cursor: 'pointer' },
      ok: { fontSize: 12, color: 'var(--dsh-success, #37b24d)' },
      warn: { fontSize: 12, color: 'var(--dsh-warn, #f08c00)' },
      codeInline: { font: '12px ui-monospace, Menlo, Consolas, monospace', background: 'rgba(128,128,128,0.15)', padding: '1px 6px', borderRadius: 4 },
      pill: { fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'rgba(55,178,77,0.15)', color: 'var(--dsh-success, #37b24d)', fontWeight: 600 },
      ul: { margin: '4px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: 1.7, opacity: 0.85 },
      scrollBox: { maxHeight: 340, overflowY: 'auto', border: '1px solid var(--dsh-border, rgba(128,128,128,0.25))', borderRadius: 8, padding: 4 },
      skillRow: { display: 'flex', alignItems: 'flex-start', gap: 10, padding: '7px 8px', borderRadius: 6, cursor: 'pointer' },
      skillMeta: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
      skillName: { fontSize: 13, fontWeight: 600 },
      skillDesc: { fontSize: 11, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' },
      ghostBtn: { padding: '5px 10px', borderRadius: 7, border: '1px solid var(--dsh-border, rgba(128,128,128,0.4))', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12, cursor: 'pointer' },
      bar: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
      search: { flex: 1, minWidth: 160, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--dsh-border, rgba(128,128,128,0.35))', background: 'var(--dsh-input-bg, rgba(128,128,128,0.08))', color: 'inherit', font: 'inherit', outline: 'none' },
      rowBetween: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 },
      warnBox: { border: '1px solid var(--dsh-warn, #f08c00)', background: 'rgba(240,140,0,0.08)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 },
      warnTitle: { fontSize: 13, fontWeight: 600, color: 'var(--dsh-warn, #f08c00)' },
      dangerBtn: { padding: '7px 12px', borderRadius: 7, border: 'none', background: 'var(--dsh-danger, #e03131)', color: '#fff', font: 'inherit', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
      offPill: { fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'rgba(224,49,49,0.15)', color: 'var(--dsh-danger, #e03131)', fontWeight: 600 },
      // ---- 分组导航（重构后）：把十几张卡按「你在做什么」收进四组 ----
      // 之前所有卡平铺在一页里，滚动到底要穿过一堆不相关的配置；
      // 现在顶部有分组标签 + 一句总览，一次只看一组。
      tabs: { display: 'flex', gap: 6, flexWrap: 'wrap', borderBottom: '1px solid var(--dsh-border, rgba(128,128,128,0.25))', paddingBottom: 10 },
      tab: { padding: '7px 14px', borderRadius: 8, border: '1px solid transparent', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 13, cursor: 'pointer', opacity: 0.7, display: 'flex', alignItems: 'center', gap: 6 },
      tabActive: { padding: '7px 14px', borderRadius: 8, border: '1px solid var(--dsh-border, rgba(128,128,128,0.35))', background: 'rgba(79,124,255,0.12)', color: 'inherit', font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 },
      tabCount: { fontSize: 11, padding: '0 6px', borderRadius: 999, background: 'rgba(128,128,128,0.2)', opacity: 0.9 },
      // 状态总览条：一眼看出「哪条通道现在是通的」
      overview: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
      chip: { fontSize: 12, padding: '4px 10px', borderRadius: 999, border: '1px solid var(--dsh-border, rgba(128,128,128,0.3))', display: 'flex', alignItems: 'center', gap: 6 },
      chipOn: { fontSize: 12, padding: '4px 10px', borderRadius: 999, border: '1px solid rgba(55,178,77,0.5)', background: 'rgba(55,178,77,0.1)', display: 'flex', alignItems: 'center', gap: 6 },
      chipOff: { fontSize: 12, padding: '4px 10px', borderRadius: 999, border: '1px solid rgba(128,128,128,0.3)', background: 'transparent', opacity: 0.55, display: 'flex', alignItems: 'center', gap: 6 },
      dot: { width: 7, height: 7, borderRadius: 999, background: 'var(--dsh-success, #37b24d)', display: 'inline-block' },
      dotOff: { width: 7, height: 7, borderRadius: 999, background: 'rgba(128,128,128,0.6)', display: 'inline-block' },
      empty: { fontSize: 13, opacity: 0.6, padding: '24px 4px', textAlign: 'center' },
      sectionIntro: { fontSize: 12, opacity: 0.65, margin: 0, lineHeight: 1.6 },
    }

    /**
     * 一次只显示一组的容器。
     *
     * 用 `display:none` 而不是卸载：卡里都有各自的 useState（账号列表、
     * 表单草稿），切走再切回不该把用户刚填一半的东西丢掉。副作用是
     * 所有卡在进入设置页时都会跑一次加载 —— 这些都是本地文件读取，
     * 量级可以忽略。
     */
    function PanelGroup(props) {
      return h('div', { style: props.active ? { display: 'flex', flexDirection: 'column', gap: 16 } : { display: 'none' } }, props.children)
    }

    /** 分组 tab：数字是这一组里的卡数，帮助判断「这里有多少要配」。 */
    function GroupTabs(props) {
      return h('div', { style: S.tabs },
        props.groups.map((g) => h('button', {
          key: g.id,
          style: props.value === g.id ? S.tabActive : S.tab,
          onClick: () => props.onChange(g.id),
          title: g.desc,
        },
        h('span', null, g.icon, ' ', g.label),
        g.count > 0 ? h('span', { style: S.tabCount }, String(g.count)) : null)))
    }

    /** 通道状态 chip：绿点 = 现在能用，灰点 = 没配好。 */
    function StatusChip(props) {
      return h('span', { style: props.on ? S.chipOn : S.chipOff, title: props.title || '' },
        h('span', { style: props.on ? S.dot : S.dotOff }),
        props.label)
    }

    function Toggle(props) {
      const on = props.on === true
      return h('button', {
        type: 'button',
        disabled: props.disabled,
        onClick: props.onClick,
        'aria-pressed': on,
        style: {
          width: 46, height: 26, borderRadius: 999, border: 'none', padding: 0, position: 'relative',
          cursor: props.disabled ? 'default' : 'pointer', flex: '0 0 auto',
          background: on ? 'var(--dsh-success, #37b24d)' : 'var(--dsh-border, rgba(128,128,128,0.5))',
          transition: 'background .15s', opacity: props.disabled ? 0.6 : 1,
        },
      }, h('span', {
        style: {
          position: 'absolute', top: 3, left: on ? 23 : 3, width: 20, height: 20, borderRadius: '50%',
          background: '#fff', transition: 'left .15s', boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
        },
      }))
    }

    function PolicyToggle() {
      const [enabled, setEnabled] = useState(null) // null=loading, true/false, 'error'
      const [busy, setBusy] = useState(false)
      const [confirmOff, setConfirmOff] = useState(false)
      const [err, setErr] = useState('')

      const load = useCallback(() => {
        fetch(`${API_BASE}/policy`, { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((j) => setEnabled(j.blockCreditTools !== false))
          .catch(() => setEnabled('error'))
      }, [])

      useEffect(() => { load() }, [load])

      const save = useCallback((val) => {
        setBusy(true)
        setErr('')
        fetch(`${API_BASE}/policy`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ blockCreditTools: val }),
        })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((j) => { setEnabled(j.blockCreditTools !== false); setConfirmOff(false) })
          .catch(() => setErr('保存失败：宿主 web 服务可能未就绪，可改用配置文件 maker.blockCreditTools。'))
          .finally(() => setBusy(false))
      }, [])

      const onToggle = useCallback(() => {
        if (enabled === true) setConfirmOff(true) // turning OFF → remind first
        else save(true) // turning ON → immediate
      }, [enabled, save])

      const head = h('h2', { style: S.cardTitle }, '额度红线')

      if (enabled === null) {
        return h('div', { style: S.card }, head, h('p', { style: { ...S.sub, marginTop: 0 } }, '加载中…'))
      }
      if (enabled === 'error') {
        return h('div', { style: S.card }, head,
          h('p', { style: { ...S.sub, marginTop: 0 } },
            '没连上宿主服务，开关暂不可用。可点「重试」，或改用配置文件 ',
            h('span', { style: S.codeInline }, 'maker.blockCreditTools'), '。'),
          h('div', { style: S.bar }, h('button', { style: S.ghostBtn, onClick: load }, '重试')))
      }

      return h('div', { style: S.card },
        h('div', { style: S.rowBetween },
          h('div', null,
            head,
            h('p', { style: { ...S.sub, marginTop: 2 } },
              enabled
                ? '已开启：非经你在对话中明确要求，模型不得调用任何消耗 Maker 内置额度的生成工具。'
                : '已关闭：模型可按需调用消耗额度的生成工具（generate_image / 视频 / 音乐 / 音效 / 语音 / 3D 等）。')),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: enabled ? S.pill : S.offPill }, enabled ? '已开启' : '已关闭'),
            h(Toggle, { on: enabled, disabled: busy, onClick: onToggle })),
        ),
        err ? h('p', { style: { ...S.hint, color: 'var(--dsh-warn, #f08c00)' } }, err) : null,
        confirmOff ? h('div', { style: S.warnBox },
          h('span', { style: S.warnTitle }, '⚠ 确认关闭额度红线？'),
          h('p', { style: { ...S.hint, margin: 0 } },
            '关闭后，模型将不再被阻止调用消耗 TapTap Maker 内置额度的生成工具（生图 / 视频 / 音乐 / 音效 / 语音 / 3D）。',
            '这些工具会实际扣费，请确认你清楚这一点。随时可以再打开。'),
          h('div', { style: S.bar },
            h('button', { style: S.dangerBtn, disabled: busy, onClick: () => save(false) }, '确认关闭'),
            h('button', { style: S.ghostBtn, disabled: busy, onClick: () => setConfirmOff(false) }, '取消')),
        ) : null,
      )
    }

    function buildImageJson(f) {
      return JSON.stringify({
        baseURL: f.baseURL.trim(),
        apiKey: f.apiKey.trim(),
        model: f.model.trim(),
        size: (f.size || '1024x1024').trim(),
      }, null, 2)
    }

    function copyText(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text)
          return true
        }
      } catch (_e) { /* fall through */ }
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        return true
      } catch (_e) {
        return false
      }
    }

    // ---------------------------------------------------------------------
    // BGM workbench widget — lives on the MAIN interface (composer dock),
    // because preview/trim/import is usage, not configuration. Everything is
    // local + free: <audio> streams from bgm-downloads, the waveform is drawn
    // from decoded samples, and trimming runs ffmpeg through the plugin API.
    // ---------------------------------------------------------------------
    function bgmFmtTime(sec) {
      if (!Number.isFinite(sec) || sec < 0) return '?:??'
      const s = Math.floor(sec % 60)
      const m = Math.floor(sec / 60)
      return `${m}:${String(s).padStart(2, '0')}`
    }

    const bgmPeaksCache = new Map() // name -> Float32Array peaks (visual only)

    async function bgmLoadPeaks(name) {
      const cached = bgmPeaksCache.get(name)
      if (cached) return cached
      const r = await fetch(`${API_BASE}/bgm-file?name=${encodeURIComponent(name)}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const buf = await r.arrayBuffer()
      const AC = window.AudioContext || window.webkitAudioContext
      if (!AC) throw new Error('此浏览器不支持 WebAudio')
      const ac = new AC()
      let audio
      try {
        audio = await ac.decodeAudioData(buf)
      } finally {
        try { ac.close() } catch { /* ignore */ }
      }
      const ch = audio.getChannelData(0)
      const N = 240
      const peaks = new Float32Array(N)
      const block = Math.max(1, Math.floor(ch.length / N))
      for (let i = 0; i < N; i += 1) {
        let max = 0
        const from = i * block
        const to = Math.min(from + block, ch.length)
        for (let j = from; j < to; j += 16) { // stride-sample: plenty for a thumbnail
          const v = Math.abs(ch[j])
          if (v > max) max = v
        }
        peaks[i] = max
      }
      bgmPeaksCache.set(name, peaks)
      return peaks
    }

    function BgmWave(props) {
      // props: name, duration, trim {start,end}, onTrim(next|null), height
      const canvasRef = useRef(null)
      const [peaks, setPeaks] = useState(null)
      const [err, setErr] = useState('')
      const dragRef = useRef(null)

      useEffect(() => {
        let alive = true
        setPeaks(null)
        setErr('')
        bgmLoadPeaks(props.name)
          .then((p) => { if (alive) setPeaks(p) })
          .catch((e) => { if (alive) setErr(e?.message ?? String(e)) })
        return () => { alive = false }
      }, [props.name])

      const draw = useCallback(() => {
        const cv = canvasRef.current
        if (!cv || peaks === null || !props.duration) return
        const dpr = window.devicePixelRatio || 1
        const w = cv.clientWidth
        const hgt = cv.clientHeight
        if (w === 0 || hgt === 0) return
        if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hgt * dpr)) {
          cv.width = Math.round(w * dpr)
          cv.height = Math.round(hgt * dpr)
        }
        const g = cv.getContext('2d')
        g.setTransform(dpr, 0, 0, dpr, 0, 0)
        g.clearRect(0, 0, w, hgt)
        const n = peaks.length
        const barW = w / n
        const trim = props.trim
        for (let i = 0; i < n; i += 1) {
          const mid = (i + 0.5) / n
          const inSel = !trim || (mid * props.duration >= trim.start && mid * props.duration <= trim.end)
          const bh = Math.max(2, peaks[i] * (hgt - 6))
          g.fillStyle = inSel ? 'rgba(79,124,255,0.85)' : 'rgba(128,128,128,0.38)'
          g.fillRect(i * barW, (hgt - bh) / 2, Math.max(1, barW - 1), bh)
        }
      }, [peaks, props.duration, props.trim])

      useEffect(() => { draw() }, [draw])

      const onPointerDown = (which) => (e) => {
        if (!props.onTrim || !props.duration) return
        e.preventDefault()
        e.stopPropagation()
        const cv = canvasRef.current
        if (!cv) return
        dragRef.current = { which, rect: cv.getBoundingClientRect(), startVal: props.trim.start, endVal: props.trim.end }
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* older engines */ }
      }
      const onPointerMove = (e) => {
        const d = dragRef.current
        if (!d || !props.duration) return
        const x = Math.min(Math.max(e.clientX - d.rect.left, 0), d.rect.width)
        const t = (x / d.rect.width) * props.duration
        if (d.which === 'start') props.onTrim({ start: Math.min(t, d.endVal - 1), end: d.endVal })
        else props.onTrim({ start: d.startVal, end: Math.max(t, d.startVal + 1) })
      }
      const onPointerUp = () => { dragRef.current = null }

      const hasTrim = peaks !== null && props.duration > 0 && props.trim
      const handle = (which) => h('div', {
        onPointerDown: onPointerDown(which),
        onPointerMove,
        onPointerUp,
        style: {
          position: 'absolute', top: -4, bottom: -4, width: 14,
          left: `calc(${(props.trim[which] / props.duration) * 100}% - 7px)`,
          cursor: 'ew-resize', touchAction: 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2,
        },
      }, h('div', { style: { width: 4, height: '100%', borderRadius: 2, background: '#4f7cff', boxShadow: '0 0 4px rgba(79,124,255,0.7)' } }))

      return h('div', { style: { position: 'relative', width: '100%', height: props.height, userSelect: 'none' } },
        h('canvas', { ref: canvasRef, style: { width: '100%', height: '100%', display: 'block', borderRadius: 6, background: 'rgba(128,128,128,0.10)' } }),
        peaks === null && !err
          ? h('div', { style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, opacity: 0.6 } }, '波形生成中…')
          : null,
        err
          ? h('div', { style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: 'var(--dsh-warn, #f08c00)', padding: '0 12px', textAlign: 'center' } }, `波形加载失败：${err}`)
          : null,
        hasTrim
          ? h('div', { style: { position: 'absolute', top: 0, bottom: 0, left: 0, width: `${(props.trim.start / props.duration) * 100}%`, background: 'rgba(0,0,0,0.38)', borderRadius: '6px 0 0 6px', pointerEvents: 'none' } })
          : null,
        hasTrim
          ? h('div', { style: { position: 'absolute', top: 0, bottom: 0, right: 0, width: `${((props.duration - props.trim.end) / props.duration) * 100}%`, background: 'rgba(0,0,0,0.38)', borderRadius: '0 6px 6px 0', pointerEvents: 'none' } })
          : null,
        hasTrim ? handle('start') : null,
        hasTrim ? handle('end') : null,
      )
    }

    function BgmWidget() {
      const [open, setOpen] = useState(false)
      const [lib, setLib] = useState(null) // null=loading | {ok, dir, project, files} | {ok:false}
      const seenRef = useRef(null) // Set of names known at first successful load
      const [toasts, setToasts] = useState([]) // newly generated, not yet seen
      const [sel, setSel] = useState(null) // file opened in the detail/trim view
      const [trim, setTrim] = useState({ start: 0, end: 0 })
      const [fade, setFade] = useState(true)
      const [loopSel, setLoopSel] = useState(false)
      const [playing, setPlaying] = useState(null) // file name currently playing
      const [busy, setBusy] = useState('') // '' | 'trim' | 'import'
      const [notice, setNotice] = useState(null) // { ok, text }
      const [err, setErr] = useState('')
      // Overlay colors measured from the live page as a CONTRASTING PAIR.
      // The old code measured only the background and left text as `inherit`
      // from the mount point — whenever the host page paints its background on
      // a child container (body itself transparent), that kept the dark
      // fallback panel while inheriting dark text: dark-on-dark, unreadable.
      // Now bg and fg are measured together and fg is FORCED to contrast bg,
      // so the panel is readable on both light and dark hosts.
      const [theme, setTheme] = useState({ bg: 'rgba(28,30,36,0.98)', fg: '#e8eaed' })
      const audioRef = useRef(null)
      const srcRef = useRef('')
      // Loop-preview range for the shared <audio>. MISSING before 2026-10-18:
      // playFile/stop wrote `rangeRef.current` without this ref ever being
      // declared, so EVERY play/close/back/stop click threw a synchronous
      // ReferenceError — the play button never played and the ✕ never closed
      // (event-handler errors bypass the render boundary, hence zero feedback).
      const rangeRef = useRef({ active: false, start: 0, end: 0 })

      // Panel background measured from the live page so it fits light/dark.
      useEffect(() => {
        try {
          const lum = (c) => {
            const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(c || '')
            return m === null ? null : (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255
          }
          let bg = ''
          let textColor = ''
          for (const el of [document.body, document.documentElement]) {
            const cs = getComputedStyle(el)
            const b = cs.backgroundColor
            if (!bg && b && b !== 'rgba(0, 0, 0, 0)' && b !== 'transparent') bg = b
            if (!textColor && cs.color) textColor = cs.color
          }
          const bgLum = lum(bg) ?? 0.12 // nothing measurable → assume a dark UI
          const fgLum = lum(textColor)
          const fg = fgLum !== null && Math.abs(fgLum - bgLum) > 0.35
            ? textColor // the host's own text already contrasts: stay theme-faithful
            : (bgLum < 0.55 ? '#e8eaed' : '#1f2328') // otherwise force contrast
          setTheme({ bg: bg || (bgLum < 0.55 ? 'rgba(28,30,36,0.98)' : 'rgba(250,250,251,0.98)'), fg })
        } catch { /* keep the dark fallback pair */ }
      }, [])

      const loadLib = useCallback(async () => {
        try {
          const r = await fetch(`${API_BASE}/bgm-library`, { headers: { accept: 'application/json' } })
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          const j = await r.json()
          const files = Array.isArray(j.files) ? j.files : []
          setLib({ ok: true, dir: j.dir, project: j.project ?? null, files })
          const names = new Set(files.map((f) => f.name))
          if (seenRef.current === null) {
            seenRef.current = names // first load: everything is "old"
          } else {
            const fresh = files.filter((f) => !seenRef.current.has(f.name))
            if (fresh.length > 0) {
              for (const f of fresh) seenRef.current.add(f.name)
              setToasts((prev) => [
                ...fresh.map((f) => ({ name: f.name, duration: f.duration })).filter((t) => !prev.some((p) => p.name === t.name)),
                ...prev,
              ].slice(0, 3))
            }
          }
        } catch (e) {
          setLib((prev) => (prev && prev.ok ? prev : { ok: false, error: e?.message ?? String(e) }))
        }
      }, [])

      // Poll: on mount, while visible, and on window focus. Frequency follows
      // the panel: 5s while it's open (fresh list while listening/trimming),
      // 30s while closed (still lights the red-dot within half a minute of a
      // fresh BGM landing, at a third of the old background cost).
      useEffect(() => {
        loadLib()
        const t = setInterval(() => { if (document.visibilityState === 'visible') loadLib() }, open ? 5000 : 30000)
        const onFocus = () => loadLib()
        window.addEventListener('focus', onFocus)
        return () => { clearInterval(t); window.removeEventListener('focus', onFocus) }
      }, [loadLib, open])

      // One shared <audio>; a timeupdate hook loops the selected range.
      useEffect(() => {
        const a = new Audio()
        a.preload = 'metadata'
        audioRef.current = a
        const onTime = () => {
          const r = rangeRef.current
          if (r.active && a.currentTime >= r.end - 0.03) {
            try { a.currentTime = r.start } catch { /* ignore */ }
          }
        }
        const onEnded = () => {
          const r = rangeRef.current
          if (r.active) {
            try { a.currentTime = r.start; a.play().catch(() => {}) } catch { /* ignore */ }
            return
          }
          setPlaying(null)
        }
        a.addEventListener('timeupdate', onTime)
        a.addEventListener('ended', onEnded)
        return () => {
          a.pause()
          a.removeEventListener('timeupdate', onTime)
          a.removeEventListener('ended', onEnded)
          audioRef.current = null
          srcRef.current = ''
        }
      }, [])

      const playFile = useCallback((file, { from = 0, selRange = null } = {}) => {
        const a = audioRef.current
        if (!a) return
        const url = `${API_BASE}/bgm-file?name=${encodeURIComponent(file.name)}`
        rangeRef.current = selRange
          ? { active: true, start: selRange.start, end: selRange.end }
          : { active: false, start: 0, end: 0 }
        const isNew = srcRef.current !== url
        if (isNew) {
          a.src = url
          srcRef.current = url
        }
        const startPlayback = () => {
          try { if (from > 0) a.currentTime = Math.min(from, a.duration || from) } catch { /* ignore */ }
          setPlaying(file.name)
        }
        if (isNew || a.paused) {
          a.play().then(startPlayback).catch(() => setPlaying(null))
        } else {
          startPlayback()
        }
      }, [])

      const stop = useCallback(() => {
        const a = audioRef.current
        if (a) a.pause()
        rangeRef.current = { active: false, start: 0, end: 0 }
        setPlaying(null)
      }, [])

      // While loop-previewing, dragging a handle retargets the loop live.
      useEffect(() => {
        if (loopSel && sel && playing === sel.name) {
          rangeRef.current = { active: true, start: trim.start, end: trim.end }
        }
      }, [loopSel, sel, playing, trim])

      const openDetail = useCallback((file) => {
        setSel(file)
        setTrim({ start: 0, end: file.duration || 0 })
        setLoopSel(false)
        setNotice(null)
        setErr('')
      }, [])

      const togglePlayFull = useCallback((file) => {
        if (playing === file.name) { stop(); return }
        setLoopSel(false)
        playFile(file)
      }, [playing, playFile, stop])

      const toggleSelPreview = useCallback(() => {
        if (!sel) return
        if (loopSel && playing === sel.name) { stop(); setLoopSel(false); return }
        setLoopSel(true)
        playFile(sel, { from: trim.start, selRange: { active: true, start: trim.start, end: trim.end } })
      }, [sel, loopSel, playing, trim, playFile, stop])

      const doAction = useCallback(async (mode) => { // 'trim' | 'import'
        if (!sel) return
        setBusy(mode)
        setErr('')
        setNotice(null)
        try {
          const r = await fetch(`${API_BASE}/bgm-${mode}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: sel.name, start: trim.start, end: trim.end, fade }),
          })
          const j = await r.json().catch(() => ({}))
          if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`)
          stop()
          setLoopSel(false)
          setSel(null)
          setNotice({ ok: true, text: `已导入项目：${j.file}${j.duration ? `（${bgmFmtTime(j.duration)}）` : ''}` })
          loadLib()
        } catch (e) {
          setErr(e?.message ?? String(e))
        } finally {
          setBusy('')
        }
      }, [sel, trim, fade, loadLib, stop])

      const openPanel = useCallback(() => {
        setToasts([])
        setOpen(true)
        loadLib()
      }, [loadLib])

      const hasNew = toasts.length > 0
      const files = lib && lib.ok ? lib.files : []
      const noProject = Boolean(lib && lib.ok && !lib.project)

      // ---- toast: freshly generated BGM, floating above the widget ----
      // (suppressed while the panel is already open — the new row is visible there)
      const toastViews = open ? [] : toasts.map((t) => h('div', {
        key: t.name,
        style: {
          position: 'fixed', right: 16, bottom: 68, zIndex: 10001, width: 300,
          background: theme.bg, color: theme.fg,
          border: '1px solid var(--dsh-border, rgba(128,128,128,0.35))',
          borderRadius: 10, padding: '10px 12px', boxShadow: '0 8px 28px rgba(0,0,0,0.35)',
          display: 'flex', flexDirection: 'column', gap: 8,
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            `🎵 新 BGM：${t.name.replace(/\.[^.]+$/, '')}`),
          h('button', {
            onClick: () => setToasts((prev) => prev.filter((p) => p.name !== t.name)),
            style: { border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13, opacity: 0.6, padding: 2 },
          }, '✕')),
        h('div', { style: { fontSize: 11, opacity: 0.6 } }, `时长 ${bgmFmtTime(t.duration)}，太长或不需要开头结尾？可裁剪后导入。`),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { style: S.btn, onClick: openPanel }, '试听 / 裁剪'),
          h('button', { style: S.ghostBtn, onClick: () => setToasts((prev) => prev.filter((p) => p.name !== t.name)) }, '稍后再说')),
      ))

      // ---- rows ----
      const rowStyle = { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, cursor: 'pointer' }
      const rows = files.map((f) => h('div', {
        key: f.name, style: { ...rowStyle, background: sel && sel.name === f.name ? 'rgba(128,128,128,0.12)' : 'transparent' },
        onClick: () => openDetail(f),
        title: f.name,
      },
        h('button', {
          onClick: (e) => { e.stopPropagation(); togglePlayFull(f) },
          style: { width: 26, height: 26, borderRadius: '50%', border: '1px solid var(--dsh-border, rgba(128,128,128,0.4))', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 11, flex: '0 0 auto' },
        }, playing === f.name ? '⏸' : '▶'),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, f.name.replace(/\.[^.]+$/, '')),
          h('div', { style: { fontSize: 11, opacity: 0.55 } }, `${bgmFmtTime(f.duration)} · ${Math.round(f.bytes / 1024)} KB`)),
        f.imported ? h('span', { style: S.pill }, '已导入') : null,
      ))

      const detail = sel ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('button', { style: { ...S.ghostBtn, padding: '4px 8px' }, onClick: () => { stop(); setLoopSel(false); setSel(null) } }, '← 返回'),
          h('span', { style: { fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, sel.name.replace(/\.[^.]+$/, '')),
          h('span', { style: { fontSize: 11, opacity: 0.55 } }, bgmFmtTime(sel.duration))),
        h(BgmWave, {
          name: sel.name, duration: sel.duration, trim, onTrim: setTrim, height: 88,
        }),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 12, opacity: 0.75 } },
          h('span', null, `选中 ${bgmFmtTime(trim.end - trim.start)} / 全长 ${bgmFmtTime(sel.duration)}`),
          h('span', null, `${bgmFmtTime(trim.start)} – ${bgmFmtTime(trim.end)}`)),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h('button', { style: { ...S.ghostBtn, ...(loopSel ? { borderColor: '#4f7cff', color: '#4f7cff' } : null) }, onClick: toggleSelPreview }, loopSel && playing === sel.name ? '⏹ 停止' : '🔁 只听选中段'),
          h('button', { style: { ...S.ghostBtn, ...(fade ? { borderColor: '#4f7cff', color: '#4f7cff' } : null) }, onClick: () => setFade((v) => !v), title: '裁剪点加淡入淡出，避免爆音' }, fade ? '☑' : '☐', ' 淡入淡出'),
          h('button', { style: S.ghostBtn, onClick: () => setTrim({ start: 0, end: sel.duration || 0 }) }, '重置')),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('button', { style: S.btn, disabled: busy !== '' || noProject || trim.end - trim.start < 1, onClick: () => doAction('trim') }, busy === 'trim' ? '裁剪中…' : '✂ 裁剪并导入项目'),
          h('button', { style: S.ghostBtn, disabled: busy !== '' || noProject, onClick: () => doAction('import') }, busy === 'import' ? '导入中…' : '原样导入')),
        noProject ? h('p', { style: { ...S.hint, color: 'var(--dsh-warn, #f08c00)', margin: 0 } }, '当前没打开 Maker 项目工作区（含 assets/ 的目录），导入前请先打开项目。') : null,
      ) : null

      const panel = open ? h('div', {
        style: {
          position: 'fixed', right: 16, bottom: 68, zIndex: 10000, width: 340,
          maxHeight: 'min(560px, 76vh)', overflowY: 'auto',
          background: theme.bg, color: theme.fg,
          border: '1px solid var(--dsh-border, rgba(128,128,128,0.35))', borderRadius: 12,
          boxShadow: '0 8px 32px rgba(0,0,0,0.35)', padding: 14,
          display: 'flex', flexDirection: 'column', gap: 10,
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { fontSize: 14, fontWeight: 600, flex: 1 } }, '🎵 BGM 工作台'),
          h('button', { style: { ...S.ghostBtn, padding: '4px 8px' }, onClick: () => { stop(); setOpen(false) } }, '✕')),
        lib === null ? h('p', { style: S.hint }, '加载中…') : null,
        lib && !lib.ok
          ? h('p', { style: { ...S.hint, color: 'var(--dsh-warn, #f08c00)' } },
            `没连上宿主服务（${lib.error}）。BGM 仍可在对话里生成；导入可用 /taptap-audio import。`)
          : null,
        lib && lib.ok && files.length === 0 && !sel
          ? h('p', { style: { ...S.hint, lineHeight: 1.7 } },
            '还没有 BGM。在对话里说「来个战斗 BGM」即可生成；生成完成后这里会亮起红点，点开就能试听或裁剪。')
          : null,
        !sel && files.length > 0 ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } }, rows) : null,
        detail,
        notice ? h('p', { style: { ...S.ok, margin: 0, wordBreak: 'break-all' } }, notice.text) : null,
        err ? h('p', { style: { ...S.hint, color: 'var(--dsh-danger, #e03131)', margin: 0 } }, `失败：${err}`) : null,
        lib && lib.ok && !sel ? h('p', { style: { ...S.hint, margin: 0 } }, `来自 ${lib.dir}；导入到项目 assets/audio/bgm/ 并自动生成 .meta。`) : null,
      ) : null

      // Fixed floating ball at the bottom-right corner: the old entry was a
      // small pill INLINE in the composer dock — users closed the panel and
      // could not find it again among the dock controls. A fixed ball is
      // always in the same place, directly under the panel/toast it opens.
      return h('span', { style: { position: 'fixed', right: 16, bottom: 16, zIndex: 9998, display: 'inline-flex' } },
        toastViews,
        panel,
        h('button', {
          onClick: open ? () => { stop(); setOpen(false) } : openPanel,
          title: 'BGM 工作台：试听 / 裁剪 / 导入（关闭后仍在这个角落）',
          'aria-label': 'BGM 工作台',
          style: {
            width: 42, height: 42, borderRadius: '50%',
            border: '1px solid var(--dsh-border, rgba(128,128,128,0.4))',
            background: 'var(--dsh-input-bg, rgba(128,128,128,0.12))', color: 'inherit',
            font: 'inherit', fontSize: 18, lineHeight: 1, cursor: 'pointer',
            boxShadow: '0 4px 14px rgba(0,0,0,0.22)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            position: 'relative',
          },
        },
          open ? '✕' : '🎵',
          !open && hasNew ? h('span', { style: { position: 'absolute', top: -1, right: -1, width: 11, height: 11, borderRadius: '50%', background: 'var(--dsh-danger, #e03131)', border: '1.5px solid rgba(255,255,255,0.7)' } }) : null),
      )
    }

    // Error boundary: a broken widget must never take the chat UI down.
    class BgmBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { err: false }
      }
      static getDerivedStateFromError() { return { err: true } }
      componentDidCatch(error) {
        try { console.error('[taptap-maker-dev] BGM widget error:', error) } catch { /* ignore */ }
      }
      render() {
        if (this.state.err) return null
        return h(BgmWidget)
      }
    }

    function LabeledInput(props) {
      return h('div', { style: S.row },
        h('label', { style: S.label }, props.label),
        h('input', {
          style: S.input,
          type: props.secret ? 'password' : 'text',
          value: props.value,
          placeholder: props.placeholder || '',
          onChange: (e) => props.onChange(e.target.value),
          spellCheck: false,
          autoComplete: 'off',
        }),
        props.hint ? h('p', { style: S.hint }, props.hint) : null,
      )
    }

    // Account management IS configuration (which account to use, switching
    // accounts), so it belongs on this page — unlike BGM generation, which is
    // usage and therefore stays in the chat.
    function BgmAccount() {
      const [info, setInfo] = useState(null) // null | 'error' | status object
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')
      const [credits, setCredits] = useState(null)
      const [cfg, setCfg] = useState(null) // { instrumental, count }
      const [newId, setNewId] = useState('')

      const load = useCallback(() => {
        fetch(`${API_BASE}/bgm`, { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('bad'))))
          .then((j) => setInfo(j))
          .catch(() => setInfo('error'))
        fetch(`${API_BASE}/bgm-config`, { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('bad'))))
          .then((j) => setCfg(j))
          .catch(() => setCfg(null))
      }, [])
      useEffect(() => { load() }, [load])

      const saveCfg = useCallback((patch) => {
        setErr('')
        fetch(`${API_BASE}/bgm-config`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
          .then((r) => r.json().then((j) => ({ ok: r.ok, j })).catch(() => ({ ok: false, j: { error: '响应解析失败' } })))
          .then(({ ok, j }) => {
            if (ok && j.ok) setCfg(j)
            else setErr(j.error || '保存失败')
          })
          .catch(() => setErr('保存失败：宿主服务未就绪'))
      }, [])

      const post = useCallback((endpoint, body, tag) => {
        setBusy(tag); setErr('')
        fetch(`${API_BASE}/${endpoint}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
          .then((r) => r.json().then((j) => ({ ok: r.ok, j })).catch(() => ({ ok: false, j: { error: '响应解析失败' } })))
          .then(({ ok, j }) => {
            if (!ok || !j.ok) { setErr(j.error || '操作失败'); return }
            if (j.credits !== undefined) setCredits(j.credits)
            else if (j.totalCredit !== undefined) setCredits(j)
            else setCredits(null)
            load()
          })
          .catch(() => setErr('请求失败：宿主服务未就绪'))
          .finally(() => setBusy(''))
      }, [load])

      const doLogin = useCallback((account) => {
        const tag = account ? `login:${account}` : 'login'
        setBusy(tag); setErr(''); setCredits(null)
        fetch(`${API_BASE}/bgm-login`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(account ? { account } : {}),
        })
          .then((r) => r.json().then((j) => ({ ok: r.ok, j })).catch(() => ({ ok: false, j: { error: '响应解析失败' } })))
          .then(({ ok, j }) => {
            if (!ok || !j.ok) { setErr(j.error || '登录启动失败'); setBusy(''); return }
            let tries = 0
            const timer = setInterval(() => {
              tries += 1
              fetch(`${API_BASE}/bgm`, { headers: { accept: 'application/json' } })
                .then((r) => (r.ok ? r.json() : Promise.reject(new Error('bad'))))
                .then((st) => {
                  // Wait for the SPECIFIC account when one was named.
                  const done = account
                    ? (st.pool?.accounts ?? []).some((a) => a.id === account && a.hasCookies)
                    : st.hasCookies === true
                  if (done || tries >= 60) {
                    clearInterval(timer)
                    setInfo(st)
                    setBusy('')
                    if (!done) setErr('未检测到登录：请在弹出的浏览器里完成登录，再点「刷新」。')
                  }
                })
                .catch(() => { if (tries >= 60) { clearInterval(timer); setBusy('') } })
            }, 3000)
          })
          .catch(() => { setErr('请求失败：宿主服务未就绪'); setBusy('') })
      }, [])

      // 添加账号 = 建条目 + 立刻打开登录（同 ChatGPT 通道）。
      const addAndLogin = useCallback(() => {
        const id = (newId || '').trim()
        if (!id) { setErr('请填账号短名（如 b2、小号）'); return }
        setBusy('add'); setErr('')
        fetch(`${API_BASE}/bgm-pool`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'add', id }),
        })
          .then((r) => r.json().then((j) => ({ ok: r.ok, j })).catch(() => ({ ok: false, j: { error: '响应解析失败' } })))
          .then(({ ok, j }) => {
            if (!ok || !j.ok) { setErr(j.error || '添加失败'); setBusy(''); return }
            setInfo(j)
            setNewId('')
            doLogin(id)
          })
          .catch(() => { setErr('请求失败：宿主服务未就绪'); setBusy('') })
      }, [newId, doLogin])

      // `on` (optional boolean) is for the rotate toggle: without it the server
      // always writes autoRotate=true, which made the switch one-way (you could
      // turn rotation on but never off again). Verified 2026-10-18.
      const poolAction = useCallback((action, id, on) => {
        setBusy(action); setErr('')
        const payload = { action }
        if (id) payload.id = id
        if (typeof on === 'boolean') payload.on = on
        fetch(`${API_BASE}/bgm-pool`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
          .then((r) => r.json().then((j) => ({ ok: r.ok, j })).catch(() => ({ ok: false, j: { error: '响应解析失败' } })))
          .then(({ ok, j }) => { if (ok && j.ok) setInfo(j); else setErr(j.error || '操作失败') })
          .catch(() => setErr('请求失败：宿主服务未就绪'))
          .finally(() => setBusy(''))
      }, [])

      if (info === null) {
        return h('div', { style: S.card },
          h('h2', { style: S.cardTitle }, 'BGM 账号'),
          h('p', { style: { ...S.sub, marginTop: 0 } }, '加载中…'))
      }
      if (info === 'error') {
        return h('div', { style: S.card },
          h('h2', { style: S.cardTitle }, 'BGM 账号'),
          h('p', { style: { ...S.sub, marginTop: 0, color: 'var(--dsh-warn, #f08c00)' } },
            '没连上宿主服务。可用命令 /taptap-bgm login。'))
      }
      const logged = info.hasCookies === true
      const pool = info.pool ?? { accounts: [], total: 0, loggedIn: 0, autoRotate: true, cooling: 0, banned: 0 }
      // 同样去掉「主账号」那一行：它和「+ 添加账号」职责不同却并排摆着，
      // 用户点主账号那行的「登录」并不会新建账号（2026-10-23 反馈）。
      const rows = pool.accounts.map((a) => ({
        id: a.id, key: a.id, isMain: false, status: a.status,
        name: a.label !== a.id ? `${a.id}（${a.label}）` : a.id,
        loggedIn: a.hasCookies === true,
      }))
      const loggedCount = rows.filter((r) => r.loggedIn).length
      const anyLogged = loggedCount > 0
      const headerText = rows.length === 0
        ? '还没有账号。在下面填一个短名，点「添加并登录」，浏览器会直接打开让你登录。'
        : (anyLogged ? `${loggedCount} / ${rows.length} 个账号已登录。` : '所有账号都未登录。')
      return h('div', { style: S.card },
        h('div', { style: S.rowBetween },
          h('div', null,
            h('h2', { style: S.cardTitle }, 'BGM 账号'),
            h('p', { style: { ...S.sub, marginTop: 2 } },
              '生成完整 BGM 用的 MiniMax 账号。可登录、查额度、换号；多个账号可在额度用完时自动轮换。'),
            h('p', { style: { ...S.hint, marginTop: 2 } }, headerText),
            h('span', { style: anyLogged ? S.pill : S.offPill }, anyLogged ? '已登录' : '未登录'),
          ),
        ),
        info.site
          ? h('p', { style: S.hint }, '站点：', h('span', { style: S.codeInline }, info.site.label))
          : null,

        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          rows.map((r) => h('div', {
            key: r.key,
            style: { ...S.rowBetween, padding: '6px 8px', border: '1px solid var(--dsh-border, rgba(128,128,128,0.2))', borderRadius: 6 },
          },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
              h('span', { style: { fontSize: 13, fontWeight: 600 } }, r.name),
              h('span', { style: S.hint },
                r.loggedIn ? '已登录' : '未登录',
                r.status === 'banned' ? ' · 已封禁' : r.status === 'cooling' ? ' · 额度冷却' : '')),
            h('div', { style: { display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' } },
              h('button', {
                style: S.ghostBtn, disabled: busy !== '',
                onClick: () => doLogin(r.id),
              }, busy === `login:${r.id}` ? '登录中…' : (r.loggedIn ? '重登' : '登录')),
              r.loggedIn
                ? h('button', {
                  style: S.ghostBtn, disabled: busy !== '',
                  onClick: () => post('bgm-logout', { account: r.id }),
                }, '退出')
                : null,
              r.loggedIn
                ? h('button', {
                  style: S.ghostBtn, disabled: busy !== '',
                  onClick: () => post('bgm-credits', { account: r.id }),
                }, busy === `credits:${r.id}` ? '查询中…' : '查额度')
                : null,
              h('button', {
                style: S.ghostBtn, disabled: busy !== '',
                onClick: () => poolAction(r.status === 'banned' || r.status === 'cooling' ? 'unban' : 'ban', r.id),
              }, r.status === 'banned' || r.status === 'cooling' ? '恢复' : '封禁'),
              h('button', { style: S.ghostBtn, disabled: busy !== '', onClick: () => poolAction('remove', r.id) }, '移除'),
            )),
          )),

        // 添加账号：**唯一的新增入口**（主账号行已移除），常驻输入框 + 醒目主按钮。
        h('div', { style: { ...S.bar, flexWrap: 'wrap' } },
          h('input', {
            style: { ...S.search, flex: '0 0 auto', width: 170 }, value: newId,
            placeholder: '新账号短名，如 b2', spellCheck: false, autoComplete: 'off',
            onChange: (e) => setNewId(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') addAndLogin() },
          }),
          h('button', { style: S.btn, disabled: busy !== '' || !(newId || '').trim(), onClick: addAndLogin }, '添加并登录'),
          newId
            ? h('button', { style: S.ghostBtn, onClick: () => setNewId('') }, '清空')
            : null,
          err ? h('span', { style: S.warn }, err) : null,
        ),

        credits !== null
          ? h('p', { style: S.hint },
            '剩余额度：', h('span', { style: S.codeInline }, `${credits.totalCredit ?? '?'}`),
            credits.expiresAt ? h('span', { style: S.hint }, `（到期 ${new Date(credits.expiresAt).toLocaleDateString('zh-CN')}）`) : null)
          : null,

        // 轮询：只在有附加账号时可调
        pool.total > 0
          ? h('div', { style: { ...S.rowBetween, marginTop: 6 } },
            h('div', null,
              h('span', { style: { fontSize: 13, fontWeight: 600 } }, '额度用完自动轮换'),
              h('p', { style: { ...S.hint, marginTop: 2 } },
                `附加账号 ${pool.total} 个（已登录 ${pool.loggedIn}，冷却 ${pool.cooling}，封禁 ${pool.banned}）。`)),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', { style: pool.autoRotate ? S.pill : S.offPill }, pool.autoRotate ? '轮换开' : '轮换关'),
              h(Toggle, {
                on: pool.autoRotate !== false,
                disabled: busy !== '',
                onClick: () => poolAction('rotate', undefined, pool.autoRotate === false),
              })),
          )
          : null,

        // 纯音乐开关（默认开）：游戏 BGM 大多不要歌词
        h('div', { style: { ...S.rowBetween, marginTop: 10 } },
          h('div', null,
            h('span', { style: { fontSize: 13, fontWeight: 600 } }, '纯音乐（无歌词）'),
            h('p', { style: { ...S.hint, marginTop: 2 } },
              '游戏 BGM 通常不需要人声，默认开启。')),
          h(Toggle, {
            on: cfg === null ? true : cfg.instrumental !== false,
            onClick: () => saveCfg({ instrumental: !(cfg === null ? true : cfg.instrumental !== false) }),
          }),
        ),
        h('p', { style: { ...S.hint, marginTop: 6 } },
          '「退出」会清除该账号的本机登录态；之后可用同一短名点「添加并登录」重新登录。'),
      )
    }

    // ChatGPT 网页生图 = PRIMARY image lane (2026-10). The relay-station API
    // below is the fallback for when this lane is unavailable.
    // Account pool: several accounts, each with its own browser profile; when
    // one hits its quota the next one is used automatically.
    function GptAccount() {
      const [info, setInfo] = useState(null) // null | 'error' | status
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')
      const [newId, setNewId] = useState('')
      // null = 用 info 里的自定义值；用户一编辑就用自己的输入
      const [dirInput, setDirInput] = useState(null)

      const load = useCallback(() => {
        fetch(`${API_BASE}/gpt`, { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('bad'))))
          .then((j) => setInfo(j))
          .catch(() => setInfo('error'))
      }, [])
      useEffect(() => { load() }, [load])

      const post = useCallback((endpoint, bodyObj) => {
        setErr('')
        return fetch(`${API_BASE}/${endpoint}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(bodyObj ?? {}),
        })
          .then((r) => r.json().then((j) => ({ ok: r.ok, j })).catch(() => ({ ok: false, j: { error: '响应解析失败' } })))
          .then(({ ok, j }) => {
            if (!ok || !j.ok) { setErr(j.error || '操作失败'); return false }
            if (j.pool || j.loggedIn !== undefined) setInfo(j)
            else load()
            return true
          })
          .catch(() => { setErr('请求失败：宿主服务未就绪'); return false })
      }, [load])

      // Poll until the chosen account shows as logged in (or we give up), so
      // the card reflects reality instead of a blind "started".
      const waitForLogin = useCallback((account) => {
        // 「添加账号」是直接调 waitForLogin 的（登录窗口由服务端启动），
        // 不经过 doLogin，所以这里必须自己把按钮置为「登录中…」，
        // 否则用户能连点、反复开一堆窗口。
        setBusy(account ? `login:${account}` : 'login')
        let tries = 0
        const timer = setInterval(() => {
          tries += 1
          fetch(`${API_BASE}/gpt`, { headers: { accept: 'application/json' } })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('bad'))))
            .then((st) => {
              const done = account
                ? (st.pool?.accounts ?? []).some((a) => a.id === account && a.loggedIn)
                : st.loggedIn === true
              if (done || tries >= 60) {
                clearInterval(timer)
                setInfo(st)
                setBusy('')
                if (!done) setErr('未检测到登录：请在弹出的浏览器里完成登录，再点「重新登录」。')
              }
            })
            .catch(() => { if (tries >= 60) { clearInterval(timer); setBusy('') } })
        }, 3000)
      }, [])

      const doLogin = useCallback((account) => {
        setBusy(account ? `login:${account}` : 'login'); setErr('')
        fetch(`${API_BASE}/gpt-login`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(account ? { account } : {}),
        })
          .then((r) => r.json().then((j) => ({ ok: r.ok, j })).catch(() => ({ ok: false, j: { error: '响应解析失败' } })))
          .then(({ ok, j }) => {
            if (!ok || !j.ok) { setErr(j.error || '登录启动失败'); setBusy(''); return }
            waitForLogin(account)
          })
          .catch(() => { setErr('请求失败：宿主服务未就绪'); setBusy('') })
      }, [waitForLogin])

      const doLogout = useCallback((account) => {
        setBusy(account ? `logout:${account}` : 'logout'); setErr('')
        fetch(`${API_BASE}/gpt-logout`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(account ? { account } : {}),
        })
          .then((r) => r.json().then((j) => ({ ok: r.ok, j })).catch(() => ({ ok: false, j: { error: '响应解析失败' } })))
          .then(({ ok, j }) => { if (ok && j.ok) { if (j.pool) setInfo(j); else load() } else setErr(j.error || '退出失败') })
          .catch(() => setErr('请求失败：宿主服务未就绪'))
          .finally(() => setBusy(''))
      }, [load])

      // 添加账号 = 建条目 + 立刻打开登录，一步到位。
      // 之前那个只建不登的「加号」正是被嫌弃鸡肋的原因；这里补上了真正的后半步。
      const addAndLogin = useCallback(() => {
        const id = (newId || '').trim()
        if (!id) { setErr('请填账号短名（如 a2、小号）'); return }
        setBusy('add'); setErr('')
        // 告诉后端「顺便把登录窗口开起来」——服务端已经会 detached spawn，
        // 前端只需进入等待状态。以前是前端 add 完再发一次 /gpt-login，
        // 等于让后端弹两次窗口（第二次会把第一次的 profile 锁清掉，行为很难解释）。
        fetch(`${API_BASE}/gpt-pool`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'add', id, login: true }),
        })
          .then((r) => r.json().then((j) => ({ ok: r.ok, j })).catch(() => ({ ok: false, j: { error: '响应解析失败' } })))
          .then(({ ok, j }) => {
            if (!ok || !j.ok) { setErr(j.error || '添加失败'); setBusy(''); return }
            if (j.warn) setErr(j.warn)
            setInfo(j)
            setNewId('')
            // 登录窗口由服务端启动，这里只负责轮询到「已登录」为止。
            waitForLogin(id)
          })
          .catch(() => { setErr('请求失败：宿主服务未就绪'); setBusy('') })
      }, [newId, doLogin])

      if (info === null) {
        return h('div', { style: S.card },
          h('h2', { style: S.cardTitle }, 'ChatGPT 网页生图'),
          h('p', { style: { ...S.sub, marginTop: 0 } }, '加载中…'))
      }
      if (info === 'error') {
        return h('div', { style: S.card },
          h('h2', { style: S.cardTitle }, 'ChatGPT 网页生图'),
          h('p', { style: { ...S.sub, marginTop: 0, color: 'var(--dsh-warn, #f08c00)' } },
            '没连上宿主服务。可用命令 /taptap-gpt login。'))
      }
      const pool = info.pool ?? { accounts: [], total: 0, loggedIn: 0, autoRotate: true }
      // Master switch: when OFF the lane is disabled end-to-end (CLI refuses,
      // the injected agent policy switches to the relay lane).
      const laneOn = info.laneEnabled !== false
      const dim = { display: 'flex', flexDirection: 'column', gap: 10, opacity: laneOn ? 1 : 0.45 }
      // 账号列表 = 账号池里的每个账号，**不再有「主账号」那一行**。
      // 以前常驻一行「主账号」，和「+ 添加账号」并排放，于是两个入口摆在一起：
      // 用户点主账号那行的「登录」只登默认 profile，并不会新建账号 ——
      // 看着像「添加」，实际不是，最容易误解（2026-10-23 反馈）。
      // 现在唯一的新增入口是下面的「添加并登录」，职责单一、不会认错。
      const rows = pool.accounts.map((a) => ({ ...a, key: a.id, name: a.label !== a.id ? `${a.id}（${a.label}）` : a.id, isMain: false }))
      // 头部状态要说清楚是「几个账号」，而不是笼统的「已登录」：只要池子里有任一
      // 账号登录，顶层就显示「已登录」，但下面那一行可能写着「未登录」——
      // 两处自相矛盾，用户会以为状态坏了。
      const loggedCount = rows.filter((r) => r.loggedIn).length
      const logged = info.loggedIn === true || loggedCount > 0
      const headerText = rows.length === 0
        ? (info.loggedIn === true ? '默认账号已登录，可生成图片。' : '还没有账号。')
        : (logged ? `${loggedCount} / ${rows.length} 个账号已登录，可生成图片。` : '所有账号都未登录。')
      return h('div', { style: S.card },
        h('div', { style: S.rowBetween },
          h('div', null,
            h('h2', { style: S.cardTitle }, 'ChatGPT 网页生图'),
            h('p', { style: { ...S.sub, marginTop: 2 } },
              laneOn
                ? '图片默认走 ChatGPT 网页版（用你自己的账号 / 免费额度）。登录一次即可，登录态存本机。'
                : '已关闭：不会走网页生图，图片改走下面的中转站回退。',
              laneOn ? '下面的中转站是网页通道不可用时的回退。' : '')),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: laneOn ? S.pill : S.offPill }, laneOn ? '开关开' : '开关关'),
            h(Toggle, {
              on: laneOn,
              disabled: busy !== '',
              onClick: () => post('gpt-lane', { enabled: !laneOn }),
            })),
        ),
        h('p', { style: S.hint },
          laneOn
            ? '这个开关决定「网页生图」整条通道是否启用：关掉后模型不会走网页生图，改走中转站回退。'
            : '通道已关闭：模型不会尝试网页生图，改走中转站。需要时打开右上角开关即可恢复。'),

        h('div', { style: dim },
          h('div', { style: S.rowBetween },
            h('div', null,
              h('span', { style: { fontSize: 13, fontWeight: 600 } }, '账号'),
              h('p', { style: { ...S.hint, marginTop: 2 } },
                headerText),
            h('span', { style: logged ? S.pill : S.offPill }, logged ? '已登录' : '未登录'),
          ),

          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            rows.length === 0
              ? h('p', { style: { ...S.hint, margin: 0, padding: '10px 8px', border: '1px dashed var(--dsh-border, rgba(128,128,128,0.3))', borderRadius: 6 } },
                '还没有账号。在下面填一个短名，点「添加并登录」，浏览器会直接打开让你登录。')
              : null,
            rows.map((r) => h('div', {
              key: r.key,
              style: { ...S.rowBetween, padding: '6px 8px', border: '1px solid var(--dsh-border, rgba(128,128,128,0.2))', borderRadius: 6 },
            },
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
                h('span', { style: { fontSize: 13, fontWeight: 600 } }, r.name),
                h('span', { style: S.hint },
                  r.loggedIn ? '已登录' : '未登录',
                  r.status === 'banned' ? ' · 已封禁' : r.status === 'cooling' ? ' · 冷却中' : '')),
              h('div', { style: { display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' } },
                h('button', {
                  style: S.ghostBtn, disabled: busy !== '' || !laneOn,
                  onClick: () => doLogin(r.id),
                }, busy === `login:${r.id}` ? '登录中…' : (r.loggedIn ? '重登' : '登录')),
                r.loggedIn
                  ? h('button', {
                    style: S.ghostBtn, disabled: busy !== '' || !laneOn,
                    onClick: () => doLogout(r.id),
                  }, busy === `logout:${r.id}` ? '退出中…' : '退出')
                  : null,
                h('button', {
                  style: S.ghostBtn, disabled: busy !== '' || !laneOn,
                  onClick: () => post('gpt-pool', { action: r.status === 'banned' || r.status === 'cooling' ? 'unban' : 'ban', id: r.id }),
                }, r.status === 'banned' || r.status === 'cooling' ? '恢复' : '封禁'),
                h('button', { style: S.ghostBtn, disabled: busy !== '' || !laneOn, onClick: () => post('gpt-pool', { action: 'remove', id: r.id }) }, '移除'),
              )),
            )),
          ),
          // 添加账号：**唯一的新增入口**，一步完成「建条目 + 打开登录」。
          // 之前它和「主账号」那一行的「登录」并排摆着，两个入口职责不同却长得
          // 像，用户会点错（2026-10-23 反馈）。现在主账号行已移除，这里也改成
          // 常驻输入框 + 醒目的主按钮，不再需要先点「+ 添加账号」展开。
          h('div', { style: { ...S.bar, flexWrap: 'wrap' } },
            h('input', {
              style: { ...S.search, flex: '0 0 auto', width: 170 }, value: newId,
              placeholder: '新账号短名，如 a2', spellCheck: false, autoComplete: 'off',
              onChange: (e) => setNewId(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') addAndLogin() },
            }),
            h('button', { style: S.btn, disabled: busy !== '' || !laneOn || !(newId || '').trim(), onClick: addAndLogin },
              '添加并登录'),
            newId
              ? h('button', { style: S.ghostBtn, onClick: () => setNewId('') }, '清空')
              : null,
            err ? h('span', { style: S.warn }, err) : null,
          ),
          h('p', { style: S.hint }, '登录会打开真实浏览器，用 Google / Apple / 手机号 / 邮箱登录一次即可。'),

          // 图片落点：默认跟随项目目录（不再丢到 C 盘），也可以自定义。
          h('div', { style: S.row },
            h('label', { style: S.label }, '图片下载目录（默认跟随项目）'),
            h('input', {
              style: S.input,
              value: dirInput === null ? (info.downloadDirConfigured || '') : dirInput,
              placeholder: '留空 = <当前项目>/sucai/images',
              spellCheck: false, autoComplete: 'off',
              onChange: (e) => setDirInput(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') post('gpt-dir', { dir: dirInput === null ? (info.downloadDirConfigured || '') : dirInput })
              },
            }),
            h('div', { style: S.bar },
              h('button', {
                style: S.ghostBtn, disabled: busy !== '',
                onClick: () => post('gpt-dir', { dir: dirInput === null ? (info.downloadDirConfigured || '') : dirInput }),
              }, '保存目录'),
              h('button', {
                style: S.ghostBtn, disabled: busy !== '',
                onClick: () => { setDirInput(''); post('gpt-dir', { dir: '' }) },
              }, '恢复默认（跟随项目）'),
            ),
            h('p', { style: S.hint },
              '留空就跟随当前项目目录（不在项目里时用 $DSH_HOME）。支持 {project}（项目目录）和 {home}（$DSH_HOME）。'),
            h('p', { style: S.hint },
              '当前解析：', h('span', { style: S.codeInline }, info.downloadDir || ''),
              info.downloadDirSource === 'project' ? '（跟随项目）' : info.downloadDirSource === 'config' ? '（自定义）' : '（默认）'),
            h('p', { style: S.hint },
              '目录里会自动放一个 .gitignore，防止生成的图片被 Maker 自动提交。'),
          ),

          // 轮询只在有附加账号时可调；「附加账号 N 个」的口径和主账号分开说，
          // 避免又出现「已登录 / 已登录 0 个」并排的误导。
          pool.total > 0
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 } },
              h('div', { style: S.rowBetween },
                h('div', null,
                  h('span', { style: { fontSize: 13, fontWeight: 600 } }, '轮询'),
                  h('p', { style: { ...S.hint, marginTop: 2 } },
                    `附加账号 ${pool.total} 个（已登录 ${pool.loggedIn}，冷却 ${pool.cooling ?? 0}，封禁 ${pool.banned ?? 0}）。`
                    + '一个触配额自动换下一个；全部触配额后停下（是否换到中转站通道由「生成通道」卡的自动切换开关决定，默认不换）。')),
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                  h('span', { style: pool.autoRotate ? S.pill : S.offPill }, pool.autoRotate ? '轮换开' : '轮换关'),
                  h(Toggle, {
                    on: pool.autoRotate !== false,
                    disabled: !laneOn || busy !== '',
                    onClick: () => post('gpt-pool', { action: 'rotate', on: pool.autoRotate === false }),
                  })),
              ),
              (pool.banned > 0 || pool.cooling > 0)
                ? h('div', { style: S.bar },
                  h('button', { style: S.ghostBtn, disabled: busy !== '' || !laneOn, onClick: () => post('gpt-pool', { action: 'unban' }) }, '恢复全部冷却/封禁'))
                : null,
              h('div', { style: { ...S.warnBox, marginTop: 2 } },
                h('span', { style: S.warnTitle }, '⚠️ 轮询风险'),
                h('p', { style: { ...S.hint, margin: 0 } },
                  '多账号轮流使用会绕过单账号配额，违反 OpenAI 服务条款，且可能导致账号被封。这是你要求的功能，风险由你承担。'),
              ),
            )
            : null,
        ),
      )
    }

    function AudioLibrary() {
      const [info, setInfo] = useState(null) // null | 'error' | {ready,count,cacheDir}
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')

      const load = useCallback(() => {
        fetch(`${API_BASE}/audio`, { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((j) => setInfo(j))
          .catch(() => setInfo('error'))
      }, [])
      useEffect(() => { load() }, [load])

      const sync = useCallback(() => {
        setBusy('sync'); setErr('')
        fetch(`${API_BASE}/audio-sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then((r) => r.json().then((j) => ({ ok: r.ok, j })).catch(() => ({ ok: false, j: { error: '响应解析失败' } })))
          .then(({ ok, j }) => { if (ok && j.ok) load(); else setErr(j.error || '同步失败') })
          .catch(() => setErr('请求失败：宿主服务未就绪'))
          .finally(() => setBusy(''))
      }, [load])

      if (info === null) {
        return h('div', { style: S.card },
          h('h2', { style: S.cardTitle }, '音效素材库'),
          h('p', { style: { ...S.sub, marginTop: 0 } }, '加载中…'))
      }
      const ready = info !== 'error' && info.ready === true
      const count = info !== 'error' ? info.count : 0
      // autoEnsure 关掉时如实显示（否则用户关了开关、界面毫无反馈，
      // 首次用时又只看到一条报错，搞不清两者是一回事）。
      const autoOff = info !== 'error' && info.autoEnsureDisabled === true

      return h('div', { style: S.card },
        h('div', { style: S.rowBetween },
          h('div', null,
            h('h2', { style: S.cardTitle }, '音效素材库'),
            h('p', { style: { ...S.sub, marginTop: 2 } },
              'Kenney 等 CC0 音源，可商用、可修改、无需署名。',
              info === 'error' ? '' : (ready ? ` 本地已有 ${count} 个音频。` : autoOff ? ' 自动下载已关（用下面的按钮手动下载）。' : ' 尚未下载，首次使用自动获取（约 7MB）。'))),
          h('span', { style: ready ? S.pill : S.offPill }, ready ? '已就绪' : (autoOff ? '自动下载已关' : '未下载')),
        ),
        info === 'error'
          ? h('p', { style: { ...S.hint, color: 'var(--dsh-warn, #f08c00)' } },
            '没连上宿主服务。')
          : null,
        h('div', { style: S.bar },
          h('button', { style: S.ghostBtn, disabled: busy !== '', onClick: sync },
            busy === 'sync' ? '下载中…' : (autoOff && !ready ? '下载素材库' : '更新素材库')),
          err ? h('span', { style: S.warn }, err) : null,
        ),
        autoOff
          ? h('p', { style: { ...S.hint, marginTop: 8 } },
            '插件配置里「首次用到时自动下载」已关闭：对话里搜/装音效前需先手动下载一次（上面的按钮）。')
          : null,
        h('p', { style: { ...S.hint, marginTop: 8 } },
          '搜索与安装都在对话里做：说「加个金币音效」即可。'),
      )
    }

    function SkillManager() {
      const [state, setState] = useState({ status: 'loading', skills: [], disabled: [] })
      const [filter, setFilter] = useState('')
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')

      const load = useCallback(() => {
        setState((s) => ({ ...s, status: 'loading' }))
        setErr('')
        fetch(`${API_BASE}/skills`, { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((j) => setState({ status: 'ok', skills: Array.isArray(j.skills) ? j.skills : [], disabled: Array.isArray(j.disabled) ? j.disabled : [] }))
          .catch(() => setState({ status: 'error', skills: [], disabled: [] }))
      }, [])

      useEffect(() => { load() }, [load])

      const persist = useCallback((names) => {
        setBusy(true)
        setErr('')
        fetch(`${API_BASE}/disabled`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ disabled: names }),
        })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((j) => {
            const dis = Array.isArray(j.disabled) ? j.disabled : names
            const set = new Set(dis)
            setState((s) => ({ ...s, disabled: dis, skills: s.skills.map((k) => ({ ...k, disabled: set.has(k.name) })) }))
          })
          .catch(() => setErr('保存失败：宿主 web 服务可能未就绪，可改用 /taptap-skills 命令。'))
          .finally(() => setBusy(false))
      }, [])

      const toggle = useCallback((name, enable) => {
        const cur = new Set(state.disabled)
        if (enable) cur.delete(name)
        else cur.add(name)
        persist([...cur])
      }, [state.disabled, persist])

      if (state.status === 'loading') {
        return h('div', { style: S.card },
          h('h2', { style: S.cardTitle }, 'Skill 管理'),
          h('p', { style: { ...S.sub, marginTop: 0 } }, '加载中…'))
      }
      if (state.status === 'error') {
        return h('div', { style: S.card },
          h('h2', { style: S.cardTitle }, 'Skill 管理'),
          h('p', { style: { ...S.sub, marginTop: 0 } },
            '没连上宿主的 skill 服务（可能此 DSH 组合未启用 web 服务，或刚启动还没就绪）。',
            '可以点「重试」，或改用命令：', h('span', { style: S.codeInline }, '/taptap-skills disable <名>'), '。'),
          h('div', { style: S.bar }, h('button', { style: S.ghostBtn, onClick: load }, '重试')))
      }

      const q = filter.trim().toLowerCase()
      const shown = q.length === 0
        ? state.skills
        : state.skills.filter((k) => k.name.toLowerCase().includes(q) || (k.description || '').toLowerCase().includes(q))
      const activeCount = state.skills.filter((k) => !k.disabled).length

      return h('div', { style: S.card },
        h('h2', { style: S.cardTitle },
          'Skill 管理',
          h('span', { style: S.pill }, `启用 ${activeCount} / 共 ${state.skills.length}`)),
        h('p', { style: { ...S.sub, marginTop: 0 } }, '取消勾选即禁用（不进入 skill 候选），即时保存到本机，无需重启。'),
        h('div', { style: S.bar },
          h('input', {
            style: S.search, value: filter, placeholder: '搜索 skill 名称 / 描述…',
            onChange: (e) => setFilter(e.target.value), spellCheck: false,
          }),
          h('button', { style: S.ghostBtn, disabled: busy, onClick: () => persist([]) }, '全部启用'),
          h('button', { style: S.ghostBtn, disabled: busy, onClick: load }, '刷新'),
        ),
        err ? h('p', { style: { ...S.hint, color: 'var(--dsh-warn, #f08c00)' } }, err) : null,
        h('div', { style: S.scrollBox },
          shown.length === 0
            ? h('p', { style: { ...S.hint, padding: 8 } }, '没有匹配的 skill。')
            : shown.map((k) => h('label', {
              key: k.name,
              style: { ...S.skillRow, opacity: k.disabled ? 0.5 : 1 },
            },
              h('input', {
                type: 'checkbox', checked: !k.disabled, disabled: busy,
                onChange: (e) => toggle(k.name, e.target.checked),
                style: { marginTop: 2 },
              }),
              h('div', { style: S.skillMeta },
                h('span', { style: S.skillName }, k.name),
                k.description ? h('span', { style: S.skillDesc }, k.description) : null,
              ),
            )),
        ),
      )
    }

    function ImageConfig() {
      const [form, setForm] = useState(null) // null=loading
      const [bridgeDown, setBridgeDown] = useState(false)
      const [status, setStatus] = useState('') // ''|'saving'|'saved'|'error'
      const [models, setModels] = useState(null) // null|'loading'|'error'|[ids]
      const [modelsErr, setModelsErr] = useState('')
      const [copied, setCopied] = useState('')

      const load = useCallback(() => {
        fetch(`${API_BASE}/image`, { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((j) => { setBridgeDown(false); setForm({ baseURL: j.baseURL || '', apiKey: j.apiKey || '', model: j.model || '', size: j.size || '1024x1024' }) })
          .catch(() => { setBridgeDown(true); setForm({ baseURL: '', apiKey: '', model: '', size: '1024x1024' }) })
      }, [])
      useEffect(() => { load() }, [load])

      const set = useCallback((k, v) => setForm((f) => ({ ...(f || {}), [k]: v })), [])

      const save = useCallback(() => {
        if (!form) return
        setStatus('saving')
        fetch(`${API_BASE}/image`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then(() => { setStatus('saved'); setBridgeDown(false); try { setTimeout(() => setStatus(''), 2500) } catch (_e) { /* no-op */ } })
          .catch(() => { setStatus('error'); setBridgeDown(true) })
      }, [form])

      const getModels = useCallback(() => {
        if (!form) return
        setModels('loading'); setModelsErr('')
        fetch(`${API_BASE}/models`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseURL: form.baseURL, apiKey: form.apiKey }) })
          .then((r) => r.json().then((j) => ({ ok: r.ok, j })).catch(() => ({ ok: false, j: { error: '响应解析失败' } })))
          .then(({ ok, j }) => {
            if (ok && j.ok && Array.isArray(j.models)) setModels(j.models)
            else { setModels('error'); setModelsErr(j.error || '获取失败') }
          })
          .catch(() => { setModels('error'); setModelsErr('请求失败：宿主 web 服务可能未就绪。') })
      }, [form])

      const onCopy = useCallback(() => {
        const ok = copyText(buildImageJson(form || { baseURL: '', apiKey: '', model: '', size: '1024x1024' }))
        setCopied(ok ? 'ok' : 'fail')
        try { setTimeout(() => setCopied(''), 2000) } catch (_e) { /* no-op */ }
      }, [form])

      if (form === null) {
        return h('div', { style: S.card },
          h('h2', { style: S.cardTitle }, '中转站生图（回退 · OpenAI 兼容 /images）'),
          h('p', { style: { ...S.sub, marginTop: 0 } }, '加载中…'))
      }

      return h('div', { style: S.card },
        h('h2', { style: S.cardTitle }, '中转站生图（回退 · OpenAI 兼容 /images）'),
        h('p', { style: { ...S.sub, marginTop: 0 } },
          '网页通道（上一张卡）不可用时的回退：未登录 / 账号都触配额 / 选择器失效。填好点「保存」即写入本机 image.json，即时生效、无需重启。Key 不进工作区、不进包。'),
        bridgeDown ? h('p', { style: { ...S.hint, color: 'var(--dsh-warn, #f08c00)' } },
          '宿主 web 服务未就绪，暂不能自动保存。可先填好用「复制 JSON」粘到 image.json；服务就绪后再点「保存」。') : null,
        h(LabeledInput, {
          label: 'Base URL', value: form.baseURL, onChange: (v) => set('baseURL', v),
          placeholder: 'https://your-endpoint/v1', hint: '填到 /v1 这层，代码会自动拼 /images/generations（获取模型用 /models）。',
        }),
        h(LabeledInput, {
          label: 'API Key（留空 = 不修改）', value: form.apiKey, onChange: (v) => set('apiKey', v), secret: true,
          placeholder: 'sk-...', hint: '仅保存在本机 image.json。已保存的 Key 不回显明文；换 Key 直接粘贴新的即可。',
        }),
        h('div', { style: S.row },
          h('label', { style: S.label }, 'Model'),
          h('input', {
            style: S.input, value: form.model, placeholder: 'gpt-image-2.5 / 你的生图模型 id',
            onChange: (e) => set('model', e.target.value), spellCheck: false, autoComplete: 'off',
          }),
          Array.isArray(models)
            ? (models.length > 0
              ? h('select', { style: S.input, value: '', onChange: (e) => { if (e.target.value) set('model', e.target.value) } },
                [h('option', { key: '__', value: '' }, `从 ${models.length} 个模型中选择…`),
                  ...models.map((m) => h('option', { key: m, value: m }, m))])
              : h('p', { style: S.hint }, '端点 /models 未返回任何模型。'))
            : null,
          models === 'error' ? h('p', { style: { ...S.hint, color: 'var(--dsh-warn, #f08c00)' } }, `获取模型失败：${modelsErr}`) : null,
        ),
        h('div', { style: S.row },
          h('label', { style: S.label }, '缺省尺寸（仅作回退；每次调用可用 --size 覆盖，尺寸不固定）'),
          h('select', { style: S.input, value: form.size, onChange: (e) => set('size', e.target.value) },
            SIZES.map((s) => h('option', { key: s, value: s }, s))),
        ),
        h('div', { style: S.bar },
          h('button', { style: S.btn, disabled: status === 'saving', onClick: save }, status === 'saving' ? '保存中…' : '保存'),
          h('button', { style: S.ghostBtn, disabled: models === 'loading', onClick: getModels }, models === 'loading' ? '获取中…' : '获取模型'),
          h('button', { style: S.ghostBtn, onClick: onCopy }, '复制 JSON'),
          status === 'saved' ? h('span', { style: S.ok }, '已保存 ✓ 即时生效') : null,
          status === 'error' ? h('span', { style: S.warn }, '保存失败') : null,
          copied === 'ok' ? h('span', { style: S.ok }, '已复制') : null,
          copied === 'fail' ? h('span', { style: S.warn }, '复制失败') : null,
        ),
      )
    }

    /**
     * 通道优先级 + 各通道开关。
     *
     * 这是「走哪条 / 额度不够时换不换」的唯一权威界面：底层三条链路
     * （生图 / 视频 / BGM）都读这一份排序。
     *
     * 交互刻意做成**拖拽 + 上移/下移**两套：拖拽给鼠标用户，上移下移给触屏和
     * 键盘用户 —— 只做拖拽会让后者完全无法调序，那不是「少个功能」而是「用不了」。
     *
     * 每行同时显示三个独立状态：开关（我要不要用它）、顺序（第几顺位）、
     * 就绪（配好没有）。把「关着」和「开着但没配」分开显示是关键 —— 这两件事
     * 的下一步动作完全不同（前者不用管，后者要去填 Key）。
     */
    function LanePriorityCard() {
      const [data, setData] = useState(null)
      const [saving, setSaving] = useState('')
      const [dragId, setDragId] = useState(null)
      const [overId, setOverId] = useState(null)

      const load = useCallback(() => {
        fetch(`${API_BASE}/lanes`, { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then(setData)
          .catch(() => setData({ error: true, groups: {}, autoFallback: false }))
      }, [])
      useEffect(() => { load() }, [load])

      const save = useCallback((patch, tag) => {
        setSaving(tag)
        fetch(`${API_BASE}/lanes`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
        })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((j) => { setData((prev) => (prev ? { ...prev, ...j } : j)); setSaving(''); try { setTimeout(() => setSaving(''), 1500) } catch (_e) { /* no-op */ } })
          .catch(() => setSaving('error'))
      }, [])

      /** 移动一条通道。idx 传 -1 表示插到最前。 */
      const move = useCallback((group, id, to) => {
        setData((prev) => {
          if (!prev || !prev.groups[group]) return prev
          const cur = prev.groups[group].lanes.map((l) => l.id)
          const from = cur.indexOf(id)
          if (from < 0) return prev
          const clamped = Math.max(0, Math.min(cur.length - 1, to))
          if (from === clamped) return prev
          cur.splice(clamped, 0, ...cur.splice(from, 1))
          save({ groups: { [group]: { order: cur } } }, group)
          return { ...prev, groups: { ...prev.groups, [group]: { ...prev.groups[group], lanes: prev.groups[group].lanes } } }
        })
      }, [save])

      const toggleLane = useCallback((group, id) => {
        setData((prev) => {
          if (!prev || !prev.groups[group]) return prev
          const lanes = prev.groups[group].lanes
          const target = lanes.find((l) => l.id === id)
          if (!target) return prev
          const onCount = lanes.filter((l) => l.enabled).length
          if (target.enabled && onCount <= 1) return prev // 后端也会挡，这里先给反馈
          save({ groups: { [group]: { enabled: { [id]: !target.enabled } } } }, group)
          return prev
        })
      }, [save])

      if (!data) return h('div', { style: S.card }, h('h2', { style: S.cardTitle }, '生成通道优先级'), h('p', { style: { ...S.sub, marginTop: 0 } }, '加载中…'))

      if (data.error) {
        return h('div', { style: S.card },
          h('h2', { style: S.cardTitle }, '生成通道优先级'),
          h('p', { style: { ...S.hint, color: 'var(--dsh-warn, #f08c00)' } }, '宿主 web 服务未就绪，暂时读不到通道配置。'))
      }

      const groups = Object.entries(data.groups || {})
      const readyCount = (g) => g.lanes.filter((l) => l.enabled && l.ready).length
      const dirLabel = { image: '图片', video: '视频', bgm: '背景音乐' }
      const dirSourceText = { project: '跟随当前项目', flag: '本次指定', config: '设置页指定', default: '当前不在项目里，已退回 $DSH_HOME' }

      return h('div', { style: S.card },
        h('h2', { style: S.cardTitle }, '生成通道优先级'),
        h('p', { style: { ...S.sub, marginTop: 0 } },
          '从上到下就是使用顺序：额度或配额不够时会往下换。每一行左侧的开关决定这条通道要不要参与，右侧圆点表示它现在配好了没有。'),

        // 素材落点：三类统一收在 sucai/ 下，如实显示真实路径。
        data.dirs
          ? h('div', { style: { marginTop: 12, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--dsh-border, rgba(128,128,128,0.25))' } },
            h('div', { style: { fontWeight: 600, fontSize: 13, marginBottom: 4 } }, '素材存到哪里'),
            h('div', { style: { fontSize: 12, opacity: 0.75, marginBottom: 6 } },
              '在 Maker 项目目录里执行时，三类素材统一收在 ', h('span', { style: S.codeInline }, '<项目>/sucai/'), ' 下，并自动忽略提交。'),
            ...Object.entries(data.dirs).map(([kind, d]) => h('div', {
              key: kind, style: { display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 12, marginTop: 2 },
            },
              h('span', { style: { minWidth: 56, opacity: 0.7 } }, dirLabel[kind] ?? kind),
              h('span', { style: { ...S.codeInline, fontSize: 11 } }, d.dir),
              h('span', { style: { opacity: 0.55 } }, dirSourceText[d.source] ?? d.source))))
          : null,

        h('div', { style: { ...S.rowBetween, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--dsh-border, rgba(128,128,128,0.25))' } },
          h('div', null,
            h('div', { style: { fontWeight: 600 } }, '额度不足时自动换下一条通道'),
            h('p', { style: { ...S.hint, margin: '2px 0 0' } },
              '默认关闭 —— 打开后可能在你不知情的情况下动用付费通道（如中转站）。只有「额度/配额」类失败才换，参数写错这类问题换了也一样错，不会浪费一轮。'),
            h('p', { style: { ...S.hint, margin: '4px 0 0' } },
              '⚠️ 关着时网页提示「今日免费额度已用完」等配额信息不会换通道：同一通道内的多账号轮换仍会做（上面的「轮换」开关），但不会跳到下一条通道 —— 会停下并把每条通道的失败原因列给你，由你决定切换、补账号还是等额度恢复。')),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: data.autoFallback ? S.pill : S.offPill }, data.autoFallback ? '自动切换开' : '自动切换关'),
            h(Toggle, {
              on: data.autoFallback, disabled: saving !== '',
              onClick: () => save({ autoFallback: !data.autoFallback }, 'fb'),
            }))),

        ...groups.map(([group, g]) => h('div', { key: group, style: { marginTop: 16 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
            h('span', { style: { fontWeight: 600, fontSize: 13 } }, g.label),
            h('span', { style: S.pill }, `可用 ${readyCount(g)} / 共 ${g.lanes.length}`)),

          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            ...g.lanes.map((lane, i) => {
              const isOver = overId === lane.id && dragId !== lane.id
              const dim = !lane.enabled
              return h('div', {
                key: lane.id,
                draggable: !dim,
                onDragStart: (e) => { setDragId(lane.id); try { e.dataTransfer.effectAllowed = 'move' } catch (_e) { /* no-op */ } },
                onDragOver: (e) => { e.preventDefault(); setOverId(lane.id) },
                onDragLeave: () => setOverId((v) => (v === lane.id ? null : v)),
                onDrop: (e) => {
                  e.preventDefault()
                  if (dragId && dragId !== lane.id) move(group, dragId, i)
                  setDragId(null); setOverId(null)
                },
                onDragEnd: () => { setDragId(null); setOverId(null) },
                style: {
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                  borderRadius: 8, border: '1px solid var(--dsh-border, rgba(128,128,128,0.25))',
                  background: isOver ? 'var(--dsh-accent-soft, rgba(80,160,255,0.12))' : 'transparent',
                  opacity: dim ? 0.55 : 1,
                  borderLeft: i === 0 && !dim ? '3px solid var(--dsh-accent, #4a9eff)' : '1px solid var(--dsh-border, rgba(128,128,128,0.25))',
                  cursor: dim ? 'default' : 'grab',
                },
              },
                h('span', { style: { fontSize: 13, opacity: 0.6, minWidth: 16, textAlign: 'center' } }, dim ? '—' : i + 1),
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                    h('span', { style: { fontWeight: 500, fontSize: 13 } }, lane.label),
                    lane.zeroCost ? h('span', { style: S.offPill }, '零额度') : null),
                  h('p', { style: { ...S.hint, margin: '1px 0 0', fontSize: 12 } },
                    lane.note + (lane.reason ? ` — ${lane.reason}` : ''))),
                h(StatusChip, {
                  on: lane.ready,
                  label: lane.ready ? '已就绪' : '未配置',
                  title: lane.ready ? '现在就能用' : (lane.reason || '尚未配置'),
                }),
                // 触屏 / 键盘可达：拖拽之外的第二条排序路径
                h('button', {
                  type: 'button', title: '上移', disabled: dim || i === 0, 'aria-label': `${lane.label} 上移`,
                  style: { ...S.ghostBtn, padding: '2px 8px', opacity: dim || i === 0 ? 0.35 : 1 },
                  onClick: () => move(group, lane.id, i - 1),
                }, '↑'),
                h('button', {
                  type: 'button', title: '下移', disabled: dim || i === g.lanes.length - 1, 'aria-label': `${lane.label} 下移`,
                  style: { ...S.ghostBtn, padding: '2px 8px', opacity: dim || i === g.lanes.length - 1 ? 0.35 : 1 },
                  onClick: () => move(group, lane.id, i + 1),
                }, '↓'),
                h(Toggle, { on: lane.enabled, disabled: saving === group, onClick: () => toggleLane(group, lane.id) }),
              )
            })),
        )),

        saving === 'error' ? h('p', { style: { ...S.hint, color: 'var(--dsh-warn, #f08c00)' } }, '保存失败，请重试') : null,
        h('p', { style: { ...S.hint, marginTop: 12, fontSize: 12 } },
          '保存于 ', h('span', { style: S.codeInline }, data.file || 'lanes.json'), '，即时生效、无需重启。所有通道都被关掉时系统会自动保留一条，避免把自己锁死。'),
      )
    }

    /**
     * 视频生成配置。
     *
     * 三段式，对应三种真正的使用场景（不是一个设置表单拆零碎）：
     *   1. 走哪条：后端优先级（auto / 官方 / 中转站 / 自选本地视频）；
     *   2. MiniMax 共用：Key + 站点 + 模型 —— 订阅 Key 与按量 Key 都填这里；
     *   3. 中转站 / 自选本地视频。
     *
     * 每一段右下角都有「现在能不能用」的状态点，不要让人配完还要去对话里试。
     */
    function VideoConfig() {
      const [relay, setRelay] = useState(null) // null=loading
      const [mmx, setMmx] = useState({ apiKey: '', baseURL: '', model: '' })
      const [backends, setBackends] = useState({ relay: false, minimax: false, local: true })
      const [keyKindText, setKeyKindText] = useState('')
      const [protocol, setProtocol] = useState('openai')
      const [showAdvanced, setShowAdvanced] = useState(false)
      const [status, setStatus] = useState('')
      const [models, setModels] = useState(null)
      const [modelsErr, setModelsErr] = useState('')
      const [down, setDown] = useState(false)

      const load = useCallback(() => {
        fetch(`${API_BASE}/video-relay`, { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((j) => {
            setDown(false)
            setRelay(j.relay || {})
            setProtocol((j.relay && j.relay.protocol) || 'openai')
            setBackends(j.backends || { relay: false, minimax: false, local: true })
            setKeyKindText((j.minimax && j.minimax.keyKindText) || '')
            // Minimax 的 Key 不回显：后端只回「有没有」，设置页沿用「留空=不修改」的惯例。
            setMmx({ apiKey: '', baseURL: (j.minimax && j.minimax.baseURL) || '', model: (j.minimax && j.minimax.model) || '' })
          })
          .catch(() => { setDown(true); setRelay({}); })
      }, [])
      useEffect(() => { load() }, [load])

      const setR = useCallback((k, v) => setRelay((f) => ({ ...(f || {}), [k]: v })), [])
      const setM = useCallback((k, v) => setMmx((f) => ({ ...f, [k]: v })), [])

      const saveRelay = useCallback(() => {
        if (!relay) return
        setStatus('saving')
        fetch(`${API_BASE}/video-relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(relay) })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((j) => { setStatus('saved'); setBackends(j.backends || backends); setDown(false); try { setTimeout(() => setStatus(''), 2500) } catch (_e) { /* no-op */ } })
          .catch(() => { setStatus('error'); setDown(true) })
      }, [relay, backends])

      const saveMmx = useCallback(() => {
        setStatus('saving')
        fetch(`${API_BASE}/video-minimax`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mmx) })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((j) => { setStatus('saved'); setKeyKindText(j.keyKindText || ''); setBackends((b) => ({ ...b, minimax: Boolean(j.hasApiKey) })); setMmx((f) => ({ ...f, apiKey: '' })) })
          .catch(() => setStatus('error'))
      }, [mmx])

      const getModels = useCallback(() => {
        if (!relay) return
        setModels('loading'); setModelsErr('')
        fetch(`${API_BASE}/video-relay/models`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseURL: relay.baseURL, apiKey: relay.apiKey }) })
          .then((r) => r.json().then((j) => ({ ok: r.ok, j })).catch(() => ({ ok: false, j: { error: '响应解析失败' } })))
          .then(({ ok, j }) => {
            if (ok && j.ok && Array.isArray(j.models)) setModels(j.models)
            else { setModels('error'); setModelsErr(j.error || '获取失败') }
          })
          .catch(() => { setModels('error'); setModelsErr('请求失败：宿主 web 服务可能未就绪。') })
      }, [relay])

      if (relay === null) {
        return h('div', { style: S.card }, h('h2', { style: S.cardTitle }, '🎬 视频生成'), h('p', { style: { ...S.sub, marginTop: 0 } }, '加载中…'))
      }

      const relayOn = Boolean(relay.enabled)
      const generic = (relay.protocol || protocol) === 'generic'
      // 不内置型号能力表 —— 提交后的 400 原文会直接回显给用户。

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
        // ────────── 1. 后端优先级 ──────────
        h('div', { style: S.card },
          h('h2', { style: S.cardTitle }, '🎬 视频生成 · 走哪条通道'),
          h('p', { style: { ...S.sub, marginTop: 0 } },
            '三个后端任选或让插件自动挑。只有「出视频」花钱；抽帧 / 抠像 / 合成 / 导入全本地、反复调不产生费用。'),
          h('div', { style: S.overview },
            h(StatusChip, { on: backends.relay, label: '中转站', title: backends.relay ? '已配置，可出片' : '未配置或未启用' }),
            h(StatusChip, { on: backends.minimax, label: 'MiniMax', title: backends.minimax ? '有可用 Key' : '没有 Key' }),
            h(StatusChip, { on: true, label: '自选本地视频', title: '始终可用，零额度' })),
          h('p', { style: S.hint },
            'auto 的优先级：先看你是否配了中转站（配了说明你想用它），其次 MiniMax Key，最后落到「没配好」的明确报错。'),
        ),

        // ────────── 2. MiniMax（订阅 / 按量共用） ──────────
        h('div', { style: S.card },
          h('h2', { style: S.cardTitle }, 'MiniMax（订阅 Key 与按量 Key 都填这里）'),
          h('p', { style: { ...S.sub, marginTop: 0 } },
            '两种 Key 打的是同一批接口，只有额度来源不同。M Plan 订阅扣套餐额度',
            '（视频模型要 Explore/Build 档），按量扣账户余额（任何档位都能出片）。',
            h('br'),
            'Key 形态不止 ',
            h('span', { style: S.codeInline }, 'sk-cp-…'),
            ' / ',
            h('span', { style: S.codeInline }, 'sk-api-…'),
            '：控制台签发的都是 JWT 长得一样，光看字符串分不出订阅还是按量——',
            '以 ',
            h('span', { style: S.codeInline }, '/taptap-video doctor'),
            ' 的实测结果为准。'),
          keyKindText ? h('p', { style: S.hint }, keyKindText) : null,
          h(LabeledInput, {
            label: 'API Key（留空 = 不修改；当前状态见下方提示）',
            value: mmx.apiKey, onChange: (v) => setM('apiKey', v), secret: true,
            placeholder: backends.minimax ? '已配置（留空保持不变）' : '订阅 / 按量 Key 都行，直接粘贴',
            hint: '仅保存在本机 minimax.json。留空时会自动用环境变量 MINIMAX_API_KEY 或本机 mmx 登录态。',
          }),
          h('div', { style: S.row },
            h('label', { style: S.label }, '站点'),
            h('select', { style: S.input, value: mmx.baseURL, onChange: (e) => setM('baseURL', e.target.value) },
              h('option', { value: 'https://api.minimaxi.com' }, '国内站 api.minimaxi.com（人民币计费）'),
              h('option', { value: 'https://api.minimax.io' }, '国际站 api.minimax.io（美元计费）'))),
          h('div', { style: S.row },
            h('label', { style: S.label }, '模型'),
            h('select', { style: S.input, value: mmx.model, onChange: (e) => setM('model', e.target.value) },
              h('option', { value: 'MiniMax-H3' }, 'MiniMax-H3 · 768P/2K · 首尾帧（推荐）'),
              h('option', { value: 'MiniMax-H3-Max' }, 'MiniMax-H3-Max · 极速'),
              h('option', { value: 'MiniMax-Hailuo-02' }, 'MiniMax-Hailuo-02 · v1 首尾帧'),
              h('option', { value: 'MiniMax-Hailuo-2.3' }, 'MiniMax-Hailuo-2.3 · 只支持首帧'),
              h('option', { value: 'MiniMax-Hailuo-2.3-Fast' }, 'MiniMax-Hailuo-2.3-Fast · 只支持首帧'))),
          h('div', { style: S.bar },
            h('button', { style: S.btn, disabled: status === 'saving', onClick: saveMmx }, '保存 MiniMax 配置'),
            status === 'saved' ? h('span', { style: S.ok }, '已保存 ✓ 即时生效') : null,
            status === 'error' ? h('span', { style: S.warn }, '保存失败') : null),
        ),

        // ────────── 3. 中转站 ──────────
        h('div', { style: S.card },
          h('div', { style: S.rowBetween },
            h('h2', { style: S.cardTitle }, '视频中转站（OpenAI 兼容 / 自定义端点）'),
            h('label', { style: { ...S.label, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' } },
              h('input', { type: 'checkbox', checked: relayOn, onChange: (e) => setR('enabled', e.target.checked) }),
              relayOn ? '已启用' : '未启用')),
          h('p', { style: { ...S.sub, marginTop: 0 } },
            '和「中转站生图」同一套逻辑：用你自己的地址 / Key / 模型，不花 Maker 额度和 MiniMax 额度。'),
          down ? h('p', { style: { ...S.hint, color: 'var(--dsh-warn, #f08c00)' } },
            '宿主 web 服务未就绪，暂不能自动保存。可先填好，服务就绪后再点保存。') : null,

          h('div', { style: S.row },
            h('label', { style: S.label }, '协议'),
            h('select', { style: S.input, value: relay.protocol || 'openai', onChange: (e) => setR('protocol', e.target.value) },
              h('option', { value: 'openai' }, 'OpenAI 兼容 /videos（最通用）'),
              h('option', { value: 'minimax' }, 'MiniMax 协议（中转站代理了 MiniMax）'),
              h('option', { value: 'generic' }, '自定义（自己填路径与字段映射）'))),

          h(LabeledInput, {
            label: 'Base URL', value: relay.baseURL || '', onChange: (v) => setR('baseURL', v),
            placeholder: 'https://your-relay.example.com/v1', hint: '填到 /v1 这层即可，粘整条 /videos 路径也会自动收敛。',
          }),
          h(LabeledInput, {
            label: 'API Key（留空 = 不修改）', value: relay.apiKey || '', onChange: (v) => setR('apiKey', v), secret: true,
            placeholder: backends.relay ? '已配置（留空保持不变）' : 'sk-...',
            hint: '仅保存在本机 video-relay.json。已保存的 Key 不回显明文；换 Key 直接粘贴新的即可。',
          }),
          h('div', { style: S.row },
            h('label', { style: S.label }, '模型'),
            h('input', {
              style: S.input, value: relay.model || '', placeholder: '你的中转站视频模型 id',
              onChange: (e) => setR('model', e.target.value), spellCheck: false, autoComplete: 'off',
            }),
            // 不预设已知型号：中转站可以自加型号、改名，列表会很快过时；
            // 让用户从自己端点的 /models 拉，或者手填。
            Array.isArray(models)
              ? (models.length > 0
                ? h('select', { style: S.input, value: '', onChange: (e) => { if (e.target.value) setR('model', e.target.value) } },
                  [h('option', { key: '__', value: '' }, `从你的端点 /models 选（${models.length} 个）…`),
                    ...models.map((m) => h('option', { key: m, value: m }, m))])
                : h('p', { style: S.hint }, '端点 /models 未返回任何模型（有些中转站禁用该接口，直接手填即可）。'))
              : null,
            models === 'error' ? h('p', { style: { ...S.hint, color: 'var(--dsh-warn, #f08c00)' } }, `获取模型失败：${modelsErr}`) : null),

          h('button', { style: { ...S.ghostBtn, alignSelf: 'flex-start' }, onClick: () => setShowAdvanced((v) => !v) },
            showAdvanced ? '▾ 收起高级选项' : '▸ 高级选项（时长 / 画幅 / 字段映射）'),
          showAdvanced ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
            h('div', { style: S.bar },
              h('div', { style: { ...S.row, flex: 1 } },
                h('label', { style: S.label }, '时长（秒，整数）'),
                h('input', { style: S.input, type: 'number', min: 1, max: 60, value: relay.seconds ?? 4, onChange: (e) => setR('seconds', Number(e.target.value)) })),
              h('div', { style: { ...S.row, flex: 1 } },
                h('label', { style: S.label }, '画幅（metadata.ratio）'),
                h('select', { style: S.input, value: relay.ratio || '16:9', onChange: (e) => setR('ratio', e.target.value) },
                  ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'auto'].map((r) => h('option', { key: r, value: r }, r))))),
            h('p', { style: S.hint },
              '不内置型号限制表 —— 你填的时长 / 画幅不在中转站支持的范围内时，平台会返回 400，错误原文会直接回显。'),
            h('div', { style: S.row },
              h('label', { style: S.label }, '参考素材字段形态'),
              h('select', { style: S.input, value: relay.referenceStyle || 'metadata', onChange: (e) => setR('referenceStyle', e.target.value) },
                h('option', { value: 'metadata' }, 'metadata.mode + first_frame_url / last_frame_url（多数 /videos 兼容站）'),
                h('option', { value: 'input_reference' }, 'input_reference 数组（OpenAI 官方风格）')),
              h('p', { style: S.hint }, '两种都是公共约定，不是某家的私有格式。选错会拿到 400，换一个再试即可。')),
            h('div', { style: S.row },
              h('label', { style: S.label }, '尺寸（留空 = 由型号决定，不要用它升降清晰度）'),
              h('input', { style: S.input, value: relay.size || '', onChange: (e) => setR('size', e.target.value), placeholder: '留空' })),
            h(LabeledInput, {
              label: '参考素材上传路径', value: relay.assetUploadPath || '',
              onChange: (v) => setR('assetUploadPath', v),
              hint: '本机图片会先传到这里换公网 url（每家中转站不一样，留空则拒绝本地图片、要求直接传公网 URL）',
            }),
            generic ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
              h('p', { style: S.hint }, '自定义协议：按中转站文档填路径与「响应里的字段路径」。{taskId} 会被替换成任务 id。'),
              h('div', { style: S.bar },
                h('div', { style: { ...S.row, flex: 1 } }, h('label', { style: S.label }, '提交方法'), h('input', { style: S.input, value: relay.submitMethod || 'POST', onChange: (e) => setR('submitMethod', e.target.value) })),
                h('div', { style: { ...S.row, flex: 2 } }, h('label', { style: S.label }, '提交路径'), h('input', { style: S.input, value: relay.submitPath || '/videos', onChange: (e) => setR('submitPath', e.target.value) }))),
              h('div', { style: S.bar },
                h('div', { style: { ...S.row, flex: 1 } }, h('label', { style: S.label }, '查询方法'), h('input', { style: S.input, value: relay.queryMethod || 'GET', onChange: (e) => setR('queryMethod', e.target.value) })),
                h('div', { style: { ...S.row, flex: 2 } }, h('label', { style: S.label }, '查询路径'), h('input', { style: S.input, value: relay.queryPath || '/videos/{taskId}', onChange: (e) => setR('queryPath', e.target.value) }))),
              h(LabeledInput, { label: '任务 id 字段路径', value: relay.taskIdPath || 'id', onChange: (v) => setR('taskIdPath', v), hint: '默认 id；嵌套写法 data.task_id' }),
              h(LabeledInput, { label: '状态字段路径', value: relay.statusPath || 'status', onChange: (v) => setR('statusPath', v) }),
              h(LabeledInput, { label: '视频地址字段路径', value: relay.videoUrlPath || '', onChange: (v) => setR('videoUrlPath', v), hint: '响应里视频 URL 的字段路径，例如 data.output.url（必填，否则成功后拿不到片子）' }),
              h(LabeledInput, { label: '完成状态值', value: Array.isArray(relay.doneValues) ? relay.doneValues.join(',') : (relay.doneValues || 'succeeded,completed,success'), onChange: (v) => setR('doneValues', v), hint: '逗号分隔' }),
              h(LabeledInput, { label: '失败状态值', value: Array.isArray(relay.failedValues) ? relay.failedValues.join(',') : (relay.failedValues || 'failed,error,cancelled'), onChange: (v) => setR('failedValues', v), hint: '逗号分隔' }),
            ) : null,
          ) : null,

          h('div', { style: S.bar },
            h('button', { style: S.btn, disabled: status === 'saving', onClick: saveRelay }, status === 'saving' ? '保存中…' : '保存中转站配置'),
            h('button', { style: S.ghostBtn, disabled: models === 'loading', onClick: getModels }, models === 'loading' ? '获取中…' : '获取模型'),
            status === 'saved' ? h('span', { style: S.ok }, '已保存 ✓ 即时生效') : null,
            status === 'error' ? h('span', { style: S.warn }, '保存失败') : null)),
      )
    }

    /**
     *
     * 以前十几张卡平铺一页，配视频要塞在两块生图之间、找 skill 要滚到底。
     * 现在按「你在做什么」分成四组，顶部一条通道状态总览：
     *   生成通道（图 / 视频）· 音频素材 · 治理与工具 · 怎么用
     * 每组内部把「先配什么、后配什么」按使用频率排好。
     */
    /**
     * 「关于」卡：当前版本 + 更新检查。
     *
     * 读的是后端缓存的检查结果（version-check.json），打开页面不发网络请求；
     * 点「检查更新」才发一次。后台另有一个 6 小时的定时检查，这里只是手动入口。
     */
    function AboutCard() {
      const [data, setData] = useState(null)
      const [checking, setChecking] = useState(false)
      const [err, setErr] = useState('')

      const load = useCallback(() => {
        fetch(`${API_BASE}/version`, { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((j) => { setData(j); setErr('') })
          .catch(() => setErr('宿主服务未就绪，读不到版本信息。'))
      }, [])
      useEffect(() => { load() }, [load])

      const checkNow = useCallback(() => {
        setChecking(true); setErr('')
        fetch(`${API_BASE}/version/check`, { method: 'POST', headers: { 'content-type': 'application/json' } })
          .then((r) => r.json().catch(() => ({ ok: false, error: '响应解析失败' })))
          .then((j) => {
            if (!j.ok && j.error) setErr(j.error)
            setData((prev) => ({ ...(prev || {}), current: j.current ?? prev?.current, cached: j }))
          })
          .catch(() => setErr('检查失败：宿主服务未就绪'))
          .finally(() => setChecking(false))
      }, [])

      if (data === null) {
        return h('div', { style: S.card },
          h('h2', { style: S.cardTitle }, '关于本插件'),
          h('p', { style: { ...S.sub, marginTop: 0 } }, err || '加载中…'))
      }

      const cur = data.current || '?'
      const cached = data.cached
      const latest = cached?.latest
      const outdated = cached?.isOutdated === true
      const checkedAt = cached?.checkedAt ? new Date(cached.checkedAt).toLocaleString('zh-CN') : null

      return h('div', { style: S.card },
        h('h2', { style: S.cardTitle }, '关于本插件'),
        h('div', { style: { ...S.rowBetween, marginTop: 4 } },
          h('div', null,
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
              h('span', { style: { fontSize: 20, fontWeight: 700 } }, `v${cur}`),
              outdated ? h('span', { style: S.pill }, `有新版本 v${latest}`) : h('span', { style: S.offPill }, '已是最新')),
            h('p', { style: { ...S.hint, marginTop: 4 } },
              cached?.error
                ? `上次检查失败：${cached.error}`
                : checkedAt
                  ? `上次检查：${checkedAt}（后台每 6 小时自动检查一次）`
                  : '尚未检查过更新。点击右侧按钮立即检查。')),
          h('button', { style: S.btn, disabled: checking, onClick: checkNow }, checking ? '检查中…' : '检查更新')),
        outdated
          ? h('div', { style: S.warnBox },
            h('span', { style: S.warnTitle }, `可以更新到 v${latest}`),
            h('p', { style: { ...S.hint, margin: 0 } },
              '更新方式：拉取最新仓库后重启 DSH。命令：',
              h('br'),
              h('span', { style: S.codeInline }, 'git -C <插件目录> pull'),
              '（或用你装插件时的同一方式更新）。'))
          : null,
        h('p', { style: { ...S.hint, marginTop: 10 } },
          '仓库：', h('span', { style: S.codeInline }, 'github.com/swyaoguai/dsh-taptap-maker-dev'),
          ' · 版本源为该仓库 main 分支的 package.json。'),
      )
    }

    function TaptapMakerSettings() {
      const [group, setGroup] = useState('render')
      const groups = [
        { id: 'render', icon: '🎨', label: '生成通道', desc: '优先级 / 开关与各通道 Key', count: 5 },
        { id: 'audio', icon: '🔊', label: '音频素材', desc: '音效库与 BGM 账号', count: 2 },
        { id: 'govern', icon: '🛡️', label: '治理与工具', desc: '额度红线、skills', count: 2 },
        { id: 'about', icon: 'ℹ️', label: '关于', desc: '版本与更新检查', count: 1 },
        { id: 'help', icon: '📖', label: '怎么用', desc: '日常全部在对话里完成', count: 0 },
      ]
      return h('div', { style: S.page },
        h('div', null,
          h('h1', { style: S.h1 }, 'TapTap Maker 本地开发'),
          h('p', { style: S.sub },
            '通道配置、音频素材、治理开关与 skills。所有 Key 只写进本机 ',
            h('span', { style: S.codeInline }, '$DSH_HOME/taptap-maker-dev/'),
            '，绝不进入会自动提交的 Maker 工作区。'),
        ),

        h(GroupTabs, { groups, value: group, onChange: setGroup }),

        // ── 生成通道：生图（网页→中转站）+ 视频（三后端） ──
        h(PanelGroup, { active: group === 'render' },
          h('p', { style: S.sectionIntro },
            '先在下面这张「通道优先级」里定好顺序和开关，再填各通道的 Key。视频：MiniMax / 中转站 / 自选本地视频。'),
          h(LanePriorityCard),
          h(GptAccount),
          h(ImageConfig),
          h(VideoConfig),
        ),

        // ── 音频素材 ──
        h(PanelGroup, { active: group === 'audio' },
          h('p', { style: S.sectionIntro },
            '音效走本地 CC0 库（零成本）；BGM 走网页生成，账号只影响额度。'),
          h(BgmAccount),
          h(AudioLibrary),
        ),

        // ── 治理与工具 ──
        h(PanelGroup, { active: group === 'govern' },
          h('p', { style: S.sectionIntro },
            '额度红线防误花 Maker 内置额度；skills 决定模型能用到哪些游戏开发知识。'),
          h(PolicyToggle),
          h(SkillManager),
        ),

        // ── 关于（版本与更新检查）──
        h(PanelGroup, { active: group === 'about' },
          h(AboutCard),
        ),

        // ── 怎么用 ──
        h(PanelGroup, { active: group === 'help' },
          h('div', { style: S.card },
            h('h2', { style: S.cardTitle }, '怎么用（全部在对话里，不用回设置页）'),
            h('p', { style: { ...S.sub, marginTop: 0 } },
              '本页只放一次性配置。日常使用直接跟模型说中文，或打斜杠命令：'),
            h('ul', { style: S.ul },
              h('li', null, '生图（首选）：说「生成一个蓝色盾牌图标」，默认走 ChatGPT 网页生图。首次需 ',
                h('span', { style: S.codeInline }, '/taptap-gpt login'), ' 登录一次。'),
              h('li', null, '生图（回退）：网页通道不可用时用 ',
                h('span', { style: S.codeInline }, '/taptap-image <描述>'), '（中转站，需先配 baseURL/key/model）。'),
              h('li', null, '视频（让角色动起来）：',
                h('span', { style: S.codeInline }, '/taptap-video'),
                ' —— 首尾帧出视频 → 抽帧 → 抠图 → 导入 Maker。先跑 ',
                h('span', { style: S.codeInline }, '/taptap-video doctor'), ' 看哪条通道通。'),
              h('li', null, '视频（零额度）：在 MiniMax Code 里用签到积分出片，下载后 ',
                h('span', { style: S.codeInline }, '/taptap-video use <mp4>'), ' 挂进来照样能抽帧抠图。'),
              h('li', null, '音效：说「加个金币音效」，或 ',
                h('span', { style: S.codeInline }, '/taptap-audio 金币音效')),
              h('li', null, 'BGM：说「来个战斗 BGM」——首次会引导登录一次，之后自动。'),
              h('li', null, 'BGM 试听 / 裁剪：生成后点', h('span', { style: S.codeInline }, '输入框旁的 🎵 BGM 挂件'),
                '，可试听、拖波形裁剪、一键导入项目（生成完会亮红点提醒）。'),
              h('li', null, '音频转格式：说「把这些音效转成 wav」，或 ',
                h('span', { style: S.codeInline }, '/taptap-audio-convert')),
              h('li', null, '初始化 Maker：说「帮我初始化 taptap maker」。'),
              h('li', null, 'Skills：说「把用不上的 skill 关掉」，或 ',
                h('span', { style: S.codeInline }, '/taptap-skills')),
              h('li', null, '额度红线开关：说「关掉额度红线」即可（会先跟你确认）。'),
            ),
            h('p', { style: { ...S.hint, marginTop: 8 } },
              '各配置文件（image.json / video-relay.json / minimax.json）改完即时生效；插件代码改动需重启 DSH。'),
          ),
        ),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        {
          name: 'settings.section',
          id: 'taptap-maker-dev',
          order: 42,
          label: () => 'TapTap Maker',
        },
        TaptapMakerSettings,
      ))

      // BGM workbench on the MAIN interface (next to the composer): preview /
      // trim / import freshly generated BGM. Usage belongs to the conversation
      // surface, not settings; the boundary keeps the chat UI safe if it breaks.
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
        {
          name: 'conversation.composer.dock',
          id: 'taptap-maker-dev-bgm',
          order: 90,
          label: () => 'BGM 工作台',
        },
        BgmBoundary,
      ))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'taptap-maker-dev-client'
    return module.exports
  },
})
