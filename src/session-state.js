/**
 * 按 Session 保存/恢复面板状态（标签、激活项、光标与滚动）。
 *
 * 存 localStorage 而不是宿主存储：这里只是「这个面板上次看到哪」，丢了也
 * 不影响磁盘内容；键按 sessionId 隔离，换对话不会串。
 */
const PREFIX = 'dce.session.v1.'
const MAX_FILES = 80

export function stateKey(sessionId) {
  return `${PREFIX}${sessionId}`
}

export function loadSessionState(sessionId) {
  if (!sessionId || typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(stateKey(sessionId))
    if (!raw) return null
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    return {
      openFiles: Array.isArray(value.openFiles) ? value.openFiles.filter((item) => typeof item === 'string').slice(0, MAX_FILES) : [],
      activePath: typeof value.activePath === 'string' ? value.activePath : null,
      dir: typeof value.dir === 'string' ? value.dir : '',
      positions: value.positions && typeof value.positions === 'object' ? value.positions : {},
    }
  } catch {
    return null
  }
}

export function saveSessionState(sessionId, state) {
  if (!sessionId || typeof localStorage === 'undefined') return
  try {
    const positions = {}
    for (const path of state.openFiles ?? []) {
      const entry = state.positions?.[path]
      if (!entry) continue
      positions[path] = {
        line: Number(entry.line) || 1,
        column: Number(entry.column) || 1,
        scrollTop: Number(entry.scrollTop) || 0,
        scrollLeft: Number(entry.scrollLeft) || 0,
      }
    }
    localStorage.setItem(
      stateKey(sessionId),
      JSON.stringify({
        openFiles: (state.openFiles ?? []).slice(0, MAX_FILES),
        activePath: state.activePath ?? null,
        dir: state.dir ?? '',
        positions,
        savedAt: Date.now(),
      })
    )
  } catch {
    /* 存不下不影响编辑 */
  }
}

export function clearSessionState(sessionId) {
  if (!sessionId || typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(stateKey(sessionId))
  } catch {
    /* 忽略 */
  }
}
