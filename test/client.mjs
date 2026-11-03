// Guards the Client half against the failure that must never recur: a factory body
// that throws during module evaluation takes the whole web boot down with it
// ("1 entry did not activate"). The real module table only resolves known seeds,
// so this harness resolves exactly what a plain-JS plugin is allowed to require.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(here, '..', 'client.js')

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

// ---- minimal React (only what the component actually calls) ----------------
function makeReact() {
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
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
check('stylesheet references theme tokens', String(styleNodes[0]?.children?.[0] ?? '').includes('--dsw-alias-'))

// ---- the shipped file must not reach for absent globals ---------------------
const source = await fs.readFile(CLIENT, 'utf8')
check('does not touch document.body', !source.includes('document.body'))
check('does not require a Harness Client package', !source.includes("@deepseek-ai/dsh-client-ui-primitives"))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exitCode = 1