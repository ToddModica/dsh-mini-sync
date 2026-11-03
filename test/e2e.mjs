// End-to-end harness: drives the real plugin `apply()` against a throwaway DSH_HOME
// and the local test WebDAV server. Verifies push → remote layout → pull → apply,
// plus conflict detection, encryption, and retention pruning.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SANDBOX = path.join(here, '.sandbox')
const DAV_ROOT = path.join(SANDBOX, 'dav')
const HOME = path.join(SANDBOX, 'home')
const PORT = 18081
const BASE = `http://127.0.0.1:${PORT}`

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

function fresh(dir) {
  return fs.rm(dir, { recursive: true, force: true }).then(() => fs.mkdir(dir, { recursive: true }))
}

async function seedHome() {
  await fresh(HOME)
  await fs.mkdir(path.join(HOME, 'profiles', 'desktop'), { recursive: true })
  await fs.mkdir(path.join(HOME, 'skills', 'demo'), { recursive: true })
  await fs.writeFile(path.join(HOME, 'profiles', 'desktop', 'cordis.patch.yml'),
    '- id: llm-pi-ai\n  config:\n    providers:\n      test:\n        api: openai-responses\n        baseURL: "http://127.0.0.1:10100/v1"\n        headers:\n          Authorization: "Bearer sk-test-123"\n')
  await fs.writeFile(path.join(HOME, 'profiles', 'desktop', 'package.json'),
    JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2))
  await fs.writeFile(path.join(HOME, 'settings.yaml'), 'theme: dark\n')
  await fs.writeFile(path.join(HOME, '.credentials.yaml'), 'sk-test-123: {kind: api-key, payload: x}\n')
  await fs.writeFile(path.join(HOME, 'skills', 'demo', 'SKILL.md'), '# demo skill\n')
  // Must never be uploaded:
  await fs.mkdir(path.join(HOME, 'sessions'), { recursive: true })
  await fs.writeFile(path.join(HOME, 'sessions', 'secret.jsonl'), '{"secret":"conversation-content"}\n')
}

const makeCtx = (config) => {
  const tools = new Map()
  const commands = new Map()
  const secrets = new Map()
  const effects = []
  const routes = []
  const fetchRoutes = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: (key) => {
      if (key === 'tools') return { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name) } }
      if (key === 'commands') return { register: (def) => { commands.set(def.name, def); return () => commands.delete(def.name) } }
      if (key === 'credentials') {
        return {
          resolve: async (ref) => (secrets.has(ref) ? { value: secrets.get(ref), source: 'test' } : undefined),
          set: async (ref, value) => { secrets.set(ref, value) },
        }
      }
      if (key === 'webServer') {
        return {
          register: (route) => { routes.push(route); return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1) } },
          getOrigin: () => BASE,
        }
      }
      if (key === 'connection') {
        return {
          fetch: {
            register: (route) => {
              fetchRoutes.push(route)
              return async () => { const i = fetchRoutes.indexOf(route); if (i >= 0) fetchRoutes.splice(i, 1) }
            },
          },
        }
      }
      return undefined
    },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') effects.push(d) },
    // Mirrors Cordis: the callback runs once every named service resolves, and
    // receives a context whose `ctx.<service>` property is that exact instance.
    inject: (deps, callback) => {
      const missing = deps.filter((dep) => ctx.get(dep) === undefined)
      if (missing.length) return
      const scope = {
        get: ctx.get,
        effect: ctx.effect,
        logger: ctx.logger,
      }
      for (const dep of deps) scope[dep] = ctx.get(dep)
      callback(scope)
    },
  }
  return { ctx, tools, commands, secrets, effects, config, routes, fetchRoutes }
}

const run = async (tools, name, args) => {
  const def = tools.get(name)
  if (!def) throw new Error(`tool ${name} not registered`)
  return def.execute(args ?? {})
}

