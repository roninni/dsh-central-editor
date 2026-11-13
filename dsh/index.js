/**
 * 服务端入口：唯一写入口 + 审阅数据。
 *
 * 设计（见 docs/adr/0010-write-channel-auth-route-patch.md、0014）：
 * - 传输是本机认证路由（cookie 证明 owner Peer），sessionId 由调用方带、服务端自校验；
 * - 写接口形状是**补丁**：只提交被改动的区间，不整篇覆盖；
 * - 写入前比对版本，不匹配一律拒绝（绝不覆盖）；
 * - 路径守卫、原子写、限流、审计全部在这里，不依赖审批管线。
 *
 * 审阅数据有两层：
 * - `workspaceChanges` 服务（Host 内存）给出每一轮开始/结束的完整文件对比，
 *   能覆盖 shell 改动；Host 重启后这一层消失。
 * - 会话转录里的 `tool/result.meta.diffs`（write/edit 产出）落盘、重启后仍在，
 *   作为持久层；两层按「轮次 + 路径」合并，持久层兜底。
 *
 * 根解析是本插件唯一需要向宿主借的能力。宿主 workspaceFiles 以 session scope 为
 * 入口，本文件按几条已知形态依次解析工作区根；解析不到就**拒绝写入**（fail
 * closed），并把试过的候选一并报出来，便于一次定位而不是反复猜。
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'

import { hunkFromPatchLines, hunkFromText, normalizeWorkspacePath } from './review-model.js'
import { isInside, pickRoot, rejectPathShape } from './path-guard.js'

export const name = 'dsh-central-editor'

export const inject = ['connection', 'sessions']

const ROUTE_PREFIX = '/api/central-editor'
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_WRITE_BYTES = 10 * 1024 * 1024
const MAX_READ_BYTES = 10 * 1024 * 1024
const MAX_RAW_BYTES = 5 * 1024 * 1024
const WRITE_INTERVAL_MS = 200
const REVIEW_DIFF_LIMIT = 60
const REVIEW_DIFF_TIMEOUT_MS = 2500

const IMAGE_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
  ['.avif', 'image/avif'],
  ['.svg', 'image/svg+xml'],
])

/** 限流是进程内状态；重启即清零，可接受（审计同时写日志）。 */
const lastWriteAt = new Map()

/**
 * 同一会话 + 路径的写盘互斥。限流只挡住「写完之后立刻再写」，挡不住两个请求
 * 同时通过版本检查；并发写必须整笔拒绝，不能让后一个静默覆盖前一个。
 */
const pendingWrites = new Set()

function fail(status, code, message, extra) {
  return Response.json({ code, message, ...(extra ?? {}) }, { status, headers: { 'cache-control': 'no-store' } })
}

function ok(value) {
  return Response.json({ value }, { headers: { 'cache-control': 'no-store' } })
}

async function readJson(request) {
  const length = Number(request.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw Object.assign(new Error('请求体过大'), { status: 413 })
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw Object.assign(new Error('请求体过大'), { status: 413 })
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 })
  }
}

/** 版本 = 字节数 + 修改时间 + 内容哈希前缀；内容一变版本必变。 */
function versionOf(buffer, mtimeMs) {
  const digest = createHash('sha1').update(buffer).digest('hex').slice(0, 16)
  return `${buffer.byteLength}:${Math.trunc(mtimeMs)}:${digest}`
}

function isBinaryBuffer(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
  for (const byte of sample) if (byte === 0) return true
  return false
}

/** 可选注入的工作区/文件服务；拿不到不影响插件加载，只影响写盘与部分审阅来源。 */
let workspacesRef
let fsRef
let workspaceChangesRef

/**
 * 解析工作区根。DSH 把工作区挂在会话头（`session.header`）上；这里按
 * 「会话自身 → 会话头 → 工作区列表」三层依次找，找不到就 fail closed。
 */
