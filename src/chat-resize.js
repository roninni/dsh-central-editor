/**
 * 对话抽屉宽度的纯计算。
 *
 * 抽屉贴在工作台面板右边、靠拖左边缘改宽，所以指针给出的原始值是
 * 「面板右边缘 − 指针 x」。这里只负责把原始值夹进合法区间：
 * 不小于 CHAT_MIN_WIDTH，且至少给左侧文件树/编辑区留 RESERVE_WIDTH，
 * 免得抽屉拉满之后再也找不到那条拖拽条。
 */
export const CHAT_MIN_WIDTH = 240
export const CHAT_RESERVE_WIDTH = 40

export function clampChatWidth(raw, boxWidth, { min = CHAT_MIN_WIDTH, reserve = CHAT_RESERVE_WIDTH } = {}) {
  const value = Number(raw)
  if (!Number.isFinite(value)) return min
  if (!Number.isFinite(boxWidth) || boxWidth <= 0) return Math.max(min, Math.round(value))
  const max = Math.max(min, Math.round(boxWidth - reserve))
  return Math.round(Math.min(Math.max(value, min), max))
}
