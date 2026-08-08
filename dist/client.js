window.__ModuleLoader__.load({ id: "@dsh-external/change-ledger", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.selectRewindTurn = selectRewindTurn;
exports.apply = apply;
exports.RewindTurnTail = RewindTurnTail;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@deepseek-ai/dsh-client-ui-primitives");
const PATH = '/change-ledger/rewind';
const STYLE_ID = '@dsh-external/change-ledger/rewind';
const styles = `
.dcl-rewind-tail{display:flex;align-items:center;height:28px;margin-top:4px}
.dcl-rewind-trigger{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:0;border-radius:14px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;cursor:pointer}
.dcl-rewind-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dcl-rewind-body{display:flex;flex-direction:column;gap:14px;min-width:min(560px,calc(100vw - 64px))}
.dcl-rewind-option{display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dcl-rewind-option strong{display:block;color:var(--dsw-alias-label-primary);font-size:14px}
.dcl-rewind-option span{display:block;margin-top:3px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dcl-rewind-summary{display:flex;gap:16px;color:var(--dsw-alias-label-secondary);font-size:13px}
.dcl-rewind-files{max-height:220px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}
.dcl-rewind-file{display:flex;justify-content:space-between;gap:16px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}
.dcl-rewind-file:last-child{border-bottom:0}.dcl-rewind-file code{overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}
.dcl-rewind-kind{flex:none;color:var(--dsw-alias-label-tertiary)}
.dcl-rewind-warning,.dcl-rewind-error{margin:0;padding:10px 12px;border-radius:10px;font-size:12px;line-height:18px}
.dcl-rewind-warning{background:var(--dsw-alias-bg-warning);color:var(--dsw-alias-label-warning)}
.dcl-rewind-error{background:var(--dsw-alias-bg-error);color:var(--dsw-alias-label-error)}
.dcl-rewind-ack{display:flex;align-items:flex-start;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
`;
/** Return the completed turn closed by one assistant-tail anchor. */
function selectRewindTurn(owner) {
    const node = owner.nodes.find(candidate => candidate.kind === 'assistant' && candidate.seq === owner.seq);
    return node !== undefined && Number.isSafeInteger(node.turn) && node.turn >= 0
        ? { turn: node.turn, seq: owner.seq }
        : null;
}
/** Browser plugin entry: register one compact action under every finalized assistant turn. */
exports.inject = ['slots'];
function apply(ctx) {
    ctx.effect(() => {
        if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null)
            return () => { };
        const tag = document.createElement('style');
        tag.dataset.plugin = '@dsh-external/change-ledger';
        tag.dataset.pluginCss = STYLE_ID;
        tag.textContent = styles;
        document.head.appendChild(tag);
        return () => { tag.remove(); };
    }, 'change-ledger: rewind styles');
    ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
        name: 'conversation.chat.turnTail',
        select: selectRewindTurn,
    }, RewindTurnTail));
}
/** Turn-tail action and its review-first code restore dialog. */
function RewindTurnTail({ matched, sessionId }) {
    const [open, setOpen] = (0, react_1.useState)(false);
    const [loading, setLoading] = (0, react_1.useState)(false);
    const [preview, setPreview] = (0, react_1.useState)(null);
    const [acknowledged, setAcknowledged] = (0, react_1.useState)(false);
    const [applying, setApplying] = (0, react_1.useState)(false);
    const [error, setError] = (0, react_1.useState)(null);
    const [completed, setCompleted] = (0, react_1.useState)(null);
    const load = (0, react_1.useCallback)(async () => {
        setLoading(true);
        setError(null);
        setCompleted(null);
        try {
            const response = await fetch(`${PATH}?sessionId=${encodeURIComponent(sessionId)}&turn=${String(matched.turn)}`, {
                method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store',
            });
            const value = await responseJson(response);
            setPreview(decodePreview(value));
        }
        catch (caught) {
            setError(messageOf(caught));
        }
        finally {
            setLoading(false);
        }
    }, [matched.turn, sessionId]);
    const show = () => {
        setOpen(true);
        setAcknowledged(false);
        void load();
    };
    const close = () => { if (!applying)
        setOpen(false); };
    const ready = preview?.status === 'ready' ? preview : null;
    const blocked = ready === null || ready.totalChanges === 0 || ready.headChanged || ready.operationChanged;
    const applyRestore = async () => {
        if (ready?.planId === undefined || ready.confirmation === undefined || !acknowledged || blocked)
            return;
        setApplying(true);
        setError(null);
        try {
            const response = await fetch(PATH, {
                method: 'POST',
                headers: { accept: 'application/json', 'content-type': 'application/json' },
                body: JSON.stringify({
                    mode: 'code', sessionId, planId: ready.planId, confirmation: ready.confirmation,
                }),
            });
            const result = recordOf(await responseJson(response));
            setCompleted(`代码已恢复；救援点 ${requiredString(result.rescuePointId, 'rescuePointId')} 已保留。`);
            setAcknowledged(false);
            await load();
        }
        catch (caught) {
            setError(messageOf(caught));
        }
        finally {
            setApplying(false);
        }
    };
    return ((0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-tail", children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Tooltip, { label: `回退到第 ${String(matched.turn)} 轮结束时`, side: "bottom", children: (0, jsx_runtime_1.jsxs)("button", { type: "button", className: "dcl-rewind-trigger", onClick: show, "aria-label": `回退到第 ${String(matched.turn)} 轮结束时`, children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.IconRefreshOutline16, { size: 16 }), (0, jsx_runtime_1.jsx)("span", { children: "\u56DE\u9000" })] }) }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Modal, { open: open, onClose: close, title: `回退到第 ${String(matched.turn)} 轮结束时`, closeLabel: "\u5173\u95ED", description: "\u6062\u590D\u524D\u4F1A\u518D\u6B21\u9A8C\u8BC1\u5DE5\u4F5C\u533A\uFF0C\u5E76\u81EA\u52A8\u4FDD\u5B58\u5F53\u524D\u4EE3\u7801\u4F5C\u4E3A\u6551\u63F4\u70B9\u3002", footer: ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "outline", onClick: close, disabled: applying, children: "\u53D6\u6D88" }), (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "primary", onClick: () => { void applyRestore(); }, disabled: blocked || !acknowledged || applying, children: applying ? '正在恢复…' : '恢复代码' })] })), children: (0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-body", children: [loading && (0, jsx_runtime_1.jsx)("p", { children: "\u6B63\u5728\u68C0\u67E5\u6B64\u8F6E\u7684\u4EE3\u7801\u72B6\u6001\u2026" }), preview?.status === 'pending' && (0, jsx_runtime_1.jsx)("p", { children: "\u6B64\u8F6E\u68C0\u67E5\u70B9\u4ECD\u5728\u5199\u5165\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002" }), preview?.status === 'missing' && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-error", children: "\u6CA1\u6709\u627E\u5230\u6B64\u8F6E\u68C0\u67E5\u70B9\uFF1B\u8BE5\u8F6E\u53EF\u80FD\u65E9\u4E8E\u63D2\u4EF6\u542F\u7528\u65F6\u95F4\u6216\u5DF2\u8D85\u8FC7\u4FDD\u7559\u7A97\u53E3\u3002" }), preview?.status === 'failed' && (0, jsx_runtime_1.jsxs)("p", { className: "dcl-rewind-error", children: ["\u68C0\u67E5\u70B9\u521B\u5EFA\u5931\u8D25\uFF1A", preview.error] }), ready !== null && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("label", { className: "dcl-rewind-option", children: [(0, jsx_runtime_1.jsx)("input", { type: "radio", checked: true, readOnly: true }), (0, jsx_runtime_1.jsxs)("span", { children: [(0, jsx_runtime_1.jsx)("strong", { children: "\u4EC5\u6062\u590D\u4EE3\u7801" }), (0, jsx_runtime_1.jsx)("span", { children: "\u5BF9\u8BDD\u4FDD\u6301\u5F53\u524D\u4F4D\u7F6E\uFF0C\u53EA\u628A\u5DE5\u4F5C\u533A\u6062\u590D\u5230\u6B64\u8F6E\u7ED3\u675F\u65F6\u3002" })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-summary", children: [(0, jsx_runtime_1.jsxs)("span", { children: [String(ready.totalChanges), " \u4E2A\u8DEF\u5F84\u5C06\u53D8\u5316"] }), (0, jsx_runtime_1.jsx)("span", { children: "\u6551\u63F4\u70B9\u4F1A\u81EA\u52A8\u521B\u5EFA" })] }), (ready.headChanged || ready.operationChanged) && ((0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-warning", children: "Git HEAD\u3001\u5206\u652F\u6216\u8FDB\u884C\u4E2D\u7684 Git \u64CD\u4F5C\u5DF2\u7ECF\u53D8\u5316\u3002\u4E3A\u907F\u514D\u8DE8\u5386\u53F2\u6062\u590D\uFF0C\u8BF7\u5148\u5904\u7406\u8BE5\u53D8\u5316\u540E\u91CD\u65B0\u6253\u5F00\u3002" })), ready.totalChanges === 0 && (0, jsx_runtime_1.jsx)("p", { children: "\u5F53\u524D\u5DE5\u4F5C\u533A\u5DF2\u7ECF\u4E0E\u8BE5\u8F6E\u7ED3\u675F\u72B6\u6001\u4E00\u81F4\u3002" }), ready.changes.length > 0 && ((0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-files", children: [ready.changes.map(change => (0, jsx_runtime_1.jsxs)("div", { className: "dcl-rewind-file", children: [(0, jsx_runtime_1.jsx)("code", { children: change.path }), (0, jsx_runtime_1.jsx)("span", { className: "dcl-rewind-kind", children: kindLabel(change.kind) })] }, change.path)), ready.truncated && (0, jsx_runtime_1.jsx)("div", { className: "dcl-rewind-file", children: (0, jsx_runtime_1.jsx)("span", { children: "\u5176\u4F59\u8DEF\u5F84\u672A\u5728\u6B64\u5904\u5C55\u5F00" }) })] })), !blocked && ((0, jsx_runtime_1.jsxs)("label", { className: "dcl-rewind-ack", children: [(0, jsx_runtime_1.jsx)("input", { type: "checkbox", checked: acknowledged, disabled: applying, onChange: event => { setAcknowledged(event.currentTarget.checked); } }), (0, jsx_runtime_1.jsx)("span", { children: "\u6211\u786E\u8BA4\u6062\u590D\u4EE5\u4E0A\u4EE3\u7801\u53D8\u5316\uFF1B\u5F53\u524D\u72B6\u6001\u5C06\u4FDD\u5B58\u5728\u6551\u63F4\u70B9\u4E2D\u3002" })] }))] })), completed !== null && (0, jsx_runtime_1.jsx)("p", { children: completed }), error !== null && (0, jsx_runtime_1.jsx)("p", { className: "dcl-rewind-error", children: error }), !loading && preview?.status !== 'ready' && (0, jsx_runtime_1.jsx)(dsh_client_ui_primitives_1.Button, { variant: "outline", size: "sm", onClick: () => { void load(); }, children: "\u91CD\u8BD5" })] }) })] }));
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
