window.__ModuleLoader__.load({ id: "@anionex/dsh-turn-rewind", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.resolveUiLocale = resolveUiLocale;
exports.selectRewindMessage = selectRewindMessage;
exports.apply = apply;
exports.collectChatNodes = collectChatNodes;
exports.RewindMessagePortals = RewindMessagePortals;
exports.RewindMessageAction = RewindMessageAction;
exports.TurnRewindSettingsCard = TurnRewindSettingsCard;
exports.formatBytes = formatBytes;
exports.selectRewindMessageTarget = selectRewindMessageTarget;
exports.responseJson = responseJson;
exports.fileRecoveryLabel = fileRecoveryLabel;
exports.describeCaptureNotice = describeCaptureNotice;
exports.explainCheckpointSkip = explainCheckpointSkip;
exports.explainCheckpointFailure = explainCheckpointFailure;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const react_dom_1 = require("react-dom");
const dsh_client_ui_primitives_1 = require("@deepseek-ai/dsh-client-ui-primitives");
const PATH = '/turn-rewind';
const MANAGE_PATH = '/turn-rewind/manage';
const STYLE_ID = '@anionex/dsh-turn-rewind';
const styles = `
.dcl-rewind-tail{display:inline-flex;align-items:center;align-self:center;order:0;height:24px;margin-left:2px}
.dcl-rewind-trigger{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dcl-rewind-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dcl-rewind-dialog{box-sizing:border-box;width:min(560px,100%);max-height:calc(100dvh - 48px)}
.dcl-rewind-content{min-width:0;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.dcl-rewind-body{display:flex;flex-direction:column;gap:14px;width:100%;min-width:0;max-width:100%;box-sizing:border-box}
.dcl-rewind-options{display:flex;flex-direction:column;gap:8px;min-width:0;max-width:100%}
.dcl-rewind-option{display:flex;align-items:flex-start;gap:10px;width:100%;min-width:0;box-sizing:border-box;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);cursor:pointer}
.dcl-rewind-option[data-selected="true"]{border-color:var(--dsw-alias-state-business-primary)}
.dcl-rewind-option[data-disabled="true"]{cursor:not-allowed;opacity:.52}
.dcl-rewind-option input{flex:none;margin:2px 0 0}
.dcl-rewind-option-content{display:block;flex:1;min-width:0}
.dcl-rewind-option strong{display:block;color:var(--dsw-alias-label-primary);font-size:14px}
.dcl-rewind-option-description{display:block;margin-top:3px;overflow-wrap:anywhere;word-break:break-word;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dcl-rewind-summary{display:flex;flex-wrap:wrap;column-gap:16px;row-gap:4px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:13px}
.dcl-rewind-files{min-width:0;max-width:100%;box-sizing:border-box;max-height:220px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}
.dcl-rewind-file{display:flex;justify-content:space-between;gap:16px;min-width:0;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}
.dcl-rewind-file:last-child{border-bottom:0}.dcl-rewind-file code{min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}
.dcl-rewind-kind{flex:none;color:var(--dsw-alias-label-tertiary)}
.dcl-rewind-file-actions{display:flex;justify-content:flex-start}
.dcl-rewind-status{margin:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dcl-rewind-warning,.dcl-rewind-error{box-sizing:border-box;max-width:100%;margin:0;padding:10px 12px;overflow-wrap:anywhere;word-break:break-word;border-radius:10px;font-size:12px;line-height:18px}
.dcl-rewind-warning{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary)}
.dcl-rewind-error{border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);color:var(--dsw-alias-state-error-primary)}
.dcl-rewind-backup{box-sizing:border-box;margin:0;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dcl-rewind-retry{align-self:flex-start}
.dcl-trs-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;transition:border-color .16s,background .16s}
.dcl-trs-card[data-open="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dcl-trs-card-head{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dcl-trs-card-heading{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dcl-trs-card-heading strong{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.dcl-trs-card-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.dcl-trs-card-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.dcl-trs-card[data-open="true"] .dcl-trs-card-chevron{transform:rotate(180deg)}
.dcl-trs-card-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:12px 0 8px;display:flex;flex-direction:column;gap:16px;min-width:0}
.dcl-trs-section-title{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.dcl-trs-section-title strong{color:var(--dsw-alias-label-primary);font-size:14px}
.dcl-trs-section-title-actions{display:inline-flex;align-items:center;gap:8px}
.dcl-trs-field{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:13px}
.dcl-trs-field:last-child{border-bottom:0}
.dcl-trs-field-label{flex:1 1 200px;min-width:0}
.dcl-trs-field-label strong{display:block;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}
.dcl-trs-field-desc{display:block;margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dcl-trs-field-control{display:inline-flex;align-items:center;gap:8px;flex:none}
.dcl-trs-field-control input,.dcl-trs-field-control select{box-sizing:border-box;min-width:140px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px}
.dcl-trs-field-control input:disabled,.dcl-trs-field-control select:disabled{opacity:.52;cursor:not-allowed}
.dcl-trs-override{flex:none;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-bg-layer-0);font-size:11px;line-height:18px}
.dcl-trs-manage-total{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;overflow-wrap:anywhere}
.dcl-trs-workspace{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.dcl-trs-workspace-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;min-width:0}
.dcl-trs-workspace-path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:12px}
.dcl-trs-workspace-meta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dcl-trs-badge{flex:none;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);font-size:11px;line-height:18px}
.dcl-trs-points{display:flex;flex-direction:column;gap:4px;min-width:0;margin:0;padding:0;list-style:none}
.dcl-trs-point{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;font-size:12px}
.dcl-trs-point time{flex:1 1 140px;min-width:0;color:var(--dsw-alias-label-secondary)}
.dcl-trs-point-kind,.dcl-trs-point-size,.dcl-trs-point-files{flex:none;color:var(--dsw-alias-label-tertiary)}
.dcl-trs-point code{flex:1 1 140px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.dcl-trs-status{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dcl-trs-notice{box-sizing:border-box;max-width:100%;margin:0;padding:8px 10px;overflow-wrap:anywhere;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dcl-trs-notice[data-warning="true"]{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary)}
.dcl-trs-error{box-sizing:border-box;max-width:100%;margin:0;padding:10px 12px;overflow-wrap:anywhere;word-break:break-word;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);border-radius:10px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.dcl-trs-storage{margin:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:12px;overflow-wrap:anywhere}
`;
/** Chinese copy — the language this plugin shipped in before English existed. */
const ZH = {
    rewindTooltip: '恢复到发送这条消息之前',
    dialogClose: '关闭',
    dialogDescription: '查看恢复的文件，选择适合你的回退方式。当前会话不受影响。',
    cancel: '取消',
    applying: '正在恢复…',
    done: '已完成',
    actionRestoreAndRestart: '恢复并从这里继续',
    actionRestoreFiles: '恢复文件',
    actionMessagesOnly: '只回溯消息',
    checkingFiles: '正在检查可以恢复的项目文件…',
    previewPending: '这条消息发送前的文件还在保存，请稍后再试。',
    previewMissing: '没有保存这条消息发送前的文件。可能是当时还没启用回退功能、记录已超过保留期限，或已关闭自动检查点。仍可只回溯消息。',
    modeBothTitle: '恢复文件并从这里继续',
    modeBothDescription: '创建一个从这里开始的新会话（当前对话会保留）',
    modeCodeTitle: '只恢复文件',
    modeCodeDescription: '恢复这条消息发送前的文件，当前对话保持不变。',
    modeMessagesTitle: '只回溯消息（不动文件）',
    modeMessagesDescription: '创建一个从这里开始的新会话，项目文件保持当前状态。',
    filesUnchanged: '项目文件保持不变',
    filesToRestore: count => `将恢复 ${String(count)} 个文件`,
    summaryBoth: '恢复后在新对话里继续',
    summaryCode: '当前对话保持不变',
    summaryMessages: '仅创建从这里继续的新对话',
    sharedBlocked: '这个项目目录还有别的对话正在运行。恢复文件会影响到它们，因此本次操作已被阻止。请等那些对话结束或停止后，再重新检查。',
    branchChanged: '当前所在的 Git 分支和发送这条消息时不同。恢复不会切换分支，只会把当时的文件内容恢复到当前分支。',
    headAdvanced: '这条消息之后有了新的 Git 提交。恢复只会改文件，不会撤销提交；完成后这些文件会显示为未提交修改。',
    driftBlocked: 'Git 正在进行合并、变基或类似操作。请先完成或取消这次 Git 操作，再重新检查。',
    planMissing: '恢复信息已经失效，请重新检查。',
    stale: '项目文件在检查后又发生了变化。为避免覆盖新修改，这次恢复已失效，请重新检查。',
    nothingToRestore: '项目文件已经是这条消息发送前的状态，无需恢复文件。可选择「只回溯消息」重新开始这段对话。',
    loadingAllFiles: '正在读取全部文件…',
    viewAllFiles: count => `查看全部 ${String(count)} 个文件`,
    backupNote: '恢复前会自动备份当前文件；若恢复失败会自动还原，项目不会停留在只恢复了一部分的状态。',
    recheck: '重新检查',
    completedMessages: '已创建从这里开始的新对话；项目文件保持不变。',
    completedCode: '项目文件已恢复；当前对话保持不变。恢复前的文件已自动备份。',
    completedBoth: '项目文件已恢复，并已创建新对话。恢复前的文件已自动备份。',
    openFailed: reason => `新对话已创建，但没能自动打开：${reason}`,
    restoredButOpenFailed: reason => `文件已经恢复，新对话也已创建，但没能自动打开：${reason}`,
    modeMismatch: mode => `服务器返回了不匹配的回退模式：${mode}`,
    listChangedWhileExpanding: '项目文件在展开列表时发生了变化。',
    incompleteFileList: '无法读取完整的文件列表。',
    fileKinds: {
        added: '移除后来新增的文件',
        deleted: '找回文件',
        modified: '恢复之前的版本',
        'mode-changed': '恢复文件权限',
        'type-changed': '恢复之前的文件类型',
    },
    errors: {
        REWIND_ENDPOINT_UNAVAILABLE: '回退服务没有响应。请确认 @anionex/dsh-turn-rewind 已挂载到当前 DSH，并重启 DSH 后重试。',
        REWIND_INVALID_RESPONSE: '回退服务返回了无法解析的内容。请重启 DSH 后重试。',
        PLAN_STALE: '项目文件在检查后又发生了变化。为避免覆盖新修改，请重新检查后再恢复。',
        PLAN_STALE_WORKSPACE: '项目文件在检查后又发生了变化。为避免覆盖新修改，请重新检查后再恢复。',
        PLAN_STALE_REPOSITORY: 'Git 状态在检查后又发生了变化，恢复已失效。请重新检查后再试。',
        WORKSPACE_IN_USE: '这个项目目录还有别的对话正在运行。请等那些对话结束或停止后，再重新检查。',
        WORKSPACE_LOCKED: '另一个恢复操作正在处理这个项目目录。请等待它完成后重新检查。',
        WORKSPACE_CHANGED: '这个项目目录已经不在原来的位置，旧的回退点无法再使用。',
        WORKSPACE_MODE_CHANGED: '这个项目目录的工作区类型变了（例如从普通目录变成了 Git 仓库）。旧的回退点不再适用，请重新发送一条消息生成新的回退点。',
        HEAD_CHANGED: '项目的提交或分支已发生变化。为避免覆盖新改动，请重新检查后再恢复。',
        REPOSITORY_CHANGED: '这个项目目录已不属于原来的 Git 工作区，无法恢复。',
        GIT_OPERATION_CHANGED: 'Git 正在执行其他操作。请先完成或取消该操作，再重新检查。',
        RESTORE_POINT_NOT_FOUND: '没有找到对应的文件状态，可能已被清理。',
        NO_CHANGES: '项目文件已经是这条消息发送前的状态，无需恢复文件。可选择「只回溯消息」重新开始这段对话。',
        RESTORE_FAILED_ROLLED_BACK: '恢复未能完成，项目文件已自动还原到操作前的状态。',
        CONVERSATION_REWIND_FAILED: '文件已恢复，但无法创建新对话；项目文件已自动还原。',
    },
    captureSnapshotLimit: '本轮要保存的文件总量超过上限，剩下的文件没有纳入检查点。恢复时不会改动它们。',
    captureFileLimit: '本轮文件数量超过上限，多出来的文件没有纳入检查点。恢复时不会改动它们。',
    captureSkipped: (count, example) => `有 ${String(count)} 个文件因为超过单文件大小上限或类型不受支持，没有纳入检查点${example === undefined ? '' : `（例如 ${example}）`}。恢复时不会改动它们。`,
    skipTimeout: '这个项目目录太大，在检查点时间上限内没保存完文件快照，所以本轮没有回退点（消息本身没有受影响）。可以在插件设置里调大「检查点时间上限」，或在目录根用 .dsh-rewindignore 排除大目录（例如 node_modules、构建产物、数据集）。仍可只回溯消息。',
    skipDisabled: '自动文件检查点已在设置里关闭，本轮没有回退点。仍可只回溯消息。',
    skipNewContentLimit: '这一轮新增的内容超过检查点预算，没有保存文件快照。仍可只回溯消息。',
    skipOther: reason => `本轮没有保存文件检查点：${reason}仍可只回溯消息。`,
    failureNotGitRepository: '这个项目目录不是 Git 仓库，回退功能无法保存文件检查点。仍可只回溯消息。',
    failureGitStatus: message => `无法读取这个项目目录的 Git 状态：${message}仍可只回溯消息。`,
    failureSizeOrCount: '本轮有文件超过检查点的大小或数量上限，没有保存文件检查点。仍可只回溯消息。',
    failureUnsupportedType: '项目目录里有无法保存的特殊文件（如 socket、设备文件、FIFO），没有保存文件检查点。仍可只回溯消息。',
    failureIgnoreFileInvalid: '项目目录里的 .dsh-rewindignore 内容无效，没有保存文件检查点。修正该文件后可重新发送消息。',
    failureInvalidPath: '项目目录里有无法安全保存的路径（例如嵌套的独立 Git 仓库），没有保存文件检查点。仍可只回溯消息。',
    failureOther: message => `没能保存这条消息发送前的文件：${message}仍可只回溯消息。`,
    settingsCardTitle: 'Turn Rewind 回退设置',
    settingsCardDescription: '自动文件检查点、信任策略与检查点保留上限；回退按钮在各条用户消息上',
    autoCheckpointSection: '自动文件检查点',
    settingsLoading: '正在加载设置…',
    settingsUnavailable: '当前部署未提供设置服务，以下选项不可用。',
    settingsReadOnly: '设置为只读（当前浏览器进程内保存），修改不可用。',
    autoCheckpointLabel: '自动文件检查点',
    autoCheckpointDescription: '关闭后不再为每条消息保存文件检查点；回退弹窗仍可只回溯消息',
    trustLabel: '检查点信任策略',
    trustDescription: '快速信任 Git/stat 元数据；严格会逐一重读文件内容',
    overridden: '已覆盖',
    resetToDefault: '恢复默认',
    positiveInteger: field => `${field} 必须是正整数。`,
    storageDir: directory => `存储目录（在 cordis.patch.yml 中配置，不可在线修改）：${directory}`,
    manageSection: '检查点管理',
    refreshing: '正在刷新…',
    refresh: '刷新',
    clearing: '正在清理…',
    confirmClearAll: '确认清空全部',
    clearAll: '一键清空全部',
    manageLoading: '正在读取检查点占用…',
    manageTotal: (workspaces, points, size) => `共 ${String(workspaces)} 个工作区，${String(points)} 个检查点，约 ${size}（Git 原生检查点的实际磁盘占用以 Git 回收为准）。`,
    workspacePoints: count => `${String(count)} 个检查点`,
    pendingRecoveries: count => `${String(count)} 个恢复待处理`,
    expand: '展开',
    collapse: '收起',
    clearWorkspace: '清空此项目',
    fileCount: count => `${String(count)} 个文件`,
    deleting: '正在删除…',
    remove: '删除',
    noCheckpoints: '还没有任何已保存的检查点。',
    clearedAll: (deleted, retained, failures) => `已删除 ${String(deleted)} 个检查点${retained > 0 ? `，${String(retained)} 个受保护检查点未删除` : ''}${failures > 0 ? `，${String(failures)} 个工作区清理失败` : ''}。`,
    cleared: (deleted, retained) => `已删除 ${String(deleted)} 个检查点${retained > 0 ? `，${String(retained)} 个受保护检查点未删除` : ''}。`,
    checkpointModes: {
        off: '关闭（不创建文件检查点）',
        auto: '自动（推荐）',
        'git-native': 'Git 原生（大仓库）',
        legacy: '完整快照（兼容模式）',
    },
    trustOptions: {
        fast: '快速',
        strict: '严格',
    },
    pointKinds: {
        user: '手动',
        rescue: '救援',
        turn: '轮次',
    },
    numberFields: {
        maxRestorePoints: { label: '用户/救援恢复点上限', description: '每个工作区保留的最大手动与救援恢复点数量' },
        maxTurnCheckpointsPerSession: { label: '轮次检查点上限', description: '每个会话保留的最大自动轮次检查点数量（最旧的先清理）' },
        maxFiles: { label: '单恢复点文件数上限', description: '一个恢复点最多纳入的文件数量' },
        maxFileBytes: { label: '单文件大小上限', description: '读取单个普通文件的最大字节数' },
        maxSnapshotBytes: { label: '快照总量上限', description: '单个恢复点读取的最大字节总量' },
        planTtlMs: { label: '恢复计划有效期（毫秒）', description: '回溯计划从创建到失效的时间' },
        staleLockMs: { label: '锁回收时长（毫秒）', description: '锁属主消失多久后允许回收该锁' },
        turnCheckpointTimeoutMs: { label: '检查点超时（毫秒）', description: '单次自动检查点最多阻塞消息发送的时间，超时记录跳过' },
        turnCheckpointMaxNewBytes: { label: '检查点读取上限', description: '单次 Git 原生检查点最多读取的未缓存字节数' },
    },
    manageMissingWorkspaces: '管理数据缺少 workspaces',
    manageMissingRestorePoints: '管理数据缺少 restorePoints',
    clearMissingReports: '清理结果缺少 reports',
    previewMissingChanges: '回退预览缺少 changes',
    previewMissingActiveSessionIds: '回退预览缺少 activeSessionIds',
    invalidField: name => `${name} 无效`,
    invalidObject: '服务器返回了无效对象',
    unknownStatus: status => `未知回退状态：${status}`,
    sessionNotReady: '新对话还没有准备好',
    unparsableResponse: status => `回退服务返回了无法解析的内容（HTTP ${status}）。`,
    requestFailed: status => `请求失败：${status}`,
    emptyResponse: '回退服务返回了空响应。',
};
/**
 * Count one English noun, used only by the English copy.
 * @param count - the quantity to render.
 * @param singular - the noun in its singular form.
 * @param plural - the plural form, when adding `s` is wrong.
 * @returns the counted phrase.
 */
function counted(count, singular, plural = `${singular}s`) {
    return `${String(count)} ${count === 1 ? singular : plural}`;
}
/** English copy, used when the Host reports a non-Chinese UI language. */
const EN = {
    rewindTooltip: 'Return to before sending this message',
    dialogClose: 'Close',
    dialogDescription: 'Review the files that would be restored and pick the rewind mode you want. The current session is unaffected.',
    cancel: 'Cancel',
    applying: 'Restoring…',
    done: 'Done',
    actionRestoreAndRestart: 'Restore and continue from here',
    actionRestoreFiles: 'Restore files',
    actionMessagesOnly: 'Rewind messages only',
    checkingFiles: 'Checking which project files can be restored…',
    previewPending: 'The files from before this message are still being saved. Try again in a moment.',
    previewMissing: 'No files were saved from before this message. Rewind may not have been enabled yet, the record may have passed its retention limit, or automatic checkpoints may be turned off. You can still rewind messages only.',
    modeBothTitle: 'Restore files and restart',
    modeBothDescription: 'Creates a new session starting here (the current conversation is kept)',
    modeCodeTitle: 'Restore files only',
    modeCodeDescription: 'Restores the files from before this message and leaves the current conversation unchanged.',
    modeMessagesTitle: 'Rewind messages only (files untouched)',
    modeMessagesDescription: 'Creates a new session starting here and leaves the project files exactly as they are.',
    filesUnchanged: 'Project files stay unchanged',
    filesToRestore: count => `Will restore ${counted(count, 'file')}`,
    summaryBoth: 'Continue in a new conversation after restoring',
    summaryCode: 'The current conversation stays unchanged',
    summaryMessages: 'Only creates a new conversation continuing from here',
    sharedBlocked: 'Another conversation is still running in this project directory. Restoring files would affect it, so this operation is blocked. Wait for those conversations to finish or stop them, then check again.',
    branchChanged: 'The current Git branch is not the one you were on when this message was sent. Restoring never switches branches; it only restores that file content onto the current branch.',
    headAdvanced: 'There are new Git commits after this message. Restoring only changes files and never undoes commits; afterwards those files appear as uncommitted changes.',
    driftBlocked: 'Git is in the middle of a merge, rebase, or similar operation. Finish or cancel that Git operation, then check again.',
    planMissing: 'The restore information has expired. Check again.',
    stale: 'The project files changed again after the check. To avoid overwriting the newer edits, this restore is no longer valid. Check again.',
    nothingToRestore: 'The project files already match the state from before this message, so no files need restoring. Choose “Rewind messages only” to restart this conversation from here.',
    loadingAllFiles: 'Loading all files…',
    viewAllFiles: count => `View all ${counted(count, 'file')}`,
    backupNote: 'The current files are backed up automatically before a restore; if the restore fails they are rolled back, so the project is never left partly restored.',
    recheck: 'Check again',
    completedMessages: 'A new conversation starting here has been created; the project files are unchanged.',
    completedCode: 'The project files have been restored; the current conversation is unchanged. The files from before the restore were backed up automatically.',
    completedBoth: 'The project files have been restored and a new conversation was created. The files from before the restore were backed up automatically.',
    openFailed: reason => `The new conversation was created but could not be opened automatically: ${reason}`,
    restoredButOpenFailed: reason => `The files were restored and the new conversation was created, but it could not be opened automatically: ${reason}`,
    modeMismatch: mode => `The server returned a rewind mode that does not match: ${mode}`,
    listChangedWhileExpanding: 'The project files changed while the full list was being loaded.',
    incompleteFileList: 'Could not read the complete file list.',
    fileKinds: {
        added: 'Remove the file added later',
        deleted: 'Bring the file back',
        modified: 'Restore the earlier version',
        'mode-changed': 'Restore the file permissions',
        'type-changed': 'Restore the earlier file type',
    },
    errors: {
        REWIND_ENDPOINT_UNAVAILABLE: 'The rewind service did not respond. Check that @anionex/dsh-turn-rewind is mounted in this DSH, restart DSH, and try again.',
        REWIND_INVALID_RESPONSE: 'The rewind service returned content that could not be parsed. Restart DSH and try again.',
        PLAN_STALE: 'The project files changed again after the check. To avoid overwriting the newer edits, check again before restoring.',
        PLAN_STALE_WORKSPACE: 'The project files changed again after the check. To avoid overwriting the newer edits, check again before restoring.',
        PLAN_STALE_REPOSITORY: 'The Git state changed after the check, so the restore is no longer valid. Check again and retry.',
        WORKSPACE_IN_USE: 'Another conversation is still running in this project directory. Wait for those conversations to finish or stop them, then check again.',
        WORKSPACE_LOCKED: 'Another restore is already working on this project directory. Wait for it to finish, then check again.',
        WORKSPACE_CHANGED: 'This project directory is no longer in its original location, so the earlier restore points cannot be used.',
        WORKSPACE_MODE_CHANGED: 'The workspace type of this project directory changed (for example from an ordinary directory to a Git repository). The earlier restore points no longer apply; send a new message to create a new one.',
        HEAD_CHANGED: 'The commits or branch of this project changed. To avoid overwriting newer work, check again before restoring.',
        REPOSITORY_CHANGED: 'This project directory no longer belongs to its original Git worktree, so it cannot be restored.',
        GIT_OPERATION_CHANGED: 'Git is running another operation. Finish or cancel it, then check again.',
        RESTORE_POINT_NOT_FOUND: 'No matching file state was found; it may already have been cleaned up.',
        NO_CHANGES: 'The project files already match the state from before this message, so no files need restoring. Choose “Rewind messages only” to restart this conversation from here.',
        RESTORE_FAILED_ROLLED_BACK: 'The restore did not finish; the project files were rolled back to their state before the operation.',
        CONVERSATION_REWIND_FAILED: 'The files were restored but the new conversation could not be created; the project files were rolled back.',
    },
    captureSnapshotLimit: 'The files in this turn exceeded the total size limit, so the remaining files were left out of the checkpoint. A restore will not touch them.',
    captureFileLimit: 'This turn had more files than the limit allows, so the extra files were left out of the checkpoint. A restore will not touch them.',
    captureSkipped: (count, example) => `${counted(count, 'file')} ${count === 1 ? 'was' : 'were'} left out of the checkpoint for exceeding the per-file size limit or having an unsupported type${example === undefined ? '' : ` (for example ${example})`}. A restore will not touch them.`,
    skipTimeout: 'This project directory is too large to finish a file snapshot within the checkpoint time limit, so this turn has no restore point (the message itself was unaffected). Raise “Checkpoint timeout (ms)” in the plugin settings, or exclude large directories with a .dsh-rewindignore in the directory root (for example node_modules, build output, datasets). You can still rewind messages only.',
    skipDisabled: 'Automatic file checkpoints are turned off in settings, so this turn has no restore point. You can still rewind messages only.',
    skipNewContentLimit: 'This turn added more content than the checkpoint budget allows, so no file snapshot was saved. You can still rewind messages only.',
    skipOther: reason => `No file checkpoint was saved for this turn: ${reason} You can still rewind messages only.`,
    failureNotGitRepository: 'This project directory is not a Git repository, so rewind cannot save file checkpoints. You can still rewind messages only.',
    failureGitStatus: message => `Could not read the Git state of this project directory: ${message} You can still rewind messages only.`,
    failureSizeOrCount: 'Files in this turn exceeded the checkpoint size or count limit, so no file checkpoint was saved. You can still rewind messages only.',
    failureUnsupportedType: 'The project directory contains special files that cannot be saved (such as sockets, device files, or FIFOs), so no file checkpoint was saved. You can still rewind messages only.',
    failureIgnoreFileInvalid: 'The .dsh-rewindignore in the project directory is invalid, so no file checkpoint was saved. Fix that file and send the message again.',
    failureInvalidPath: 'The project directory contains paths that cannot be saved safely (for example a nested standalone Git repository), so no file checkpoint was saved. You can still rewind messages only.',
    failureOther: message => `Could not save the files from before this message: ${message} You can still rewind messages only.`,
    settingsCardTitle: 'Turn Rewind settings',
    settingsCardDescription: 'Automatic file checkpoints, trust policy, and checkpoint retention limits; the rewind button sits on each user message',
    autoCheckpointSection: 'Automatic file checkpoints',
    settingsLoading: 'Loading settings…',
    settingsUnavailable: 'This deployment provides no settings service, so the options below are unavailable.',
    settingsReadOnly: 'Settings are read-only (kept inside this browser process), so changes are unavailable.',
    autoCheckpointLabel: 'Automatic file checkpoints',
    autoCheckpointDescription: 'When off, no file checkpoint is saved for each message; the rewind dialog can still rewind messages only',
    trustLabel: 'Checkpoint trust policy',
    trustDescription: 'Fast trusts Git/stat metadata; Strict re-reads every file’s content',
    overridden: 'Overridden',
    resetToDefault: 'Reset to default',
    positiveInteger: field => `${field} must be a positive integer.`,
    storageDir: directory => `Storage directory (configured in cordis.patch.yml, not editable here): ${directory}`,
    manageSection: 'Checkpoint management',
    refreshing: 'Refreshing…',
    refresh: 'Refresh',
    clearing: 'Clearing…',
    confirmClearAll: 'Confirm clear all',
    clearAll: 'Clear all',
    manageLoading: 'Reading checkpoint usage…',
    manageTotal: (workspaces, points, size) => `${counted(workspaces, 'workspace')}, ${counted(points, 'checkpoint')}, about ${size} (disk use for Git-native checkpoints follows Git garbage collection).`,
    workspacePoints: count => counted(count, 'checkpoint'),
    pendingRecoveries: count => `${counted(count, 'recovery', 'recoveries')} pending`,
    expand: 'Expand',
    collapse: 'Collapse',
    clearWorkspace: 'Clear this project',
    fileCount: count => counted(count, 'file'),
    deleting: 'Deleting…',
    remove: 'Delete',
    noCheckpoints: 'No checkpoints have been saved yet.',
    clearedAll: (deleted, retained, failures) => `Deleted ${counted(deleted, 'checkpoint')}${retained > 0 ? `; ${counted(retained, 'protected checkpoint')} kept` : ''}${failures > 0 ? `; ${counted(failures, 'workspace')} failed to clear` : ''}.`,
    cleared: (deleted, retained) => `Deleted ${counted(deleted, 'checkpoint')}${retained > 0 ? `; ${counted(retained, 'protected checkpoint')} kept` : ''}.`,
    checkpointModes: {
        off: 'Off (no file checkpoints)',
        auto: 'Auto (recommended)',
        'git-native': 'Git-native (large repositories)',
        legacy: 'Full snapshot (compatibility mode)',
    },
    trustOptions: {
        fast: 'Fast',
        strict: 'Strict',
    },
    pointKinds: {
        user: 'Manual',
        rescue: 'Rescue',
        turn: 'Turn',
    },
    numberFields: {
        maxRestorePoints: { label: 'User/rescue restore point limit', description: 'Most manual and rescue restore points kept per workspace' },
        maxTurnCheckpointsPerSession: { label: 'Turn checkpoint limit', description: 'Most automatic turn checkpoints kept per session (oldest pruned first)' },
        maxFiles: { label: 'Files per restore point', description: 'Most files one restore point may include' },
        maxFileBytes: { label: 'Maximum file size', description: 'Most bytes read from a single regular file' },
        maxSnapshotBytes: { label: 'Maximum snapshot size', description: 'Most bytes read in total for one restore point' },
        planTtlMs: { label: 'Restore plan lifetime (ms)', description: 'How long a rewind plan stays valid after it is created' },
        staleLockMs: { label: 'Stale lock timeout (ms)', description: 'How long after its owner disappears a lock may be reclaimed' },
        turnCheckpointTimeoutMs: { label: 'Checkpoint timeout (ms)', description: 'How long one automatic checkpoint may hold up sending a message before it is recorded as skipped' },
        turnCheckpointMaxNewBytes: { label: 'Checkpoint read limit', description: 'Most uncached bytes one Git-native checkpoint may read' },
    },
    manageMissingWorkspaces: 'The management data is missing workspaces',
    manageMissingRestorePoints: 'The management data is missing restorePoints',
    clearMissingReports: 'The clear result is missing reports',
    previewMissingChanges: 'The rewind preview is missing changes',
    previewMissingActiveSessionIds: 'The rewind preview is missing activeSessionIds',
    invalidField: name => `${name} is invalid`,
    invalidObject: 'The server returned an invalid object',
    unknownStatus: status => `Unknown rewind status: ${status}`,
    sessionNotReady: 'The new conversation is not ready yet',
    unparsableResponse: status => `The rewind service returned content that could not be parsed (HTTP ${status}).`,
    requestFailed: status => `Request failed: ${status}`,
    emptyResponse: 'The rewind service returned an empty response.',
};
const TEXT = { zh: ZH, en: EN };
/**
 * Active UI language, and the listeners rendering it.
 *
 * One browser runs one copy of this plugin, so the active language is module
 * state rather than React context: the pure helpers below (`friendlyError`,
 * `explainCheckpointSkip`, and the decoders) produce user-facing sentences
 * outside any render and would otherwise need their exported signatures
 * changed.
 */
let uiLocale = 'zh';
const localeListeners = new Set();
/**
 * Resolve one Host locale id to a language this plugin ships copy for.
 *
 * An absent, empty, or unreadable id means the Host published no UI language —
 * DSH releases without the locale plugin, and profiles that do not mount it —
 * and keeps Chinese, so an existing install never changes language on upgrade.
 * Any other registered language resolves to English, mirroring the Host's own
 * per-key fallback chain, which terminates at English rather than Chinese.
 * @param active - the Host's active locale id, when it publishes one.
 * @returns the language whose copy to render.
 */
function resolveUiLocale(active) {
    if (typeof active !== 'string' || active === '')
        return 'zh';
    return /^zh(?:[-_]|$)/i.test(active) ? 'zh' : 'en';
}
/** Current UI copy. Chinese until the Host publishes another language. */
function uiText() {
    return TEXT[uiLocale];
}
/** Adopt one Host locale id and re-render everything currently mounted. */
function adoptLocale(active) {
    const next = resolveUiLocale(active);
    if (next === uiLocale)
        return;
    uiLocale = next;
    for (const listener of localeListeners)
        listener();
}
/** `useSyncExternalStore` subscribe half for the active language. */
function subscribeLocale(listener) {
    localeListeners.add(listener);
    return () => { localeListeners.delete(listener); };
}
/** Read the current copy and re-render this component when the language changes. */
function useText() {
    return (0, react_1.useSyncExternalStore)(subscribeLocale, uiText, uiText);
}
/**
 * Follow the Host's UI language for as long as the plugin is mounted.
 *
 * The locale service is read through `ctx.get`, Cordis's un-injected read, and
 * not declared in `inject`: an injected service the profile does not mount
 * holds the fiber inactive, which would stop the rewind button appearing at all
 * on a profile without the locale plugin. Late arrival is covered by the
 * `locale/change` event, which is emitted on the context rather than on the
 * service, so a listener registered here sees a switch even when the locale
 * plugin loads after this one.
 * @param ctx - the client context this plugin was applied to.
 * @returns the teardown restoring the default language.
 */
function followHostLocale(ctx) {
    adoptLocale(hostLocale(ctx));
    // Client plugin apply() order is not guaranteed, and `locale` is read
    // un-injected (see the doc comment above) so this plugin never forces it
    // to load first. When `dsh-client-locale` mounts after this plugin, the
    // read above returns `undefined` and the surface falls back to Chinese;
    // nothing then corrects it, because a stored preference that was already
    // settled before this plugin mounted never fires another `locale/change`
    // event. Re-checking once on the next microtask and once on the next
    // macrotask catches both same-tick and deferred registration without
    // adding a hard dependency; `adoptLocale` is a no-op when the language
    // has not actually changed, so the extra calls are always safe.
    const recheck = () => adoptLocale(hostLocale(ctx));
    // `Promise` is an ECMAScript built-in present in every realm, unlike the
    // host-provided `queueMicrotask`, which a constrained embedding (this
    // plugin's own test sandbox included) need not supply.
    void Promise.resolve().then(recheck);
    const timeoutId = setTimeout(recheck, 0);
    let off;
    try {
        off = ctx.on?.('locale/change', (snapshot) => {
            adoptLocale(typeof snapshot?.active === 'string' ? snapshot.active : hostLocale(ctx));
        });
    }
    catch {
        off = undefined;
    }
    return () => {
        clearTimeout(timeoutId);
        if (typeof off === 'function')
            off();
        adoptLocale(undefined);
    };
}
/**
 * Read the Host's active locale id.
 *
 * The locale service belongs to the Host, so its presence and shape are not
 * this plugin's to guarantee: a language that cannot be read leaves the rewind
 * surface in Chinese instead of failing the effect that installs the button.
 * @param ctx - the client context this plugin was applied to.
 * @returns the active locale id, or `undefined` when none can be read.
 */
function hostLocale(ctx) {
    try {
        const active = ctx.get?.('locale')?.getSnapshot().active;
        return typeof active === 'string' ? active : undefined;
    }
    catch {
        return undefined;
    }
}
/** Return the rewind anchor and editable text owned by one direct user message. */
function selectRewindMessage(node) {
    if (node.kind !== 'user' || !Number.isSafeInteger(node.seq) || node.seq < 0)
        return null;
    const promptText = (node.content ?? [])
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n');
    return { messageSeq: node.seq, promptText };
}
/**
 * Browser plugin entry: bridge every direct user-message action row to the rewind UI.
 *
 * Every service read on `ctx` must be declared here: Cordis throws while reading an
 * undeclared service off the context proxy, before optional chaining can apply.
 * `settingsScope` is provided by `@deepseek-ai/dsh-client-ui-settings` and may be
 * absent, which is what `ctx.settingsScope?.bind(…)` below relies on.
 */
exports.inject = ['slots', 'sessions', 'conversation', 'settingsScope'];
function apply(ctx) {
    ctx.effect(() => followHostLocale(ctx), 'turn-rewind: locale');
    ctx.effect(() => {
        if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null)
            return () => { };
        const tag = document.createElement('style');
        tag.dataset.plugin = '@anionex/dsh-turn-rewind';
        tag.dataset.pluginCss = STYLE_ID;
        tag.textContent = styles;
        document.head.appendChild(tag);
        return () => { tag.remove(); };
    }, 'turn-rewind: styles');
    ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'turn-rewind-portals',
        order: 100,
        inject: () => ({
            openRestoredSession: async (sessionId, promptText) => {
                await openSessionWithDraft(ctx, sessionId, promptText);
            },
        }),
    }, RewindMessagePortals));
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: 'turn-rewind',
        inject: () => ({
            scope: ctx.settingsScope?.bind({ namespace: 'turn-rewind' }),
        }),
    }, TurnRewindSettingsCard));
}
/** Narrow a chat node source to the keyed store form. */
function isNodeStore(value) {
    return typeof value.get === 'function';
}
/**
 * Resolve the ordered chat node list from one chat projection.
 *
 * Both inputs keep a stable identity across renders: `order` is republished only
 * when the node set changes and the store is a mutable handle, so the caller can
 * memoize the list instead of allocating a new array on every render (a fresh
 * array per render makes `useSyncExternalStore` loop forever).
 * @param order - ordered node keys, or null when the projection is absent.
 * @param store - keyed node store, a legacy node array, or null.
 * @returns the chat nodes in render order.
 */
