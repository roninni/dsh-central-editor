# dsh-central-editor（资源管理器）

> [!WARNING]
> 🚧 **开发未完成，仍在测试中，请勿下载、请勿安装。** 当前为 0.3.0 预览版本，功能与接口随时可能改动，尚未发布任何正式版本；请等正式发布后再使用。

> DSH（DeepSeek Harness）桌面端的工作台插件：在对话旁边浏览、修改并逐块审阅工作区文件。界面上的面板名是「资源管理器」。

许可证 [MIT](LICENSE)。设计取舍记在 [`docs/adr/`](docs/adr/)。

## 功能

- **文件树 + Monaco 编辑器**：内核分块按需加载，首次打开文件时才下载约 2 MB gzip 的 Monaco 分块；之后切文件不再下载，也不重建编辑器实例。
- **逐块审阅与回滚**：按对话轮次分组，文件显示 `+N −M` 与块数；逐块 hunk、选中块用 Monaco diff 对比；保留只改本地状态，回滚走唯一写入口。
- **对话 ↔ 编辑器双向指路**：对话里的 `a.ts:10` / `./a.ts#L10` 跳到文件与行；编辑器选区一键送进对话输入框。
- **工作区切换入口**：工作台模式下原生入口被桌面工作台插件接管，编辑器工具栏自带工作区下拉与 `＋工作区`。
- **会话提示条与对话抽屉**：抽屉贴面板右侧，可拖拽调宽（双击复位），宽度跨刷新保留。
- **边界处理**：大文件只读、二进制预览、符号链接拒绝、窄屏降级、面板不自曝异常。

## 安装

前提：DSH Desktop（带 `dsh-desktop-workbenches` 的版本）。插件已提交构建产物 `lib/`，直接装即可，不需要先构建。

### 方式一：克隆后跑脚本（推荐）

```powershell
git clone https://github.com/roninni/dsh-central-editor.git
cd dsh-central-editor
node scripts/install-local.mjs --profile "C:\Users\<你>\AppData\Roaming\dsh-desktop\harness\profiles\web"
```

- 先加 `--dry-run` 可以只看会改什么，不写盘。
- `--uninstall` 卸载（同样会先备份 profile 的 `package.json`）。
- 不给 `--profile` 时，Windows 上默认找 `%APPDATA%\dsh-desktop\harness\profiles\web`，也可以用环境变量 `DSH_PROFILE` 指定。
- 装完在应用窗口里按 `Ctrl+R` 重新加载即可，客户端脚本由宿主按需从磁盘取。

脚本做的事：在 profile 的 `package.json` 里登记 `dependencies` 与 `pnpm.overrides`（`link:` 指向本仓）、把包名追加进 `dsh.profile.bundles`、再在 profile 的 `node_modules` 下建一个目录联接（junction）。幂等，重复执行不会重复追加。

### 方式二：手动

1. 克隆本仓到任意目录。
2. 编辑 DSH profile 的 `package.json`（改前先备份）：
   - `dependencies["dsh-central-editor"] = "link:<本仓绝对路径>"`
   - `pnpm.overrides["dsh-central-editor"]` 写同一个值
   - `dsh.profile.bundles` 数组里追加 `"dsh-central-editor"`
3. 在 profile 的 `node_modules` 下建目录联接指向本仓：

   ```powershell
   New-Item -ItemType Junction -Path "<profile>\node_modules\dsh-central-editor" -Target "<本仓绝对路径>"
   ```

4. 应用内 `Ctrl+R`。

### 改了 `src/` 之后

```powershell
npm install
npm run build    # 两个产物一起产出：lib/client.js 与 lib/client.monaco.js
```

客户端入口是构建产物，宿主读的是 `lib/client.js`，不改 `src/` 直接改 `lib/` 会在下次构建时被覆盖。

## 开发