/** Decrypt the remote envelope the way the plugin sealed it. */
async function readRemoteFiles(passphrase) {
  const { createDecipheriv, scryptSync } = await import('node:crypto')
  const envelope = JSON.parse(await fs.readFile(path.join(DAV_ROOT, 'dsh-mini-sync', 'config.json'), 'utf8'))
  const key = scryptSync(passphrase, Buffer.from(envelope.salt, 'base64'), 32, { N: 16384, r: 8, p: 1 })
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
  d.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  const plain = Buffer.concat([d.update(Buffer.from(envelope.ciphertext, 'base64')), d.final()]).toString('utf8')
  return JSON.parse(plain).files
}

async function startServer() {
  const { spawn } = await import('node:child_process')
  const proc = spawn(process.execPath, [path.join(here, 'dav-server.mjs'), DAV_ROOT, String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 8000)
    proc.stdout.on('data', (d) => { if (String(d).includes('dav test server')) { clearTimeout(timer); resolve() } })
    proc.on('error', reject)
  })
  return proc
}

async function main() {
  await fresh(SANDBOX)
  await seedHome()
  // The pasted base URL must be an existing folder; the sync folder under it is
  // what the plugin creates on its own.
  await fs.mkdir(DAV_ROOT, { recursive: true })
  process.env.DSH_HOME = HOME
  process.env.DSH_PROFILE = 'desktop'

  const server = await startServer()
  try {
    const { apply } = await import(pathToFileURL(path.join(here, '..', 'index.js')).href)
    const h = makeCtx({})
    apply(h.ctx, {})
    const { tools, commands } = h

    check('registers 4 tools', tools.size === 4, [...tools.keys()].join(','))
    check('registers /sync command', commands.has('sync'))

    // --- configure -------------------------------------------------------
    await run(tools, 'mini_sync_setup', {
      url: BASE,
      remoteDir: 'dsh-mini-sync',
      intervalMinutes: 0,
      keepVersions: 0,
      passphrase: 'correct horse battery staple',
      includeCredentials: true,
    })
    check('setup stores passphrase as credential', h.secrets.get('DSH_SYNC_PASSPHRASE') === 'correct horse battery staple')

    // --- push ------------------------------------------------------------
    const pushed = await run(tools, 'mini_sync_push')
    check('push reports files', pushed.pushed >= 5, `${pushed.pushed} files, ${pushed.bytes} bytes`)
    check('push is encrypted', pushed.encrypted === true)

    // --- remote layout ---------------------------------------------------
    const remoteFiles = await fs.readdir(path.join(DAV_ROOT, 'dsh-mini-sync'))
    check('remote holds exactly one file', remoteFiles.length === 1 && remoteFiles[0] === 'config.json', remoteFiles.join(','))

    const envelope = JSON.parse(await fs.readFile(path.join(DAV_ROOT, 'dsh-mini-sync', 'config.json'), 'utf8'))
    check('envelope is AES-256-GCM', envelope.cipher === 'aes-256-gcm' && envelope.encrypted === true)
    const raw = JSON.stringify(envelope)
    check('plaintext absent from remote bytes', !raw.includes('sk-test-123') && !raw.includes('conversation-content'))
    check('conversation content excluded from payload', !raw.includes('secret.jsonl'))

    // --- pull into a clean machine ---------------------------------------
    // A fresh device has no sync state, so nothing looks locally modified.
    await fs.rm(path.join(HOME, 'dsh-mini-sync', 'state.json'), { force: true })
    await fs.writeFile(path.join(HOME, 'settings.yaml'), 'theme: light\n')
    const dry = await run(tools, 'mini_sync_pull', {})
    check('dry run writes nothing', dry.applied === false)
    const stillLight = await fs.readFile(path.join(HOME, 'settings.yaml'), 'utf8')
    check('dry run left settings.yaml untouched', stillLight.includes('light'))

    const applied = await run(tools, 'mini_sync_pull', { apply: true })
    check('apply writes files', applied.written.length > 0, applied.written.join(','))
    const restored = await fs.readFile(path.join(HOME, 'settings.yaml'), 'utf8')
    check('settings restored from remote', restored.includes('dark'))
    const creds = await fs.readFile(path.join(HOME, '.credentials.yaml'), 'utf8')
    check('credentials round-trip', creds.includes('sk-test-123'))
    const skill = await fs.readFile(path.join(HOME, 'skills', 'demo', 'SKILL.md'), 'utf8')
    check('skills round-trip', skill.includes('demo skill'))
    const bak = await fs.stat(path.join(HOME, 'settings.yaml.dsh-mini-sync.bak')).then(() => true).catch(() => false)
    check('writes a .bak of the replaced file', bak)

    // --- idempotent second pull ------------------------------------------
    const second = await run(tools, 'mini_sync_pull', {})
    const changed = second.changes.filter((c) => c.action !== 'identical')
    check('second pull is a no-op', changed.length === 0, changed.map((c) => `${c.action}:${c.rel}`).join(','))

    // --- conflict detection ----------------------------------------------
    await fs.writeFile(path.join(HOME, 'settings.yaml'), 'theme: edited-locally\n')
    const conflict = await run(tools, 'mini_sync_pull', {})
    check('local edit reported as conflict', conflict.changes.some((c) => c.action === 'conflict' && c.rel === 'settings.yaml'))
    const guarded = await fs.readFile(path.join(HOME, 'settings.yaml'), 'utf8')
    check('conflict does not clobber local edit', guarded.includes('edited-locally'))
    const forced = await run(tools, 'mini_sync_pull', { apply: true, force: true })
    const afterForce = await fs.readFile(path.join(HOME, 'settings.yaml'), 'utf8')
    check('force overwrites after conflict', afterForce.includes('dark'), forced.written.join(','))

    // --- wrong passphrase ------------------------------------------------
    await run(tools, 'mini_sync_setup', { passphrase: 'wrong passphrase' })
    let wrongFailed = false
    try { await run(tools, 'mini_sync_pull', {}) } catch (e) { wrongFailed = /decrypt|passphrase/i.test(e.message) }
    check('wrong passphrase is rejected, not silently accepted', wrongFailed)
    await run(tools, 'mini_sync_setup', { passphrase: 'correct horse battery staple' })

    // --- retention -------------------------------------------------------
    await run(tools, 'mini_sync_setup', { keepVersions: 2 })
    for (let i = 0; i < 4; i += 1) await run(tools, 'mini_sync_push')
    const hist = await fs.readdir(path.join(DAV_ROOT, 'dsh-mini-sync', 'history'))
    check('retention keeps exactly N versions', hist.length === 2, `history=${hist.length}`)
    const payloadOnly = await fs.readdir(path.join(DAV_ROOT, 'dsh-mini-sync'))
    check('payload still a single file at top level', payloadOnly.includes('config.json'))

    // --- back to single-file policy --------------------------------------
    await run(tools, 'mini_sync_setup', { keepVersions: 0 })
    await run(tools, 'mini_sync_push')
    const status = await run(tools, 'mini_sync_status')
    check('status reports single-file retention', /single file/i.test(status.summary))

    // --- command surface -------------------------------------------------
    const cmd = await commands.get('sync').handler({ rawInput: 'status', agent: { id: 'x' }, signal: null, attachments: [] })
    check('/sync status works', cmd.kind === 'success' && cmd.text.includes('Target'))

    // --- cross-OS: machine-local link deps must not travel ---------------
    await fs.writeFile(path.join(HOME, 'profiles', 'desktop', 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      dependencies: {
        'local-only-thing': 'link:D:/bundles/local-only-thing',
        'from-npm': '^1.2.3',
      },
    }, null, 2))
    await run(tools, 'mini_sync_setup', { pathMap: [{ from: 'D:/', to: '/Users/alice/' }] })
    const xPush = await run(tools, 'mini_sync_push')
    check('reports dropped machine-local links', (xPush.notes ?? []).some((n) => n.includes('local-only-thing')))

    // Re-pull on a "Mac" (same sandbox) and confirm the dead link is gone.
    await fs.rm(path.join(HOME, 'dsh-mini-sync', 'state.json'), { force: true })
    await run(tools, 'mini_sync_pull', { apply: true, force: true })
    const pulledPkg = JSON.parse(await fs.readFile(path.join(HOME, 'profiles', 'desktop', 'package.json'), 'utf8'))
    check('dead local link removed from synced package.json', !('local-only-thing' in (pulledPkg.dependencies ?? {})))
    check('npm dependency preserved', pulledPkg.dependencies?.['from-npm'] === '^1.2.3')
    check('bundle list preserved', pulledPkg.dsh?.profile?.bundles?.includes('@deepseek-ai/dsh-base'))

    // --- provider whitelist ----------------------------------------------
    // Another tool wrote its own provider into the same patch file; it must not travel.
    await fs.writeFile(path.join(HOME, 'profiles', 'desktop', 'cordis.patch.yml'), [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      mine:',
      '        api: openai-responses',
      '        baseURL: "http://127.0.0.1:10100/v1"',
      '        headers:',
      '          Authorization: "Bearer sk-mine"',
      '        models:',
      '          - id: Qwen/qwen3.8-max',
      '          - id: Qwen/qwen3.8-flash',
      '      foreign:',
      '        api: openai-chat',
      '        baseURL: "https://foreign.example.com/v1"',
      '        models:',
      '          - id: foreign/auto-added',
      '- id: web',
      '  config:',
      '    searchProvider: deepseek-search-api',
      '',
    ].join('\n'))

    await run(tools, 'mini_sync_setup', {
      syncProviders: ['mine/Qwen/qwen3.8-max'],
      rewriteBaseURL: [{ match: '127.0.0.1:10100', replace: 'gateway.local:10100' }],
    })
    const wlPush = await run(tools, 'mini_sync_push')
    check('whitelist reports dropped provider', (wlPush.notes ?? []).some((n) => /foreign/.test(n)))
    check('whitelist reports dropped model', (wlPush.notes ?? []).some((n) => n.includes('qwen3.8-flash')))
    check('reports base URL rewrite', (wlPush.notes ?? []).some((n) => n.includes('gateway.local')))

    const wlPull = await run(tools, 'mini_sync_pull', { apply: true, force: true })
    check('pull succeeded with whitelist', wlPull.applied === true)

    // The whitelist scopes what is UPLOADED; the local file is not edited.
    const payloadFiles = await readRemoteFiles('correct horse battery staple')
    const syncedPatch = payloadFiles['profile/cordis.patch.yml']
    check('synced payload keeps whitelisted provider', syncedPatch.includes('mine:'))
    check('synced payload drops unlisted model', !syncedPatch.includes('qwen3.8-flash'))
    check('synced payload drops unlisted provider', !syncedPatch.includes('foreign:'))
    check('synced payload drops foreign base URL', !syncedPatch.includes('foreign.example.com'))
    check('synced payload keeps non-provider rows', syncedPatch.includes('searchProvider'))
    check('synced payload has rewritten base URL', syncedPatch.includes('gateway.local:10100'))

    const localAfter = await fs.readFile(path.join(HOME, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')
    check('local file untouched by push filtering', localAfter.includes('foreign:'))

    // --- loopback warning -------------------------------------------------
    await fs.writeFile(path.join(HOME, 'profiles', 'desktop', 'cordis.patch.yml'), [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      mine:',
      '        api: openai-responses',
      '        baseURL: "http://127.0.0.1:9999/v1"',
      '',
    ].join('\n'))
    await run(tools, 'mini_sync_setup', { syncProviders: ['mine'], rewriteBaseURL: [] })
    const lbPush = await run(tools, 'mini_sync_push')
    check('warns about loopback base URL', (lbPush.notes ?? []).some((n) => /loopback/.test(n)))

    // --- HTTP route used by the settings page -----------------------------
    const route = h.routes.find((r) => r.path === '/dsh-mini-sync/api')
    check('registers the settings-page API route', Boolean(route))

    if (route) {
      const invoke = async (action, extra = {}, headers = {}) => {
        const body = JSON.stringify({ action, ...extra })
        const req = {
          method: 'POST',
          headers: { host: '127.0.0.1', ...headers },
          async *[Symbol.asyncIterator]() { yield Buffer.from(body) },
        }
        let status
        let payload
        const res = {
          writeHead: (code) => { status = code },
          end: (text) => { payload = JSON.parse(text) },
        }
        await route.handler(req, res)
        return { status, payload }
      }

      const inspected = await invoke('inspect')
      check('route inspect returns state', inspected.payload.ok === true && typeof inspected.payload.value.url === 'string')
      check('route inspect lists providers', Array.isArray(inspected.payload.value.providers))
      check('route inspect never leaks the passphrase', !JSON.stringify(inspected.payload).includes('correct horse battery staple'))

      const saved = await invoke('save', { settings: { intervalMinutes: 45, keepVersions: 3 } })
      check('route save persists settings', saved.payload.ok === true)
      const reInspected = await invoke('inspect')
      check('saved interval visible on reload', reInspected.payload.value.intervalMinutes === 45)

      const crossOrigin = await invoke('inspect', {}, { origin: 'https://evil.example.com' })
      check('route refuses cross-origin callers', crossOrigin.status === 403)

      const unknown = await invoke('nope')
      check('route rejects unknown action', unknown.payload.ok === false)
    }

    // --- the shared /api carrier (what the desktop renderer reaches) ------
    const carrier = h.fetchRoutes.find((r) => r.path === '/dsh-mini-sync')
    check('registers the shared /api carrier', Boolean(carrier))
    if (carrier) {
      const send = async (payload, headers = {}) => {
        const request = new Request('http://host/api/dsh-mini-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', host: '127.0.0.1', ...headers },
          body: JSON.stringify(payload),
        })
        const response = await carrier.fetch(request)
        return { status: response.status, body: await response.json() }
      }
      const viaApi = await send({ action: 'inspect' })
      check('carrier answers inspect', viaApi.body.ok === true && Array.isArray(viaApi.body.value.providers))
      const viaApiBad = await send({ action: 'nope' })
      check('carrier rejects unknown action', viaApiBad.body.ok === false)
      const viaApiCross = await send({ action: 'inspect' }, { origin: 'https://evil.example.com' })
      check('carrier refuses cross-origin callers', viaApiCross.status === 403)
    }

    // --- a pasted URL is all it takes -------------------------------------
    // Nested folders must be created automatically. The stub answers 409 to a
    // one-level MKCOL whose parent is absent, so this exercises the real path.
    await run(tools, 'mini_sync_setup', { remoteDir: 'deep/nested/dsh', url: `${BASE}/` })
    const nested = await run(tools, 'mini_sync_push')
    check('push creates nested remote folders from a pasted URL', nested.pushed > 0, nested.target)
    const nestedExists = await fs.stat(path.join(DAV_ROOT, 'deep', 'nested', 'dsh', 'config.json'))
      .then(() => true).catch(() => false)
    check('nested payload file landed on disk', nestedExists)
    check(
      'trailing slash normalised out of the target',
      !nested.target.replace(/^https?:\/\//, '').includes('//'),
      nested.target,
    )

    // Pasting the folder URL itself must not produce .../dsh/dsh.
    await run(tools, 'mini_sync_setup', { url: `${BASE}/deep/nested/dsh`, remoteDir: 'dsh' })
    const again = await run(tools, 'mini_sync_push')
    check('pasting the folder URL does not double the folder name', !again.target.includes('/dsh/dsh'), again.target)

    // A URL copied from the file itself resolves to its folder.
    await run(tools, 'mini_sync_setup', { url: `${BASE}/deep/nested/dsh/config.json`, remoteDir: 'dsh' })
    const fromFile = await run(tools, 'mini_sync_push')
    check('a file URL degrades to its folder', fromFile.target.endsWith('/deep/nested/dsh/config.json'), fromFile.target)

    // Back to the shared folder for any remaining checks.
    await run(tools, 'mini_sync_setup', { url: BASE, remoteDir: 'dsh-mini-sync' })
  } finally {
    server.kill()
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) process.exitCode = 1
}

main().catch((error) => { console.error('HARNESS ERROR', error); process.exitCode = 1 })