function collectChatNodes(order, store) {
    if (store === null)
        return [];
    if (Array.isArray(store))
        return store;
    if (order !== null && isNodeStore(store)) {
        const nodes = [];
        for (const key of order) {
            const node = store.get(key);
            if (node !== undefined)
                nodes.push(node);
        }
        return nodes;
    }
    return typeof store.values === 'function' ? Array.from(store.values()) : [];
}
/** Session-scoped bridge that portals rewind controls into direct user-message action rows. */
function RewindMessagePortals({ sessionId, openRestoredSession, useSession, useChat }) {
    // DSH 0.1.2+ moved the Chat projection out of the Session snapshot into its own
    // session-scoped `useChat` hook; `snapshot.chat` remains the 0.1.1 shape.
    const readSnapshot = useChat ?? useSession;
    const chatOf = (snapshot) => snapshot.chat ?? snapshot;
    const chatOrder = readSnapshot(snapshot => chatOf(snapshot).order ?? null);
    const chatStore = readSnapshot(snapshot => chatOf(snapshot).nodes ?? null);
    const nodes = (0, react_1.useMemo)(() => collectChatNodes(chatOrder, chatStore), [chatOrder, chatStore]);
    const [targets, setTargets] = (0, react_1.useState)([]);
    (0, react_1.useLayoutEffect)(() => {
        let active = true;
        let queued = false;
        const refresh = () => {
            if (!active)
                return;
            const next = collectPortalTargets(nodes);
            setTargets(current => samePortalTargets(current, next) ? current : next);
        };
        const queueRefresh = () => {
            if (queued || !active)
                return;
            queued = true;
            queueMicrotask(() => {
                queued = false;
                refresh();
            });
        };
        refresh();
        const observer = new MutationObserver(queueRefresh);
        observer.observe(document.body, { childList: true, subtree: true });
        return () => {
            active = false;
            observer.disconnect();
        };
    }, [nodes]);
    return targets.map(target => (0, react_dom_1.createPortal)((0, jsx_runtime_1.jsx)(RewindMessageAction, { matched: target.matched, sessionId: sessionId, openRestoredSession: openRestoredSession }), target.container, `${sessionId}:${String(target.matched.messageSeq)}`));
}
/** User-message action and its review-first file/conversation restore dialog. */
function RewindMessageAction({ matched, sessionId, openRestoredSession }) {
    const t = useText();
    const [open, setOpen] = (0, react_1.useState)(false);
    const [loading, setLoading] = (0, react_1.useState)(false);
    const [preview, setPreview] = (0, react_1.useState)(null);
    const [mode, setMode] = (0, react_1.useState)('both');
    const [applying, setApplying] = (0, react_1.useState)(false);
    const [loadingDetails, setLoadingDetails] = (0, react_1.useState)(false);
    const [stale, setStale] = (0, react_1.useState)(false);
    const [error, setError] = (0, react_1.useState)(null);
    const [completed, setCompleted] = (0, react_1.useState)(null);
    const loadAbort = (0, react_1.useRef)(null);
    const applyPending = (0, react_1.useRef)(false);
    const modeTouched = (0, react_1.useRef)(false);
    (0, react_1.useEffect)(() => () => {
        loadAbort.current?.abort();
        loadAbort.current = null;
    }, []);
    const load = (0, react_1.useCallback)(async () => {
        loadAbort.current?.abort();
        const controller = new AbortController();
        loadAbort.current = controller;
        setLoading(true);
        setStale(false);
        setError(null);
        setCompleted(null);
        try {
            const response = await fetch(`${PATH}?sessionId=${encodeURIComponent(sessionId)}&messageSeq=${String(matched.messageSeq)}`, {
                method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store', signal: controller.signal,
            });
            const decoded = decodePreview(await responseJson(response));
            if (loadAbort.current === controller) {
                setPreview(decoded);
                if (!modeTouched.current) {
                    setMode(decoded.status === 'ready' && decoded.totalChanges > 0 ? 'both' : 'messages');
                }
            }
        }
        catch (caught) {
            if (!controller.signal.aborted) {
                setPreview({ status: 'failed', error: friendlyError(caught) });
                if (!modeTouched.current)
                    setMode('messages');
            }
        }
        finally {
            if (loadAbort.current === controller) {
                loadAbort.current = null;
                setLoading(false);
            }
        }
    }, [matched.messageSeq, sessionId]);
    const show = () => {
        setOpen(true);
        setPreview(null);
        setMode('both');
        modeTouched.current = false;
        setStale(false);
        void load();
    };
    const close = () => {
        if (applying)
            return;
        loadAbort.current?.abort();
        loadAbort.current = null;
        setLoading(false);
        setOpen(false);
    };
    const chooseMode = (next) => {
        if (applying)
            return;
        modeTouched.current = true;
        setMode(next);
        setError(null);
        setCompleted(null);
    };
    const ready = preview?.status === 'ready' ? preview : null;
    const hasFileChanges = ready !== null && ready.totalChanges > 0;
    const driftBlocked = hasFileChanges && ready?.operationChanged === true;
    const sharedBlocked = (ready?.activeSessionIds.length ?? 0) > 0;
    const planMissing = hasFileChanges && ready !== null && !sharedBlocked && !driftBlocked
        && (ready.planId === undefined || ready.confirmation === undefined);
    const canApply = preview !== null
        && !loading
        && !applying
        && !loadingDetails
        && completed === null
        && (mode === 'messages'
            ? true
            : ready !== null && hasFileChanges && !driftBlocked && !sharedBlocked && !planMissing && !stale);
    const loadAllChanges = async () => {
        if (ready === null || loadingDetails || !ready.truncated)
            return;
        setLoadingDetails(true);
        setError(null);
        try {
            const collected = [...ready.changes];
            let offset = collected.length;
            while (offset < ready.totalChanges) {
                const response = await fetch(`${PATH}?sessionId=${encodeURIComponent(sessionId)}&messageSeq=${String(matched.messageSeq)}&details=1&offset=${String(offset)}&limit=200`, {
                    method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store',
                });
                const page = decodePreview(await responseJson(response));
                if (page.status !== 'ready'
                    || page.checkpointId !== ready.checkpointId
                    || page.totalChanges !== ready.totalChanges
                    || page.offset !== offset) {
                    throw new RewindRequestError('PLAN_STALE', t.listChangedWhileExpanding);
                }
                collected.push(...page.changes);
                offset += page.changes.length;
                if (page.changes.length === 0)
                    break;
            }
            if (offset !== ready.totalChanges)
                throw new RewindRequestError('PLAN_STALE', t.incompleteFileList);
            setPreview({ ...ready, changes: collected, truncated: false });
        }
        catch (caught) {
            if (caught instanceof RewindRequestError && caught.code === 'PLAN_STALE')
                setStale(true);
            setError(friendlyError(caught));
        }
        finally {
            setLoadingDetails(false);
        }
    };
    const applyRestore = async () => {
        if (preview === null || !canApply || applyPending.current)
            return;
        const body = {
            mode,
            sessionId,
            messageSeq: matched.messageSeq,
        };
        if (mode !== 'messages') {
            if (ready === null || ready.planId === undefined || ready.confirmation === undefined)
                return;
            body.checkpointId = ready.checkpointId;
            body.planId = ready.planId;
            body.confirmation = ready.confirmation;
        }
        applyPending.current = true;
        setApplying(true);
        setError(null);
        try {
            const response = await fetch(PATH, {
                method: 'POST',
                headers: { accept: 'application/json', 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            const result = recordOf(await responseJson(response));
            const resultMode = requiredString(result.mode, 'mode');
            if (resultMode !== mode)
                throw new Error(t.modeMismatch(resultMode));
            if (mode === 'messages') {
                const childSessionId = requiredString(result.sessionId, 'sessionId');
                setCompleted(t.completedMessages);
                try {
                    await openRestoredSession(childSessionId, matched.promptText);
                    setOpen(false);
                }
                catch (navigationError) {
                    setError(t.openFailed(messageOf(navigationError)));
                }
                return;
            }
            if (mode === 'code') {
                requiredString(result.rescuePointId, 'rescuePointId');
                setCompleted(t.completedCode);
                return;
            }
            const childSessionId = requiredString(result.sessionId, 'sessionId');
            requiredString(result.rescuePointId, 'rescuePointId');
            setCompleted(t.completedBoth);
            try {
                await openRestoredSession(childSessionId, matched.promptText);
                setOpen(false);
            }
            catch (navigationError) {
                setError(t.restoredButOpenFailed(messageOf(navigationError)));
            }
        }
        catch (caught) {
            if (caught instanceof RewindRequestError && (caught.code === 'PLAN_STALE' || caught.code === 'WORKSPACE_IN_USE')) {
                setStale(true);
            }
            setError(friendlyError(caught));
        }
        finally {
            applyPending.current = false;
            setApplying(false);
        }
    };
    const captureNotice = describeCaptureNotice(ready);
    const actionLabel = mode === 'both' ? t.actionRestoreAndRestart : mode === 'code' ? t.actionRestoreFiles : t.actionMessagesOnly;
    const radioName = `dcl-rewind-${sessionId}-${String(matched.messageSeq)}`;
    const branchChanged = ready !== null && ready.checkpointBranch !== ready.currentBranch;
    return ((0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-tail", children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: t.rewindTooltip, side: "bottom", children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: "dcl-rewind-trigger", onClick: show, "aria-label": t.rewindTooltip, children: (0, jsx_runtime_1.jsx)(RewindIcon, { size: 16 }) }) }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Modal, { open: open, onClose: close, title: t.rewindTooltip, closeLabel: t.dialogClose, description: t.dialogDescription, className: "dcl-rewind-dialog", contentClassName: "dcl-rewind-content", footer: ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "outline", onClick: close, disabled: applying, children: t.cancel }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "primary", onClick: () => { void applyRestore(); }, disabled: !canApply, children: applying ? t.applying : completed === null ? actionLabel : t.done })] })), children: (0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-body", children: [loading && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-status", children: t.checkingFiles }), preview?.status === 'pending' && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-status", children: t.previewPending }), preview?.status === 'missing' && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-error", children: t.previewMissing }), preview?.status === 'skipped' && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-status", children: explainCheckpointSkip(preview.reason) }), preview?.status === 'failed' && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-error", children: explainCheckpointFailure(preview.error) }), preview !== null && ((0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-options", children: [(0, jsx_runtime_1.jsxs)("label", { className: "dcl-rewind-option", "data-selected": mode === 'both', "data-disabled": applying || !hasFileChanges, children: [(0, jsx_runtime_1.jsx)("input", { type: "radio", name: radioName, checked: mode === 'both', disabled: applying || !hasFileChanges, onChange: () => { chooseMode('both'); } }), (0, jsx_runtime_1.jsxs)("span", { className: "dcl-rewind-option-content", children: [(0, jsx_runtime_1.jsx)("strong", { children: t.modeBothTitle }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-rewind-option-description", children: t.modeBothDescription })] })] }), (0, jsx_runtime_1.jsxs)("label", { className: "dcl-rewind-option", "data-selected": mode === 'code', "data-disabled": applying || !hasFileChanges, children: [(0, jsx_runtime_1.jsx)("input", { type: "radio", name: radioName, checked: mode === 'code', disabled: applying || !hasFileChanges, onChange: () => { chooseMode('code'); } }), (0, jsx_runtime_1.jsxs)("span", { className: "dcl-rewind-option-content", children: [(0, jsx_runtime_1.jsx)("strong", { children: t.modeCodeTitle }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-rewind-option-description", children: t.modeCodeDescription })] })] }), (0, jsx_runtime_1.jsxs)("label", { className: "dcl-rewind-option", "data-selected": mode === 'messages', "data-disabled": applying, children: [(0, jsx_runtime_1.jsx)("input", { type: "radio", name: radioName, checked: mode === 'messages', disabled: applying, onChange: () => { chooseMode('messages'); } }), (0, jsx_runtime_1.jsxs)("span", { className: "dcl-rewind-option-content", children: [(0, jsx_runtime_1.jsx)("strong", { children: t.modeMessagesTitle }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-rewind-option-description", children: t.modeMessagesDescription })] })] })] })), ready !== null && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [captureNotice !== null && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-warning", children: captureNotice }), (0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-summary", children: [mode === 'messages'
                                            ? (0, jsx_runtime_1.jsx)("strong", { children: t.filesUnchanged })
                                            : (0, jsx_runtime_1.jsx)("strong", { children: t.filesToRestore(ready.totalChanges) }), (0, jsx_runtime_1.jsx)("span", { children: mode === 'both' ? t.summaryBoth : mode === 'code' ? t.summaryCode : t.summaryMessages })] }), sharedBlocked && ((0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-error", children: t.sharedBlocked })), ready.headChanged && !ready.operationChanged && ((0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-warning", children: branchChanged ? t.branchChanged : t.headAdvanced })), driftBlocked && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-warning", children: t.driftBlocked }), planMissing && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-error", children: t.planMissing }), stale && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-error", children: t.stale }), ready.totalChanges === 0 && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-status", children: t.nothingToRestore }), ready.changes.length > 0 && ((0, jsx_runtime_1.jsx)("div", { className: "dcl-rewind-files", children: ready.changes.map(change => (0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-file", children: [(0, jsx_runtime_1.jsx)("code", { children: change.path }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-rewind-kind", children: fileRecoveryLabel(change.kind) })] }, change.path)) })), ready.truncated && ((0, jsx_runtime_1.jsx)("div", { className: "dcl-rewind-file-actions", children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "outline", size: "sm", onClick: () => { void loadAllChanges(); }, disabled: loadingDetails, children: loadingDetails ? t.loadingAllFiles : t.viewAllFiles(ready.totalChanges) }) }))] })), completed !== null && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-status", children: completed }), error !== null && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-error", children: error }), error !== null && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-backup", children: t.backupNote }), !loading && (preview?.status !== 'ready' || stale || planMissing || sharedBlocked || driftBlocked) && (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { className: "dcl-rewind-retry", variant: "outline", size: "sm", onClick: () => { void load(); }, children: t.recheck })] }) })] }));
}
const EMPTY_SETTINGS_SNAPSHOT = {
    status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'host',
};
/** Numeric settings fields, in the order the card renders them. */
const NUMBER_FIELDS = [
    'maxRestorePoints', 'maxTurnCheckpointsPerSession', 'maxFiles', 'maxFileBytes', 'maxSnapshotBytes',
    'planTtlMs', 'staleLockMs', 'turnCheckpointTimeoutMs', 'turnCheckpointMaxNewBytes',
];
/** Checkpoint modes, in the order the select offers them. */
const CHECKPOINT_MODES = ['off', 'auto', 'git-native', 'legacy'];
/** Checkpoint trust policies, in the order the select offers them. */
const TRUST_MODES = ['fast', 'strict'];
/** Settings card for the `turn-rewind` namespace: runtime options plus checkpoint management. */
function TurnRewindSettingsCard({ scope }) {
    const t = useText();
    const snapshot = (0, react_1.useSyncExternalStore)((0, react_1.useCallback)((notify) => scope?.subscribe(notify) ?? (() => { }), [scope]), (0, react_1.useCallback)(() => scope?.getSnapshot() ?? EMPTY_SETTINGS_SNAPSHOT, [scope]));
    const [manage, setManage] = (0, react_1.useState)(null);
    const [manageLoading, setManageLoading] = (0, react_1.useState)(false);
    const [manageError, setManageError] = (0, react_1.useState)(null);
    const [manageNotice, setManageNotice] = (0, react_1.useState)(null);
    const [formError, setFormError] = (0, react_1.useState)(null);
    const [busy, setBusy] = (0, react_1.useState)(null);
    const [drafts, setDrafts] = (0, react_1.useState)({});
    const [confirmClearAll, setConfirmClearAll] = (0, react_1.useState)(false);
    const [collapsed, setCollapsed] = (0, react_1.useState)(new Set());
    // Official plugin cards collapse behind a disclosure row; this card keeps the
    // same reading gesture so the settings page stays one row per plugin.
    const [cardOpen, setCardOpen] = (0, react_1.useState)(false);
    const refreshManage = (0, react_1.useCallback)(async () => {
        setManageLoading(true);
        setManageError(null);
        try {
            const response = await fetch(MANAGE_PATH, { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store' });
            setManage(decodeManageOverview(await responseJson(response)));
        }
        catch (caught) {
            setManageError(messageOf(caught));
        }
        finally {
            setManageLoading(false);
        }
    }, []);
    (0, react_1.useEffect)(() => { void refreshManage(); }, [refreshManage]);
    const userLayer = snapshot.user !== null && typeof snapshot.user === 'object' ? snapshot.user : {};
    const value = snapshot.value;
    const writable = snapshot.writable && snapshot.status === 'ready';
    const commitEnum = (field, next) => {
        if (scope === undefined || !writable)
            return;
        setFormError(null);
        void scope.set(field, next).catch((caught) => { setFormError(messageOf(caught)); });
    };
    const commitNumber = (field) => {
        if (scope === undefined || !writable)
            return;
        const draft = drafts[field];
        if (draft === undefined)
            return;
        setDrafts((current) => { const next = { ...current }; delete next[field]; return next; });
        if (draft.trim() === '') {
            void scope.unset(field).catch((caught) => { setFormError(messageOf(caught)); });
            return;
        }
        const parsed = Number.parseInt(draft, 10);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
            setFormError(t.positiveInteger(field));
            return;
        }
        if (parsed === value?.[field])
            return;
        setFormError(null);
        void scope.set(field, parsed).catch((caught) => { setFormError(messageOf(caught)); });
    };
    const runManageAction = async (body, key) => {
        if (busy !== null)
            return;
        setBusy(key);
        setManageError(null);
        setManageNotice(null);
        setConfirmClearAll(false);
        try {
            const result = await responseJson(await fetch(MANAGE_PATH, {
                method: 'POST',
                headers: { accept: 'application/json', 'content-type': 'application/json' },
                body: JSON.stringify(body),
            }));
            setManageNotice(decodeManageActionNotice(result));
            await refreshManage();
        }
        catch (caught) {
            setManageError(messageOf(caught));
        }
        finally {
            setBusy(null);
        }
    };
    const toggleWorkspace = (workspace) => {
        setCollapsed((current) => {
            const next = new Set(current);
            if (next.has(workspace))
                next.delete(workspace);
            else
                next.add(workspace);
            return next;
        });
    };
    return ((0, jsx_runtime_1.jsxs)("div", { className: "dcl-trs-card", "data-open": cardOpen, children: [(0, jsx_runtime_1.jsxs)("button", { type: "button", className: "dcl-trs-card-head", "aria-expanded": cardOpen, onClick: () => { setCardOpen(value => !value); }, children: [(0, jsx_runtime_1.jsxs)("span", { className: "dcl-trs-card-heading", children: [(0, jsx_runtime_1.jsx)("strong", { children: t.settingsCardTitle }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-trs-card-description", children: t.settingsCardDescription })] }), (0, jsx_runtime_1.jsx)("svg", { className: "dcl-trs-card-chevron", width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", children: (0, jsx_runtime_1.jsx)("path", { d: "M4.5 6.5 8 10l3.5-3.5", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }) })] }), cardOpen && ((0, jsx_runtime_1.jsxs)("div", { className: "dcl-trs-card-body", children: [(0, jsx_runtime_1.jsxs)("section", { className: "dcl-trs-section", children: [(0, jsx_runtime_1.jsx)("div", { className: "dcl-trs-section-title", children: (0, jsx_runtime_1.jsx)("strong", { children: t.autoCheckpointSection }) }), snapshot.status === 'loading' && (0, jsx_runtime_1.jsx)("p", { className: "dcl-trs-status", children: t.settingsLoading }), snapshot.status === 'unavailable' && (0, jsx_runtime_1.jsx)("p", { className: "dcl-trs-status", children: t.settingsUnavailable }), snapshot.status === 'ready' && !snapshot.writable && (0, jsx_runtime_1.jsx)("p", { className: "dcl-trs-status", children: t.settingsReadOnly }), value !== undefined && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("div", { className: "dcl-trs-field", children: [(0, jsx_runtime_1.jsxs)("span", { className: "dcl-trs-field-label", children: [(0, jsx_runtime_1.jsx)("strong", { children: t.autoCheckpointLabel }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-trs-field-desc", children: t.autoCheckpointDescription })] }), (0, jsx_runtime_1.jsxs)("span", { className: "dcl-trs-field-control", children: [(0, jsx_runtime_1.jsx)("select", { value: value.turnCheckpointMode, disabled: !writable || busy !== null, onChange: (event) => { commitEnum('turnCheckpointMode', event.target.value); }, children: CHECKPOINT_MODES.map((option) => ((0, jsx_runtime_1.jsx)("option", { value: option, children: t.checkpointModes[option] }, option))) }), userLayer.turnCheckpointMode !== undefined && (0, jsx_runtime_1.jsx)("span", { className: "dcl-trs-override", children: t.overridden }), userLayer.turnCheckpointMode !== undefined && ((0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "ghost", size: "sm", disabled: !writable || busy !== null, onClick: () => { setFormError(null); void scope?.unset('turnCheckpointMode').catch((caught) => { setFormError(messageOf(caught)); }); }, children: t.resetToDefault }))] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "dcl-trs-field", children: [(0, jsx_runtime_1.jsxs)("span", { className: "dcl-trs-field-label", children: [(0, jsx_runtime_1.jsx)("strong", { children: t.trustLabel }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-trs-field-desc", children: t.trustDescription })] }), (0, jsx_runtime_1.jsxs)("span", { className: "dcl-trs-field-control", children: [(0, jsx_runtime_1.jsx)("select", { value: value.turnCheckpointTrust, disabled: !writable || busy !== null, onChange: (event) => { commitEnum('turnCheckpointTrust', event.target.value); }, children: TRUST_MODES.map((option) => ((0, jsx_runtime_1.jsx)("option", { value: option, children: t.trustOptions[option] }, option))) }), userLayer.turnCheckpointTrust !== undefined && (0, jsx_runtime_1.jsx)("span", { className: "dcl-trs-override", children: t.overridden }), userLayer.turnCheckpointTrust !== undefined && ((0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "ghost", size: "sm", disabled: !writable || busy !== null, onClick: () => { setFormError(null); void scope?.unset('turnCheckpointTrust').catch((caught) => { setFormError(messageOf(caught)); }); }, children: t.resetToDefault }))] })] }), NUMBER_FIELDS.map((field) => ((0, jsx_runtime_1.jsxs)("div", { className: "dcl-trs-field", children: [(0, jsx_runtime_1.jsxs)("span", { className: "dcl-trs-field-label", children: [(0, jsx_runtime_1.jsx)("strong", { children: t.numberFields[field].label }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-trs-field-desc", children: t.numberFields[field].description })] }), (0, jsx_runtime_1.jsxs)("span", { className: "dcl-trs-field-control", children: [(0, jsx_runtime_1.jsx)("input", { type: "number", min: 1, step: 1, value: drafts[field] ?? String(value[field]), disabled: !writable || busy !== null, onChange: (event) => { setDrafts((current) => ({ ...current, [field]: event.target.value })); }, onBlur: () => { commitNumber(field); }, onKeyDown: (event) => { if (event.key === 'Enter')
                                                            commitNumber(field); } }), userLayer[field] !== undefined && (0, jsx_runtime_1.jsx)("span", { className: "dcl-trs-override", children: t.overridden }), userLayer[field] !== undefined && ((0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "ghost", size: "sm", disabled: !writable || busy !== null, onClick: () => { setFormError(null); void scope?.unset(field).catch((caught) => { setFormError(messageOf(caught)); }); }, children: t.resetToDefault }))] })] }, field)))] })), formError !== null && (0, jsx_runtime_1.jsx)("p", { className: "dcl-trs-error", children: formError }), (0, jsx_runtime_1.jsx)("p", { className: "dcl-trs-storage", children: t.storageDir(manage?.storageDir ?? '…') })] }), (0, jsx_runtime_1.jsxs)("section", { className: "dcl-trs-section", children: [(0, jsx_runtime_1.jsxs)("div", { className: "dcl-trs-section-title", children: [(0, jsx_runtime_1.jsx)("strong", { children: t.manageSection }), (0, jsx_runtime_1.jsxs)("span", { className: "dcl-trs-section-title-actions", children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "outline", size: "sm", onClick: () => { void refreshManage(); }, disabled: manageLoading, children: manageLoading ? t.refreshing : t.refresh }), manage !== null && manage.workspaces.length > 0 && (confirmClearAll
                                                ? ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "outline", size: "sm", onClick: () => { setConfirmClearAll(false); }, disabled: busy !== null, children: t.cancel }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "primary", size: "sm", onClick: () => { void runManageAction({ action: 'clear-all' }, 'clear-all'); }, disabled: busy !== null, children: busy === 'clear-all' ? t.clearing : t.confirmClearAll })] }))
                                                : (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "outline", size: "sm", onClick: () => { setConfirmClearAll(true); }, disabled: busy !== null, children: t.clearAll }))] })] }), (0, jsx_runtime_1.jsx)("p", { className: "dcl-trs-manage-total", children: manage === null
                                    ? t.manageLoading
                                    : t.manageTotal(manage.workspaces.length, manage.totalBytes >= 0 ? manage.workspaces.reduce((total, workspace) => total + workspace.restorePoints.length, 0) : 0, formatBytes(manage.totalBytes)) }), manageNotice !== null && (0, jsx_runtime_1.jsx)("p", { className: "dcl-trs-notice", "data-warning": manageNotice.warning, children: manageNotice.message }), manageError !== null && (0, jsx_runtime_1.jsx)("p", { className: "dcl-trs-error", children: manageError }), manage?.workspaces.map((workspace) => ((0, jsx_runtime_1.jsxs)("div", { className: "dcl-trs-workspace", children: [(0, jsx_runtime_1.jsxs)("div", { className: "dcl-trs-workspace-head", children: [(0, jsx_runtime_1.jsx)("span", { className: "dcl-trs-workspace-path", title: workspace.workspace, children: workspace.workspace }), (0, jsx_runtime_1.jsxs)("span", { className: "dcl-trs-workspace-meta", children: [t.workspacePoints(workspace.restorePoints.length), " \u00B7 ", formatBytes(workspace.totalBytes)] }), workspace.recoveryCount > 0 && (0, jsx_runtime_1.jsx)("span", { className: "dcl-trs-badge", children: t.pendingRecoveries(workspace.recoveryCount) }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "ghost", size: "sm", onClick: () => { toggleWorkspace(workspace.workspace); }, children: collapsed.has(workspace.workspace) ? t.expand : t.collapse }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "outline", size: "sm", onClick: () => { void runManageAction({ action: 'clear-workspace', workspace: workspace.workspace }, `clear:${workspace.workspace}`); }, disabled: busy !== null || workspace.restorePoints.length === 0, children: busy === `clear:${workspace.workspace}` ? t.clearing : t.clearWorkspace })] }), !collapsed.has(workspace.workspace) && workspace.restorePoints.length > 0 && ((0, jsx_runtime_1.jsx)("ul", { className: "dcl-trs-points", children: workspace.restorePoints.map((point) => ((0, jsx_runtime_1.jsxs)("li", { className: "dcl-trs-point", children: [(0, jsx_runtime_1.jsx)("time", { children: formatTime(point.createdAt) }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-trs-point-kind", children: t.pointKinds[point.kind] ?? point.kind }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-trs-point-size", children: formatBytes(point.totalBytes) }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-trs-point-files", children: t.fileCount(point.fileCount) }), point.sessionId !== undefined && (0, jsx_runtime_1.jsx)("code", { children: point.sessionId }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "ghost", size: "sm", onClick: () => { void runManageAction({ action: 'delete', workspace: workspace.workspace, restorePointId: point.id }, `delete:${point.id}`); }, disabled: busy !== null, children: busy === `delete:${point.id}` ? t.deleting : t.remove })] }, point.id))) }))] }, workspace.workspace))), manage !== null && manage.workspaces.length === 0 && (0, jsx_runtime_1.jsx)("p", { className: "dcl-trs-status", children: t.noCheckpoints })] })] }))] }));
}
function decodeManageOverview(value) {
    const record = recordOf(value);
    const workspacesValue = record.workspaces;
    if (!Array.isArray(workspacesValue))
        throw new Error(uiText().manageMissingWorkspaces);
    return {
        storageDir: requiredString(record.storageDir, 'storageDir'),
        totalBytes: requiredInteger(record.totalBytes, 'totalBytes'),
        workspaces: workspacesValue.map((entry) => {
            const workspace = recordOf(entry);
            const pointsValue = workspace.restorePoints;
            if (!Array.isArray(pointsValue))
                throw new Error(uiText().manageMissingRestorePoints);
            return {
                workspace: requiredString(workspace.workspace, 'workspace'),
                totalBytes: requiredInteger(workspace.totalBytes, 'totalBytes'),
                recoveryCount: requiredInteger(workspace.recoveryCount, 'recoveryCount'),
                restorePoints: pointsValue.map((pointEntry) => {
                    const point = recordOf(pointEntry);
                    return {
                        id: requiredString(point.id, 'id'),
                        kind: requiredString(point.kind, 'kind'),
                        format: requiredInteger(point.format, 'format'),
                        createdAt: requiredInteger(point.createdAt, 'createdAt'),
                        totalBytes: requiredInteger(point.totalBytes, 'totalBytes'),
                        fileCount: requiredInteger(point.fileCount, 'fileCount'),
                        ...optionalRecordString(point, 'sessionId'),
                        ...optionalRecordString(point, 'label'),
                    };
                }),
            };
        }),
    };
}
function decodeManageActionNotice(value) {
    const record = recordOf(value);
    const action = requiredString(record.action, 'action');
    if (action === 'clear-all') {
        if (!Array.isArray(record.reports))
            throw new Error(uiText().clearMissingReports);
        const totals = record.reports.reduce((current, entry) => {
            const report = recordOf(entry);
            return {
                deleted: current.deleted + requiredInteger(report.deletedRestorePoints, 'deletedRestorePoints'),
                retained: current.retained + requiredInteger(report.retainedRestorePoints, 'retainedRestorePoints'),
            };
        }, { deleted: 0, retained: 0 });
        const failures = Array.isArray(record.failures) ? record.failures.length : 0;
        const warning = record.status === 'partial' || totals.retained > 0 || failures > 0;
        return {
            warning,
            message: uiText().clearedAll(totals.deleted, totals.retained, failures),
        };
    }
    const deleted = requiredInteger(record.deletedRestorePoints, 'deletedRestorePoints');
    const retained = requiredInteger(record.retainedRestorePoints, 'retainedRestorePoints');
    return {
        warning: retained > 0,
        message: uiText().cleared(deleted, retained),
    };
}
/** Format one byte count with human-friendly units. */
function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0)
        return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${unit === 0 ? String(Math.round(value)) : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
function formatTime(timestamp) {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? String(timestamp) : date.toLocaleString();
}
function decodePreview(value) {
    const record = recordOf(value);
    const status = requiredString(record.status, 'status');
    if (status === 'pending' || status === 'missing')
        return { status };
    if (status === 'skipped')
        return { status, reason: requiredString(record.reason, 'reason') };
    if (status === 'failed')
        return { status, error: requiredString(record.error, 'error') };
    if (status !== 'ready')
        throw new Error(uiText().unknownStatus(status));
    const changesValue = record.changes;
    if (!Array.isArray(changesValue))
        throw new Error(uiText().previewMissingChanges);
    const changes = changesValue.map((entry) => {
        const change = recordOf(entry);
        return { path: requiredString(change.path, 'path'), kind: requiredString(change.kind, 'kind') };
    });
    const activeSessionIdsValue = record.activeSessionIds;
    if (!Array.isArray(activeSessionIdsValue) || !activeSessionIdsValue.every(value => typeof value === 'string')) {
        throw new Error(uiText().previewMissingActiveSessionIds);
    }
    return {
        status,
        sessionId: requiredString(record.sessionId, 'sessionId'),
        messageSeq: requiredInteger(record.messageSeq, 'messageSeq'),
        turn: requiredInteger(record.turn, 'turn'),
        checkpointId: requiredString(record.checkpointId, 'checkpointId'),
        turnStartSeq: requiredInteger(record.turnStartSeq, 'turnStartSeq'),
        totalChanges: requiredInteger(record.totalChanges, 'totalChanges'),
        changes,
        offset: requiredInteger(record.offset, 'offset'),
        truncated: requiredBoolean(record.truncated, 'truncated'),
        skippedCount: typeof record.skippedCount === 'number' ? record.skippedCount : 0,
        skipped: Array.isArray(record.skipped)
            ? record.skipped.map((entry) => {
                const skip = recordOf(entry);
                return { path: requiredString(skip.path, 'path'), reason: requiredString(skip.reason, 'reason') };
            })
            : [],
        ...(record.captureTruncated === 'file-limit' || record.captureTruncated === 'snapshot-limit'
            ? { captureTruncated: record.captureTruncated }
            : {}),
        headChanged: requiredBoolean(record.headChanged, 'headChanged'),
        operationChanged: requiredBoolean(record.operationChanged, 'operationChanged'),
        ...optionalRecordString(record, 'checkpointHead'),
        ...optionalRecordString(record, 'checkpointBranch'),
        ...optionalRecordString(record, 'checkpointOperation'),
        ...optionalRecordString(record, 'currentHead'),
        ...optionalRecordString(record, 'currentBranch'),
        ...optionalRecordString(record, 'currentOperation'),
        activeSessionIds: activeSessionIdsValue,
        restoreBlocked: requiredBoolean(record.restoreBlocked, 'restoreBlocked'),
        ...(typeof record.planId === 'string' ? { planId: record.planId } : {}),
        ...(typeof record.confirmation === 'string' ? { confirmation: record.confirmation } : {}),
    };
}
/** Resolve one conversation node to its DOM row key and rewind match. */
function selectRewindMessageTarget(value) {
    const node = 'key' in value && 'data' in value ? value.data : value;
    const matched = selectRewindMessage(node);
    if (matched === null)
        return null;
    return {
        matched,
        rowKey: 'key' in value && 'data' in value ? value.key : `node:${String(node.seq)}`,
    };
}
/** CSS-module class every DSH message action row matches (`<hash>_actions`). */
const ACTIONS_SELECTOR = '[class*="actions"]';
/**
 * Wrapper that owned the hover chrome and the action row before DSH 0.1.5. The
 * attribute is gone in 0.1.5 — the message row itself is the hover root now — so it
 * is only a fallback for older clients.
 */
const LEGACY_HOVER_ROOT_SELECTOR = '[data-time-hover-root="true"]';
/** Query one descendant, tolerating a row double that implements no `querySelector`. */
function queryInside(root, selector) {
    const query = root.querySelector;
    return typeof query === 'function' ? query.call(root, selector) : null;
}
/**
 * Resolve the container one rewind button is portalled into.
 *
 * DSH 0.1.5 renders the copy/branch icon row (`MessageIconActions`, class
 * `<hash>_actions`) as a direct child of the user-message row and dropped
 * `data-time-hover-root`; older clients nested that row under the removed wrapper.
 * Both shapes are tried, current first. There is no official slot for user-message
 * actions in 0.1.5 — only `conversation.chat.assistant-actions`, for finalized
 * assistant turns — so this bridge stays DOM-based.
 * @param row - the `[data-chat-flow-kind="user"]` row owning one message.
 * @returns the actions container, or null when the row exposes none.
 */
function findActionsContainer(row) {
    const direct = queryInside(row, ACTIONS_SELECTOR);
    if (direct !== null)
        return direct;
    const legacy = queryInside(row, LEGACY_HOVER_ROOT_SELECTOR);
    if (legacy === null)
        return null;
    return queryInside(legacy, ACTIONS_SELECTOR) ?? legacy.lastElementChild;
}
function collectPortalTargets(nodes) {
    const rows = new Map();
    for (const element of Array.from(document.querySelectorAll('[data-chat-flow-kind="user"][data-chat-anchor-key]'))) {
        const key = element.dataset.chatAnchorKey;
        if (key !== undefined)
            rows.set(key, element);
    }
    const targets = [];
    for (const value of nodes) {
        const target = selectRewindMessageTarget(value);
        if (target === null)
            continue;
        const row = rows.get(target.rowKey);
        const actions = row === undefined ? null : findActionsContainer(row);
        if (!(actions instanceof HTMLElement))
            continue;
        targets.push({ container: actions, matched: target.matched });
    }
    return targets;
}
function samePortalTargets(left, right) {
    return left.length === right.length && left.every((target, index) => {
        const other = right[index];
        return other !== undefined
            && target.container === other.container
            && target.matched.messageSeq === other.matched.messageSeq
            && target.matched.promptText === other.matched.promptText;
    });
}
async function openSessionWithDraft(ctx, sessionId, promptText) {
    let lastError = new Error(uiText().sessionNotReady);
    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            ctx.sessions.open(sessionId);
            const scope = ctx.sessions.scope(sessionId);
            if (scope !== undefined) {
                ctx.conversation.input.for(scope).setDraft(promptText);
                return;
            }
            lastError = new Error(uiText().sessionNotReady);
        }
        catch (error) {
            lastError = error;
        }
        await new Promise(resolve => { setTimeout(resolve, 50); });
    }
    throw lastError;
}
/**
 * Read one rewind response body without ever leaking a raw parse error.
 *
 * A missing route, a restarted Host, or a proxy answering before the plugin
 * loads all produce a body that is not the plugin's JSON envelope; those must
 * surface as an explained failure instead of `Failed to execute 'json' …`.
 * @param response - fetch response from the rewind endpoint.
 * @returns the decoded JSON body.
 */
async function responseJson(response) {
    const text = await response.text();
    let value;
    try {
        value = text === '' ? undefined : JSON.parse(text);
    }
    catch {
        throw new RewindRequestError(response.ok ? 'REWIND_INVALID_RESPONSE' : 'REWIND_ENDPOINT_UNAVAILABLE', uiText().unparsableResponse(String(response.status)));
    }
    const record = value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
    if (!response.ok) {
        throw new RewindRequestError(typeof record?.code === 'string'
            ? record.code
            : response.status === 404 ? 'REWIND_ENDPOINT_UNAVAILABLE' : 'REWIND_FAILED', typeof record?.error === 'string' ? record.error : uiText().requestFailed(String(response.status)));
    }
    if (value === undefined) {
        throw new RewindRequestError('REWIND_INVALID_RESPONSE', uiText().emptyResponse);
    }
    return value;
}
class RewindRequestError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
function recordOf(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error(uiText().invalidObject);
    return value;
}
function requiredString(value, name) {
    if (typeof value !== 'string' || value === '')
        throw new Error(uiText().invalidField(name));
    return value;
}
function requiredInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new Error(uiText().invalidField(name));
    return value;
}
function requiredBoolean(value, name) {
    if (typeof value !== 'boolean')
        throw new Error(uiText().invalidField(name));
    return value;
}
function optionalRecordString(record, name) {
    const value = record[name];
    if (value === undefined)
        return {};
    return { [name]: requiredString(value, name) };
}
/** Describe the user-visible result of restoring one changed file. */
function fileRecoveryLabel(kind) {
    return uiText().fileKinds[kind];
}
function RewindIcon({ size }) {
    return ((0, jsx_runtime_1.jsx)("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", children: (0, jsx_runtime_1.jsx)("path", { d: "M6.35 3.25 2.75 7l3.6 3.75M3.1 7h5.15a4.25 4.25 0 0 1 4.25 4.25v1.25", stroke: "currentColor", strokeWidth: "1.45", strokeLinecap: "round", strokeLinejoin: "round" }) }));
}
function friendlyError(error) {
    if (!(error instanceof RewindRequestError))
        return messageOf(error);
    return uiText().errors[error.code] ?? error.message;
}
/**
 * Describe what a checkpoint could not store, in one user-facing sentence.
 *
 * Limits leave a restore point partial rather than failing it, so the dialog has
 * to say which files stay untouched when the restore runs.
 * @param ready - decoded ready preview, or null.
 * @returns the warning text, or null when the checkpoint is complete.
 */
function describeCaptureNotice(ready) {
    if (ready === null)
        return null;
    const example = (ready.skipped ?? [])[0]?.path;
    if (ready.captureTruncated === 'snapshot-limit')
        return uiText().captureSnapshotLimit;
    if (ready.captureTruncated === 'file-limit')
        return uiText().captureFileLimit;
    if (ready.skippedCount > 0)
        return uiText().captureSkipped(ready.skippedCount, example);
    return null;
}
/**
 * Explain one recorded checkpoint skip in user terms.
 *
 * A skip is not a failure of the message: the turn ran normally and only the
 * file snapshot is missing, so the text names the actual cause and the two
 * levers that fix it.
 * @param reason - reason recorded by the Host, usually a `[CODE] detail` line.
 * @returns one user-facing sentence.
 */
function explainCheckpointSkip(reason) {
    const code = /^\[([A-Z_]+)\]/.exec(reason)?.[1];
    const t = uiText();
    if (code === 'TURN_CHECKPOINT_TIMEOUT')
        return t.skipTimeout;
    if (code === 'TURN_CHECKPOINT_DISABLED')
        return t.skipDisabled;
    if (code === 'TURN_CHECKPOINT_NEW_CONTENT_LIMIT')
        return t.skipNewContentLimit;
    return t.skipOther(reason);
}
/**
 * Explain one recorded checkpoint failure in user terms.
 *
 * The Host records the raw `[CODE] diagnostic` line; a non-Git project
 * directory is the common case and deserves a plain sentence instead of a
 * `git rev-parse` transcript.
 * @param message - recorded checkpoint failure message.
 * @returns one user-facing sentence.
 */
function explainCheckpointFailure(message) {
    const code = /^\[([A-Z_]+)\]/.exec(message)?.[1];
    const t = uiText();
    switch (code) {
        case 'GIT_COMMAND_FAILED':
            return /not a git repository/i.test(message) ? t.failureNotGitRepository : t.failureGitStatus(message);
        case 'FILE_TOO_LARGE':
        case 'SNAPSHOT_TOO_LARGE':
        case 'TOO_MANY_FILES':
            return t.failureSizeOrCount;
        case 'UNSUPPORTED_FILE_TYPE':
            return t.failureUnsupportedType;
        case 'IGNORE_FILE_INVALID':
            return t.failureIgnoreFileInvalid;
        case 'INVALID_PATH':
            return t.failureInvalidPath;
        default:
            return t.failureOther(message);
    }
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}

return module.exports; } });
//# sourceMappingURL=client.js.map
