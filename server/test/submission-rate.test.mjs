import assert from 'node:assert/strict'
import test from 'node:test'

import { decideSubmissionRate, SUBMISSION_WINDOW_SECONDS } from '../lib/submission-rate.mjs'

const NOW = '2026-08-01T00:01:00Z'

test('submission rate admits an identity with no recent batch', () => {
  assert.deepEqual(
    decideSubmissionRate({ now: NOW, submitter: { count: 0, oldest: null }, session: { count: 0, oldest: null } }),
    { allowed: true, retryAfterSeconds: null },
  )
})

test('submission rate uses the stricter of the submitter and session dimensions', () => {
  const result = decideSubmissionRate({
    now: NOW,
    submitter: { count: 1, oldest: '2026-08-01T00:00:40Z' },
    session: { count: 1, oldest: '2026-08-01T00:00:55Z' },
  })
  assert.equal(result.allowed, false)
  assert.equal(result.retryAfterSeconds, 55)
})

test('the window boundary is allowed and the retry value is whole seconds', () => {
  assert.equal(SUBMISSION_WINDOW_SECONDS, 60)
  assert.deepEqual(
    decideSubmissionRate({
      now: '2026-08-01T00:01:40Z',
      submitter: { count: 1, oldest: '2026-08-01T00:00:40Z' },
      session: { count: 0, oldest: null },
    }),
    { allowed: true, retryAfterSeconds: null },
  )
})
