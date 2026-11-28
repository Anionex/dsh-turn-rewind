import assert from 'node:assert/strict'
import test from 'node:test'
import { archiveSourceSession, chooseForkPoint, findCompactionBoundary, surfaceBytes } from '../lib/rewind-host.js'

/** One canonical event with a deterministic payload size. */
function event(seq, type, data = {}) {
  return { type, seq, time: seq, data }
}

/** A compaction summary followed by its replacement user message. */
function compacted(seq, summaryChars) {
  return [
    event(seq, 'compaction/summary', { compactionId: 'c', summary: [{ type: 'text', text: 'x'.repeat(summaryChars) }] }),
    event(seq + 1, 'user/message', { source: { kind: 'compaction' }, content: [{ type: 'text', text: `<compacted-summary>${'x'.repeat(summaryChars)}</compacted-summary>` }] }),
    event(seq + 2, 'compaction/end', { compactionId: 'c' }),
  ]
}

test('findCompactionBoundary reports the latest summary and its replacement', () => {
  const events = [
    event(1, 'system/message'),
    ...compacted(10, 10),
    ...compacted(100, 10),
    event(200, 'turn/end'),
  ]
  assert.deepEqual(findCompactionBoundary(events, 200), { summarySeq: 100, replacementSeq: 101 })
  assert.deepEqual(findCompactionBoundary(events, 100), { summarySeq: 100, replacementSeq: 101 })
  assert.deepEqual(findCompactionBoundary(events, 90), { summarySeq: 10, replacementSeq: 11 })
  assert.equal(findCompactionBoundary(events, 9), undefined)
})

test('surfaceBytes sums only the requested inclusive span', () => {
  const events = [event(1, 'a'), event(2, 'b', { text: 'y'.repeat(1000) }), event(3, 'c')]
  assert.ok(surfaceBytes(events, 2, 2) >= 1000)
  assert.equal(surfaceBytes(events, 4, 5), 0)
  assert.ok(surfaceBytes(events, 0, 3) > surfaceBytes(events, 2, 2))
})

test('surfaceBytes counts inline image bytes, not just the reference', () => {
  const events = [
    event(1, 'user/message', {
      content: [
        { type: 'image', attachment: { attachmentId: 'sha256:x', mediaType: 'image/png', bytes: 900_000 } },
        { type: 'text', text: 'hello' },
      ],
    }),
  ]
  const bytes = surfaceBytes(events, 1, 1)
  assert.ok(bytes >= 1_200_000, `expected base64-inflated estimate, got ${bytes}`)
})

test('a small prefix keeps the requested turn boundary', () => {
  const events = [...compacted(1, 10), event(10, 'turn/end')]
  assert.deepEqual(chooseForkPoint(events, 10, 11), { seq: 10, compacted: false, skippedEvents: 0 })
})

test('an oversized compacted prefix forks from the compaction replacement', () => {
  const big = 'z'.repeat(1024 * 1024)
  const events = [
    ...compacted(1, 10),
    ...Array.from({ length: 7 }, (_, index) => event(10 + index, 'assistant/message', { text: big })),
    event(20, 'turn/end'),
  ]
  const point = chooseForkPoint(events, 20, 21)
  assert.equal(point.compacted, true)
  assert.equal(point.seq, 2)
  assert.equal(point.skippedEvents, 9)
})

test('a compaction between the boundary and the message is still forkable', () => {
  const big = 'z'.repeat(1024 * 1024)
  const events = [
    ...Array.from({ length: 7 }, (_, index) => event(index + 1, 'assistant/message', { text: big })),
    event(10, 'turn/end'),
    ...compacted(100, 10),
    event(110, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] }),
  ]
  const point = chooseForkPoint(events, 10, 110)
  assert.equal(point.compacted, true)
  assert.equal(point.seq, 101)
  assert.equal(point.skippedEvents, 0)
})

test('an oversized prefix without compaction is rejected with SESSION_TOO_LARGE', () => {
  const big = 'z'.repeat(1024 * 1024)
  const events = Array.from({ length: 7 }, (_, index) => event(index + 1, 'assistant/message', { text: big }))
  assert.throws(
    () => chooseForkPoint(events, events.length, events.length + 1),
    error => error?.code === 'SESSION_TOO_LARGE',
  )
})

test('the source session is archived after a successful rewind fork', async () => {
  const calls = []
  const ctx = {
    get: name => name === 'workspaceRegistry'
      ? { archiveSession: async id => { calls.push(id) } }
      : undefined,
  }
  assert.equal(await archiveSourceSession(ctx, 'session-a'), true)
  assert.deepEqual(calls, ['session-a'])
})

test('a missing or rejecting archive is reported, never thrown', async () => {
  assert.equal(await archiveSourceSession({ get: () => undefined }, 'session-a'), false)
  assert.equal(await archiveSourceSession({ get: () => ({ archiveSession: async () => { throw new Error('still running') } }) }, 'session-a'), false)
})
