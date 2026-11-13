/**
 * 把本仓的插件装进本机 DSH profile（不改 lockfile、不跑包管理器）。
 *
 * 做法：在 profile 的 package.json 里登记 dependencies 与 pnpm.overrides（link: 指向本仓目录）、
 * 把包名追加进 dsh.profile.bundles，再在 profile 的 node_modules 下建一个目录联接，
 * 让 Node 能按包名解析到它。幂等：重复执行不会重复追加。
 *
 * 用法：
 *   node scripts/install-local.mjs --profile "<DSH profile 目录>" [--dry-run]
 *   node scripts/install-local.mjs --profile "..." --uninstall
 *
 * 不给 --profile 时，Windows 默认找 %APPDATA%\dsh-desktop\harness\profiles\web。
 * DSH profile 目录就是含 package.json 与 node_modules 的那一层（应用设置里能看到路径）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = 'dsh-central-editor'
const TARGET = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const uninstall = argv.includes('--uninstall')
const profileArgIndex = argv.findIndex((a) => a === '--profile' || a.startsWith('--profile='))
const profileArg = profileArgIndex === -1
  ? undefined
  : (argv[profileArgIndex].includes('=')
      ? argv[profileArgIndex].split('=').slice(1).join('=')
      : argv[profileArgIndex + 1])

const defaultProfile = process.platform === 'win32' && process.env.APPDATA
  ? join(process.env.APPDATA, 'dsh-desktop', 'harness', 'profiles', 'web')
  : undefined
const profileSpec = profileArg ?? process.env.DSH_PROFILE ?? defaultProfile

if (!profileSpec) {
  console.error('找不到默认 DSH profile，请用 --profile "<profile 目录>" 或环境变量 DSH_PROFILE 指定（目录里应有 package.json）。')
  process.exit(1)
}

const PROFILE = resolve(profileSpec)
const manifestPath = join(PROFILE, 'package.json')
if (!existsSync(manifestPath)) {
  console.error(`profile 里没有 package.json：${manifestPath}`)
  process.exit(1)
}

const linkPath = join(PROFILE, 'node_modules', PKG)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
manifest.dependencies ??= {}
manifest.pnpm ??= {}
manifest.pnpm.overrides ??= {}
manifest.dsh ??= {}
manifest.dsh.profile ??= {}

const spec = `link:${TARGET}`
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
const hadBundle = bundles.includes(PKG)
const before = manifest.dependencies[PKG]

const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase()

/** 是重定向（junction / 符号链接）吗？真实目录的 realpath 等于自身，不会被当成联接。 */
function isLink(link) {
  if (!existsSync(link)) return false
  try {
    return !samePath(realpathSync.native(link), link)
  } catch {
    return false
  }
}

function linkTarget(link) {
  try {
    return realpathSync.native(link)
  } catch {
    return '(无法解析)'
  }
}

/** 只删联接本身；junction/符号链接的目录内容绝不递归删。 */
function removeLink(link) {
  if (process.platform === 'win32') rmdirSync(link)
  else unlinkSync(link)
}

function commitManifest() {
  const backup = `${manifestPath}.bak-${PKG}-${Date.now()}`
  copyFileSync(manifestPath, backup)
  console.log(`备份：${backup}`)
  const temp = `${manifestPath}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`)
  renameSync(temp, manifestPath)
  console.log(`WROTE ${manifestPath}`)
}

if (uninstall) {
  delete manifest.dependencies[PKG]
  delete manifest.pnpm.overrides[PKG]
  manifest.dsh.profile.bundles = bundles.filter((name) => name !== PKG)
  console.log(`dependencies.${PKG}: ${before ?? '(none)'} -> (removed)`)
  console.log(`dsh.profile.bundles: ${hadBundle ? '已移除' : '本来就没有'}`)
  if (dryRun) {
    console.log('--dry-run：未写入')
    process.exit(0)
  }
  commitManifest()
  if (isLink(linkPath)) {
    removeLink(linkPath)
    console.log(`REMOVED ${linkPath}（应用内 Ctrl+R 重载生效）`)
  } else if (existsSync(linkPath)) {
    console.log(`跳过联接：${linkPath} 是真实目录，未动它`)
  }
  process.exit(0)
}

manifest.dependencies[PKG] = spec
manifest.pnpm.overrides[PKG] = spec
if (!hadBundle) bundles.push(PKG)
manifest.dsh.profile.bundles = bundles

console.log(`profile：${PROFILE}`)
console.log(`包目录：${TARGET}`)
console.log(`dependencies.${PKG}: ${before ?? '(none)'} -> ${spec}`)
console.log(`pnpm.overrides.${PKG}: ${spec}`)
console.log(`dsh.profile.bundles: ${hadBundle ? '已存在，未追加' : '已追加'}`)

if (dryRun) {
  console.log('--dry-run：未写入')
  process.exit(0)
}

commitManifest()

const linkDir = join(PROFILE, 'node_modules')
mkdirSync(linkDir, { recursive: true })
if (existsSync(linkPath)) {
  if (!isLink(linkPath)) {
    throw new Error(`${linkPath} 已存在且是真实目录（不是联接），先人工确认再装`)
  }
  const old = linkTarget(linkPath)
  removeLink(linkPath)
  console.log(`已移除旧联接 → ${old}`)
}
symlinkSync(TARGET, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
console.log(`LINK ${linkPath} -> ${TARGET}`)
console.log('装完在应用窗口里按 Ctrl+R 重新加载即可（客户端脚本由宿主按需从磁盘取）。')
