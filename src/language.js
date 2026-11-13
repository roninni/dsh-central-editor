/**
 * 扩展名 → Monaco language id。
 *
 * 单独成模块：入口要用它显示语言名，内核 chunk 也要用它建 model。
 * 如果留在 monaco-host 里，入口为了这一行映射就得把 Monaco 一起静态拉进来，
 * 按需加载就失效了。
 */

const LANGUAGE_BY_EXT = {
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  go: 'go',
  html: 'html',
  java: 'java',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  md: 'markdown',
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'shell',
  sql: 'sql',
  ts: 'typescript',
  tsx: 'typescript',
  txt: 'plaintext',
  vue: 'html',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
}

export function languageOf(path) {
  const at = path.lastIndexOf('.')
  if (at === -1) return 'plaintext'
  const ext = path.slice(at + 1).toLowerCase()
  return LANGUAGE_BY_EXT[ext] ?? 'plaintext'
}
