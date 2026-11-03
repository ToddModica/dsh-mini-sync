// DSH 的启动保护在"禁用第三方插件并重启"时会把 profile 的 patch 层整体收起，
// 只留下最小行集。这个脚本把备份里的完整行集恢复回来，同时保留下后写入的
// 较新偏好值（同名行以当前文件为准）。
//
//   node test/restore-patch.mjs [profile]
import { readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import { load, dump } from 'js-yaml'

const profile = process.argv[2] || process.env.DSH_PROFILE || 'desktop'
const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE ?? process.env.HOME, '.dsh')
const prof = path.join(home, 'profiles', profile)
const target = path.join(prof, 'cordis.patch.yml')

const backups = readdirSync(prof)
  .filter((n) => n.startsWith('cordis.patch.yml.bak-'))
  .sort()
if (backups.length === 0) throw new Error('no cordis.patch.yml backup found')
const bakPath = path.join(prof, backups[backups.length - 1])
console.log('backup:', backups[backups.length - 1])

const current = load(readFileSync(target, 'utf8')) ?? []
const backup = load(readFileSync(bakPath, 'utf8')) ?? []

copyFileSync(target, `${target}.before-restore`)
console.log('saved current copy:', 'cordis.patch.yml.before-restore')

const byId = new Map(current.map((row) => [row.id, row]))
// The backup holds the complete row set and its order; where both define a row,
// the newer value recorded since the incident wins.
const merged = backup.map((row) => {
  const now = byId.get(row.id)
  if (!now) return row
  return { ...row, config: { ...(row.config ?? {}), ...(now.config ?? {}) } }
})
const backupIds = new Set(backup.map((row) => row.id))
for (const row of current) if (!backupIds.has(row.id)) merged.push(row)

const header = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '',
].join('\n')

writeFileSync(target, header + dump(merged, { lineWidth: 120, noRefs: true, quotingType: '"' }), 'utf8')

const check = load(readFileSync(target, 'utf8'))
const providerRow = check.find((row) => row?.config?.providers)
const providerIds = Object.keys(providerRow?.config?.providers ?? {})
const modelCount = providerRow?.config?.providers?.[providerIds[0]]?.models?.length
const def = check.find((row) => row.id === 'agent-default-model')

console.log('rows           :', check.length)
console.log('provider row   :', providerRow?.id)
console.log('providers      :', providerIds.join(', '))
console.log('models         :', modelCount)
console.log('default model  :', `${def?.config?.provider}/${def?.config?.model}`)
console.log('web row        :', Boolean(check.find((row) => row.id === 'web')))