/**
 * #10 的性能快照：服务端读写往返（可重复基线，不进 npm test 的绿/红门禁）。
 *
 * 用法：node test/perf-snapshot.mjs [--json out.json]
 * 口径：真实临时工作区 + 真实路由；每项先 1 次预热，再取 N 次样本的中位数/最小值/最大值。
 * 首帧的浏览器渲染开销不在这个脚本里，报告里单独标注。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { apply } from '../dsh/index.js'

const root = mkdtempSync(join(tmpdir(), 'dce-perf-'))
mkdirSync(join(root, 'src'), { recursive: true })

const enc = new TextEncoder()
function makeText(bytes) {
  const lines = []
  let size = 0
  for (let i = 1; size < bytes; i += 1) {
    const line = `line ${String(i).padStart(6, '0')} ${'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(2)}\n`
    lines.push(line)
    size += enc.encode(line).length
  }
  return lines.join('').slice(0, bytes)
}

writeFileSync(join(root, 'perf-100kb.txt'), makeText(100 * 1024))
writeFileSync(join(root, 'perf-1mb.txt'), makeText(1024 * 1024))
writeFileSync(join(root, 'small.txt'), 'alpha\nbeta\ngamma\ndelta\n')

const routes = new Map()
const session = { id: 'perf', header: { root }, log: [] }
const ctx = {
  connection: { fetch: { register(route) { routes.set(route.path, route) } } },
  sessions: { get: (id) => (id === 'perf' ? session : undefined) },
  effect(fn) { fn() },
  inject(services, callback) {
    const scope = {}
    for (const service of services) if (service in ctx) scope[service] = ctx[service]
    if (services.every((service) => service in scope)) callback(scope)
  },
  logger: { info() {}, warn() {} },
}
apply(ctx)

async function post(path, body) {
  const route = routes.get(`/api/central-editor${path}`)
  if (!route) throw new Error(`route ${path} 未注册`)
  const response = await route.fetch(
    new Request(`http://x/api/central-editor${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  )
  return { status: response.status, payload: await response.json() }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const stats = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b)
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return {
    n: samples.length,
    min: +sorted[0].toFixed(2),
    median: +pick(0.5).toFixed(2),
    p95: +pick(0.95).toFixed(2),
    max: +sorted[sorted.length - 1].toFixed(2),
  }
}

async function measure(name, fn, { iterations = 7, warmup = true, gapMs = 0 } = {}) {
  if (warmup) await fn()
  const samples = []
  for (let i = 0; i < iterations; i += 1) {
    if (gapMs) await sleep(gapMs)
    const started = performance.now()
    await fn()
    samples.push(performance.now() - started)
  }
  return { name, ...stats(samples) }
}

const results = []
results.push(
  await measure('fileText · 100 KB', () => post('/fileText', { sessionId: 'perf', path: 'perf-100kb.txt' }), {
    iterations: 10,
  })
)
results.push(
  await measure('fileText · 1 MB', () => post('/fileText', { sessionId: 'perf', path: 'perf-1mb.txt' }), {
    iterations: 10,
  })
)

// 保存往返：版本 + 补丁 + fsync + rename；间隔 260 ms 避开 200 ms 限流。
const saveTimes = []
let version = (await post('/fileText', { sessionId: 'perf', path: 'small.txt' })).payload.value.version
const original = readFileSync(join(root, 'small.txt'), 'utf8')
for (let i = 0; i < 7; i += 1) {
  await sleep(260)
  const started = performance.now()
  const result = await post('/applyPatch', {
    sessionId: 'perf',
    path: 'small.txt',
    baseVersion: version,
    edits: [{ from: 0, to: 0, text: `/*${i}*/` }],
  })
  saveTimes.push(performance.now() - started)
  if (result.status !== 200) throw new Error(`保存失败：${JSON.stringify(result.payload)}`)
  version = result.payload.value.version
}
results.push({ name: 'applyPatch · 小文件保存往返', ...stats(saveTimes) })

// 回滚一块：按块定位，只替换这一段（只读补丁的反向应用）。
await sleep(260)
const beforeText = readFileSync(join(root, 'small.txt'), 'utf8')
const rollbackFrom = beforeText.indexOf('delta')
const rollbackTo = rollbackFrom + 'delta'.length
const rollbackStart = performance.now()
const rollback = await post('/applyPatch', {
  sessionId: 'perf',
  path: 'small.txt',
  baseVersion: version,
  edits: [{ from: rollbackFrom, to: rollbackTo, text: 'DELTA' }],
})
const rollbackMs = performance.now() - rollbackStart
if (rollback.status !== 200) throw new Error(`回滚失败：${JSON.stringify(rollback.payload)}`)
results.push({ name: 'applyPatch · 回滚一块（单段补丁）', n: 1, min: +rollbackMs.toFixed(2), median: +rollbackMs.toFixed(2), p95: +rollbackMs.toFixed(2), max: +rollbackMs.toFixed(2) })
writeFileSync(join(root, 'small.txt'), original)

const payload = {
  when: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  results,
  notes: [
    'fileText 含整文件 SHA-1 版本计算与 UTF-8 解码，是打开文件的读路径。',
    'applyPatch 含版本校验、整读、补丁、临时文件 fsync 与 rename。',
    '100 KB / 1 MB 的首帧还含客户端 Monaco 模型与渲染，见验收报告。',
  ],
}

const jsonIndex = process.argv.indexOf('--json')
if (jsonIndex >= 0 && process.argv[jsonIndex + 1]) writeFileSync(process.argv[jsonIndex + 1], `${JSON.stringify(payload, null, 2)}\n`)

console.log(`# 性能快照 ${payload.when} (node ${payload.node}, ${payload.platform})`)
console.log('| 项目 | n | min ms | median ms | p95 ms | max ms |')
console.log('| --- | --- | --- | --- | --- | --- |')
for (const row of results) console.log(`| ${row.name} | ${row.n} | ${row.min} | ${row.median} | ${row.p95} | ${row.max} |`)

rmSync(root, { recursive: true, force: true })
