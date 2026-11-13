/**
 * Monaco 打包探针：验证 rollup 能把 monaco-editor 的 ESM 打进单文件，
 * 并量出实际体积。上一版是 CM6 的同款探针，结论写进 ADR-0013。
 */
import * as monaco from 'monaco-editor'

export function probe() {
  // 只做类型/形状判断，不在 Node 里建编辑器（没有 DOM）。
  return typeof monaco.editor?.create === 'function' && typeof monaco.editor?.createDiffEditor === 'function'
}
