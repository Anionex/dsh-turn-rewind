# Changelog

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
