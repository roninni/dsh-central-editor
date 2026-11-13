/**
 * Monaco 宿主：一个编辑器实例 + 按路径唯一的一份 model。
 *
 * 本期不带语言服务 worker：Monaco 在需要 worker 时会尝试创建，这里给一个空实现，
 * 让它降级成「无智能提示但可编辑」，而不是抛异常把面板打挂。
 *
 * 主题不写死 vs-dark：从外壳的 `--dsw-*` 调色板生成一个 Monaco 主题，外壳
 * 切明暗时重新生成。审阅用的是另一条路：diff editor + 只读。
 */
import * as monaco from 'monaco-editor'
import { languageOf } from './language.js'

const WORKER_STUB = `self.onmessage = function () {}`
const THEME_ID = 'dsh-shell'

/**
 * Monaco 的样式由构建时内联成 window.__DCE_MONACO_CSS__，这里显式注入一次。
 * 不依赖打包器对 css import 的副作用——那条路在本项目里证明了不可靠
 * （没有语法配色、没有行号、隐藏输入框露出来，都是样式没生效的表现）。
 */
function ensureMonacoCss() {
  if (typeof document === 'undefined') return
  const styleId = 'monaco-editor/base.css'
  if (document.querySelector(`style[data-plugin-css="${styleId}"]`)) return
  const text = typeof window !== 'undefined' ? window.__DCE_MONACO_CSS__ : ''
  if (!text) return
  const tag = document.createElement('style')
  tag.dataset.pluginCss = styleId
  tag.textContent = text
  document.head.appendChild(tag)
}

function ensureWorkerStub() {
  const scope = typeof self !== 'undefined' ? self : undefined
  if (!scope) return
  if (scope.MonacoEnvironment) return
  scope.MonacoEnvironment = {
    getWorker() {
      const url = URL.createObjectURL(new Blob([WORKER_STUB], { type: 'text/javascript' }))
      const worker = new Worker(url)
      URL.revokeObjectURL(url)
      return worker
    },
  }
}

/** 当前页面里由 Monaco 创建的编辑器实例数（单实例验收用）。 */
export function editorCount() {
  return monaco.editor.getEditors().length
}

const FALLBACK_DARK = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  lineNumber: '#858585',
  cursor: '#aeafad',
  selection: '#264f78',
  inactiveSelection: '#3a3d41',
  added: '#2ea043',
  deleted: '#f85149',
}
const FALLBACK_LIGHT = {
  background: '#ffffff',
  foreground: '#1f2328',
  lineNumber: '#8c959f',
  cursor: '#0969da',
  selection: '#b6d7ff',
  inactiveSelection: '#dbe7f3',
  added: '#1a7f37',
  deleted: '#cf222e',
}

const TOKEN_VARS = {
  background: '--dsw-alias-bg-layer-1',
  foreground: '--dsw-alias-label-primary',
  lineNumber: '--dsw-alias-label-tertiary',
  cursor: '--dsw-alias-state-business-primary',
  selection: '--dsw-alias-interactive-bg-hover',
  added: '--dsw-alias-state-success-primary',
  deleted: '--dsw-alias-state-error-primary',
}

/**
 * 读取外壳调色板。别名变量本身是 `var(--static-…)` 链，直接 getPropertyValue
 * 拿到的是未展开的字符串；这里用一个离屏探针让浏览器把最终颜色算成 rgb。
 */
function probePalette(scope) {
  if (typeof document === 'undefined') return {}
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = 'position:absolute;left:-10000px;top:-10000px;width:0;height:0;overflow:hidden;pointer-events:none'
  const nodes = {}
  for (const [key, token] of Object.entries(TOKEN_VARS)) {
    const node = document.createElement('span')
    node.style.backgroundColor = `var(${token})`
    host.appendChild(node)
    nodes[key] = node
  }
  // 探针必须放在编辑器自己的子树里，才能读到面板上的主题覆盖；body 上读到的是外壳默认值。
  const mount = scope && scope.isConnected ? scope : document.body
  mount.appendChild(host)
  const result = {}
  for (const [key, node] of Object.entries(nodes)) result[key] = getComputedStyle(node).backgroundColor
  host.remove()
  return result
}

