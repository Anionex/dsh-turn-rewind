# Changelog

## 0.3.9 — Unreleased / 待发布

- Add the exact DSH `0.2.0-rc.2` peer and compatibility range while preserving the previously declared release ranges.
- 增加 DSH `0.2.0-rc.2` 的明确 peer 与兼容范围，保留原有版本范围。
- Open the restored conversation through the new workspace navigation service when `sessions.open` is absent, then restore the original draft into its retained Session scope.
- 新版移除 `sessions.open` 后，通过工作区导航服务打开回退后的会话，并把原始输入恢复到该会话的草稿中。
- Verification includes 143 tests, portable package checks, and an isolated tarball Web installation. Publication remains pending.
- 验证包含 143 项测试、可移植包检查和隔离 Web Profile 压缩包安装；尚未发布。

- Preserve the source workspace membership when restarting the first turn; verified real Web rewind creates a usable child session and restores its draft on DSH `0.2.0-rc.2`.
- 首轮回退保留源会话的工作区归属；已在 DSH `0.2.0-rc.2` 实测 Web 回退后子会话可用、原输入草稿恢复。
