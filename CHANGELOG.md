# Changelog

## Unreleased

## 0.3.19 — 2026-11-28

- Count image attachments at their inline base64 request size in the fork-surface estimate. Session logs store image references with a declared byte length, but the provider receives the bytes inline, so a screenshot-heavy prefix previously stayed under the text budget and the child still failed with `Request body too large`. The estimate now adds each referenced image's `bytes` scaled by 4/3.
- 计算 fork surface 时把图片附件按内联 base64 的请求体积计入。会话日志只保存图片引用及其声明字节数，而 provider 收到的是内联字节；此前截图多的前缀在文本预算内、子会话仍会报 `Request body too large`。现在按引用里的 `bytes` 乘以 4/3 计入。

## 0.3.18 — 2026-11-27

- Archive the source conversation after a successful rewind fork, so repeated rewinds no longer pile up sessions in the sidebar. DSH has no session delete API; archive removes the row while keeping durable state, and the sidebar's archived search restores it. A session with running work rejects the archive, which never fails the rewind; the response reports `archived`.
- 回滚成功 fork 后自动归档源对话，反复回滚不再堆积会话。DSH 没有删除会话的 API，归档只把该行移出列表、保留数据，可在侧边栏「已归档」搜索中恢复；仍有工作在跑的会话归档会被拒绝，不影响回滚本身，响应返回 `archived`。

## 0.3.17 — 2026-11-27

- Fix `SESSION_TOO_LARGE` on sessions compacted right before the selected message: a `/compact` recorded after the previous turn's end lies outside that fork boundary, so the checkpoint search now runs up to the selected message and prefers it. Forking at that later replacement keeps the child on the summary surface and skips nothing before the boundary.
- Show a localized `SESSION_TOO_LARGE` sentence and stop rendering a structured skip reason as `[object Object]`.
- 修复「刚 `/compact` 过仍报 `SESSION_TOO_LARGE`」：`/compact` 在上一轮结束之后、所选消息之前时不在该 fork 边界内，现在把检查点搜索范围扩大到所选消息之前并优先使用它；从该替换消息 fork 后子会话只保留摘要 surface。
- `SESSION_TOO_LARGE` 现在有本地化文案，结构化跳过原因不再显示为 `[object Object]`。

## 0.3.16 — 2026-11-27

- Fork oversized sessions from their latest compaction checkpoint: when the requested turn boundary's surface exceeds the provider request-body budget, the restart child opens from the compaction replacement instead of an over-cap raw prefix, so it no longer dies on its first automatic compaction with `Request body too large`. The response reports `compacted` and `skippedEvents`, and the dialog explains that content after the checkpoint was not carried over.
- Reject a boundary that is oversized and was never compacted with `SESSION_TOO_LARGE`, telling the user to `/compact` or start a new conversation first instead of creating a dead child session.
- 超大会话改为从最近一次压缩检查点 fork：当目标轮次边界的 surface 超过 provider 请求体预算时，重启子会话从压缩替换消息开始，而不是继承超限的原始前缀，从而不再在第一次自动压缩时报 `Request body too large`；响应返回 `compacted` 与 `skippedEvents`，对话框说明压缩点之后的内容没有带入。
- 对「超大且从未压缩」的边界返回 `SESSION_TOO_LARGE`，提示先 `/compact` 或新开会话，而不是创建一个必然失败的子会话。

## 0.3.15 — 2026-11-26

- Support exact DSH `0.2.2-rc.5` in the compatibility declaration and settings peer range, preserving every previously supported release. Verified with the repository checks and a live Desktop Profile installation on `0.2.2-rc.5`.
- 兼容性声明及 settings peer 范围明确支持 DSH `0.2.2-rc.5`，保留此前支持的全部版本；通过仓库检查并在 `0.2.2-rc.5` 的 Desktop Profile 中实测安装。

## 0.3.14 — 2026-11-21

