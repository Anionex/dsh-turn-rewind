window.__ModuleLoader__.load({ id: "@anionex/dsh-turn-rewind", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.selectRewindMessage = selectRewindMessage;
exports.apply = apply;
exports.RewindMessagePortals = RewindMessagePortals;
exports.RewindMessageAction = RewindMessageAction;
exports.TurnRewindSettingsCard = TurnRewindSettingsCard;
exports.formatBytes = formatBytes;
exports.selectRewindMessageTarget = selectRewindMessageTarget;
exports.fileRecoveryLabel = fileRecoveryLabel;
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
.dcl-trs-card{display:flex;flex-direction:column;gap:16px;width:100%;min-width:0}
.dcl-trs-section{display:flex;flex-direction:column;gap:10px;min-width:0}
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
/** Browser plugin entry: bridge every direct user-message action row to the rewind UI. */
exports.inject = ['slots', 'sessions', 'conversation'];
function apply(ctx) {
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
/** Session-scoped bridge that portals rewind controls into direct user-message action rows. */
function RewindMessagePortals({ sessionId, openRestoredSession, useSession }) {
    const nodes = useSession(snapshot => snapshot.chat?.nodes.values() ?? snapshot.nodes);
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
                    throw new RewindRequestError('PLAN_STALE', '项目文件在展开列表时发生了变化。');
                }
                collected.push(...page.changes);
                offset += page.changes.length;
                if (page.changes.length === 0)
                    break;
            }
            if (offset !== ready.totalChanges)
                throw new RewindRequestError('PLAN_STALE', '无法读取完整的文件列表。');
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
                throw new Error(`服务器返回了不匹配的回退模式：${resultMode}`);
            if (mode === 'messages') {
                const childSessionId = requiredString(result.sessionId, 'sessionId');
                setCompleted('已创建从这里开始的新对话；项目文件保持不变。');
                try {
                    await openRestoredSession(childSessionId, matched.promptText);
                    setOpen(false);
                }
                catch (navigationError) {
                    setError(`新对话已创建，但没能自动打开：${messageOf(navigationError)}`);
                }
                return;
            }
            if (mode === 'code') {
                requiredString(result.rescuePointId, 'rescuePointId');
                setCompleted('项目文件已恢复；当前对话保持不变。恢复前的文件已自动备份。');
                return;
            }
            const childSessionId = requiredString(result.sessionId, 'sessionId');
            requiredString(result.rescuePointId, 'rescuePointId');
            setCompleted('项目文件已恢复，并已创建新对话。恢复前的文件已自动备份。');
            try {
                await openRestoredSession(childSessionId, matched.promptText);
                setOpen(false);
            }
            catch (navigationError) {
                setError(`文件已经恢复，新对话也已创建，但没能自动打开：${messageOf(navigationError)}`);
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
    const actionLabel = mode === 'both' ? '恢复并从这里继续' : mode === 'code' ? '恢复文件' : '只回溯消息';
    const radioName = `dcl-rewind-${sessionId}-${String(matched.messageSeq)}`;
    const branchChanged = ready !== null && ready.checkpointBranch !== ready.currentBranch;
    return ((0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-tail", children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: "\u6062\u590D\u5230\u53D1\u9001\u8FD9\u6761\u6D88\u606F\u4E4B\u524D", side: "bottom", children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: "dcl-rewind-trigger", onClick: show, "aria-label": "\u6062\u590D\u5230\u53D1\u9001\u8FD9\u6761\u6D88\u606F\u4E4B\u524D", children: (0, jsx_runtime_1.jsx)(RewindIcon, { size: 16 }) }) }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Modal, { open: open, onClose: close, title: "\u6062\u590D\u5230\u53D1\u9001\u8FD9\u6761\u6D88\u606F\u4E4B\u524D", closeLabel: "\u5173\u95ED", description: "\u67E5\u770B\u6062\u590D\u7684\u6587\u4EF6\uFF0C\u9009\u62E9\u9002\u5408\u4F60\u7684\u56DE\u9000\u65B9\u5F0F\u3002\u5F53\u524D\u4F1A\u8BDD\u4E0D\u53D7\u5F71\u54CD\u3002", className: "dcl-rewind-dialog", contentClassName: "dcl-rewind-content", footer: ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "outline", onClick: close, disabled: applying, children: "\u53D6\u6D88" }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "primary", onClick: () => { void applyRestore(); }, disabled: !canApply, children: applying ? '正在恢复…' : completed === null ? actionLabel : '已完成' })] })), children: (0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-body", children: [loading && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-status", children: "\u6B63\u5728\u68C0\u67E5\u53EF\u4EE5\u6062\u590D\u7684\u9879\u76EE\u6587\u4EF6\u2026" }), preview?.status === 'pending' && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-status", children: "\u8FD9\u6761\u6D88\u606F\u53D1\u9001\u524D\u7684\u6587\u4EF6\u8FD8\u5728\u4FDD\u5B58\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002" }), preview?.status === 'missing' && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-error", children: "\u6CA1\u6709\u4FDD\u5B58\u8FD9\u6761\u6D88\u606F\u53D1\u9001\u524D\u7684\u6587\u4EF6\u3002\u53EF\u80FD\u662F\u5F53\u65F6\u8FD8\u6CA1\u542F\u7528\u56DE\u9000\u529F\u80FD\u3001\u8BB0\u5F55\u5DF2\u8D85\u8FC7\u4FDD\u7559\u671F\u9650\uFF0C\u6216\u5DF2\u5173\u95ED\u81EA\u52A8\u68C0\u67E5\u70B9\u3002\u4ECD\u53EF\u53EA\u56DE\u6EAF\u6D88\u606F\u3002" }), preview?.status === 'skipped' && (0, jsx_runtime_1.jsxs)("p", { className: "dcl-rewind-status", children: ["\u4E3A\u907F\u514D\u963B\u585E\u6D88\u606F\u53D1\u9001\uFF0C\u672C\u8F6E\u6CA1\u6709\u81EA\u52A8\u4FDD\u5B58\u6587\u4EF6\uFF1A", preview.reason, "\u4ECD\u53EF\u53EA\u56DE\u6EAF\u6D88\u606F\u3002"] }), preview?.status === 'failed' && (0, jsx_runtime_1.jsxs)("p", { className: "dcl-rewind-error", children: ["\u6CA1\u80FD\u4FDD\u5B58\u8FD9\u6761\u6D88\u606F\u53D1\u9001\u524D\u7684\u6587\u4EF6\uFF1A", preview.error, "\u4ECD\u53EF\u53EA\u56DE\u6EAF\u6D88\u606F\u3002"] }), preview !== null && ((0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-options", children: [(0, jsx_runtime_1.jsxs)("label", { className: "dcl-rewind-option", "data-selected": mode === 'both', "data-disabled": applying || !hasFileChanges, children: [(0, jsx_runtime_1.jsx)("input", { type: "radio", name: radioName, checked: mode === 'both', disabled: applying || !hasFileChanges, onChange: () => { chooseMode('both'); } }), (0, jsx_runtime_1.jsxs)("span", { className: "dcl-rewind-option-content", children: [(0, jsx_runtime_1.jsx)("strong", { children: "\u6062\u590D\u6587\u4EF6\u5E76\u4ECE\u8FD9\u91CC\u7EE7\u7EED" }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-rewind-option-description", children: "\u521B\u5EFA\u4E00\u4E2A\u4ECE\u8FD9\u91CC\u5F00\u59CB\u7684\u65B0\u4F1A\u8BDD\uFF08\u5F53\u524D\u5BF9\u8BDD\u4F1A\u4FDD\u7559\uFF09" })] })] }), (0, jsx_runtime_1.jsxs)("label", { className: "dcl-rewind-option", "data-selected": mode === 'code', "data-disabled": applying || !hasFileChanges, children: [(0, jsx_runtime_1.jsx)("input", { type: "radio", name: radioName, checked: mode === 'code', disabled: applying || !hasFileChanges, onChange: () => { chooseMode('code'); } }), (0, jsx_runtime_1.jsxs)("span", { className: "dcl-rewind-option-content", children: [(0, jsx_runtime_1.jsx)("strong", { children: "\u53EA\u6062\u590D\u6587\u4EF6" }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-rewind-option-description", children: "\u6062\u590D\u8FD9\u6761\u6D88\u606F\u53D1\u9001\u524D\u7684\u6587\u4EF6\uFF0C\u5F53\u524D\u5BF9\u8BDD\u4FDD\u6301\u4E0D\u53D8\u3002" })] })] }), (0, jsx_runtime_1.jsxs)("label", { className: "dcl-rewind-option", "data-selected": mode === 'messages', "data-disabled": applying, children: [(0, jsx_runtime_1.jsx)("input", { type: "radio", name: radioName, checked: mode === 'messages', disabled: applying, onChange: () => { chooseMode('messages'); } }), (0, jsx_runtime_1.jsxs)("span", { className: "dcl-rewind-option-content", children: [(0, jsx_runtime_1.jsx)("strong", { children: "\u53EA\u56DE\u6EAF\u6D88\u606F\uFF08\u4E0D\u52A8\u6587\u4EF6\uFF09" }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-rewind-option-description", children: "\u521B\u5EFA\u4E00\u4E2A\u4ECE\u8FD9\u91CC\u5F00\u59CB\u7684\u65B0\u4F1A\u8BDD\uFF0C\u9879\u76EE\u6587\u4EF6\u4FDD\u6301\u5F53\u524D\u72B6\u6001\u3002" })] })] })] })), ready !== null && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-summary", children: [mode === 'messages'
                                            ? (0, jsx_runtime_1.jsx)("strong", { children: "\u9879\u76EE\u6587\u4EF6\u4FDD\u6301\u4E0D\u53D8" })
                                            : (0, jsx_runtime_1.jsxs)("strong", { children: ["\u5C06\u6062\u590D ", String(ready.totalChanges), " \u4E2A\u6587\u4EF6"] }), (0, jsx_runtime_1.jsx)("span", { children: mode === 'both' ? '恢复后在新对话里继续' : mode === 'code' ? '当前对话保持不变' : '仅创建从这里继续的新对话' })] }), sharedBlocked && ((0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-error", children: "\u8FD9\u4E2A\u9879\u76EE\u76EE\u5F55\u8FD8\u6709\u522B\u7684\u5BF9\u8BDD\u6B63\u5728\u8FD0\u884C\u3002\u6062\u590D\u6587\u4EF6\u4F1A\u5F71\u54CD\u5230\u5B83\u4EEC\uFF0C\u56E0\u6B64\u672C\u6B21\u64CD\u4F5C\u5DF2\u88AB\u963B\u6B62\u3002\u8BF7\u7B49\u90A3\u4E9B\u5BF9\u8BDD\u7ED3\u675F\u6216\u505C\u6B62\u540E\uFF0C\u518D\u91CD\u65B0\u68C0\u67E5\u3002" })), ready.headChanged && !ready.operationChanged && ((0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-warning", children: branchChanged
                                        ? '当前所在的 Git 分支和发送这条消息时不同。恢复不会切换分支，只会把当时的文件内容恢复到当前分支。'
                                        : '这条消息之后有了新的 Git 提交。恢复只会改文件，不会撤销提交；完成后这些文件会显示为未提交修改。' })), driftBlocked && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-warning", children: "Git \u6B63\u5728\u8FDB\u884C\u5408\u5E76\u3001\u53D8\u57FA\u6216\u7C7B\u4F3C\u64CD\u4F5C\u3002\u8BF7\u5148\u5B8C\u6210\u6216\u53D6\u6D88\u8FD9\u6B21 Git \u64CD\u4F5C\uFF0C\u518D\u91CD\u65B0\u68C0\u67E5\u3002" }), planMissing && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-error", children: "\u6062\u590D\u4FE1\u606F\u5DF2\u7ECF\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u68C0\u67E5\u3002" }), stale && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-error", children: "\u9879\u76EE\u6587\u4EF6\u5728\u68C0\u67E5\u540E\u53C8\u53D1\u751F\u4E86\u53D8\u5316\u3002\u4E3A\u907F\u514D\u8986\u76D6\u65B0\u4FEE\u6539\uFF0C\u8FD9\u6B21\u6062\u590D\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u68C0\u67E5\u3002" }), ready.totalChanges === 0 && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-status", children: "\u9879\u76EE\u6587\u4EF6\u5DF2\u7ECF\u662F\u8FD9\u6761\u6D88\u606F\u53D1\u9001\u524D\u7684\u72B6\u6001\uFF0C\u65E0\u9700\u6062\u590D\u6587\u4EF6\u3002\u53EF\u9009\u62E9\u300C\u53EA\u56DE\u6EAF\u6D88\u606F\u300D\u91CD\u65B0\u5F00\u59CB\u8FD9\u6BB5\u5BF9\u8BDD\u3002" }), ready.changes.length > 0 && ((0, jsx_runtime_1.jsx)("div", { className: "dcl-rewind-files", children: ready.changes.map(change => (0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-file", children: [(0, jsx_runtime_1.jsx)("code", { children: change.path }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-rewind-kind", children: fileRecoveryLabel(change.kind) })] }, change.path)) })), ready.truncated && ((0, jsx_runtime_1.jsx)("div", { className: "dcl-rewind-file-actions", children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "outline", size: "sm", onClick: () => { void loadAllChanges(); }, disabled: loadingDetails, children: loadingDetails ? '正在读取全部文件…' : `查看全部 ${String(ready.totalChanges)} 个文件` }) }))] })), completed !== null && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-status", children: completed }), error !== null && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-error", children: error }), error !== null && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-backup", children: "\u6062\u590D\u524D\u4F1A\u81EA\u52A8\u5907\u4EFD\u5F53\u524D\u6587\u4EF6\uFF1B\u82E5\u6062\u590D\u5931\u8D25\u4F1A\u81EA\u52A8\u8FD8\u539F\uFF0C\u9879\u76EE\u4E0D\u4F1A\u505C\u7559\u5728\u53EA\u6062\u590D\u4E86\u4E00\u90E8\u5206\u7684\u72B6\u6001\u3002" }), !loading && (preview?.status !== 'ready' || stale || planMissing || sharedBlocked || driftBlocked) && (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { className: "dcl-rewind-retry", variant: "outline", size: "sm", onClick: () => { void load(); }, children: "\u91CD\u65B0\u68C0\u67E5" })] }) })] }));
}
const EMPTY_SETTINGS_SNAPSHOT = {
    status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'host',
};
const NUMBER_FIELDS = [
    { key: 'maxRestorePoints', label: '用户/救援恢复点上限', description: '每个工作区保留的最大手动与救援恢复点数量' },
    { key: 'maxTurnCheckpointsPerSession', label: '轮次检查点上限', description: '每个会话保留的最大自动轮次检查点数量（最旧的先清理）' },
    { key: 'maxFiles', label: '单恢复点文件数上限', description: '一个恢复点最多纳入的文件数量' },
    { key: 'maxFileBytes', label: '单文件大小上限', description: '读取单个普通文件的最大字节数' },
    { key: 'maxSnapshotBytes', label: '快照总量上限', description: '单个恢复点读取的最大字节总量' },
    { key: 'planTtlMs', label: '恢复计划有效期（毫秒）', description: '回溯计划从创建到失效的时间' },
    { key: 'staleLockMs', label: '锁回收时长（毫秒）', description: '锁属主消失多久后允许回收该锁' },
    { key: 'turnCheckpointTimeoutMs', label: '检查点超时（毫秒）', description: '单次自动检查点最多阻塞消息发送的时间，超时记录跳过' },
    { key: 'turnCheckpointMaxNewBytes', label: '检查点读取上限', description: '单次 Git 原生检查点最多读取的未缓存字节数' },
];
const CHECKPOINT_MODE_LABELS = {
    off: '关闭（不创建文件检查点）',
    'git-native': 'Git 原生（推荐大仓库）',
    legacy: '完整快照（兼容模式）',
};
const TRUST_LABELS = {
    fast: '快速',
    strict: '严格',
};
const POINT_KIND_LABELS = {
    user: '手动',
    rescue: '救援',
    turn: '轮次',
};
/** Settings card for the `turn-rewind` namespace: runtime options plus checkpoint management. */
function TurnRewindSettingsCard({ scope }) {
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
            setFormError(`${field} 必须是正整数。`);
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
    return ((0, jsx_runtime_1.jsxs)("div", { className: "dcl-trs-card", children: [(0, jsx_runtime_1.jsxs)("section", { className: "dcl-trs-section", children: [(0, jsx_runtime_1.jsx)("div", { className: "dcl-trs-section-title", children: (0, jsx_runtime_1.jsx)("strong", { children: "Turn Rewind \u56DE\u9000\u8BBE\u7F6E" }) }), snapshot.status === 'loading' && (0, jsx_runtime_1.jsx)("p", { className: "dcl-trs-status", children: "\u6B63\u5728\u52A0\u8F7D\u8BBE\u7F6E\u2026" }), snapshot.status === 'unavailable' && (0, jsx_runtime_1.jsx)("p", { className: "dcl-trs-status", children: "\u5F53\u524D\u90E8\u7F72\u672A\u63D0\u4F9B\u8BBE\u7F6E\u670D\u52A1\uFF0C\u4EE5\u4E0B\u9009\u9879\u4E0D\u53EF\u7528\u3002" }), snapshot.status === 'ready' && !snapshot.writable && (0, jsx_runtime_1.jsx)("p", { className: "dcl-trs-status", children: "\u8BBE\u7F6E\u4E3A\u53EA\u8BFB\uFF08\u5F53\u524D\u6D4F\u89C8\u5668\u8FDB\u7A0B\u5185\u4FDD\u5B58\uFF09\uFF0C\u4FEE\u6539\u4E0D\u53EF\u7528\u3002" }), value !== undefined && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("div", { className: "dcl-trs-field", children: [(0, jsx_runtime_1.jsxs)("span", { className: "dcl-trs-field-label", children: [(0, jsx_runtime_1.jsx)("strong", { children: "\u81EA\u52A8\u6587\u4EF6\u68C0\u67E5\u70B9" }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-trs-field-desc", children: "\u5173\u95ED\u540E\u4E0D\u518D\u4E3A\u6BCF\u6761\u6D88\u606F\u4FDD\u5B58\u6587\u4EF6\u68C0\u67E5\u70B9\uFF1B\u56DE\u9000\u5F39\u7A97\u4ECD\u53EF\u53EA\u56DE\u6EAF\u6D88\u606F" })] }), (0, jsx_runtime_1.jsxs)("span", { className: "dcl-trs-field-control", children: [(0, jsx_runtime_1.jsx)("select", { value: value.turnCheckpointMode, disabled: !writable || busy !== null, onChange: (event) => { commitEnum('turnCheckpointMode', event.target.value); }, children: Object.keys(CHECKPOINT_MODE_LABELS).map((option) => ((0, jsx_runtime_1.jsx)("option", { value: option, children: CHECKPOINT_MODE_LABELS[option] }, option))) }), userLayer.turnCheckpointMode !== undefined && (0, jsx_runtime_1.jsx)("span", { className: "dcl-trs-override", children: "\u5DF2\u8986\u76D6" }), userLayer.turnCheckpointMode !== undefined && ((0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "ghost", size: "sm", disabled: !writable || busy !== null, onClick: () => { setFormError(null); void scope?.unset('turnCheckpointMode').catch((caught) => { setFormError(messageOf(caught)); }); }, children: "\u6062\u590D\u9ED8\u8BA4" }))] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "dcl-trs-field", children: [(0, jsx_runtime_1.jsxs)("span", { className: "dcl-trs-field-label", children: [(0, jsx_runtime_1.jsx)("strong", { children: "\u68C0\u67E5\u70B9\u4FE1\u4EFB\u7B56\u7565" }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-trs-field-desc", children: "\u5FEB\u901F\u4FE1\u4EFB Git/stat \u5143\u6570\u636E\uFF1B\u4E25\u683C\u4F1A\u9010\u4E00\u91CD\u8BFB\u6587\u4EF6\u5185\u5BB9" })] }), (0, jsx_runtime_1.jsxs)("span", { className: "dcl-trs-field-control", children: [(0, jsx_runtime_1.jsx)("select", { value: value.turnCheckpointTrust, disabled: !writable || busy !== null, onChange: (event) => { commitEnum('turnCheckpointTrust', event.target.value); }, children: Object.keys(TRUST_LABELS).map((option) => ((0, jsx_runtime_1.jsx)("option", { value: option, children: TRUST_LABELS[option] }, option))) }), userLayer.turnCheckpointTrust !== undefined && (0, jsx_runtime_1.jsx)("span", { className: "dcl-trs-override", children: "\u5DF2\u8986\u76D6" }), userLayer.turnCheckpointTrust !== undefined && ((0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "ghost", size: "sm", disabled: !writable || busy !== null, onClick: () => { setFormError(null); void scope?.unset('turnCheckpointTrust').catch((caught) => { setFormError(messageOf(caught)); }); }, children: "\u6062\u590D\u9ED8\u8BA4" }))] })] }), NUMBER_FIELDS.map((field) => ((0, jsx_runtime_1.jsxs)("div", { className: "dcl-trs-field", children: [(0, jsx_runtime_1.jsxs)("span", { className: "dcl-trs-field-label", children: [(0, jsx_runtime_1.jsx)("strong", { children: field.label }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-trs-field-desc", children: field.description })] }), (0, jsx_runtime_1.jsxs)("span", { className: "dcl-trs-field-control", children: [(0, jsx_runtime_1.jsx)("input", { type: "number", min: 1, step: 1, value: drafts[field.key] ?? String(value[field.key]), disabled: !writable || busy !== null, onChange: (event) => { setDrafts((current) => ({ ...current, [field.key]: event.target.value })); }, onBlur: () => { commitNumber(field.key); }, onKeyDown: (event) => { if (event.key === 'Enter')
                                                    commitNumber(field.key); } }), userLayer[field.key] !== undefined && (0, jsx_runtime_1.jsx)("span", { className: "dcl-trs-override", children: "\u5DF2\u8986\u76D6" }), userLayer[field.key] !== undefined && ((0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "ghost", size: "sm", disabled: !writable || busy !== null, onClick: () => { setFormError(null); void scope?.unset(field.key).catch((caught) => { setFormError(messageOf(caught)); }); }, children: "\u6062\u590D\u9ED8\u8BA4" }))] })] }, field.key)))] })), formError !== null && (0, jsx_runtime_1.jsx)("p", { className: "dcl-trs-error", children: formError }), (0, jsx_runtime_1.jsxs)("p", { className: "dcl-trs-storage", children: ["\u5B58\u50A8\u76EE\u5F55\uFF08\u5728 cordis.patch.yml \u4E2D\u914D\u7F6E\uFF0C\u4E0D\u53EF\u5728\u7EBF\u4FEE\u6539\uFF09\uFF1A", manage?.storageDir ?? '…'] })] }), (0, jsx_runtime_1.jsxs)("section", { className: "dcl-trs-section", children: [(0, jsx_runtime_1.jsxs)("div", { className: "dcl-trs-section-title", children: [(0, jsx_runtime_1.jsx)("strong", { children: "\u68C0\u67E5\u70B9\u7BA1\u7406" }), (0, jsx_runtime_1.jsxs)("span", { className: "dcl-trs-section-title-actions", children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "outline", size: "sm", onClick: () => { void refreshManage(); }, disabled: manageLoading, children: manageLoading ? '正在刷新…' : '刷新' }), manage !== null && manage.workspaces.length > 0 && (confirmClearAll
                                        ? ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "outline", size: "sm", onClick: () => { setConfirmClearAll(false); }, disabled: busy !== null, children: "\u53D6\u6D88" }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "primary", size: "sm", onClick: () => { void runManageAction({ action: 'clear-all' }, 'clear-all'); }, disabled: busy !== null, children: busy === 'clear-all' ? '正在清理…' : '确认清空全部' })] }))
                                        : (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "outline", size: "sm", onClick: () => { setConfirmClearAll(true); }, disabled: busy !== null, children: "\u4E00\u952E\u6E05\u7A7A\u5168\u90E8" }))] })] }), (0, jsx_runtime_1.jsx)("p", { className: "dcl-trs-manage-total", children: manage === null
                            ? '正在读取检查点占用…'
                            : `共 ${String(manage.workspaces.length)} 个工作区，${String(manage.totalBytes >= 0 ? manage.workspaces.reduce((total, workspace) => total + workspace.restorePoints.length, 0) : 0)} 个检查点，约 ${formatBytes(manage.totalBytes)}（Git 原生检查点的实际磁盘占用以 Git 回收为准）。` }), manageNotice !== null && (0, jsx_runtime_1.jsx)("p", { className: "dcl-trs-notice", "data-warning": manageNotice.warning, children: manageNotice.message }), manageError !== null && (0, jsx_runtime_1.jsx)("p", { className: "dcl-trs-error", children: manageError }), manage?.workspaces.map((workspace) => ((0, jsx_runtime_1.jsxs)("div", { className: "dcl-trs-workspace", children: [(0, jsx_runtime_1.jsxs)("div", { className: "dcl-trs-workspace-head", children: [(0, jsx_runtime_1.jsx)("span", { className: "dcl-trs-workspace-path", title: workspace.workspace, children: workspace.workspace }), (0, jsx_runtime_1.jsxs)("span", { className: "dcl-trs-workspace-meta", children: [String(workspace.restorePoints.length), " \u4E2A\u68C0\u67E5\u70B9 \u00B7 ", formatBytes(workspace.totalBytes)] }), workspace.recoveryCount > 0 && (0, jsx_runtime_1.jsxs)("span", { className: "dcl-trs-badge", children: [String(workspace.recoveryCount), " \u4E2A\u6062\u590D\u5F85\u5904\u7406"] }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "ghost", size: "sm", onClick: () => { toggleWorkspace(workspace.workspace); }, children: collapsed.has(workspace.workspace) ? '展开' : '收起' }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "outline", size: "sm", onClick: () => { void runManageAction({ action: 'clear-workspace', workspace: workspace.workspace }, `clear:${workspace.workspace}`); }, disabled: busy !== null || workspace.restorePoints.length === 0, children: busy === `clear:${workspace.workspace}` ? '正在清理…' : '清空此项目' })] }), !collapsed.has(workspace.workspace) && workspace.restorePoints.length > 0 && ((0, jsx_runtime_1.jsx)("ul", { className: "dcl-trs-points", children: workspace.restorePoints.map((point) => ((0, jsx_runtime_1.jsxs)("li", { className: "dcl-trs-point", children: [(0, jsx_runtime_1.jsx)("time", { children: formatTime(point.createdAt) }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-trs-point-kind", children: POINT_KIND_LABELS[point.kind] ?? point.kind }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-trs-point-size", children: formatBytes(point.totalBytes) }), (0, jsx_runtime_1.jsxs)("span", { className: "dcl-trs-point-files", children: [String(point.fileCount), " \u4E2A\u6587\u4EF6"] }), point.sessionId !== undefined && (0, jsx_runtime_1.jsx)("code", { children: point.sessionId }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "ghost", size: "sm", onClick: () => { void runManageAction({ action: 'delete', workspace: workspace.workspace, restorePointId: point.id }, `delete:${point.id}`); }, disabled: busy !== null, children: busy === `delete:${point.id}` ? '正在删除…' : '删除' })] }, point.id))) }))] }, workspace.workspace))), manage !== null && manage.workspaces.length === 0 && (0, jsx_runtime_1.jsx)("p", { className: "dcl-trs-status", children: "\u8FD8\u6CA1\u6709\u4EFB\u4F55\u5DF2\u4FDD\u5B58\u7684\u68C0\u67E5\u70B9\u3002" })] })] }));
}
function decodeManageOverview(value) {
    const record = recordOf(value);
    const workspacesValue = record.workspaces;
    if (!Array.isArray(workspacesValue))
        throw new Error('管理数据缺少 workspaces');
    return {
        storageDir: requiredString(record.storageDir, 'storageDir'),
        totalBytes: requiredInteger(record.totalBytes, 'totalBytes'),
        workspaces: workspacesValue.map((entry) => {
            const workspace = recordOf(entry);
            const pointsValue = workspace.restorePoints;
            if (!Array.isArray(pointsValue))
                throw new Error('管理数据缺少 restorePoints');
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
            throw new Error('清理结果缺少 reports');
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
            message: `已删除 ${String(totals.deleted)} 个检查点${totals.retained > 0 ? `，${String(totals.retained)} 个受保护检查点未删除` : ''}${failures > 0 ? `，${String(failures)} 个工作区清理失败` : ''}。`,
        };
    }
    const deleted = requiredInteger(record.deletedRestorePoints, 'deletedRestorePoints');
    const retained = requiredInteger(record.retainedRestorePoints, 'retainedRestorePoints');
    return {
        warning: retained > 0,
        message: `已删除 ${String(deleted)} 个检查点${retained > 0 ? `，${String(retained)} 个受保护检查点未删除` : ''}。`,
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
        throw new Error(`未知回退状态：${status}`);
    const changesValue = record.changes;
    if (!Array.isArray(changesValue))
        throw new Error('回退预览缺少 changes');
    const changes = changesValue.map((entry) => {
        const change = recordOf(entry);
        return { path: requiredString(change.path, 'path'), kind: requiredString(change.kind, 'kind') };
    });
    const activeSessionIdsValue = record.activeSessionIds;
    if (!Array.isArray(activeSessionIdsValue) || !activeSessionIdsValue.every(value => typeof value === 'string')) {
        throw new Error('回退预览缺少 activeSessionIds');
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
        const messageRoot = row?.querySelector('[data-time-hover-root="true"]');
        const actions = messageRoot?.lastElementChild;
        if (!(actions instanceof HTMLElement) || actions.querySelector(':scope > button') === null)
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
    let lastError = new Error('新对话还没有准备好');
    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            ctx.sessions.open(sessionId);
            const scope = ctx.sessions.scope(sessionId);
            if (scope !== undefined) {
                ctx.conversation.input.for(scope).setDraft(promptText);
                return;
            }
            lastError = new Error('新对话还没有准备好');
        }
        catch (error) {
            lastError = error;
        }
        await new Promise(resolve => { setTimeout(resolve, 50); });
    }
    throw lastError;
}
async function responseJson(response) {
    const value = await response.json();
    if (!response.ok) {
        const record = recordOf(value);
        throw new RewindRequestError(typeof record.code === 'string' ? record.code : 'REWIND_FAILED', typeof record.error === 'string' ? record.error : `请求失败：${String(response.status)}`);
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
        throw new Error('服务器返回了无效对象');
    return value;
}
function requiredString(value, name) {
    if (typeof value !== 'string' || value === '')
        throw new Error(`${name} 无效`);
    return value;
}
function requiredInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new Error(`${name} 无效`);
    return value;
}
function requiredBoolean(value, name) {
    if (typeof value !== 'boolean')
        throw new Error(`${name} 无效`);
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
    switch (kind) {
        case 'added': return '移除后来新增的文件';
        case 'deleted': return '找回文件';
        case 'modified': return '恢复之前的版本';
        case 'mode-changed': return '恢复文件权限';
        case 'type-changed': return '恢复之前的文件类型';
    }
}
function RewindIcon({ size }) {
    return ((0, jsx_runtime_1.jsx)("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", children: (0, jsx_runtime_1.jsx)("path", { d: "M6.35 3.25 2.75 7l3.6 3.75M3.1 7h5.15a4.25 4.25 0 0 1 4.25 4.25v1.25", stroke: "currentColor", strokeWidth: "1.45", strokeLinecap: "round", strokeLinejoin: "round" }) }));
}
function friendlyError(error) {
    if (!(error instanceof RewindRequestError))
        return messageOf(error);
    switch (error.code) {
        case 'PLAN_STALE': return '项目文件在检查后又发生了变化。为避免覆盖新修改，请重新检查后再恢复。';
        case 'PLAN_STALE_REPOSITORY': return 'Git 状态在检查后又发生了变化，恢复已失效。请重新检查后再试。';
        case 'WORKSPACE_IN_USE': return '这个项目目录还有别的对话正在运行。请等那些对话结束或停止后，再重新检查。';
        case 'WORKSPACE_LOCKED': return '另一个恢复操作正在处理这个项目目录。请等待它完成后重新检查。';
        case 'HEAD_CHANGED': return '项目的提交或分支已发生变化。为避免覆盖新改动，请重新检查后再恢复。';
        case 'REPOSITORY_CHANGED': return '这个项目目录已不属于原来的 Git 工作区，无法恢复。';
        case 'GIT_OPERATION_CHANGED': return 'Git 正在执行其他操作。请先完成或取消该操作，再重新检查。';
        case 'RESTORE_POINT_NOT_FOUND': return '没有找到对应的文件状态，可能已被清理。';
        case 'NO_CHANGES': return '项目文件已经是这条消息发送前的状态，无需恢复文件。可选择「只回溯消息」重新开始这段对话。';
        case 'RESTORE_FAILED_ROLLED_BACK': return '恢复未能完成，项目文件已自动还原到操作前的状态。';
        case 'CONVERSATION_REWIND_FAILED': return '文件已恢复，但无法创建新对话；项目文件已自动还原。';
        default: return error.message;
    }
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}

return module.exports; } });
//# sourceMappingURL=client.js.map
