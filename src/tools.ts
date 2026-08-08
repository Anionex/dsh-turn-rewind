import type { Context } from 'cordis'
import type { ChangeLedgerEngine } from './engine.js'
import { ChangeLedgerError } from './errors.js'

interface AgentLike {
  readonly id: string
  readonly session: { readonly header: { readonly cwd?: string } }
}

interface ToolRunContextLike {
  readonly agent?: AgentLike
  readonly signal: AbortSignal
}

interface ToolDefinitionLike {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): readonly { readonly type: 'text'; readonly text: string }[]
  }
  execute(args: unknown, exec: ToolRunContextLike): Promise<unknown>
  presentCall?(args: Record<string, unknown>): Record<string, unknown>
}

interface ToolsServiceLike {
  register(definition: ToolDefinitionLike): () => void
}

interface HarnessContextLike {
  readonly tools: ToolsServiceLike
  effect(callback: () => (() => void)): void
  on(name: string, callback: (exec: { readonly name: string }, next: () => Promise<unknown>) => Promise<unknown>): () => void
}

const OBJECT_OUTPUT = {
  schema: { type: 'object' },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: formatValue(value) }],
}

const MAX_TOOL_PAGE = 200
const MAX_RECOVERY_PAGE = 50
const RECOVERY_PATH_PREVIEW = 20
const MAX_DIAGNOSTIC_TEXT = 2_000