async function resolveRoot(ctx, sessionId) {
  const tried = []

  // sessions.get 是同步的（也可能是 thenable，两种都兼容）。
  let session
  try {
    session = ctx.sessions.get(sessionId)
    if (session && typeof session.then === 'function') session = await session
  } catch (error) {
    tried.push(`sessions.get: ${error?.message ?? error}`)
    session = undefined
  }

  if (!session) {
    tried.push('sessions.get 返回空')
  } else {
    const direct = pickRoot(session, 'session')
    if (direct) return direct

    const header = session.header
    if (!header || typeof header !== 'object') {
      tried.push('session.header 缺失')
    } else {
      const fromHeader = pickRoot(header, 'session.header')
      if (fromHeader) return fromHeader
      for (const nestedKey of ['workspace', 'context', 'identity', 'root']) {
        const nested = header[nestedKey]
        const fromNested = pickRoot(nested, `session.header.${nestedKey}`)
        if (fromNested) return fromNested
        if (nested && typeof nested === 'object') {
          tried.push(`header.${nestedKey} keys=${Object.keys(nested).join(',')}`)
        }
      }
      tried.push(`session.header keys=${Object.keys(header).join(',')}`)
    }

    if (!workspacesRef) {
      tried.push('workspaces 未注入')
    } else {
      try {
        const snapshot =
          typeof workspacesRef.list?.getSnapshot === 'function' ? workspacesRef.list.getSnapshot() : undefined
        const items = snapshot?.items ?? []
        tried.push(`workspaces=${items.length}`)
        const bySession = items.find(
          (item) => Array.isArray(item?.sessionIds) && item.sessionIds.includes(sessionId)
        )
        const workspaceId = header?.workspaceId ?? header?.workspace?.id ?? session.workspaceId
        const byId = workspaceId
          ? items.find((item) => item?.workspaceId === workspaceId || item?.id === workspaceId)
          : undefined
        const target = bySession ?? byId
        if (target) {
          const fromWorkspace = pickRoot(target, 'workspace')
          if (fromWorkspace) return fromWorkspace
          tried.push(`workspace keys=${Object.keys(target).join(',')}`)
        }
      } catch (error) {
        tried.push(`workspaces: ${error?.message ?? error}`)
      }
    }
  }

  throw Object.assign(new Error('解析不到这个会话的工作区根'), {
    status: 409,
    code: 'editor-file/root-unresolved',
    tried,
  })
}

/** 解析一次读写目标：路径形状 → 工作区根 → 真实父目录 → 目标状态。 */
async function locateTarget(ctx, sessionId, path, { createIfMissing = false } = {}) {
  const shapeError = rejectPathShape(path)
  if (shapeError) throw Object.assign(new Error(shapeError), { status: 400, code: 'editor-file/forbidden-path' })

  const { root } = await resolveRoot(ctx, sessionId)
  // `.native` 才会解析 Windows 目录联接（junction）；普通 realpathSync 会把它当普通目录返回。
  const realRoot = realpathSync.native(root)
  const target = resolve(realRoot, path)
  if (!isInside(realRoot, target)) {
    throw Object.assign(new Error('不在当前工作区'), { status: 400, code: 'editor-file/outside-workspace' })
  }

  const parent = dirname(target)
  if (!existsSync(parent)) {
    if (createIfMissing) throw Object.assign(new Error('目录不存在'), { status: 404, code: 'editor-file/not-found' })
    throw Object.assign(new Error('目录不存在'), { status: 404, code: 'editor-file/not-found' })
  }
  const realParent = realpathSync.native(parent)
  if (!isInside(realRoot, realParent)) {
    throw Object.assign(new Error('解析后越出工作区'), { status: 400, code: 'editor-file/outside-workspace' })
  }

  const exists = existsSync(target)
  let info
  if (exists) {
    info = lstatSync(target)
    if (info.isSymbolicLink()) {
      throw Object.assign(new Error('不接受符号链接'), { status: 400, code: 'editor-file/forbidden-path' })
    }
    if (!info.isFile()) {
      throw Object.assign(new Error('目标不是普通文件'), { status: 400, code: 'editor-file/not-regular-file' })
    }
  } else if (!createIfMissing) {
    throw Object.assign(new Error('文件不存在'), { status: 404, code: 'editor-file/not-found' })
  }

  return { root, realRoot, target, realParent, exists, stat: exists ? statSync(target) : undefined }
}

