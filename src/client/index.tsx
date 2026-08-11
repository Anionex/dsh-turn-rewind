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
  readonly content?: readonly { readonly type: string; readonly text?: string }[]
}

interface ConversationChatNodeLike {
  readonly key: string
  readonly kind: string
  readonly data: ConversationNodeLike
}

interface ConversationSnapshotLike {
  readonly nodes: readonly ConversationNodeLike[]
  readonly chat?: {
    readonly nodes: {
      values(): readonly ConversationChatNodeLike[]
    }
  }
}

type RewindNodeLike = ConversationNodeLike | ConversationChatNodeLike

interface RewindMatch {
  readonly messageSeq: number
  readonly promptText: string
}

interface RewindMessageActionProps {
  readonly matched: RewindMatch
  readonly sessionId: string
  readonly openRestoredSession: (sessionId: string, promptText: string) => Promise<void>
}

interface RewindPortalBridgeProps {
  readonly sessionId: string
  readonly openRestoredSession: (sessionId: string, promptText: string) => Promise<void>
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
      readonly inject: () => {
        readonly openRestoredSession: (sessionId: string, promptText: string) => Promise<void>
      }
    },
    component: (props: RewindPortalBridgeProps) => ReactNode,
  ): () => void
}

interface ClientContextLike {
  readonly slots: SlotsLike
  readonly sessions: {
    open(sessionId: string): void
    scope(sessionId: string): unknown | undefined
  }
  readonly conversation: {
    readonly input: {
      for(scope: unknown): { setDraft(text: string): void }
    }
  }
  effect(setup: () => (() => void), label?: string): unknown
}

type RewindMode = 'both' | 'code'
type ChangeKind = 'added' | 'deleted' | 'modified' | 'mode-changed' | 'type-changed'

