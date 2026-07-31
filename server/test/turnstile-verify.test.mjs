// The production siteverify path: what Cloudflare actually says, and what this
// server does about each thing it says.
//
// Every case here runs with NO network and NO secret. The only reason that is
// possible is config.fetchImpl, which env-guard lists as a refuse-severity
// bypass — so these tests are also the reason that flag exists, and the reason
// it must stay refused in production.
//
// TWO DISTINCTIONS THIS FILE EXISTS TO HOLD:
//
//   1. "Cloudflare said no" is a statement about a visitor. "Cloudflare did not
//      answer" is a statement about a network and says nothing about the person
//      holding the token. A suite that only checks `ok === false` cannot tell
//      them apart, and neither can the operator reading the logs afterwards.
//
//   2. `ok` means Cloudflare confirmed this token — under EVERY posture. The
//      'review' posture moves `disposition`, never `ok`. If those two ever fuse,
//      one config key silently starts admitting unverified submissions, and the
//      case named for it here goes red.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SITEVERIFY_ERROR_CODES,
  SYNTHETIC_ERROR_CODES,
  TURNSTILE_DEFAULTS,
  UNREACHABLE_POSTURES,
  VERIFY_DISPOSITIONS,
  VERIFY_REASONS,
  createTurnstile,
} from '../lib/turnstile.mjs'

const T0 = '2026-08-01T00:00:00Z'
const frozenClock = (iso = T0) => () => new Date(iso)

/** A siteverify 200 with a JSON body, which is what Cloudflare answers with. */
function answers(payload, { headers } = {}) {
  return async () => ({ ok: true, status: 200, headers, json: async () => payload })
}

function turnstile(overrides = {}) {
  return createTurnstile({
    mode: 'production',
    secretKey: 'secret-key',
    verifyUrl: 'https://example.invalid/siteverify',
    now: frozenClock(),
    fetchImpl: answers({ success: true }),
    ...overrides,
  })
}

/** Unique per call: the local single-use map is per instance, not per test. */
let tokenCounter = 0
const freshToken = () => `token-${(tokenCounter += 1)}`

const failsWith = (...codes) => answers({ success: false, 'error-codes': codes })

// ---------------------------------------------------------------------------
// The documented error codes, one branch each

// The complete table from
// developers.cloudflare.com/turnstile/get-started/server-side-validation/,
// read 2026-08-01. Written out here rather than derived from the module, so
// that the module and the documentation are two independent statements: a code
// quietly added to or dropped from SITEVERIFY_ERROR_CODES fails this, which is
// the only thing standing between "we handle the documented set" and a comment
// that used to be true.
const DOCUMENTED_CODES = [
  'missing-input-secret',
  'invalid-input-secret',
  'missing-input-response',
  'invalid-input-response',
  'bad-request',
  'timeout-or-duplicate',
  'internal-error',
]

test('the handled set is exactly the set Cloudflare documents — no more, no fewer', () => {
  assert.deepEqual(Object.keys(SITEVERIFY_ERROR_CODES).sort(), [...DOCUMENTED_CODES].sort())
})

test('invalid-input-secret is an OPERATOR error: loud, and not the visitor being told they failed', async () => {
  const verdict = await turnstile({ fetchImpl: failsWith('invalid-input-secret') }).verify(freshToken())

  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, VERIFY_REASONS.MISCONFIGURED)
  assert.equal(verdict.operatorAlert, true, 'a wrong secret fails every challenge for everyone until a human fixes it')
  // Not degraded: Cloudflare answered perfectly well. The problem is ours.
  assert.equal(verdict.degraded, false)
  assert.deepEqual(verdict.errorCodes, ['invalid-input-secret'])
})

test('missing-input-secret is the same class of problem and reads the same way', async () => {
  const verdict = await turnstile({ fetchImpl: failsWith('missing-input-secret') }).verify(freshToken())
  assert.equal(verdict.reason, VERIFY_REASONS.MISCONFIGURED)
  assert.equal(verdict.operatorAlert, true)
})

test('bad-request and missing-input-response are OUR request being wrong, which is a different fix from a bad secret', async () => {
  for (const code of ['bad-request', 'missing-input-response']) {
    const verdict = await turnstile({ fetchImpl: failsWith(code) }).verify(freshToken())
    assert.equal(verdict.reason, VERIFY_REASONS.MALFORMED_REQUEST, code)
    assert.equal(verdict.operatorAlert, true, code)
    // verify() refuses an empty token before it posts, so missing-input-response
    // cannot be a visitor sending nothing — it is this file's encoding.
    assert.equal(verdict.degraded, false, code)
  }
})

