import assert from 'node:assert/strict'
import test from 'node:test'
import { hashTree } from '../lib/snapshot.js'
import { parseManifest } from '../lib/validate.js'

const base = {
  version: 1,
  id: 'rp_test_0123456789ab',
  kind: 'turn',
  workspace: '/tmp/turn-rewind-workspace',
  repository: {
    root: '/tmp/turn-rewind-workspace',
    commonDir: '/tmp/turn-rewind-workspace/.git',
    stagedPaths: [],
  },
  sessionId: 'session-test',
  turn: 1,
  createdAt: 1,
  treeHash: hashTree({}),
  fileCount: 0,
  totalBytes: 0,
  entries: {},
  restoreCount: 0,
}

test('turn manifests accept exactly one prompt or legacy turn boundary', () => {
  assert.equal(parseManifest({ ...base, turnStartSeq: 2 }).turnStartSeq, 2)
  assert.equal(parseManifest({ ...base, turnEndSeq: 8 }).turnEndSeq, 8)
  assert.throws(() => parseManifest(base), /exactly one turn boundary/)
  assert.throws(() => parseManifest({ ...base, turnStartSeq: 2, turnEndSeq: 8 }), /exactly one turn boundary/)
})

test('non-turn manifests reject every turn boundary field', () => {
  assert.throws(() => parseManifest({
    ...base,
    kind: 'user',
    turn: undefined,
    turnStartSeq: 2,
  }), /only turn restore points/)
})
