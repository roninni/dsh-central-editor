/**
 * 客户端打包（rollup，纯 JS、同进程，不需要子进程）。
 *
 * DSH 的客户端插件只接受已构建的产物，入口必须是
 *   window.__ModuleLoader__.load({ id, factory(require) { … return module.exports } })
 * 的形状。这里把 ESM 源码打成 CJS，再套上这层壳；React 保持 external，由宿主的
 * require 提供（共享基线）。
 *
 * 内核按需加载：Monaco 打到独立 chunk（`lib/client.monaco.js`），壳里带 `chunk`
 * 字段注册成包内分块；入口用 `require.async("./client.monaco.js")` 在首次打开
 * 编辑器时再取。宿主只接受 `client.<name>.js` 这种名字（见 dsh-client-modules
 * 的 CLIENT_CHUNK），所以文件名不能随意起。
 *
 * Monaco 的样式仍在构建时读成字符串，放进 chunk 的 prelude，运行时由
 * monaco-host 显式注入一次。
 *
 * 用法：node build.mjs <entry> <outfile> <moduleId> [chunkName] [--css]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { rollup } from 'rollup'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import css from 'rollup-plugin-import-css'

const here = dirname(fileURLToPath(import.meta.url))

export async function bundleClient(entry, outfile, moduleId, options = {}) {
  const { chunk = null } = options
  const bundle = await rollup({
    input: resolve(here, entry),
    // browser: false —— Monaco 的 browser 字段会把 esm 路径再套一层，关掉它。
    plugins: [css({ minify: true }), nodeResolve({ browser: false, preferBuiltins: false })],
    external: ['react', 'react-dom'],
    onwarn(warning, warn) {
      if (warning.code === 'CIRCULAR_DEPENDENCY') return
      if (warning.code === 'THIS_IS_UNDEFINED') return
      warn(warning)
    },
  })
  const { output } = await bundle.generate({ format: 'cjs', exports: 'named', inlineDynamicImports: true })
  await bundle.close()
  const body = output[0].code
  // 入口不带 Monaco 样式；只有内核 chunk 才需要它。
  const cssText = options.monacoCss
    ? await readFile(resolve(here, 'node_modules/monaco-editor/min/vs/editor/editor.main.css'), 'utf8').catch(() => '')
    : ''
  const prelude = cssText ? `window.__DCE_MONACO_CSS__ = ${JSON.stringify(cssText)};\n` : ''
  const registration = chunk
    ? `{ id: ${JSON.stringify(moduleId)}, chunk: ${JSON.stringify(chunk)}, factory(require) {`
    : `{ id: ${JSON.stringify(moduleId)}, factory(require) {`
  const wrapped =
    `window.__ModuleLoader__.load(${registration}\n` +
    `var module = { exports: {} };\nvar exports = module.exports;\n` +
    `${prelude}${body}\nreturn module.exports;\n} });\n`
  const target = resolve(here, outfile)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, wrapped)
  const raw = Buffer.byteLength(wrapped)
  const gzip = gzipSync(wrapped).byteLength
  return { bytes: raw, gzip }
}

const args = process.argv.slice(2)
const flags = new Set(args.filter((arg) => arg.startsWith('--')))
const [entry, outfile, moduleId, chunkName] = args.filter((arg) => !arg.startsWith('--'))
if (entry && outfile && moduleId) {
  const result = await bundleClient(entry, outfile, moduleId, {
    chunk: chunkName || null,
    monacoCss: flags.has('--css'),
  })
  const kind = chunkName ? `chunk ${chunkName}` : 'entry'
  console.log(
    `bundled ${entry} -> ${outfile} (${kind}, ${(result.bytes / 1024).toFixed(1)} KB raw / ${(result.gzip / 1024).toFixed(1)} KB gzip)`
  )
}