test('timeout-or-duplicate means the token was ALREADY SPENT, which is a different thing to tell a visitor than "invalid"', async () => {
  const spent = await turnstile({ fetchImpl: failsWith('timeout-or-duplicate') }).verify(freshToken())
  const invalid = await turnstile({ fetchImpl: failsWith('invalid-input-response') }).verify(freshToken())

  assert.equal(spent.reason, VERIFY_REASONS.REPLAYED, 'solve the challenge again')
  assert.equal(invalid.reason, VERIFY_REASONS.REJECTED, 'the challenge was not solved')
  assert.notEqual(spent.reason, invalid.reason, 'the two are collapsed onto one message')
  // Both are real answers about a real token, so neither is degraded and neither
  // is anybody's fault but the visitor's browser.
  assert.equal(spent.degraded, false)
  assert.equal(spent.operatorAlert, false)
  assert.equal(invalid.degraded, false)
})

test('internal-error is Cloudflare failing to DECIDE, not the visitor failing', async () => {
  const verdict = await turnstile({ fetchImpl: failsWith('internal-error') }).verify(freshToken())

  assert.equal(verdict.reason, VERIFY_REASONS.UNREACHABLE)
  assert.equal(verdict.degraded, true, 'a verdict Cloudflare declined to give is not a verdict against the visitor')
  assert.equal(verdict.operatorAlert, false, 'nothing here is ours to fix')
  assert.deepEqual(verdict.errorCodes, ['internal-error'])
})

test('an operator error wins over a token error riding along in the same response', async () => {
  // The table's ORDER is its precedence. With a wrong secret every response can
  // carry invalid-input-secret; answering each visitor "your challenge failed"
  // while that is on the wire turns one broken deploy into an apparent wave of
  // suspicious people.
  const verdict = await turnstile({
    fetchImpl: failsWith('invalid-input-response', 'invalid-input-secret'),
  }).verify(freshToken())

  assert.equal(verdict.reason, VERIFY_REASONS.MISCONFIGURED)
  assert.equal(verdict.operatorAlert, true)
  assert.deepEqual(verdict.errorCodes, ['invalid-input-response', 'invalid-input-secret'], 'both codes are kept verbatim')
})

test('internal-error outranks invalid-input-response: if Cloudflare says it broke, the token is unjudged rather than bad', async () => {
  const verdict = await turnstile({
    fetchImpl: failsWith('invalid-input-response', 'internal-error'),
  }).verify(freshToken())

  assert.equal(verdict.reason, VERIFY_REASONS.UNREACHABLE)
  assert.equal(verdict.degraded, true)
})

test('a code this module has never been taught is refused AND named, not absorbed', async () => {
  const verdict = await turnstile({
    fetchImpl: failsWith('invalid-input-response', 'some-future-code'),
  }).verify(freshToken())

  assert.equal(verdict.reason, VERIFY_REASONS.REJECTED)
  assert.deepEqual(verdict.unrecognizedCodes, ['some-future-code'], 'the day Cloudflare adds a code, the word must survive to the logs')
  assert.deepEqual(verdict.errorCodes, ['invalid-input-response', 'some-future-code'])
})

test('a failure with NO codes at all is still a refusal — Cloudflare declining without saying why', async () => {
  const verdict = await turnstile({ fetchImpl: answers({ success: false }) }).verify(freshToken())

  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, VERIFY_REASONS.REJECTED)
  assert.equal(verdict.degraded, false, 'it answered; it just did not elaborate')
  assert.deepEqual(verdict.errorCodes, [])
})

test('the codes this module invents never collide with the codes Cloudflare defines', () => {
  // A reader of one log line should never have to work out whose vocabulary a
  // code is in.
  for (const code of SYNTHETIC_ERROR_CODES) {
    assert.equal(
      Object.hasOwn(SITEVERIFY_ERROR_CODES, code),
      false,
      `${code} is both a synthetic code and a documented Cloudflare code`,
    )
  }
})

// ---------------------------------------------------------------------------
// Single use

