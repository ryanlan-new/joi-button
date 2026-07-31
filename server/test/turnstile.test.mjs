// When a challenge is demanded, and what happens to the answer.
//
// The defect at the centre of this file is a phantom field: the trust rule read
// `submitter.blockedUntil`, a name submitters has no column for. In JavaScript
// that is `undefined` on every call, so the rule never fired and a BLOCKED
// submitter with a good history was waved through by the rule written to stop
// exactly that. Nothing reports a misspelt field, which is why every field a
// rule reads is now checked for presence before any rule runs.

import assert from 'node:assert/strict'
import test from 'node:test'

import { REQUIRED_REASONS, VERIFY_REASONS, createTurnstile } from '../lib/turnstile.mjs'
import { clearedConfig } from './helpers/config.mjs'

const okResponse = (payload = { success: true }) => ({
  ok: true,
  status: 200,
  json: async () => payload,
})

function productionTurnstile(overrides = {}) {
  return createTurnstile({
    mode: 'production',
    secretKey: 'secret-key',
    verifyUrl: 'https://example.invalid/siteverify',
    fetchImpl: async () => okResponse(),
    ...overrides,
  })
}

const GOOD_HISTORY = { acceptedCount: 9, rejectedCount: 0, blocked: 0 }
const QUIET_HOUR = { submissions: 0, windowMinutes: 60 }

// ---------------------------------------------------------------------------
// required()

test('a BLOCKED submitter with a spotless history is still challenged', () => {
  const turnstile = productionTurnstile()

  const verdict = turnstile.required({
    submitter: { acceptedCount: 9, rejectedCount: 0, blocked: 1 },
    recent: QUIET_HOUR,
  })

  assert.equal(verdict.required, true, 'a blocked submitter was waved through by the trusted-submitter rule')
  assert.equal(verdict.reason, REQUIRED_REASONS.HISTORY)
  assert.equal(verdict.evidence.blocked, true)
})

test('the SAME submitter without the block flag is challenged for missing evidence, not trusted', () => {
  const turnstile = productionTurnstile()

  // The caller simply did not SELECT the column. Left optional, `blocked` would
  // read as "not blocked" here and the case above would become unreachable for
  // any caller that forgets one column.
  const verdict = turnstile.required({
    submitter: { acceptedCount: 9, rejectedCount: 0 },
    recent: QUIET_HOUR,
  })

  assert.equal(verdict.required, true)
  assert.equal(verdict.reason, REQUIRED_REASONS.INSUFFICIENT_EVIDENCE)
  assert.deepEqual(verdict.evidence.missing, ['submitter.blocked'])
})

test('a submitter with the block flag actually selected and clear is trusted, which is what makes the two cases above differ', () => {
  const turnstile = productionTurnstile()

  const verdict = turnstile.required({ submitter: GOOD_HISTORY, recent: QUIET_HOUR })
  assert.equal(verdict.required, false)
  assert.equal(verdict.reason, REQUIRED_REASONS.TRUSTED)
  assert.equal(verdict.evidence.acceptedCount, 9)
})

test('booleans are accepted for `blocked` too, since a caller that maps its rows may have converted already', () => {
  const turnstile = productionTurnstile()

  assert.equal(
    turnstile.required({ submitter: { ...GOOD_HISTORY, blocked: false }, recent: QUIET_HOUR }).reason,
    REQUIRED_REASONS.TRUSTED,
  )
  assert.equal(
    turnstile.required({ submitter: { ...GOOD_HISTORY, blocked: true }, recent: QUIET_HOUR }).reason,
    REQUIRED_REASONS.HISTORY,
  )
  // Anything else is not evidence.
  for (const value of ['0', 'false', null, 2]) {
    assert.equal(
      turnstile.required({ submitter: { ...GOOD_HISTORY, blocked: value }, recent: QUIET_HOUR }).reason,
      REQUIRED_REASONS.INSUFFICIENT_EVIDENCE,
      `blocked = ${JSON.stringify(value)} was read as evidence`,
    )
  }
})

