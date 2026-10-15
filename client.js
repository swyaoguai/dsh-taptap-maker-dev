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
    const { useState, useMemo, useCallback, useEffect } = React

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

      const doLogin = useCallback(() => {
        setBusy('login'); setErr(''); setCredits(null)
        fetch(`${API_BASE}/bgm-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then((r) => r.json().then((j) => ({ ok: r.ok, j })).catch(() => ({ ok: false, j: { error: '响应解析失败' } })))
          .then(({ ok, j }) => {
            if (!ok || !j.ok) { setErr(j.error || '登录启动失败'); setBusy(''); return }
            let tries = 0
            const timer = setInterval(() => {
              tries += 1
              fetch(`${API_BASE}/bgm`, { headers: { accept: 'application/json' } })
                .then((r) => (r.ok ? r.json() : Promise.reject(new Error('bad'))))
                .then((st) => {
                  if (st.hasCookies === true || tries >= 60) {
                    clearInterval(timer)
                    setInfo(st)
                    setBusy('')
                    if (st.hasCookies !== true) setErr('未检测到登录：请在弹出的浏览器里完成登录，再点「刷新」。')
                  }
                })
                .catch(() => { if (tries >= 60) { clearInterval(timer); setBusy('') } })
            }, 3000)
          })
          .catch(() => { setErr('请求失败：宿主服务未就绪'); setBusy('') })
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
      return h('div', { style: S.card },
        h('div', { style: S.rowBetween },
          h('div', null,
            h('h2', { style: S.cardTitle }, 'BGM 账号'),
            h('p', { style: { ...S.sub, marginTop: 2 } },
              '生成完整 BGM 用的 MiniMax 账号。可登录、查额度、换号。')),
          h('span', { style: logged ? S.pill : S.offPill }, logged ? '已登录' : '未登录'),
        ),
        info.site
          ? h('p', { style: S.hint }, '站点：', h('span', { style: S.codeInline }, info.site.label))
          : null,
        h('div', { style: S.bar },
          h('button', { style: S.btn, disabled: busy !== '', onClick: doLogin },
            busy === 'login' ? '登录中…' : (logged ? '重新登录' : '登录')),
          logged ? h('button', { style: S.ghostBtn, disabled: busy !== '', onClick: () => post('bgm-credits', {}, 'credits') }, busy === 'credits' ? '查询中…' : '查额度') : null,
          logged ? h('button', { style: S.ghostBtn, disabled: busy !== '', onClick: () => post('bgm-logout', {}, 'logout') }, busy === 'logout' ? '退出中…' : '退出 / 换号') : null,
          err ? h('span', { style: S.warn }, err) : null,
        ),
        credits !== null
          ? h('p', { style: S.hint },
            '剩余额度：', h('span', { style: S.codeInline }, `${credits.totalCredit ?? '?'}`),
            credits.expiresAt ? h('span', { style: S.hint }, `（到期 ${new Date(credits.expiresAt).toLocaleDateString('zh-CN')}）`) : null)
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
          '「退出 / 换号」会清除本机登录态，之后可用另一个账号登录。'),
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
          h('h2', { style: S.cardTitle }, '自定义生图通道（OpenAI 兼容 /images）'),
          h('p', { style: { ...S.sub, marginTop: 0 } }, '加载中…'))
      }

      return h('div', { style: S.card },
        h('h2', { style: S.cardTitle }, '自定义生图通道（OpenAI 兼容 /images）'),
        h('p', { style: { ...S.sub, marginTop: 0 } }, '填好点「保存」即写入本机 image.json，即时生效、无需重启。Key 不进工作区、不进包。'),
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

        h(ImageConfig),

        h(BgmAccount),

        h(AudioLibrary),

        h(SkillManager),

        h('div', { style: S.card },
          h('h2', { style: S.cardTitle }, '怎么用（全部在对话里，不用回设置页）'),
          h('p', { style: { ...S.sub, marginTop: 0 } },
            '本页只放一次性配置。日常使用直接跟模型说中文，或打斜杠命令：'),
          h('ul', { style: S.ul },
            h('li', null, '生图：说「生成一个蓝色盾牌图标」，或 ',
              h('span', { style: S.codeInline }, '/taptap-image 蓝色盾牌图标')),
            h('li', null, '音效：说「加个金币音效」，或 ',
              h('span', { style: S.codeInline }, '/taptap-audio 金币音效')),
            h('li', null, 'BGM：说「来个战斗 BGM」——首次会引导登录一次，之后自动。'),
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
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'taptap-maker-dev-client'
    return module.exports
  },
})
