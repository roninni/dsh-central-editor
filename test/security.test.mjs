/**
 * 写通道的安全回归：#10 要求越界写入、符号链接逃逸、并发写、超限写 100% 被拒。
 *
 * 这里打的是 HTTP 边界（ADR-0004 的接缝一）：真实临时工作区 + 真实路由处理函数，
 * 断言返回码与磁盘字节，不 mock 文件系统。文件符号链接在 Windows 需要管理员权限，
 * 用目录联接（junction）覆盖同一类逃逸；文件符号链接的 lstat 检查由代码路径保证。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../dsh/index.js'

const root = mkdtempSync(join(tmpdir(), 'dce-sec-root-'))
const outside = mkdtempSync(join(tmpdir(), 'dce-sec-out-'))
mkdirSync(join(root, 'src'), { recursive: true })
writeFileSync(join(root, 'a.txt'), 'alpha\nbeta\ngamma\n')
writeFileSync(join(outside, 'secret.txt'), 'outside-secret\n')

const routes = new Map()
const session = { id: 'sec', header: { root }, log: [] }
const ctx = {
  connection: { fetch: { register(route) { routes.set(route.path, route) } } },
  sessions: { get: (id) => (id === 'sec' ? session : undefined) },
  effect(fn) {
    fn()
  },
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
  assert.ok(route, `route ${path} registered`)
  const response = await route.fetch(
    new Request(`http://x/api/central-editor${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  )
  return { status: response.status, payload: await response.json() }
}

async function versionOf(path) {
  const result = await post('/fileText', { sessionId: 'sec', path })
  assert.equal(result.status, 200, `fileText ${path}`)
  return result.payload.value.version
}

function patchBody(path, baseVersion, text) {
  return {
    sessionId: 'sec',
    path,
    baseVersion,
    edits: [{ from: 0, to: 0, text }],
  }
}

test.after(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

test('越界与绝对路径写入被拒', async () => {
  const cases = ['../outside.txt', '..\\outside.txt', 'C:\\Windows\\win.ini', '\\\\server\\share\\a.txt', 'CON', 'a:b', 'file:///c:/a.txt', 'src/../../outside.txt']
  for (const path of cases) {
    const { status, payload } = await post('/applyPatch', patchBody(path, null, 'pwn'))
    assert.equal(status, 400, `应拒绝 ${path}`)
    assert.equal(payload.code, 'editor-file/forbidden-path', `应拒绝 ${path}`)
  }
})

test('工作区外的真实文件没有被写', async () => {
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'outside-secret\n')
})

test('目录联接（junction）逃逸被拒', async () => {
  const junction = join(root, 'junction-out')
  symlinkSync(outside, junction, 'junction')
  const created = await post('/applyPatch', {
    sessionId: 'sec',
    path: 'junction-out/escape.txt',
    baseVersion: null,
    createIfMissing: true,
    edits: [{ from: 0, to: 0, text: 'pwn' }],
  })
  assert.equal(created.status, 400)
  assert.equal(created.payload.code, 'editor-file/outside-workspace')

  const read = await post('/fileText', { sessionId: 'sec', path: 'junction-out/secret.txt' })
  assert.equal(read.status, 400)
  assert.equal(read.payload.code, 'editor-file/outside-workspace')
})

test('文件符号链接被拒（无权限时跳过并留痕）', async (t) => {
  const link = join(root, 'link-out.txt')
  try {
    symlinkSync(join(outside, 'secret.txt'), link, 'file')
  } catch (error) {
    t.diagnostic(`跳过：本机创建文件符号链接需要管理员权限（${error.code ?? error.message}）；目录联接用例已覆盖同一逃逸面`)
    return
  }
  const result = await post('/fileText', { sessionId: 'sec', path: 'link-out.txt' })
  assert.equal(result.status, 400)
  assert.equal(result.payload.code, 'editor-file/forbidden-path')
})

test('并发写：同版本两笔同时提交，只允许一笔落盘', async () => {
  const path = 'src/race.txt'
  writeFileSync(join(root, path), 'base\n')
  const baseVersion = await versionOf(path)
  const [first, second] = await Promise.all([
    post('/applyPatch', patchBody(path, baseVersion, 'FIRST\n')),
    post('/applyPatch', patchBody(path, baseVersion, 'SECOND\n')),
  ])
  const statuses = [first.status, second.status].sort()
  assert.equal(statuses[0], 200, `两笔并发应有一笔成功，实际 ${statuses}`)
  assert.ok([409, 429].includes(statuses[1]), `另一笔应被拒（409/429），实际 ${statuses}`)
  const rejected = first.status === 200 ? second : first
  assert.ok(['editor-file/busy', 'editor-file/stale'].includes(rejected.payload.code), rejected.payload.code)
  const text = readFileSync(join(root, path), 'utf8')
  assert.ok(text === 'FIRST\nbase\n' || text === 'SECOND\nbase\n', `文件应只落一笔改动，实际 ${JSON.stringify(text)}`)
})

test('超限写：11 MB 文件上的补丁被拒为 413', async () => {
  const path = 'src/huge.txt'
  const huge = 'x'.repeat(11 * 1024 * 1024)
  writeFileSync(join(root, path), huge)
  const baseVersion = await versionOf(path)
  const result = await post('/applyPatch', patchBody(path, baseVersion, 'y'))
  assert.equal(result.status, 413)
  assert.equal(result.payload.code, 'editor-file/too-large')
  assert.equal(readFileSync(join(root, path), 'utf8').length, huge.length)
})

test('限流：刚写过的路径立即再写被拒为 429', async () => {
  const path = 'src/rate.txt'
  writeFileSync(join(root, path), 'one\n')
  const baseVersion = await versionOf(path)
  const first = await post('/applyPatch', patchBody(path, baseVersion, 'two\n'))
  assert.equal(first.status, 200)
  const second = await post('/applyPatch', patchBody(path, first.payload.value.version, 'three\n'))
  assert.equal(second.status, 429)
  assert.equal(second.payload.code, 'editor-file/busy')
})
