window.__ModuleLoader__.load({ id: "@dsh-external/turn-rewind", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.selectRewindTurn = selectRewindTurn;
exports.apply = apply;
exports.RewindTurnPortals = RewindTurnPortals;
exports.RewindTurnTail = RewindTurnTail;
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
.dcl-rewind-status{margin:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dcl-rewind-warning,.dcl-rewind-error{box-sizing:border-box;max-width:100%;margin:0;padding:10px 12px;overflow-wrap:anywhere;word-break:break-word;border-radius:10px;font-size:12px;line-height:18px}
.dcl-rewind-warning{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary)}
.dcl-rewind-error{border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);color:var(--dsw-alias-state-error-primary)}
.dcl-rewind-ack{display:flex;align-items:flex-start;gap:8px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.dcl-rewind-ack input{flex:none}.dcl-rewind-ack span{min-width:0;overflow-wrap:anywhere}
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
    const [acknowledged, setAcknowledged] = (0, react_1.useState)(false);
    const [applying, setApplying] = (0, react_1.useState)(false);
    const [error, setError] = (0, react_1.useState)(null);
    const [completed, setCompleted] = (0, react_1.useState)(null);
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
        setError(null);
        setCompleted(null);
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
        setAcknowledged(false);
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
        setAcknowledged(false);
        setError(null);
        setCompleted(null);
    };
    const ready = preview?.status === 'ready' ? preview : null;
    const hasCodeChanges = ready !== null && ready.totalChanges > 0;
    const restoresCode = mode !== 'conversation';
    const needsCodeRestore = restoresCode && hasCodeChanges;
    const codeUnavailable = mode === 'code' && !hasCodeChanges;
    const driftBlocked = needsCodeRestore && ready !== null && (ready.headChanged || ready.operationChanged);
    const planMissing = needsCodeRestore && ready !== null && (ready.planId === undefined || ready.confirmation === undefined);
    const canApply = ready !== null
        && !loading
        && !applying
        && completed === null
        && !codeUnavailable
        && !driftBlocked
        && !planMissing
        && (!needsCodeRestore || acknowledged);
    const applyRestore = async () => {
        if (ready === null || !canApply || applyPending.current)
            return;
        const body = {
            mode,
            sessionId,
            turn: ready.turn,
            checkpointId: ready.checkpointId,
        };
        if (needsCodeRestore) {
            if (ready.planId === undefined || ready.confirmation === undefined)
                return;
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
            setAcknowledged(false);
            if (mode === 'code') {
                const rescuePointId = requiredString(result.rescuePointId, 'rescuePointId');
                setCompleted(`代码已恢复；当前对话保持不变。救援点 ${rescuePointId} 已保留。`);
                return;
            }
            const childSessionId = requiredString(result.sessionId, 'sessionId');
            if (mode === 'conversation') {
                setCompleted('已创建此轮结束时的对话版本；当前代码保持不变。');
            }
            else if (needsCodeRestore) {
                const rescuePointId = requiredString(result.rescuePointId, 'rescuePointId');
                setCompleted(`代码与对话已回到此轮结束时；操作前代码已保存在救援点 ${rescuePointId}。`);
            }
            else {
                setCompleted('已创建此轮结束时的对话版本；代码原本已与该轮一致。');
            }
            try {
                openSession(childSessionId);
                setOpen(false);
            }
            catch (navigationError) {
                setError(`回退已完成，但无法自动打开新对话：${messageOf(navigationError)}`);
            }
        }
        catch (caught) {
            setError(messageOf(caught));
        }
        finally {
            applyPending.current = false;
            setApplying(false);
        }
    };
    const actionLabel = mode === 'both' ? '同时回退' : mode === 'code' ? '恢复代码' : '回退对话';
    const radioName = `dcl-rewind-${sessionId}-${String(matched.turn)}`;
    return ((0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-tail", children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: `回退到第 ${String(matched.turn)} 轮结束时`, side: "bottom", children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: "dcl-rewind-trigger", onClick: show, "aria-label": `回退到第 ${String(matched.turn)} 轮结束时`, children: (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconRefreshOutline16, { size: 16 }) }) }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Modal, { open: open, onClose: close, title: `回退到第 ${String(matched.turn)} 轮结束时`, closeLabel: "\u5173\u95ED", description: "\u9009\u62E9\u8981\u6062\u590D\u7684\u8303\u56F4\u3002\u539F\u5BF9\u8BDD\u59CB\u7EC8\u4FDD\u7559\uFF1B\u6D89\u53CA\u4EE3\u7801\u65F6\u4F1A\u518D\u6B21\u9A8C\u8BC1\u5DE5\u4F5C\u533A\u5E76\u5148\u521B\u5EFA\u6551\u63F4\u70B9\u3002", className: "dcl-rewind-dialog", contentClassName: "dcl-rewind-content", footer: ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "outline", onClick: close, disabled: applying, children: "\u53D6\u6D88" }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "primary", onClick: () => { void applyRestore(); }, disabled: !canApply, children: applying ? '正在回退…' : completed === null ? actionLabel : '已完成' })] })), children: (0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-body", children: [loading && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-status", children: "\u6B63\u5728\u8BFB\u53D6\u6B64\u8F6E\u6062\u590D\u70B9\u2026" }), preview?.status === 'pending' && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-status", children: "\u6B64\u8F6E\u68C0\u67E5\u70B9\u4ECD\u5728\u5199\u5165\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002" }), preview?.status === 'missing' && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-error", children: "\u6CA1\u6709\u627E\u5230\u6B64\u8F6E\u68C0\u67E5\u70B9\uFF1B\u8BE5\u8F6E\u53EF\u80FD\u65E9\u4E8E\u63D2\u4EF6\u542F\u7528\u65F6\u95F4\u6216\u5DF2\u8D85\u8FC7\u4FDD\u7559\u7A97\u53E3\u3002" }), preview?.status === 'failed' && (0, jsx_runtime_1.jsxs)("p", { className: "dcl-rewind-error", children: ["\u68C0\u67E5\u70B9\u521B\u5EFA\u5931\u8D25\uFF1A", preview.error] }), ready !== null && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-options", children: [(0, jsx_runtime_1.jsxs)("label", { className: "dcl-rewind-option", "data-selected": mode === 'both', "data-disabled": applying, children: [(0, jsx_runtime_1.jsx)("input", { type: "radio", name: radioName, checked: mode === 'both', disabled: applying, onChange: () => { chooseMode('both'); } }), (0, jsx_runtime_1.jsxs)("span", { className: "dcl-rewind-option-content", children: [(0, jsx_runtime_1.jsx)("strong", { children: "\u540C\u65F6\u6062\u590D\u4EE3\u7801\u4E0E\u5BF9\u8BDD" }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-rewind-option-description", children: "\u6062\u590D\u5DE5\u4F5C\u533A\uFF0C\u5E76\u521B\u5EFA\u3001\u6253\u5F00\u6B64\u8F6E\u7ED3\u675F\u65F6\u7684\u5BF9\u8BDD\u7248\u672C\uFF1B\u539F\u5BF9\u8BDD\u4FDD\u7559\u3002" })] })] }), (0, jsx_runtime_1.jsxs)("label", { className: "dcl-rewind-option", "data-selected": mode === 'code', "data-disabled": applying || ready.totalChanges === 0, children: [(0, jsx_runtime_1.jsx)("input", { type: "radio", name: radioName, checked: mode === 'code', disabled: applying || ready.totalChanges === 0, onChange: () => { chooseMode('code'); } }), (0, jsx_runtime_1.jsxs)("span", { className: "dcl-rewind-option-content", children: [(0, jsx_runtime_1.jsx)("strong", { children: "\u4EC5\u6062\u590D\u4EE3\u7801" }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-rewind-option-description", children: ready.totalChanges === 0 ? '当前代码已经与该轮一致，无需恢复。' : '对话保持当前位置，只把工作区恢复到此轮结束时。' })] })] }), (0, jsx_runtime_1.jsxs)("label", { className: "dcl-rewind-option", "data-selected": mode === 'conversation', "data-disabled": applying, children: [(0, jsx_runtime_1.jsx)("input", { type: "radio", name: radioName, checked: mode === 'conversation', disabled: applying, onChange: () => { chooseMode('conversation'); } }), (0, jsx_runtime_1.jsxs)("span", { className: "dcl-rewind-option-content", children: [(0, jsx_runtime_1.jsx)("strong", { children: "\u4EC5\u56DE\u9000\u5BF9\u8BDD" }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-rewind-option-description", children: "\u521B\u5EFA\u5E76\u6253\u5F00\u6B64\u8F6E\u7ED3\u675F\u65F6\u7684\u5BF9\u8BDD\u7248\u672C\uFF1B\u5F53\u524D\u4EE3\u7801\u4FDD\u6301\u4E0D\u53D8\u3002" })] })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-summary", children: [(0, jsx_runtime_1.jsxs)("span", { children: [String(ready.totalChanges), " \u4E2A\u4EE3\u7801\u8DEF\u5F84\u4E0E\u8BE5\u8F6E\u4E0D\u540C"] }), (0, jsx_runtime_1.jsx)("span", { children: needsCodeRestore ? '恢复前自动创建救援点' : '不会修改当前代码' })] }), needsCodeRestore && (ready.headChanged || ready.operationChanged) && ((0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-warning", children: "Git HEAD\u3001\u5206\u652F\u6216\u8FDB\u884C\u4E2D\u7684 Git \u64CD\u4F5C\u5DF2\u7ECF\u53D8\u5316\u3002\u4E3A\u907F\u514D\u8DE8\u5386\u53F2\u6062\u590D\uFF0C\u8BF7\u5148\u5904\u7406\u8BE5\u53D8\u5316\u540E\u91CD\u65B0\u6253\u5F00\u3002" })), !restoresCode && (ready.headChanged || ready.operationChanged) && ((0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-status", children: "\u4EC5\u56DE\u9000\u5BF9\u8BDD\u4E0D\u4F1A\u4FEE\u6539\u5DE5\u4F5C\u533A\uFF0C\u56E0\u6B64\u4E0D\u53D7\u5F53\u524D HEAD \u6216 Git \u64CD\u4F5C\u72B6\u6001\u5F71\u54CD\u3002" })), planMissing && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-error", children: "\u4EE3\u7801\u6062\u590D\u8BA1\u5212\u7F3A\u5931\uFF0C\u8BF7\u5173\u95ED\u540E\u91CD\u65B0\u6253\u5F00\u56DE\u9000\u7A97\u53E3\u3002" }), ready.totalChanges === 0 && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-status", children: "\u5F53\u524D\u5DE5\u4F5C\u533A\u5DF2\u7ECF\u4E0E\u8BE5\u8F6E\u7ED3\u675F\u72B6\u6001\u4E00\u81F4\uFF1B\u201C\u540C\u65F6\u56DE\u9000\u201D\u5C06\u53EA\u521B\u5EFA\u5BF9\u8BDD\u7248\u672C\u3002" }), ready.changes.length > 0 && ((0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-files", children: [ready.changes.map(change => (0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-file", children: [(0, jsx_runtime_1.jsx)("code", { children: change.path }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-rewind-kind", children: kindLabel(change.kind) })] }, change.path)), ready.truncated && (0, jsx_runtime_1.jsx)("div", { className: "dcl-rewind-file", children: (0, jsx_runtime_1.jsx)("span", { children: "\u5176\u4F59\u8DEF\u5F84\u672A\u5728\u6B64\u5904\u5C55\u5F00" }) })] })), needsCodeRestore && !driftBlocked && !planMissing && ((0, jsx_runtime_1.jsxs)("label", { className: "dcl-rewind-ack", children: [(0, jsx_runtime_1.jsx)("input", { type: "checkbox", checked: acknowledged, disabled: applying, onChange: event => { setAcknowledged(event.currentTarget.checked); } }), (0, jsx_runtime_1.jsx)("span", { children: "\u6211\u786E\u8BA4\u6062\u590D\u4EE5\u4E0A\u4EE3\u7801\u53D8\u5316\uFF1B\u5F53\u524D\u4EE3\u7801\u4F1A\u5148\u4FDD\u5B58\u5230\u6551\u63F4\u70B9\uFF0C\u539F\u5BF9\u8BDD\u4E0D\u4F1A\u88AB\u5220\u9664\u3002" })] }))] })), completed !== null && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-status", children: completed }), error !== null && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-error", children: error }), !loading && preview?.status !== 'ready' && (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { className: "dcl-rewind-retry", variant: "outline", size: "sm", onClick: () => { void load(true); }, children: "\u91CD\u8BD5" })] }) })] }));
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
    return {
        status,
        sessionId: requiredString(record.sessionId, 'sessionId'),
        turn: requiredInteger(record.turn, 'turn'),
        checkpointId: requiredString(record.checkpointId, 'checkpointId'),
        turnEndSeq: requiredInteger(record.turnEndSeq, 'turnEndSeq'),
        totalChanges: requiredInteger(record.totalChanges, 'totalChanges'),
        changes,
        truncated: requiredBoolean(record.truncated, 'truncated'),
        headChanged: requiredBoolean(record.headChanged, 'headChanged'),
        operationChanged: requiredBoolean(record.operationChanged, 'operationChanged'),
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
        throw new Error(typeof record.error === 'string' ? record.error : `请求失败：${String(response.status)}`);
    }
    return value;
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
function kindLabel(kind) {
    switch (kind) {
        case 'added': return '删除新增文件';
        case 'deleted': return '恢复已删文件';
        case 'modified': return '恢复内容';
        case 'mode-changed': return '恢复权限';
        case 'type-changed': return '恢复类型';
    }
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}

return module.exports; } });
//# sourceMappingURL=client.js.map