/** Register the explicit, approval-gated model-facing change-ledger tools. */
export function registerTools(ctx: Context, engine: ChangeLedgerEngine): void {
  const harness = ctx as unknown as HarnessContextLike
  harness.effect(() => {
    const disposers = [
      harness.tools.register({
        name: 'change_ledger_create',
        description: 'Create a persistent working-tree restore point. Use only when the user explicitly asks to mark a safe point; this never commits, stashes, or changes Git state.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string', description: 'Optional human-readable label, at most 200 characters.' },
          },
        },
        output: OBJECT_OUTPUT,
        async execute(args, exec) {
          const input = objectArgs(args)
          const label = optionalString(input.label, 'label')
          return engine.create({
            ...executionWorkspace(exec),
            ...(label === undefined ? {} : { label }),
            signal: exec.signal,
          })
        },
        presentCall(args) {
          return { card: 'generic', title: `Create restore point${typeof args.label === 'string' ? `: ${args.label}` : ''}` }
        },
      }),
      harness.tools.register({
        name: 'change_ledger_list',
        description: 'List persistent restore points for the current Git worktree with pagination. Rescue points are hidden unless explicitly requested.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            include_rescue: { type: 'boolean', description: 'Include automatic pre-restore rescue points.' },
            offset: { type: 'integer', description: 'Zero-based restore-point offset. Defaults to 0.' },
            limit: { type: 'integer', description: `Number of restore points to return, from 1 to ${MAX_TOOL_PAGE}.` },
          },
        },
        output: OBJECT_OUTPUT,
        async execute(args, exec) {
          const input = objectArgs(args)
          const points = await engine.list({
            cwd: executionWorkspace(exec).cwd,
            includeRescue: optionalBoolean(input.include_rescue, 'include_rescue') ?? false,
            signal: exec.signal,
          })
          const offset = optionalNonNegativeInteger(input.offset, 'offset') ?? 0
          const limit = optionalPositiveInteger(input.limit, 'limit') ?? 100
          if (limit > MAX_TOOL_PAGE) throw new ChangeLedgerError('INVALID_ARGUMENTS', `limit must not exceed ${MAX_TOOL_PAGE}`)
          return {
            totalRestorePoints: points.length,
            offset,
            limit,
            restorePoints: points.slice(offset, offset + limit),
            hasMore: offset + limit < points.length,
          }
        },
      }),
      harness.tools.register({
        name: 'change_ledger_inspect',
        description: 'Compare a restore point with the current working tree. This is read-only and reports path-level changes plus Git HEAD/operation drift.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            restore_point_id: { type: 'string' },
            offset: { type: 'integer', description: 'Zero-based change offset. Defaults to 0.' },
            limit: { type: 'integer', description: `Number of changes to return, from 1 to ${MAX_TOOL_PAGE}.` },
          },
          required: ['restore_point_id'],
        },
        output: OBJECT_OUTPUT,
        async execute(args, exec) {
          const input = objectArgs(args)
          const inspection = await engine.inspect({
            cwd: executionWorkspace(exec).cwd,
            restorePointId: requiredString(input.restore_point_id, 'restore_point_id'),
            signal: exec.signal,
          })
          const offset = optionalNonNegativeInteger(input.offset, 'offset') ?? 0
          const limit = optionalPositiveInteger(input.limit, 'limit') ?? 100
          if (limit > MAX_TOOL_PAGE) throw new ChangeLedgerError('INVALID_ARGUMENTS', `limit must not exceed ${MAX_TOOL_PAGE}`)
          return {
            restorePoint: inspection.restorePoint,
            currentTreeHash: inspection.currentTreeHash,
            headChanged: inspection.headChanged,
            operationChanged: inspection.operationChanged,
            totalChanges: inspection.changes.length,
            offset,
            limit,
            changes: inspection.changes.slice(offset, offset + limit).map(simplifyChange),
            hasMore: offset + limit < inspection.changes.length,
          }
        },
      }),
      harness.tools.register({
        name: 'change_ledger_plan_restore',
        description: 'Prepare, but do not apply, an exact restore plan. Returns a short-lived confirmation string. Omit paths to restore every changed path; selected paths must exactly match inspected changes.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            restore_point_id: { type: 'string' },
            paths: { type: 'array', items: { type: 'string' } },
            allow_head_change: { type: 'boolean', description: 'Permit planning after a reviewed branch/HEAD change. Git operation changes remain blocked.' },
          },
          required: ['restore_point_id'],
        },
        output: OBJECT_OUTPUT,
        async execute(args, exec) {
          const input = objectArgs(args)
          const workspace = executionWorkspace(exec)
          const paths = optionalStringArray(input.paths, 'paths')
          const plan = await engine.planRestore({
            ...workspace,
            restorePointId: requiredString(input.restore_point_id, 'restore_point_id'),
            ...(paths === undefined ? {} : { paths }),
            allowHeadChange: optionalBoolean(input.allow_head_change, 'allow_head_change') ?? false,
            signal: exec.signal,
          })
          return {
            planId: plan.id,
            restorePointId: plan.restorePointId,
            workspace: plan.workspace,
            expiresAt: plan.expiresAt,
            confirmation: plan.confirmation,
            allowHeadChange: plan.allowHeadChange,
            pathCount: plan.paths.length,
            pathsPreview: plan.paths.slice(0, 100),
            pathsTruncated: plan.paths.length > 100,
            changeCounts: countChangeKinds(plan.changes),
          }
        },
      }),
      harness.tools.register({
        name: 'change_ledger_apply_restore',
        description: 'Apply one previously reviewed restore plan. Requires the plan confirmation and a separate DSH human approval. A durable rescue point is created before any workspace mutation.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            plan_id: { type: 'string' },
            confirmation: { type: 'string' },
          },
          required: ['plan_id', 'confirmation'],
        },
        output: OBJECT_OUTPUT,
        async execute(args, exec) {
          const input = objectArgs(args)
          const result = await engine.applyRestore({
            planId: requiredString(input.plan_id, 'plan_id'),
            confirmation: requiredString(input.confirmation, 'confirmation'),
            sessionId: executionWorkspace(exec).sessionId,
            signal: exec.signal,
          })
          return {
            operationId: result.operationId,
            restorePointId: result.restorePointId,
            rescuePointId: result.rescuePointId,
            restoredPathCount: result.restoredPaths.length,
            restoredPathsPreview: result.restoredPaths.slice(0, 100),
            pathsTruncated: result.restoredPaths.length > 100,
          }
        },
        presentCall(args) {
          return { card: 'generic', title: `Restore workspace from plan ${String(args.plan_id)}` }
        },
      }),
      harness.tools.register({
        name: 'change_ledger_delete',
        description: 'Delete one restore point and collect unreferenced blobs. Requires confirmation exactly equal to "DELETE <restore_point_id>" and a separate DSH human approval.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            restore_point_id: { type: 'string' },
            confirmation: { type: 'string' },
          },
          required: ['restore_point_id', 'confirmation'],
        },
        output: OBJECT_OUTPUT,
        async execute(args, exec) {
          const input = objectArgs(args)
          return engine.delete({
            cwd: executionWorkspace(exec).cwd,
            restorePointId: requiredString(input.restore_point_id, 'restore_point_id'),
            confirmation: requiredString(input.confirmation, 'confirmation'),
            signal: exec.signal,
          })
        },
      }),
      harness.tools.register({
        name: 'change_ledger_recovery_list',
        description: 'List interrupted or recovery-required restore operations. Their rescue_point_id can be inspected and restored through the normal two-step restore flow.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            offset: { type: 'integer', description: 'Zero-based operation offset. Defaults to 0.' },
            limit: { type: 'integer', description: `Number of operations to return, from 1 to ${MAX_RECOVERY_PAGE}.` },
          },
        },
        output: OBJECT_OUTPUT,
        async execute(args, exec) {
          const input = objectArgs(args)
          const operations = await engine.listRecovery({ cwd: executionWorkspace(exec).cwd, signal: exec.signal })
          const offset = optionalNonNegativeInteger(input.offset, 'offset') ?? 0
          const limit = optionalPositiveInteger(input.limit, 'limit') ?? 20
          if (limit > MAX_RECOVERY_PAGE) throw new ChangeLedgerError('INVALID_ARGUMENTS', `limit must not exceed ${MAX_RECOVERY_PAGE}`)
          return {
            totalOperations: operations.length,
            offset,
            limit,
            operations: operations.slice(offset, offset + limit).map((operation) => ({
              operationId: operation.operationId,
              restorePointId: operation.restorePointId,
              rescuePointId: operation.rescuePointId,
              state: operation.state,
              startedAt: operation.startedAt,
              pathCount: operation.paths.length,
              pathsPreview: operation.paths.slice(0, RECOVERY_PATH_PREVIEW),
              pathsTruncated: operation.paths.length > RECOVERY_PATH_PREVIEW,
              ...(operation.error === undefined ? {} : { error: truncateText(operation.error) }),
              ...(operation.rollbackError === undefined ? {} : { rollbackError: truncateText(operation.rollbackError) }),
            })),
            hasMore: offset + limit < operations.length,
          }
        },
      }),
    ]

    const disposeApprovalGate = harness.on('tools/pre-execute', async (exec, next) => {
      if (exec.name === 'change_ledger_apply_restore') {
        return { kind: 'ask', reason: 'Apply the reviewed workspace restore plan after creating a rescue point.' }
      }
      if (exec.name === 'change_ledger_delete') {
        return { kind: 'ask', reason: 'Permanently delete a change-ledger restore point and unreferenced blobs.' }
      }
      return next()
    })

    return () => {
      disposeApprovalGate()
      for (const dispose of disposers.reverse()) dispose()
    }
  })
}

