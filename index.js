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
  installPlugins: false,
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

function isLocalDependencySpec(spec) {
  return typeof spec === 'string' && (spec.startsWith('link:') || spec.startsWith('file:'))
}

/** Absolute folder a `link:`/`file:` dependency points at, if it is a folder. */
function localDependencyPath(spec, profileDir) {
  if (!isLocalDependencySpec(spec)) return undefined
  const raw = spec.slice(spec.indexOf(':') + 1).trim()
  if (!raw) return undefined
  return path.resolve(profileDir, raw)
}

/** Turn a package `repository` field into a `github:owner/repo` install spec. */
function githubSpecFromRepository(repository) {
  let raw = typeof repository === 'string' ? repository : repository?.url
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  raw = raw.trim()
  if (/^github:[^/]+\/[^/]+$/.test(raw)) return raw
  raw = raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@github\.com:/, 'https://github.com/')
  const match = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?(?:[#?].*)?$/i.exec(raw)
  if (!match) return undefined
  return `github:${match[1]}/${match[2]}`
}

/** The install spec a registry/git dependency should use on another machine. */
function portableDependencySpec(name, spec, installedVersion) {
  if (typeof spec !== 'string' || !spec) return installedVersion ? `${name}@${installedVersion}` : name
  if (/^(https?:|git\+|git:|github:|gitlab:|bitbucket:|npm:)/i.test(spec)) return spec
  if (isLocalDependencySpec(spec)) return undefined
  const version = installedVersion ?? spec
  return `${name}@${version}`
}

async function packageJsonAt(dir) {
  const value = await readJsonIfExists(path.join(dir, 'package.json'))
  return value && typeof value === 'object' ? value : undefined
}

/** Order-insensitive JSON comparison, for "did the merged result really change?". */
function jsonEquivalent(leftText, rightText) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    }
    return value
  }
  try {
    return JSON.stringify(canonical(JSON.parse(leftText)))
      === JSON.stringify(canonical(JSON.parse(rightText)))
  } catch {
    return false
  }
}

function pluginManagerOf(ctx) {
  try {
    return ctx?.get?.('pluginManager')
  } catch {
    return undefined
  }
}

/**
 * A portable inventory of the third-party plugins this profile uses.
 *
 * The profile `package.json` holds the truth, but its `link:`/`file:` entries are
 * absolute paths that mean nothing on another machine. For those, a GitHub
 * `repository` field becomes a `github:owner/repo` install spec; anything without
 * one is marked `localOnly` and reported instead of silently pretending it can be
 * restored. Registry entries carry the exact installed version.
 */
