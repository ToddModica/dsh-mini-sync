/**
 * dsh-mini-sync — minimal cross-device configuration sync over your own WebDAV.
 *
 * What travels: model providers (api / base URL / headers / API keys), the plugin
 * bundle list, global settings, skills and — optionally — the DSH credential store.
 * What never travels: conversations, sessions, attachments, workspace registries.
 *
 * Everything is sealed into ONE encrypted JSON file on the remote, so the WebDAV
 * folder never accumulates a pile of archives. `keepVersions` controls whether the
 * remote keeps history at all (0 = a single file, always overwritten in place).
 *
 * Zero runtime dependencies: node:crypto for the envelope, global fetch for WebDAV.
 */

import { createHash, randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { homedir, hostname } from 'node:os'
import path from 'node:path'
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'

export const name = 'dsh-mini-sync'

const FORMAT = 'dsh-mini-sync'
const FORMAT_VERSION = 1
const PAYLOAD_FILE = 'config.json'
const HISTORY_DIR = 'history'

/** Files (relative to $DSH_HOME) that carry portable configuration. */
const PROFILE_FILES = ['cordis.patch.yml', 'package.json']
const HOME_FILES = ['settings.yaml', 'settings.json', 'AGENTS.md']
const CREDENTIAL_FILE = '.credentials.yaml'

const MAX_FILE_BYTES = 512 * 1024
const MAX_TOTAL_BYTES = 4 * 1024 * 1024
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tgz',
  '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.mp3', '.wav', '.wasm', '.node',
])

const DEFAULTS = {
  url: '',
  username: '',
  passwordRef: 'DSH_SYNC_WEBDAV_PASSWORD',
  passphraseRef: 'DSH_SYNC_PASSPHRASE',
  remoteDir: 'dsh-mini-sync',
  includeCredentials: true,
  includeSkills: true,
  intervalMinutes: 0,
  keepVersions: 0,
  pullOnStart: false,
  encrypt: true,
  pathMap: [],
  syncProviders: [],
  rewriteBaseURL: [],
}

// ---------------------------------------------------------------- environment

function dshHome() {
  return process.env.DSH_HOME || path.join(homedir(), '.dsh')
}

function profileName() {
  return process.env.DSH_PROFILE || 'desktop'
}

function pluginDataDir() {
  return path.join(dshHome(), FORMAT)
}

function statePath() {
  return path.join(pluginDataDir(), 'state.json')
}

function localSettingsPath() {
  return path.join(pluginDataDir(), 'settings.json')
}

// ----------------------------------------------------------------- utilities

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

async function readTextIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

async function readJsonIfExists(file) {
  const text = await readTextIfExists(file)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(tmp, file)
}

async function writeTextAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, file)
}

