/// <reference path="./types.d.ts" />
/**
 * dsh-mini-sync settings page.
 *
 * Renders one settings section. All reads and writes go through this package's own
 * same-origin route (`/dsh-mini-sync/api`), so the page never imports a Harness Client
 * package and never touches another plugin's DOM.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mini-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    // The desktop renderer is served from a custom scheme, so a page-relative path
    // does not always reach the Host. Try the shared /api channel first (the one the
    // app itself uses), then a direct route on the host origin.
    const ENDPOINTS = ['/api/dsh-mini-sync', '/dsh-mini-sync/api']
    let endpoint = null

    async function callAt(url, action, payload) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...(payload ?? {}) }),
      })
      const text = await response.text()
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} @ ${url}${text ? `: ${text.slice(0, 120)}` : ''}`)
      }
      let body
      try {
        body = JSON.parse(text)
      } catch {
        throw new Error(`非 JSON 响应 @ ${url}（${text.length} 字节）`)
      }
      if (!body.ok) throw new Error(body.error ?? 'request failed')
      return body.value
    }

    async function call(action, payload) {
      if (endpoint) return callAt(endpoint, action, payload)
      const failures = []
      for (const candidate of ENDPOINTS) {
        try {
          const value = await callAt(candidate, action, payload)
          endpoint = candidate
          return value
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
        }
      }
      throw new Error(failures.join(' ／ '))
    }

    // ---- styles -------------------------------------------------------
    // Theme tokens only, so light/dark and future retheming keep working.
    const CSS = `
.mmsx-root { display:flex; flex-direction:column; gap:18px; padding:4px 0 32px; color:var(--dsw-alias-text-primary,#1f2328); font-size:13px; }
.mmsx-card { border:1px solid var(--dsw-alias-border-subtle,#e3e6ea); border-radius:10px; padding:16px; background:var(--dsw-alias-bg-elevated,#fff); }
.mmsx-card h3 { margin:0 0 12px; font-size:13px; font-weight:600; letter-spacing:.01em; }
.mmsx-row { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:7px 0; }
.mmsx-row + .mmsx-row { border-top:1px solid var(--dsw-alias-border-subtle,#f0f2f4); }
.mmsx-label { flex:0 0 190px; color:var(--dsw-alias-text-secondary,#5b6470); }
.mmsx-grow { flex:1 1 auto; min-width:0; }
.mmsx-input { width:100%; box-sizing:border-box; padding:6px 9px; font:inherit; color:inherit;
  background:var(--dsw-alias-bg-base,#fff); border:1px solid var(--dsw-alias-border-subtle,#d5dae0); border-radius:7px; }
.mmsx-input:focus { outline:2px solid var(--dsw-alias-accent-primary,#3b82f6); outline-offset:-1px; }
.mmsx-hint { color:var(--dsw-alias-text-tertiary,#8a929c); font-size:12px; margin-top:4px; }
.mmsx-btn { display:inline-flex; align-items:center; gap:6px; padding:6px 13px; font:inherit; font-weight:500; cursor:pointer;
  color:var(--dsw-alias-text-primary,#1f2328); background:var(--dsw-alias-bg-elevated,#fff);
  border:1px solid var(--dsw-alias-border-subtle,#d5dae0); border-radius:7px; }
.mmsx-btn:hover:not(:disabled) { background:var(--dsw-alias-bg-hover,#f4f6f8); }
.mmsx-btn:disabled { opacity:.5; cursor:not-allowed; }
.mmsx-btn-primary { color:#fff; background:var(--dsw-alias-accent-primary,#3b82f6); border-color:transparent; }
.mmsx-btn-primary:hover:not(:disabled) { background:var(--dsw-alias-accent-primary-hover,#2563eb); }
.mmsx-btn-danger { color:var(--dsw-alias-text-danger,#c0392b); }
.mmsx-actions { display:flex; flex-wrap:wrap; gap:8px; }
.mmsx-pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; font-weight:500;
  background:var(--dsw-alias-bg-muted,#eef1f4); color:var(--dsw-alias-text-secondary,#5b6470); }
.mmsx-pill-warn { background:var(--dsw-alias-bg-warning,#fff4e0); color:var(--dsw-alias-text-warning,#9a6400); }
.mmsx-pill-ok { background:var(--dsw-alias-bg-success,#e8f6ee); color:var(--dsw-alias-text-success,#1c7c46); }
.mmsx-model { display:flex; align-items:center; gap:8px; padding:3px 0 3px 22px; font-size:12px;
  color:var(--dsw-alias-text-secondary,#5b6470); }
.mmsx-prov { display:flex; align-items:center; gap:10px; padding:8px 0; }
.mmsx-prov + .mmsx-prov { border-top:1px solid var(--dsw-alias-border-subtle,#f0f2f4); }
.mmsx-check { width:15px; height:15px; accent-color:var(--dsw-alias-accent-primary,#3b82f6); cursor:pointer; flex:0 0 auto; }
.mmsx-code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px;
  color:var(--dsw-alias-text-tertiary,#8a929c); }
.mmsx-out { margin:0; padding:10px 12px; white-space:pre-wrap; word-break:break-word; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:11.5px; line-height:1.55; background:var(--dsw-alias-bg-muted,#f7f9fb);
  border:1px solid var(--dsw-alias-border-subtle,#e3e6ea); border-radius:8px; max-height:280px; overflow:auto; }
.mmsx-out-error { background:var(--dsw-alias-bg-danger,#fdecea); color:var(--dsw-alias-text-danger,#a3271b); }
.mmsx-muted { color:var(--dsw-alias-text-tertiary,#8a929c); }
.mmsx-toggle { display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none; }
.mmsx-empty { padding:12px; color:var(--dsw-alias-text-tertiary,#8a929c); text-align:center; }
`

    // ---- small controls ------------------------------------------------
    function Row({ label, hint, children }) {
      return h('div', { className: 'mmsx-row' },
        h('div', { className: 'mmsx-label' }, label),
        h('div', { className: 'mmsx-grow' },
          children,
          hint ? h('div', { className: 'mmsx-hint' }, hint) : null))
    }

    function Field({ label, hint, value, onChange, type, placeholder, ...rest }) {
      return h(Row, { label, hint },
        h('input', {
          className: 'mmsx-input',
          type: type ?? 'text',
          value: value ?? '',
          placeholder,
          onChange: (e) => onChange(e.target.value),
          ...rest,
        }))
    }

    function Toggle({ label, hint, checked, onChange }) {
      return h(Row, { label, hint },
        h('label', { className: 'mmsx-toggle' },
          h('input', {
            className: 'mmsx-check', type: 'checkbox',
            checked: Boolean(checked),
            onChange: (e) => onChange(e.target.checked),
          }),
          h('span', null, checked ? '已开启' : '已关闭')))
    }

    // ---- page ----------------------------------------------------------
    function MiniSyncSettings() {
      const [state, setState] = useState(null)
      const [draft, setDraft] = useState({})
      const [busy, setBusy] = useState(null)
      const [output, setOutput] = useState(null)
      const [error, setError] = useState(null)

      const load = useCallback(async () => {
        setError(null)
        try {
          const value = await call('inspect')
          setState(value)
          setDraft({
            url: value.url,
            username: value.username,
            remoteDir: value.remoteDir,
            intervalMinutes: value.intervalMinutes,
            keepVersions: value.keepVersions,
            includeCredentials: value.includeCredentials,
            includeSkills: value.includeSkills,
            pullOnStart: value.pullOnStart,
            syncProviders: value.syncProviders,
            rewriteBaseURL: value.rewriteBaseURL,
            password: '',
            passphrase: '',
          })
        } catch (e) {
          setError(e.message)
        }
      }, [])

      useEffect(() => { load() }, [load])

      const patch = (key, value) => setDraft((d) => ({ ...d, [key]: value }))

      const run = async (label, fn) => {
        setBusy(label)
        setError(null)
        setOutput(null)
        try {
          const result = await fn()
          if (result?.summary) setOutput({ text: result.summary })
          else setOutput({ text: JSON.stringify(result, null, 2) })
          await load()
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy(null)
        }
      }

      const save = () => run('save', async () => {
        const payload = { ...draft }
        if (!payload.password) delete payload.password
        if (!payload.passphrase) delete payload.passphrase
        const result = await call('save', { settings: payload })
        return { summary: `已保存。配置文件：${result.settingsPath}` }
      })

      // provider whitelist helpers
      const selected = new Set(draft.syncProviders ?? [])
      const isAll = selected.size === 0
      const setProviders = (next) => patch('syncProviders', next)

      const toggleProvider = (id) => {
        const next = new Set(selected)
        if (isAll) {
          // Leaving "everything" mode: start from nothing but this provider.
          setProviders([id])
          return
        }
        if (next.has(id)) {
          next.delete(id)
          // Dropping the provider should also drop its per-model entries.
          for (const entry of [...next]) {
            if (typeof entry === 'string' && entry.startsWith(`${id}/`)) next.delete(entry)
          }
        } else {
          // A provider-level entry supersedes its per-model entries.
          for (const entry of [...next]) {
            if (typeof entry === 'string' && entry.startsWith(`${id}/`)) next.delete(entry)
          }
          next.add(id)
        }
        setProviders([...next])
      }

      const toggleModel = (providerId, modelId, providerChecked) => {
        const key = `${providerId}/${modelId}`
        const next = new Set(selected)
        if (next.has(key)) {
          next.delete(key)
          setProviders([...next])
          return
        }
        // Selecting one model of a wholly-included provider = switch to per-model.
        next.delete(providerId)
        next.add(key)
        setProviders([...next])
        void providerChecked
      }

      if (error && !state) {
        return h('div', { className: 'mmsx-root' },
          h('style', { key: 'mmsx-styles' }, CSS),
          h('pre', { className: 'mmsx-out mmsx-out-error' }, `无法读取状态：${error}`),
          h('div', { className: 'mmsx-actions', style: { marginTop: 12 } },
            h('button', { className: 'mmsx-btn', onClick: load }, '重试')))
      }
      if (!state) {
        return h('div', { className: 'mmsx-root mmsx-muted' },
          h('style', { key: 'mmsx-styles' }, CSS), '正在读取…')
      }

      const secretHint = (set) => (set ? '已保存在凭据库（留空则不修改）' : '尚未设置')

      // Mirrors the Host's resolution so the address previews before saving.
      const targetPreview = (() => {
        const base = String(draft.url ?? '').trim().replace(/\/+$/, '')
        if (!base) return ''
        const dir = String(draft.remoteDir ?? '').replace(/^\/+|\/+$/g, '') || 'dsh-mini-sync'
        const folder = base.toLowerCase().endsWith(`/${dir.toLowerCase()}`) ? base : `${base}/${dir}`
        return `${folder}/config.json`
      })()

      return h('div', { className: 'mmsx-root' },
        // Component-local stylesheet: unmounting this element removes it, so no
        // global stylesheet is installed and nothing leaks between slots.
        h('style', { key: 'mmsx-styles' }, CSS),

        // ---- connection ----
        h('div', { className: 'mmsx-card' },
          h('h3', null, '连接'),
          h(Field, {
            label: 'WebDAV 地址', value: draft.url,
            onChange: (v) => patch('url', v),
            placeholder: 'https://dav.example.com/remote.php/dav/files/me/',
            hint: '直接粘你的 WebDAV 目录地址即可，末尾斜杠可有可无。',
          }),
          h(Field, {
            label: '用户名', value: draft.username,
            onChange: (v) => patch('username', v),
            placeholder: '留空表示匿名访问',
          }),
          h(Field, {
            label: '密码', type: 'password', value: draft.password,
            onChange: (v) => patch('password', v),
            placeholder: secretHint(state.passwordSet),
            hint: '只写入 DSH 凭据库，不会进入任何配置文件。',
          }),
          h(Field, {
            label: '加密口令', type: 'password', value: draft.passphrase,
            onChange: (v) => patch('passphrase', v),
            placeholder: secretHint(state.passphraseSet),
            hint: 'API Key 以 AES-256-GCM 加密后才上传；换机时输入同一口令即可解密。',
          }),
          h(Row, {
            label: '存放位置',
            hint: '子文件夹自动创建，你不用建也不用填。',
          }, h('div', {
            className: 'mmsx-code',
            style: { wordBreak: 'break-all', lineHeight: 1.5 },
          }, targetPreview || '（填入地址后显示）')))

        // ---- schedule & retention ----
        , h('div', { className: 'mmsx-card' },
          h('h3', null, '同步节奏'),
          h(Row, {
            label: '自动同步间隔',
            hint: draft.intervalMinutes > 0
              ? `每 ${draft.intervalMinutes} 分钟自动推送一次`
              : '0 = 只在手动点击时同步',
          }, h('div', { className: 'mmsx-actions' },
            ...[0, 15, 30, 60, 180].map((m) => h('button', {
              key: m,
              className: `mmsx-btn${draft.intervalMinutes === m ? ' mmsx-btn-primary' : ''}`,
              onClick: () => patch('intervalMinutes', m),
            }, m === 0 ? '关闭' : `${m} 分钟`)),
            h('input', {
              className: 'mmsx-input', type: 'number', min: 0, style: { width: 96 },
              value: draft.intervalMinutes,
              onChange: (e) => patch('intervalMinutes', Number(e.target.value) || 0),
            }))),
          h(Row, {
            label: '远端保留',
            hint: draft.keepVersions > 0
              ? `保留最近 ${draft.keepVersions} 个历史版本，更旧的自动删除`
              : '只保留一个文件，每次原地覆盖——不会在网盘里堆积',
          }, h('div', { className: 'mmsx-actions' },
            ...[0, 3, 5, 10].map((n) => h('button', {
              key: n,
              className: `mmsx-btn${draft.keepVersions === n ? ' mmsx-btn-primary' : ''}`,
              onClick: () => patch('keepVersions', n),
            }, n === 0 ? '仅一个文件' : `${n} 个版本`)),
            h('input', {
              className: 'mmsx-input', type: 'number', min: 0, style: { width: 96 },
              value: draft.keepVersions,
              onChange: (e) => patch('keepVersions', Number(e.target.value) || 0),
            }))))

        // ---- content ----
        , h('div', { className: 'mmsx-card' },
          h('h3', null, '同步内容'),
          h(Toggle, {
            label: '包含 API 凭据', checked: draft.includeCredentials,
            onChange: (v) => patch('includeCredentials', v),
            hint: '把 .credentials.yaml 一并加密上传，换机后无需重填 API Key。',
          }),
          h(Toggle, {
            label: '包含技能目录', checked: draft.includeSkills,
            onChange: (v) => patch('includeSkills', v),
            hint: '同步 ~/.dsh/skills 下的文本文件。',
          }),
          h(Toggle, {
            label: '启动时自动拉取', checked: draft.pullOnStart,
            onChange: (v) => patch('pullOnStart', v),
            hint: '插件加载时应用远端配置；开启前请先确认远端内容是你想要的。',
          }),
          h('div', { className: 'mmsx-row' },
            h('div', { className: 'mmsx-label' }, '本次会同步'),
            h('div', { className: 'mmsx-grow' },
              state.files.length
                ? h('div', { className: 'mmsx-actions' },
                  ...state.files.map((f) => h('span', { key: f, className: 'mmsx-pill' }, f)))
                : h('span', { className: 'mmsx-muted' }, '无'),
              state.skipped.length
                ? h('div', { className: 'mmsx-hint' }, `跳过：${state.skipped.join('、')}`)
                : null)))

        // ---- providers ----
        , h('div', { className: 'mmsx-card' },
          h('h3', null, '模型供应商'),
          h('div', { className: 'mmsx-hint', style: { marginTop: 0, marginBottom: 10 } },
            '其他软件也会往同一份配置里写供应商。勾选你真正想带到其他设备的那些；未勾选的不参与同步，本机配置也不会被改动。'),
          isAll
            ? h('div', { style: { marginBottom: 8 } },
              h('span', { className: 'mmsx-pill mmsx-pill-warn' }, '当前：同步全部供应商'))
            : h('div', { style: { marginBottom: 8 } },
              h('span', { className: 'mmsx-pill mmsx-pill-ok' }, `当前：仅同步 ${selected.size} 项`),
              h('button', {
                className: 'mmsx-btn', style: { marginLeft: 8 },
                onClick: () => setProviders([]),
              }, '改为同步全部')),

          state.providers.length === 0
            ? h('div', { className: 'mmsx-empty' }, '没有找到供应商配置')
            : state.providers.map((provider) => {
              const providerChecked = isAll || selected.has(provider.id)
              return h('div', { key: provider.id },
                h('div', { className: 'mmsx-prov' },
                  h('input', {
                    className: 'mmsx-check', type: 'checkbox',
                    checked: providerChecked,
                    onChange: () => toggleProvider(provider.id),
                  }),
                  h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', null, provider.id,
                      provider.loopback
                        ? h('span', {
                          className: 'mmsx-pill mmsx-pill-warn',
                          style: { marginLeft: 8 },
                        }, '本机地址')
                        : null),
                    provider.baseURL
                      ? h('div', { className: 'mmsx-code' }, provider.baseURL)
                      : null)),
                ...(provider.models ?? []).map((modelId) => {
                  const key = `${provider.id}/${modelId}`
                  const modelChecked = isAll || selected.has(provider.id) || selected.has(key)
                  return h('label', { key: modelId, className: 'mmsx-model' },
                    h('input', {
                      className: 'mmsx-check', type: 'checkbox',
                      checked: modelChecked,
                      disabled: isAll || selected.has(provider.id),
                      onChange: () => toggleModel(provider.id, modelId, providerChecked),
                    }),
                    h('span', null, modelId))
                }))
            }),

          providerHasLoopback(state, draft)
            ? h('div', { className: 'mmsx-row' },
              h('div', { className: 'mmsx-label' }, '地址改写'),
              h('div', { className: 'mmsx-grow' },
                h('input', {
                  className: 'mmsx-input',
                  placeholder: '例如 127.0.0.1:10100 → gateway.lan:10100',
                  value: (draft.rewriteBaseURL?.[0]
                    ? `${draft.rewriteBaseURL[0].match}=${draft.rewriteBaseURL[0].replace}`
                    : ''),
                  onChange: (e) => {
                    const [match, replace] = String(e.target.value).split('=')
                    patch('rewriteBaseURL',
                      match && replace ? [{ match: match.trim(), replace: replace.trim() }] : [])
                  },
                }),
                h('div', { className: 'mmsx-hint' },
                  '本机地址（127.0.0.1 / localhost）只在写它的那台机器上有效。若各机器端口相同可留空；若共用一台网关，在这里填「原地址=新地址」。'),
                (draft.rewriteBaseURL?.length
                  ? h('button', {
                    className: 'mmsx-btn', style: { marginTop: 6 },
                    onClick: () => patch('rewriteBaseURL', []),
                  }, '清除改写')
                  : null)))
            : null)

        // ---- actions ----
        , h('div', { className: 'mmsx-card' },
          h('h3', null, '操作'),
          h('div', { className: 'mmsx-actions' },
            h('button', {
              className: 'mmsx-btn mmsx-btn-primary',
              disabled: busy !== null, onClick: save,
            }, busy === 'save' ? '保存中…' : '保存设置'),
            h('button', {
              className: 'mmsx-btn',
              disabled: busy !== null,
              onClick: () => run('push', async () => call('push')),
            }, busy === 'push' ? '推送中…' : '立即推送'),
            h('button', {
              className: 'mmsx-btn',
              disabled: busy !== null,
              onClick: () => run('preview', async () => {
                const r = await call('pull', { apply: false })
                return r
              }),
            }, busy === 'preview' ? '读取中…' : '预览远端'),
            h('button', {
              className: 'mmsx-btn mmsx-btn-danger',
              disabled: busy !== null,
              onClick: () => run('apply', async () => {
                const r = await call('pull', { apply: true })
                return r
              }),
            }, busy === 'apply' ? '应用中…' : '拉取并应用')),
          h('div', { className: 'mmsx-hint' },
            `上次推送：${state.lastPushAt ?? '从未'} · 上次拉取：${state.lastPullAt ?? '从未'}`),
          error ? h('pre', { className: 'mmsx-out mmsx-out-error', style: { marginTop: 12 } }, error) : null,
          output ? h('pre', { className: 'mmsx-out', style: { marginTop: 12 } }, output.text) : null))

    }

    function providerHasLoopback(state, draft) {
      if ((draft.rewriteBaseURL ?? []).length) return true
      return (state.providers ?? []).some((p) => p.loopback)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get?.('slots')
        if (!slots) return
        slots.inject('settings.section', () => slots.register({
          name: 'settings.section',
          id: 'dsh-mini-sync',
          order: 30,
          label: '轻量同步',
        }, MiniSyncSettings))
      },
    }
  },
})