interface ReadyPreview {
  readonly status: 'ready'
  readonly sessionId: string
  readonly messageSeq: number
  readonly turn: number
  readonly checkpointId: string
  readonly turnStartSeq: number
  readonly totalChanges: number
  readonly changes: readonly { readonly path: string; readonly kind: ChangeKind }[]
  readonly offset: number
  readonly truncated: boolean
  readonly headChanged: boolean
  readonly operationChanged: boolean
  readonly checkpointHead?: string
  readonly checkpointBranch?: string
  readonly checkpointOperation?: string
  readonly currentHead?: string
  readonly currentBranch?: string
  readonly currentOperation?: string
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
`

/** Return the rewind anchor and editable text owned by one direct user message. */
export function selectRewindMessage(node: ConversationNodeLike): RewindMatch | null {
  if (node.kind !== 'user' || !Number.isSafeInteger(node.seq) || node.seq < 0) return null
  const promptText = (node.content ?? [])
    .filter((block): block is { readonly type: string; readonly text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
  return { messageSeq: node.seq, promptText }
}

/** Browser plugin entry: bridge every direct user-message action row to the rewind UI. */
export const inject = ['slots', 'sessions', 'conversation']
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
    inject: () => ({
      openRestoredSession: async (sessionId: string, promptText: string) => {
        await openSessionWithDraft(ctx, sessionId, promptText)
      },
    }),
  }, RewindMessagePortals))
}

/** Session-scoped bridge that portals rewind controls into direct user-message action rows. */
export function RewindMessagePortals({ sessionId, openRestoredSession, useSession }: RewindPortalBridgeProps): ReactNode {
  const nodes = useSession<readonly RewindNodeLike[]>(snapshot => snapshot.chat?.nodes.values() ?? snapshot.nodes)
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
    <RewindMessageAction matched={target.matched} sessionId={sessionId} openRestoredSession={openRestoredSession} />,
    target.container,
    `${sessionId}:${String(target.matched.messageSeq)}`,
  ))
}

/** User-message action and its review-first file/conversation restore dialog. */
export function RewindMessageAction({ matched, sessionId, openRestoredSession }: RewindMessageActionProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [mode, setMode] = useState<RewindMode>('both')
  const [applying, setApplying] = useState(false)
  const [loadingDetails, setLoadingDetails] = useState(false)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [completed, setCompleted] = useState<string | null>(null)
  const loadAbort = useRef<AbortController | null>(null)
  const applyPending = useRef(false)

  useEffect(() => () => {
    loadAbort.current?.abort()
    loadAbort.current = null
  }, [])

  const load = useCallback(async () => {
    loadAbort.current?.abort()
    const controller = new AbortController()
    loadAbort.current = controller
    setLoading(true)
    setStale(false)
    setError(null)
    setCompleted(null)
    try {
      const response = await fetch(`${PATH}?sessionId=${encodeURIComponent(sessionId)}&messageSeq=${String(matched.messageSeq)}`, {
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
  }, [matched.messageSeq, sessionId])

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
  const driftBlocked = hasFileChanges && ready?.operationChanged === true
  const sharedBlocked = (ready?.activeSessionIds.length ?? 0) > 0
  const planMissing = hasFileChanges && ready !== null && !sharedBlocked && !driftBlocked
    && (ready.planId === undefined || ready.confirmation === undefined)
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
        const response = await fetch(`${PATH}?sessionId=${encodeURIComponent(sessionId)}&messageSeq=${String(matched.messageSeq)}&details=1&offset=${String(offset)}&limit=200`, {
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
      messageSeq: ready.messageSeq,
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
        requiredString(result.rescuePointId, 'rescuePointId')
        setCompleted('项目文件已恢复；当前对话保持不变。恢复前的文件已自动备份。')
        return
      }
      const childSessionId = requiredString(result.sessionId, 'sessionId')
      requiredString(result.rescuePointId, 'rescuePointId')
      setCompleted('项目文件已恢复，并已创建新对话。恢复前的文件已自动备份。')
      try {
        await openRestoredSession(childSessionId, matched.promptText)
        setOpen(false)
      } catch (navigationError) {
        setError(`文件已经恢复，新对话也已创建，但没能自动打开：${messageOf(navigationError)}`)
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

  const actionLabel = mode === 'both' ? '恢复并从这里继续' : '恢复文件'
  const radioName = `dcl-rewind-${sessionId}-${String(matched.messageSeq)}`
  const branchChanged = ready !== null && ready.checkpointBranch !== ready.currentBranch

  return (
    <div className="dcl-rewind-tail">
      <Tooltip label="恢复到发送这条消息之前" side="bottom">
        <button type="button" className="dcl-rewind-trigger" onClick={show} aria-label="恢复到发送这条消息之前">
          <RewindIcon size={16} />
        </button>
      </Tooltip>
      <Modal
        open={open}
        onClose={close}
        title="恢复到发送这条消息之前"
        closeLabel="关闭"
        description="查看恢复的文件，选择适合你的回退方式。当前会话不受影响。"
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
          {preview?.status === 'pending' && <p className="dcl-rewind-status">这条消息发送前的文件还在保存，请稍后再试。</p>}
          {preview?.status === 'missing' && <p className="dcl-rewind-error">没有保存这条消息发送前的文件。可能是当时还没启用回退功能，或记录已超过保留期限。</p>}
          {preview?.status === 'failed' && <p className="dcl-rewind-error">没能保存这条消息发送前的文件：{preview.error}</p>}
          {ready !== null && (
            <>
              <div className="dcl-rewind-options">
                <label className="dcl-rewind-option" data-selected={mode === 'both'} data-disabled={applying}>
                  <input type="radio" name={radioName} checked={mode === 'both'} disabled={applying} onChange={() => { chooseMode('both') }} />
                  <span className="dcl-rewind-option-content"><strong>恢复文件并从这里继续</strong><span className="dcl-rewind-option-description">创建一个从这里开始的新会话（当前对话会保留）</span></span>
                </label>
                <label className="dcl-rewind-option" data-selected={mode === 'code'} data-disabled={applying}>
                  <input type="radio" name={radioName} checked={mode === 'code'} disabled={applying} onChange={() => { chooseMode('code') }} />
                  <span className="dcl-rewind-option-content"><strong>只恢复文件</strong><span className="dcl-rewind-option-description">恢复这条消息发送前的文件，当前对话保持不变。</span></span>
                </label>
              </div>
              <div className="dcl-rewind-summary">
                <strong>将恢复 {String(ready.totalChanges)} 个文件</strong>
                <span>{mode === 'both' ? '恢复后在新对话里继续' : '当前对话保持不变'}</span>
              </div>
              {sharedBlocked && (
                <p className="dcl-rewind-error">这个项目目录还有别的对话正在运行。恢复文件会影响到它们，因此本次操作已被阻止。请等那些对话结束或停止后，再重新检查。</p>
              )}
              {ready.headChanged && !ready.operationChanged && (
                <p className="dcl-rewind-warning">{branchChanged
                  ? '当前所在的 Git 分支和发送这条消息时不同。恢复不会切换分支，只会把当时的文件内容恢复到当前分支。'
                  : '这条消息之后有了新的 Git 提交。恢复只会改文件，不会撤销提交；完成后这些文件会显示为未提交修改。'}</p>
              )}
              {driftBlocked && <p className="dcl-rewind-warning">Git 正在进行合并、变基或类似操作。请先完成或取消这次 Git 操作，再重新检查。</p>}
              {planMissing && <p className="dcl-rewind-error">恢复信息已经失效，请重新检查。</p>}
              {stale && <p className="dcl-rewind-error">项目文件在检查后又发生了变化。为避免覆盖新修改，这次恢复已失效，请重新检查。</p>}
              {ready.totalChanges === 0 && <p className="dcl-rewind-status">项目文件已经是这条消息发送前的状态，无需恢复。想重新开始时，可以使用“分支新对话”。</p>}
              {ready.changes.length > 0 && (
                <div className="dcl-rewind-files">
                  {ready.changes.map(change => <div className="dcl-rewind-file" key={change.path}><code>{change.path}</code><span className="dcl-rewind-kind">{fileRecoveryLabel(change.kind)}</span></div>)}
                </div>
              )}
              {ready.truncated && (
                <div className="dcl-rewind-file-actions"><Button variant="outline" size="sm" onClick={() => { void loadAllChanges() }} disabled={loadingDetails}>{loadingDetails ? '正在读取全部文件…' : `查看全部 ${String(ready.totalChanges)} 个文件`}</Button></div>
              )}
            </>
          )}
          {completed !== null && <p className="dcl-rewind-status">{completed}</p>}
          {error !== null && <p className="dcl-rewind-error">{error}</p>}
          {error !== null && <p className="dcl-rewind-backup">恢复前会自动备份当前文件；若恢复失败会自动还原，项目不会停留在只恢复了一部分的状态。</p>}
          {!loading && (preview?.status !== 'ready' || stale || planMissing || sharedBlocked || driftBlocked) && <Button className="dcl-rewind-retry" variant="outline" size="sm" onClick={() => { void load() }}>重新检查</Button>}
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
    activeSessionIds: activeSessionIdsValue as string[],
    restoreBlocked: requiredBoolean(record.restoreBlocked, 'restoreBlocked'),
    ...(typeof record.planId === 'string' ? { planId: record.planId } : {}),
    ...(typeof record.confirmation === 'string' ? { confirmation: record.confirmation } : {}),
  }
}

/** Resolve one conversation node to its DOM row key and rewind match. */
export function selectRewindMessageTarget(value: RewindNodeLike): { readonly matched: RewindMatch; readonly rowKey: string } | null {
  const node = 'key' in value && 'data' in value ? value.data : value
  const matched = selectRewindMessage(node)
  if (matched === null) return null
  return {
    matched,
    rowKey: 'key' in value && 'data' in value ? value.key : `node:${String(node.seq)}`,
  }
}

function collectPortalTargets(nodes: readonly RewindNodeLike[]): readonly RewindPortalTarget[] {
  const rows = new Map<string, HTMLElement>()
  for (const element of Array.from(document.querySelectorAll<HTMLElement>(
    '[data-chat-flow-kind="user"][data-chat-anchor-key]',
  ))) {
    const key = element.dataset.chatAnchorKey
    if (key !== undefined) rows.set(key, element)
  }
  const targets: RewindPortalTarget[] = []
  for (const value of nodes) {
    const target = selectRewindMessageTarget(value)
    if (target === null) continue
    const row = rows.get(target.rowKey)
    const messageRoot = row?.querySelector<HTMLElement>(':scope > [data-time-hover-root="true"]')
    const actions = messageRoot?.lastElementChild
    if (!(actions instanceof HTMLElement) || actions.querySelector(':scope > button') === null) continue
    targets.push({ container: actions, matched: target.matched })
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
      && target.matched.messageSeq === other.matched.messageSeq
      && target.matched.promptText === other.matched.promptText
  })
}

async function openSessionWithDraft(ctx: ClientContextLike, sessionId: string, promptText: string): Promise<void> {
  let lastError: unknown = new Error('新对话还没有准备好')
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      ctx.sessions.open(sessionId)
      const scope = ctx.sessions.scope(sessionId)
      if (scope !== undefined) {
        ctx.conversation.input.for(scope).setDraft(promptText)
        return
      }
      lastError = new Error('新对话还没有准备好')
    } catch (error) {
      lastError = error
    }
    await new Promise<void>(resolve => { setTimeout(resolve, 50) })
  }
  throw lastError
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

function optionalRecordString(record: Record<string, unknown>, name: string): Record<string, string> {
  const value = record[name]
  if (value === undefined) return {}
  return { [name]: requiredString(value, name) }
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
    case 'PLAN_STALE_REPOSITORY': return 'Git 状态在检查后又发生了变化，恢复已失效。请重新检查后再试。'
    case 'WORKSPACE_IN_USE': return '这个项目目录还有别的对话正在运行。请等那些对话结束或停止后，再重新检查。'
    case 'WORKSPACE_LOCKED': return '另一个恢复操作正在处理这个项目目录。请等待它完成后重新检查。'
    case 'HEAD_CHANGED': return '项目的提交或分支已发生变化。为避免覆盖新改动，请重新检查后再恢复。'
    case 'REPOSITORY_CHANGED': return '这个项目目录已不属于原来的 Git 工作区，无法恢复。'
    case 'GIT_OPERATION_CHANGED': return 'Git 正在执行其他操作。请先完成或取消该操作，再重新检查。'
    case 'RESTORE_POINT_NOT_FOUND': return '没有找到对应的文件状态，可能已被清理。'
    case 'NO_CHANGES': return '项目文件已经是这条消息发送前的状态，无需恢复。想重新开始时，可以使用“分支新对话”。'
    case 'RESTORE_FAILED_ROLLED_BACK': return '恢复未能完成，项目文件已自动还原到操作前的状态。'
    case 'CONVERSATION_REWIND_FAILED': return '文件已恢复，但无法创建新对话；项目文件已自动还原。'
    default: return error.message
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