async function walkFiles(root, prefix, out, budget) {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (budget.bytes > MAX_TOTAL_BYTES) return
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const full = path.join(root, entry.name)
    const rel = `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      await walkFiles(full, rel, out, budget)
      continue
    }
    if (!entry.isFile()) continue
    if (BINARY_EXT.has(path.extname(entry.name).toLowerCase())) continue
    try {
      const stat = await fs.stat(full)
      if (stat.size > MAX_FILE_BYTES) continue
      const text = await fs.readFile(full, 'utf8')
      out[rel] = text
      budget.bytes += Buffer.byteLength(text, 'utf8')
    } catch {
      // Unreadable single file: skip it rather than fail the whole sync.
    }
  }
}

/** True when a path is absolute in Windows or POSIX form. */
function isAbsoluteAnywhere(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/')
}

function applyPathMap(text, pathMap) {
  let result = text
  for (const rule of pathMap ?? []) {
    if (!rule?.from || rule?.to === undefined) continue
    result = result.split(rule.from).join(rule.to)
  }
  return result
}

/**
 * A profile's package.json may carry `link:`/`file:` dependencies pointing at an
 * absolute path that only exists on the machine that wrote it. Installing that on
 * another OS breaks the profile, so drop those entries here and report them —
 * the bundle list itself still travels, and `dsh plugin add` restores the plugin
 * on the target machine.
 */
function sanitizePackageJson(text) {
  let pkg
  try {
    pkg = JSON.parse(text)
  } catch {
    return { text, dropped: [] }
  }
  const deps = pkg?.dependencies
  if (!deps || typeof deps !== 'object') return { text, dropped: [] }

  const dropped = []
  for (const [dep, spec] of Object.entries(deps)) {
    if (typeof spec !== 'string') continue
    const local = spec.startsWith('link:') ? spec.slice(5)
      : spec.startsWith('file:') ? spec.slice(5)
        : undefined
    if (local === undefined) continue
    if (isAbsoluteAnywhere(local) && !existsSync(local)) {
      delete deps[dep]
      dropped.push(`${dep} (${spec})`)
    }
  }
  const links = Array.isArray(pkg?.dsh?.profile?.links) ? pkg.dsh.profile.links : undefined
  if (links) {
    pkg.dsh.profile.links = links.filter((entry) => {
      if (typeof entry === 'string' && isAbsoluteAnywhere(entry) && !existsSync(entry)) {
        dropped.push(`link entry ${entry}`)
        return false
      }
      return true
    })
  }
  if (!dropped.length) return { text, dropped }
  return { text: `${JSON.stringify(pkg, null, 2)}\n`, dropped }
}

// ------------------------------------------------------------ provider filter

function providerMapOf(row) {
  return row?.config?.providers && typeof row.config.providers === 'object'
    ? row.config.providers
    : undefined
}

/**
 * Narrow the provider map of `cordis.patch.yml` to the providers/models the user
 * named in `syncProviders`. Other tooling writes its own provider and model
 * entries into this same file; those must not travel to another machine.
 *
 * Entry forms:
 *   "opencodex"                     every model of that provider
 *   "opencodex/Qwen/qwen3.8-max"    one model (model ids contain slashes)
 */
function filterProviders(doc, syncProviders) {
  if (!Array.isArray(syncProviders) || syncProviders.length === 0) {
    return { doc, applied: false, kept: [], dropped: [] }
  }
  const wanted = new Map()
  for (const entry of syncProviders) {
    if (typeof entry !== 'string' || !entry.includes('/')) {
      if (typeof entry === 'string' && entry) wanted.set(entry, null)
      continue
    }
    const cut = entry.indexOf('/')
    const provider = entry.slice(0, cut)
    const model = entry.slice(cut + 1)
    if (!wanted.has(provider)) wanted.set(provider, new Set())
    const set = wanted.get(provider)
    if (set) set.add(model)
  }

  const kept = []
  const dropped = []
  for (const row of doc) {
    const providers = providerMapOf(row)
    if (!providers) continue
    for (const providerId of Object.keys(providers)) {
      const allow = wanted.get(providerId)
      if (allow === undefined) {
        dropped.push(providerId)
        delete providers[providerId]
        continue
      }
      const models = providers[providerId]?.models
      if (!Array.isArray(models)) {
        kept.push(providerId)
        continue
      }
      const survivors = models.filter((model) => allow === null || allow.has(model?.id))
      for (const model of models) {
        if (!survivors.includes(model)) dropped.push(`${providerId}/${model?.id}`)
      }
      // An explicit model list that matches nothing would leave a provider with
      // no models; keep the provider config and report it rather than guessing.
      providers[providerId].models = survivors
      kept.push(allow === null ? providerId : `${providerId} (${survivors.length} model(s))`)
    }
  }
  return { doc, applied: true, kept, dropped }
}

function serializePatch(doc) {
  return yamlDump(doc, { lineWidth: 120, noRefs: true, quotingType: '"', forceQuotes: false })
}

/** True for base URLs that only resolve on the machine that wrote them. */
function isLoopbackUrl(url) {
  if (typeof url !== 'string') return false
  let host
  try {
    host = new URL(url).hostname
  } catch {
    return false
  }
  return host === 'localhost' || host === '::1' || /^127\./.test(host)
}

/**
 * Every machine runs its own gateway on its own loopback port, so a provider base
 * URL pointing at 127.0.0.1 is meaningful only on the machine that wrote it.
 * `rewriteBaseURL` lets the user relocate those URLs while pushing:
 *   [{ "match": "127.0.0.1:10100", "replace": "192.168.1.20:10100" }]
 * An empty list leaves the URLs untouched, and loopback URLs are reported so the
 * user is never surprised by a dead address on the other machine.
 */
function rewriteProviderUrls(doc, rules) {
  const changed = []
  const loopback = []
  const list = Array.isArray(rules) ? rules.filter((r) => r?.match && r?.replace !== undefined) : []
  for (const row of doc) {
    const providers = providerMapOf(row)
    if (!providers) continue
    for (const [id, provider] of Object.entries(providers)) {
      if (typeof provider?.baseURL !== 'string') continue
      const before = provider.baseURL
      let after = before
      for (const rule of list) after = after.split(rule.match).join(rule.replace)
      if (after !== before) {
        provider.baseURL = after
        changed.push(`${id}: ${before} -> ${after}`)
      } else if (isLoopbackUrl(after)) {
        loopback.push(`${id}: ${after}`)
      }
    }
  }
  return { changed, loopback }
}

/** Split a leading run of comment/blank lines so re-serialising does not eat it. */
function splitHeader(text) {
  const lines = text.split('\n')
  let end = 0
  while (end < lines.length && (lines[end].startsWith('#') || lines[end].trim() === '')) end += 1
  return { header: lines.slice(0, end).join('\n'), body: lines.slice(end).join('\n') }
}

/** Apply the whitelist and URL rewrites to a cordis.patch.yml text. */
function filterPatchText(text, settings) {
  const hasFilter = Array.isArray(settings.syncProviders) && settings.syncProviders.length > 0
  const hasRewrite = Array.isArray(settings.rewriteBaseURL) && settings.rewriteBaseURL.length > 0
  if (!hasFilter && !hasRewrite) return { text, report: null }

  const { header, body } = splitHeader(text)
  let doc
  try {
    doc = yamlLoad(body)
  } catch (error) {
    return { text, report: { error: `could not parse cordis.patch.yml: ${error.message}` } }
  }
  if (!Array.isArray(doc)) return { text, report: { error: 'cordis.patch.yml is not a list of rows' } }

  const report = {}
  if (hasFilter) {
    const result = filterProviders(doc, settings.syncProviders)
    if (result.applied) {
      report.kept = result.kept
      report.dropped = result.dropped
    }
  }
  const urls = rewriteProviderUrls(doc, settings.rewriteBaseURL)
  if (urls.changed.length) report.urlsChanged = urls.changed
  if (urls.loopback.length) report.loopback = urls.loopback

  if (!report.kept && !report.urlsChanged && !report.loopback) {
    return { text, report: Object.keys(report).length ? report : null }
  }
  return {
    text: `${header ? `${header}\n` : ''}${serializePatch(doc)}`,
    report,
  }
}

/**
 * Merge the whitelisted providers from a remote patch into the local one.
 *
 * A plain overwrite would delete whatever this machine's other tooling wrote into
 * the same file, so only the named providers/models are taken from the remote;
 * every other local provider stays exactly as it is.
 */
function mergePatchText(localText, remoteText, settings) {
  if (!Array.isArray(settings.syncProviders) || settings.syncProviders.length === 0) {
    return { text: remoteText, replaced: true }
  }
  const localHeader = splitHeader(localText)
  const remoteHeader = splitHeader(remoteText)
  let localDoc
  let remoteDoc
  try {
    localDoc = yamlLoad(localHeader.body) ?? []
    remoteDoc = yamlLoad(remoteHeader.body) ?? []
  } catch (error) {
    return { text: remoteText, replaced: true, error: error.message }
  }
  if (!Array.isArray(localDoc) || !Array.isArray(remoteDoc)) {
    return { text: remoteText, replaced: true }
  }

  const remoteProviders = new Map()
  for (const row of remoteDoc) {
    const providers = providerMapOf(row)
    if (!providers) continue
    for (const [id, value] of Object.entries(providers)) remoteProviders.set(id, value)
  }

  let touched = 0
  for (const row of localDoc) {
    const providers = providerMapOf(row)
    if (!providers) continue
    for (const [id, value] of Object.entries(providers)) {
      if (!remoteProviders.has(id)) continue
      const remoteValue = remoteProviders.get(id)
      const next = { ...remoteValue }
      // Keep any local model this machine has that the remote did not carry, so a
      // narrower remote whitelist never silently deletes a local model.
      const remoteModelIds = new Set((remoteValue?.models ?? []).map((m) => m?.id))
      const extra = (value?.models ?? []).filter((m) => !remoteModelIds.has(m?.id))
      if (extra.length) next.models = [...(remoteValue?.models ?? []), ...extra]
      providers[id] = next
      touched += 1
    }
  }
  if (!touched) return { text: localText, replaced: false, touched: 0 }
  return {
    text: `${localHeader.header ? `${localHeader.header}\n` : ''}${serializePatch(localDoc)}`,
    replaced: false,
    touched,
  }
}

// -------------------------------------------------------------- local payload

async function collectLocalFiles(settings) {
  const home = dshHome()
  const profileDir = path.join(home, 'profiles', profileName())
  const files = {}
  const budget = { bytes: 0 }
  const skipped = []

  for (const name of PROFILE_FILES) {
    const text = await readTextIfExists(path.join(profileDir, name))
    if (text === undefined) {
      skipped.push(`profiles/${profileName()}/${name} (absent)`)
      continue
    }
    files[`profile/${name}`] = text
    budget.bytes += Buffer.byteLength(text, 'utf8')
  }

  for (const name of HOME_FILES) {
    const text = await readTextIfExists(path.join(home, name))
    if (text === undefined) continue
    files[name] = text
    budget.bytes += Buffer.byteLength(text, 'utf8')
  }

  if (settings.includeSkills) {
    await walkFiles(path.join(home, 'skills'), 'skills', files, budget)
  }

  if (settings.includeCredentials) {
    const text = await readTextIfExists(path.join(home, CREDENTIAL_FILE))
    if (text === undefined) {
      skipped.push(`${CREDENTIAL_FILE} (absent)`)
    } else {
      files[CREDENTIAL_FILE] = text
      budget.bytes += Buffer.byteLength(text, 'utf8')
    }
  }

  return { files, skipped }
}

/** Map a payload-relative key back to the absolute path on THIS machine. */
function resolveLocalTarget(rel) {
  const home = dshHome()
  if (rel.startsWith('profile/')) {
    return path.join(home, 'profiles', profileName(), rel.slice('profile/'.length))
  }
  if (rel.startsWith('skills/')) {
    return path.join(home, rel)
  }
  return path.join(home, rel)
}

// ------------------------------------------------------------------ crypto

function deriveKey(passphrase, salt) {
  return scryptSync(passphrase.normalize('NFKC'), salt, 32, { N: 16384, r: 8, p: 1 })
}

function seal(plaintext, passphrase) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    encrypted: true,
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

function unseal(envelope, passphrase) {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(passphrase, Buffer.from(envelope.salt, 'base64')),
    Buffer.from(envelope.iv, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

// ------------------------------------------------------------------- WebDAV

function joinUrl(base, ...parts) {
  const root = base.replace(/\/+$/, '')
  return [root, ...parts.filter(Boolean).map((p) => String(p).replace(/^\/+|\/+$/g, ''))]
    .join('/')
}

function authHeaders(settings, password) {
  if (!settings.username) return {}
  return {
    Authorization: `Basic ${Buffer.from(`${settings.username}:${password}`, 'utf8').toString('base64')}`,
  }
}

async function ensureCollection(baseUrl, settings, password) {
  const response = await fetch(joinUrl(baseUrl, settings.remoteDir), {
    method: 'MKCOL',
    headers: authHeaders(settings, password),
  })
  // 405 = already there; 401/403 surface later on PUT with a clearer message.
  if (!response.ok && response.status !== 405) {
    // A nested parent may be missing; report rather than pretend success.
    if (response.status === 409) {
      throw new Error(
        `WebDAV parent collection for "${settings.remoteDir}" does not exist (409). Create it once in your WebDAV client, or point remoteDir at an existing folder.`,
      )
    }
  }
}

async function remotePut(url, settings, password, body) {
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      ...authHeaders(settings, password),
      'Content-Type': 'application/json; charset=utf-8',
    },
    body,
  })
  if (!response.ok) {
    throw new Error(`PUT ${url} failed: HTTP ${response.status} ${response.statusText}`)
  }
}

async function remoteGet(url, settings, password) {
  const response = await fetch(url, {
    method: 'GET',
    headers: authHeaders(settings, password),
  })
  if (response.status === 404) return undefined
  if (!response.ok) {
    throw new Error(`GET ${url} failed: HTTP ${response.status} ${response.statusText}`)
  }
  return response.text()
}

async function remoteDelete(url, settings, password) {
  const response = await fetch(url, {
    method: 'DELETE',
    headers: authHeaders(settings, password),
  })
  return response.ok || response.status === 404
}

async function listHistory(url, settings, password) {
  const response = await fetch(url, {
    method: 'PROPFIND',
    headers: { ...authHeaders(settings, password), Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/></d:prop></d:propfind>',
  })
  if (!response.ok) return []
  const xml = await response.text()
  const names = []
  for (const match of xml.matchAll(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/gi)) {
    const href = decodeURIComponent(match[1])
    const base = href.split('/').filter(Boolean).pop() || ''
    if (base.endsWith('.json')) names.push(base)
  }
  return names
}

// ------------------------------------------------------------------- state

async function loadState() {
  return (await readJsonIfExists(statePath())) ?? { files: {}, lastPushAt: null, lastPullAt: null }
}

async function saveState(state) {
  await writeJsonAtomic(statePath(), state)
}

async function loadLocalSettings() {
  return (await readJsonIfExists(localSettingsPath())) ?? {}
}

// ------------------------------------------------------------ config resolve

function resolveSettings(config, stored) {
  const merged = { ...DEFAULTS, ...(config ?? {}), ...(stored ?? {}) }
  for (const key of Object.keys(DEFAULTS)) {
    if (merged[key] === '' && typeof DEFAULTS[key] !== 'string') merged[key] = DEFAULTS[key]
  }
  merged.intervalMinutes = Number(merged.intervalMinutes) || 0
  merged.keepVersions = Math.max(0, Math.trunc(Number(merged.keepVersions) || 0))
  return merged
}

function requireConfigured(settings) {
  if (!settings.url) {
    throw new Error(
      'WebDAV URL is not configured. Run mini_sync_setup with url (and username/password), or set config.url in the profile patch.',
    )
  }
}

async function resolveSecrets(ctx, settings) {
  const credentials = ctx.get('credentials')
  const password = settings.username && credentials
    ? (await credentials.resolve(settings.passwordRef))?.value
    : undefined
  const passphrase = credentials
    ? (await credentials.resolve(settings.passphraseRef))?.value
    : undefined
  if (settings.username && !password) {
    throw new Error(
      `WebDAV password is missing. Run mini_sync_setup with password (stored as credential "${settings.passwordRef}").`,
    )
  }
  if (settings.encrypt && !passphrase) {
    throw new Error(
      `Encryption passphrase is missing. Run mini_sync_setup with passphrase (stored as credential "${settings.passphraseRef}").`,
    )
  }
  return { password, passphrase }
}

// ------------------------------------------------------------------- engine

function deviceLabel() {
  return hostname()
}

async function buildPayload(settings) {
  const { files, skipped } = await collectLocalFiles(settings)
  const notes = []

  if (typeof files['profile/cordis.patch.yml'] === 'string') {
    const { text: filtered, report } = filterPatchText(files['profile/cordis.patch.yml'], settings)
    files['profile/cordis.patch.yml'] = filtered
    if (report?.error) {
      notes.push(`Provider filter skipped: ${report.error}`)
    } else if (report) {
      if (report.kept) {
        const kept = report.kept.length ? report.kept.join(', ') : '(none)'
        notes.push(
          `Provider whitelist kept: ${kept}`,
          report.dropped.length
            ? `Not synced (not in syncProviders): ${report.dropped.join(', ')}`
            : 'Nothing else in providers was excluded.',
        )
        if (!report.kept.length) {
          notes.push('Warning: syncProviders matched no provider — the synced patch carries no provider config.')
        }
      }
      if (report.urlsChanged) notes.push(`Base URLs rewritten: ${report.urlsChanged.join('; ')}`)
      if (report.loopback) {
        notes.push(
          `Warning: these base URLs point at a loopback address (127.0.0.1/localhost): ${report.loopback.join('; ')}`,
          'A loopback address only works on the machine that wrote it. Set rewriteBaseURL to map it to an address the other machine can reach, or fill it in there after pulling.',
        )
      }
    }
  }

  if (typeof files['profile/package.json'] === 'string') {
    const { text: cleaned, dropped } = sanitizePackageJson(files['profile/package.json'])
    files['profile/package.json'] = cleaned
    if (dropped.length) {
      notes.push(
        `Left out machine-local plugin links from package.json (they only resolve on this machine): ${dropped.join('; ')}`,
      )
    }
  }

  const pathMap = Array.isArray(settings.pathMap) ? settings.pathMap : []
  if (pathMap.length) {
    for (const key of Object.keys(files)) {
      files[key] = applyPathMap(files[key], pathMap)
    }
  }

  const body = {
    format: FORMAT,
    version: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    device: deviceLabel(),
    platform: process.platform,
    profile: profileName(),
    files,
  }
  return { body, files, skipped, notes }
}

async function doPush(ctx, settings) {
  requireConfigured(settings)
  const { password, passphrase } = await resolveSecrets(ctx, settings)
  const { body, files, skipped, notes } = await buildPayload(settings)
  const plaintext = JSON.stringify(body)
  const serialized = settings.encrypt
    ? JSON.stringify(seal(plaintext, passphrase), null, 2)
    : JSON.stringify({ format: FORMAT, version: FORMAT_VERSION, encrypted: false, body }, null, 2)

  await ensureCollection(settings.url, settings, password)
  const target = joinUrl(settings.url, settings.remoteDir, PAYLOAD_FILE)
  await remotePut(target, settings, password, serialized)

  let pruned = 0
  if (settings.keepVersions > 0) {
    const historyUrl = joinUrl(settings.url, settings.remoteDir, HISTORY_DIR)
    await fetch(historyUrl, { method: 'MKCOL', headers: authHeaders(settings, password) })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await remotePut(joinUrl(historyUrl, `v-${stamp}.json`), settings, password, serialized)
    const names = (await listHistory(historyUrl, settings, password)).sort().reverse()
    for (const stale of names.slice(settings.keepVersions)) {
      if (await remoteDelete(joinUrl(historyUrl, stale), settings, password)) pruned += 1
    }
  }

  const state = await loadState()
  state.files = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha256(v)]))
  state.lastPushAt = new Date().toISOString()
  state.remoteUrl = target
  await saveState(state)

  return {
    pushed: Object.keys(files).length,
    bytes: Buffer.byteLength(serialized, 'utf8'),
    encrypted: Boolean(settings.encrypt),
    keptVersions: settings.keepVersions,
    pruned,
    target,
    skipped,
    notes,
    names: Object.keys(files).sort(),
  }
}

async function fetchRemoteBody(settings, password, passphrase) {
  const target = joinUrl(settings.url, settings.remoteDir, PAYLOAD_FILE)
  const raw = await remoteGet(target, settings, password)
  if (raw === undefined) {
    return { missing: true, target }
  }
  let envelope
  try {
    envelope = JSON.parse(raw)
  } catch {
    throw new Error(`Remote file at ${target} is not valid JSON. It may be corrupt or from another tool.`)
  }
  if (envelope.format !== FORMAT) {
    throw new Error(`Remote file at ${target} is not a ${FORMAT} payload (format="${envelope.format}").`)
  }
  if (envelope.encrypted) {
    if (!passphrase) throw new Error('Remote payload is encrypted but no passphrase is configured.')
    let plaintext
    try {
      plaintext = unseal(envelope, passphrase)
    } catch {
      throw new Error('Could not decrypt the remote payload — wrong passphrase, or the file was altered.')
    }
    const body = JSON.parse(plaintext)
    return { body, target, createdAt: body.createdAt, device: body.device, platform: body.platform, profile: body.profile }
  }
  return {
    body: envelope.body,
    target,
    createdAt: envelope.body?.createdAt,
    device: envelope.body?.device,
    platform: envelope.body?.platform,
    profile: envelope.body?.profile,
  }
}

async function doPull(ctx, settings, { apply = false, force = false } = {}) {
  requireConfigured(settings)
  const { password, passphrase } = await resolveSecrets(ctx, settings)
  await ensureCollection(settings.url, settings, password)
  const remote = await fetchRemoteBody(settings, password, passphrase)
  if (remote.missing) {
    return { missing: true, target: remote.target }
  }

  const state = await loadState()
  const changes = []
  for (const [rel, remoteText] of Object.entries(remote.body.files ?? {})) {
    const targetPath = resolveLocalTarget(rel)
    const localText = await readTextIfExists(targetPath)
    const remoteHash = sha256(remoteText)
    if (localText !== undefined && sha256(localText) === remoteHash) {
      changes.push({ rel, action: 'identical' })
      continue
    }
    if (localText === undefined) {
      changes.push({ rel, action: apply ? 'created' : 'would-create', targetPath, text: remoteText })
      continue
    }
    const known = state.files?.[rel]
    if (known === undefined) {
      // No common ancestor on this machine (first sync of this device): adopt the
      // remote value, keeping a .bak of whatever the local default was.
      changes.push({ rel, action: apply ? 'adopted' : 'would-adopt', targetPath, text: remoteText })
      continue
    }
    if (known === sha256(localText)) {
      changes.push({ rel, action: apply ? 'updated' : 'would-update', targetPath, text: remoteText })
      continue
    }
    // Local file changed since the last sync — do not silently destroy it.
    changes.push({
      rel,
      action: force ? (apply ? 'forced' : 'would-force') : 'conflict',
      targetPath,
      text: force ? remoteText : undefined,
    })
  }

  if (apply) {
    const written = []
    const merged = []
    for (const change of changes) {
      if (!change.text) continue
      const backup = `${change.targetPath}.dsh-mini-sync.bak`
      const current = await readTextIfExists(change.targetPath)
      if (current !== undefined) await writeTextAtomic(backup, current)

      let payload = change.text
      if (change.rel === 'profile/cordis.patch.yml' && current !== undefined) {
        const outcome = mergePatchText(current, change.text, settings)
        payload = outcome.text
        if (!outcome.replaced) {
          merged.push(
            outcome.touched
              ? `merged ${outcome.touched} whitelisted provider(s), other local providers kept`
              : 'no whitelisted provider present locally; left this machine\'s providers untouched',
          )
        }
      }

      await writeTextAtomic(change.targetPath, payload)
      written.push(change.rel)
      state.files = { ...(state.files ?? {}), [change.rel]: sha256(payload) }
    }
    state.lastPullAt = new Date().toISOString()
    await saveState(state)
    return {
      applied: true,
      written,
      merged,
      changes,
      createdAt: remote.createdAt,
      device: remote.device,
      platform: remote.platform,
    }
  }

  return {
    applied: false,
    changes,
    createdAt: remote.createdAt,
    device: remote.device,
    platform: remote.platform,
    sourceProfile: remote.profile,
  }
}

// ------------------------------------------------------------------- output

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
const outSchema = { type: 'object' }

function summarizePush(result) {
  const lines = [
    `Pushed ${result.pushed} file(s), ${result.bytes} bytes to`,
    `  ${result.target}`,
    `Encrypted: ${result.encrypted ? 'yes' : 'no'} · history kept: ${result.keptVersions} (0 = single file only)`,
  ]
  if (result.pruned) lines.push(`Pruned ${result.pruned} old remote version(s).`)
  if (result.skipped?.length) lines.push(`Skipped: ${result.skipped.join(', ')}`)
  if (result.notes?.length) lines.push('', ...result.notes)
  lines.push('', 'Included:', ...result.names.map((n) => `  - ${n}`))
  return lines.join('\n')
}

function summarizePull(result) {
  if (result.missing) {
    return `No remote payload at ${result.target} yet. Run mini_sync_push on a configured machine first.`
  }
  const rows = result.changes.map((c) => `  ${c.action.padEnd(12)} ${c.rel}`)
  const head = [
    `Remote payload from ${result.device ?? 'unknown device'} at ${result.createdAt ?? 'unknown time'}.`,
    result.applied ? `Applied ${result.written.length} file(s).` : 'Dry run — nothing written. Pass apply: true to write.',
    '',
    ...rows,
  ]
  if (result.platform && result.platform !== process.platform) {
    head.push(
      '',
      `Note: that payload was produced on ${result.platform}, this machine is ${process.platform}.`,
      'Absolute paths in settings may not resolve — use mini_sync_setup pathMap to rewrite them, or fix them after applying.',
    )
  }
  const conflicts = result.changes.filter((c) => c.action === 'conflict')
  if (conflicts.length) {
    head.push(
      '',
      `${conflicts.length} file(s) changed locally since the last sync and were left alone.`,
      'Pass force: true to overwrite them with the remote version (a .dsh-mini-sync.bak backup is written first).',
    )
  }
  if (result.applied && result.written.includes('profile/package.json')) {
    head.push('', 'The plugin list changed — run `dsh plugin --profile <name> install` or restart DSH to apply it.')
  }
  return head.join('\n')
}

// -------------------------------------------------------------------- plugin

export function apply(ctx, config) {
  let stored
  let loaded = false

  const settingsNow = async () => {
    if (!loaded) {
      stored = await loadLocalSettings()
      loaded = true
    }
    return resolveSettings(config, stored)
  }

  const reload = () => {
    loaded = false
  }

  // ---- tools ------------------------------------------------------------
  const tools = ctx.get('tools')
  if (tools) {
    ctx.effect(() =>
      tools.register({
        name: 'mini_sync_status',
        description:
          'Show dsh-mini-sync state: WebDAV target, sync interval, retention policy, which files would travel, and when the last push/pull happened.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: { schema: outSchema, render: (_a, v) => text(v.summary) },
        execute: async () => {
          const settings = await settingsNow()
          const credentials = ctx.get('credentials')
          const { files, skipped } = await collectLocalFiles(settings)
          const state = await loadState()
          const passwordSet = settings.username
            ? Boolean((await credentials?.resolve(settings.passwordRef))?.value)
            : true
          const passphraseSet = Boolean((await credentials?.resolve(settings.passphraseRef))?.value)
          const lines = [
            `Target      : ${settings.url || '(not configured)'}`,
            `Folder      : ${settings.remoteDir}/${PAYLOAD_FILE}`,
            `User        : ${settings.username || '(anonymous)'}  password ${passwordSet ? 'set' : 'MISSING'}`,
            `Encryption  : ${settings.encrypt ? `on (passphrase ${passphraseSet ? 'set' : 'MISSING'})` : 'off'}`,
            `Interval    : ${settings.intervalMinutes > 0 ? `every ${settings.intervalMinutes} min` : 'off (manual only)'}`,
            `Retention   : ${settings.keepVersions > 0 ? `keep last ${settings.keepVersions} version(s)` : 'single file, overwritten in place'}`,
            `Last push   : ${state.lastPushAt ?? 'never'}`,
            `Last pull   : ${state.lastPullAt ?? 'never'}`,
            '',
            `Would sync ${Object.keys(files).length} file(s):`,
            ...Object.keys(files).sort().map((n) => `  - ${n}`),
          ]
          if (skipped.length) lines.push('', `Skipped: ${skipped.join(', ')}`)
          return { summary: lines.join('\n') }
        },
      }),
    )

    ctx.effect(() =>
      tools.register({
        name: 'mini_sync_setup',
        description:
          'Configure dsh-mini-sync: WebDAV url, username, password, encryption passphrase, sync interval in minutes, and how many remote versions to keep. Secrets are stored in the DSH credential store, never in config files.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'WebDAV base URL, e.g. https://dav.example.com/dsh.' },
            username: { type: 'string', description: 'WebDAV username; omit for anonymous.' },
            password: { type: 'string', description: 'WebDAV password; stored as a credential.' },
            passphrase: { type: 'string', description: 'Encryption passphrase; stored as a credential.' },
            remoteDir: { type: 'string', description: 'Folder under the URL that holds the sync file.' },
            intervalMinutes: { type: 'number', description: 'Auto-push interval in minutes; 0 disables it.' },
            keepVersions: { type: 'number', description: 'Remote versions to keep; 0 keeps a single file only.' },
            includeCredentials: { type: 'boolean', description: 'Include .credentials.yaml in the payload.' },
            includeSkills: { type: 'boolean', description: 'Include the skills directory in the payload.' },
            pullOnStart: { type: 'boolean', description: 'Pull and apply the remote config when this plugin loads.' },
            syncProviders: {
              type: 'array',
              description:
                'Whitelist of providers/models to sync. Other software writes its own providers into cordis.patch.yml; only these travel. Forms: "opencodex" (whole provider) or "opencodex/Qwen/qwen3.8-max" (one model). Empty = sync every provider.',
              items: { type: 'string' },
            },
            rewriteBaseURL: {
              type: 'array',
              description:
                'Rewrite provider base URLs while pushing, for gateways bound to a machine-specific address. Each entry is { match, replace }, e.g. {"match":"127.0.0.1:10100","replace":"192.168.1.20:10100"}.',
              items: {
                type: 'object',
                properties: {
                  match: { type: 'string' },
                  replace: { type: 'string' },
                },
                required: ['match', 'replace'],
                additionalProperties: false,
              },
            },
            pathMap: {
              type: 'array',
              description:
                'Rewrite absolute paths while pushing, for machines with different layouts. Each entry is { from, to }, e.g. {"from":"C:\\\\Users\\\\me\\\\","to":"/Users/me/"}.',
              items: {
                type: 'object',
                properties: {
                  from: { type: 'string' },
                  to: { type: 'string' },
                },
                required: ['from', 'to'],
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        output: { schema: outSchema, render: (_a, v) => text(v.summary) },
        execute: async (args) => {
          const credentials = ctx.get('credentials')
          const input = args ?? {}
          const next = { ...(await loadLocalSettings()) }
          for (const key of [
            'url', 'username', 'remoteDir', 'intervalMinutes', 'keepVersions',
            'includeCredentials', 'includeSkills', 'pullOnStart', 'pathMap',
            'syncProviders', 'rewriteBaseURL',
          ]) {
            if (input[key] !== undefined) next[key] = input[key]
          }
          const saved = []
          if (input.password !== undefined) {
            const settings = resolveSettings(config, next)
            if (!credentials) throw new Error('Credential service is unavailable.')
            await credentials.set(settings.passwordRef, input.password)
            saved.push('password')
          }
          if (input.passphrase !== undefined) {
            const settings = resolveSettings(config, next)
            if (!credentials) throw new Error('Credential service is unavailable.')
            await credentials.set(settings.passphraseRef, input.passphrase)
            saved.push('passphrase')
          }
          await writeJsonAtomic(localSettingsPath(), next)
          reload()
          const settings = await settingsNow()
          return {
            summary: [
              'Saved dsh-mini-sync settings.',
              `Target    : ${settings.url || '(not configured)'}`,
              `Interval  : ${settings.intervalMinutes > 0 ? `every ${settings.intervalMinutes} min` : 'off'}`,
              `Retention : ${settings.keepVersions > 0 ? `keep last ${settings.keepVersions}` : 'single file'}`,
              saved.length ? `Secrets   : ${saved.join(', ')} stored` : 'Secrets   : unchanged',
              `Settings file: ${localSettingsPath()}`,
            ].join('\n'),
          }
        },
      }),
    )

    ctx.effect(() =>
      tools.register({
        name: 'mini_sync_push',
        description:
          'Upload this machine\'s DSH configuration (providers, API keys, base URLs, plugin list, settings, skills) to the configured WebDAV as one encrypted file. Conversations are never included.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: { schema: outSchema, render: (_a, v) => text(v.summary) },
        execute: async () => {
          const settings = await settingsNow()
          const result = await doPush(ctx, settings)
          return { summary: summarizePush(result), ...result }
        },
      }),
    )

    ctx.effect(() =>
      tools.register({
        name: 'mini_sync_pull',
        description:
          'Download the DSH configuration from WebDAV. Without apply it only reports what would change; with apply it writes the files (keeping a .dsh-mini-sync.bak of each replaced file). Files changed locally since the last sync are reported as conflicts unless force is set.',
        parameters: {
          type: 'object',
          properties: {
            apply: { type: 'boolean', description: 'Write the remote files to this machine. Default false (dry run).' },
            force: { type: 'boolean', description: 'Overwrite files that changed locally since the last sync.' },
          },
          additionalProperties: false,
        },
        output: { schema: outSchema, render: (_a, v) => text(v.summary) },
        execute: async (args) => {
          const settings = await settingsNow()
          const result = await doPull(ctx, settings, {
            apply: Boolean(args?.apply),
            force: Boolean(args?.force),
          })
          return { summary: summarizePull(result), ...result }
        },
      }),
    )
  }

  // ---- /sync command ----------------------------------------------------
  const commands = ctx.get('commands')
  if (commands) {
    ctx.effect(() =>
      commands.register({
        name: 'sync',
        description: 'dsh-mini-sync: push this machine\'s config, or pull the remote one (`/sync push|pull|status`).',
        input: { hint: 'push | pull [apply] | status' },
        handler: async (invocation) => {
          const words = String(invocation.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
          const action = words[0] || 'status'
          try {
            const settings = await settingsNow()
            if (action === 'push') {
              return { kind: 'success', text: summarizePush(await doPush(ctx, settings)) }
            }
            if (action === 'pull') {
              const apply = words.includes('apply')
              return { kind: 'success', text: summarizePull(await doPull(ctx, settings, { apply })) }
            }
            if (action === 'status') {
              const state = await loadState()
              return {
                kind: 'success',
                text: [
                  `Target    : ${settings.url || '(not configured)'}`,
                  `Interval  : ${settings.intervalMinutes > 0 ? `${settings.intervalMinutes} min` : 'off'}`,
                  `Retention : ${settings.keepVersions > 0 ? `keep ${settings.keepVersions}` : 'single file'}`,
                  `Last push : ${state.lastPushAt ?? 'never'}`,
                  `Last pull : ${state.lastPullAt ?? 'never'}`,
                ].join('\n'),
              }
            }
            return { kind: 'error', text: `Unknown action "${action}". Use: push | pull [apply] | status` }
          } catch (error) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
          }
        },
      }),
    )
  }

  // ---- background timer + optional startup pull -------------------------
  ctx.effect(() => {
    let timer
    let disposed = false
    const tick = async () => {
      try {
        const settings = await settingsNow()
        if (disposed || !settings.url || settings.intervalMinutes <= 0) return
        await doPush(ctx, settings)
        ctx.logger?.info?.('dsh-mini-sync: auto push complete')
      } catch (error) {
        ctx.logger?.warn?.(`dsh-mini-sync: auto push failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const arm = async () => {
      const settings = await settingsNow()
      if (disposed || settings.intervalMinutes <= 0) return
      timer = setInterval(tick, settings.intervalMinutes * 60_000)
      timer.unref?.()
    }
    void arm()
    return () => {
      disposed = true
      if (timer) clearInterval(timer)
    }
  })

  ctx.effect(() => {
    let cancelled = false
    const boot = async () => {
      try {
        const settings = await settingsNow()
        if (cancelled || !settings.pullOnStart || !settings.url) return
        const result = await doPull(ctx, settings, { apply: true })
        ctx.logger?.info?.(`dsh-mini-sync: startup pull applied ${result.written?.length ?? 0} file(s)`)
      } catch (error) {
        ctx.logger?.warn?.(`dsh-mini-sync: startup pull failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    void boot()
    return () => {
      cancelled = true
    }
  })
}