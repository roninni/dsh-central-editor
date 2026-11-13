/**
 * 审阅数据的纯函数：路径归一、hunk 文本与计数。
 *
 * 这里不碰文件系统、不碰会话对象——单测直接跑。服务端把「从事件里取到的
 * 原始差异」交给这些函数，得到 UI 能直接渲染的 hunk。
 */
import { isAbsolute, relative, sep } from 'node:path'

/**
 * 把 diff 里的路径归一成「工作区相对路径、斜杠分隔」。
 * @param {string} root - 工作区根（绝对路径）
 * @param {string} value - diff 里的路径，可能是绝对或相对
 * @returns {string|null} 相对路径；越出工作区时返回 null
 */
export function normalizeWorkspacePath(root, value) {
  if (typeof value !== 'string' || value.length === 0) return null
  const absolute = isAbsolute(value) ? value : `${root}${sep}${value}`
  const rel = relative(root, absolute)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

/**
 * 算一个连续 hunk 的 +/− 行数。
 *
 * 工具产出的 diff 每个 hunk 只含一段连续改动加三行上下文，所以去掉公共
 * 前缀/后缀后，中间剩下的就是纯增/纯删；不需要完整 diff 算法。
 * @param {string|null|undefined} oldText
 * @param {string|null|undefined} newText
 * @returns {{added: number, deleted: number}}
 */
export function countHunkLines(oldText, newText) {
  const before = splitLines(oldText)
  const after = splitLines(newText)
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }
  return {
    added: after.length - prefix - suffix,
    deleted: before.length - prefix - suffix,
  }
}

function splitLines(text) {
  if (typeof text !== 'string' || text === '') return []
  // 末尾换行是终止符，不是多出来的一行；hunk 文本由行 join('\n') 得到，通常没有它。
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body === '' ? [] : body.split('\n')
}

/**
 * 由 `oldText` / `newText` 造一个 hunk；`oldText` 为 null 表示纯插入。
 * @param {{oldText: string|null, newText: string, index: number, id: string, turn: number, path: string, header?: string}} input
 */
export function hunkFromText(input) {
  const oldText = typeof input.oldText === 'string' ? input.oldText : ''
  const newText = typeof input.newText === 'string' ? input.newText : ''
  const { added, deleted } = countHunkLines(oldText, newText)
  return {
    id: input.id,
    index: input.index,
    turn: input.turn,
    path: input.path,
    oldText,
    newText,
    added,
    deleted,
    ...(input.header ? { header: input.header } : {}),
    ...(input.oldText === null ? { pureInsertion: true } : {}),
  }
}

/**
 * 由 unified diff 的一个 hunk 造出 `oldText` / `newText`。
 * workspace/changes 的 `diff` 返回的就是这种 `lines`（含 −/+/空格前缀）。
 * @param {{oldStart:number, oldLines:number, newStart:number, newLines:number, lines:string[]}} hunk
 * @param {{index:number, id:string, turn:number, path:string}} meta
 */
export function hunkFromPatchLines(hunk, meta) {
  const oldLines = []
  const newLines = []
  let added = 0
  let deleted = 0
  for (const line of Array.isArray(hunk?.lines) ? hunk.lines : []) {
    const tag = line[0]
    const text = line.slice(1)
    if (tag === '-') {
      oldLines.push(text)
      deleted += 1
    } else if (tag === '+') {
      newLines.push(text)
      added += 1
    } else if (tag === ' ' || tag === '') {
      oldLines.push(text)
      newLines.push(text)
    }
  }
  return {
    id: meta.id,
    index: meta.index,
    turn: meta.turn,
    path: meta.path,
    oldStart: Number(hunk?.oldStart) || 0,
    oldLines: Number(hunk?.oldLines) || 0,
    newStart: Number(hunk?.newStart) || 0,
    newLines: Number(hunk?.newLines) || 0,
    header: `@@ -${Number(hunk?.oldStart) || 0},${Number(hunk?.oldLines) || 0} +${Number(hunk?.newStart) || 0},${Number(hunk?.newLines) || 0} @@`,
    oldText: oldLines.join('\n'),
    newText: newLines.join('\n'),
    added,
    deleted,
  }
}
