import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  IconRefreshOutline16,
  Modal,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'

interface ConversationNodeLike {
  readonly kind: string
  readonly seq: number
  readonly turn?: number
}

interface TurnTailOwnerLike {
  readonly nodes: readonly ConversationNodeLike[]
  readonly seq: number
}

interface RewindMatch {
  readonly turn: number
  readonly seq: number
}

interface RewindTailProps {
  readonly matched: RewindMatch
  readonly sessionId: string
  readonly openSession: (sessionId: string) => void
}

interface SlotsLike {
  inject(name: string, install: () => unknown): void
  register(
    entry: {
      readonly name: string
      readonly select: (owner: TurnTailOwnerLike) => RewindMatch | null
      readonly inject: () => { readonly openSession: (sessionId: string) => void }
    },
    component: (props: RewindTailProps) => ReactNode,
  ): () => void
}

interface ClientContextLike {
  readonly slots: SlotsLike
  readonly sessions: { open(sessionId: string): void }
  effect(setup: () => (() => void), label?: string): unknown
}

type RewindMode = 'both' | 'code' | 'conversation'
type ChangeKind = 'added' | 'deleted' | 'modified' | 'mode-changed' | 'type-changed'

interface ReadyPreview {
  readonly status: 'ready'
  readonly sessionId: string
  readonly turn: number
  readonly checkpointId: string
  readonly turnEndSeq: number
  readonly totalChanges: number
  readonly changes: readonly { readonly path: string; readonly kind: ChangeKind }[]
  readonly truncated: boolean
  readonly headChanged: boolean
  readonly operationChanged: boolean
  readonly planId?: string
  readonly confirmation?: string
}

type Preview = ReadyPreview
  | { readonly status: 'pending' }
  | { readonly status: 'missing' }
  | { readonly status: 'failed'; readonly error: string }

const PATH = '/change-ledger/rewind'
const STYLE_ID = '@dsh-external/change-ledger/rewind'
const styles = `
.dcl-rewind-tail{display:flex;align-items:center;height:28px;margin-top:4px}
.dcl-rewind-trigger{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:0;border-radius:14px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;cursor:pointer}
.dcl-rewind-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dcl-rewind-body{display:flex;flex-direction:column;gap:14px;min-width:min(560px,calc(100vw - 64px))}
.dcl-rewind-options{display:flex;flex-direction:column;gap:8px}
.dcl-rewind-option{display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);cursor:pointer}
.dcl-rewind-option[data-selected="true"]{border-color:var(--dsw-alias-state-business-primary)}
.dcl-rewind-option[data-disabled="true"]{cursor:not-allowed;opacity:.52}
.dcl-rewind-option input{margin-top:2px}
.dcl-rewind-option strong{display:block;color:var(--dsw-alias-label-primary);font-size:14px}
.dcl-rewind-option span{display:block;margin-top:3px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dcl-rewind-summary{display:flex;gap:16px;color:var(--dsw-alias-label-secondary);font-size:13px}
.dcl-rewind-files{max-height:220px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}
.dcl-rewind-file{display:flex;justify-content:space-between;gap:16px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}
.dcl-rewind-file:last-child{border-bottom:0}.dcl-rewind-file code{overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}
.dcl-rewind-kind{flex:none;color:var(--dsw-alias-label-tertiary)}
.dcl-rewind-warning,.dcl-rewind-error{margin:0;padding:10px 12px;border-radius:10px;font-size:12px;line-height:18px}
.dcl-rewind-warning{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary)}
.dcl-rewind-error{border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);color:var(--dsw-alias-state-error-primary)}
.dcl-rewind-ack{display:flex;align-items:flex-start;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
`

/** Return the completed turn closed by one assistant-tail anchor. */
export function selectRewindTurn(owner: TurnTailOwnerLike): RewindMatch | null {
  const node = owner.nodes.find(candidate => candidate.kind === 'assistant' && candidate.seq === owner.seq)
  return node !== undefined && Number.isSafeInteger(node.turn) && (node.turn as number) >= 0
    ? { turn: node.turn as number, seq: owner.seq }
    : null
}