test('a token is spent by ONE attempt: the second never reaches the network', async () => {
  let calls = 0
  const instance = turnstile({
    fetchImpl: async () => {
      calls += 1
      return { ok: true, status: 200, json: async () => ({ success: true }) }
    },
  })
  const token = freshToken()

  const first = await instance.verify(token)
  const second = await instance.verify(token)

  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.equal(second.reason, VERIFY_REASONS.REPLAYED)
  assert.equal(calls, 1, 'the replay was caught after the network call, so a flood of replays is a flood of siteverify calls')
  // Our own refusal, made without asking anyone: sound, and therefore not
  // degraded. Only a verdict reached WITHOUT an answer is degraded.
  assert.equal(second.degraded, false)
  assert.equal(second.disposition, VERIFY_DISPOSITIONS.REJECT)
})

test('a token spent on a call that FAILED is still spent — reservation, not success', async () => {
  let calls = 0
  const instance = turnstile({
    fetchImpl: async () => {
      calls += 1
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    },
  })
  const token = freshToken()

  const first = await instance.verify(token)
  const second = await instance.verify(token)

  assert.equal(first.reason, VERIFY_REASONS.UNREACHABLE)
  assert.equal(second.reason, VERIFY_REASONS.REPLAYED, 'a token we have already sent must be treated as spent')
  assert.equal(calls, 1)
})

test('the local map is PER INSTANCE — a second process is not covered, and that is Cloudflare\'s job', async () => {
  // Two instances stand in for two pods behind one domain. The same token is
  // unknown to the second one, and only Cloudflare's timeout-or-duplicate
  // catches it there. This is not a bug being tolerated, it is the boundary of
  // what an in-memory Map can promise, measured rather than asserted in prose.
  const podA = turnstile()
  const podB = turnstile({ fetchImpl: failsWith('timeout-or-duplicate') })
  const token = freshToken()

  assert.equal((await podA.verify(token)).ok, true)
  const onTheOtherPod = await podB.verify(token)
  assert.equal(onTheOtherPod.reason, VERIFY_REASONS.REPLAYED, 'the cross-process authority is the one that caught it')
  assert.equal(onTheOtherPod.ok, false)
})

// ---------------------------------------------------------------------------
// The timeout

/** Hangs until the caller's signal aborts. Without a signal it hangs forever. */
function hangingFetch(seen = []) {
  return async (url, init) => {
    seen.push(init)
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason))
    })
  }
}

// The `timeout` here is not belt and braces: the way this case goes red is that
// the fetch is started WITHOUT a signal, and an unbounded call against a peer
// that never answers does not fail, it hangs. Without a deadline the suite would
// report nothing at all, which is the same absence of a signal one level up.
test('a peer that never answers is bounded, and the bound is configurable', { timeout: 5_000 }, async () => {
  const seen = []
  const instance = turnstile({ fetchImpl: hangingFetch(seen), limits: { timeoutMs: 25 } })

  const started = Date.now()
  const verdict = await instance.verify(freshToken())
  const elapsed = Date.now() - started

  assert.equal(verdict.reason, VERIFY_REASONS.UNREACHABLE)
  assert.deepEqual(verdict.errorCodes, ['timeout'])
  assert.equal(verdict.degraded, true)
  // If the signal were not passed to fetch, this promise would never settle and
  // the case would fail by timing out rather than by asserting.
  assert.ok(seen[0].signal instanceof AbortSignal, 'the fetch was started without a bound')
  assert.ok(elapsed < 2_000, `the configured 25ms bound was not honoured (took ${elapsed}ms)`)
})

test('the default bound is a small number of seconds, not "eventually"', () => {
  assert.ok(TURNSTILE_DEFAULTS.timeoutMs > 0 && TURNSTILE_DEFAULTS.timeoutMs <= 10_000)
})

test('the bound covers the BODY too, and a body cut short reports the timeout rather than a parse error', { timeout: 5_000 }, async () => {
  const instance = turnstile({
    limits: { timeoutMs: 25 },
    fetchImpl: async (url, init) => ({
      ok: true,
      status: 200,
      // Headers arrived; the body then stops. Reported as 'unparseable-body'
      // this sends an operator to read Cloudflare's JSON, which is fine.
      json: () =>
        new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason))
        }),
    }),
  })

  const verdict = await instance.verify(freshToken())
  assert.equal(verdict.reason, VERIFY_REASONS.UNREACHABLE)
  assert.deepEqual(verdict.errorCodes, ['timeout'], 'a timeout during the body read was reported as a malformed answer')
})

