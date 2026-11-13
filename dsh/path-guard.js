/**
 * 写通道的纯函数部分：路径形态守卫、包含判定、根字段挑选。
 *
 * 抽出来的唯一理由是可单测——这些规则是安全边界，不能靠"跑一遍看起来没问题"。
 * 它们不碰文件系统，也不读任何宿主服务。
 */
import { isAbsolute, relative } from 'node:path'

/** 宿主在不同版本里用过的根字段名，按优先级挑第一个非空字符串。 */
export const ROOT_KEYS = ['workspaceRoot', 'root', 'cwd', 'folder', 'directory', 'dir', 'path']

export function pickRoot(source, prefix) {
  if (!source || typeof source !== 'object') return undefined
  for (const key of ROOT_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value) return { root: value, via: `${prefix}.${key}` }
  }
  return undefined
}

/**
 * 路径形态检查。返回拒绝原因（字符串），通过则返回 undefined。
 *
 * 这里只做"形态"判断：不碰磁盘、不解析真实路径。父目录 realpath 与目标 lstat
 * 在写通道里另做（那两步依赖宿主，不能纯函数化）。
 */
export function rejectPathShape(path) {
  if (typeof path !== 'string' || path.trim() === '') return '路径为空'
  if (path.includes('\u0000')) return '路径含 NUL'
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(path)) return '不接受 URL 形式的路径'
  if (path.startsWith('\\\\')) return '不接受 UNC 路径'
  if (isAbsolute(path)) return '路径必须是工作区相对路径'
  for (const segment of path.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return '路径不能越出工作区'
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(segment)) return 'Windows 保留设备名'
    if (/[ .]$/.test(segment)) return '路径片段不能以空格或点结尾'
    if (segment.includes(':')) return '不接受备用数据流（ADS）'
  }
  return undefined
}

/** target 是否在 root 之内（含 root 本身）；跨根、越界一律 false。 */
export function isInside(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