test('a trusted submitter who suddenly uploads forty clips in the window is still challenged', () => {
  const turnstile = productionTurnstile()

  // Order is the whole semantics of a first-match-wins list: the rate rule sits
  // above the trust rule precisely because trust should not be the deciding
  // fact here.
  const verdict = turnstile.required({
    submitter: GOOD_HISTORY,
    recent: { submissions: 40, windowMinutes: 60 },
  })
  assert.equal(verdict.required, true)
  assert.equal(verdict.reason, REQUIRED_REASONS.RATE)
  assert.deepEqual(verdict.evidence, { submissions: 40, windowMinutes: 60, threshold: 3 })
})

test('a count taken over a SHORTER window than the policy asks about is insufficient evidence', () => {
  const turnstile = productionTurnstile()

  const verdict = turnstile.required({ submitter: GOOD_HISTORY, recent: { submissions: 0, windowMinutes: 1 } })
  assert.equal(verdict.required, true)
  assert.equal(verdict.reason, REQUIRED_REASONS.INSUFFICIENT_EVIDENCE)
  assert.match(verdict.evidence.missing[0], /shorter than the policy window \(60\)/)

  // A longer window over-reports, which only over-challenges, so it is allowed.
  assert.equal(
    turnstile.required({ submitter: GOOD_HISTORY, recent: { submissions: 0, windowMinutes: 1440 } }).reason,
    REQUIRED_REASONS.TRUSTED,
  )
})

test('absent evidence is never a pass: every missing field is named in one answer', () => {
  const turnstile = productionTurnstile()

  const verdict = turnstile.required({})
  assert.equal(verdict.required, true)
  assert.equal(verdict.reason, REQUIRED_REASONS.INSUFFICIENT_EVIDENCE)
  assert.deepEqual(verdict.evidence.missing, ['submitter', 'recent'])

  const partial = turnstile.required({ submitter: {}, recent: {} })
  assert.deepEqual(partial.evidence.missing, [
    'submitter.acceptedCount',
    'submitter.rejectedCount',
    'submitter.blocked',
    'recent.submissions',
    'recent.windowMinutes',
  ])
})

test('a submitter who has never had anything accepted is challenged', () => {
  const turnstile = productionTurnstile()

  const verdict = turnstile.required({
    submitter: { acceptedCount: 0, rejectedCount: 0, blocked: 0 },
    recent: QUIET_HOUR,
  })
  assert.equal(verdict.required, true)
  assert.equal(verdict.reason, REQUIRED_REASONS.HISTORY)
})

test('the operator switch is read first, and its two settings are told apart in the answer', () => {
  const always = productionTurnstile({ switch: 'always' })
  const off = productionTurnstile({ switch: 'off' })

  const demanded = always.required({ submitter: GOOD_HISTORY, recent: QUIET_HOUR })
  assert.equal(demanded.required, true)
  assert.equal(demanded.reason, REQUIRED_REASONS.SWITCH_ALWAYS)

  // 'off' is a kill switch and not a fake verdict — and it must not be
  // reachable by accident, so it is reported as its own reason.
  const skipped = off.required({ submitter: { acceptedCount: 0, rejectedCount: 9, blocked: 1 }, recent: QUIET_HOUR })
  assert.equal(skipped.required, false)
  assert.equal(skipped.reason, REQUIRED_REASONS.SWITCH_OFF)
})

test('describePolicy() reports the rules in the order they are actually evaluated', () => {
  const turnstile = productionTurnstile()
  assert.deepEqual(
    turnstile.policy().map((rule) => rule.rule),
    ['switch', 'evidence', 'rate', 'history', 'trusted', 'default'],
  )
})

// ---------------------------------------------------------------------------
// verify()

test('a token is burned at RESERVATION, so two concurrent verifies of one token cannot both pass', async () => {
  let releaseGate
  const gate = new Promise((resolve) => {
    releaseGate = resolve
  })
  let calls = 0
  const turnstile = productionTurnstile({
    fetchImpl: async () => {
      calls += 1
      await gate
      return okResponse()
    },
  })

  // Both are in flight at once. That window is exactly what a replay is; marking
  // the token after a successful response would let both through.
  const first = turnstile.verify('token-abc')
  const second = turnstile.verify('token-abc')
  releaseGate()
  const [a, b] = await Promise.all([first, second])

  assert.equal(a.ok, true)
  assert.equal(a.reason, VERIFY_REASONS.OK)
  assert.equal(b.ok, false)
  assert.equal(b.reason, VERIFY_REASONS.REPLAYED)
  assert.equal(calls, 1, 'the replay reached siteverify, so it was caught after the network call and not before it')
})

