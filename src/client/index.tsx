import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
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

interface ConversationSnapshotLike {
  readonly nodes: readonly ConversationNodeLike[]
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

interface RewindPortalBridgeProps {
  readonly sessionId: string
  readonly openSession: (sessionId: string) => void
  readonly useSession: <T>(selector: (snapshot: ConversationSnapshotLike) => T) => T
}

interface RewindPortalTarget {
  readonly container: HTMLElement
  readonly matched: RewindMatch
}

interface SlotsLike {
  inject(name: string, install: () => unknown): void
  register(
    entry: {
      readonly name: string
      readonly id: string
      readonly order: number
      readonly inject: () => { readonly openSession: (sessionId: string) => void }
    },
    component: (props: RewindPortalBridgeProps) => ReactNode,
  ): () => void
}

interface ClientContextLike {
  readonly slots: SlotsLike
  readonly sessions: { open(sessionId: string): void }
  effect(setup: () => (() => void), label?: string): unknown
}

type RewindMode = 'both' | 'code'
type ChangeKind = 'added' | 'deleted' | 'modified' | 'mode-changed' | 'type-changed'

interface ReadyPreview {
  readonly status: 'ready'
  readonly sessionId: string
  readonly turn: number
  readonly checkpointId: string
  readonly turnEndSeq: number
  readonly totalChanges: number
  readonly changes: readonly { readonly path: string; readonly kind: ChangeKind }[]
  readonly offset: number
  readonly truncated: boolean
  readonly headChanged: boolean
  readonly operationChanged: boolean
  readonly activeSessionIds: readonly string[]
  readonly restoreBlocked: boolean
  readonly planId?: string
  readonly confirmation?: string
}

type Preview = ReadyPreview
  | { readonly status: 'pending' }
  | { readonly status: 'missing' }
  | { readonly status: 'failed'; readonly error: string }

const PATH = '/turn-rewind'
const STYLE_ID = '@dsh-external/turn-rewind'
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
`

/** Return the completed turn closed by one assistant-tail anchor. */
export function selectRewindTurn(owner: TurnTailOwnerLike): RewindMatch | null {
  const node = owner.nodes.find(candidate => candidate.kind === 'assistant' && candidate.seq === owner.seq)
  return node !== undefined && Number.isSafeInteger(node.turn) && (node.turn as number) >= 0
    ? { turn: node.turn as number, seq: owner.seq }
    : null
}

/** Browser plugin entry: bridge every finalized assistant action row to the rewind UI. */
export const inject = ['slots', 'sessions']
export function apply(ctx: ClientContextLike): void {
  ctx.effect(() => {
    if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.plugin = '@dsh-external/turn-rewind'
    tag.dataset.pluginCss = STYLE_ID
    tag.textContent = styles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'turn-rewind: styles')
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'turn-rewind-portals',
    order: 100,
    inject: () => ({ openSession: (sessionId: string) => { ctx.sessions.open(sessionId) } }),
  }, RewindTurnPortals))
}

/** Session-scoped bridge that portals rewind controls into finalized assistant action rows. */
export function RewindTurnPortals({ sessionId, openSession, useSession }: RewindPortalBridgeProps): ReactNode {
  const nodes = useSession(snapshot => snapshot.nodes)
  const [targets, setTargets] = useState<readonly RewindPortalTarget[]>([])

  useLayoutEffect(() => {
    let active = true
    let queued = false
    const refresh = (): void => {
      if (!active) return
      const next = collectPortalTargets(nodes)
      setTargets(current => samePortalTargets(current, next) ? current : next)
    }
    const queueRefresh = (): void => {
      if (queued || !active) return
      queued = true
      queueMicrotask(() => {
        queued = false
        refresh()
      })
    }
    refresh()
    const observer = new MutationObserver(queueRefresh)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      active = false
      observer.disconnect()
    }
  }, [nodes])

  return targets.map(target => createPortal(
    <RewindTurnTail matched={target.matched} sessionId={sessionId} openSession={openSession} />,
    target.container,
    `${sessionId}:${String(target.matched.seq)}`,
  ))
}

/** Turn-tail action and its review-first code/conversation restore dialog. */
export function RewindTurnTail({ matched, sessionId, openSession }: RewindTailProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [mode, setMode] = useState<RewindMode>('both')
  const [applying, setApplying] = useState(false)
  const [loadingDetails, setLoadingDetails] = useState(false)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [completed, setCompleted] = useState<string | null>(null)
  const [backupId, setBackupId] = useState<string | null>(null)
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
    setStale(false)
    setError(null)
    setCompleted(null)
    setBackupId(null)
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
    setStale(false)
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
    setError(null)
    setCompleted(null)
  }
  const ready = preview?.status === 'ready' ? preview : null
  const hasFileChanges = ready !== null && ready.totalChanges > 0
  const driftBlocked = hasFileChanges && ready !== null && (ready.headChanged || ready.operationChanged)
  const sharedBlocked = ready?.restoreBlocked === true
  const planMissing = hasFileChanges && ready !== null && !sharedBlocked && (ready.planId === undefined || ready.confirmation === undefined)
  const canApply = ready !== null
    && !loading
    && !applying
    && !loadingDetails
    && completed === null
    && hasFileChanges
    && !driftBlocked
    && !sharedBlocked
    && !planMissing
    && !stale

  const loadAllChanges = async (): Promise<void> => {
    if (ready === null || loadingDetails || !ready.truncated) return
    setLoadingDetails(true)
    setError(null)
    try {
      const collected = [...ready.changes]
      let offset = collected.length
      while (offset < ready.totalChanges) {
        const response = await fetch(`${PATH}?sessionId=${encodeURIComponent(sessionId)}&turn=${String(matched.turn)}&details=1&offset=${String(offset)}&limit=200`, {
          method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store',
        })
        const page = decodePreview(await responseJson(response))
        if (page.status !== 'ready'
          || page.checkpointId !== ready.checkpointId
          || page.totalChanges !== ready.totalChanges
          || page.offset !== offset) {
          throw new RewindRequestError('PLAN_STALE', '项目文件在展开列表时发生了变化。')
        }
        collected.push(...page.changes)
        offset += page.changes.length
        if (page.changes.length === 0) break
      }
      if (offset !== ready.totalChanges) throw new RewindRequestError('PLAN_STALE', '无法读取完整的文件列表。')
      setPreview({ ...ready, changes: collected, truncated: false })
    } catch (caught) {
      if (caught instanceof RewindRequestError && caught.code === 'PLAN_STALE') setStale(true)
      setError(friendlyError(caught))
    } finally {
      setLoadingDetails(false)
    }
  }

  const applyRestore = async (): Promise<void> => {
    if (ready === null || !canApply || applyPending.current) return
    const body: Record<string, unknown> = {
      mode,
      sessionId,
      turn: ready.turn,
      checkpointId: ready.checkpointId,
    }
    if (ready.planId === undefined || ready.confirmation === undefined) return
    body.planId = ready.planId
    body.confirmation = ready.confirmation
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
      if (mode === 'code') {
        const rescuePointId = requiredString(result.rescuePointId, 'rescuePointId')
        setBackupId(rescuePointId)
        setCompleted('项目文件已恢复；当前对话保持不变。操作前的文件已保存在自动备份中。')
        return
      }
      const childSessionId = requiredString(result.sessionId, 'sessionId')
      const rescuePointId = requiredString(result.rescuePointId, 'rescuePointId')
      setBackupId(rescuePointId)
      setCompleted('项目文件已恢复，并已创建从这里继续的新对话。操作前的文件已保存在自动备份中。')
      try {
        openSession(childSessionId)
        setOpen(false)
      } catch (navigationError) {
        setError(`回退已完成，但无法自动打开新对话：${messageOf(navigationError)}`)
      }
    } catch (caught) {
      if (caught instanceof RewindRequestError && (caught.code === 'PLAN_STALE' || caught.code === 'WORKSPACE_IN_USE')) {
        setStale(true)
      }
      setError(friendlyError(caught))
    } finally {
      applyPending.current = false
      setApplying(false)
    }
  }

  const actionLabel = mode === 'both' ? '恢复并继续' : '恢复文件'
  const radioName = `dcl-rewind-${sessionId}-${String(matched.turn)}`

  return (
    <div className="dcl-rewind-tail">
      <Tooltip label={`恢复到第 ${String(matched.turn)} 轮结束时的文件`} side="bottom">
        <button type="button" className="dcl-rewind-trigger" onClick={show} aria-label={`恢复到第 ${String(matched.turn)} 轮结束时的文件`}>
          <RewindIcon size={16} />
        </button>
      </Tooltip>
      <Modal
        open={open}
        onClose={close}
        title={`恢复第 ${String(matched.turn)} 轮结束时的项目文件`}
        closeLabel="关闭"
        description="先查看将要恢复的文件，再选择是否从这里继续新对话。原对话始终保留。"
        className="dcl-rewind-dialog"
        contentClassName="dcl-rewind-content"
        footer={(
          <>
            <Button variant="outline" onClick={close} disabled={applying}>取消</Button>
            <Button variant="primary" onClick={() => { void applyRestore() }} disabled={!canApply}>
              {applying ? '正在恢复…' : completed === null ? actionLabel : '已完成'}
            </Button>
          </>
        )}
      >
        <div className="dcl-rewind-body">
          {loading && <p className="dcl-rewind-status">正在检查可以恢复的项目文件…</p>}
          {preview?.status === 'pending' && <p className="dcl-rewind-status">这一轮的文件状态仍在保存，请稍后重新检查。</p>}
          {preview?.status === 'missing' && <p className="dcl-rewind-error">没有保存这一轮的文件状态。它可能早于 Turn Rewind 启用时间，或已经超过保留期限。</p>}
          {preview?.status === 'failed' && <p className="dcl-rewind-error">无法读取这一轮的文件状态：{preview.error}</p>}
          {ready !== null && (
            <>
              <div className="dcl-rewind-options">
                <label className="dcl-rewind-option" data-selected={mode === 'both'} data-disabled={applying}>
                  <input type="radio" name={radioName} checked={mode === 'both'} disabled={applying} onChange={() => { chooseMode('both') }} />
                  <span className="dcl-rewind-option-content"><strong>恢复文件并从这里继续</strong><span className="dcl-rewind-option-description">创建一个从这里开始的新会话（当前对话会保留）</span></span>
                </label>
                <label className="dcl-rewind-option" data-selected={mode === 'code'} data-disabled={applying}>
                  <input type="radio" name={radioName} checked={mode === 'code'} disabled={applying} onChange={() => { chooseMode('code') }} />
                  <span className="dcl-rewind-option-content"><strong>只恢复文件</strong><span className="dcl-rewind-option-description">当前对话保持不变，只恢复这一轮结束时的项目文件。</span></span>
                </label>
              </div>
              <div className="dcl-rewind-summary">
                <strong>将恢复 {String(ready.totalChanges)} 个文件</strong>
                <span>{mode === 'both' ? '恢复后从这里继续新对话' : '当前对话保持不变'}</span>
              </div>
              {sharedBlocked && (
                <p className="dcl-rewind-error">这个项目目录还有其他对话正在运行。恢复文件会影响那些对话，因此当前操作已被阻止。请等待它们结束或先停止运行，再重新检查。</p>
              )}
              {driftBlocked && <p className="dcl-rewind-warning">项目的版本状态已经变化，当前无法安全恢复。请先完成或取消正在进行的版本控制操作，然后重新检查。</p>}
              {planMissing && <p className="dcl-rewind-error">恢复信息已经失效，请重新检查文件。</p>}
              {stale && <p className="dcl-rewind-error">项目文件在检查后又发生了变化。为避免覆盖新修改，这次恢复已失效，请重新检查。</p>}
              {ready.totalChanges === 0 && <p className="dcl-rewind-status">项目文件已经和这一轮结束时一致，无需恢复。如需从这里开始新对话，请使用回复旁的“分支新对话”按钮。</p>}
              {ready.changes.length > 0 && (
                <div className="dcl-rewind-files">
                  {ready.changes.map(change => <div className="dcl-rewind-file" key={change.path}><code>{change.path}</code><span className="dcl-rewind-kind">{fileRecoveryLabel(change.kind)}</span></div>)}
                </div>
              )}
              {ready.truncated && (
                <div className="dcl-rewind-file-actions"><Button variant="outline" size="sm" onClick={() => { void loadAllChanges() }} disabled={loadingDetails}>{loadingDetails ? '正在读取全部文件…' : `查看全部 ${String(ready.totalChanges)} 个文件`}</Button></div>
              )}
              <details className="dcl-rewind-details">
                <summary>操作详情</summary>
                <dl>
                  <dt>文件状态</dt><dd>{ready.checkpointId}</dd>
                  <dt>对话边界</dt><dd>turn {String(ready.turn)} / seq {String(ready.turnEndSeq)}</dd>
                  <dt>恢复授权</dt><dd>{ready.planId ?? '未生成'}</dd>
                  <dt>版本状态变化</dt><dd>{ready.headChanged || ready.operationChanged ? '是' : '否'}</dd>
                  <dt>共享目录</dt><dd>{ready.activeSessionIds.length > 0 ? ready.activeSessionIds.join(', ') : '无其他正在运行的对话'}</dd>
                  {backupId !== null && <><dt>自动备份</dt><dd>{backupId}</dd></>}
                </dl>
              </details>
            </>
          )}
          {completed !== null && <p className="dcl-rewind-status">{completed}</p>}
          {error !== null && <p className="dcl-rewind-error">{error}</p>}
          {error !== null && <p className="dcl-rewind-backup">恢复前会自动备份当前项目文件。恢复失败时会自动还原，不会让项目停留在只恢复了一部分的状态。</p>}
          {!loading && (preview?.status !== 'ready' || stale || planMissing || sharedBlocked || driftBlocked) && <Button className="dcl-rewind-retry" variant="outline" size="sm" onClick={() => { void load(true) }}>重新检查</Button>}
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
  const activeSessionIdsValue = record.activeSessionIds
  if (!Array.isArray(activeSessionIdsValue) || !activeSessionIdsValue.every(value => typeof value === 'string')) {
    throw new Error('回退预览缺少 activeSessionIds')
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
    activeSessionIds: activeSessionIdsValue as string[],
    restoreBlocked: requiredBoolean(record.restoreBlocked, 'restoreBlocked'),
    ...(typeof record.planId === 'string' ? { planId: record.planId } : {}),
    ...(typeof record.confirmation === 'string' ? { confirmation: record.confirmation } : {}),
  }
}

function collectPortalTargets(nodes: readonly ConversationNodeLike[]): readonly RewindPortalTarget[] {
  const rows = new Map<string, HTMLElement>()
  for (const element of Array.from(document.querySelectorAll<HTMLElement>(
    '[data-chat-flow-kind="assistant"][data-chat-anchor-key]',
  ))) {
    const key = element.dataset.chatAnchorKey
    if (key !== undefined) rows.set(key, element)
  }
  const targets: RewindPortalTarget[] = []
  for (const node of nodes) {
    if (node.kind !== 'assistant') continue
    const matched = selectRewindTurn({ nodes, seq: node.seq })
    if (matched === null) continue
    const row = rows.get(`node:${String(node.seq)}`)
    const messageRoot = row?.querySelector<HTMLElement>(':scope > [data-time-hover-root="true"]')
    const actions = messageRoot?.lastElementChild
    if (!(actions instanceof HTMLElement) || actions.querySelector(':scope > button') === null) continue
    targets.push({ container: actions, matched })
  }
  return targets
}

function samePortalTargets(
  left: readonly RewindPortalTarget[],
  right: readonly RewindPortalTarget[],
): boolean {
  return left.length === right.length && left.every((target, index) => {
    const other = right[index]
    return other !== undefined
      && target.container === other.container
      && target.matched.seq === other.matched.seq
      && target.matched.turn === other.matched.turn
  })
}

async function responseJson(response: Response): Promise<unknown> {
  const value = await response.json() as unknown
  if (!response.ok) {
    const record = recordOf(value)
    throw new RewindRequestError(
      typeof record.code === 'string' ? record.code : 'REWIND_FAILED',
      typeof record.error === 'string' ? record.error : `请求失败：${String(response.status)}`,
    )
  }
  return value
}

class RewindRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
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

/** Describe the user-visible result of restoring one changed file. */
export function fileRecoveryLabel(kind: ChangeKind): string {
  switch (kind) {
    case 'added': return '移除后来新增的文件'
    case 'deleted': return '找回文件'
    case 'modified': return '恢复之前的版本'
    case 'mode-changed': return '恢复文件权限'
    case 'type-changed': return '恢复之前的文件类型'
  }
}

function RewindIcon({ size }: { readonly size: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6.35 3.25 2.75 7l3.6 3.75M3.1 7h5.15a4.25 4.25 0 0 1 4.25 4.25v1.25" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function friendlyError(error: unknown): string {
  if (!(error instanceof RewindRequestError)) return messageOf(error)
  switch (error.code) {
    case 'PLAN_STALE': return '项目文件在检查后又发生了变化。为避免覆盖新修改，请重新检查后再恢复。'
    case 'WORKSPACE_IN_USE': return '这个项目目录还有其他对话正在运行。请等待它们结束或先停止运行，再重新检查。'
    case 'WORKSPACE_LOCKED': return '另一个恢复操作正在处理这个项目目录。请等待它完成后重新检查。'
    case 'NO_CHANGES': return '项目文件已经和这一轮结束时一致，无需恢复。需要新对话时请使用“分支新对话”。'
    case 'RESTORE_FAILED_ROLLED_BACK': return '恢复未能完成，项目文件已自动还原到操作前的状态。'
    case 'CONVERSATION_REWIND_FAILED': return '文件已经恢复，但无法创建继续对话；项目文件已自动还原。'
    default: return error.message
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
