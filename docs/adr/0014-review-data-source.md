# 审阅数据：实时 workspaceChanges + 转录 diffs 兜底

**状态**：接受（2026-11-07），服务于 #5「审阅视图」与 #6「逐块回滚」。

**决定**：

- **Review Batch（审阅批次）= 一轮对话的改动**；**Review Queue（审阅队列）= 当前 Session 尚未处置的全部批次**。界面按轮次分组，文件下再列 hunk。
- 数据分两层读取：
  1. **实时层**：`ctx.workspaceChanges.summary(sessionId, seq)` + `diff(sessionId, seq, index)`。每轮开始/结束时对工作区做完整对比，能覆盖 shell 与其它工具的改动，给出 `+N −M` 和带三行上下文的 hunk；摘要、快照与对比只活在 Host 进程里，重启后消失。
  2. **持久层**：`session.log` 里 `tool/result.meta.diffs`。`write`/`edit` 的每个 hunk 携带 `oldText` / `newText`，落会话转录，重启后仍在。
- **合并规则**：按「轮次 + 路径」合并。实时层拿到该路径的整轮 diff 时，以实时层为权威，覆盖持久层同路径的逐次 hunk；实时层缺失或读取失败时用持久层；实时层只有摘要、没有 diff 时保留持久层 hunk，行数沿用摘要。
- **没有基线就明说**：`create` 且没有 hunk、`binary`、`oversized`、只有摘要没有 diff，分别标「新增（无基线）」「二进制」「超大」「无基线」，不画空 diff，也不报错。`workspaceChanges` 服务不可用时，命令行/子代理直接改的文件无法枚举，审阅界面明示覆盖缺口；write/edit 仍从转录逐块审阅。
- **Keep 不写盘**：保留只改本地处置状态并让角标递减。**Rollback 是唯一写盘动作**：客户端按 hunk 的 `newText` 精确定位（CRLF 文件同时尝试 CRLF 文本），用 `applyPatch` 的反向补丁只替换这一段；版本对不上就拒绝并刷新该文件。纯删除 hunk 的 `newText` 为空，没有可定位位置，拒绝自动回滚而不是猜位置。
- **UI 不抢占编辑面**：审阅面是 `.dce_body` 上的覆盖层，编辑面不卸载，Monaco model、光标与未保存改动都保留；diff 用同一内核 chunk 的只读 diff editor。

**Consequences**：

- Host 重启后，write/edit 的历史轮次仍可审阅（本次会话已验证：重启前后两轮都从转录读回）；只经 shell 改的文件在重启后消失，这是实时层的既定边界。
- 审阅响应可能较大（本次会话 23 个文件、130 个 hunk、约 212 KB）；客户端按需刷新、审阅态每 10 秒轮询，编辑态不轮询。
- `workspaceChanges` 服务缺失时，文件列表只覆盖 write/edit；界面必须显示这一限制，不能把不完整当完整。

**Considered Options**：

- 只读 `workspaceChanges`：重启后历史全丢，与「重开应用仍能查看历史轮次」冲突，否决。
- 只读转录 diffs：看不到 shell 改动，也拿不到整轮 `+N −M`，否决。
- 自建工作区快照：成本、存储与并发问题都高，ADR-0009 已否决该方向。
