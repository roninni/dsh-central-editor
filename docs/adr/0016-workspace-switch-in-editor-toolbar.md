# 0016 工作台里切换工作区的入口归编辑器工具栏

- 状态：已采纳（2026-11-13）
- 相关：#8 三栏工作台、桌面工作台（`dsh-desktop-workbenches`）

## 背景

工作台（workbench）由 DSH Desktop 的 `dsh-desktop-workbenches` 管理，它为了让「全局入口不绕过工作台自己的创建流程」，
注册了一个全局 `sessionStarter`：

```js
// dsh-desktop-workbenches/client.js（随 app.asar 发布，不可改）
ctx.uiWorkspace.registerSessionStarter(() =>
  workbenchPreference.getSnapshot() && !!service.state.active)
```

而 `@deepseek-ai/dsh-client-ui-workspace` 的 `startSession()` 在拿到 `true` 时**直接返回**，把这次请求视为「已处理」：

```js
if (this.sessionStarter?.(workspaceId) === true) return
```

于是只要工作台开着且有一个 active 工作台，下面这些原生入口全部变成死路（点了没有任何反馈）：

- 侧栏「工作区」标题旁的 `＋`（添加工作区）：目录选择器能弹出来、能选完，之后静默无反应；
- 侧栏「新会话」行、工作区行上的「在此工作区新建会话」；
- 对话英雄区的「工作区选择器」。

实测（2026-11-13 20:44，本机）：`＋` → 「选择工作区目录」→ 选一个工作区目录 → 无新会话、
`storages/workspace.json` 无写入、无任何提示。会话记录里只有当前会话被写入，确认请求在客户端就被吞掉。

## 决策

在编辑器工具栏里放一组**自己的**工作区入口，直接调用工作台服务，而不是走 `uiWorkspace.startSession`：

- 工作区下拉：`service.visibleWorkspaces()` 列表，当前会话所在工作区为值；改动即 `service.newSession(workspaceId)`
  —— 由工作台自己建会话并绑定，和它内部的「在此工作区新建会话」是同一条路径；
- `＋工作区` 按钮：`service.newWorkspaceSession()` —— 原生选目录 → 注册工作区 → 建会话并绑定；
- 两个入口失败时把错误写进编辑器笔记（`setNote`），不再静默。

`service` 为 `EditorPanel` 已注入的工作台服务实例；`newSession` / `newWorkspaceSession` / `visibleWorkspaces`
都是它的公开方法，因此不需要替换全局 `sessionStarter`，也不与桌面插件的注册顺序抢位。

## 取舍

- **不改 app.asar**：桌面插件随安装包发布，改它会在升级时被覆盖，也超出本仓库范围。全局 `sessionStarter`
  仍归桌面插件，原生入口依旧是死路 —— 这是上游缺陷，值得反馈给 DSH Desktop。
- **不加全局入口**：另一条路是把 `registerSessionStarter` 换成调 `service.newSession` 的实现（单槽覆盖）。
  不选它：它会把桌面插件的行为整体改写，且工作台功能被关闭时容易和原生流程打架。
- **入口放在编辑器里**：工作台打开时编辑器就是业务面，用户在这里切工作区最直观；也符合「工作台自己管会话创建」。

## 影响

- 侧栏 `＋` / 原生工作区选择器在工作台模式下仍然无效（上游行为），需要在工作台里切请用编辑器工具栏。
- 想恢复原生入口：设置 → 通用 → 关掉「启用工作台功能」，加完再打开。
