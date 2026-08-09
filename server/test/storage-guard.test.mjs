import assert from 'node:assert/strict'
import test from 'node:test'

import { createStorageGuard, STORAGE_RESERVE_BYTES, decideStorage } from '../lib/storage-guard.mjs'

test('storage admission leaves the hard reserve plus in-flight worst case untouched', () => {
  assert.equal(STORAGE_RESERVE_BYTES, 256 * 1024 * 1024)
  assert.deepEqual(
    decideStorage({ availableBytes: 300 * 1024 * 1024, inflightBytes: 0 }),
    { allowed: true, reason: null },
  )
  assert.deepEqual(
    decideStorage({ availableBytes: STORAGE_RESERVE_BYTES + 10, inflightBytes: 10 }),
    { allowed: false, reason: 'storage_exhausted' },
  )
  assert.deepEqual(
    decideStorage({ availableBytes: STORAGE_RESERVE_BYTES + 11, inflightBytes: 10 }),
    { allowed: true, reason: null },
  )
})

test('unreadable storage statistics fail closed', () => {
  assert.deepEqual(
    decideStorage({ availableBytes: Number.NaN, inflightBytes: 1 }),
    { allowed: false, reason: 'storage_unreadable' },
  )
})

test('a refused reservation records the last refusal and an accepted one tracks in-flight bytes', async () => {
  let availableBytes = STORAGE_RESERVE_BYTES
  const guard = createStorageGuard({
    dataDir: '/test-only',
    now: () => new Date('2026-08-01T00:00:00Z'),
    readStats: async () => ({ totalBytes: 1_000, usedBytes: 0, availableBytes }),
  })

  const refused = await guard.reserve(0)
  assert.equal(refused.allowed, false)
  assert.equal((await guard.snapshot()).lastRefusalAt, '2026-08-01T00:00:00Z')

  availableBytes = STORAGE_RESERVE_BYTES + 10
  const accepted = await guard.reserve(10)
  assert.equal(accepted.allowed, false, 'reserve plus in-flight is an equality refusal')
  availableBytes = STORAGE_RESERVE_BYTES + 11
  const admitted = await guard.reserve(10)
  assert.equal(admitted.allowed, true)
  assert.equal((await guard.snapshot()).inflightBytes, 10)
  guard.release(10)
  assert.equal((await guard.snapshot()).inflightBytes, 0)
})
