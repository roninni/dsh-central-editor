/**
 * 从对话里的链接/文本解析「文件 + 行」。
 *
 * 三种常见写法：
 *   a.ts:10
 *   a.ts:10:4
 *   ./a.ts#L10    （也接受 #L10-L20）
 *
 * 只接受工作区相对路径；绝对路径、URL、带 `..` 的路径一律不接，避免把对话
 * 里的任意字符串变成读盘请求。
 */

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i

function clean(value) {
  return value
    .trim()
    .replace(/^[("'`[（【\s]+/, '')
    .replace(/[)"'`\],.;。；，）】\s]+$/, '')
    .replace(/^\.\//, '')
    .replace(/\\/g, '/')
}

function normalize(rawPath, line, column, endLine) {
  const path = clean(rawPath)
  if (!path) return null
  if (path.startsWith('/') || /^[a-z]:/i.test(path)) return null
  if (path.split('/').some((segment) => segment === '..' || segment === '')) return null
  if (!/[\\/]/.test(path) && !/\.[a-z0-9]+$/i.test(path)) return null
  return {
    path,
    line: Math.max(1, Number(line) || 1),
    column: Math.max(1, Number(column) || 1),
    ...(Number(endLine) > 0 ? { endLine: Math.max(Number(line) || 1, Number(endLine)) } : {}),
  }
}

/**
 * @param {string} input - 链接 href、链接文字或一段包含路径的文字
 * @returns {{path:string,line:number,column:number,endLine?:number}|null}
 */
export function parseFileLink(input) {
  if (typeof input !== 'string') return null
  let value = input.trim()
  if (!value || URL_LIKE.test(value)) return null
  try {
    value = decodeURIComponent(value)
  } catch {
    /* 非法编码按原文处理 */
  }
  value = clean(value)
  if (!value || URL_LIKE.test(value)) return null

  // #L10 / #L10-L20
  let match = value.match(/^(.+?)#L(\d+)(?:-L?(\d+))?$/)
  if (match) return normalize(match[1], Number(match[2]), 1, Number(match[3]) || 0)

  // :10 / :10:4
  match = value.match(/^(.+?):(\d+)(?::(\d+))?$/)
  if (match) return normalize(match[1], Number(match[2]), Number(match[3]) || 1)

  // 纯路径：默认第 1 行
  return normalize(value, 1, 1)
}

/**
 * 宿主文件卡片会把图标/附件前缀和文件名放在同一段文字里：先按整串解析，
 * 失败再从串里抠一个「文件名.扩展名[:行]」令牌。URL 不抠，避免把链接尾部当路径。
 */
export function parseFileLinkLoose(input) {
  const text = String(input ?? '').trim()
  if (!text || text.includes('://')) return null
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith('/')) return null
  const direct = parseFileLink(text)
  const match = text.match(/[A-Za-z0-9_./\\\u4e00-\u9fa5-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?/)
  const extracted = match ? parseFileLink(match[0]) : null
  if (!extracted) return direct
  // 整串解析出来带了图标/附件前缀（路径不同）时，以抠出来的文件名为准；
  // 路径相同则保留整串解析的结果（它可能带着 #L 行号）。
  if (direct && direct.path === extracted.path) return direct
  return extracted
}
