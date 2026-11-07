// Guards the Client half against the failure that must never recur: a factory body
// that throws during module evaluation takes the whole web boot down with it
// ("1 entry did not activate"). The real module table only resolves known seeds,
// so this harness resolves exactly what a plain-JS plugin is allowed to require.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(here, '..', 'client.js')
const source = await fs.readFile(CLIENT, 'utf8')

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

// ---- minimal React (only what the component actually calls) ----------------
// `stateQueue` lets the test render the loaded branch by feeding the hook values
// in call order, without a real reconciler.
let stateQueue = []
function makeReact() {
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      if (stateQueue.length) return [stateQueue.shift(), () => {}]
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    useCallback(fn) {
      return fn
    },
    Fragment: 'Fragment',
  }
  return React
}

// ---- capture the module definition ----------------------------------------
const loaded = []
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded.push(definition)
    },
  },
}

const requiredNames = []
const moduleTable = {
  react: makeReact(),
}

const requireStub = (name) => {
  requiredNames.push(name)
  if (!(name in moduleTable)) {
    // Mirrors the real error shape so a regression fails this test loudly.
    throw new Error(
      `require("${name}") missed the module table — not a platform seed word, not a materialized module, and no registered package factory`,
    )
  }
  return moduleTable[name]
}

// ---- run it -----------------------------------------------------------------
await import(pathToFileURL(CLIENT).href)

check('registers exactly one module definition', loaded.length === 1, `${loaded.length}`)
const definition = loaded[0]
check('module id matches the package name', definition?.id === 'dsh-mini-sync', definition?.id)

let plugin
let factoryError
try {
  plugin = definition.factory(requireStub)
} catch (error) {
  factoryError = error
}
check('factory body does not throw at boot', !factoryError, factoryError ? factoryError.message : '')
check('only require("react") is used', requiredNames.every((n) => n === 'react'), `required: ${requiredNames.join(', ') || '(none)'}`)

check('exports apply()', typeof plugin?.apply === 'function')
check('injects slots', Array.isArray(plugin?.inject) && plugin.inject.includes('slots'))