- Support DSH `0.2.2-rc.3` in the compatibility declaration and settings peer range, fixing the Desktop Profile installation rejection reported in [#38](https://github.com/Anionex/dsh-turn-rewind/issues/38).
- 兼容性声明及 settings peer 范围明确支持 DSH `0.2.2-rc.3`，修复 [#38](https://github.com/Anionex/dsh-turn-rewind/issues/38) 报告的 Desktop Profile 安装被拒绝问题。

## 0.3.13 — 2026-11-12

- Support exact DSH `0.2.2-rc.1`: the per-session chat snapshot hooks (`useChat`/`useSession`) are gone from the client slot API, so the rewind button now keys Host-provided turn anchors (`GET /turn-rewind/turns`) to rendered user rows via `data-chat-turn`. The legacy snapshot path is retained for older Hosts.
- 支持 DSH `0.2.2-rc.1`：客户端 slot API 已移除会话级 chat 快照 hooks（`useChat`/`useSession`），回退按钮改为把 Host 提供的轮次锚点（`GET /turn-rewind/turns`）按 `data-chat-turn` 映射到已渲染的用户消息行；旧 Host 的 snapshot 路径保留。
- Refresh anchors for new messages, scope buttons to their owning session, cancel stale requests, and retain missing attachment references for explicit recovery errors.
- 新消息自动刷新回退锚点，按钮限定于所属会话，取消过期请求，并保留缺失附件引用以明确提示恢复失败。
- Keep messages-only rewind available on turns recorded before this plugin created a file checkpoint.
- 对插件建立文件检查点之前的轮次，仍可使用仅回退消息。

## 0.3.12 — 2026-11-07

- Restore message images and files into the draft when rewinding or restarting, using the public session-input API. Validate original message references before reading attachment bytes; retain empty files and explain missing or refused attachments.
- 回溯或重新开始会话时，通过公开草稿接口恢复原消息的图片和文件；读取前核对原消息引用，保留空文件，并提示无法恢复的附件。
- Finish attachment reads before opening the restored draft, preventing late uploads from entering a later message.
- 打开恢复后的草稿前完成附件读取，避免延迟返回的附件进入后续消息。
- Support exact DSH `0.2.1-rc.5`, preserving earlier supported releases. Verified with 146 tests and clean rc.5 tarball Profile installation and startup.
- 支持 DSH `0.2.1-rc.5`，保留此前支持版本；通过 146 项测试及 rc.5 压缩包干净 Profile 安装、启动验收。

## 0.3.11 — 2026-10-26

- Support exact DSH `0.2.1-rc.3` through the settings peer and compatibility declarations; keep earlier supported versions and reject unverified future prereleases.
- 通过 settings peer 和兼容性声明支持 DSH `0.2.1-rc.3`，保留此前支持的版本，不放行未验证的未来预发布版。

## 0.3.10 — 2026-10-18

- Support DSH `0.2.1-rc.2` through explicit peer ranges and compatibility declarations.
- 支持 DSH `0.2.1-rc.2`，补齐 peer 版本范围及兼容性声明。

## 0.3.9 — 2026-10-01

- Add the exact DSH `0.2.0-rc.2` peer and compatibility range while preserving the previously declared release ranges.
- 增加 DSH `0.2.0-rc.2` 的明确 peer 与兼容范围，保留原有版本范围。
- Open the restored conversation through the new workspace navigation service when `sessions.open` is absent, then restore the original draft into its retained Session scope.
- 新版移除 `sessions.open` 后，通过工作区导航服务打开回退后的会话，并把原始输入恢复到该会话的草稿中。
- Verification includes 143 tests, portable package checks, and an isolated tarball Web installation.
- 验证包含 143 项测试、可移植包检查和隔离 Web Profile 压缩包安装。

- Preserve the source workspace membership when restarting the first turn; verified real Web rewind creates a usable child session and restores its draft on DSH `0.2.0-rc.2`.
- 首轮回退保留源会话的工作区归属；已在 DSH `0.2.0-rc.2` 实测 Web 回退后子会话可用、原输入草稿恢复。
