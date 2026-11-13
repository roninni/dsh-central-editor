/**
 * 打包管线探针：只验证「esbuild-wasm 能在本进程内解析并打包 CM6」。
 * 等这条通了，再把 lib/client.js 换成构建产物。
 */
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'

export function probe() {
  return [EditorState, EditorView, keymap, defaultKeymap, javascript].every((value) => value !== undefined)
}