test('verify fails CLOSED when siteverify cannot be reached or answers non-2xx', async () => {
  const thrown = productionTurnstile({
    fetchImpl: async () => {
      throw Object.assign(new Error('connect ETIMEDOUT'), { name: 'TimeoutError' })
    },
  })
  const timedOut = await thrown.verify('token-1')
  assert.equal(timedOut.ok, false, 'a challenge you cannot verify is a challenge that is not there')
  assert.equal(timedOut.reason, VERIFY_REASONS.UNREACHABLE)
  assert.deepEqual(timedOut.errorCodes, ['timeout'])

  const failing = productionTurnstile({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) })
  const unavailable = await failing.verify('token-2')
  assert.equal(unavailable.ok, false)
  assert.equal(unavailable.reason, VERIFY_REASONS.UNREACHABLE)
  assert.deepEqual(unavailable.errorCodes, ['http-503'])
})

test("Cloudflare's own duplicate report lands on the same reason as the local map", async () => {
  const turnstile = productionTurnstile({
    fetchImpl: async () => okResponse({ success: false, 'error-codes': ['timeout-or-duplicate'] }),
  })
  const verdict = await turnstile.verify('token-1')
  assert.equal(verdict.reason, VERIFY_REASONS.REPLAYED)
})

test('a missing or oversized token is refused without a network call', async () => {
  let calls = 0
  const turnstile = productionTurnstile({
    fetchImpl: async () => {
      calls += 1
      return okResponse()
    },
  })

  assert.equal((await turnstile.verify(undefined)).reason, VERIFY_REASONS.MISSING_TOKEN)
  assert.equal((await turnstile.verify('   ')).reason, VERIFY_REASONS.MISSING_TOKEN)
  assert.equal((await turnstile.verify('t'.repeat(2049))).reason, VERIFY_REASONS.MALFORMED_TOKEN)
  assert.equal(calls, 0)
})

test('a hostname or action that does not match the expected one is a refusal, not a warning', async () => {
  const turnstile = productionTurnstile({
    expectedHostname: 'joi.example',
    expectedAction: 'submit',
    fetchImpl: async () => okResponse({ success: true, hostname: 'evil.example', action: 'submit' }),
  })
  const verdict = await turnstile.verify('token-1')
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, VERIFY_REASONS.HOSTNAME_MISMATCH)
  assert.equal(verdict.hostname, 'evil.example')
})

test('a development verdict can never be mistaken for a real one', async () => {
  const { config } = clearedConfig()
  const turnstile = createTurnstile(config.turnstile)

  const verdict = await turnstile.verify('anything-at-all')
  assert.equal(verdict.ok, true)
  assert.equal(verdict.mode, 'development')
  assert.equal(verdict.simulated, true, 'a caller that never looks at `reason` must still be unable to read this as real')
  assert.equal(verdict.reason, VERIFY_REASONS.DEVELOPMENT_BYPASS)
})

test('a production verdict is never marked simulated', async () => {
  const verdict = await productionTurnstile().verify('token-1')
  assert.equal(verdict.simulated, false)
  assert.equal(verdict.mode, 'production')
})

test('the development verifier can be told to fail, so the caller\'s rejection branch is reachable before production', async () => {
  const { config } = clearedConfig({
    turnstile: { mode: 'development', switch: 'auto', development: { simulate: VERIFY_REASONS.REJECTED } },
  })
  const turnstile = createTurnstile(config.turnstile)

  const verdict = await turnstile.verify('anything-at-all')
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, VERIFY_REASONS.REJECTED)
  assert.equal(verdict.simulated, true)
})

test('production mode demands a secret key at construction rather than at the first challenge', () => {
  assert.throws(() => createTurnstile({ mode: 'production' }), /production mode needs config\.secretKey/)
  assert.throws(() => createTurnstile({}), /config\.mode must be "production" or "development"/)
})