function respond(error) {
  if (error && typeof error.status === 'number') {
    return fail(error.status, error.code ?? 'editor-file/io-error', error.message, error.tried ? { tried: error.tried } : undefined)
  }
  return fail(500, 'editor-file/io-error', error?.message ?? '未知错误')
}

// ---------------------------------------------------------------------------
// 审阅数据
// ---------------------------------------------------------------------------

function makeBatch(batches, turn, time, seq) {
  let batch = batches.get(turn)
  if (!batch) {
    batch = { turn, time: Number(time) || 0, seq: seq ?? null, files: new Map() }
    batches.set(turn, batch)
  } else {
    if (time && (!batch.time || Number(time) < batch.time)) batch.time = Number(time)
    if (seq !== undefined && (batch.seq === null || seq > batch.seq)) batch.seq = seq
  }
  return batch
}

function makeFile(batch, path, display) {
  let file = batch.files.get(path)
  if (!file) {
    file = {
      path,
      display: display || path,
      added: 0,
      deleted: 0,
      hunks: [],
      binary: false,
      oversized: false,
      created: false,
      coarse: false,
      origin: 'tool',
      sourceKnown: true,
    }
    batch.files.set(path, file)
  }
  return file
}

/**
 * 从 Session 事件 + workspaceChanges 服务构造审阅队列。
 * @returns {Promise<{root:string, turns:Array, totals:object}>}
 */
