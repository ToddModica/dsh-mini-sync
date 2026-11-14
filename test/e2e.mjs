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

const makeCtx = (config, { pluginManager } = {}) => {
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
      if (key === 'pluginManager') return pluginManager
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
    // A different local credentials document: the pull adopts it and keeps a .bak,
    // which must be owner-only just like the document it backs up.
    await fs.writeFile(path.join(HOME, '.credentials.yaml'), 'sk-test-999: {kind: api-key, payload: y}\n')
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

    // DSH refuses to start when the credentials document is group/other readable,
    // and a refused credentials provider blocks every plugin that waits on it.
    if (process.platform !== 'win32') {
      const credPath = path.join(HOME, '.credentials.yaml')
      const credMode = (await fs.stat(credPath)).mode & 0o777
      check('applied credentials are owner-only (0600)', credMode === 0o600, credMode.toString(8))
      const credBak = await fs.stat(`${credPath}.dsh-mini-sync.bak`).catch(() => undefined)
      check(
        'the credentials backup is owner-only too',
        credBak !== undefined && (credBak.mode & 0o777) === 0o600,
        credBak ? (credBak.mode & 0o777).toString(8) : 'no backup',
      )

      // An unchanged credentials document is never rewritten, so a mode inherited
      // from an older version must still be repaired before it breaks startup.
      await fs.chmod(credPath, 0o644)
      const repaired = await run(tools, 'mini_sync_pull', { apply: true })
      check(
        'an applied pull tightens a group-readable credentials file',
        ((await fs.stat(credPath)).mode & 0o777) === 0o600,
        (repaired.merged ?? []).join('; '),
      )
    }

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

    // --- plugin inventory + portable reinstall ---------------------------
    const localPluginDir = path.join(SANDBOX, 'demo-local-plugin')
    const privatePluginDir = path.join(SANDBOX, 'demo-private-plugin')
    await fs.mkdir(localPluginDir, { recursive: true })
    await fs.mkdir(privatePluginDir, { recursive: true })
    await fs.writeFile(path.join(localPluginDir, 'package.json'), JSON.stringify({
      name: 'demo-local',
      version: '1.2.3',
      repository: { type: 'git', url: 'https://github.com/ToddModica/demo-plugin.git' },
    }, null, 2))
    await fs.writeFile(path.join(localPluginDir, 'index.js'), 'export const name = "demo-local"\n')
    await fs.writeFile(path.join(privatePluginDir, 'package.json'), JSON.stringify({
      name: 'demo-private',
      version: '0.0.1',
    }, null, 2))
    await fs.writeFile(path.join(privatePluginDir, 'index.js'), 'export const name = "demo-private"\n')

    const profilePkgPath = path.join(HOME, 'profiles', 'desktop', 'package.json')
    await fs.writeFile(profilePkgPath, JSON.stringify({
      name: 'dsh-profile-desktop',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'demo-local', 'demo-private', 'from-npm'] } },
      dependencies: {
        'demo-local': `link:${localPluginDir}`,
        'demo-private': `link:${privatePluginDir}`,
        'from-npm': '^1.2.3',
      },
    }, null, 2))

    const installCalls = []
    const nodeModules = path.join(HOME, 'profiles', 'desktop', 'node_modules')
    /** spec -> package name, from the remote inventory (read on demand). */
    const nameForSpec = async (spec) => {
      const envelope = JSON.parse(await fs.readFile(path.join(DAV_ROOT, 'plugins', 'config.json'), 'utf8'))
      const hit = (envelope.body.plugins ?? []).find((p) => p.spec === spec)
      if (hit?.name) return hit.name
      return spec.startsWith('github:')
        ? spec.slice('github:'.length).split('/').pop()
        : spec.replace(/@[^@/]+$/, '')
    }
    // Faithful to the real manager: a dependency that is declared but absent from
    // node_modules reports `installed: true` with a resolution error, and only a
    // real install materializes the package.
    const materialized = async (name) => {
      try { await fs.stat(path.join(nodeModules, ...name.split('/'), 'package.json')); return true }
      catch { return false }
    }
    const pluginManager = {
      listBundles: async () => {
        const current = JSON.parse(await fs.readFile(profilePkgPath, 'utf8'))
        const names = Object.keys(current.dependencies ?? {})
        return Promise.all(names.map(async (name) => {
          const there = await materialized(name)
          return {
            name, official: false, enabled: true,
            installed: true,
            availability: there ? 'profile' : 'missing',
            source: name === 'from-npm' ? 'from-npm@1.2.3' : undefined,
            ...(there ? {} : {
              error: { code: 'operation-error', diagnostic: `cannot resolve profile bundle "${name}"` },
            }),
          }
        }))
      },
      installBundle: async (spec, options) => {
        installCalls.push({ spec, options })
        // Resolve the package name the way a real manager does: from the registry
        // manifest behind the spec, not by splitting the spec string.
        const name = await nameForSpec(spec)
        await fs.mkdir(path.join(nodeModules, ...name.split('/')), { recursive: true })
        await fs.writeFile(
          path.join(nodeModules, ...name.split('/'), 'package.json'),
          JSON.stringify({ name, version: '1.2.3', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
        )
        return { changed: true, application: 'restart-required' }
      },
    }
    const h3 = makeCtx({}, { pluginManager })
    apply(h3.ctx, {})
    await run(h3.tools, 'mini_sync_setup', {
      url: BASE, remoteDir: 'plugins', encrypt: false, keepVersions: 0,
    })
    const pluginPush = await run(h3.tools, 'mini_sync_push')
    check('plugin inventory counts every profile dependency', pluginPush.plugins.total === 3, JSON.stringify(pluginPush.plugins))
    check('two plugins have a portable install spec', pluginPush.plugins.portable === 2)
    check('plugin without repository is reported local-only', pluginPush.plugins.localOnly.includes('demo-private'))

    const pluginEnvelope = JSON.parse(await fs.readFile(path.join(DAV_ROOT, 'plugins', 'config.json'), 'utf8'))
    const remotePlugins = Object.fromEntries(pluginEnvelope.body.plugins.map((p) => [p.name, p]))
    check('GitHub repository becomes a portable github: spec', remotePlugins['demo-local']?.spec === 'github:ToddModica/demo-plugin', remotePlugins['demo-local']?.spec)
    check('registry dependency carries its version', remotePlugins['from-npm']?.spec === 'from-npm@1.2.3', remotePlugins['from-npm']?.spec)
    check('local-only plugin carries no install spec', remotePlugins['demo-private']?.localOnly === true && !remotePlugins['demo-private'].spec)
    const remotePkg = JSON.parse(pluginEnvelope.body.files['profile/package.json'])
    // A bundle listed without a dependency is pruned by the next install, so the
    // link must become the portable spec rather than disappear.
    check(
      'a local link dependency is replaced by its portable spec in the payload',
      remotePkg.dependencies?.['demo-local'] === 'github:ToddModica/demo-plugin',
      remotePkg.dependencies?.['demo-local'],
    )
    check(
      'the payload never carries an absolute link target',
      !JSON.stringify(remotePkg).includes(localPluginDir),
    )
    // A plugin that exists only here cannot be restored elsewhere, so its bundle
    // selection must not reach the payload either: a bundle with no dependency is
    // a selection the other machine can neither install nor resolve.
    check(
      'a bundle whose plugin is local-only is left out of the payload',
      !(remotePkg.dsh?.profile?.bundles ?? []).includes('demo-private'),
      (remotePkg.dsh?.profile?.bundles ?? []).join(','),
    )
    check(
      'portable bundles stay selected in the payload',
      (remotePkg.dsh?.profile?.bundles ?? []).includes('demo-local')
        && (remotePkg.dsh?.profile?.bundles ?? []).includes('from-npm'),
      (remotePkg.dsh?.profile?.bundles ?? []).join(','),
    )

    // The pushing machine must not see its own package.json as a permanent conflict.
    const originPull = await run(h3.tools, 'mini_sync_pull', {})
    const originPkgChange = originPull.changes.find((c) => c.rel === 'profile/package.json')
    check('origin pull treats its package with links as identical', originPkgChange?.action === 'identical', originPkgChange?.action)

    // Simulate a new machine that has none of those plugins.
    await fs.writeFile(profilePkgPath, JSON.stringify({
      name: 'dsh-profile-desktop',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      dependencies: {},
    }, null, 2))
    const newMachinePull = await run(h3.tools, 'mini_sync_pull', { apply: true, force: true, installPlugins: true })
    check('pull reports two installable missing plugins', newMachinePull.plugins.missing.length === 2, JSON.stringify(newMachinePull.plugins.missing))
    check('pull reports the local-only plugin separately', newMachinePull.plugins.localOnly.length === 1)
    const installedSpecs = (newMachinePull.plugins.install?.installed ?? []).map((p) => p.spec)
    check('pull installs the portable GitHub plugin', installedSpecs.includes('github:ToddModica/demo-plugin'), installedSpecs.join(','))
    check('pull installs the registry plugin', installedSpecs.includes('from-npm@1.2.3'), installedSpecs.join(','))
    check('pull does not try to install a local-only plugin', !installedSpecs.includes('demo-private'))
    // Selecting a bundle that resolves nowhere is a startup failure, not a
    // missing-plugin notice, so the selection must not survive the pull.
    const newMachinePkg = JSON.parse(await fs.readFile(profilePkgPath, 'utf8'))
    const newMachineBundles = newMachinePkg.dsh?.profile?.bundles ?? []
    check(
      'a bundle this machine cannot resolve is not selected',
      !newMachineBundles.includes('demo-private'),
      newMachineBundles.join(','),
    )
    check(
      'installable bundles stay selected',
      newMachineBundles.includes('demo-local') && newMachineBundles.includes('from-npm'),
      newMachineBundles.join(','),
    )
    check('install result is surfaced in the summary', /installed\s+demo-local/.test(newMachinePull.summary ?? ''))

    // --- a declared dependency that is not materialized is NOT installed ---
    // The real failure: package.json listed the plugin, node_modules lacked it, so
    // the manager answered "already-installed" while nothing was resolvable.
    await fs.rm(path.join(nodeModules, 'from-npm'), { recursive: true, force: true })
    await fs.writeFile(profilePkgPath, JSON.stringify({
      name: 'dsh-profile-desktop',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'from-npm'] } },
      dependencies: { 'from-npm': '^1.2.3' },
    }, null, 2))
    const stalePull = await run(h3.tools, 'mini_sync_pull', {})
    const staleEntry = stalePull.plugins.missing.find((p) => p.name === 'from-npm')
      ?? stalePull.plugins.present.find((p) => p.name === 'from-npm')
    check(
      'a declared-but-unresolvable dependency counts as missing',
      Boolean(stalePull.plugins.missing.find((p) => p.name === 'from-npm')),
      `missing=${stalePull.plugins.missing.map((p) => p.name).join(',') || '(none)'} present=${stalePull.plugins.present.map((p) => p.name).join(',') || '(none)'}`,
    )
    void staleEntry

    // And a manager that does nothing must not be reported as a successful install.
    // Clear what the earlier install materialized so this machine starts bare.
    await fs.rm(nodeModules, { recursive: true, force: true })
    const inertManager = {
      listBundles: async () => [],
      installBundle: async () => ({ changed: false, error: { code: 'already-installed' } }),
    }
    const hInert = makeCtx({}, { pluginManager: inertManager })
    apply(hInert.ctx, {})
    await run(hInert.tools, 'mini_sync_setup', { url: BASE, remoteDir: 'plugins', encrypt: false })
    const inertPull = await run(hInert.tools, 'mini_sync_pull', { apply: true, force: true, installPlugins: true })
    check(
      'an install that materializes nothing is reported as failed, not installed',
      (inertPull.plugins.install?.installed ?? []).length === 0
        && (inertPull.plugins.install?.failed ?? []).length > 0,
      `installed=${JSON.stringify(inertPull.plugins.install?.installed)} failed=${JSON.stringify((inertPull.plugins.install?.failed ?? []).map((f) => f.error))}`,
    )

    // A manager that can remove the stale declaration must be used to recover,
    // instead of handing the user a "remove it, then install it again" chore.
    await fs.rm(nodeModules, { recursive: true, force: true })
    let stale = true
    const recoverCalls = []
    const recoveringManager = {
      listBundles: async () => [],
      installBundle: async (spec) => {
        recoverCalls.push(`install:${spec}`)
        // First attempt: the declaration exists, the package does not.
        if (stale) return { changed: false, application: 'failed', error: { code: 'already-installed' } }
        const name = await nameForSpec(spec)
        await fs.mkdir(path.join(nodeModules, ...name.split('/')), { recursive: true })
        await fs.writeFile(
          path.join(nodeModules, ...name.split('/'), 'package.json'),
          JSON.stringify({ name, version: '1.2.3', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
        )
        return { changed: true, application: 'restart-required' }
      },
      removeBundle: async (name) => {
        recoverCalls.push(`remove:${name}`)
        stale = false
      },
    }
    const hRecover = makeCtx({}, { pluginManager: recoveringManager })
    apply(hRecover.ctx, {})
    await run(hRecover.tools, 'mini_sync_setup', { url: BASE, remoteDir: 'plugins', encrypt: false })
    const recoverPull = await run(hRecover.tools, 'mini_sync_pull', { apply: true, force: true, installPlugins: true })
    const recovered = (recoverPull.plugins.install?.installed ?? []).find((p) => p.name === 'demo-local')
    check(
      'a stale declaration is removed and the plugin installed again',
      recovered?.recovered === true,
      `installed=${JSON.stringify(recoverPull.plugins.install?.installed)} calls=${recoverCalls.join(',')}`,
    )
    check('the stale declaration was removed once, before reinstalling', recoverCalls.includes('remove:demo-local'), recoverCalls.join(','))

    // A local link that still resolves must survive a package.json pull, even when
    // the remote now carries a portable spec for that same plugin.
    await fs.writeFile(profilePkgPath, JSON.stringify({
      name: 'dsh-profile-desktop',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'demo-local'] } },
      dependencies: { 'demo-local': `link:${localPluginDir}` },
    }, null, 2))
    await run(h3.tools, 'mini_sync_pull', { apply: true, force: true, installPlugins: false })
    const keptPkg = JSON.parse(await fs.readFile(profilePkgPath, 'utf8'))
    check('pull keeps a resolvable machine-local link dependency', keptPkg.dependencies?.['demo-local'] === `link:${localPluginDir}`)
    check('pull keeps the bundle selection for that local plugin', keptPkg.dsh?.profile?.bundles?.includes('demo-local'))

    // The origin machine of a local-only plugin (no portable spec) must keep its
    // own selection: there the link resolves, so pruning it would disable a
    // working plugin. Only a selection that resolves *nowhere here* is dropped.
    // pnpm materializes a link: dependency as a node_modules symlink; only then
    // does the plugin actually resolve for DSH.
    await fs.mkdir(nodeModules, { recursive: true })
    await fs.rm(path.join(nodeModules, 'demo-private'), { recursive: true, force: true })
    await fs.symlink(privatePluginDir, path.join(nodeModules, 'demo-private'))
    await fs.writeFile(profilePkgPath, JSON.stringify({
      name: 'dsh-profile-desktop',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'demo-private'] } },
      dependencies: { 'demo-private': `link:${privatePluginDir}` },
    }, null, 2))
    const originKeeppull = await run(h3.tools, 'mini_sync_pull', { apply: true, force: true, installPlugins: false })
    const originPkgAfter = JSON.parse(await fs.readFile(profilePkgPath, 'utf8'))
    check(
      'a resolvable local-only plugin keeps its bundle selection',
      originPkgAfter.dsh?.profile?.bundles?.includes('demo-private'),
      `bundles=${(originPkgAfter.dsh?.profile?.bundles ?? []).join(',')} merged=${(originKeeppull.merged ?? []).join('; ')}`,
    )

    // --- optional passphrase: explicit plaintext -------------------------
    await run(h3.tools, 'mini_sync_setup', { url: BASE, remoteDir: 'plain', encrypt: false, keepVersions: 0 })
    const plainPush = await run(h3.tools, 'mini_sync_push')
    check('encrypt:false uploads plaintext without complaint', plainPush.encrypted === false)
    const plainEnvelope = JSON.parse(await fs.readFile(path.join(DAV_ROOT, 'plain', 'config.json'), 'utf8'))
    check('plaintext envelope is marked unencrypted', plainEnvelope.encrypted === false)
    check('plaintext payload carries the credentials', JSON.stringify(plainEnvelope).includes('sk-test-123'))
    check('plaintext push warns about the exposure', (plainPush.notes ?? []).some((n) => /PLAINTEXT/.test(n)))
    const plainPull = await run(h3.tools, 'mini_sync_pull', {})
    check('plaintext remote pulls without a passphrase', plainPull.missing !== true && Array.isArray(plainPull.changes))

    // --- optional passphrase: encrypt on but no passphrase configured -----
    const h4 = makeCtx({})
    apply(h4.ctx, {})
    await run(h4.tools, 'mini_sync_setup', { url: BASE, remoteDir: 'no-passphrase', encrypt: true, keepVersions: 0 })
    const noPassPush = await run(h4.tools, 'mini_sync_push')
    check('encrypt:true with no passphrase falls back to plaintext', noPassPush.encrypted === false)
    check('fallback warning explains the missing passphrase', (noPassPush.notes ?? []).some((n) => /No encryption passphrase/i.test(n)))

    // --- remote file browser and deletion --------------------------------
    await run(tools, 'mini_sync_setup', { url: BASE, remoteDir: 'browse', keepVersions: 2, encrypt: false })
    for (let i = 0; i < 3; i += 1) await run(tools, 'mini_sync_push')

    const browseRoute = h.routes.find((r) => r.path === '/dsh-mini-sync/api')
    const invoke = async (action, extra = {}) => {
      const body = JSON.stringify({ action, ...extra })
      const req = {
        method: 'POST',
        headers: { host: '127.0.0.1' },
        async *[Symbol.asyncIterator]() { yield Buffer.from(body) },
      }
      let status
      let payload
      const res = {
        writeHead: (code) => { status = code },
        end: (text) => { payload = JSON.parse(text) },
      }
      await browseRoute.handler(req, res)
      return { status, payload }
    }

    const listed = await invoke('files')
    check('files action lists the remote folder', listed.payload.ok === true, listed.payload.error)
    const listedFiles = listed.payload.value?.files ?? []
    const listedPaths = listedFiles.map((f) => f.path)
    check('remote list includes config.json', listedPaths.includes('config.json'), listedPaths.join(','))
    check('remote list includes both history versions', listedPaths.filter((p) => p.startsWith('history/')).length === 2, listedPaths.join(','))
    check('remote list carries size and modified time', listedFiles.every((f) => typeof f.size === 'number' && f.modified), JSON.stringify(listedFiles))
    check('payload is ranked before history', listedFiles[0]?.path === 'config.json', listedPaths.join(','))

    const victim = listedPaths.find((p) => p.startsWith('history/'))
    const deleted = await invoke('delete', { name: victim })
    check('delete action removes the chosen history file', deleted.payload.ok === true, deleted.payload.error)
    const victimGone = await fs.stat(path.join(DAV_ROOT, 'browse', victim)).then(() => false).catch(() => true)
    check('deleted history file is gone from disk', victimGone)
    const afterDelete = await invoke('files')
    check('remote list reflects the deletion', !(afterDelete.payload.value?.files ?? []).some((f) => f.path === victim))

    const traversal = await invoke('delete', { name: '../config.json' })
    check('delete rejects path traversal', traversal.payload.ok === false)
    const wrongFolder = await invoke('delete', { name: 'other/config.json' })
    check('delete rejects unknown subfolders', wrongFolder.payload.ok === false)
    const missingName = await invoke('delete', {})
    check('delete rejects an empty name', missingName.payload.ok === false)
    const folderDelete = await invoke('delete', { name: 'history' })
    check('delete refuses to remove the history folder itself', folderDelete.payload.ok === false)

    const payloadDelete = await invoke('delete', { name: 'config.json' })
    check('delete action can remove the payload', payloadDelete.payload.ok === true, payloadDelete.payload.error)
    const payloadGone = await fs.stat(path.join(DAV_ROOT, 'browse', 'config.json')).then(() => false).catch(() => true)
    check('deleted payload is gone from disk', payloadGone)
  } finally {
    server.kill()
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) process.exitCode = 1
}

main().catch((error) => { console.error('HARNESS ERROR', error); process.exitCode = 1 })