/** Browser plugin entry: register one compact action under every finalized assistant turn. */
export const inject = ['slots', 'sessions']
export function apply(ctx: ClientContextLike): void {
  ctx.effect(() => {
    if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.plugin = '@dsh-external/change-ledger'
    tag.dataset.pluginCss = STYLE_ID
    tag.textContent = styles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'change-ledger: rewind styles')
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    select: selectRewindTurn,
    inject: () => ({ openSession: (sessionId: string) => { ctx.sessions.open(sessionId) } }),
  }, RewindTurnTail))
}

/** Turn-tail action and its review-first code/conversation restore dialog. */
export function RewindTurnTail({ matched, sessionId, openSession }: RewindTailProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [mode, setMode] = useState<RewindMode>('both')
  const [acknowledged, setAcknowledged] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [completed, setCompleted] = useState<string | null>(null)
  const loadAbort = useRef<AbortController | null>(null)
  const applyPending = useRef(false)

  useEffect(() => () => {
    loadAbort.current?.abort()
    loadAbort.current = null
  }, [])

  const load = useCallback(async (retry = false) => {
    loadAbort.current?.abort()
    const controller = new AbortController()
    loadAbort.current = controller
    setLoading(true)
    setError(null)
    setCompleted(null)
    try {
      const retryQuery = retry ? '&retry=1' : ''
      const response = await fetch(`${PATH}?sessionId=${encodeURIComponent(sessionId)}&turn=${String(matched.turn)}${retryQuery}`, {
        method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store', signal: controller.signal,
      })
      const value = await responseJson(response)
      if (loadAbort.current === controller) setPreview(decodePreview(value))
    } catch (caught) {
      if (!controller.signal.aborted) setError(messageOf(caught))
    } finally {
      if (loadAbort.current === controller) {
        loadAbort.current = null
        setLoading(false)
      }
    }
  }, [matched.turn, sessionId])

  const show = (): void => {
    setOpen(true)
    setPreview(null)
    setMode('both')
    setAcknowledged(false)
    void load()
  }
  const close = (): void => {
    if (applying) return
    loadAbort.current?.abort()
    loadAbort.current = null
    setLoading(false)
    setOpen(false)
  }
  const chooseMode = (next: RewindMode): void => {
    if (applying) return
    setMode(next)
    setAcknowledged(false)
    setError(null)
    setCompleted(null)
  }
  const ready = preview?.status === 'ready' ? preview : null
  const hasCodeChanges = ready !== null && ready.totalChanges > 0
  const restoresCode = mode !== 'conversation'
  const needsCodeRestore = restoresCode && hasCodeChanges
  const codeUnavailable = mode === 'code' && !hasCodeChanges
  const driftBlocked = needsCodeRestore && ready !== null && (ready.headChanged || ready.operationChanged)
  const planMissing = needsCodeRestore && ready !== null && (ready.planId === undefined || ready.confirmation === undefined)
  const canApply = ready !== null
    && !loading
    && !applying
    && completed === null
    && !codeUnavailable
    && !driftBlocked
    && !planMissing
    && (!needsCodeRestore || acknowledged)

  const applyRestore = async (): Promise<void> => {
    if (ready === null || !canApply || applyPending.current) return
    const body: Record<string, unknown> = {
      mode,
      sessionId,
      turn: ready.turn,
      checkpointId: ready.checkpointId,
    }
    if (needsCodeRestore) {
      if (ready.planId === undefined || ready.confirmation === undefined) return
      body.planId = ready.planId
      body.confirmation = ready.confirmation
    }
    applyPending.current = true
    setApplying(true)
    setError(null)
    try {
      const response = await fetch(PATH, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = recordOf(await responseJson(response))
      const resultMode = requiredString(result.mode, 'mode')
      if (resultMode !== mode) throw new Error(`服务器返回了不匹配的回退模式：${resultMode}`)
      setAcknowledged(false)
      if (mode === 'code') {
        const rescuePointId = requiredString(result.rescuePointId, 'rescuePointId')
        setCompleted(`代码已恢复；当前对话保持不变。救援点 ${rescuePointId} 已保留。`)
        return
      }
      const childSessionId = requiredString(result.sessionId, 'sessionId')
      if (mode === 'conversation') {
        setCompleted('已创建此轮结束时的对话版本；当前代码保持不变。')
      } else if (needsCodeRestore) {
        const rescuePointId = requiredString(result.rescuePointId, 'rescuePointId')
        setCompleted(`代码与对话已回到此轮结束时；操作前代码已保存在救援点 ${rescuePointId}。`)
      } else {
        setCompleted('已创建此轮结束时的对话版本；代码原本已与该轮一致。')
      }
      try {
        openSession(childSessionId)
        setOpen(false)
      } catch (navigationError) {
        setError(`回退已完成，但无法自动打开新对话：${messageOf(navigationError)}`)
      }
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      applyPending.current = false
      setApplying(false)
    }
  }

  const actionLabel = mode === 'both' ? '同时回退' : mode === 'code' ? '恢复代码' : '回退对话'
  const radioName = `dcl-rewind-${sessionId}-${String(matched.turn)}`

  return (
    <div className="dcl-rewind-tail">
      <Tooltip label={`回退到第 ${String(matched.turn)} 轮结束时`} side="bottom">
        <button type="button" className="dcl-rewind-trigger" onClick={show} aria-label={`回退到第 ${String(matched.turn)} 轮结束时`}>
          <IconRefreshOutline16 size={16} />
          <span>回退</span>
        </button>
      </Tooltip>
      <Modal
        open={open}
        onClose={close}
        title={`回退到第 ${String(matched.turn)} 轮结束时`}
        closeLabel="关闭"
        description="选择要恢复的范围。原对话始终保留；涉及代码时会再次验证工作区并先创建救援点。"
        footer={(
          <>
            <Button variant="outline" onClick={close} disabled={applying}>取消</Button>
            <Button variant="primary" onClick={() => { void applyRestore() }} disabled={!canApply}>
              {applying ? '正在回退…' : completed === null ? actionLabel : '已完成'}
            </Button>
          </>
        )}
      >
        <div className="dcl-rewind-body">
          {loading && <p>正在读取此轮恢复点…</p>}
          {preview?.status === 'pending' && <p>此轮检查点仍在写入，请稍后重试。</p>}
          {preview?.status === 'missing' && <p className="dcl-rewind-error">没有找到此轮检查点；该轮可能早于插件启用时间或已超过保留窗口。</p>}
          {preview?.status === 'failed' && <p className="dcl-rewind-error">检查点创建失败：{preview.error}</p>}
          {ready !== null && (
            <>
              <div className="dcl-rewind-options">
                <label className="dcl-rewind-option" data-selected={mode === 'both'} data-disabled={applying}>
                  <input type="radio" name={radioName} checked={mode === 'both'} disabled={applying} onChange={() => { chooseMode('both') }} />
                  <span><strong>同时恢复代码与对话</strong><span>恢复工作区，并创建、打开此轮结束时的对话版本；原对话保留。</span></span>
                </label>
                <label className="dcl-rewind-option" data-selected={mode === 'code'} data-disabled={applying || ready.totalChanges === 0}>
                  <input type="radio" name={radioName} checked={mode === 'code'} disabled={applying || ready.totalChanges === 0} onChange={() => { chooseMode('code') }} />
                  <span><strong>仅恢复代码</strong><span>{ready.totalChanges === 0 ? '当前代码已经与该轮一致，无需恢复。' : '对话保持当前位置，只把工作区恢复到此轮结束时。'}</span></span>
                </label>
                <label className="dcl-rewind-option" data-selected={mode === 'conversation'} data-disabled={applying}>
                  <input type="radio" name={radioName} checked={mode === 'conversation'} disabled={applying} onChange={() => { chooseMode('conversation') }} />
                  <span><strong>仅回退对话</strong><span>创建并打开此轮结束时的对话版本；当前代码保持不变。</span></span>
                </label>
              </div>
              <div className="dcl-rewind-summary">
                <span>{String(ready.totalChanges)} 个代码路径与该轮不同</span>
                <span>{needsCodeRestore ? '恢复前自动创建救援点' : '不会修改当前代码'}</span>
              </div>
              {needsCodeRestore && (ready.headChanged || ready.operationChanged) && (
                <p className="dcl-rewind-warning">Git HEAD、分支或进行中的 Git 操作已经变化。为避免跨历史恢复，请先处理该变化后重新打开。</p>
              )}
              {!restoresCode && (ready.headChanged || ready.operationChanged) && (
                <p>仅回退对话不会修改工作区，因此不受当前 HEAD 或 Git 操作状态影响。</p>
              )}
              {planMissing && <p className="dcl-rewind-error">代码恢复计划缺失，请关闭后重新打开回退窗口。</p>}
              {ready.totalChanges === 0 && <p>当前工作区已经与该轮结束状态一致；“同时回退”将只创建对话版本。</p>}
              {ready.changes.length > 0 && (
                <div className="dcl-rewind-files">
                  {ready.changes.map(change => <div className="dcl-rewind-file" key={change.path}><code>{change.path}</code><span className="dcl-rewind-kind">{kindLabel(change.kind)}</span></div>)}
                  {ready.truncated && <div className="dcl-rewind-file"><span>其余路径未在此处展开</span></div>}
                </div>
              )}
              {needsCodeRestore && !driftBlocked && !planMissing && (
                <label className="dcl-rewind-ack"><input type="checkbox" checked={acknowledged} disabled={applying} onChange={event => { setAcknowledged(event.currentTarget.checked) }} /><span>我确认恢复以上代码变化；当前代码会先保存到救援点，原对话不会被删除。</span></label>
              )}
            </>
          )}
          {completed !== null && <p>{completed}</p>}
          {error !== null && <p className="dcl-rewind-error">{error}</p>}
          {!loading && preview?.status !== 'ready' && <Button variant="outline" size="sm" onClick={() => { void load(true) }}>重试</Button>}
        </div>
      </Modal>
    </div>
  )
}

function decodePreview(value: unknown): Preview {
  const record = recordOf(value)
  const status = requiredString(record.status, 'status')
  if (status === 'pending' || status === 'missing') return { status }
  if (status === 'failed') return { status, error: requiredString(record.error, 'error') }
  if (status !== 'ready') throw new Error(`未知回退状态：${status}`)
  const changesValue = record.changes
  if (!Array.isArray(changesValue)) throw new Error('回退预览缺少 changes')
  const changes = changesValue.map((entry) => {
    const change = recordOf(entry)
    return { path: requiredString(change.path, 'path'), kind: requiredString(change.kind, 'kind') as ChangeKind }
  })
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
  }
}

async function responseJson(response: Response): Promise<unknown> {
  const value = await response.json() as unknown
  if (!response.ok) {
    const record = recordOf(value)
    throw new Error(typeof record.error === 'string' ? record.error : `请求失败：${String(response.status)}`)
  }
  return value
}

function recordOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('服务器返回了无效对象')
  return value as Record<string, unknown>
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${name} 无效`)
  return value
}

function requiredInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${name} 无效`)
  return value as number
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} 无效`)
  return value
}

function kindLabel(kind: ChangeKind): string {
  switch (kind) {
    case 'added': return '删除新增文件'
    case 'deleted': return '恢复已删文件'
    case 'modified': return '恢复内容'
    case 'mode-changed': return '恢复权限'
    case 'type-changed': return '恢复类型'
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