async function buildReview(ctx, sessionId) {
  const { root } = await resolveRoot(ctx, sessionId)
  let session
  try {
    session = ctx.sessions.get(sessionId)
    if (session && typeof session.then === 'function') session = await session
  } catch {
    session = undefined
  }
  if (!session) return { root, turns: [], totals: { batches: 0, files: 0, hunks: 0, added: 0, deleted: 0 } }

  const log = Array.isArray(session.log) ? session.log : []
  const calls = new Map()
  for (const event of log) {
    if (event?.type === 'tool/call' && event.data?.callId) calls.set(event.data.callId, event.data.name)
  }

  const batches = new Map()
  let diffBudget = REVIEW_DIFF_LIMIT

  // 持久层：write/edit 的 tool/result.meta.diffs。
  for (const event of log) {
    if (event?.type !== 'tool/result') continue
    const meta = event.data?.meta
    if (!meta) continue
    const turn = Number(event.data.turn) || 0
    const callId = event.data.message?.toolCallId
    const toolName = calls.get(callId) ?? 'unknown'
    const pathValue = typeof meta.path === 'string' ? meta.path : undefined

    if (Array.isArray(meta.diffs) && meta.diffs.length > 0) {
      const batch = makeBatch(batches, turn, event.time)
      meta.diffs.forEach((diff, index) => {
        if (!diff || typeof diff.newText !== 'string') return
        const rel = normalizeWorkspacePath(root, diff.path) ?? diff.path
        const file = makeFile(batch, rel, rel)
        file.origin = 'tool'
        file.lastTool = toolName
        file.hunks.push(
          hunkFromText({
            oldText: diff.oldText,
            newText: diff.newText,
            index: file.hunks.length,
            id: `${turn}\u0000${rel}\u0000${file.hunks.length}`,
            turn,
            path: rel,
          })
        )
      })
      continue
    }

    if (pathValue && meta.operation === 'create') {
      const batch = makeBatch(batches, turn, event.time)
      const rel = normalizeWorkspacePath(root, pathValue) ?? pathValue
      const file = makeFile(batch, rel, rel)
      file.created = true
      file.sourceKnown = false
      file.origin = 'tool'
      file.lastTool = toolName
    }
  }

  // 实时层：workspaceChanges 的逐轮摘要 + 按需对比。同一轮只取最后一条事件。
  if (workspaceChangesRef) {
    const announced = new Map()
    for (const event of log) {
      if (event?.type !== 'workspace/changes') continue
      const turn = Number(event.data?.turn) || 0
      const previous = announced.get(turn)
      if (!previous || event.seq > previous.seq) announced.set(turn, event)
    }
    for (const event of announced.values()) {
      let summary
      try {
        summary = workspaceChangesRef.summary(sessionId, event.seq)
      } catch {
        summary = undefined
      }
      if (!summary || !Array.isArray(summary.files)) continue
      const turn = Number(summary.turn ?? event.data?.turn) || 0
      const batch = makeBatch(batches, turn, event.time, event.seq)
      for (let index = 0; index < summary.files.length; index += 1) {
        const listed = summary.files[index]
        if (!listed || typeof listed.path !== 'string') continue
        const rel = normalizeWorkspacePath(root, listed.path) ?? listed.path
        const file = makeFile(batch, rel, listed.display || listed.path)
        file.added = Number(listed.added) || 0
        file.deleted = Number(listed.deleted) || 0
        file.binary = listed.binary === true
        file.oversized = listed.oversized === true
        file.origin = 'workspace'
        if (file.binary || file.oversized) continue
        if (diffBudget <= 0) continue
        diffBudget -= 1
        try {
          const diff = await workspaceChangesRef.diff(
            sessionId,
            event.seq,
            index,
            AbortSignal.timeout(REVIEW_DIFF_TIMEOUT_MS)
          )
          if (!diff) continue
          if (diff.kind === 'binary') {
            file.binary = true
            continue
          }
          if (diff.kind === 'oversized') {
            file.oversized = true
            continue
          }
          if (diff.kind !== 'text') continue
          file.coarse = diff.coarse === true
          file.hunks = (diff.hunks ?? []).map((hunk, hunkIndex) =>
            hunkFromPatchLines(hunk, {
              index: hunkIndex,
              id: `${turn}\u0000${rel}\u0000${hunkIndex}`,
              turn,
              path: rel,
            })
          )
          // 实时层是整轮对比；持久层同一路径的逐次 hunk 被它覆盖。
          file.origin = 'workspace'
        } catch {
          /* 对比读取失败时保留持久层或摘要行数 */
        }
      }
    }
  }

  const turns = [...batches.values()]
    .sort((a, b) => b.turn - a.turn)
    .map((batch) => {
      const files = [...batch.files.values()]
        .map((file) => {
          const hunks = file.hunks
          const added = file.added || hunks.reduce((sum, hunk) => sum + hunk.added, 0)
          const deleted = file.deleted || hunks.reduce((sum, hunk) => sum + hunk.deleted, 0)
          const hunkAdded = hunks.reduce((sum, hunk) => sum + hunk.added, 0)
          const hunkDeleted = hunks.reduce((sum, hunk) => sum + hunk.deleted, 0)
          return {
            ...file,
            added,
            deleted,
            hunkAdded,
            hunkDeleted,
            hunkCount: hunks.length,
            // 先 create 后又被 edit 的文件仍有 hunk，可回滚；只有纯新增才标「无基线」。
            created: file.created === true,
            noBaseline: file.created === true && hunks.length === 0,
            canRollback: hunks.length > 0,
          }
        })
        .sort((a, b) => a.display.localeCompare(b.display, 'zh-CN'))
      return {
        turn: batch.turn,
        time: batch.time,
        seq: batch.seq,
        files,
        totals: {
          files: files.length,
          hunks: files.reduce((sum, file) => sum + file.hunkCount, 0),
          added: files.reduce((sum, file) => sum + file.added, 0),
          deleted: files.reduce((sum, file) => sum + file.deleted, 0),
        },
      }
    })

  const totals = turns.reduce(
    (acc, batch) => {
      acc.batches += 1
      acc.files += batch.totals.files
      acc.hunks += batch.totals.hunks
      acc.added += batch.totals.added
      acc.deleted += batch.totals.deleted
      return acc
    },
    { batches: 0, files: 0, hunks: 0, added: 0, deleted: 0 }
  )

  return {
    root,
    turns,
    totals,
    coverage: {
      // 实时层能覆盖 shell 改动；缺它时只有 write/edit 的转录 diffs。
      workspaceChanges: Boolean(workspaceChangesRef),
      transcript: true,
    },
  }
}