async function collectPluginEntries(ctx) {
  const profileDir = path.join(dshHome(), 'profiles', profileName())
  const pkg = (await packageJsonAt(profileDir)) ?? {}
  const deps = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
  const bundles = new Set(Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [])

  const listed = new Map()
  const manager = pluginManagerOf(ctx)
  if (typeof manager?.listBundles === 'function') {
    try {
      for (const entry of await manager.listBundles()) {
        if (!entry?.name || entry.official || entry.installed === false) continue
        if (entry.availability === 'installation') continue
        listed.set(entry.name, entry)
      }
    } catch {
      // Fall back to package.json alone; the page still works.
    }
  }

  const names = new Set([...Object.keys(deps), ...listed.keys()])
  const entries = []
  for (const name of names) {
    const depSpec = deps[name]
    const listedEntry = listed.get(name)
    const localDir = localDependencyPath(depSpec, profileDir)
    const localManifest = localDir ? await packageJsonAt(localDir) : undefined
    const installedManifest = await packageJsonAt(path.join(profileDir, 'node_modules', ...name.split('/')))
    const manifest = localManifest ?? installedManifest

    // A profile's dependencies also carry infrastructure (@deepseek-ai/cordis,
    // credentials, home-paths). Only packages that declare a DSH bundle/client —
    // or that the profile selects as a bundle — are plugins worth restoring.
    const declaresPlugin = Boolean(manifest?.dsh?.bundle || manifest?.dsh?.client)
    if (!listedEntry && !declaresPlugin && !bundles.has(name)) continue

    let spec
    let localOnly = false
    if (localDir) {
      spec = githubSpecFromRepository(manifest?.repository ?? manifest?.homepage)
      localOnly = !spec
    } else if (isLocalDependencySpec(depSpec)) {
      localOnly = true
    } else if (listedEntry?.source && isAbsoluteAnywhere(listedEntry.source)) {
      localOnly = true
    } else if (listedEntry?.source) {
      spec = listedEntry.source
    } else {
      spec = portableDependencySpec(name, depSpec, installedManifest?.version ?? listedEntry?.version)
    }
    if (!spec) localOnly = true

    entries.push({
      name,
      version: typeof manifest?.version === 'string' ? manifest.version : listedEntry?.version,
      spec,
      enabled: bundles.has(name) || listedEntry?.enabled === true,
      localOnly,
    })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return entries
}

/** Compare the remote plugin inventory with this profile, read-only. */
async function planRemotePlugins(ctx, remotePlugins) {
  const profileDir = path.join(dshHome(), 'profiles', profileName())
  const pkg = (await packageJsonAt(profileDir)) ?? {}
  const deps = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
  const manager = pluginManagerOf(ctx)
  const installed = new Set(Object.keys(deps))
  if (typeof manager?.listBundles === 'function') {
    try {
      for (const entry of await manager.listBundles()) {
        if (entry?.installed) installed.add(entry.name)
      }
    } catch {
      // package.json alone still gives a useful answer.
    }
  }
  const present = []
  const missing = []
  const localOnly = []
  for (const entry of Array.isArray(remotePlugins) ? remotePlugins : []) {
    if (!entry?.name) continue
    if (installed.has(entry.name)) {
      present.push(entry)
      continue
    }
    if (entry.localOnly || !entry.spec) localOnly.push(entry)
    else missing.push(entry)
  }
  return {
    declared: present.length + missing.length + localOnly.length,
    present,
    missing,
    localOnly,
    canInstall: Boolean(manager?.installBundle),
  }
}

async function installMissingPlugins(ctx, missing) {
  const manager = pluginManagerOf(ctx)
  if (typeof manager?.installBundle !== 'function') {
    return { supported: false, installed: [], failed: [] }
  }
  const installed = []
  const failed = []
  for (const entry of missing) {
    try {
      const result = await manager.installBundle(entry.spec, { enabled: entry.enabled !== false })
      const refusal = result?.error && result.error.code !== 'already-installed'
        ? (result.error.diagnostic ?? result.error.code)
        : result?.application === 'failed' || result?.application === 'cancelled'
          ? `installation ${result.application}`
          : undefined
      if (refusal) {
        failed.push({ name: entry.name, spec: entry.spec, error: refusal })
        continue
      }
      installed.push({
        name: entry.name,
        spec: entry.spec,
        application: result?.application ?? null,
        alreadyInstalled: result?.error?.code === 'already-installed',
      })
    } catch (error) {
      failed.push({
        name: entry.name,
        spec: entry.spec,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { supported: true, installed, failed }
}

/**
 * On a pull, a local `link:` plugin cannot be represented remotely. Keep the
 * machine's own link dependencies (and their bundle selections) instead of
 * deleting them when the remote package.json is written.
 */
function mergeLocalPluginDeps(localText, remoteText) {
  let local
  let remote
  try {
    local = JSON.parse(localText)
    remote = JSON.parse(remoteText)
  } catch {
    return { text: remoteText, kept: [], keptLinks: [] }
  }
  if (!local || !remote || typeof remote !== 'object') return { text: remoteText, kept: [], keptLinks: [] }
  const localDeps = local?.dependencies && typeof local.dependencies === 'object' ? local.dependencies : {}
  const localBundles = new Set(Array.isArray(local?.dsh?.profile?.bundles) ? local.dsh.profile.bundles : [])
  const deps = remote.dependencies && typeof remote.dependencies === 'object' ? remote.dependencies : {}
  const profileDir = path.join(dshHome(), 'profiles', profileName())
  const kept = []
  for (const [name, spec] of Object.entries(localDeps)) {
    if (!isLocalDependencySpec(spec) || deps[name] !== undefined) continue
    // A stale link is not worth preserving; only keep one that still resolves.
    const target = path.resolve(profileDir, spec.slice(spec.indexOf(':') + 1))
    if (!existsSync(target)) continue
    deps[name] = spec
    kept.push(name)
  }

  const keptLinks = []
  const localLinks = Array.isArray(local?.dsh?.profile?.links) ? local.dsh.profile.links : []
  if (localLinks.length) {
    const links = Array.isArray(remote?.dsh?.profile?.links) ? remote.dsh.profile.links : []
    for (const entry of localLinks) {
      if (typeof entry !== 'string' || !isAbsoluteAnywhere(entry)) continue
      if (!existsSync(entry) || links.includes(entry)) continue
      links.push(entry)
      keptLinks.push(entry)
    }
    if (links.length) remote.dsh = { ...(remote.dsh ?? {}), profile: { ...(remote.dsh?.profile ?? {}), links } }
  }

  if (!kept.length && !keptLinks.length) return { text: remoteText, kept, keptLinks }
  if (kept.length) {
    remote.dependencies = deps
    const bundles = Array.isArray(remote?.dsh?.profile?.bundles) ? remote.dsh.profile.bundles : undefined
    if (bundles) {
      for (const name of kept) {
        if (localBundles.has(name) && !bundles.includes(name)) bundles.push(name)
      }
    }
  }
  return { text: `${JSON.stringify(remote, null, 2)}\n`, kept, keptLinks }
}

/**
 * A profile's package.json may carry `link:`/`file:` dependencies pointing at an
 * absolute path that only exists on the machine that wrote it. Drop those from the
 * uploaded copy — the portable plugin inventory carries a repository-based spec
 * for the ones that have one. Nothing is changed on disk.
 */
function sanitizePackageJson(text) {
  let pkg
  try {
    pkg = JSON.parse(text)
  } catch {
    return { text, dropped: [] }
  }

  const dropped = []
  const deps = pkg?.dependencies
  if (deps && typeof deps === 'object') {
    for (const [dep, spec] of Object.entries(deps)) {
      if (!isLocalDependencySpec(spec)) continue
      const local = spec.slice(spec.indexOf(':') + 1)
      if (isAbsoluteAnywhere(local)) {
        delete deps[dep]
        dropped.push(`${dep} (${spec})`)
      }
    }
  }
  const links = Array.isArray(pkg?.dsh?.profile?.links) ? pkg.dsh.profile.links : undefined
  if (links) {
    pkg.dsh.profile.links = links.filter((entry) => {
      if (typeof entry === 'string' && isAbsoluteAnywhere(entry)) {
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

/**
 * The folder a pasted URL points at, normalised.
 * A trailing slash, a pasted file URL, or a URL that already ends with the sync
 * folder all resolve to the same base, so the user never has to think about it.
 */
function normalizeBaseUrl(url) {
  let value = String(url ?? '').trim()
  if (!value) return ''
  value = value.replace(/\/+$/, '')
  // A URL copied from the file's own address becomes its folder.
  if (/\/config\.json$/i.test(value)) value = value.replace(/\/[^/]+$/, '')
  return value
}

/** Full remote folder for this sync, e.g. https://dav.example.com/dsh/dsh-mini-sync */
function remoteBase(settings) {
  const base = normalizeBaseUrl(settings.url)
  const dir = String(settings.remoteDir ?? '').replace(/^\/+|\/+$/g, '')
  if (!base) return ''
  if (!dir) return base
  // Pasting the folder URL directly must not double it.
  if (base.toLowerCase().endsWith(`/${dir.toLowerCase()}`)) return base
  return joinUrl(base, dir)
}

/**
 * Create every missing level so a pasted URL is the only thing the user supplies.
 * Existing collections answer 405 on most servers — that is the "already there" signal.
 */
async function ensureCollection(settings, password) {
  const base = normalizeBaseUrl(settings.url)
  const target = remoteBase(settings)
  if (!base || !target) return
  const suffix = target.slice(base.length).split('/').filter(Boolean)
  let current = base
  for (const segment of suffix) {
    current = joinUrl(current, segment)
    const response = await fetch(current, {
      method: 'MKCOL',
      headers: authHeaders(settings, password),
    })
    if (response.ok || response.status === 405) continue
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `WebDAV refused to create "${current}" (HTTP ${response.status}). Check the username and password, and that this account may create folders there.`,
      )
    }
    if (response.status === 409) {
      throw new Error(
        `WebDAV could not create "${current}" (HTTP 409): the folder in the address you pasted does not exist. Open the URL in a browser first — it must be an existing folder.`,
      )
    }
    // Anything else is left to the upload, which reports the real failure.
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
  // A pasted address is normalised once here, so every later path is consistent.
  merged.url = normalizeBaseUrl(merged.url)
  merged.remoteDir = String(merged.remoteDir ?? '').trim().replace(/^\/+|\/+$/g, '') || DEFAULTS.remoteDir
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
  // The passphrase is optional by design: with none, the payload goes out as
  // plaintext and the user is told so. The passphrase is only required to read a
  // remote payload that is already encrypted.
  return { password, passphrase }
}

// ------------------------------------------------------------------- engine

function deviceLabel() {
  return hostname()
}

async function buildPayload(ctx, settings) {
  const { files, skipped } = await collectLocalFiles(settings)
  const notes = []
  const plugins = await collectPluginEntries(ctx)

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

  if (plugins.length) {
    const portable = plugins.filter((p) => !p.localOnly)
    notes.push(
      `Plugins in the payload: ${plugins.length} (${portable.length} with a portable install spec, ${plugins.length - portable.length} local-only).`,
    )
    const localOnly = plugins.filter((p) => p.localOnly).map((p) => p.name)
    if (localOnly.length) {
      notes.push(
        `Local-only plugin(s) cannot be restored from another machine automatically: ${localOnly.join(', ')}. Add a GitHub "repository" field to each package.json to make it portable.`,
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
    plugins,
  }
  return { body, files, plugins, skipped, notes }
}

async function doPush(ctx, settings) {
  requireConfigured(settings)
  const { password, passphrase } = await resolveSecrets(ctx, settings)
  const { body, files, plugins, skipped, notes } = await buildPayload(ctx, settings)
  const encrypted = Boolean(settings.encrypt && passphrase)
  if (!encrypted) {
    notes.push(
      settings.encrypt
        ? 'No encryption passphrase is set — uploading PLAINTEXT. Set one to encrypt API keys at rest on the WebDAV server.'
        : 'Encryption is off — uploading PLAINTEXT. Anyone who can read the remote file can read your API keys.',
    )
  } else if (settings.includeCredentials) {
    notes.push('API credentials are included and sealed with the encryption passphrase.')
  }
  const plaintext = JSON.stringify(body)
  const serialized = encrypted
    ? JSON.stringify(seal(plaintext, passphrase), null, 2)
    : JSON.stringify({ format: FORMAT, version: FORMAT_VERSION, encrypted: false, body }, null, 2)

  await ensureCollection(settings, password)
  const target = joinUrl(remoteBase(settings), PAYLOAD_FILE)
  await remotePut(target, settings, password, serialized)

  let pruned = 0
  if (settings.keepVersions > 0) {
    const historyUrl = joinUrl(remoteBase(settings), HISTORY_DIR)
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
    encrypted,
    keptVersions: settings.keepVersions,
    pruned,
    target,
    skipped,
    notes,
    names: Object.keys(files).sort(),
    plugins: {
      total: plugins.length,
      portable: plugins.filter((p) => !p.localOnly).length,
      localOnly: plugins.filter((p) => p.localOnly).map((p) => p.name),
    },
  }
}

async function fetchRemoteBody(settings, password, passphrase) {
  const target = joinUrl(remoteBase(settings), PAYLOAD_FILE)
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

async function doPull(ctx, settings, { apply = false, force = false, installPlugins } = {}) {
  requireConfigured(settings)
  const { password, passphrase } = await resolveSecrets(ctx, settings)
  await ensureCollection(settings, password)
  const remote = await fetchRemoteBody(settings, password, passphrase)
  if (remote.missing) {
    return { missing: true, target: remote.target }
  }

  const pluginPlan = await planRemotePlugins(ctx, remote.body.plugins)
  const state = await loadState()
  const changes = []
  for (const [rel, remoteText] of Object.entries(remote.body.files ?? {})) {
    const targetPath = resolveLocalTarget(rel)
    const localText = await readTextIfExists(targetPath)
    // package.json is uploaded without its machine-local links, so the raw file
    // legitimately differs on the machine that pushed. Compare what a pull would
    // actually write (remote + this machine's links) instead of hashing the bytes.
    if (rel === 'profile/package.json' && localText !== undefined) {
      const merged = mergeLocalPluginDeps(localText, remoteText)
      if (jsonEquivalent(merged.text, localText)) {
        changes.push({ rel, action: 'identical' })
        continue
      }
    }
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
      if (change.rel === 'profile/package.json' && current !== undefined) {
        const outcome = mergeLocalPluginDeps(current, change.text)
        payload = outcome.text
        if (outcome.kept.length) {
          merged.push(
            `kept ${outcome.kept.length} machine-local plugin link(s): ${outcome.kept.join(', ')}`,
          )
        }
        if (outcome.keptLinks?.length) {
          merged.push(`kept ${outcome.keptLinks.length} machine-local profile link(s)`)
        }
      }

      await writeTextAtomic(change.targetPath, payload)
      written.push(change.rel)
      state.files = { ...(state.files ?? {}), [change.rel]: sha256(payload) }
    }
    state.lastPullAt = new Date().toISOString()
    await saveState(state)

    let pluginInstall
    const shouldInstall = installPlugins ?? settings.installPlugins
    if (shouldInstall && pluginPlan.missing.length) {
      pluginInstall = await installMissingPlugins(ctx, pluginPlan.missing)
      // The plugin manager edits package.json while installing, so refresh the
      // baseline instead of reporting our own install as a local conflict next time.
      const pkgPath = resolveLocalTarget('profile/package.json')
      const text = await readTextIfExists(pkgPath)
      if (text !== undefined) {
        state.files = { ...(state.files ?? {}), 'profile/package.json': sha256(text) }
        await saveState(state)
      }
    }

    return {
      applied: true,
      written,
      merged,
      changes,
      plugins: { ...pluginPlan, install: pluginInstall },
      createdAt: remote.createdAt,
      device: remote.device,
      platform: remote.platform,
    }
  }

  return {
    applied: false,
    changes,
    plugins: pluginPlan,
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
    `Plugins: ${result.plugins?.total ?? 0} (${result.plugins?.portable ?? 0} portable${result.plugins?.localOnly?.length ? `, ${result.plugins.localOnly.length} local-only` : ''})`,
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
  if (result.plugins?.declared) {
    const { present, missing, localOnly, install } = result.plugins
    head.push(
      '',
      `Plugins: ${present?.length ?? 0} already here · ${missing?.length ?? 0} missing · ${localOnly?.length ?? 0} local-only`,
    )
    for (const entry of missing ?? []) {
      head.push(`  missing     ${entry.name}${entry.spec ? `  (${entry.spec})` : ''}`)
    }
    for (const entry of localOnly ?? []) {
      head.push(`  local-only  ${entry.name} — install it manually with dsh plugin add`)
    }
    if (install) {
      if (!install.supported) {
        head.push('  Plugin manager is unavailable, so nothing was installed — run dsh plugin add manually.')
      }
      for (const entry of install.installed ?? []) {
        head.push(`  installed   ${entry.name}${entry.application === 'restart-required' ? ' — restart DSH to activate' : ''}`)
      }
      for (const entry of install.failed ?? []) {
        head.push(`  failed      ${entry.name}: ${entry.error}`)
      }
    } else if (missing?.length) {
      head.push('  Turn on "拉取时安装缺失插件" (installPlugins) to install them during a pull.')
    }
  }
  if (result.applied && result.written.includes('profile/package.json') && !result.plugins?.install?.installed?.length) {
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

  /** State the settings page renders. Shared by the tool, /sync and the HTTP route. */
  const inspectState = async () => {
    const settings = await settingsNow()
    const state = await loadState()
    const credentials = ctx.get('credentials')
    const { files, skipped } = await collectLocalFiles(settings)
    const passwordSet = settings.username
      ? Boolean((await credentials?.resolve(settings.passwordRef))?.value)
      : true
    const passphraseSet = Boolean((await credentials?.resolve(settings.passphraseRef))?.value)
    const plugins = await collectPluginEntries(ctx)

    const providers = []
    const patch = await readTextIfExists(
      path.join(dshHome(), 'profiles', profileName(), 'cordis.patch.yml'),
    )
    if (patch) {
      try {
        const doc = yamlLoad(splitHeader(patch).body)
        for (const row of Array.isArray(doc) ? doc : []) {
          const map = providerMapOf(row)
          if (!map) continue
          for (const [id, provider] of Object.entries(map)) {
            providers.push({
              id,
              baseURL: typeof provider?.baseURL === 'string' ? provider.baseURL : '',
              loopback: isLoopbackUrl(provider?.baseURL),
              models: (provider?.models ?? []).map((m) => m?.id).filter(Boolean),
            })
          }
        }
      } catch {
        // A malformed patch is reported by push; the page still renders.
      }
    }

    return {
      url: settings.url,
      username: settings.username,
      remoteDir: settings.remoteDir,
      folderUrl: remoteBase(settings),
      fileUrl: remoteBase(settings) ? joinUrl(remoteBase(settings), PAYLOAD_FILE) : '',
      intervalMinutes: settings.intervalMinutes,
      keepVersions: settings.keepVersions,
      includeCredentials: Boolean(settings.includeCredentials),
      includeSkills: Boolean(settings.includeSkills),
      pullOnStart: Boolean(settings.pullOnStart),
      encrypt: Boolean(settings.encrypt),
      encryptEffective: Boolean(settings.encrypt && passphraseSet),
      installPlugins: Boolean(settings.installPlugins),
      canInstallPlugins: typeof pluginManagerOf(ctx)?.installBundle === 'function',
      plugins,
      syncProviders: settings.syncProviders ?? [],
      rewriteBaseURL: settings.rewriteBaseURL ?? [],
      passwordSet,
      passphraseSet,
      lastPushAt: state.lastPushAt ?? null,
      lastPullAt: state.lastPullAt ?? null,
      files: Object.keys(files).sort(),
      skipped,
      providers,
    }
  }

  /** Persist settings and the two secrets; shared by the tool and the HTTP route. */
  const saveSettings = async (input) => {
    const credentials = ctx.get('credentials')
    const next = { ...(await loadLocalSettings()) }
    for (const key of [
      'url', 'username', 'remoteDir', 'intervalMinutes', 'keepVersions',
      'includeCredentials', 'includeSkills', 'pullOnStart', 'encrypt',
      'installPlugins', 'pathMap', 'syncProviders', 'rewriteBaseURL',
    ]) {
      if (input?.[key] !== undefined) next[key] = input[key]
    }
    const resolved = resolveSettings(config, next)
    if (input?.password) await credentials?.set(resolved.passwordRef, input.password)
    if (input?.passphrase) await credentials?.set(resolved.passphraseRef, input.passphrase)
    await writeJsonAtomic(localSettingsPath(), next)
    reload()
    return { ok: true, settingsPath: localSettingsPath() }
  }

  // ---- request handler for the settings page ----------------------------
  // One pure function serves both carriers below, so the page's behaviour cannot
  // diverge between the browser build and the desktop renderer.
  const handleApi = async (body, headers) => {
    const origin = headers?.origin
    const host = headers?.host
    // Only this page may drive the sync; refuse cross-origin callers.
    if (origin && host && new URL(origin).host !== host) {
      return { status: 403, value: { ok: false, error: 'cross-origin request refused' } }
    }
    let input
    try {
      input = body ? JSON.parse(body) : {}
    } catch {
      return { status: 400, value: { ok: false, error: 'request body is not JSON' } }
    }
    const action = String(input.action ?? 'inspect')
    try {
      if (action === 'inspect') return { status: 200, value: { ok: true, value: await inspectState() } }
      if (action === 'save') {
        return { status: 200, value: { ok: true, value: await saveSettings(input.settings) } }
      }
      if (action === 'push') {
        const settings = await settingsNow()
        const result = await doPush(ctx, settings)
        return { status: 200, value: { ok: true, value: { ...result, summary: summarizePush(result) } } }
      }
      if (action === 'pull') {
        const settings = await settingsNow()
        const result = await doPull(ctx, settings, {
          apply: Boolean(input.apply),
          force: Boolean(input.force),
          installPlugins: input.installPlugins === undefined ? undefined : Boolean(input.installPlugins),
        })
        return { status: 200, value: { ok: true, value: { ...result, summary: summarizePull(result) } } }
      }
      return { status: 400, value: { ok: false, error: `unknown action "${action}"` } }
    } catch (error) {
      // A failed sync is an answer the page renders, not an HTTP error.
      return { status: 200, value: { ok: false, error: error instanceof Error ? error.message : String(error) } }
    }
  }

  // ---- carrier 1: a plain route on the web server ----------------------
  // Serves `dsh web` and anything reaching the host origin directly.
  ctx.inject(['webServer'], (wctx) => {
    const webServer = wctx.webServer
    const route = () => webServer.register({
      kind: 'exact',
      path: `/${FORMAT}/api`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'POST required' }))
          return
        }
        let body = ''
        for await (const chunk of req) body += chunk
        const { status, value } = await handleApi(body, req.headers)
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(value))
      },
    })
    wctx.effect(route)
  })

  // ---- carrier 2: the shared /api channel ------------------------------
  // The desktop renderer is served from a custom scheme, so a path relative to the
  // page is not the host. The app already reaches its Host through the shared
  // /api channel, so the same handler is mounted there too.
  ctx.inject(['connection'], (ccon) => {
    const connection = ccon.connection
    ccon.effect(() => connection.fetch.register({
      path: `/${FORMAT}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await request.text()
        const { status, value } = await handleApi(body, {
          origin: request.headers.get('origin') ?? undefined,
          host: request.headers.get('host') ?? undefined,
        })
        return new Response(JSON.stringify(value), {
          status,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        })
      },
    }))
  })

  // ---- tools ------------------------------------------------------------
  ctx.inject(['tools'], (tctx) => {
    const tools = tctx.tools
    tctx.effect(() =>
      tools.register({
        name: 'mini_sync_status',
        description:
          'Show dsh-mini-sync state: WebDAV target, sync interval, retention policy, which files would travel, and when the last push/pull happened.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: { schema: outSchema, render: (_a, v) => text(v.summary) },
        execute: async () => {
          const s = await inspectState()
          const lines = [
            `Target      : ${s.url || '(not configured)'}`,
            `Folder      : ${s.folderUrl || '(not configured)'}`,
            `User        : ${s.username || '(anonymous)'}  password ${s.passwordSet ? 'set' : 'MISSING'}`,
            `Encryption  : ${s.encryptEffective
              ? 'on (passphrase set)'
              : s.encrypt ? 'off — no passphrase, payload is PLAINTEXT' : 'off — payload is PLAINTEXT'}`,
            `Plugins     : ${s.plugins.length} (${s.plugins.filter((p) => !p.localOnly).length} portable${s.plugins.some((p) => p.localOnly) ? `, ${s.plugins.filter((p) => p.localOnly).length} local-only` : ''})`,
            `Install     : ${s.installPlugins ? 'install missing plugins on pull' : 'report only'}${s.canInstallPlugins ? '' : ' (plugin manager unavailable)'}`,
            `Interval    : ${s.intervalMinutes > 0 ? `every ${s.intervalMinutes} min` : 'off (manual only)'}`,
            `Retention   : ${s.keepVersions > 0 ? `keep last ${s.keepVersions} version(s)` : 'single file, overwritten in place'}`,
            `Last push   : ${s.lastPushAt ?? 'never'}`,
            `Last pull   : ${s.lastPullAt ?? 'never'}`,
            '',
            `Would sync ${s.files.length} file(s):`,
            ...s.files.map((n) => `  - ${n}`),
          ]
          if (s.plugins.length) {
            lines.push('', 'Plugins:')
            for (const plugin of s.plugins) {
              lines.push(`  - ${plugin.name}${plugin.version ? ` ${plugin.version}` : ''}${plugin.spec ? `  (${plugin.spec})` : '  (local-only)'}`)
            }
          }
          if (s.skipped.length) lines.push('', `Skipped: ${s.skipped.join(', ')}`)
          return { summary: lines.join('\n') }
        },
      }),
    )

    tctx.effect(() =>
      tools.register({
        name: 'mini_sync_setup',
        description:
          'Configure dsh-mini-sync: WebDAV url, username, password, optional encryption passphrase, sync interval in minutes, remote retention, and whether to install missing plugins on pull. Secrets are stored in the DSH credential store, never in config files.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'WebDAV base URL, e.g. https://dav.example.com/dsh.' },
            username: { type: 'string', description: 'WebDAV username; omit for anonymous.' },
            password: { type: 'string', description: 'WebDAV password; stored as a credential.' },
            passphrase: { type: 'string', description: 'Optional encryption passphrase; stored as a credential. Leave unset to upload plaintext.' },
            remoteDir: { type: 'string', description: 'Folder under the URL that holds the sync file.' },
            intervalMinutes: { type: 'number', description: 'Auto-push interval in minutes; 0 disables it.' },
            keepVersions: { type: 'number', description: 'Remote versions to keep; 0 keeps a single file only.' },
            includeCredentials: { type: 'boolean', description: 'Include .credentials.yaml in the payload.' },
            includeSkills: { type: 'boolean', description: 'Include the skills directory in the payload.' },
            pullOnStart: { type: 'boolean', description: 'Pull and apply the remote config when this plugin loads.' },
            encrypt: { type: 'boolean', description: 'Encrypt the remote payload with the passphrase. Off = plaintext; on without a passphrase also falls back to plaintext.' },
            installPlugins: { type: 'boolean', description: 'When pulling with apply, install third-party plugins from the remote inventory that this machine lacks. Requires the host plugin manager and network access.' },
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
          const input = args ?? {}
          await saveSettings(input)
          const settings = await settingsNow()
          const saved = []
          if (input.password !== undefined) saved.push('password')
          if (input.passphrase !== undefined) saved.push('passphrase')
          const passphraseSet = Boolean((await ctx.get('credentials')?.resolve(settings.passphraseRef))?.value)
          return {
            summary: [
              'Saved dsh-mini-sync settings.',
              `Target    : ${settings.url || '(not configured)'}`,
              `Interval  : ${settings.intervalMinutes > 0 ? `every ${settings.intervalMinutes} min` : 'off'}`,
              `Retention : ${settings.keepVersions > 0 ? `keep last ${settings.keepVersions}` : 'single file'}`,
              `Encryption: ${settings.encrypt && passphraseSet ? 'on' : 'off (plaintext)'}`,
              `Plugins   : ${settings.installPlugins ? 'install missing on pull' : 'report missing on pull'}`,
              saved.length ? `Secrets   : ${saved.join(', ')} stored` : 'Secrets   : unchanged',
              `Settings file: ${localSettingsPath()}`,
            ].join('\n'),
          }
        },
      }),
    )

    tctx.effect(() =>
      tools.register({
        name: 'mini_sync_push',
        description:
          'Upload this machine\'s DSH configuration (providers, API keys, base URLs, plugin inventory, settings, skills) to the configured WebDAV as one file — encrypted when a passphrase is set, plaintext otherwise. Conversations are never included.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: { schema: outSchema, render: (_a, v) => text(v.summary) },
        execute: async () => {
          const settings = await settingsNow()
          const result = await doPush(ctx, settings)
          return { summary: summarizePush(result), ...result }
        },
      }),
    )

    tctx.effect(() =>
      tools.register({
        name: 'mini_sync_pull',
        description:
          'Download the DSH configuration from WebDAV. Without apply it only reports what would change; with apply it writes the files (keeping a .dsh-mini-sync.bak of each replaced file) and reports missing plugins. Files changed locally since the last sync are reported as conflicts unless force is set.',
        parameters: {
          type: 'object',
          properties: {
            apply: { type: 'boolean', description: 'Write the remote files to this machine. Default false (dry run).' },
            force: { type: 'boolean', description: 'Overwrite files that changed locally since the last sync.' },
            installPlugins: { type: 'boolean', description: 'Install plugins from the remote inventory that this machine lacks (overrides the saved setting). Requires the host plugin manager and network access.' },
          },
          additionalProperties: false,
        },
        output: { schema: outSchema, render: (_a, v) => text(v.summary) },
        execute: async (args) => {
          const settings = await settingsNow()
          const result = await doPull(ctx, settings, {
            apply: Boolean(args?.apply),
            force: Boolean(args?.force),
            installPlugins: args?.installPlugins === undefined ? undefined : Boolean(args.installPlugins),
          })
          return { summary: summarizePull(result), ...result }
        },
      }),
    )
  })

  // ---- /sync command ----------------------------------------------------
  ctx.inject(['commands'], (cctx) => {
    const commands = cctx.commands
    cctx.effect(() =>
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
              const passphraseSet = Boolean((await ctx.get('credentials')?.resolve(settings.passphraseRef))?.value)
              return {
                kind: 'success',
                text: [
                  `Target    : ${settings.url || '(not configured)'}`,
                  `Encryption: ${settings.encrypt && passphraseSet ? 'on' : 'off (plaintext)'}`,
                  `Plugins   : ${settings.installPlugins ? 'install missing on pull' : 'report missing on pull'}`,
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
  })

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