// ---------------------------------------------------------------------------
// The unreachable posture

const TRANSPORT_FAILURES = [
  ['a DNS failure', async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) }, 'ENOTFOUND'],
  ['a reset connection', async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }, 'ECONNRESET'],
  ['a timeout', async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }) }, 'timeout'],
  ['a 503', async () => ({ ok: false, status: 503, json: async () => ({}) }), 'http-503'],
]

test('the DEFAULT posture is fail closed, and the verdict records which path it took', async () => {
  for (const [what, fetchImpl, code] of TRANSPORT_FAILURES) {
    const verdict = await turnstile({ fetchImpl }).verify(freshToken())

    assert.equal(verdict.ok, false, what)
    assert.equal(verdict.disposition, VERIFY_DISPOSITIONS.REJECT, what)
    assert.equal(verdict.posture, UNREACHABLE_POSTURES.CLOSED, `${what}: the default posture moved`)
    assert.equal(verdict.degraded, true, `${what}: an unanswered call is not a failed challenge`)
    assert.deepEqual(verdict.errorCodes, [code], what)
    // The record a stored submission needs: not merely "it did not pass", but
    // that nobody was asked, when, and why not.
    assert.equal(verdict.checkedAt, T0, what)
    assert.equal(verdict.reason, VERIFY_REASONS.UNREACHABLE, what)
  }
})

test('Node\'s own transport codes are passed through rather than flattened, because ENOTFOUND and ECONNRESET are different diagnoses', async () => {
  const dns = await turnstile({ fetchImpl: TRANSPORT_FAILURES[0][1] }).verify(freshToken())
  const reset = await turnstile({ fetchImpl: TRANSPORT_FAILURES[1][1] }).verify(freshToken())
  assert.notDeepEqual(dns.errorCodes, reset.errorCodes)
})

test('the "review" posture changes the DISPOSITION and never the ok flag', async () => {
  const instance = turnstile({
    onUnreachable: UNREACHABLE_POSTURES.REVIEW,
    fetchImpl: TRANSPORT_FAILURES[1][1],
  })
  const verdict = await instance.verify(freshToken())

  // This is the whole safety property of the knob: routes/public.mjs branches on
  // `ok`, so turning the posture on cannot admit anything by itself. Fuse the
  // two and one config key silently starts accepting unverified submissions.
  assert.equal(verdict.ok, false, 'the review posture turned an unanswered call into a pass')
  assert.equal(verdict.disposition, VERIFY_DISPOSITIONS.REVIEW)
  assert.equal(verdict.posture, UNREACHABLE_POSTURES.REVIEW)
  assert.equal(verdict.degraded, true)
})

test('the "review" posture does NOT launder a real rejection', async () => {
  // Only an unanswered call may be admitted for review. A token Cloudflare
  // looked at and refused is refused under every posture, or the posture is not
  // a degradation policy, it is an off switch wearing one.
  const instance = turnstile({
    onUnreachable: UNREACHABLE_POSTURES.REVIEW,
    fetchImpl: failsWith('invalid-input-response'),
  })
  const verdict = await instance.verify(freshToken())

  assert.equal(verdict.reason, VERIFY_REASONS.REJECTED)
  assert.equal(verdict.disposition, VERIFY_DISPOSITIONS.REJECT)
})

test('internal-error takes the posture too, since it is the same fact as a timeout', async () => {
  const instance = turnstile({
    onUnreachable: UNREACHABLE_POSTURES.REVIEW,
    fetchImpl: failsWith('internal-error'),
  })
  assert.equal((await instance.verify(freshToken())).disposition, VERIFY_DISPOSITIONS.REVIEW)
})

test('a posture that is neither is refused at construction, not defaulted', async () => {
  // 'open' is the obvious thing to write and means nothing here. Read as
  // 'closed', an operator who believed they had chosen a posture chose nothing.
  assert.throws(
    () => turnstile({ onUnreachable: 'open' }),
    /config\.onUnreachable must be "closed" or "review"/,
  )
  assert.throws(() => turnstile({ onUnreachable: 'Closed' }), /must be "closed" or "review"/)
})