function applyPatchToText(text, edits) {
  const sorted = [...edits].sort((a, b) => Number(b.from) - Number(a.from))
  let next = text
  for (const edit of sorted) {
    const from = Number(edit.from)
    const to = Number(edit.to)
    const value = typeof edit.text === 'string' ? edit.text : ''
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > next.length) {
      throw Object.assign(new Error(`补丁区间非法：${from}..${to}`), { status: 400, code: 'editor-file/bad-request' })
    }
    next = next.slice(0, from) + value + next.slice(to)
  }
  return next
}

export function apply(ctx) {
  // 可选注入：服务不在时由 cordis 等待，不会阻塞插件自身的加载。
  try {
    ctx.effect(() =>
      ctx.inject(['workspaces', 'fs'], (scope) => {
        workspacesRef = scope.workspaces
        fsRef = scope.fs
      })
    )
  } catch (error) {
    ctx.logger?.warn?.(`[central-editor] 可选注入失败：${error?.message ?? error}`)
  }
  // workspaceChanges 是审阅的实时层；缺了它仍能用转录里的 diffs 兜底。
  try {
    ctx.effect(() =>
      ctx.inject(['workspaceChanges'], (scope) => {
        workspaceChangesRef = scope.workspaceChanges
      })
    )
  } catch (error) {
    ctx.logger?.warn?.(`[central-editor] workspaceChanges 不可用：${error?.message ?? error}`)
  }

  const audit = (entry) => {
    try {
      ctx.logger?.info?.(`[central-editor] ${JSON.stringify(entry)}`)
    } catch {
      /* 日志失败不影响写入 */
    }
  }

  ctx.connection.fetch.register({
    path: `${ROUTE_PREFIX}/health`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch() {
      return ok({ name: 'dsh-central-editor', version: '0.3.0' })
    }
  })

  // 诊断：把「根解析试过什么」一次性说清。
  ctx.connection.fetch.register({
    path: `${ROUTE_PREFIX}/diag`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const body = await readJson(request)
        const sessionId = String(body.sessionId ?? '')
        const info = { sessionId, services: {} }
        for (const key of ['sessions', 'workspaces', 'workspaceFiles', 'workspaceChanges', 'typert', 'fs']) {
          try {
            const service = ctx[key]
            info.services[key] = service
              ? Object.keys(service).filter((name) => typeof service[name] === 'function').slice(0, 24)
              : null
          } catch (error) {
            info.services[key] = `需 inject：${error?.message ?? error}`
          }
        }
        try {
          const resolved = await resolveRoot(ctx, sessionId)
          info.root = resolved.root
          info.via = resolved.via
        } catch (error) {
          info.rootError = error?.message
          info.tried = error?.tried
        }
        // 会话对象长什么样，一次说清（下一轮就能照着改根解析）。
        try {
          const session = ctx.sessions && typeof ctx.sessions.get === 'function' ? await ctx.sessions.get(sessionId) : undefined
          if (session) {
            info.sessionKeys = Object.keys(session)
            info.sessionStrings = Object.fromEntries(
              Object.entries(session)
                .filter(([, value]) => typeof value === 'string')
                .map(([key, value]) => [key, value.length > 120 ? `${value.slice(0, 120)}…` : value])
            )
            info.sessionNested = Object.fromEntries(
              Object.entries(session)
                .filter(([, value]) => value && typeof value === 'object')
                .map(([key, value]) => [key, Object.keys(value).slice(0, 12)])
            )
            info.sessionLogLength = Array.isArray(session.log) ? session.log.length : null
            const header = session.header
            if (header && typeof header === 'object') {
              info.headerKeys = Object.keys(header)
              info.headerStrings = Object.fromEntries(
                Object.entries(header)
                  .filter(([, value]) => typeof value === 'string')
                  .map(([key, value]) => [key, value.length > 160 ? `${value.slice(0, 160)}…` : value])
              )
              info.headerNested = Object.fromEntries(
                Object.entries(header)
                  .filter(([, value]) => value && typeof value === 'object')
                  .map(([key, value]) => [key, Array.isArray(value) ? `array(${value.length})` : Object.keys(value).slice(0, 16)])
              )
            }
          }
        } catch (error) {
          info.sessionError = String(error?.message ?? error)
        }
        return ok(info)
      } catch (error) {
        return respond(error)
      }
    }
  })

  // 版本：客户端打开文件时取一次，保存时原样带回。
  ctx.connection.fetch.register({
    path: `${ROUTE_PREFIX}/stat`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const body = await readJson(request)
        const sessionId = String(body.sessionId ?? '')
        const located = await locateTarget(ctx, sessionId, body.path)
        const buffer = readFileSync(located.target)
        return ok({
          version: versionOf(buffer, located.stat.mtimeMs),
          bytes: buffer.byteLength,
          mtimeMs: located.stat.mtimeMs,
        })
      } catch (error) {
        return respond(error)
      }
    }
  })

  // 全文读取：编辑面、回滚与审阅文件都走这里；二进制只报类型，不回文本。
  ctx.connection.fetch.register({
    path: `${ROUTE_PREFIX}/fileText`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const body = await readJson(request)
        const sessionId = String(body.sessionId ?? '')
        const located = await locateTarget(ctx, sessionId, body.path)
        const bytes = located.stat.size
        if (bytes > MAX_READ_BYTES) {
          const buffer = readFileSync(located.target)
          return ok({
            oversized: true,
            bytes,
            version: versionOf(buffer, located.stat.mtimeMs),
            mtimeMs: located.stat.mtimeMs,
            absolutePath: located.target,
            binary: false,
          })
        }
        const buffer = readFileSync(located.target)
        const binary = isBinaryBuffer(buffer)
        const text = binary ? '' : buffer.toString('utf8')
        return ok({
          text,
          binary,
          bytes,
          lines: text === '' ? 0 : text.split('\n').length,
          version: versionOf(buffer, located.stat.mtimeMs),
          mtimeMs: located.stat.mtimeMs,
          absolutePath: located.target,
          oversized: false,
        })
      } catch (error) {
        return respond(error)
      }
    }
  })

  // 二进制预览：图片回 data URL，其余回前 256 字节的十六进制。
  ctx.connection.fetch.register({
    path: `${ROUTE_PREFIX}/raw`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const body = await readJson(request)
        const sessionId = String(body.sessionId ?? '')
        const located = await locateTarget(ctx, sessionId, body.path)
        if (located.stat.size > MAX_RAW_BYTES) {
          return fail(413, 'editor-file/too-large', `文件超过 ${Math.round(MAX_RAW_BYTES / 1024 / 1024)} MB，不做内嵌预览`)
        }
        const buffer = readFileSync(located.target)
        const mime = IMAGE_MIME.get(extname(located.target).toLowerCase())
        if (mime) {
          return ok({ kind: 'image', mime, bytes: buffer.byteLength, base64: buffer.toString('base64') })
        }
        const preview = buffer.subarray(0, Math.min(buffer.length, 256))
        return ok({ kind: 'binary', bytes: buffer.byteLength, hex: preview.toString('hex') })
      } catch (error) {
        return respond(error)
      }
    }
  })

  // 审阅队列：按轮次返回文件与 hunk；不读磁盘内容即可列出。
  ctx.connection.fetch.register({
    path: `${ROUTE_PREFIX}/review`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const body = await readJson(request)
        const sessionId = String(body.sessionId ?? '')
        const review = await buildReview(ctx, sessionId)
        return ok(review)
      } catch (error) {
        return respond(error)
      }
    }
  })

  // 唯一写入口：补丁式。
  ctx.connection.fetch.register({
    path: `${ROUTE_PREFIX}/applyPatch`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const startedAt = Date.now()
      let body
      try {
        body = await readJson(request)
      } catch (error) {
        return respond(error)
      }
      const sessionId = String(body.sessionId ?? '')
      const path = body.path
      const baseVersion = body.baseVersion
      const edits = Array.isArray(body.edits) ? body.edits : []
      const auditBase = { sessionId, path: typeof path === 'string' ? path : '', at: new Date().toISOString() }
      const key = `${sessionId}\u0000${typeof path === 'string' ? path : ''}`

      if (pendingWrites.has(key)) {
        audit({ ...auditBase, result: 'busy', reason: '同一文件正在写入', ms: Date.now() - startedAt })
        return fail(409, 'editor-file/busy', '这个文件正在写入，请等上一次写盘完成')
      }
      pendingWrites.add(key)

      try {
        if (edits.length === 0) {
          audit({ ...auditBase, result: 'bad-request', reason: 'edits 为空', ms: Date.now() - startedAt })
          return fail(400, 'editor-file/bad-request', '没有要写入的改动')
        }

        const located = await locateTarget(ctx, sessionId, path, { createIfMissing: body.createIfMissing === true })
        const { target, realParent } = located

        // 限流：同一会话同一路径的最小写间隔。
        const last = lastWriteAt.get(key) ?? 0
        if (Date.now() - last < WRITE_INTERVAL_MS) {
          audit({ ...auditBase, result: 'busy', ms: Date.now() - startedAt })
          return fail(429, 'editor-file/busy', '写入过于频繁，稍后重试')
        }

        const before = located.exists ? readFileSync(target) : Buffer.alloc(0)
        const beforeText = before.toString('utf8')
        const currentVersion = located.exists ? versionOf(before, located.stat.mtimeMs) : null
        if (currentVersion !== baseVersion) {
          audit({ ...auditBase, result: 'stale', ms: Date.now() - startedAt })
          return fail(409, 'editor-file/stale', '文件已被改动，内容已刷新', { version: currentVersion })
        }

        const next = applyPatchToText(beforeText, edits)
        const after = Buffer.from(next, 'utf8')
        if (after.byteLength > MAX_WRITE_BYTES) return fail(413, 'editor-file/too-large', '单次写入超过上限')

        // 原子写：同目录临时文件 → 落盘 → 改名；保留原权限位。
        const mode = located.exists ? located.stat.mode : undefined
        const temp = join(realParent, `.dsh-editor-${randomBytes(6).toString('hex')}.tmp`)
        try {
          writeFileSync(temp, after, mode !== undefined ? { mode } : undefined)
          if (mode !== undefined) {
            try {
              chmodSync(temp, mode)
            } catch {
              /* Windows 上权限位可能不适用 */
            }
          }
          const handle = openSync(temp, 'r+')
          try {
            fsyncSync(handle)
          } finally {
            closeSync(handle)
          }
          // 写入期间被替换：rename 前再确认一次基线没变，变了就放弃这次写。
          if (currentVersion === null) {
            if (existsSync(target)) {
              throw Object.assign(new Error('文件已被创建，内容已刷新'), {
                status: 409,
                code: 'editor-file/stale',
              })
            }
          } else {
            const latest = readFileSync(target)
            const latestVersion = versionOf(latest, statSync(target).mtimeMs)
            if (latestVersion !== currentVersion) {
              throw Object.assign(new Error('文件已被改动，内容已刷新'), {
                status: 409,
                code: 'editor-file/stale',
                version: latestVersion,
              })
            }
          }
          renameSync(temp, target)
        } catch (error) {
          try {
            if (existsSync(temp)) unlinkSync(temp)
          } catch {
            /* 清理失败不掩盖原错误 */
          }
          throw error
        }

        lastWriteAt.set(key, Date.now())
        const nextMtime = statSync(target).mtimeMs
        const version = versionOf(after, nextMtime)
        audit({ ...auditBase, result: 'ok', bytes: after.byteLength, ms: Date.now() - startedAt })
        return ok({ version, bytes: after.byteLength, mtimeMs: nextMtime })
      } catch (error) {
        audit({ ...auditBase, result: 'error', reason: String(error?.message ?? error), ms: Date.now() - startedAt })
        return respond(error)
      } finally {
        pendingWrites.delete(key)
      }
    }
  })
}

// 让测试可以引用纯函数而不启动插件。
export { buildReview, applyPatchToText }
