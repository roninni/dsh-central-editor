import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'

// Exercise the real panel at its React/transport boundary, without loading Monaco.
function panelHarness({ width = 1200, saved = {} } = {}) {
  const slots = [], effects = [], requests = [], writes = [], storage = new Map(Object.entries(saved))
  let cursor = 0, changed = true, tree, subscription, session = 'A'
  const media = { matches: width <= 640, addEventListener() {}, removeEventListener() {} }
  // useLayoutEffect 在真实 React 里先于绘制跑；这里没有绘制，和 useEffect 同样处理即可。
  function effectSlot(fn, deps) {
    const i = cursor++
    const old = slots[i]
    if (!old || !deps || deps.some((v, j) => v !== old.deps[j])) {
      slots[i] = { deps, cleanup: old?.cleanup }
      effects.push(() => { old?.cleanup?.(); slots[i].cleanup = fn() })
    }
  }
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity) } },
    Fragment: 'fragment',
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; changed = true }] },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial } },
    useCallback(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((v, j) => v !== slots[i].deps[j])) slots[i] = { fn, deps }; return slots[i].fn },
    useEffect: effectSlot,
    useLayoutEffect: effectSlot,
  }
  const context = vm.createContext({ React, ReactDOM: { createPortal() {} }, console,
    window: { matchMedia: () => media, addEventListener() {}, removeEventListener() {}, confirm: () => { context.confirmCount++; return context.confirmResult } },
    matchMedia: () => media, confirmCount: 0, confirmResult: false,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    languageOf: () => 'plaintext', parseFileLinkLoose: () => null,
    loadSessionState: id => saved[id] || null,
    saveSessionState: (id, state) => writes.push({ id, state: structuredClone(state) }),
    fetch: (url, options) => new Promise(resolve => requests.push({ url, body: JSON.parse(options.body), resolve: value => resolve({ ok: true, json: async () => ({ value }) }) })),
  })
  let source = fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  source = source.replace(/^import .*$/gm, '').replace(/^export \{.*\}$/gm, '').replace(/^export default /gm, '').replace(/^export (?=(const|let|function|class|async))/gm, '')
  vm.runInContext(source + '\n globalThis.Panel = EditorPanel; globalThis.Surface = EditorSurface; globalThis.Review = ReviewPanel;', context)
  const service = { currentSession: () => session, subscribe(fn) { subscription = fn; return () => {} }, openSession(id) { session = id; subscription?.() } }
  function flush() { let count = 0; do { changed = false; cursor = 0; tree = context.Panel({ service, entry: {} }); while (effects.length) effects.shift()(); if (++count > 30) throw new Error('render loop') } while (changed); return tree }
  function nodes(node = tree) { return node && typeof node === 'object' ? [node, ...node.children.flatMap(nodes)] : [] }
  async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); flush() }
  flush()
  return { context, requests, writes, flush, settle, nodes,
    switch(id) { session = id; subscription(); flush() },
    button(label) { const node = nodes().find(n => n.type === 'button' && n.children.includes(label)); assert.ok(node, `missing button ${label}`); return node },
    surface() { return nodes().find(n => n.type === context.Surface) },
  }
}
const text = value => ({ text: value, binary: false, bytes: value.length, version: 'v1' })

test('late A open cannot populate B tabs or active file (including A → B → A)', async () => {
  const h = panelHarness({ saved: { A: { openFiles: ['a.txt'], activePath: 'a.txt' }, B: { openFiles: ['b.txt'], activePath: 'b.txt' } } })
  const a = h.requests.find(r => r.body.sessionId === 'A')
  h.switch('B')
  const b = h.requests.find(r => r.body.sessionId === 'B')
  a.resolve(text('A secret'))
  await h.settle()
  assert.equal(h.surface(), undefined)
  b.resolve(text('B only'))
  await h.settle()
  assert.equal(h.surface().props.file.original, 'B only')
  assert.equal(h.nodes().some(n => n.type === 'button' && n.props.title === 'a.txt'), false)
  h.switch('A')
  assert.equal(h.requests.filter(r => r.body.sessionId === 'A').length, 2)
})

test('narrow restored text renders read-only without mounting EditorSurface or save action', async () => {
  const h = panelHarness({ width: 390, saved: { A: { openFiles: ['a.txt'], activePath: 'a.txt' } } })
  h.requests[0].resolve(text('read only'))
  await h.settle()
  assert.equal(h.surface(), undefined)
  assert.ok(h.nodes().some(n => n.type === 'pre' && n.children.includes('read only')))
  assert.equal(h.nodes().some(n => n.type === 'button' && n.children.includes('保存')), false)
})

test('binary file routes to BinaryPreview, never EditorSurface', async () => {
  const h = panelHarness({ saved: { A: { openFiles: ['photo.png'], activePath: 'photo.png' } } })
  h.requests[0].resolve({ binary: true, bytes: 24, version: 'v1' })
  await h.settle()
  assert.equal(h.surface(), undefined)
  assert.ok(h.nodes().some(n => typeof n.type === 'function' && n.type.name === 'BinaryPreview'))
})

test('dirty inactive tab prompts before switching, cancellation retains A', async () => {
  const h = panelHarness({ saved: { A: { openFiles: ['a.txt', 'clean.txt'], activePath: 'a.txt' } } })
  h.requests[0].resolve(text('disk'))
  await h.settle()
  const host = { getText: () => 'UNSAVED', clear() { throw new Error('must not clear on cancel') }, getViewState: () => ({ path: 'a.txt', line: 1 }) }
  h.surface().props.hostRef.current = host
  h.switch('B')
  assert.equal(h.context.confirmCount, 1)
  assert.equal(h.surface().props.file.path, 'a.txt')
  assert.equal(h.requests.some(r => r.body.sessionId === 'B'), false)
})