test('a 4xx says a human must look; a 5xx or a 429 does not', async () => {
  // Both are "no answer about this visitor" and both fail closed. The split is
  // about who can fix it: a 400 nobody is told about never gets better.
  const bands = [
    [400, true],
    [403, true],
    [429, false],
    [500, false],
    [503, false],
  ]
  for (const [status, expected] of bands) {
    const verdict = await turnstile({ fetchImpl: async () => ({ ok: false, status, json: async () => ({}) }) })
      .verify(freshToken())
    assert.equal(verdict.operatorAlert, expected, `HTTP ${status}`)
    assert.equal(verdict.degraded, true, `HTTP ${status}`)
    assert.deepEqual(verdict.errorCodes, [`http-${status}`])
  }
})

// ---------------------------------------------------------------------------
// Answers that are not answers

test('a JSON body with no `success` field is DEGRADED, not a failed challenge', async () => {
  // An interception page that happens to be JSON. Read as a rejection, this
  // becomes a claim about a person, made from a body Cloudflare never wrote —
  // and in the network this audience sits behind, that page is a real thing.
  for (const body of [{}, null, [], 'success', { success: 'true' }]) {
    const verdict = await turnstile({ fetchImpl: answers(body) }).verify(freshToken())
    assert.equal(verdict.reason, VERIFY_REASONS.UNREACHABLE, JSON.stringify(body))
    assert.equal(verdict.degraded, true, JSON.stringify(body))
    assert.deepEqual(verdict.errorCodes, ['malformed-response'], JSON.stringify(body))
  }
})

test('a body that is not JSON at all is degraded, and says so distinctly', async () => {
  const verdict = await turnstile({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0')
      },
    }),
  }).verify(freshToken())

  assert.equal(verdict.reason, VERIFY_REASONS.UNREACHABLE)
  assert.deepEqual(verdict.errorCodes, ['unparseable-body'])
})

test('a body announcing megabytes is refused WITHOUT being read', async () => {
  let read = false
  const verdict = await turnstile({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name === 'content-length' ? '9000000' : null) },
      json: async () => {
        read = true
        return { success: true }
      },
    }),
  }).verify(freshToken())

  assert.equal(read, false, 'the oversized body was read in order to find out it was oversized')
  assert.equal(verdict.reason, VERIFY_REASONS.UNREACHABLE)
  assert.deepEqual(verdict.errorCodes, ['oversized-response'])
})

test('a declared length within the limit, or none declared at all, is read normally', async () => {
  const sized = await turnstile({
    fetchImpl: answers({ success: true }, { headers: { get: () => '120' } }),
  }).verify(freshToken())
  assert.equal(sized.ok, true)

  const noHeaders = await turnstile({ fetchImpl: answers({ success: true }) }).verify(freshToken())
  assert.equal(noHeaders.ok, true, 'a response object without headers must not be read as oversized')
})

// ---------------------------------------------------------------------------
// Freshness

const solvedAt = (iso) => answers({ success: true, challenge_ts: iso })

test('a challenge solved longer ago than its life is expired', async () => {
  const verdict = await turnstile({ fetchImpl: solvedAt('2026-07-31T23:50:00Z') }).verify(freshToken())
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, VERIFY_REASONS.EXPIRED)
  assert.equal(verdict.challengeTs, '2026-07-31T23:50:00Z')
  assert.equal(verdict.degraded, false, 'we know exactly what happened here')
})

test('a challenge solved moments ago passes', async () => {
  const verdict = await turnstile({ fetchImpl: solvedAt('2026-07-31T23:59:30Z') }).verify(freshToken())
  assert.equal(verdict.ok, true)
  assert.equal(verdict.reason, VERIFY_REASONS.OK)
})

test('an unreadable challenge_ts is degraded — a check that cannot fire is worse than no check', async () => {
  // Guarding on Number.isFinite(age) instead of on the parse makes every
  // comparison false, so the freshness check runs and can never say no. That is
  // the phantom-field defect this module was rebuilt around, one field over.
  const verdict = await turnstile({ fetchImpl: solvedAt('not-a-date') }).verify(freshToken())

  assert.equal(verdict.ok, false, 'a timestamp we cannot read was accepted as fresh')
  assert.equal(verdict.reason, VERIFY_REASONS.UNREACHABLE)
  assert.equal(verdict.degraded, true)
  assert.deepEqual(verdict.errorCodes, ['malformed-challenge-ts'])
})