```powershell
npm install
npm run build    # 面板 + Monaco 内核分块
npm test         # 七组：路径守卫 / 审阅模型 / 对话链接 / 抽屉宽度 / 服务端路由 / 安全 / 面板隔离
```

测试脚本直接跑各测试文件，而不是 `node --test`：某些受限环境下 `node --test` 会因 `spawn EPERM` 失败。

## 审阅与回滚

- **审阅队列**按轮次分组：文件列表显示 `+N −M` 与块数；点文件看逐块 hunk，选中块用 Monaco diff 查看。
- 数据来自两层：`workspaceChanges` 的逐轮摘要/对比（实时，覆盖 shell），以及会话转录里的 `tool/result.meta.diffs`（write/edit 逐块，重启后仍在）。详见 [`docs/adr/0014-review-data-source.md`](docs/adr/0014-review-data-source.md)。
- **保留**只改本地状态，不写盘；**回滚**走唯一写入口 `applyPatch`，只替换目标 hunk，版本不符就拒绝并刷新。
- 键盘：`n/↓` 下一块、`p` 保留、`r` 回滚、`Esc` 退出。角标显示待处理块数，处理完自动退出并提示。
- 连接两个方向的指路：对话里的 `a.ts:10` / `./a.ts#L10` 链接跳到文件与行；编辑器选区可一键送进对话输入框（同一选区不重复插入）。

## 切换工作区

工作台模式下，原生的「新会话 / 添加工作区 / 工作区选择器」都被桌面工作台插件的全局 `sessionStarter` 接管而变成死路（选完目录没有任何反应）。编辑器工具栏因此自带一组入口：工作区下拉（`service.newSession`）与 `＋工作区`（`service.newWorkspaceSession`）。取舍见 [`docs/adr/0016-workspace-switch-in-editor-toolbar.md`](docs/adr/0016-workspace-switch-in-editor-toolbar.md)。

## 会话提示条

宿主切工作台时默认打开 `recentSessions` 而不是刚才的会话，面板顶部因此有一条提示「这个工作台打开的是另一个会话」，右按钮「用刚才的会话打开」把 `nativeLocation` 绑到本工作台并切过去。提示条最右侧的 `×` 关掉的是**这一对**「当前会话 + 原生会话」：记录放在模块级（`dismissedNativeBannerKey`），切视图、重挂面板都不再弹；刷新页面会重新提示一次，避免把唯一的切换入口永久关掉。配对变了（换会话/换工作台）提示照常出现。

## 对话抽屉

抽屉贴在工作台面板右边，默认宽度 `min(460px, 58%)`。左边缘有一条拖拽条（悬停变蓝、`cursor: col-resize`）：按住拖动即可改宽度，范围为 `240px` 到「面板宽度 − 40px」（拉满时留 40px 给左侧文件树/编辑区，免得拖不回来）；双击复位为默认宽度。宽度存在浏览器 localStorage 的 `dce.chatWidth.v1`，跨会话、跨刷新都保留；窗口变窄时 `max-width:100%` 兜底。夹取规则是纯函数 [`clampChatWidth`](src/chat-resize.js)，有单测。

拖动全程**不重渲染**：宽度写成 root 上的 CSS 变量 `--dce-chat-width`（React 不接管这条属性，重渲染也盖不掉），`pointermove` 用 `requestAnimationFrame` 合帧，拖拽态写成抽屉上的 `data-resizing`（顺手让抽屉内容 `pointer-events:none`，停掉宿主会话里的悬停处理），松手才写 localStorage。第一版是每次 `pointermove` 都 `setState`，等于每帧重渲染文件树 + 编辑器宿主 + 抽屉，所以拖起来卡。

## 写通道

唯一写入口是 `/api/central-editor/applyPatch`（补丁式）：客户端只提交「公共前缀/后缀之间」那一段，服务端校验版本、过路径守卫、原子写、限流、审计（只记元数据）。版本对不上返回 `editor-file/stale`，不覆盖。