// ---- apply against a fake client context ------------------------------------
const registrations = []
const slots = {
  inject(key, callback) {
    registrations.push({ kind: 'inject', key })
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  register(options, component) {
    registrations.push({ kind: 'register', options, component })
    return () => {}
  },
}

const ctx = {
  get: (name) => (name === 'slots' ? slots : undefined),
  effect(fn) {
    const d = fn()
    return typeof d === 'function' ? d : () => {}
  },
  on: () => () => {},
}

let applyError
try {
  plugin.apply(ctx)
} catch (error) {
  applyError = error
}
check('apply() does not throw', !applyError, applyError ? applyError.message : '')

const registered = registrations.find((r) => r.kind === 'register')
check('registers into settings.section', registered?.options?.name === 'settings.section', registered?.options?.name)
check('uses its own section id', registered?.options?.id === 'dsh-mini-sync')
check('has a localized label', registered?.options?.label === '轻量同步', registered?.options?.label)
check('has an order', typeof registered?.options?.order === 'number')

// ---- the component must be renderable without a DOM -------------------------
const Component = registered?.component
check('component is a function', typeof Component === 'function')

let renderError
let tree
try {
  tree = Component({})
} catch (error) {
  renderError = error
}
check('renders in its loading state without throwing', !renderError, renderError ? renderError.message : '')
check('loading state is a React element', Boolean(tree && tree.type))

// ---- the loaded branch (state non-null) must render too ---------------------
const loadedState = {
  url: 'https://dav.example.com/me',
  username: 'me',
  remoteDir: 'dsh-mini-sync',
  folderUrl: 'https://dav.example.com/me/dsh-mini-sync',
  fileUrl: 'https://dav.example.com/me/dsh-mini-sync/config.json',
  intervalMinutes: 15,
  keepVersions: 0,
  includeCredentials: true,
  includeSkills: true,
  pullOnStart: false,
  encrypt: true,
  encryptEffective: true,
  installPlugins: false,
  canInstallPlugins: true,
  plugins: [
    { name: 'dsh-mini-sync', version: '0.2.0', spec: 'github:ToddModica/dsh-mini-sync', localOnly: false },
    { name: 'demo-private', version: '1.0.0', localOnly: true },
  ],
  syncProviders: [],
  rewriteBaseURL: [],
  passwordSet: true,
  passphraseSet: true,
  lastPushAt: null,
  lastPullAt: null,
  files: ['profile/package.json'],
  skipped: [],
  providers: [{ id: 'test', baseURL: 'http://127.0.0.1:10100/v1', loopback: true, models: ['m1'] }],
}
const loadedDraft = {
  url: loadedState.url,
  username: 'me',
  remoteDir: 'dsh-mini-sync',
  intervalMinutes: 15,
  keepVersions: 0,
  includeCredentials: true,
  includeSkills: true,
  pullOnStart: false,
  encrypt: true,
  installPlugins: true,
  syncProviders: [],
  rewriteBaseURL: [],
  password: '',
  passphrase: '',
}
stateQueue = [loadedState, loadedDraft, null, null, null]
let loadedTree
let loadedError
try {
  loadedTree = Component({})
} catch (error) {
  loadedError = error
}
stateQueue = []
check('renders the loaded settings page without throwing', !loadedError, loadedError ? loadedError.message : '')
const loadedText = JSON.stringify(loadedTree ?? {})
check('loaded page shows the optional passphrase control', loadedText.includes('加密上传') && loadedText.includes('可选。填写后'))
check('loaded page shows the plugin inventory', loadedText.includes('本机插件') && loadedText.includes('demo-private'))
check('loaded page offers plugin install on pull', loadedText.includes('拉取时安装缺失插件'))
check('apply button reflects the plugin install setting', loadedText.includes('拉取、应用并装插件'))
check('apply sends the live plugin install choice', source.includes('installPlugins: Boolean(draft.installPlugins)'))
check('loaded page flags loopback providers', loadedText.includes('本机地址'))

// The stylesheet must ship as a component-local <style> element, not a global
// install — that is what keeps unload clean and avoids the removed styles API.
const collect = (node, out) => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node.children)) node.children.forEach((child) => collect(child, out))
  if (node.type === 'style') out.push(node)
  return out
}
const styleNodes = tree ? collect(tree, []) : []
check('ships styles as a component-local <style> element', styleNodes.length === 1, `${styleNodes.length} found`)
const stylesheet = String(styleNodes[0]?.children?.[0] ?? '')
check('stylesheet references theme tokens', stylesheet.includes('--dsw-alias-'))

// Regression: these aliases do not exist in Harness. Using them made every colour
// fall through to a light-theme literal, so dark mode rendered dark-on-dark inputs.
for (const token of [
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-settings-card-fill',
  '--dsw-alias-bg-base',
  '--dsw-alias-border-l2',
  '--dsw-alias-state-business-primary',
]) {
  check(`stylesheet uses the real token ${token}`, stylesheet.includes(token))
}
for (const stale of [
  '--dsw-alias-text-primary',
  '--dsw-alias-text-secondary',
  '--dsw-alias-text-tertiary',
  '--dsw-alias-bg-elevated',
  '--dsw-alias-border-subtle',
  '--dsw-alias-accent-primary',
  '--dsw-alias-bg-muted',
]) {
  check(`stylesheet dropped the nonexistent token ${stale}`, !stylesheet.includes(stale))
}

// The encryption passphrase is optional, and plugins can be restored on pull.
check('offers an explicit encryption toggle', source.includes("label: '加密上传'"))
check('passphrase field says it is optional', source.includes('留空则不加密'))
check('offers plugin install on pull', source.includes('拉取时安装缺失插件'))
check('shows the local plugin inventory', source.includes('本机插件'))

// ---- the shipped file must not reach for absent globals ---------------------
check('does not touch document.body', !source.includes('document.body'))
check('does not require a Harness Client package', !source.includes("@deepseek-ai/dsh-client-ui-primitives"))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exitCode = 1