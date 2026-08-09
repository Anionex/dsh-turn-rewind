window.__ModuleLoader__.load({ id: "@dsh-external/turn-rewind", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.selectRewindTurn = selectRewindTurn;
exports.apply = apply;
exports.RewindTurnPortals = RewindTurnPortals;
exports.RewindTurnTail = RewindTurnTail;
exports.fileRecoveryLabel = fileRecoveryLabel;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const react_dom_1 = require("react-dom");
const dsh_client_ui_primitives_1 = require("@deepseek-ai/dsh-client-ui-primitives");
const PATH = '/turn-rewind';
const STYLE_ID = '@dsh-external/turn-rewind';
const styles = `
.dcl-rewind-tail{display:inline-flex;align-items:center;align-self:center;order:0;height:24px;margin-left:2px}
.dcl-rewind-trigger{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dcl-rewind-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
[data-time-hover-root="true"]>:last-child:has(>.dcl-rewind-tail)>:not(button):not(.dcl-rewind-tail){order:1}
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
.dcl-rewind-details{font-size:12px;color:var(--dsw-alias-label-tertiary)}.dcl-rewind-details summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}.dcl-rewind-details dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:5px 10px;margin:10px 0 0}.dcl-rewind-details dt{color:var(--dsw-alias-label-tertiary)}.dcl-rewind-details dd{min-width:0;margin:0;overflow-wrap:anywhere;font-family:monospace;color:var(--dsw-alias-label-secondary)}
.dcl-rewind-retry{align-self:flex-start}
`;
/** Return the completed turn closed by one assistant-tail anchor. */
function selectRewindTurn(owner) {
    const node = owner.nodes.find(candidate => candidate.kind === 'assistant' && candidate.seq === owner.seq);
    return node !== undefined && Number.isSafeInteger(node.turn) && node.turn >= 0
        ? { turn: node.turn, seq: owner.seq }
        : null;
}
/** Browser plugin entry: bridge every finalized assistant action row to the rewind UI. */
exports.inject = ['slots', 'sessions'];
function apply(ctx) {
    ctx.effect(() => {
        if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null)
            return () => { };
        const tag = document.createElement('style');
        tag.dataset.plugin = '@dsh-external/turn-rewind';
        tag.dataset.pluginCss = STYLE_ID;
        tag.textContent = styles;
        document.head.appendChild(tag);
        return () => { tag.remove(); };
    }, 'turn-rewind: styles');
    ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'turn-rewind-portals',
        order: 100,
        inject: () => ({ openSession: (sessionId) => { ctx.sessions.open(sessionId); } }),
    }, RewindTurnPortals));
}
/** Session-scoped bridge that portals rewind controls into finalized assistant action rows. */
function RewindTurnPortals({ sessionId, openSession, useSession }) {
    const nodes = useSession(snapshot => snapshot.nodes);
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
    return targets.map(target => (0, react_dom_1.createPortal)((0, jsx_runtime_1.jsx)(RewindTurnTail, { matched: target.matched, sessionId: sessionId, openSession: openSession }), target.container, `${sessionId}:${String(target.matched.seq)}`));
}
/** Turn-tail action and its review-first code/conversation restore dialog. */
function RewindTurnTail({ matched, sessionId, openSession }) {
    const [open, setOpen] = (0, react_1.useState)(false);
    const [loading, setLoading] = (0, react_1.useState)(false);
    const [preview, setPreview] = (0, react_1.useState)(null);
    const [mode, setMode] = (0, react_1.useState)('both');
    const [applying, setApplying] = (0, react_1.useState)(false);
    const [loadingDetails, setLoadingDetails] = (0, react_1.useState)(false);
    const [stale, setStale] = (0, react_1.useState)(false);
    const [error, setError] = (0, react_1.useState)(null);
    const [completed, setCompleted] = (0, react_1.useState)(null);
    const [backupId, setBackupId] = (0, react_1.useState)(null);
    const loadAbort = (0, react_1.useRef)(null);
    const applyPending = (0, react_1.useRef)(false);
    (0, react_1.useEffect)(() => () => {
        loadAbort.current?.abort();
        loadAbort.current = null;
    }, []);
    const load = (0, react_1.useCallback)(async (retry = false) => {
        loadAbort.current?.abort();
        const controller = new AbortController();
        loadAbort.current = controller;
        setLoading(true);
        setStale(false);
        setError(null);
        setCompleted(null);
        setBackupId(null);
        try {
            const retryQuery = retry ? '&retry=1' : '';
            const response = await fetch(`${PATH}?sessionId=${encodeURIComponent(sessionId)}&turn=${String(matched.turn)}${retryQuery}`, {
                method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store', signal: controller.signal,
            });
            const value = await responseJson(response);
            if (loadAbort.current === controller)
                setPreview(decodePreview(value));
        }
        catch (caught) {
            if (!controller.signal.aborted)
                setError(messageOf(caught));
        }
        finally {
            if (loadAbort.current === controller) {
                loadAbort.current = null;
                setLoading(false);
            }
        }
    }, [matched.turn, sessionId]);
    const show = () => {
        setOpen(true);
        setPreview(null);
        setMode('both');
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
        setMode(next);
        setError(null);
        setCompleted(null);
    };
    const ready = preview?.status === 'ready' ? preview : null;
    const hasFileChanges = ready !== null && ready.totalChanges > 0;
    const driftBlocked = hasFileChanges && ready !== null && (ready.headChanged || ready.operationChanged);
    const sharedBlocked = ready?.restoreBlocked === true;
    const planMissing = hasFileChanges && ready !== null && !sharedBlocked && (ready.planId === undefined || ready.confirmation === undefined);
    const canApply = ready !== null
        && !loading
        && !applying
        && !loadingDetails
        && completed === null
        && hasFileChanges
        && !driftBlocked
        && !sharedBlocked
        && !planMissing
        && !stale;
    const loadAllChanges = async () => {
        if (ready === null || loadingDetails || !ready.truncated)
            return;
        setLoadingDetails(true);
        setError(null);
        try {
            const collected = [...ready.changes];
            let offset = collected.length;
            while (offset < ready.totalChanges) {
                const response = await fetch(`${PATH}?sessionId=${encodeURIComponent(sessionId)}&turn=${String(matched.turn)}&details=1&offset=${String(offset)}&limit=200`, {
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
        if (ready === null || !canApply || applyPending.current)
            return;
        const body = {
            mode,
            sessionId,
            turn: ready.turn,
            checkpointId: ready.checkpointId,
        };
        if (ready.planId === undefined || ready.confirmation === undefined)
            return;
        body.planId = ready.planId;
        body.confirmation = ready.confirmation;
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
            if (mode === 'code') {
                const rescuePointId = requiredString(result.rescuePointId, 'rescuePointId');
                setBackupId(rescuePointId);
                setCompleted('项目文件已恢复；当前对话保持不变。操作前的文件已保存在自动备份中。');
                return;
            }
            const childSessionId = requiredString(result.sessionId, 'sessionId');
            const rescuePointId = requiredString(result.rescuePointId, 'rescuePointId');
            setBackupId(rescuePointId);
            setCompleted('项目文件已恢复，并已创建从这里继续的新对话。操作前的文件已保存在自动备份中。');
            try {
                openSession(childSessionId);
                setOpen(false);
            }
            catch (navigationError) {
                setError(`回退已完成，但无法自动打开新对话：${messageOf(navigationError)}`);
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
    const actionLabel = mode === 'both' ? '恢复并继续' : '恢复文件';
    const radioName = `dcl-rewind-${sessionId}-${String(matched.turn)}`;
    return ((0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-tail", children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: `恢复到第 ${String(matched.turn)} 轮结束时的文件`, side: "bottom", children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: "dcl-rewind-trigger", onClick: show, "aria-label": `恢复到第 ${String(matched.turn)} 轮结束时的文件`, children: (0, jsx_runtime_1.jsx)(RewindIcon, { size: 16 }) }) }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Modal, { open: open, onClose: close, title: `恢复第 ${String(matched.turn)} 轮结束时的项目文件`, closeLabel: "\u5173\u95ED", description: "\u5148\u67E5\u770B\u5C06\u8981\u6062\u590D\u7684\u6587\u4EF6\uFF0C\u518D\u9009\u62E9\u662F\u5426\u4ECE\u8FD9\u91CC\u7EE7\u7EED\u65B0\u5BF9\u8BDD\u3002\u539F\u5BF9\u8BDD\u59CB\u7EC8\u4FDD\u7559\u3002", className: "dcl-rewind-dialog", contentClassName: "dcl-rewind-content", footer: ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "outline", onClick: close, disabled: applying, children: "\u53D6\u6D88" }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "primary", onClick: () => { void applyRestore(); }, disabled: !canApply, children: applying ? '正在恢复…' : completed === null ? actionLabel : '已完成' })] })), children: (0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-body", children: [loading && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-status", children: "\u6B63\u5728\u68C0\u67E5\u53EF\u4EE5\u6062\u590D\u7684\u9879\u76EE\u6587\u4EF6\u2026" }), preview?.status === 'pending' && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-status", children: "\u8FD9\u4E00\u8F6E\u7684\u6587\u4EF6\u72B6\u6001\u4ECD\u5728\u4FDD\u5B58\uFF0C\u8BF7\u7A0D\u540E\u91CD\u65B0\u68C0\u67E5\u3002" }), preview?.status === 'missing' && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-error", children: "\u6CA1\u6709\u4FDD\u5B58\u8FD9\u4E00\u8F6E\u7684\u6587\u4EF6\u72B6\u6001\u3002\u5B83\u53EF\u80FD\u65E9\u4E8E Turn Rewind \u542F\u7528\u65F6\u95F4\uFF0C\u6216\u5DF2\u7ECF\u8D85\u8FC7\u4FDD\u7559\u671F\u9650\u3002" }), preview?.status === 'failed' && (0, jsx_runtime_1.jsxs)("p", { className: "dcl-rewind-error", children: ["\u65E0\u6CD5\u8BFB\u53D6\u8FD9\u4E00\u8F6E\u7684\u6587\u4EF6\u72B6\u6001\uFF1A", preview.error] }), ready !== null && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-options", children: [(0, jsx_runtime_1.jsxs)("label", { className: "dcl-rewind-option", "data-selected": mode === 'both', "data-disabled": applying, children: [(0, jsx_runtime_1.jsx)("input", { type: "radio", name: radioName, checked: mode === 'both', disabled: applying, onChange: () => { chooseMode('both'); } }), (0, jsx_runtime_1.jsxs)("span", { className: "dcl-rewind-option-content", children: [(0, jsx_runtime_1.jsx)("strong", { children: "\u6062\u590D\u6587\u4EF6\u5E76\u4ECE\u8FD9\u91CC\u7EE7\u7EED" }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-rewind-option-description", children: "\u6062\u590D\u9879\u76EE\u6587\u4EF6\uFF0C\u7136\u540E\u521B\u5EFA\u5E76\u6253\u5F00\u4ECE\u8FD9\u4E00\u8F6E\u7EE7\u7EED\u7684\u65B0\u5BF9\u8BDD\u3002\u539F\u5BF9\u8BDD\u4FDD\u7559\u3002" })] })] }), (0, jsx_runtime_1.jsxs)("label", { className: "dcl-rewind-option", "data-selected": mode === 'code', "data-disabled": applying, children: [(0, jsx_runtime_1.jsx)("input", { type: "radio", name: radioName, checked: mode === 'code', disabled: applying, onChange: () => { chooseMode('code'); } }), (0, jsx_runtime_1.jsxs)("span", { className: "dcl-rewind-option-content", children: [(0, jsx_runtime_1.jsx)("strong", { children: "\u53EA\u6062\u590D\u6587\u4EF6" }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-rewind-option-description", children: "\u5F53\u524D\u5BF9\u8BDD\u4FDD\u6301\u4E0D\u53D8\uFF0C\u53EA\u6062\u590D\u8FD9\u4E00\u8F6E\u7ED3\u675F\u65F6\u7684\u9879\u76EE\u6587\u4EF6\u3002" })] })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-summary", children: [(0, jsx_runtime_1.jsxs)("strong", { children: ["\u5C06\u6062\u590D ", String(ready.totalChanges), " \u4E2A\u6587\u4EF6"] }), (0, jsx_runtime_1.jsx)("span", { children: mode === 'both' ? '恢复后从这里继续新对话' : '当前对话保持不变' })] }), ready.totalChanges > 0 && !sharedBlocked && ((0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-backup", children: "\u6062\u590D\u524D\u4F1A\u81EA\u52A8\u5907\u4EFD\u5F53\u524D\u9879\u76EE\u6587\u4EF6\u3002\u6062\u590D\u5931\u8D25\u65F6\u4F1A\u81EA\u52A8\u8FD8\u539F\uFF0C\u4E0D\u4F1A\u8BA9\u9879\u76EE\u505C\u7559\u5728\u53EA\u6062\u590D\u4E86\u4E00\u90E8\u5206\u7684\u72B6\u6001\u3002" })), sharedBlocked && ((0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-error", children: "\u8FD9\u4E2A\u9879\u76EE\u76EE\u5F55\u8FD8\u6709\u5176\u4ED6\u5BF9\u8BDD\u6B63\u5728\u8FD0\u884C\u3002\u6062\u590D\u6587\u4EF6\u4F1A\u5F71\u54CD\u90A3\u4E9B\u5BF9\u8BDD\uFF0C\u56E0\u6B64\u5F53\u524D\u64CD\u4F5C\u5DF2\u88AB\u963B\u6B62\u3002\u8BF7\u7B49\u5F85\u5B83\u4EEC\u7ED3\u675F\u6216\u5148\u505C\u6B62\u8FD0\u884C\uFF0C\u518D\u91CD\u65B0\u68C0\u67E5\u3002" })), driftBlocked && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-warning", children: "\u9879\u76EE\u7684\u7248\u672C\u72B6\u6001\u5DF2\u7ECF\u53D8\u5316\uFF0C\u5F53\u524D\u65E0\u6CD5\u5B89\u5168\u6062\u590D\u3002\u8BF7\u5148\u5B8C\u6210\u6216\u53D6\u6D88\u6B63\u5728\u8FDB\u884C\u7684\u7248\u672C\u63A7\u5236\u64CD\u4F5C\uFF0C\u7136\u540E\u91CD\u65B0\u68C0\u67E5\u3002" }), planMissing && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-error", children: "\u6062\u590D\u4FE1\u606F\u5DF2\u7ECF\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u68C0\u67E5\u6587\u4EF6\u3002" }), stale && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-error", children: "\u9879\u76EE\u6587\u4EF6\u5728\u68C0\u67E5\u540E\u53C8\u53D1\u751F\u4E86\u53D8\u5316\u3002\u4E3A\u907F\u514D\u8986\u76D6\u65B0\u4FEE\u6539\uFF0C\u8FD9\u6B21\u6062\u590D\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u68C0\u67E5\u3002" }), ready.totalChanges === 0 && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-status", children: "\u9879\u76EE\u6587\u4EF6\u5DF2\u7ECF\u548C\u8FD9\u4E00\u8F6E\u7ED3\u675F\u65F6\u4E00\u81F4\uFF0C\u65E0\u9700\u6062\u590D\u3002\u5982\u9700\u4ECE\u8FD9\u91CC\u5F00\u59CB\u65B0\u5BF9\u8BDD\uFF0C\u8BF7\u4F7F\u7528\u56DE\u590D\u65C1\u7684 Branch \u6309\u94AE\u3002" }), ready.changes.length > 0 && ((0, jsx_runtime_1.jsx)("div", { className: "dcl-rewind-files", children: ready.changes.map(change => (0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-file", children: [(0, jsx_runtime_1.jsx)("code", { children: change.path }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-rewind-kind", children: fileRecoveryLabel(change.kind) })] }, change.path)) })), ready.truncated && ((0, jsx_runtime_1.jsx)("div", { className: "dcl-rewind-file-actions", children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "outline", size: "sm", onClick: () => { void loadAllChanges(); }, disabled: loadingDetails, children: loadingDetails ? '正在读取全部文件…' : `查看全部 ${String(ready.totalChanges)} 个文件` }) })), (0, jsx_runtime_1.jsxs)("details", { className: "dcl-rewind-details", children: [(0, jsx_runtime_1.jsx)("summary", { children: "\u64CD\u4F5C\u8BE6\u60C5" }), (0, jsx_runtime_1.jsxs)("dl", { children: [(0, jsx_runtime_1.jsx)("dt", { children: "\u6587\u4EF6\u72B6\u6001" }), (0, jsx_runtime_1.jsx)("dd", { children: ready.checkpointId }), (0, jsx_runtime_1.jsx)("dt", { children: "\u5BF9\u8BDD\u8FB9\u754C" }), (0, jsx_runtime_1.jsxs)("dd", { children: ["turn ", String(ready.turn), " / seq ", String(ready.turnEndSeq)] }), (0, jsx_runtime_1.jsx)("dt", { children: "\u6062\u590D\u6388\u6743" }), (0, jsx_runtime_1.jsx)("dd", { children: ready.planId ?? '未生成' }), (0, jsx_runtime_1.jsx)("dt", { children: "\u7248\u672C\u72B6\u6001\u53D8\u5316" }), (0, jsx_runtime_1.jsx)("dd", { children: ready.headChanged || ready.operationChanged ? '是' : '否' }), (0, jsx_runtime_1.jsx)("dt", { children: "\u5171\u4EAB\u76EE\u5F55" }), (0, jsx_runtime_1.jsx)("dd", { children: ready.activeSessionIds.length > 0 ? ready.activeSessionIds.join(', ') : '无其他正在运行的对话' }), backupId !== null && (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("dt", { children: "\u81EA\u52A8\u5907\u4EFD" }), (0, jsx_runtime_1.jsx)("dd", { children: backupId })] })] })] })] })), completed !== null && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-status", children: completed }), error !== null && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-error", children: error }), !loading && (preview?.status !== 'ready' || stale || planMissing || sharedBlocked || driftBlocked) && (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { className: "dcl-rewind-retry", variant: "outline", size: "sm", onClick: () => { void load(true); }, children: "\u91CD\u65B0\u68C0\u67E5" })] }) })] }));
}
function decodePreview(value) {
    const record = recordOf(value);
    const status = requiredString(record.status, 'status');
    if (status === 'pending' || status === 'missing')
        return { status };
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
        turn: requiredInteger(record.turn, 'turn'),
        checkpointId: requiredString(record.checkpointId, 'checkpointId'),
        turnEndSeq: requiredInteger(record.turnEndSeq, 'turnEndSeq'),
        totalChanges: requiredInteger(record.totalChanges, 'totalChanges'),
        changes,
        offset: requiredInteger(record.offset, 'offset'),
        truncated: requiredBoolean(record.truncated, 'truncated'),
        headChanged: requiredBoolean(record.headChanged, 'headChanged'),
        operationChanged: requiredBoolean(record.operationChanged, 'operationChanged'),
        activeSessionIds: activeSessionIdsValue,
        restoreBlocked: requiredBoolean(record.restoreBlocked, 'restoreBlocked'),
        ...(typeof record.planId === 'string' ? { planId: record.planId } : {}),
        ...(typeof record.confirmation === 'string' ? { confirmation: record.confirmation } : {}),
    };
}
function collectPortalTargets(nodes) {
    const rows = new Map();
    for (const element of Array.from(document.querySelectorAll('[data-chat-flow-kind="assistant"][data-chat-anchor-key]'))) {
        const key = element.dataset.chatAnchorKey;
        if (key !== undefined)
            rows.set(key, element);
    }
    const targets = [];
    for (const node of nodes) {
        if (node.kind !== 'assistant')
            continue;
        const matched = selectRewindTurn({ nodes, seq: node.seq });
        if (matched === null)
            continue;
        const row = rows.get(`node:${String(node.seq)}`);
        const messageRoot = row?.querySelector(':scope > [data-time-hover-root="true"]');
        const actions = messageRoot?.lastElementChild;
        if (!(actions instanceof HTMLElement) || actions.querySelector(':scope > button') === null)
            continue;
        targets.push({ container: actions, matched });
    }
    return targets;
}
function samePortalTargets(left, right) {
    return left.length === right.length && left.every((target, index) => {
        const other = right[index];
        return other !== undefined
            && target.container === other.container
            && target.matched.seq === other.matched.seq
            && target.matched.turn === other.matched.turn;
    });
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
        case 'WORKSPACE_IN_USE': return '这个项目目录还有其他对话正在运行。请等待它们结束或先停止运行，再重新检查。';
        case 'WORKSPACE_LOCKED': return '另一个恢复操作正在处理这个项目目录。请等待它完成后重新检查。';
        case 'NO_CHANGES': return '项目文件已经和这一轮结束时一致，无需恢复。需要新对话时请使用 Branch。';
        case 'RESTORE_FAILED_ROLLED_BACK': return '恢复未能完成，项目文件已自动还原到操作前的状态。';
        case 'CONVERSATION_REWIND_FAILED': return '文件已经恢复，但无法创建继续对话；项目文件已自动还原。';
        default: return error.message;
    }
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}

return module.exports; } });
//# sourceMappingURL=client.js.map