工作区根从 `session.header` 解析（`sessions.get(sessionId)` 是**同步**调用）；解析不到就拒绝写入，并把试过的候选回传。

## 目录

```
package.json        # npm 包 + DSH 插件声明（dsh.bundle.patch / dsh.client）
cordis.patch.yml    # 把服务端入口插进插件树
dsh/index.js        # 服务端：health / diag / stat / fileText / raw / review / applyPatch
dsh/review-model.js # 审阅纯函数：路径归一、hunk 还原与 ± 计数
dsh/path-guard.js   # 路径守卫：越界、绝对路径、UNC、设备名、ADS
src/client.js       # 客户端面板：编辑 / 审阅 / 导航 / 会话状态
src/monaco-host.js  # Monaco 单实例、model、diff host、主题
src/file-link.js    # 对话文件链接解析
src/chat-resize.js  # 对话抽屉宽度的夹取纯函数
src/session-state.js# 按 sessionId 存标签 / 激活项 / 光标 / 滚动
lib/client.js       # 客户端入口（构建产物，约 101 KB）
lib/client.monaco.js# 内核分块：Monaco，首次打开文件时经 require.async 取（约 10.9 MB raw）
scripts/install-local.mjs # 装进本机 DSH profile
docs/adr/           # 设计决策
test/               # 七组测试
```

## 已知边界

- 二进制文件不进编辑面：图片回 data URL 预览，其余显示前 256 字节十六进制；符号链接在读取时被拒绝。
- 超过 1 MB 的文件退为只读并说明原因，可用系统程序打开；超过 10 MB 不在面板里回文本。
- 窄屏（≤640px）不加载编辑器内核，只给只读文本预览与说明。
- 首次打开编辑器要下载一次内核分块（约 2 MB gzip）；之后切文件不再下载，也不重建编辑器实例。
- 审阅的实时层依赖 `workspaceChanges` 服务；本机未启用时只能从转录读 write/edit 改动，命令行/子代理直接改的文件无法枚举（界面会明示）。

## 踩过的坑（调宿主接口时一定会再遇到）

1. **Remote 返回的是信封，不是数据**：`{ ok: true, value }` / `{ ok: false, error: { code, message } }`。官方前端都是先判 `ok` 再取 `value`；把信封当数据用不会报错，只会静默得到空列表。
2. **根路径不能传空串**：`workspaceFiles.list(sessionId, '')` 会被网关判 `gateway/bad-request`，根目录传 `.`，子目录传相对路径。
3. **客户端构建后是两个文件**：入口 `lib/client.js` 只能注册一个 factory；Monaco 打进 `lib/client.monaco.js` 分块，入口用 `require.async("./client.monaco.js")` 取。分块名必须匹配宿主的 `^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$`，且必须与 `client.js` 同目录；样式在 factory 里注入一次（按 `data-plugin-css` 去重）。
4. **`src/client.js` 末尾的 `export const inject` 不能丢**：`['desktopWorkbenches','remote','remote.workspaceFiles']`。丢了会在 `apply(ctx)` 处抛 TypeError，整页 `ERR_ABORTED`，启动恢复界面把插件判为罪魁。改完必须重新 `npm run build`，宿主读的是 `lib/client.js`。
5. **不要往 `dsh.client.inject` 里加不在 boot graph 的包**：缺提供方会让客户端组合失败；`remote.session` 直接从已注入的 `remote` 代理取。
6. **面板不要抛异常**：宿主会用「工作台加载失败」盖掉一切，连原因都看不到。面板自带 try/catch 与错误边界，底部留一行自检（服务 / 读接口 / 会话 / 环境错误）。
7. **会话由工作台服务给**：面板 props 里拿到 `service`，用 `service.currentSession()` + `service.subscribe()` 跟踪当前会话；不要自己从路由或设置猜。

## 许可证

[MIT](LICENSE)