test('a challenge solved in OUR future beyond the skew we tolerate is refused and is LOUD', async () => {
  // A clock that far out makes every age negative, so maxChallengeAgeSeconds is
  // unreachable — and it also breaks the second-precision timestamps every
  // CHECK in schema.sql reads. The visitor cannot fix either one.
  const verdict = await turnstile({ fetchImpl: solvedAt('2026-08-01T00:10:00Z') }).verify(freshToken())

  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, VERIFY_REASONS.EXPIRED)
  assert.equal(verdict.operatorAlert, true)
  assert.ok(verdict.errorCodes.includes('challenge-ts-in-future'), verdict.errorCodes.join(','))

  // Inside the tolerance it is ordinary clock jitter and passes.
  const jitter = await turnstile({ fetchImpl: solvedAt('2026-08-01T00:00:30Z') }).verify(freshToken())
  assert.equal(jitter.ok, true)
})

// ---------------------------------------------------------------------------
// The request itself

test('the request is the form POST Cloudflare documents, carrying the secret, the token and the IP', async () => {
  const seen = []
  const instance = turnstile({
    verifyUrl: 'https://example.invalid/siteverify',
    fetchImpl: async (url, init) => {
      seen.push({ url, init, body: new URLSearchParams(String(init.body)) })
      return { ok: true, status: 200, json: async () => ({ success: true }) }
    },
  })

  await instance.verify('a-token', '203.0.113.9')

  assert.equal(seen[0].url, 'https://example.invalid/siteverify')
  assert.equal(seen[0].init.method, 'POST')
  assert.equal(seen[0].init.headers['content-type'], 'application/x-www-form-urlencoded')
  assert.equal(seen[0].body.get('secret'), 'secret-key')
  assert.equal(seen[0].body.get('response'), 'a-token')
  assert.equal(seen[0].body.get('remoteip'), '203.0.113.9')
})

test('remoteip is OMITTED rather than guessed when the caller has no address it trusts', async () => {
  // siteverify compares remoteip with the address that solved the challenge, so
  // a spoofed X-Forwarded-For forwarded on here is a hard rejection for a
  // legitimate visitor. Absent beats wrong.
  const seen = []
  const instance = turnstile({
    fetchImpl: async (url, init) => {
      seen.push(new URLSearchParams(String(init.body)))
      return { ok: true, status: 200, json: async () => ({ success: true }) }
    },
  })

  await instance.verify(freshToken())
  await instance.verify(freshToken(), '   ')

  assert.equal(seen[0].has('remoteip'), false)
  assert.equal(seen[1].has('remoteip'), false, 'a blank address was sent as the visitor\'s address')
})

test('no siteverify call is made at all for a token this module can reject on sight', async () => {
  let calls = 0
  const instance = turnstile({
    fetchImpl: async () => {
      calls += 1
      return { ok: true, status: 200, json: async () => ({ success: true }) }
    },
  })

  assert.equal((await instance.verify('')).reason, VERIFY_REASONS.MISSING_TOKEN)
  assert.equal((await instance.verify('t'.repeat(4096))).reason, VERIFY_REASONS.MALFORMED_TOKEN)
  assert.equal(calls, 0)
})

// ---------------------------------------------------------------------------
// The invariant that holds across all of it

test('ok is true ONLY where Cloudflare answered success, under every posture', async () => {
  const everyFailure = [
    ...DOCUMENTED_CODES.map((code) => failsWith(code)),
    answers({ success: false }),
    answers({}),
    answers('nope'),
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
    async () => {
      throw new Error('down')
    },
    solvedAt('2026-07-31T00:00:00Z'),
    solvedAt('not-a-date'),
  ]

  for (const postureValue of Object.values(UNREACHABLE_POSTURES)) {
    for (const fetchImpl of everyFailure) {
      const verdict = await turnstile({ fetchImpl, onUnreachable: postureValue }).verify(freshToken())
      assert.equal(verdict.ok, false, `ok was true without a success from Cloudflare (posture ${postureValue})`)
      assert.notEqual(verdict.disposition, VERIFY_DISPOSITIONS.ACCEPT, `posture ${postureValue}`)
      assert.equal(verdict.simulated, false, 'a production verdict claimed to be simulated')
      assert.equal(verdict.posture, postureValue)
    }
  }

  const passed = await turnstile().verify(freshToken())
  assert.equal(passed.ok, true)
  assert.equal(passed.disposition, VERIFY_DISPOSITIONS.ACCEPT)
  assert.equal(passed.degraded, false)
  assert.equal(passed.operatorAlert, false)
})
