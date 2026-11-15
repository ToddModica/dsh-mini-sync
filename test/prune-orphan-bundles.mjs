// Remove bundle selections that can never resolve on this machine: the name sits in
// dsh.profile.bundles but package.json has no dependency entry for it, so no install
// could ever satisfy it and DSH fails to start. Prints what it changed.
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import path from 'node:path'

const profile = process.argv[2] || process.env.DSH_PROFILE || 'desktop'
const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE ?? process.env.HOME, '.dsh')
const pkgPath = path.join(home, 'profiles', profile, 'package.json')

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const bundles = pkg?.dsh?.profile?.bundles
if (!Array.isArray(bundles)) {
  console.log('no dsh.profile.bundles found')
  process.exit(0)
}
const deps = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}

// Shipped bundles resolve from the installation; they never need a dependency entry.
const shipped = (name) => name.startsWith('@deepseek-ai/dsh-') || name.startsWith('@deepseek-ai/cordis')

const dropped = []
const kept = []
for (const name of bundles) {
  if (typeof name !== 'string') { kept.push(name); continue }
  const declared = Object.prototype.hasOwnProperty.call(deps, name)
  if (!declared && !shipped(name)) {
    dropped.push(name)
    continue
  }
  kept.push(name)
}

if (!dropped.length) {
  console.log('nothing to drop; every bundle has a dependency entry or ships with dsh')
  process.exit(0)
}

const backup = `${pkgPath}.before-bundle-prune`
copyFileSync(pkgPath, backup)
pkg.dsh.profile.bundles = kept
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

console.log(`dropped ${dropped.length} bundle selection(s) with no dependency entry:`)
for (const name of dropped) console.log(`  - ${name}`)
console.log(`\nkept: ${kept.join(', ')}`)
console.log(`backup: ${path.basename(backup)}`)