function executionWorkspace(exec: ToolRunContextLike): { readonly cwd: string; readonly sessionId: string } {
  const agent = exec.agent
  if (agent === undefined) throw new ChangeLedgerError('AGENT_REQUIRED', 'change-ledger tools require a calling DSH agent')
  const cwd = agent.session.header.cwd
  if (cwd === undefined) throw new ChangeLedgerError('WORKSPACE_REQUIRED', 'the calling session has no working directory')
  return { cwd, sessionId: agent.id }
}

function objectArgs(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChangeLedgerError('INVALID_ARGUMENTS', 'tool arguments must be an object')
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new ChangeLedgerError('INVALID_ARGUMENTS', `${name} must be a non-empty string`)
  return value
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, name)
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new ChangeLedgerError('INVALID_ARGUMENTS', `${name} must be a boolean`)
  return value
}

function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new ChangeLedgerError('INVALID_ARGUMENTS', `${name} must be an array`)
  return value.map((entry, index) => requiredString(entry, `${name}[${index}]`))
}

function optionalNonNegativeInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ChangeLedgerError('INVALID_ARGUMENTS', `${name} must be a non-negative safe integer`)
  }
  return value as number
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ChangeLedgerError('INVALID_ARGUMENTS', `${name} must be a positive safe integer`)
  }
  return value as number
}

function simplifyChange(change: { readonly path: string; readonly kind: string; readonly before?: { readonly kind: string }; readonly after?: { readonly kind: string } }) {
  return {
    path: change.path,
    kind: change.kind,
    ...(change.before === undefined ? {} : { beforeType: change.before.kind }),
    ...(change.after === undefined ? {} : { afterType: change.after.kind }),
  }
}

function countChangeKinds(changes: readonly { readonly kind: string }[]): Record<string, number> {
  const counts: Record<string, number> = Object.create(null) as Record<string, number>
  for (const change of changes) counts[change.kind] = (counts[change.kind] ?? 0) + 1
  return counts
}

function formatValue(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function truncateText(value: string): string {
  if (value.length <= MAX_DIAGNOSTIC_TEXT) return value
  return `${value.slice(0, MAX_DIAGNOSTIC_TEXT)}...`
}
