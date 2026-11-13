import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../dsh/index.js'

const root = mkdtempSync(join(tmpdir(), 'dce-review-'))
mkdirSync(join(root, 'src'), { recursive: true })
writeFileSync(join(root, 'a.txt'), 'line1\nline2\nline3\n')
writeFileSync(join(root, 'notes.md'), '# notes\n')
writeFileSync(join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x41]))
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3kAAAAAElFTkSuQmCC',
  'base64'
)
writeFileSync(join(root, 'pixel.png'), png)

const routes = new Map()
const events = [
  { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'edit' } },
  {
    type: 'tool/result',
    seq: 2,
    time: 1794024700000,
    data: {
      turn: 1,
      message: { toolCallId: 'c1' },
      meta: {
        path: join(root, 'a.txt'),
        diffs: [
          {
            path: join(root, 'a.txt'),
            oldText: 'line1\nline2\nline3',
            newText: 'line1\nCHANGED\nline3',
          },
        ],
      },
    },
  },
  { type: 'workspace/changes', seq: 3, time: 1794024701000, data: { turn: 1 } },
]
const session = { id: 's1', header: { root }, log: events }

const workspaceChanges = {
  summary(_sessionId, seq) {
    if (seq !== 3) return undefined
    return {
      turn: 1,
      cwd: root,
      files: [{ path: 'a.txt', display: 'a.txt', added: 1, deleted: 1 }],
      total: 1,
      added: 1,
      deleted: 1,
    }
  },
  async diff(_sessionId, seq, index) {
    if (seq !== 3 || index !== 0) return undefined
    return {
      kind: 'text',
      path: 'a.txt',
      display: 'a.txt',
      before: true,
      after: true,
      coarse: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [' line1', '-line2', '+CHANGED', ' line3'],
        },
      ],
    }
  },
}

const ctx = {
  connection: { fetch: { register(route) { routes.set(route.path, route) } } },
  sessions: { get: (id) => (id === 's1' ? session : undefined) },
  workspaceChanges,
  effect(fn) {
    fn()
  },
  inject(services, callback) {
    const scope = {}
    for (const service of services) {
      if (service in ctx) scope[service] = ctx[service]
    }
    if (services.every((service) => service in scope)) callback(scope)
  },
  logger: { info() {}, warn() {} },
}

apply(ctx)

async function post(path, body) {
  const route = routes.get(`/api/central-editor${path}`)
  assert.ok(route, `route ${path} registered`)
  const response = await route.fetch(
    new Request(`http://x/api/central-editor${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  )
  const payload = await response.json()
  return { status: response.status, payload }
}

let passed = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`✔ ${name}`)
    passed += 1
  } catch (error) {
    console.error(`✘ ${name}`)
    throw error
  }
}

await test('fileText：文本文件返回全文、行数与版本', async () => {
  const { status, payload } = await post('/fileText', { sessionId: 's1', path: 'a.txt' })
  assert.equal(status, 200)
  assert.equal(payload.value.text, 'line1\nline2\nline3\n')
  assert.equal(payload.value.lines, 4)
  assert.equal(payload.value.binary, false)
  assert.match(payload.value.version, /^\d+:\d+:[0-9a-f]{16}$/)
})

await test('fileText：二进制不返回文本', async () => {
  const { payload } = await post('/fileText', { sessionId: 's1', path: 'bin.dat' })
  assert.equal(payload.value.binary, true)
  assert.equal(payload.value.text, '')
})

await test('raw：图片回 data URL，未知二进制回十六进制', async () => {
  const image = await post('/raw', { sessionId: 's1', path: 'pixel.png' })
  assert.equal(image.payload.value.kind, 'image')
  assert.equal(image.payload.value.mime, 'image/png')
  assert.ok(image.payload.value.base64.length > 0)
  const binary = await post('/raw', { sessionId: 's1', path: 'bin.dat' })
  assert.equal(binary.payload.value.kind, 'binary')
  assert.equal(binary.payload.value.hex, '00010241')
})

await test('fileText：越界路径被拒', async () => {
  const { status, payload } = await post('/fileText', { sessionId: 's1', path: '../outside.txt' })
  assert.equal(status, 400)
  assert.equal(payload.code, 'editor-file/forbidden-path')
})

await test('review：一轮 1 文件 1 块，行数与 hunk 一致', async () => {
  const { status, payload } = await post('/review', { sessionId: 's1' })
  assert.equal(status, 200)
  const review = payload.value
  assert.equal(review.totals.batches, 1)
  assert.equal(review.totals.files, 1)
  assert.equal(review.totals.hunks, 1)
  const file = review.turns[0].files[0]
  assert.equal(file.path, 'a.txt')
  assert.equal(file.added, 1)
  assert.equal(file.deleted, 1)
  assert.equal(file.hunkCount, 1)
  assert.equal(file.canRollback, true)
  assert.equal(file.hunks[0].oldText, 'line1\nline2\nline3')
  assert.equal(file.hunks[0].newText, 'line1\nCHANGED\nline3')
})

await test('review：workspaceChanges 没有摘要时用转录 diffs 兜底', async () => {
  const savedSummary = workspaceChanges.summary
  workspaceChanges.summary = () => undefined
  try {
    const { payload } = await post('/review', { sessionId: 's1' })
    const review = payload.value
    assert.equal(review.totals.hunks, 1)
    assert.equal(review.turns[0].files[0].origin, 'tool')
    assert.equal(review.turns[0].files[0].added, 1)
    assert.equal(review.turns[0].files[0].deleted, 1)
  } finally {
    workspaceChanges.summary = savedSummary
  }
})

await test('applyPatch：版本匹配才写，写后版本变化', async () => {
  const before = await post('/fileText', { sessionId: 's1', path: 'a.txt' })
  const text = before.payload.value.text
  const from = text.indexOf('line2')
  const { status, payload } = await post('/applyPatch', {
    sessionId: 's1',
    path: 'a.txt',
    baseVersion: before.payload.value.version,
    edits: [{ from, to: from + 'line2'.length, text: 'line2-fixed' }],
  })
  assert.equal(status, 200)
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'line1\nline2-fixed\nline3\n')
  const next = await post('/fileText', { sessionId: 's1', path: 'a.txt' })
  assert.equal(next.payload.value.version, payload.value.version)
})

await test('applyPatch：旧版本被拒为 editor-file/stale', async () => {
  await new Promise((resolve) => setTimeout(resolve, 260))
  const { status, payload } = await post('/applyPatch', {
    sessionId: 's1',
    path: 'a.txt',
    baseVersion: '1:1:deadbeefdeadbeef',
    edits: [{ from: 0, to: 1, text: 'x' }],
  })
  assert.equal(status, 409)
  assert.equal(payload.code, 'editor-file/stale')
})

await test('applyPatch：非法区间被拒', async () => {
  const current = await post('/fileText', { sessionId: 's1', path: 'a.txt' })
  await new Promise((resolve) => setTimeout(resolve, 260))
  const { status, payload } = await post('/applyPatch', {
    sessionId: 's1',
    path: 'a.txt',
    baseVersion: current.payload.value.version,
    edits: [{ from: 999, to: 1000, text: 'x' }],
  })
  assert.equal(status, 400)
  assert.equal(payload.code, 'editor-file/bad-request')
})

console.log(`\n${passed} 组服务端审阅/读取测试全绿`)
rmSync(root, { recursive: true, force: true })
