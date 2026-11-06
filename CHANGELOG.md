# Changelog

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
