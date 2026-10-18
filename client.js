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

    const S = {
      page: { padding: '20px 24px', maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 20 },
      h1: { fontSize: 18, fontWeight: 600, margin: 0 },
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
      const [panelBg, setPanelBg] = useState('rgba(28,30,36,0.98)')
      const audioRef = useRef(null)
      const srcRef = useRef('')

      // Panel background measured from the live page so it fits light/dark.
      useEffect(() => {
        if (!open) return
        try {
          for (const el of [document.body, document.documentElement]) {
            const bg = getComputedStyle(el).backgroundColor
            if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') { setPanelBg(bg); break }
          }
        } catch { /* keep fallback */ }
      }, [open])

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

      // Poll: on mount, every 10s while visible, and when the window regains
      // focus — a freshly generated BGM lights the widget up within seconds.
      useEffect(() => {
        loadLib()
        const t = setInterval(() => { if (document.visibilityState === 'visible') loadLib() }, 10000)
        const onFocus = () => loadLib()
        window.addEventListener('focus', onFocus)
        return () => { clearInterval(t); window.removeEventListener('focus', onFocus) }
      }, [loadLib])

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
          position: 'fixed', right: 16, bottom: 64, zIndex: 10001, width: 300,
          background: panelBg, border: '1px solid var(--dsh-border, rgba(128,128,128,0.35))',
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
          position: 'fixed', right: 16, bottom: 64, zIndex: 10000, width: 340,
          maxHeight: 'min(560px, 76vh)', overflowY: 'auto',
          background: panelBg, color: 'inherit',
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

      return h('span', { style: { display: 'inline-flex', position: 'relative' } },
        toastViews,
        panel,
        h('button', {
          onClick: open ? () => { stop(); setOpen(false) } : openPanel,
          title: 'BGM 工作台：试听 / 裁剪 / 导入',
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px',
            borderRadius: 999, border: '1px solid var(--dsh-border, rgba(128,128,128,0.4))',
            background: 'var(--dsh-input-bg, rgba(128,128,128,0.08))', color: 'inherit',
            font: 'inherit', fontSize: 12, cursor: 'pointer', position: 'relative',
          },
        },
          '🎵 BGM',
          hasNew ? h('span', { style: { position: 'absolute', top: -3, right: -3, width: 9, height: 9, borderRadius: '50%', background: 'var(--dsh-danger, #e03131)', border: '1.5px solid rgba(255,255,255,0.6)' } }) : null),
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
      const [showAdd, setShowAdd] = useState(false)

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
            setNewId(''); setShowAdd(false)
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
      const anyLogged = logged || pool.loggedIn > 0
      // 账号列表：主账号常驻（退出后可再登）+ 附加账号（轮询）
      const rows = [
        { id: null, key: '__main__', name: '主账号', isMain: true, loggedIn: logged, status: 'ok' },
        ...pool.accounts.map((a) => ({
          id: a.id, key: a.id, isMain: false, status: a.status,
          name: a.label !== a.id ? `${a.id}（${a.label}）` : a.id,
          loggedIn: a.hasCookies === true,
        })),
      ]
      return h('div', { style: S.card },
        h('div', { style: S.rowBetween },
          h('div', null,
            h('h2', { style: S.cardTitle }, 'BGM 账号'),
            h('p', { style: { ...S.sub, marginTop: 2 } },
              '生成完整 BGM 用的 MiniMax 账号。可登录、查额度、换号；多个账号可在额度用完时自动轮换。')),
          h('span', { style: anyLogged ? S.pill : S.offPill }, anyLogged ? '已登录' : '未登录'),
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
                onClick: () => doLogin(r.isMain ? undefined : r.id),
              }, busy === (r.isMain ? 'login' : `login:${r.id}`) ? '登录中…' : (r.loggedIn ? '重登' : '登录')),
              r.loggedIn
                ? h('button', {
                  style: S.ghostBtn, disabled: busy !== '',
                  onClick: () => post('bgm-logout', r.isMain ? {} : { account: r.id }, r.isMain ? 'logout' : `logout:${r.id}`),
                }, '退出')
                : null,
              r.loggedIn
                ? h('button', {
                  style: S.ghostBtn, disabled: busy !== '',
                  onClick: () => post('bgm-credits', r.isMain ? {} : { account: r.id }, r.isMain ? 'credits' : `credits:${r.id}`),
                }, busy === (r.isMain ? 'credits' : `credits:${r.id}`) ? '查询中…' : '查额度')
                : null,
              r.isMain
                ? null
                : h('button', {
                  style: S.ghostBtn, disabled: busy !== '',
                  onClick: () => poolAction(r.status === 'banned' || r.status === 'cooling' ? 'unban' : 'ban', r.id),
                }, r.status === 'banned' || r.status === 'cooling' ? '恢复' : '封禁'),
              r.isMain
                ? null
                : h('button', { style: S.ghostBtn, disabled: busy !== '', onClick: () => poolAction('remove', r.id) }, '移除'),
            )),
          )),

        h('div', { style: S.bar },
          showAdd
            ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('input', {
                style: { ...S.search, flex: '0 0 auto', width: 170 }, value: newId,
                placeholder: '账号短名，如 b2', spellCheck: false, autoComplete: 'off',
                onChange: (e) => setNewId(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') addAndLogin() },
              }),
              h('button', { style: S.btn, disabled: busy !== '' || !(newId || '').trim(), onClick: addAndLogin }, '添加并登录'),
              h('button', { style: S.ghostBtn, onClick: () => { setShowAdd(false); setNewId('') } }, '取消'))
            : h('button', { style: S.ghostBtn, disabled: busy !== '', onClick: () => setShowAdd(true) }, '+ 添加账号'),
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
          '「退出」会清除该账号的本机登录态；主账号那一行常驻，退出后可随时再登回来。'),
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
      const [showAdd, setShowAdd] = useState(false)
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
        fetch(`${API_BASE}/gpt-pool`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'add', id }),
        })
          .then((r) => r.json().then((j) => ({ ok: r.ok, j })).catch(() => ({ ok: false, j: { error: '响应解析失败' } })))
          .then(({ ok, j }) => {
            if (!ok || !j.ok) { setErr(j.error || '添加失败'); setBusy(''); return }
            setInfo(j)
            setNewId(''); setShowAdd(false)
            // 紧接着为该账号打开登录浏览器。
            doLogin(id)
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
      const logged = info.loggedIn === true || pool.loggedIn > 0
      const dim = { display: 'flex', flexDirection: 'column', gap: 10, opacity: laneOn ? 1 : 0.45 }
      // 账号列表永远是「主账号 + 附加账号」。主账号那一行常驻 —— 退出登录后
      // 行还在，可以直接再登回去。之前的版本把「+ 账号」删了，结果用户点
      // 「退出/换号」后就再也没有入口，等于把换号变成单向操作（2026-10-17 反馈）。
      const rows = [
        { id: null, key: '__main__', name: '主账号', isMain: true, loggedIn: info.loggedIn === true, status: 'ok' },
        ...pool.accounts.map((a) => ({ ...a, key: a.id, name: a.label !== a.id ? `${a.id}（${a.label}）` : a.id, isMain: false })),
      ]
      const busyKey = (r) => (r.isMain ? '' : r.id)
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
                logged ? '已登录，可生成图片。' : '未登录：点账号那一行的「登录」，或「+ 添加账号」')),
            h('span', { style: logged ? S.pill : S.offPill }, logged ? '已登录' : '未登录'),
          ),

          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
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
                  onClick: () => doLogin(busyKey(r) || undefined),
                }, busy === (r.isMain ? 'login' : `login:${r.id}`) ? '登录中…' : (r.loggedIn ? '重登' : '登录')),
                r.loggedIn
                  ? h('button', {
                    style: S.ghostBtn, disabled: busy !== '' || !laneOn,
                    onClick: () => doLogout(busyKey(r) || undefined),
                  }, busy === (r.isMain ? 'logout' : `logout:${r.id}`) ? '退出中…' : '退出')
                  : null,
                r.isMain
                  ? null
                  : h('button', {
                    style: S.ghostBtn, disabled: busy !== '' || !laneOn,
                    onClick: () => post('gpt-pool', { action: r.status === 'banned' || r.status === 'cooling' ? 'unban' : 'ban', id: r.id }),
                  }, r.status === 'banned' || r.status === 'cooling' ? '恢复' : '封禁'),
                r.isMain
                  ? null
                  : h('button', { style: S.ghostBtn, disabled: busy !== '' || !laneOn, onClick: () => post('gpt-pool', { action: 'remove', id: r.id }) }, '移除'),
              )),
            )),
          // 添加账号：一步完成「建条目 + 打开登录」。不再是空点一下的按钮，
          // 加完立刻进入登录，登完就能用（之前那次删掉就是漏了这层价值）。
          h('div', { style: S.bar },
            showAdd
              ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('input', {
                  style: { ...S.search, flex: '0 0 auto', width: 170 }, value: newId,
                  placeholder: '账号短名，如 a2', spellCheck: false, autoComplete: 'off',
                  onChange: (e) => setNewId(e.target.value),
                  onKeyDown: (e) => { if (e.key === 'Enter') addAndLogin() },
                }),
                h('button', { style: S.btn, disabled: busy !== '' || !laneOn || !(newId || '').trim(), onClick: addAndLogin },
                  '添加并登录'),
                h('button', { style: S.ghostBtn, onClick: () => { setShowAdd(false); setNewId('') } }, '取消'))
              : h('button', { style: S.ghostBtn, disabled: !laneOn || busy !== '', onClick: () => setShowAdd(true) }, '+ 添加账号'),
            err ? h('span', { style: S.warn }, err) : null,
          ),
          h('p', { style: S.hint }, '登录会打开真实浏览器，用 Google / Apple / 手机号 / 邮箱登录一次即可。'),

          // 图片落点：默认跟随项目目录（不再丢到 C 盘），也可以自定义。
          h('div', { style: S.row },
            h('label', { style: S.label }, '图片下载目录（默认跟随项目）'),
            h('input', {
              style: S.input,
              value: dirInput === null ? (info.downloadDirConfigured || '') : dirInput,
              placeholder: '留空 = <当前项目>/.taptap-images',
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
                    + '一个触配额自动换下一个。')),
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

      return h('div', { style: S.card },
        h('div', { style: S.rowBetween },
          h('div', null,
            h('h2', { style: S.cardTitle }, '音效素材库'),
            h('p', { style: { ...S.sub, marginTop: 2 } },
              'Kenney 等 CC0 音源，可商用、可修改、无需署名。',
              info === 'error' ? '' : (ready ? ` 本地已有 ${count} 个音频。` : ' 尚未下载，首次使用自动获取（约 7MB）。'))),
          h('span', { style: ready ? S.pill : S.offPill }, ready ? '已就绪' : '未下载'),
        ),
        info === 'error'
          ? h('p', { style: { ...S.hint, color: 'var(--dsh-warn, #f08c00)' } },
            '没连上宿主服务。')
          : null,
        h('div', { style: S.bar },
          h('button', { style: S.ghostBtn, disabled: busy !== '', onClick: sync },
            busy === 'sync' ? '下载中…' : '更新素材库'),
          err ? h('span', { style: S.warn }, err) : null,
        ),
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
          label: 'API Key', value: form.apiKey, onChange: (v) => set('apiKey', v), secret: true,
          placeholder: 'sk-...', hint: '仅保存在本机 image.json。',
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

    function TaptapMakerSettings() {
      return h('div', { style: S.page },
        h('div', null,
          h('h1', { style: S.h1 }, 'TapTap Maker 本地开发'),
          h('p', { style: S.sub },
            '为 TapTap 制造（Maker）本地开发配置：自定义生图通道、额度红线、内置可更新 skills。',
            '生图 Key 只写进本机 ', h('span', { style: S.codeInline }, 'image.json'),
            '，绝不进入会自动提交的 Maker 工作区。'),
        ),

        h(PolicyToggle),

        // 网页生图是首选 → 排在前面；中转站降为回退。
        h(GptAccount),

        h(ImageConfig),

        h(BgmAccount),

        h(AudioLibrary),

        h(SkillManager),

        h('div', { style: S.card },
          h('h2', { style: S.cardTitle }, '怎么用（全部在对话里，不用回设置页）'),
          h('p', { style: { ...S.sub, marginTop: 0 } },
            '本页只放一次性配置。日常使用直接跟模型说中文，或打斜杠命令：'),
          h('ul', { style: S.ul },
            h('li', null, '生图（首选）：说「生成一个蓝色盾牌图标」，默认走 ChatGPT 网页生图。',
              '首次需 ', h('span', { style: S.codeInline }, '/taptap-gpt login'), ' 登录一次。'),
            h('li', null, '关掉网页生图：本页「ChatGPT 网页生图」卡右上角开关，或 ',
              h('span', { style: S.codeInline }, '/taptap-gpt lane off'), '（关掉后自动改走中转站）'),
            h('li', null, '生图（回退）：网页通道不可用时用 ',
              h('span', { style: S.codeInline }, '/taptap-image <描述>'), '（中转站，需先配 baseURL/key/model）'),
            h('li', null, '账号池：/taptap-gpt pool list 看账号，add --id <名> 添加账号，login --account <名> 登录，unban 恢复冷却账号'),
            h('li', null, '音效：说「加个金币音效」，或 ',
              h('span', { style: S.codeInline }, '/taptap-audio 金币音效')),
            h('li', null, 'BGM：说「来个战斗 BGM」——首次会引导登录一次，之后自动。'),
            h('li', null, 'BGM 试听 / 裁剪：生成后点', h('span', { style: S.codeInline }, '输入框旁的 🎵 BGM 挂件'),
              '，可试听、拖波形裁剪、一键导入项目（生成完会亮红点提醒）。'),
            h('li', null, '换 BGM 账号 / 查额度：说「退出登录」或「查额度」，也在本页「BGM 账号」卡。'),
            h('li', null, '音频转格式：说「把这些音效转成 wav」，或 ',
              h('span', { style: S.codeInline }, '/taptap-audio-convert')),
            h('li', null, '初始化 Maker：说「帮我初始化 taptap maker」。'),
            h('li', null, 'Skills：说「把用不上的 skill 关掉」，或 ',
              h('span', { style: S.codeInline }, '/taptap-skills')),
            h('li', null, '额度红线开关：说「关掉额度红线」即可（会先跟你确认）。'),
          ),
          h('p', { style: { ...S.hint, marginTop: 8 } },
            'image.json / music 配置改完即时生效；插件代码与设置页改动需重启 DSH。'),
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
