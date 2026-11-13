window.__ModuleLoader__.load({ id: "dsh-central-editor", factory(require) {
var module = { exports: {} };
var exports = module.exports;
'use strict';

var React = require('react');
var ReactDOM = require('react-dom');

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

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

function clean(value) {
  return value
    .trim()
    .replace(/^[("'`[（【\s]+/, '')
    .replace(/[)"'`\],.;。；，）】\s]+$/, '')
    .replace(/^\.\//, '')
    .replace(/\\/g, '/')
}

function normalize(rawPath, line, column, endLine) {
  const path = clean(rawPath);
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
function parseFileLink(input) {
  if (typeof input !== 'string') return null
  let value = input.trim();
  if (!value || URL_LIKE.test(value)) return null
  try {
    value = decodeURIComponent(value);
  } catch {
    /* 非法编码按原文处理 */
  }
  value = clean(value);
  if (!value || URL_LIKE.test(value)) return null

  // #L10 / #L10-L20
  let match = value.match(/^(.+?)#L(\d+)(?:-L?(\d+))?$/);
  if (match) return normalize(match[1], Number(match[2]), 1, Number(match[3]) || 0)

  // :10 / :10:4
  match = value.match(/^(.+?):(\d+)(?::(\d+))?$/);
  if (match) return normalize(match[1], Number(match[2]), Number(match[3]) || 1)

  // 纯路径：默认第 1 行
  return normalize(value, 1, 1)
}

/**
 * 宿主文件卡片会把图标/附件前缀和文件名放在同一段文字里：先按整串解析，
 * 失败再从串里抠一个「文件名.扩展名[:行]」令牌。URL 不抠，避免把链接尾部当路径。
 */
function parseFileLinkLoose(input) {
  const text = String(input ?? '').trim();
  if (!text || text.includes('://')) return null
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith('/')) return null
  const direct = parseFileLink(text);
  const match = text.match(/[A-Za-z0-9_./\\\u4e00-\u9fa5-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?/);
  const extracted = match ? parseFileLink(match[0]) : null;
  if (!extracted) return direct
  // 整串解析出来带了图标/附件前缀（路径不同）时，以抠出来的文件名为准；
  // 路径相同则保留整串解析的结果（它可能带着 #L 行号）。
  if (direct && direct.path === extracted.path) return direct
  return extracted
}

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
};

function languageOf(path) {
  const at = path.lastIndexOf('.');
  if (at === -1) return 'plaintext'
  const ext = path.slice(at + 1).toLowerCase();
  return LANGUAGE_BY_EXT[ext] ?? 'plaintext'
}

/**
 * 按 Session 保存/恢复面板状态（标签、激活项、光标与滚动）。
 *
 * 存 localStorage 而不是宿主存储：这里只是「这个面板上次看到哪」，丢了也
 * 不影响磁盘内容；键按 sessionId 隔离，换对话不会串。
 */
const PREFIX = 'dce.session.v1.';
const MAX_FILES = 80;

function stateKey(sessionId) {
  return `${PREFIX}${sessionId}`
}

function loadSessionState(sessionId) {
  if (!sessionId || typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(stateKey(sessionId));
    if (!raw) return null
    const value = JSON.parse(raw);
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

function saveSessionState(sessionId, state) {
  if (!sessionId || typeof localStorage === 'undefined') return
  try {
    const positions = {};
    for (const path of state.openFiles ?? []) {
      const entry = state.positions?.[path];
      if (!entry) continue
      positions[path] = {
        line: Number(entry.line) || 1,
        column: Number(entry.column) || 1,
        scrollTop: Number(entry.scrollTop) || 0,
        scrollLeft: Number(entry.scrollLeft) || 0,
      };
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
    );
  } catch {
    /* 存不下不影响编辑 */
  }
}

/**
 * 对话抽屉宽度的纯计算。
 *
 * 抽屉贴在工作台面板右边、靠拖左边缘改宽，所以指针给出的原始值是
 * 「面板右边缘 − 指针 x」。这里只负责把原始值夹进合法区间：
 * 不小于 CHAT_MIN_WIDTH，且至少给左侧文件树/编辑区留 RESERVE_WIDTH，
 * 免得抽屉拉满之后再也找不到那条拖拽条。
 */
const CHAT_MIN_WIDTH = 240;
const CHAT_RESERVE_WIDTH = 40;

function clampChatWidth(raw, boxWidth, { min = CHAT_MIN_WIDTH, reserve = CHAT_RESERVE_WIDTH } = {}) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return min
  if (!Number.isFinite(boxWidth) || boxWidth <= 0) return Math.max(min, Math.round(value))
  const max = Math.max(min, Math.round(boxWidth - reserve));
  return Math.round(Math.min(Math.max(value, min), max))
}

/**
 * 客户端半侧（工作台业务面板）。
 *
 * 由 rollup 打包成入口 + 内核 chunk（Monaco）；React 由宿主的 require 提供。
 * 编辑面是 Monaco（ADR-0013），审阅面是同一个 chunk 里的 diff editor。
 */

const h = React.createElement;

const STYLE_ID = 'dsh-central-editor/panel.css';
const LARGE_FILE_BYTES = 1_000_000;
const CSS = `
.dce_root{display:flex;flex-direction:column;min-height:0;height:100%;width:100%;position:relative;background:var(--dsw-alias-bg-layer-1,#1e1e1e);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
/* 工作台业务区可能拿着深色 token，与外壳的明暗偏好不同步；按 ctx.theme 的 active.colorScheme 在面板内覆盖一套。 */
.dce_root[data-dce-theme="light"]{--dsw-alias-bg-layer-1:#ffffff;--dsw-alias-label-primary:#1f2328;--dsw-alias-label-secondary:#59636e;--dsw-alias-label-tertiary:#818b98;--dsw-alias-label-primary-foreground:#ffffff;--dsw-alias-border-l3:rgba(31,35,40,.12);--dsw-alias-interactive-bg-hover:rgba(31,35,40,.06);--dsw-alias-state-business-primary:#0969da;--dsw-alias-state-error-primary:#d1242f;--dsw-alias-state-success-primary:#1a7f37}
.dce_toolbar{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l3);flex:none;min-width:0;flex-wrap:wrap;min-height:36px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 94%,var(--dsw-alias-label-primary) 6%)}
.dce_title{font-weight:650;font-size:13px;white-space:nowrap;letter-spacing:.1px}
.dce_badge{flex:none;font-size:10px;line-height:16px;padding:0 6px;border-radius:4px;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Menlo,monospace}
.dce_crumbs{display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden;color:var(--dsw-alias-label-secondary);margin-left:4px}
.dce_crumb{background:none;border:none;padding:0 2px;font:inherit;font-size:12px;color:inherit;cursor:pointer;white-space:nowrap}
.dce_crumb:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}
.dce_sep{color:var(--dsw-alias-label-tertiary)}
.dce_body{display:flex;flex:1;min-height:0;min-width:0;position:relative;overflow:hidden}
.dce_tree{flex:none;width:264px;min-width:216px;max-width:340px;border-right:1px solid var(--dsw-alias-border-l3);overflow:auto;padding:0 0 8px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 97%,var(--dsw-alias-label-primary) 3%)}
.dce_treeHead{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px 6px;font-size:10px;font-weight:650;letter-spacing:.08em;color:var(--dsw-alias-label-secondary);text-transform:uppercase;background:inherit;border-bottom:1px solid var(--dsw-alias-border-l3)}
.dce_treePath{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,monospace;font-weight:400;letter-spacing:0;text-transform:none;color:var(--dsw-alias-label-tertiary)}
.dce_row{display:flex;align-items:center;gap:6px;padding:4px 10px 4px 12px;background:none;border:none;border-left:2px solid transparent;font:inherit;color:inherit;text-align:left;cursor:pointer;width:100%;min-height:26px}
.dce_row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dce_row[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover);border-left-color:var(--dsw-alias-state-business-primary)}
.dce_row[disabled]{opacity:.5;cursor:default}
.dce_icon{flex:none;width:16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;font-family:ui-monospace,Menlo,monospace}
.dce_icon[data-kind="dir"]{color:var(--dsw-alias-state-business-primary)}
.dce_icon[data-kind="image"]{color:var(--dsw-alias-state-success-primary)}
.dce_name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.dce_size{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Menlo,monospace}
.dce_view{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden;position:relative}
.dce_viewBar{flex:none;display:flex;align-items:center;gap:8px;padding:5px 12px;border-bottom:1px solid var(--dsw-alias-border-l3);font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0;min-height:30px;background:var(--dsw-alias-bg-layer-1)}
.dce_viewPath{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,monospace;color:var(--dsw-alias-label-primary);font-size:12px}
.dce_save{border:1px solid var(--dsw-alias-border-l3);border-radius:5px;background:transparent;color:inherit;font:inherit;font-size:12px;padding:3px 10px;cursor:pointer;white-space:nowrap}
.dce_save:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-state-business-primary)}
.dce_save:disabled{opacity:.45;cursor:default}
.dce_primary{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.dce_dirty{color:var(--dsw-alias-state-business-primary)}
.dce_editor{flex:1;min-height:0;position:relative;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#1e1e1e)}
.dce_empty{display:flex;flex:1;align-items:center;justify-content:center;padding:24px;color:var(--dsw-alias-label-tertiary);text-align:center}
.dce_error{margin:8px 12px;padding:8px 10px;border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word}
.dce_note{margin:6px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dce_diag{flex:none;display:flex;align-items:center;gap:0;flex-wrap:wrap;padding:0;border-top:1px solid var(--dsw-alias-border-l3);font-size:10px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Menlo,monospace;min-height:22px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 93%,var(--dsw-alias-label-primary) 7%)}
.dce_diag > span{padding:0 10px;border-right:1px solid var(--dsw-alias-border-l3);line-height:22px}
.dce_diag > span:last-child{border-right:none}
.dce_diagOk{color:var(--dsw-alias-state-success-primary)}
.dce_diagBad{color:var(--dsw-alias-state-error-primary)}
.dce_chat{position:absolute;top:0;right:0;bottom:0;width:var(--dce-chat-width,min(460px,58%));max-width:100%;display:flex;flex-direction:column;border-left:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1,#1e1e1e);z-index:5}
.dce_chat[data-resizing="true"]{user-select:none}
.dce_chat[data-resizing="true"] .dce_chatBody{pointer-events:none}
.dce_chatGrip{position:absolute;left:-3px;top:0;bottom:0;width:8px;display:flex;align-items:center;justify-content:center;cursor:col-resize;z-index:6;touch-action:none}
.dce_chatGrip::before{content:"";width:2px;height:40px;border-radius:2px;background:var(--dsw-alias-border-l3);transition:height .12s}
.dce_chatGrip:hover::before,.dce_chatGrip:active::before{height:72px;background:var(--dsw-alias-state-business-primary)}
.dce_chatBar{flex:none;display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3);font-size:12px;flex-wrap:wrap}
.dce_chatBody{flex:1;min-height:0;overflow:hidden;position:relative}
.dce_chatMount{position:absolute;inset:0}
.dce_chatFallback{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;text-align:center;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1,#1e1e1e)}
.dce_col{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.dce_tabs{flex:none;display:flex;align-items:stretch;gap:0;padding:0;border-bottom:1px solid var(--dsw-alias-border-l3);overflow-x:auto;min-height:30px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 96%,var(--dsw-alias-label-primary) 4%)}
.dce_tab{display:flex;align-items:center;gap:2px;border-radius:0;border-top:2px solid transparent;border-right:1px solid var(--dsw-alias-border-l3);padding:0 2px 0 10px;max-width:200px;min-height:30px;color:var(--dsw-alias-label-secondary)}
.dce_tab:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dce_tab[data-active="true"]{background:var(--dsw-alias-bg-layer-1);border-top-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}
.dce_tabName{background:none;border:none;font:inherit;font-size:12px;color:inherit;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 2px}
.dce_tabClose{background:none;border:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:14px;line-height:14px;padding:0 5px;border-radius:3px;opacity:0}
.dce_tab:hover .dce_tabClose,.dce_tab[data-active="true"] .dce_tabClose{opacity:1}
.dce_tabClose:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dce_tabDot{font-size:10px;color:var(--dsw-alias-state-business-primary)}
.dce_tabMissing{opacity:.55;text-decoration:line-through}
.dce_line_highlight{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}
.dce_reviewBadge{flex:none;font-size:11px;line-height:18px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground)}
/* 背景必须跟宿主解析后的主题走：系统是浅色而应用选了深色时，prefers-color-scheme 会骗人。 */
.dce_reviewOverlay{position:absolute;inset:0;z-index:10;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#1e1e1e);min-height:0;min-width:0;overflow:hidden;isolation:isolate}
.dce_reviewHead{flex:none;display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);font-size:13px;flex-wrap:wrap;min-width:0}
.dce_reviewBody{flex:1;display:flex;min-height:0;min-width:0;overflow:hidden}
.dce_reviewList{flex:none;width:38%;min-width:220px;max-width:420px;border-right:.5px solid var(--dsw-alias-border-l3);overflow:auto;padding:6px 0}
.dce_batch{margin:4px 0 8px}
.dce_batchTitle{display:flex;align-items:center;justify-content:space-between;padding:4px 12px;font-size:11px;color:var(--dsw-alias-label-tertiary);text-transform:none}
.dce_reviewFile{display:flex;align-items:center;gap:8px;width:100%;padding:5px 12px;background:none;border:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dce_reviewFile:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dce_reviewFile[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover)}
.dce_reviewFileMain{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,monospace;font-size:12px}
.dce_stat{flex:none;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dce_add{color:var(--dsw-alias-state-success-primary)}
.dce_del{color:var(--dsw-alias-state-error-primary)}
.dce_reviewMain{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;overflow:hidden}
.dce_reviewFileHead{flex:none;display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);flex-wrap:wrap}
.dce_reviewFileTitle{font-family:ui-monospace,Menlo,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dce_hunkList{flex:none;max-height:44%;overflow:auto;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dce_hunk{display:flex;align-items:flex-start;gap:8px;padding:6px 12px;border-bottom:.5px dashed var(--dsw-alias-border-l3);flex-wrap:wrap}
.dce_hunk[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover)}
.dce_hunkMain{flex:1;min-width:0;cursor:pointer;background:none;border:none;color:inherit;font:inherit;text-align:left;padding:0}
.dce_hunkHeader{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dce_hunkPreview{font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:16px;max-height:48px;overflow:hidden;white-space:pre-wrap;word-break:break-all}
.dce_hunkActions{flex:none;display:flex;gap:4px}
.dce_hunkState{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);align-self:center}
.dce_diffWrap{flex:1;min-height:140px;position:relative;overflow:hidden}
.dce_diffMount{position:absolute;inset:0}
.dce_reviewFoot{flex:none;display:flex;align-items:center;gap:8px;padding:6px 12px;border-top:.5px solid var(--dsw-alias-border-l3);font-size:11px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}
.dce_chip{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:0 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3);font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dce_preview{flex:1;min-height:0;overflow:auto;margin:0;padding:12px;font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary)}
.dce_imagePreview{flex:1;min-height:0;overflow:hidden;position:relative;padding:12px}
.dce_imagePreview img{position:absolute;inset:12px;width:calc(100% - 24px);height:calc(100% - 24px);object-fit:contain;background:repeating-conic-gradient(#8882 0 25%,transparent 0 50%) 50%/16px 16px}
.dce_banner{flex:none;display:flex;align-items:center;gap:8px;margin:8px 12px;padding:8px 10px;border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);font-size:12px;flex-wrap:wrap}
.dce_bannerClose{flex:none;margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:14px;line-height:1;cursor:pointer}
.dce_bannerClose:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dce_bannerClose:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dce_sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.dce_hidden{display:none !important}
`;

function ensureStyle() {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) return
  const tag = document.createElement('style');
  tag.dataset.pluginCss = STYLE_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

/** 客户端上下文由 apply 注入。 */
let client = null;

/**
 * 已关掉的「这个工作台打开的是另一个会话」提示，记住的是「当前会话 + 原生会话」这一对。
 * 放模块级而不是 state：切面板/切视图会重挂，重挂后不该又弹出来；刷新页面才重新提示，
 * 免得唯一的「切到刚才的会话」入口被永久关掉。
 */
let dismissedNativeBannerKey = '';

/**
 * 对话抽屉的宽度（px）。拖过抽屉左边缘就记住，跨会话、跨刷新都保留；
 * 没拖过（null）就用 CSS 默认的 `min(460px, 58%)`。
 */
const CHAT_WIDTH_KEY = 'dce.chatWidth.v1';

function loadChatWidth() {
  try {
    if (typeof localStorage === 'undefined') return null
    const value = Number(localStorage.getItem(CHAT_WIDTH_KEY));
    return Number.isFinite(value) && value >= CHAT_MIN_WIDTH ? Math.round(value) : null
  } catch {
    return null
  }
}

function saveChatWidth(width) {
  try {
    if (typeof localStorage === 'undefined') return
    if (width) localStorage.setItem(CHAT_WIDTH_KEY, String(Math.round(width)));
    else localStorage.removeItem(CHAT_WIDTH_KEY);
  } catch {
    /* 存不下不影响拖动 */
  }
}


/** 读宿主主题快照的明暗；拿不到就返回 null，保持原行为（不猜 prefers-color-scheme）。 */
function appThemeScheme() {
  try {
    const theme = client?.get?.('theme');
    const snapshot = theme?.getTheme?.();
    const scheme = snapshot?.active?.colorScheme;
    if (scheme === 'light' || scheme === 'dark') return scheme
  } catch {
    /* 主题服务不可用 */
  }
  return null
}

function filesApi() {
  try {
    const files = client && client.remote && client.remote.workspaceFiles;
    return files && typeof files.list === 'function' ? files : null
  } catch {
    return null
  }
}

function describeError(error) {
  if (!error) return ''
  if (typeof error === 'string') return error
  const code = error.code ? String(error.code) : '';
  const message = error.message ?? String(error);
  return code ? `${message}（${code}）` : message
}

function unwrap(result) {
  if (result && typeof result === 'object' && typeof result.ok === 'boolean') {
    if (result.ok) return result.value
    const thrown = new Error(result.error?.message ?? '请求失败');
    if (result.error?.code) thrown.code = result.error.code;
    throw thrown
  }
  return result
}

async function post(route, body) {
  const response = await fetch(`/api/central-editor${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    /* 非 JSON 响应按状态码处理 */
  }
  if (!response.ok) {
    const thrown = new Error(payload.message || `HTTP ${response.status}`);
    if (payload.code) thrown.code = payload.code;
    thrown.status = response.status;
    if (payload.tried) thrown.tried = payload.tried;
    throw thrown
  }
  return payload.value
}

function diffEdits(original, next) {
  if (original === next) return []
  let start = 0;
  const limit = Math.min(original.length, next.length);
  while (start < limit && original.charCodeAt(start) === next.charCodeAt(start)) start += 1;
  let endOld = original.length;
  let endNew = next.length;
  while (endOld > start && endNew > start && original.charCodeAt(endOld - 1) === next.charCodeAt(endNew - 1)) {
    endOld -= 1;
    endNew -= 1;
  }
  return [{ from: start, to: endOld, text: next.slice(start, endNew) }]
}

function looksBinary(text) {
  if (typeof text !== 'string') return true
  if (text.indexOf('\u0000') !== -1) return true
  const sample = text.slice(0, 4000);
  if (!sample) return false
  let bad = 0;
  for (let index = 0; index < sample.length; index += 1) {
    if (sample.charCodeAt(index) === 0xfffd) bad += 1;
  }
  return bad / sample.length > 0.02
}

/**
 * 读全文。新服务端走 /fileText（完整、带绝对路径）；旧服务端没有这个路由时
 * 退回 workspaceFiles + /stat，保证升级前后都能打开文件。
 */
async function readFileText(sessionId, path) {
  try {
    return await post('/fileText', { sessionId, path })
  } catch (error) {
    // 新服务端的 404 有两种含义：没有 /fileText 路由（旧服务端）或文件确实不存在。
    // 带 editor-file/not-found 码的就是「文件不存在」，必须原样抛给调用方去显示占位，
    // 不能落到 workspaceFiles 回退里——那边只会抛 workspace-file-not-found，占位就没了。
    if (error.status !== 404 || error.code === 'editor-file/not-found') throw error
    const files = filesApi();
    if (!files) throw error
    const page = unwrap(await files.read(sessionId, path, { offset: 1, limit: 5000 }));
    const stat = await post('/stat', { sessionId, path });
    const text = typeof page?.text === 'string' ? page.text : '';
    return {
      text,
      binary: looksBinary(text),
      bytes: stat.bytes ?? page?.bytes ?? 0,
      lines: text === '' ? 0 : text.split('\n').length,
      version: stat.version,
      absolutePath: null,
      oversized: false,
      fallback: true,
    }
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function baseName(path) {
  const at = path.lastIndexOf('/');
  return at === -1 ? path : path.slice(at + 1)
}

/** 文件树图标分类：只用于显示，不影响语言或打开行为。 */
function iconKind(name) {
  const ext = (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'].includes(ext)) return 'image'
  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'py', 'go', 'rs', 'java', 'c', 'cc', 'cpp', 'h', 'cs', 'rb', 'php', 'sh', 'ps1', 'yml', 'yaml', 'xml', 'html', 'css', 'scss', 'sql'].includes(ext)) return 'code'
  if (['md', 'txt', 'log', 'rst', 'adoc'].includes(ext)) return 'text'
  return 'file'
}

function iconGlyph(kind) {
  if (kind === 'dir') return '▸'
  if (kind === 'image') return '▨'
  if (kind === 'code') return '‹›'
  if (kind === 'text') return '¶'
  return '·'
}

function dirName(path) {
  const at = path.lastIndexOf('/');
  return at <= 0 ? '' : path.slice(0, at)
}

function withSlash(path) {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** 审阅列表优先用服务端的 display；历史数据里可能是绝对路径，退回相对 path。 */
function displayOf(file) {
  const display = file?.display || file?.path || '';
  if (/^[a-zA-Z]:[\\/]/.test(display) || display.startsWith('/')) return file?.path || display
  return display
}

function offsetOfLine(text, line) {
  if (!Number.isFinite(line) || line <= 1) return 0
  let offset = 0;
  for (let index = 0; index < line - 1; index += 1) {
    const next = text.indexOf('\n', offset);
    if (next === -1) return -1
    offset = next + 1;
  }
  return offset
}

/**
 * 内核按需加载：入口只带面板与语言映射，Monaco 在 `client.monaco.js` 分块里。
 * `require.async` 由宿主的模块系统提供给 factory，只在首次打开编辑器时才会去
 * 取 `/plugins/dsh-central-editor/client.monaco.js`。失败不缓存，下次重建可重试。
 */
let monacoModulePromise = null;
function loadMonacoModule() {
  if (monacoModulePromise) return monacoModulePromise
  const req = typeof require === 'function' ? require : null;
  if (!req || typeof req.async !== 'function') {
    return Promise.reject(new Error('宿主没有提供 require.async，内核无法按需加载'))
  }
  monacoModulePromise = req.async('./client.monaco.js').catch((error) => {
    monacoModulePromise = null;
    throw error
  });
  return monacoModulePromise
}

function useFilesListing(sessionId, dir) {
  const [listing, setListing] = React.useState(null);
  const [listingError, setListingError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (!sessionId) return undefined
    const files = filesApi();
    if (!files) {
      setListingError('没有拿到工作区读取接口（remote.workspaceFiles 未注入）');
      return undefined
    }
    let cancelled = false;
    setBusy(true);
    setListingError('');
    try {
      files
        .list(sessionId, dir || '.')
        .then((result) => {
          if (cancelled) return
          const value = unwrap(result);
          setListing(value?.entries ? value : { entries: [], truncated: false });
        })
        .catch((error) => {
          if (cancelled) return
          setListing(null);
          setListingError(describeError(error));
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    } catch (error) {
      setListingError(describeError(error));
      setBusy(false);
    }
    return () => {
      cancelled = true;
    }
  }, [sessionId, dir]);
  return { listing, listingError, busy }
}

/**
 * 编辑面：只在有可编辑文本时挂载。组件生命周期 = 编辑面生命周期，
 * 切文件不重建 Monaco 实例（多标签共用同一个实例与各自 model）。
 */
function EditorSurface({ file, readOnly, theme, hostRef, fileRef, saveRef, pendingRef, onStatus, onDirty, onViewState }) {
  const mountRef = React.useRef(null);
  const modRef = React.useRef(null);
  const [ready, setReady] = React.useState(false);

  const report = () => {
    const node = mountRef.current;
    const mod = modRef.current;
    if (!node || !mod) return
    const host = hostRef.current;
    const models = host ? host.modelCount() : 0;
    onStatus(`ready ${node.clientWidth}x${node.clientHeight} · chunk · 实例:${mod.editorCount()} 文档:${models}`);
  };

  const applyPending = (host) => {
    const pending = pendingRef.current;
    if (!pending || pending.path !== fileRef.current?.path) return
    pendingRef.current = null;
    if (pending.restore) host.restoreView(pending.path, pending.restore);
    else host.reveal(pending.path, pending.line, pending.column);
  };

  React.useEffect(() => {
    const node = mountRef.current;
    if (!node) return undefined
    let cancelled = false;
    let host = null;
    let off = null;
    let viewOff = null;
    onStatus('加载内核…');
    loadMonacoModule()
      .then((mod) => {
        if (cancelled) return
        modRef.current = mod;
        host = mod.createMonacoHost(node, {
          readOnly,
          onSave: () => {
            if (saveRef.current) void saveRef.current();
          },
        });
        hostRef.current = host;
        off = host.onChange(() => {
          const current = fileRef.current;
          if (!current || current.binary) return
          onDirty(host.getText(current.path) !== current.original);
        });
        viewOff = host.onStateChange(() => {
          try {
            const state = host.getViewState();
            if (state.path) onViewState(state);
          } catch {
            /* 忽略 */
          }
        });
        const opening = fileRef.current;
        if (opening && !opening.binary && !opening.error && !opening.missing && !opening.oversized) {
          host.show(opening.path, opening.original);
          applyPending(host);
        }
        setReady(true);
        report();
      })
      .catch((error) => {
        if (cancelled) return
        onStatus(`失败：${describeError(error)}`);
      });
    return () => {
      cancelled = true;
      try {
        off?.dispose?.();
      } catch {
        /* 忽略 */
      }
      try {
        viewOff?.dispose?.();
      } catch {
        /* 忽略 */
      }
      if (host) host.dispose();
      hostRef.current = null;
      modRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (!ready) return
    const host = hostRef.current;
    if (!host || !file) return
    if (file.binary || file.error || file.missing || file.oversized) return
    host.show(file.path, file.original);
    const pending = pendingRef.current;
    if (pending && pending.path === file.path) {
      pendingRef.current = null;
      if (pending.restore) host.restoreView(file.path, pending.restore);
      else host.reveal(file.path, pending.line, pending.column);
    }
    report();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, file && file.path]);

  React.useEffect(() => {
    if (!ready) return
    hostRef.current?.setReadOnly?.(readOnly === true);
  }, [ready, readOnly]);

  // 面板内的 theme 覆盖变了：让 Monaco 从编辑器子树重新读 token 生成主题。
  React.useEffect(() => {
    if (!ready) return
    const node = mountRef.current;
    const mod = modRef.current;
    if (node && typeof mod?.refreshShellTheme === 'function') mod.refreshShellTheme(node);
  }, [ready, theme]);

  return h('div', { className: 'dce_editor', ref: mountRef })
}

function BinaryPreview({ sessionId, path, file, onOpenInSystem }) {
  const [state, setState] = React.useState({ loading: true });
  React.useEffect(() => {
    let cancelled = false;
    setState({ loading: true });
    post('/raw', { sessionId, path })
      .then((value) => {
        if (cancelled) return
        if (value?.kind === 'image') {
          setState({ loading: false, kind: 'image', src: `data:${value.mime};base64,${value.base64}`, bytes: value.bytes });
        } else if (value?.kind === 'binary') {
          setState({ loading: false, kind: 'binary', hex: value.hex, bytes: value.bytes });
        } else {
          setState({ loading: false, kind: 'none' });
        }
      })
      .catch((error) => {
        if (!cancelled) setState({ loading: false, error: describeError(error) });
      });
    return () => {
      cancelled = true;
    }
  }, [sessionId, path]);

  if (state.loading) return h('div', { className: 'dce_empty' }, '读取预览…')
  if (state.error) return h('div', { className: 'dce_error' }, state.error)
  return h(
    'div',
    { className: 'dce_view' },
    h(
      'div',
      { className: 'dce_banner' },
      h('span', null, `二进制文件${state.bytes ? ` · ${formatBytes(state.bytes)}` : ''}，不进入编辑面`),
      file.absolutePath
        ? h(
            'button',
            { type: 'button', className: 'dce_save', onClick: () => onOpenInSystem(file) },
            '用系统程序打开'
          )
        : null
    ),
    state.kind === 'image'
      ? h('div', { className: 'dce_imagePreview' }, h('img', { src: state.src, alt: path }))
      : h('pre', { className: 'dce_preview' }, state.hex ? `前 ${Math.min(256, Math.floor(state.hex.length / 2))} 字节：\n${state.hex}` : '没有可预览的内容')
  )
}

function ReviewDiff({ hunk }) {
  const mountRef = React.useRef(null);
  const hostRef = React.useRef(null);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    let cancelled = false;
    loadMonacoModule()
      .then((mod) => {
        if (cancelled || !mountRef.current) return
        hostRef.current = mod.createDiffHost(mountRef.current);
        hostRef.current.show({ oldText: hunk.oldText, newText: hunk.newText, path: hunk.path });
      })
      .catch((failure) => {
        if (!cancelled) setError(describeError(failure));
      });
    return () => {
      cancelled = true;
      try {
        hostRef.current?.dispose?.();
      } catch {
        /* 忽略 */
      }
      hostRef.current = null;
    }
  }, [hunk.id]);
  React.useEffect(() => {
    if (hostRef.current) hostRef.current.show({ oldText: hunk.oldText, newText: hunk.newText, path: hunk.path });
  }, [hunk.id, hunk.oldText, hunk.newText, hunk.path]);
  return h(
    'div',
    { className: 'dce_diffWrap' },
    error ? h('div', { className: 'dce_error' }, error) : null,
    h('div', { className: 'dce_diffMount', ref: mountRef })
  )
}

function hunkStatus(handled, id) {
  return handled.get(id) ?? null
}

function ReviewPanel({
  review,
  handled,
  selectedFileKey,
  selectedHunkId,
  busy,
  message,
  onSelectFile,
  onSelectHunk,
  onKeep,
  onKeepAll,
  onRollback,
  onExit,
  onRefresh,
  onOpenFile,
  narrow,
}) {
  const data = review.data;
  const files = [];
  if (data) {
    for (const batch of data.turns) {
      for (const file of batch.files) files.push({ batch, file, key: `${batch.turn}\u0000${file.path}` });
    }
  }
  const selected = files.find((item) => item.key === selectedFileKey) ?? files[0];
  const hunks = selected?.file.hunks ?? [];
  const hunk = hunks.find((item) => item.id === selectedHunkId) ?? hunks[0];
  const pending = (data?.totals?.hunks ?? 0) - handled.size;

  const nextHunk = (delta) => {
    if (!selected || hunks.length === 0) return
    const index = Math.max(0, hunks.findIndex((item) => item.id === hunk?.id));
    const next = hunks[(index + delta + hunks.length) % hunks.length];
    onSelectHunk(next.id);
  };

  const onKeyDown = (event) => {
    if (event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return
    const key = event.key.toLowerCase();
    if (key === 'escape') {
      event.preventDefault();
      onExit();
    } else if (key === 'n' || key === 'j' || key === 'arrowdown') {
      event.preventDefault();
      nextHunk(1);
    } else if (key === 'arrowup') {
      event.preventDefault();
      nextHunk(-1);
    } else if (key === 'p' && hunk) {
      event.preventDefault();
      onKeep(selected.file, hunk);
    } else if (key === 'r' && hunk) {
      event.preventDefault();
      onRollback(selected.file, hunk);
    }
  };

  return h(
    'div',
    { className: 'dce_reviewOverlay', onKeyDown, tabIndex: 0, role: 'region', 'aria-label': '审阅队列' },
    h(
      'div',
      { className: 'dce_reviewHead' },
      h('strong', null, '审阅队列'),
      data ? h('span', { className: 'dce_stat' }, `${data.totals.batches} 批 · ${data.totals.files} 文件 · ${data.totals.hunks} 块 · 待处理 ${Math.max(0, pending)}`) : null,
      h('span', { className: 'dce_stat dce_add' }, `+${data?.totals?.added ?? 0}`),
      h('span', { className: 'dce_stat dce_del' }, `−${data?.totals?.deleted ?? 0}`),
      h('span', { style: { flex: 1 } }),
      h(
        'button',
        {
          type: 'button',
          className: 'dce_save',
          onClick: onKeepAll,
          disabled: !data || pending <= 0 || review.loading,
          'aria-label': '全部保留，标记所有块已处理',
        },
        pending > 0 ? '全部保留' : '已全部处理'
      ),
      h('button', { type: 'button', className: 'dce_save', onClick: onRefresh, disabled: review.loading }, review.loading ? '刷新中…' : '刷新'),
      h('button', { type: 'button', className: 'dce_save', onClick: onExit }, '退出审阅')
    ),
    review.error ? h('div', { className: 'dce_error' }, review.error) : null,
    data && data.coverage && !data.coverage.workspaceChanges
      ? h(
          'div',
          { className: 'dce_note' },
          '本机 workspaceChanges 未启用：命令行/子代理直接改的文件无法枚举；write/edit 的改动仍从会话转录逐块审阅。'
        )
      : null,
    !data && review.loading ? h('div', { className: 'dce_empty' }, '读取审阅队列…') : null,
    data && files.length === 0 ? h('div', { className: 'dce_empty' }, '这个对话还没有可审阅的改动。') : null,
    data && files.length > 0
      ? h(
          'div',
          { className: 'dce_reviewBody' },
          h(
            'div',
            { className: 'dce_reviewList' },
            data.turns.map((batch) =>
              h(
                'div',
                { key: batch.turn, className: 'dce_batch' },
                h(
                  'div',
                  { className: 'dce_batchTitle' },
                  h('span', null, `第 ${batch.turn} 轮`),
                  h('span', null, batch.files.length ? `${batch.files.length} 文件` : '')
                ),
                batch.files.map((file) => {
                  const key = `${batch.turn}\u0000${file.path}`;
                  const remaining = file.hunks.filter((item) => !handled.has(item.id));
                  const added = remaining.reduce((sum, item) => sum + item.added, 0);
                  const deleted = remaining.reduce((sum, item) => sum + item.deleted, 0);
                  const shownAdded = file.hunks.length > 0 ? added : file.added;
                  const shownDeleted = file.hunks.length > 0 ? deleted : file.deleted;
                  return h(
                    'button',
                    {
                      key,
                      type: 'button',
                      className: 'dce_reviewFile',
                      'data-active': selected?.key === key ? 'true' : 'false',
                      onClick: () => onSelectFile(key),
                    },
                    h('span', { className: 'dce_reviewFileMain', title: file.path }, displayOf(file)),
                    file.created ? h('span', { className: 'dce_stat' }, '新增') : null,
                    file.binary ? h('span', { className: 'dce_stat' }, '二进制') : null,
                    file.oversized ? h('span', { className: 'dce_stat' }, '超大') : null,
                    file.hunkCount > 0
                      ? h('span', { className: 'dce_stat' }, `${file.hunkCount} 块`)
                      : h('span', { className: 'dce_stat' }, file.created ? '无基线' : '无基线'),
                    h('span', { className: 'dce_stat dce_add' }, `+${shownAdded}`),
                    h('span', { className: 'dce_stat dce_del' }, `−${shownDeleted}`)
                  )
                })
              )
            )
          ),
          h(
            'div',
            { className: 'dce_reviewMain' },
            selected
              ? h(
                  React.Fragment,
                  null,
                  h(
                    'div',
                    { className: 'dce_reviewFileHead' },
                    h('span', { className: 'dce_reviewFileTitle', title: selected.file.path }, displayOf(selected.file)),
                    h('span', { className: 'dce_stat dce_add' }, `+${selected.file.added}`),
                    h('span', { className: 'dce_stat dce_del' }, `−${selected.file.deleted}`),
                    h('span', { className: 'dce_stat' }, `${selected.file.hunkCount} 块`),
                    selected.file.binary ? h('span', { className: 'dce_stat' }, '二进制') : null,
                    selected.file.oversized ? h('span', { className: 'dce_stat' }, '超大') : null,
                    selected.file.created
                      ? h('span', { className: 'dce_stat' }, selected.file.hunkCount > 0 ? '新增' : '新增（无基线）')
                      : null,
                    h('span', { style: { flex: 1 } }),
                    h('button', { type: 'button', className: 'dce_save', onClick: () => onOpenFile(selected.file, hunk) }, '在编辑器中打开')
                  ),
                  hunks.length > 0
                    ? h(
                        'div',
                        { className: 'dce_hunkList' },
                        hunks.map((item, index) => {
                          const status = hunkStatus(handled, item.id);
                          return h(
                            'div',
                            {
                              key: item.id,
                              className: 'dce_hunk',
                              'data-active': hunk?.id === item.id ? 'true' : 'false',
                            },
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'dce_hunkMain',
                                onClick: () => onSelectHunk(item.id),
                                'aria-label': `第 ${index + 1} 块，共 ${hunks.length} 块`,
                              },
                              h('div', { className: 'dce_hunkHeader' }, item.header || `第 ${index + 1} 块`),
                              h(
                                'div',
                                { className: 'dce_hunkPreview' },
                                (item.oldText || '').split('\n').slice(0, 2).map((line) => `- ${line}`).join('\n'),
                                '\n',
                                (item.newText || '').split('\n').slice(0, 2).map((line) => `+ ${line}`).join('\n')
                              )
                            ),
                            h(
                              'div',
                              { className: 'dce_hunkActions' },
                              status
                                ? h('span', { className: 'dce_hunkState' }, status === 'kept' ? '已保留' : '已回滚')
                                : [
                                    h(
                                      'button',
                                      {
                                        key: 'keep',
                                        type: 'button',
                                        className: 'dce_save',
                                        disabled: busy,
                                        onClick: () => onKeep(selected.file, item),
                                        'aria-label': `保留第 ${index + 1} 块，共 ${hunks.length} 块`,
                                      },
                                      '保留'
                                    ),
                                    h(
                                      'button',
                                      {
                                        key: 'rollback',
                                        type: 'button',
                                        className: 'dce_save dce_primary',
                                        disabled: busy,
                                        onClick: () => onRollback(selected.file, item),
                                        'aria-label': `回滚第 ${index + 1} 块，共 ${hunks.length} 块`,
                                      },
                                      '回滚'
                                    ),
                                  ]
                            )
                          )
                        })
                      )
                    : h('div', { className: 'dce_empty' }, selected.file.created ? '新增文件：无基线，不能逐块回滚。' : '这个文件拿不到基线，只能提示已变更。'),
                  hunk
                    ? narrow ? h('pre', { className: 'dce_preview' }, `修改前：\n${hunk.oldText || ''}\n修改后：\n${hunk.newText || ''}`) : h(ReviewDiff, { hunk })
                    : h('div', { className: 'dce_empty' }, '没有可查看的 hunk。')
                )
              : null
          )
        )
      : null,
    h(
      'div',
      { className: 'dce_reviewFoot' },
      h('span', null, '键盘：n/↓ 下一块 · p 保留 · r 回滚 · Esc 退出审阅'),
      h('span', { style: { flex: 1 } }),
      message ? h('span', { role: 'status' }, message) : null
    ),
    h('div', { className: 'dce_sr', 'aria-live': 'polite', 'aria-atomic': 'true' }, message)
  )
}

function EditorPanel({ service, entry, conversation }) {
  const [sessionId, setSessionId] = React.useState(null);
  const sessionIdRef = React.useRef(null);
  const [scheme, setScheme] = React.useState(() => appThemeScheme());

  // 连续同步只走 theme/change（主题服务契约）；拿不到事件时至少用挂载时的快照。
  React.useEffect(() => {
    const read = () => setScheme(appThemeScheme());
    read();
    let off = null;
    try {
      off = client?.on?.('theme/change', read);
    } catch {
      /* 事件不可用 */
    }
    return () => {
      try {
        if (typeof off === 'function') off();
        else off?.dispose?.();
      } catch {
        /* 忽略 */
      }
    }
  }, []);
  const [showChat, setShowChat] = React.useState(false);
  const [chatNode, setChatNode] = React.useState(null);
  const [chatRetry, setChatRetry] = React.useState(0);
  const [chatEmpty, setChatEmpty] = React.useState(false);
  const chatNodeRef = React.useRef(null);
  const chatDragRef = React.useRef(null);
  const chatBoxRef = React.useRef(null);
  const chatFrameRef = React.useRef(0);
  const rootRef = React.useRef(null);
  /**
   * 拖动全程不重渲染：宽度写成 root 上的 CSS 变量（`--dce-chat-width`），拖拽态写成
   * 抽屉节点上的 `data-resizing`。原先每次 pointermove 都 setState，会重渲染整个面板
   * （文件树 + 编辑器宿主 + 抽屉），拖起来像幻灯片；只改自定义属性和一个 data 属性，
   * React 连 diff 都不做，重渲染也不会把它们盖掉。松开时才写 localStorage。
   */
  const applyChatWidth = React.useCallback((width) => {
    const root = rootRef.current;
    if (!root) return
    if (width) root.style.setProperty('--dce-chat-width', `${width}px`);
    else root.style.removeProperty('--dce-chat-width');
  }, []);
  React.useLayoutEffect(() => {
    const saved = loadChatWidth();
    if (!saved) return
    const box = rootRef.current?.getBoundingClientRect?.();
    applyChatWidth(clampChatWidth(saved, box?.width));
  }, [applyChatWidth]);
  React.useEffect(
    () => () => {
      if (chatFrameRef.current) cancelAnimationFrame(chatFrameRef.current);
      chatFrameRef.current = 0;
    },
    []
  );
  const setChatResizing = (on) => {
    const node = chatBoxRef.current;
    if (!node) return
    if (on) node.setAttribute('data-resizing', 'true');
    else node.removeAttribute('data-resizing');
  };
  const startChatResize = (event) => {
    if (event.button !== 0) return
    const box = rootRef.current?.getBoundingClientRect?.();
    if (!box || !box.width) return
    event.preventDefault();
    // 面板右边缘与宽度只在按下时量一次：拖动中不再读布局，省掉每帧的同步重排。
    chatDragRef.current = {
      right: box.right,
      boxWidth: box.width,
      latest: clampChatWidth(box.right - event.clientX, box.width),
    };
    setChatResizing(true);
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* 忽略 */
    }
  };
  const moveChatResize = (event) => {
    const drag = chatDragRef.current;
    if (!drag) return
    drag.latest = clampChatWidth(drag.right - event.clientX, drag.boxWidth);
    if (chatFrameRef.current) return
    chatFrameRef.current = requestAnimationFrame(() => {
      chatFrameRef.current = 0;
      const width = chatDragRef.current?.latest;
      if (width) applyChatWidth(width);
    });
  };
  const endChatResize = (event) => {
    const drag = chatDragRef.current;
    if (!drag) return
    if (chatFrameRef.current) {
      cancelAnimationFrame(chatFrameRef.current);
      chatFrameRef.current = 0;
    }
    chatDragRef.current = null;
    setChatResizing(false);
    applyChatWidth(drag.latest);
    saveChatWidth(drag.latest);
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      /* 忽略 */
    }
  };
  const resetChatWidth = () => {
    applyChatWidth(null);
    saveChatWidth(null);
  };
  const setChatMount = React.useCallback((node) => {
    chatNodeRef.current = node;
    setChatNode(node);
  }, []);
  // 宿主在部分路径（例如工作台模式下 Ctrl+R）不会把会话节点交给面板；
  // 此时抽屉不能只是一片空白。DOM 节点还可能已被卸载（isConnected=false）。
  const conversationAttached = Boolean(
    conversation && (typeof conversation !== 'object' || conversation.nodeType === undefined || conversation.isConnected !== false)
  );
  // 宿主给的容器也可能是空的（会话内容没挂进来）：挂载后观测一次文本，
  // 空则显示恢复提示，但保持 portal 挂载，内容一旦出现就自动消失。
  React.useEffect(() => {
    if (!showChat) {
      setChatEmpty(false);
      return undefined
    }
    const node = chatNodeRef.current;
    if (!node) {
      setChatEmpty(!conversationAttached);
      return undefined
    }
    const check = () => {
      try {
        // innerText 只统计「看得见」的文本：宿主节点可能挂着 display:none 的
        // 旧内容，textContent 非空但实际什么都没画出来。
        const visible = String(node.innerText || '').trim();
        setChatEmpty(!visible);
      } catch {
        setChatEmpty(false);
      }
    };
    check();
    const timer = setTimeout(check, 800);
    const observer = typeof MutationObserver === 'function' ? new MutationObserver(check) : null;
    try {
      observer?.observe(node, { childList: true, subtree: true, characterData: true });
    } catch {
      /* 观测失败就只靠定时检查 */
    }
    return () => {
      clearTimeout(timer);
      try {
        observer?.disconnect();
      } catch {
        /* 忽略 */
      }
    }
  }, [showChat, conversationAttached, chatRetry, chatNode]);
  const [dir, setDir] = React.useState('');
  const [file, setFile] = React.useState(null);
  const [openFiles, setOpenFiles] = React.useState([]);
  const metaRef = React.useRef({});
  const [dirty, setDirty] = React.useState(false);
  const dirtyRef = React.useRef(false);
  dirtyRef.current = dirty;
  const [saving, setSaving] = React.useState(false);
  const [note, setNote] = React.useState('');
  const [versionError, setVersionError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [bindingBusy, setBindingBusy] = React.useState(false);
  const [dismissedNativeBanner, setDismissedNativeBanner] = React.useState(dismissedNativeBannerKey);
  const [hostState, setHostState] = React.useState('未加载（按需）');
  const [mode, setMode] = React.useState('files');
  const [review, setReview] = React.useState({
    data: null,
    loading: false,
    error: '',
    handled: new Map(),
    selectedFile: null,
    selectedHunk: null,
    message: '',
    complete: false,
  });
  const [narrow, setNarrow] = React.useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches);
  const [chatRefs, setChatRefs] = React.useState([]);
  const chatRefsSet = React.useRef(new Set());
  const hostRef = React.useRef(null);
  const saveRef = React.useRef(null);
  const fileRef = React.useRef(null);
  fileRef.current = file;
  const pendingPositionRef = React.useRef(null);
  const sessionEpochRef = React.useRef(0);
  const reviewRequestRef = React.useRef(0);
  const isCurrent = (id, epoch) => sessionIdRef.current === id && sessionEpochRef.current === epoch;
  const isDirtyPath = (path) => {
    const meta = metaRef.current[path];
    const host = hostRef.current;
    return Boolean(meta && host && !meta.binary && !meta.missing && !meta.oversized && host.getText(path) !== meta.original)
  };
  const hasDirtyFiles = () => Object.keys(metaRef.current).some(isDirtyPath);

  const positionsRef = React.useRef({});
  const restorePositionsRef = React.useRef({});
  const stateRef = React.useRef({ openFiles: [], file: null, dir: '' });
  stateRef.current = { openFiles, file, dir };
  const { listing, listingError, busy: listingBusy } = useFilesListing(sessionId, dir);

  const persist = React.useCallback((id) => {
    if (!id) return
    const positions = { ...positionsRef.current };
    try {
      const state = hostRef.current?.getViewState?.();
      if (state?.path) positions[state.path] = state;
    } catch {
      /* 忽略 */
    }
    saveSessionState(id, {
      openFiles: stateRef.current.openFiles,
      activePath: stateRef.current.file?.path ?? null,
      dir: stateRef.current.dir,
      positions,
    });
  }, []);

  // 会话跟踪：切换前有未保存改动先问；取消就试着切回去。
  React.useEffect(() => {
    if (!service || typeof service.currentSession !== 'function') return undefined
    const read = () => {
      try {
        const value = service.currentSession();
        return typeof value === 'string' ? value : null
      } catch {
        return null
      }
    };
    const apply = () => {
      const next = read();
      const current = sessionIdRef.current;
      if (next === current) return
      if (!next) {
        sessionEpochRef.current += 1;
        persist(current);
        try {
          hostRef.current?.clear?.();
        } catch {
          /* 忽略清理失败 */
        }
        metaRef.current = {};
        positionsRef.current = {};
        restorePositionsRef.current = {};
        pendingPositionRef.current = null;
        sessionIdRef.current = null;
        setSessionId(null);
        return
      }
      if (current && hasDirtyFiles()) {
        const ok =
          typeof window !== 'undefined' &&
          window.confirm('当前对话有未保存的改动，切换对话会丢失。仍要切换吗？');
        if (!ok) {
          try {
            service.openSession(current);
          } catch {
            /* 切不回去就保持旧视图，至少不悄悄丢内容 */
          }
          return
        }
      }
      sessionEpochRef.current += 1;
      persist(current);
      try {
        hostRef.current?.clear?.();
      } catch {
        /* 清理失败不阻断会话切换；后续会重新同步文件文本 */
      }
      metaRef.current = {};
      positionsRef.current = {};
      restorePositionsRef.current = {};
      pendingPositionRef.current = null;
      sessionIdRef.current = next;
      setSessionId(next);
    };
    apply();
    if (typeof service.subscribe !== 'function') return undefined
    const off = service.subscribe(apply);
    return () => {
      try {
        if (typeof off === 'function') off();
      } catch {
        /* 忽略退订失败 */
      }
    }
  }, [service]);

  // 离开旧会话/关页前落一次状态。
  React.useEffect(() => {
    if (!sessionId) return undefined
    const id = sessionId;
    const onBeforeUnload = () => persist(id);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (sessionIdRef.current === id) persist(id);
    }
  }, [sessionId, persist]);

  // 会话切换：清空上一个会话的视图与 model，再恢复本会话的标签。
  React.useEffect(() => {
    if (!sessionId) return undefined
    setDir('');
    setFile(null);
    setOpenFiles([]);
    setDirty(false);
    setBusy(false);
    setSaving(false);
    setNote('');
    setVersionError('');
    setMode('files');
    setReview({
      data: null,
      loading: false,
      error: '',
      handled: new Map(),
      selectedFile: null,
      selectedHunk: null,
      message: '',
      complete: false,
    });
    metaRef.current = {};
    positionsRef.current = {};
    restorePositionsRef.current = {};
    pendingPositionRef.current = null;
    setHostState('未加载（按需）');
    const saved = loadSessionState(sessionId);
    if (saved?.openFiles?.length) {
      restorePositionsRef.current = saved.positions ?? {};
      setOpenFiles(saved.openFiles);
      setDir(saved.dir || '');
      if (saved.activePath) {
        void openFile(saved.activePath, { restore: saved.positions?.[saved.activePath] });
      }
    } else if (saved?.dir) {
      setDir(saved.dir);
    }
    return () => {
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 会话内状态变化时防抖保存。
  React.useEffect(() => {
    if (!sessionId) return undefined
    const timer = setTimeout(() => persist(sessionId), 500);
    return () => clearTimeout(timer)
  }, [sessionId, dir, openFiles, file && file.path, dirty, persist]);

  // 窄屏：只读，不加载内核。
  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof matchMedia !== 'function') return undefined
    const media = matchMedia('(max-width: 640px)');
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update)
  }, []);

  async function refreshReview({ silent = false } = {}) {
    if (!sessionId) return
    const epoch = sessionEpochRef.current;
    const request = ++reviewRequestRef.current;
    if (!silent) setReview((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      const value = await post('/review', { sessionId });
      if (!isCurrent(sessionId, epoch) || request !== reviewRequestRef.current) return
      const fileKeys = [];
      let firstFile = null;
      for (const batch of value.turns ?? []) {
        for (const changed of batch.files ?? []) {
          const key = `${batch.turn}\u0000${changed.path}`;
          const entry = { key, file: changed, turn: batch.turn };
          fileKeys.push(entry);
          if (!firstFile) firstFile = entry;
        }
      }
      const validHunks = new Set();
      for (const entry of fileKeys) for (const hunk of entry.file.hunks ?? []) validHunks.add(hunk.id);
      const fileKeySet = new Set(fileKeys.map((entry) => entry.key));
      const newestTurn = value.turns?.[0]?.turn ?? null;
      const newestKey = firstFile?.key ?? null;
      setReview((prev) => {
        const handled = new Map();
        for (const [id, state] of prev.handled) if (validHunks.has(id)) handled.set(id, state);
        const turnChanged = newestTurn !== null && newestTurn !== (prev.data?.turns?.[0]?.turn ?? null);
        const selectedFile =
          turnChanged && newestKey
            ? newestKey
            : prev.selectedFile && fileKeySet.has(prev.selectedFile)
              ? prev.selectedFile
              : (firstFile?.key ?? null);
        const selectedEntry = fileKeys.find((entry) => entry.key === selectedFile);
        const candidateHunk = prev.selectedHunk;
        const selectedHunk =
          candidateHunk && (selectedEntry?.file.hunks ?? []).some((hunk) => hunk.id === candidateHunk)
            ? candidateHunk
            : (selectedEntry?.file.hunks?.[0]?.id ?? null);
        const total = value.totals?.hunks ?? 0;
        const complete = total > 0 && handled.size >= total;
        return {
          ...prev,
          data: value,
          loading: false,
          error: '',
          handled,
          selectedFile,
          selectedHunk,
          complete,
          message: complete ? '全部处理完了' : prev.message,
        }
      });
    } catch (error) {
      if (!isCurrent(sessionId, epoch) || request !== reviewRequestRef.current) return
      setReview((prev) => ({ ...prev, loading: false, error: describeError(error) }));
    }
  }

  React.useEffect(() => {
    if (!sessionId) return undefined
    if (mode === 'review') void refreshReview();
    const timer = setInterval(() => {
      if (mode === 'review') void refreshReview({ silent: true });
    }, 10000);
    const onFocus = () => void refreshReview({ silent: true });
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, mode]);

  React.useEffect(() => {
    if (!review.complete) return undefined
    const timer = setTimeout(() => {
      setMode('files');
      setNote('审阅完成');
    }, 1400);
    return () => clearTimeout(timer)
  }, [review.complete]);

  function activate(path, options = {}) {
    const meta = metaRef.current[path];
    if (!meta) return
    setFile(meta);
    setDirty(isDirtyPath(path));
    setNote(meta.missing ? '文件不存在；可能已被删除' : '');
    setVersionError('');
    if (meta.binary) return
    const host = hostRef.current;
    if (host && !meta.binary && !meta.missing && !meta.oversized) {
      host.show(path, meta.original ?? '');
      if (options.position) host.reveal(path, options.position.line, options.position.column);
      else if (options.restore) host.restoreView(path, options.restore);
      host.focus();
    }
  }

  async function openFile(path, options = {}) {
    if (!sessionId) return
    const epoch = sessionEpochRef.current;
    if (sessionIdRef.current !== sessionId) return
    if (metaRef.current[path] && hostRef.current) {
      activate(path, options);
      return
    }
    setNote('');
    setVersionError('');
    setBusy(true);
    try {
      const value = await readFileText(sessionId, path);
      if (!isCurrent(sessionId, epoch)) return
      const restore = options.restore ?? (options.position ? undefined : restorePositionsRef.current[path]);
      const addTab = (meta) => {
        metaRef.current[path] = meta;
        setFile(meta);
        setOpenFiles((prev) => (prev.includes(path) ? prev : [...prev, path]));
        setDirty(false);
      };
      if (value.oversized) {
        addTab({ path, oversized: true, bytes: value.bytes, version: value.version, absolutePath: value.absolutePath, readOnly: true });
        setNote(`文件超过 ${formatBytes(LARGE_FILE_BYTES)}，已退为只读`);
      } else if (value.binary) {
        addTab({ path, binary: true, bytes: value.bytes, version: value.version, absolutePath: value.absolutePath, readOnly: true });
      } else {
        const readOnly = value.bytes > LARGE_FILE_BYTES;
        addTab({
          path,
          original: value.text,
          version: value.version,
          bytes: value.bytes,
          absolutePath: value.absolutePath,
          readOnly,
          missing: false,
        });
        if (options.position) pendingPositionRef.current = { path, ...options.position };
        else if (restore) pendingPositionRef.current = { path, restore };
        if (readOnly) setNote(`文件超过 ${formatBytes(LARGE_FILE_BYTES)}，已退为只读；可用系统编辑器打开`);
      }
    } catch (error) {
      if (!isCurrent(sessionId, epoch)) return
      if (error.status === 404) {
        const meta = { path, missing: true, error: '文件不存在' };
        metaRef.current[path] = meta;
        setFile(meta);
        setOpenFiles((prev) => (prev.includes(path) ? prev : [...prev, path]));
        setNote('文件不存在；可能已被删除');
        setDir(dirName(path));
      } else {
        setFile({ path, error: describeError(error) });
      }
    } finally {
      if (isCurrent(sessionId, epoch)) setBusy(false);
    }
  }

  async function openFileAt(path, line = 1, column = 1) {
    const clean = withSlash(path);
    if (!clean) return
    if (metaRef.current[clean] && hostRef.current) {
      activate(clean, { position: { line, column } });
      return
    }
    await openFile(clean, { position: { line, column } });
  }

  function closeTab(path) {
    const meta = metaRef.current[path];
    const host = hostRef.current;
    if (!meta) {
      setOpenFiles((prev) => prev.filter((item) => item !== path));
      return
    }
    const changed = host && !meta.binary && !meta.missing ? host.getText(path) !== meta.original : false;
    if (changed && typeof window !== 'undefined' && !window.confirm(`${path} 有未保存的改动，仍要关闭吗？`)) {
      return
    }
    try {
      host?.disposeModel?.(path);
    } catch {
      /* 忽略 */
    }
    delete metaRef.current[path];
    delete positionsRef.current[path];
    const next = openFiles.filter((item) => item !== path);
    setOpenFiles(next);
    if (file && file.path === path) {
      const fallbackPath = next.length ? next[next.length - 1] : null;
      if (fallbackPath && metaRef.current[fallbackPath]) {
        activate(fallbackPath);
      } else {
        setFile(null);
      }
    }
  }

  async function save() {
    const host = hostRef.current;
    const current = fileRef.current;
    const activeSession = sessionId;
    const epoch = sessionEpochRef.current;
    if (!host || !current || current.binary || current.missing || current.oversized || saving) return
    if (current.readOnly) {
      setNote('这个文件是只读的，不能保存');
      return
    }
    if (!current.version) {
      setNote(versionError ? `保存不可用：${versionError}` : '这个文件当前不可写（没有版本号）');
      return
    }
    const next = host.getText(current.path);
    const edits = diffEdits(current.original, next);
    if (edits.length === 0) {
      setNote('没有改动');
      return
    }
    if (sessionIdRef.current !== activeSession) {
      setNote('对话已切换，已取消这次保存');
      return
    }
    setSaving(true);
    setNote('');
    try {
      const result = await post('/applyPatch', {
        sessionId: activeSession,
        path: current.path,
        baseVersion: current.version,
        edits,
      });
      if (!isCurrent(activeSession, epoch)) return
      const updated = { ...current, original: next, version: result.version, bytes: result.bytes };
      metaRef.current[current.path] = updated;
      setFile(updated);
      setDirty(false);
      setNote('已保存');
      void refreshReview({ silent: true });
    } catch (error) {
      if (!isCurrent(sessionId, epoch)) return
      if (error.code === 'editor-file/stale') {
        setNote('文件已被改动：已拒绝覆盖。正在刷新最新内容');
        try {
          const fresh = await readFileText(activeSession, current.path);
          if (!isCurrent(activeSession, epoch)) return
          if (!fresh.oversized && !fresh.binary) {
            const updated = { ...current, original: fresh.text, version: fresh.version, bytes: fresh.bytes };
            metaRef.current[current.path] = updated;
            host.setText(current.path, fresh.text);
            setFile(updated);
            setDirty(false);
            setNote('文件已被改动：已刷新，请重新审阅');
          }
        } catch {
          /* 刷新失败就保留提示 */
        }
      } else if (error.code === 'editor-file/root-unresolved') {
        setNote(`无法解析工作区根：${error.message}${error.tried ? `（试过：${error.tried.join(' / ')}）` : ''}`);
      } else {
        setNote(`保存失败：${describeError(error)}`);
      }
    } finally {
      if (isCurrent(activeSession, epoch)) setSaving(false);
    }
  }

  saveRef.current = save;

  function markHandled(file, hunk, state, message) {
    setReview((prev) => {
      const handled = new Map(prev.handled);
      handled.set(hunk.id, state);
      const total = prev.data?.totals?.hunks ?? 0;
      const complete = total > 0 && handled.size >= total;
      return { ...prev, handled, message, complete: complete || prev.complete }
    });
  }

  function keepHunk(file, hunk) {
    if (review.handled.has(hunk.id)) return
    const index = file.hunks.findIndex((item) => item.id === hunk.id);
    markHandled(file, hunk, 'kept', `已保留第 ${index + 1} 块，共 ${file.hunks.length} 块`);
  }

  /** 一次把队列里所有块标成保留（不写盘）；用于大队列清空与 #5 的自动退出。 */
  function keepAllHunks() {
    const data = review.data;
    if (!data) return
    setReview((prev) => {
      const handled = new Map(prev.handled);
      let total = 0;
      for (const batch of data.turns ?? []) {
        for (const file of batch.files ?? []) {
          for (const hunk of file.hunks ?? []) {
            handled.set(hunk.id, 'kept');
            total += 1;
          }
        }
      }
      const complete = total > 0 && handled.size >= total;
      return { ...prev, handled, message: `已全部保留（${total} 块）`, complete: complete || prev.complete }
    });
  }

  async function rollbackHunk(file, hunk) {
    if (!sessionId || review.handled.has(hunk.id) || busy || narrow) return
    const epoch = sessionEpochRef.current;
    setBusy(true);
    setReview((prev) => ({ ...prev, message: '' }));
    try {
      const current = await readFileText(sessionId, file.path);
      if (!isCurrent(sessionId, epoch)) return
      if (current.oversized || current.binary) {
        setReview((prev) => ({ ...prev, message: '这个文件不能按块回滚' }));
        return
      }
      if (!hunk.newText) {
        setReview((prev) => ({ ...prev, message: '纯删除块没有可定位的位置，无法自动回滚' }));
        return
      }
      const candidates = [hunk.newText];
      if (current.text.includes('\r\n')) candidates.push(hunk.newText.replace(/\n/g, '\r\n'));
      let located = null;
      for (const candidate of candidates) {
        if (!candidate) continue
        let at = -1;
        if (Number(hunk.newStart) > 0) {
          const offset = offsetOfLine(current.text, Number(hunk.newStart));
          if (offset >= 0 && current.text.startsWith(candidate, offset)) at = offset;
        }
        if (at < 0) at = current.text.indexOf(candidate);
        if (at >= 0) {
          located = {
            at,
            newText: candidate,
            oldText: candidate.includes('\r\n') ? (hunk.oldText ?? '').replace(/\n/g, '\r\n') : (hunk.oldText ?? ''),
          };
          break
        }
      }
      if (!located) {
        await refreshFileAfterConflict(file.path);
        if (!isCurrent(sessionId, epoch)) return
        setReview((prev) => ({ ...prev, message: '文件已被改动，已刷新；请重新审阅这一块' }));
        return
      }
      const at = located.at;
      const result = await post('/applyPatch', {
        sessionId,
        path: file.path,
        baseVersion: current.version,
        edits: [{ from: at, to: at + located.newText.length, text: located.oldText }],
      });
      if (!isCurrent(sessionId, epoch)) return
      const nextText = current.text.slice(0, at) + located.oldText + current.text.slice(at + located.newText.length);
      const meta = metaRef.current[file.path];
      if (meta) {
        meta.original = nextText;
        meta.version = result.version;
        meta.bytes = result.bytes;
        try {
          hostRef.current?.setText?.(file.path, nextText);
        } catch {
          /* 忽略 */
        }
        if (fileRef.current?.path === file.path) {
          setFile({ ...meta });
          setDirty(isDirtyPath(file.path));
        }
      }
      const index = file.hunks.findIndex((item) => item.id === hunk.id);
      markHandled(file, hunk, 'rolledback', `已回滚第 ${index + 1} 块，共 ${file.hunks.length} 块`);
      void refreshReview({ silent: true });
    } catch (error) {
      if (!isCurrent(sessionId, epoch)) return
      if (error.code === 'editor-file/stale') {
        setReview((prev) => ({ ...prev, message: '文件已被改动，已刷新；请重新审阅这一块' }));
        await refreshFileAfterConflict(file.path);
        if (!isCurrent(sessionId, epoch)) return
      } else {
        setReview((prev) => ({ ...prev, message: `回滚失败：${describeError(error)}` }));
      }
    } finally {
      if (isCurrent(sessionId, epoch)) setBusy(false);
    }
  }

  async function refreshFileAfterConflict(path) {
    if (!sessionId) return
    const epoch = sessionEpochRef.current;
    try {
      const fresh = await readFileText(sessionId, path);
      if (!isCurrent(sessionId, epoch)) return
      if (fresh.binary || fresh.oversized) return
      const meta = metaRef.current[path];
      if (meta) {
        meta.original = fresh.text;
        meta.version = fresh.version;
        meta.bytes = fresh.bytes;
        hostRef.current?.setText?.(path, fresh.text);
        if (fileRef.current?.path === path) {
          setFile({ ...meta });
          setDirty(isDirtyPath(path));
        }
      }
    } catch {
      /* 刷新失败保留原状态 */
    }
  }

  /**
   * 宿主切工作台时默认打开 recentSessions，不是刚才的会话。这里把 nativeLocation
   * （切工作台前所在的会话）绑定到当前工作台并切过去；只改本地归属，不动会话内容。
   */
  async function useNativeSession() {
    const target = service?.nativeLocation?.sessionId;
    const owner = entry?.id;
    if (!target || !owner) return
    if (typeof service?.commit !== 'function' || typeof service?.openSession !== 'function') {
      setNote('宿主没有提供绑定会话的接口');
      return
    }
    setBindingBusy(true);
    try {
      const bound = service?.state?.sessionBindings?.[target];
      if (bound && bound !== owner) {
        setNote('这个会话已属于另一个工作台');
        return
      }
      await service.commit((state) => {
        if (!state.sessionBindings[target]) state.sessionBindings[target] = owner;
        state.recentSessions[owner] = target;
      });
      service.openSession(target);
    } catch (error) {
      setNote(`切换会话失败：${describeError(error)}`);
    } finally {
      setBindingBusy(false);
    }
  }

  function openReview() {
    setMode('review');
    setReview((prev) => ({ ...prev, message: '', complete: false }));
    void refreshReview();
  }

  /**
   * 宿主的文件卡片属于宿主自己的 React 树（portal 进 drawer 的 DOM）：我们的
   * React onClick 不会触发，但原生捕获监听会。卡片可能是 button/div，文件名在
   * text/title/aria-label 里，默认点击会打开右侧预览——捕获阶段截住并改走编辑器。
   */
  const openFileAtRef = React.useRef(openFileAt);
  openFileAtRef.current = openFileAt;

  function parseChatFileTarget(target, root) {
    let node = target;
    while (node && node !== root) {
      const candidates = [];
      if (node.tagName === 'A') candidates.push(node.getAttribute('href') ?? '');
      if (node.getAttribute) {
        const title = node.getAttribute('title');
        const label = node.getAttribute('aria-label');
        if (title) candidates.push(title);
        if (label) candidates.push(label);
      }
      if (node.childElementCount === 0 || node.tagName === 'BUTTON' || node.getAttribute?.('role') === 'button') {
        candidates.push(node.textContent ?? '');
      }
      for (const text of candidates) {
        const found = parseFileLinkLoose(text);
        if (found) return found
      }
      node = node.parentElement;
    }
    return null
  }

  React.useEffect(() => {
    if (!showChat) return undefined
    const pick = (event) => {
      const node = chatNodeRef.current;
      if (!node || !(event.target instanceof Node) || !node.contains(event.target)) return null
      return parseChatFileTarget(event.target instanceof Element ? event.target : event.target.parentElement, node)
    };
    // 指针按下只阻断宿主（有的实现按 pointerdown 就开预览），真正的跳转等 click。
    const suppress = (event) => {
      if (!pick(event)) return
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    const activate = (event) => {
      const parsed = pick(event);
      if (!parsed) return
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      openFileAtRef.current(parsed.path, parsed.line, parsed.column);
    };
    document.addEventListener('pointerdown', suppress, true);
    document.addEventListener('mousedown', suppress, true);
    document.addEventListener('click', activate, true);
    return () => {
      document.removeEventListener('pointerdown', suppress, true);
      document.removeEventListener('mousedown', suppress, true);
      document.removeEventListener('click', activate, true);
    }
  }, [showChat]);

  function insertIntoComposer(text) {
    const node = chatNodeRef.current;
    if (!node) return false
    const input = node.querySelector('textarea, [contenteditable="true"]');
    if (!input) return false
    try {
      input.focus();
      if (input.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(input, `${input.value}${input.value && !input.value.endsWith(' ') ? ' ' : ''}${text}`);
        else input.value += text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        document.execCommand('insertText', false, text);
      }
      return true
    } catch {
      return false
    }
  }

  function quoteSelection() {
    const host = hostRef.current;
    const current = fileRef.current;
    if (!host || !current) {
      setNote('先打开一个文件再引用选区');
      return
    }
    const selection = host.getSelection();
    if (!selection || !selection.text) {
      setNote('先在编辑器里选中一段');
      return
    }
    const id = `${current.path}:${selection.startLine}:${selection.endLine}:${selection.startColumn}:${selection.endColumn}`;
    if (chatRefsSet.current.has(id)) {
      setNote('这个选区已经在对话引用里了');
      return
    }
    chatRefsSet.current.add(id);
    const ref = {
      id,
      path: current.path,
      startLine: selection.startLine,
      endLine: selection.endLine,
      preview: selection.text.slice(0, 160),
    };
    setChatRefs((prev) => [...prev, ref]);
    setShowChat(true);
    const refText = `@${current.path}#L${selection.startLine}-L${selection.endLine} `;
    let attempts = 0;
    const tryInsert = () => {
      attempts += 1;
      if (insertIntoComposer(refText)) {
        setNote('引用已送进对话');
        return
      }
      if (attempts < 6) {
        setTimeout(tryInsert, 250);
        return
      }
      setNote('已生成引用；没找到对话输入框，可手动粘贴');
      try {
        void navigator.clipboard?.writeText(refText);
      } catch {
        /* 忽略 */
      }
    };
    setTimeout(tryInsert, 250);
  }

  async function openInSystem(target) {
    try {
      const remoteSession = client?.remote?.session;
      if (!remoteSession || typeof remoteSession.openWorkspacePath !== 'function') {
        setNote('宿主没有提供打开本地文件的能力');
        return
      }
      const result = await remoteSession.openWorkspacePath({ path: target.absolutePath, action: 'open' });
      if (result && result.ok === false) throw new Error(result.error?.message ?? '打开失败')
    } catch (error) {
      setNote(`打开失败：${describeError(error)}`);
    }
  }

  // 工作台模式下原生的「新会话 / 添加工作区 / 工作区选择器」最后都走
  // uiWorkspace.startSession，而 dsh-desktop-workbenches 为了让入口不绕过工作台，
  // 注册了一个 sessionStarter：只要工作台开着且 active 就返回 true（=已处理），
  // 但它自己并不创建会话。结果是选完目录后静默无反应——工作台里换不了工作区。
  // 这里给面板一个真能落地的入口：直接调工作台服务建会话。
  const workbenchSwitchable = Boolean(service && typeof service.newSession === 'function');
  const workbenchWorkspaces =
    workbenchSwitchable && typeof service.visibleWorkspaces === 'function' ? service.visibleWorkspaces() || [] : [];
  const currentWorkspaceId =
    (sessionId &&
      workbenchWorkspaces.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId))
        ?.workspaceId) ||
    '';
  const [workspaceBusy, setWorkspaceBusy] = React.useState(false);
  const switchWorkspace = (workspaceId) => {
    if (!workspaceId || workspaceBusy) return
    setWorkspaceBusy(true);
    Promise.resolve()
      .then(() => service.newSession(workspaceId))
      .catch((error) => setNote(`切换工作区失败：${describeError(error)}`))
      .finally(() => setWorkspaceBusy(false));
  };
  const createWorkspace = () => {
    if (workspaceBusy) return
    setWorkspaceBusy(true);
    Promise.resolve()
      .then(() => service.newWorkspaceSession())
      .catch((error) => setNote(`新建工作区失败：${describeError(error)}`))
      .finally(() => setWorkspaceBusy(false));
  };

  const title = (entry && (entry.panelTitle || entry.title)) || '资源管理器';
  const hasApi = Boolean(filesApi());
  const pendingReview = Math.max(0, (review.data?.totals?.hunks ?? 0) - review.handled.size);
  const selectedFile = file;

  const toolbar = h(
    'div',
    { className: 'dce_toolbar' },
    h('span', { className: 'dce_title' }, title),
    h('span', { className: 'dce_badge' }, 'Monaco'),
    workbenchSwitchable && workbenchWorkspaces.length > 0
      ? h(
          'select',
          {
            className: 'dce_save',
            style: { maxWidth: 160 },
            value: currentWorkspaceId,
            disabled: workspaceBusy,
            title: '切换工作区：在这个工作台里开一个新会话',
            'aria-label': '切换工作区',
            onChange: (event) => switchWorkspace(event.target.value),
          },
          ...(currentWorkspaceId ? [] : [h('option', { key: '__none', value: '' }, '选择工作区…')]),
          ...workbenchWorkspaces.map((item) =>
            h('option', { key: item.workspaceId, value: item.workspaceId }, item.title || item.path || item.workspaceId)
          )
        )
      : null,
    workbenchSwitchable
      ? h(
          'button',
          {
            type: 'button',
            className: 'dce_save',
            disabled: workspaceBusy,
            title: '新建工作区并开始对话（选一个目录）',
            onClick: createWorkspace,
          },
          '＋工作区'
        )
      : null,
    h(
      'button',
      { type: 'button', className: 'dce_save', onClick: () => setShowChat((value) => !value) },
      showChat ? '收起对话' : '对话'
    ),
    h(
      'button',
      {
        type: 'button',
        className: 'dce_save',
        onClick: mode === 'review' ? () => setMode('files') : openReview,
        'aria-label': pendingReview > 0 ? `审阅，待处理 ${pendingReview} 块` : '审阅',
      },
      mode === 'review' ? '返回文件' : '审阅',
      pendingReview > 0 ? h('span', { className: 'dce_reviewBadge', style: { marginLeft: 6 } }, String(pendingReview)) : null
    ),
    selectedFile && !selectedFile.binary && !selectedFile.missing && !selectedFile.oversized && !narrow
      ? h('button', { type: 'button', className: 'dce_save', onClick: quoteSelection }, '引用选区')
      : null,
    h(
      'div',
      { className: 'dce_crumbs' },
      h('button', { type: 'button', className: 'dce_crumb', onClick: () => setDir('') }, '工作区'),
      ...dir
        .split('/')
        .filter(Boolean)
        .map((part, index, parts) => {
          const path = parts.slice(0, index + 1).join('/');
          return h(
            React.Fragment,
            { key: path },
            h('span', { className: 'dce_sep' }, '›'),
            h('button', { type: 'button', className: 'dce_crumb', onClick: () => setDir(path) }, part)
          )
        })
    )
  );

  const diag = h(
    'div',
    { className: 'dce_diag', role: 'status', 'aria-label': '编辑器状态栏' },
    h('span', { className: service ? 'dce_diagOk' : 'dce_diagBad' }, `服务 ${service ? 'ok' : '缺'}`),
    h('span', { className: hasApi ? 'dce_diagOk' : 'dce_diagBad' }, `读接口 ${hasApi ? 'ok' : '缺'}`),
    h('span', null, `内核 ${hostState}`),
    h('span', null, `会话 ${sessionId ? sessionId.slice(0, 12) : '无'}`),
    h('span', null, `审阅 ${pendingReview}`),
    file && !file.binary && !file.error && !file.missing ? h('span', null, languageOf(file.path)) : null,
    file ? h('span', null, formatBytes(file.bytes ?? 0)) : null
  );

  let body;
  if (!sessionId) {
    body = h('div', { className: 'dce_empty' }, '这个工作台还没有开始对话。');
  } else {
    const rows = [];
    if (dir) {
      rows.push(
        h(
          'button',
          {
            key: 'up',
            type: 'button',
            className: 'dce_row',
            onClick: () => setDir(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''),
          },
          h('span', { className: 'dce_icon' }, '↰'),
          h('span', { className: 'dce_name' }, '上一级')
        )
      );
    }
    for (const item of listing ? Array.from(listing.entries || []) : []) {
      const isDir = item.type === 'directory';
      const isFile = item.type === 'file';
      const childPath = dir ? `${dir}/${item.name}` : item.name;
      const kind = isDir ? 'dir' : iconKind(item.name);
      rows.push(
        h(
          'button',
          {
            key: childPath,
            type: 'button',
            className: 'dce_row',
            'data-active': file && file.path === childPath ? 'true' : 'false',
            disabled: !isDir && !isFile,
            onClick: isDir ? () => setDir(childPath) : isFile ? () => void openFile(childPath) : undefined,
          },
          h('span', { className: 'dce_icon', 'data-kind': kind }, isDir ? '▸' : iconGlyph(kind)),
          h('span', { className: 'dce_name' }, isDir ? `${item.name}/` : item.name)
        )
      );
    }
    const tree = h(
      'div',
      { className: 'dce_tree' },
      h(
        'div',
        { className: 'dce_treeHead' },
        h('span', null, '工作区'),
        dir ? h('span', { className: 'dce_treePath', title: dir }, dir) : null
      ),
      listingError ? h('div', { className: 'dce_error' }, listingError) : null,
      listingBusy && !listing ? h('div', { className: 'dce_note' }, '读取中…') : null,
      listing && rows.length === 0 ? h('div', { className: 'dce_note' }, '这个目录是空的') : null,
      rows
    );

    const viewBar = h(
      'div',
      { className: 'dce_viewBar' },
      h('span', { className: 'dce_viewPath' }, file ? file.path : ''),
      file && !file.binary && !file.error && !file.missing ? h('span', null, languageOf(file.path)) : null,
      file && file.readOnly ? h('span', null, '只读') : null,
      file && !file.binary && !file.error && !file.missing
        ? dirty
          ? h('span', { className: 'dce_dirty' }, '● 未保存')
          : h('span', null, '已保存')
        : null,
      file && !file.binary && !file.error && !file.missing && !file.readOnly && !narrow
        ? h(
            'button',
            {
              type: 'button',
              className: 'dce_save',
              disabled: saving || !dirty || !file.version,
              onClick: () => void save(),
            },
            saving ? '保存中…' : '保存'
          )
        : null,
      file && file.readOnly && file.absolutePath
        ? h('button', { type: 'button', className: 'dce_save', onClick: () => void openInSystem(file) }, '用系统编辑器打开')
        : null
    );

    let view;
    if (!file) {
      view = h('div', { className: 'dce_empty' }, narrow ? '窄屏只读模式：从左边选一个文件' : '从左边选一个文件');
    } else if (file.error && !file.missing) {
      view = h('div', { className: 'dce_view' }, viewBar, h('div', { className: 'dce_error' }, file.error));
    } else if (file.missing) {
      view = h('div', { className: 'dce_view' }, viewBar, h('div', { className: 'dce_empty' }, '文件不存在；可能已被删除。可以关闭这个标签。'));
    } else if (file.binary) {
      view = h('div', { className: 'dce_view' }, viewBar, h(BinaryPreview, { sessionId, path: file.path, file, onOpenInSystem: openInSystem }));
    } else if (file.oversized) {
      view = h(
        'div',
        { className: 'dce_view' },
        viewBar,
        h(
          'div',
          { className: 'dce_empty' },
          `文件超过 ${formatBytes(LARGE_FILE_BYTES)}，不在面板里打开；可用系统编辑器打开。`
        )
      );
    } else if (narrow) {
      view = h(
        'div',
        { className: 'dce_view' },
        viewBar,
        h('div', { className: 'dce_banner' }, '窄屏只读模式：不加载编辑器内核，不能编辑。'),
        h('pre', { className: 'dce_preview' }, file.original ?? '')
      );
    } else {
      view = h(
        'div',
        { className: 'dce_view' },
        viewBar,
        note ? h('div', { className: 'dce_note' }, note) : null,
        versionError ? h('div', { className: 'dce_error' }, `取版本失败：${versionError}`) : null,
        file.readOnly
          ? h('div', { className: 'dce_banner' }, `文件超过 ${formatBytes(LARGE_FILE_BYTES)}，已退为只读。`)
          : null,
        h(EditorSurface, {
          file,
          readOnly: file.readOnly === true,
          theme: scheme,
          hostRef,
          fileRef,
          saveRef,
          pendingRef: pendingPositionRef,
          onStatus: setHostState,
          onDirty: setDirty,
          onViewState: (state) => {
            if (state?.path) positionsRef.current[state.path] = state;
          },
        })
      );
    }
    const tabStrip =
      openFiles.length > 0
        ? h(
            'div',
            { className: 'dce_tabs' },
            ...openFiles.map((path) => {
              const active = file && file.path === path;
              const meta = metaRef.current[path];
              const dirtyNow = meta && hostRef.current && !meta.binary && !meta.missing ? hostRef.current.getText(path) !== meta.original : false;
              return h(
                'div',
                { key: path, className: 'dce_tab', 'data-active': active ? 'true' : 'false' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: `dce_tabName${meta?.missing ? ' dce_tabMissing' : ''}`,
                    title: path,
                    onClick: () => (metaRef.current[path] ? activate(path) : void openFile(path)),
                  },
                  baseName(path)
                ),
                dirtyNow ? h('span', { className: 'dce_tabDot' }, '●') : null,
                h('button', { type: 'button', className: 'dce_tabClose', title: '关闭', onClick: () => closeTab(path) }, '×')
              )
            })
          )
        : null;

    body = h(
      'div',
      { className: 'dce_body' },
      tree,
      h('div', { className: 'dce_col' }, tabStrip, view),
      mode === 'review'
        ? h(ReviewPanel, {
            narrow,
            review,
            handled: review.handled,
            selectedFileKey: review.selectedFile,
            selectedHunkId: review.selectedHunk,
            busy,
            message: review.message,
            onSelectFile: (key) =>
              setReview((prev) => {
                const batch = prev.data?.turns.find((item) => key.startsWith(`${item.turn}\u0000`));
                const changed = batch?.files.find((item) => key === `${batch.turn}\u0000${item.path}`);
                return { ...prev, selectedFile: key, selectedHunk: changed?.hunks?.[0]?.id ?? null }
              }),
            onSelectHunk: (id) => setReview((prev) => ({ ...prev, selectedHunk: id })),
            onKeep: keepHunk,
            onKeepAll: keepAllHunks,
            onRollback: rollbackHunk,
            onExit: () => setMode('files'),
            onRefresh: () => void refreshReview(),
            onOpenFile: (changed, hunk) => {
              setMode('files');
              void openFileAt(changed.path, hunk?.newStart || 1, 1);
            },
          })
        : null
    );
  }

  const nativeSession = service?.nativeLocation?.sessionId ?? null;
  const nativeOwner = nativeSession ? service?.state?.sessionBindings?.[nativeSession] : null;
  const nativeBannerKey = nativeSession && sessionId ? `${sessionId}\u0000${nativeSession}` : '';
  const nativeBanner =
    nativeSession &&
    sessionId &&
    nativeSession !== sessionId &&
    (!nativeOwner || nativeOwner === entry?.id) &&
    dismissedNativeBanner !== nativeBannerKey
      ? h(
          'div',
          { className: 'dce_banner' },
          h('span', null, '这个工作台打开的是另一个会话。'),
          h(
            'button',
            { type: 'button', className: 'dce_save dce_primary', disabled: bindingBusy, onClick: () => void useNativeSession() },
            bindingBusy ? '切换中…' : '用刚才的会话打开'
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dce_bannerClose',
              title: '关闭提示',
              'aria-label': '关闭提示',
              onClick: () => {
                dismissedNativeBannerKey = nativeBannerKey;
                setDismissedNativeBanner(nativeBannerKey);
              },
            },
            '×'
          )
        )
      : null;

  return h(
    'div',
    { className: 'dce_root', ref: rootRef, 'data-dce-theme': scheme ?? undefined },
    toolbar,
    nativeBanner,
    body,
    diag,
    showChat
      ? h(
          'div',
          { className: 'dce_chat', ref: chatBoxRef },
          h('div', {
            className: 'dce_chatGrip',
            title: '拖动调整对话宽度，双击复位',
            'aria-hidden': 'true',
            onPointerDown: startChatResize,
            onPointerMove: moveChatResize,
            onPointerUp: endChatResize,
            onPointerCancel: endChatResize,
            onDoubleClick: resetChatWidth,
          }),
          h(
            'div',
            { className: 'dce_chatBar' },
            h('span', null, '对话'),
            ...chatRefs.slice(-3).map((ref) =>
              h('span', { key: ref.id, className: 'dce_chip', title: ref.preview }, `${ref.path} L${ref.startLine}-${ref.endLine}`)
            ),
            h(
              'button',
              { type: 'button', className: 'dce_save', onClick: () => setChatRetry((value) => value + 1), title: '重新尝试挂载宿主的会话面板' },
              '重试挂载'
            ),
            h('button', { type: 'button', className: 'dce_save', onClick: () => setShowChat(false) }, '收起')
          ),
          h(
            'div',
            { className: 'dce_chatBody' },
            conversationAttached ? h('div', { className: 'dce_chatMount', ref: setChatMount, key: chatRetry }) : null,
            !conversationAttached || chatEmpty
              ? h(
                  'div',
                  { className: 'dce_chatFallback', role: 'status' },
                  h('strong', null, '对话面板没有挂载'),
                  h('span', null, '这次进入工作台时宿主没有把会话内容交给编辑器。'),
                  h('span', null, '点「收起」后，从左侧模式菜单切到「会话」再切回「资源管理器」，对话就会回来。'),
                  h('span', null, '如果一直这样，点「重试挂载」或再按一次 Ctrl+R。')
                )
              : null
          )
        )
      : null,
    showChat && conversationAttached && chatNode ? ReactDOM.createPortal(conversation, chatNode) : null
  )
}

function apply(ctx) {
  client = ctx;
  ensureStyle();
  ctx.effect(
    () =>
      ctx.desktopWorkbenches.register(
        {
          title: '资源管理器',
          panelTitle: '资源管理器',
          description: '在对话旁浏览、修改与逐块审阅工作区文件（Monaco 内核）。',
          repository: 'https://github.com/roninni/dsh-central-editor',
          customFrame: true,
          layout: { businessSide: 'right', businessWidth: 0.62 },
        },
        EditorPanel
      ),
    'central-editor: workbench panel'
  );
}
const inject = ['desktopWorkbenches', 'remote', 'remote.workspaceFiles'];

exports.apply = apply;
exports.iconGlyph = iconGlyph;
exports.iconKind = iconKind;
exports.inject = inject;

return module.exports;
} });