function parseColor(value) {
  if (typeof value !== 'string') return null
  const hex = value.trim()
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) {
    if (hex.length === 4) return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
    return hex.slice(0, 7)
  }
  const match = hex.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/i)
  if (!match) return null
  if (match[4] !== undefined && Number(match[4]) <= 0) return null
  const toHex = (part) => Math.max(0, Math.min(255, Math.round(Number(part)))).toString(16).padStart(2, '0')
  return `#${toHex(match[1])}${toHex(match[2])}${toHex(match[3])}`
}

function luminance(hex) {
  const value = parseColor(hex) || '#000000'
  const r = Number.parseInt(value.slice(1, 3), 16) / 255
  const g = Number.parseInt(value.slice(3, 5), 16) / 255
  const b = Number.parseInt(value.slice(5, 7), 16) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function withAlpha(value, alpha, fallback) {
  const hex = parseColor(value) || parseColor(fallback)
  if (!hex) return undefined
  const byte = Math.max(0, Math.min(255, Math.round(alpha * 255)))
  return `${hex}${byte.toString(16).padStart(2, '0')}`
}

function shellPalette(scope) {
  const vars = probePalette(scope)
  const rawBackground = vars.background
  const dark = rawBackground
    ? luminance(rawBackground) < 0.45
    : typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
  const fallback = dark ? FALLBACK_DARK : FALLBACK_LIGHT
  const pick = (key) => parseColor(vars[key]) || fallback[key]
  return {
    dark,
    background: pick('background'),
    foreground: pick('foreground'),
    lineNumber: pick('lineNumber'),
    cursor: pick('cursor'),
    selection: pick('selection'),
    added: pick('added'),
    deleted: pick('deleted'),
  }
}

function defineShellTheme(scope) {
  const palette = shellPalette(scope)
  const colors = {
    'editor.background': palette.background,
    'editor.foreground': palette.foreground,
    'editorLineNumber.foreground': palette.lineNumber,
    'editorLineNumber.activeForeground': palette.foreground,
    'editorCursor.foreground': palette.cursor,
    'editor.selectionBackground': withAlpha(palette.selection, 0.45, palette.selection),
    'editor.inactiveSelectionBackground': withAlpha(palette.selection, 0.2, palette.selection),
    'editorWidget.background': palette.background,
    'editorWidget.border': withAlpha(palette.lineNumber, 0.35, palette.lineNumber),
    'editorSuggestWidget.background': palette.background,
    'editorSuggestWidget.selectedBackground': withAlpha(palette.selection, 0.4, palette.selection),
    'editorGutter.background': palette.background,
    'editor.lineHighlightBackground': withAlpha(palette.lineNumber, 0.08, palette.lineNumber),
    'editor.findMatchBackground': withAlpha(palette.cursor, 0.3, palette.selection),
    'editor.findMatchHighlightBackground': withAlpha(palette.cursor, 0.16, palette.selection),
    'diffEditor.insertedTextBackground': withAlpha(palette.added, 0.18, palette.added),
    'diffEditor.removedTextBackground': withAlpha(palette.deleted, 0.18, palette.deleted),
    'diffEditor.insertedLineBackground': withAlpha(palette.added, 0.08, palette.added),
    'diffEditor.removedLineBackground': withAlpha(palette.deleted, 0.08, palette.deleted),
    'diffEditor.diagonalFill': withAlpha(palette.lineNumber, 0.12, palette.lineNumber),
    'scrollbarSlider.background': withAlpha(palette.lineNumber, 0.2, palette.lineNumber),
    'scrollbarSlider.hoverBackground': withAlpha(palette.lineNumber, 0.3, palette.lineNumber),
    'scrollbarSlider.activeBackground': withAlpha(palette.lineNumber, 0.4, palette.lineNumber),
  }
  // Monaco 对非法颜色会整条定义失败，退回默认浅色；只把合法值交出去。
  for (const key of Object.keys(colors)) {
    if (typeof colors[key] !== 'string' || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(colors[key])) delete colors[key]
  }
  monaco.editor.defineTheme(THEME_ID, {
    base: palette.dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors,
  })
  monaco.editor.setTheme(THEME_ID)
  return palette
}

let themeWatcher = null
let themeScope = null

function ensureThemeWatcher(scope) {
  if (scope) themeScope = scope
  if (themeWatcher || typeof document === 'undefined') return
  const apply = () => {
    try {
      defineShellTheme(themeScope)
    } catch {
      /* 主题失败不阻塞编辑 */
    }
  }
  apply()
  const observer = new MutationObserver(apply)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
  media?.addEventListener?.('change', apply)
  themeWatcher = { observer, media, apply }
}

/** 面板切换明暗后重读自己的 token 覆盖；scope 是编辑器容器。 */
export function refreshShellTheme(scope) {
  if (scope) themeScope = scope
  if (themeWatcher) themeWatcher.apply()
  else ensureThemeWatcher(themeScope)
}

function safeLanguage(id) {
  try {
    return monaco.languages.getLanguages().some((language) => language.id === id) ? id : 'plaintext'
  } catch {
    return 'plaintext'
  }
}

function lineRange(line, column) {
  return new monaco.Range(line, Math.max(1, column), line, Math.max(1, column))
}

export function createMonacoHost(container, options = {}) {
  ensureWorkerStub()
  ensureMonacoCss()
  ensureThemeWatcher(container)
  // 宿主给业务面板的高度在有的布局下会塌成 0，Monaco 在 0 高度里排版会把内容
  // 画到容器外。这里先兜一个可见高度，等 ResizeObserver 拿到真实尺寸再改。
  if (container.clientHeight < 40) {
    const viewport = typeof window !== 'undefined' ? window.innerHeight : 800
    container.style.height = `${Math.max(240, Math.floor(viewport * 0.62))}px`
  }
  const models = new Map()
  let currentPath = null
  let highlight = null
  const view = monaco.editor.create(container, {
    theme: THEME_ID,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 12,
    tabSize: 4,
    renderWhitespace: 'selection',
    wordWrap: 'off',
    readOnly: options.readOnly === true,
  })

  // 容器刚出现时高度可能是 0；先量一次，再订阅尺寸变化并重新布局，
  // 否则 Monaco 会把内容画到容器外面。
  const relayout = () => {
    try {
      view.layout({ width: container.clientWidth, height: container.clientHeight })
    } catch {
      /* 布局失败不影响编辑 */
    }
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(relayout)
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(relayout) : null
  if (observer) observer.observe(container)

  // Monaco 接管键盘后，宿主与面板都收不到 Ctrl+S；在编辑器里注册一条保存命令。
  if (typeof options.onSave === 'function') {
    view.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      options.onSave()
    })
  }

  function modelFor(path, text) {
    const cached = models.get(path)
    if (cached) return cached
    const uri = monaco.Uri.parse(`inmemory://central-editor/${encodeURI(path)}`)
    const model = monaco.editor.createModel(text, safeLanguage(languageOf(path)), uri)
    models.set(path, model)
    return model
  }

  return {
    show(path, text) {
      const model = modelFor(path, text)
      if (view.getModel() !== model) view.setModel(model)
      currentPath = path
    },
    setText(path, text) {
      const model = models.get(path)
      if (model && model.getValue() !== text) model.setValue(text)
    },
    getText(path) {
      const model = models.get(path)
      return model ? model.getValue() : ''
    },
    modelCount() {
      return models.size
    },
    currentPath() {
      return currentPath
    },
    reveal(path, line = 1, column = 1) {
      const target = path === currentPath ? view.getModel() : models.get(path)
      if (!target) return false
      if (view.getModel() !== target) view.setModel(target)
      currentPath = path
      const safeLine = Math.max(1, Math.min(Number(line) || 1, target.getLineCount()))
      view.revealLineInCenter(safeLine)
      view.setPosition({ lineNumber: safeLine, column: Math.max(1, Number(column) || 1) })
      view.focus()
      try {
        highlight?.clear?.()
        highlight = view.createDecorationsCollection([
          { range: lineRange(safeLine, 1), options: { isWholeLine: true, className: 'dce_line_highlight' } },
        ])
        setTimeout(() => {
          try {
            highlight?.clear?.()
          } catch {
            /* 忽略 */
          }
        }, 1800)
      } catch {
        /* 高亮失败不影响跳转 */
      }
      return true
    },
    getSelection() {
      const selection = view.getSelection()
      const model = view.getModel()
      if (!selection || !model || selection.isEmpty()) return null
      return {
        text: model.getValueInRange(selection),
        startLine: selection.startLineNumber,
        startColumn: selection.startColumn,
        endLine: selection.endLineNumber,
        endColumn: selection.endColumn,
      }
    },
    getViewState() {
      const position = view.getPosition()
      const model = view.getModel()
      return {
        path: currentPath,
        line: position?.lineNumber ?? 1,
        column: position?.column ?? 1,
        scrollTop: view.getScrollTop(),
        scrollLeft: view.getScrollLeft(),
        modelLines: model?.getLineCount() ?? 0,
      }
    },
    restoreView(path, state) {
      if (!state || path !== currentPath) return
      try {
        if (Number.isFinite(state.scrollTop)) view.setScrollTop(state.scrollTop)
        if (Number.isFinite(state.scrollLeft)) view.setScrollLeft(state.scrollLeft)
        const model = view.getModel()
        if (model && Number.isFinite(state.line)) {
          const line = Math.max(1, Math.min(state.line, model.getLineCount()))
          view.setPosition({ lineNumber: line, column: Math.max(1, state.column || 1) })
        }
      } catch {
        /* 恢复失败不影响编辑 */
      }
    },
    setReadOnly(value) {
      view.updateOptions({ readOnly: value === true })
    },
    focus() {
      view.focus()
    },
    setTheme(theme) {
      monaco.editor.setTheme(theme)
    },
    onChange(handler) {
      return view.onDidChangeModelContent(() => handler())
    },
    onStateChange(handler) {
      const cursor = view.onDidChangeCursorPosition(() => handler())
      const scroll = view.onDidScrollChange(() => handler())
      return {
        dispose() {
          cursor.dispose()
          scroll.dispose()
        },
      }
    },
    clear() {
      currentPath = null
      highlight?.clear?.()
      highlight = null
      view.setModel(null)
      for (const model of models.values()) model.dispose()
      models.clear()
    },
    disposeModel(path) {
      const model = models.get(path)
      if (!model) return
      models.delete(path)
      model.dispose()
    },
    dispose() {
      if (observer) observer.disconnect()
      highlight?.clear?.()
      for (const model of models.values()) model.dispose()
      models.clear()
      view.dispose()
    },
  }
}

/**
 * 审阅用 diff editor：左右两侧都是只读 model。
 * 一个实例可以反复 `show()`，切换 hunk 时只换 model。
 */
export function createDiffHost(container, options = {}) {
  ensureMonacoCss()
  ensureThemeWatcher(container)
  const editor = monaco.editor.createDiffEditor(container, {
    theme: THEME_ID,
    automaticLayout: true,
    readOnly: true,
    originalEditable: false,
    renderSideBySide: options.renderSideBySide !== false,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 12,
    renderOverviewRuler: false,
    enableSplitViewResizing: true,
  })
  let original = null
  let modified = null
  return {
    show({ oldText, newText, path }) {
      const language = safeLanguage(languageOf(path || 'plain.txt'))
      if (original) original.dispose()
      if (modified) modified.dispose()
      original = monaco.editor.createModel(oldText || '', language)
      modified = monaco.editor.createModel(newText || '', language)
      editor.setModel({ original, modified })
    },
    dispose() {
      try {
        editor.setModel(null)
      } catch {
        /* 忽略 */
      }
      original?.dispose()
      modified?.dispose()
      original = null
      modified = null
      editor.dispose()
    },
  }
}
