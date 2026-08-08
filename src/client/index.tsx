import { useCallback, useState, type ReactNode } from 'react'
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
}

interface SlotsLike {
  inject(name: string, install: () => unknown): void
  register(
    entry: { readonly name: string; readonly select: (owner: TurnTailOwnerLike) => RewindMatch | null },
    component: (props: RewindTailProps) => ReactNode,
  ): () => void
}

interface ClientContextLike {
  readonly slots: SlotsLike
  effect(setup: () => (() => void), label?: string): unknown
}

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
`

/** Return the completed turn closed by one assistant-tail anchor. */
export function selectRewindTurn(owner: TurnTailOwnerLike): RewindMatch | null {
  const node = owner.nodes.find(candidate => candidate.kind === 'assistant' && candidate.seq === owner.seq)
  return node !== undefined && Number.isSafeInteger(node.turn) && (node.turn as number) >= 0
    ? { turn: node.turn as number, seq: owner.seq }
    : null
}

/** Browser plugin entry: register one compact action under every finalized assistant turn. */
export const inject = ['slots']
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
  }, RewindTurnTail))
}

/** Turn-tail action and its review-first code restore dialog. */
export function RewindTurnTail({ matched, sessionId }: RewindTailProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [completed, setCompleted] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setCompleted(null)
    try {
      const response = await fetch(`${PATH}?sessionId=${encodeURIComponent(sessionId)}&turn=${String(matched.turn)}`, {
        method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store',
      })
      const value = await responseJson(response)
      setPreview(decodePreview(value))
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setLoading(false)
    }
  }, [matched.turn, sessionId])

  const show = (): void => {
    setOpen(true)
    setAcknowledged(false)
    void load()
  }
  const close = (): void => { if (!applying) setOpen(false) }
  const ready = preview?.status === 'ready' ? preview : null
  const blocked = ready === null || ready.totalChanges === 0 || ready.headChanged || ready.operationChanged

  const applyRestore = async (): Promise<void> => {
    if (ready?.planId === undefined || ready.confirmation === undefined || !acknowledged || blocked) return
    setApplying(true)
    setError(null)
    try {
      const response = await fetch(PATH, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'code', sessionId, planId: ready.planId, confirmation: ready.confirmation,
        }),
      })
      const result = recordOf(await responseJson(response))
      setCompleted(`代码已恢复；救援点 ${requiredString(result.rescuePointId, 'rescuePointId')} 已保留。`)
      setAcknowledged(false)
      await load()
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setApplying(false)
    }
  }

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
        description="恢复前会再次验证工作区，并自动保存当前代码作为救援点。"
        footer={(
          <>
            <Button variant="outline" onClick={close} disabled={applying}>取消</Button>
            <Button variant="primary" onClick={() => { void applyRestore() }} disabled={blocked || !acknowledged || applying}>
              {applying ? '正在恢复…' : '恢复代码'}
            </Button>
          </>
        )}
      >
        <div className="dcl-rewind-body">
          {loading && <p>正在检查此轮的代码状态…</p>}
          {preview?.status === 'pending' && <p>此轮检查点仍在写入，请稍后重试。</p>}
          {preview?.status === 'missing' && <p className="dcl-rewind-error">没有找到此轮检查点；该轮可能早于插件启用时间或已超过保留窗口。</p>}
          {preview?.status === 'failed' && <p className="dcl-rewind-error">检查点创建失败：{preview.error}</p>}
          {ready !== null && (
            <>
              <label className="dcl-rewind-option">
                <input type="radio" checked readOnly />
                <span><strong>仅恢复代码</strong><span>对话保持当前位置，只把工作区恢复到此轮结束时。</span></span>
              </label>
              <div className="dcl-rewind-summary"><span>{String(ready.totalChanges)} 个路径将变化</span><span>救援点会自动创建</span></div>
              {(ready.headChanged || ready.operationChanged) && (
                <p className="dcl-rewind-warning">Git HEAD、分支或进行中的 Git 操作已经变化。为避免跨历史恢复，请先处理该变化后重新打开。</p>
              )}
              {ready.totalChanges === 0 && <p>当前工作区已经与该轮结束状态一致。</p>}
              {ready.changes.length > 0 && (
                <div className="dcl-rewind-files">
                  {ready.changes.map(change => <div className="dcl-rewind-file" key={change.path}><code>{change.path}</code><span className="dcl-rewind-kind">{kindLabel(change.kind)}</span></div>)}
                  {ready.truncated && <div className="dcl-rewind-file"><span>其余路径未在此处展开</span></div>}
                </div>
              )}
              {!blocked && (
                <label className="dcl-rewind-ack"><input type="checkbox" checked={acknowledged} disabled={applying} onChange={event => { setAcknowledged(event.currentTarget.checked) }} /><span>我确认恢复以上代码变化；当前状态将保存在救援点中。</span></label>
              )}
            </>
          )}
          {completed !== null && <p>{completed}</p>}
          {error !== null && <p className="dcl-rewind-error">{error}</p>}
          {!loading && preview?.status !== 'ready' && <Button variant="outline" size="sm" onClick={() => { void load() }}>重试</Button>}
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
