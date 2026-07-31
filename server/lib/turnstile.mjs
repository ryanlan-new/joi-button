// SPDX-License-Identifier: MIT
//
// Cloudflare Turnstile: when to demand a challenge, and how to check the answer.
//
// The challenge is applied ON DEMAND — the server decides at the moment submit
// is pressed whether this submitter, right now, has to solve one. required() is
// that decision and verify() is the check; they are deliberately separate, because
// "we did not ask for a token" and "the token we asked for did not verify" are
// different answers and the caller has to be able to tell them apart.
//
// WHY required() IS A RULE LIST AND NOT A SCORE.
// At 1am, with submissions failing, an operator has to be able to read the rule
// that fired and know what to change. A weighted score cannot be read that way:
// it can only be tuned, and tuning under pressure is how a threshold ends up at a
// value nobody can justify the next morning. So: three rules plus a default,
// evaluated in a fixed order, first match wins, and the reason that fired is in
// the return value along with the numbers it read.
//
// WHY MISSING EVIDENCE MEANS "CHALLENGE THEM".
// The rate rule needs a count that only the caller can produce (this module never
// touches the database). If that count is absent — or was taken over a shorter
// window than the policy asks about — the honest answer is that we do not know,
// and "we do not know" must not resolve to "let them through". Absence of
// evidence is not evidence of good behaviour.
//
// The submitter's block flag is evidence in exactly the same sense, and is
// listed with the counts rather than defaulted. Left optional it would read as
// "not blocked" for every caller that forgot to SELECT it, which is how a
// blocked submitter with a clean history gets waved through by a rule written
// to stop precisely that.
//
// WHY VERIFY FAILS CLOSED.
// A siteverify call that times out produces ok:false. This does make Cloudflare a
// dependency of the submission path, but only for submitters a rule already
// singled out — required() decides who is asked at all, so an outage degrades
// into "the suspicious minority cannot submit", not "the site is down". The other
// way round, a challenge you cannot verify is a challenge that is not there.
//
// WHY A TOKEN IS BURNED AT RESERVATION AND NOT AT SUCCESS.
// The local seen-token map is marked BEFORE the network call. Cloudflare enforces
// single use itself (error code timeout-or-duplicate), so this map is a fast path
// and not the authority — but marking after a successful response leaves a window
// in which two concurrent requests carrying the same token are both in flight, and
// that window is exactly what a replay is. A token we have sent must be treated as
// spent even if we never learned the answer.
//
// ---------------------------------------------------------------------------
// WHAT MAKES THIS GO RED
//
//   * Move the `seen.set(token, ...)` reservation to after a successful verify —
//     the replay case goes red (two concurrent verifies of one token both pass).
//   * Drop `simulated: true` from the development verdict, or make it anything
//     other than a distinct reason — the "a bypass verdict cannot be mistaken for
//     a real one" case goes red.
//   * Return ok:true when siteverify throws or answers non-2xx — the fail-closed
//     case goes red.
//   * Move the trusted-submitter rule above the rate rule — the "a trusted
//     submitter uploading 40 clips in five minutes is still challenged" case goes
//     red. Order is the whole semantics of a first-match-wins list.
//   * Return { required: false } when context.recent is absent, or change the
//     window comparison from `>=` to `<=` — the insufficient-evidence case goes
//     red, and a caller counting one minute would satisfy a ten-minute rule.
//   * Let config.verifyUrl or config.fetchImpl through in production — that is
//     caught in env-guard.mjs, not here: both are refuse-severity bypass flags,
//     since either one turns the verdict into whatever the injected thing says.
//   * Read a field submitters has no column for (this rule used to read
//     `submitter.blockedUntil`) — red input:
//     required({ submitter: { acceptedCount: 9, rejectedCount: 0, blocked: 1 },
//     recent: { submissions: 0, windowMinutes: 60 } }) answers
//     { required: false, reason: 'trusted-submitter' }: a BLOCKED submitter with
//     a good history, waved through. A phantom field is not a lenient rule, it
//     is a rule that never fires, and nothing in JavaScript reports it.
//   * Drop 'submitter.blocked' from the evidence list — red input:
//     required({ submitter: { acceptedCount: 9, rejectedCount: 0 },
//     recent: { submissions: 0, windowMinutes: 60 } }), i.e. the same call with
//     the flag simply not selected. It must answer insufficient-evidence; with
//     the flag optional it answers trusted-submitter, and the previous case
//     becomes unreachable for any caller that forgets one column.
//   * Put Date#toISOString() back in place of toCanonicalTimestamp() — red
//     input: now: () => new Date('2026-08-01T00:00:00.500Z') makes evaluatedAt
//     '2026-08-01T00:00:00.500Z', which batches.turnstile_decided_at's CHECK
//     (second precision, no fractional part) refuses outright.
// ---------------------------------------------------------------------------

// The one correct producer of the second-precision timestamps every timestamp
// CHECK in schema.sql accepts — including batches.turnstile_decided_at, which is
// where a verdict from here lands. Imported rather than copied: a second
// implementation is a second thing to keep in step with the column constraints,
// and migrate.mjs does nothing at import time.
import { toCanonicalTimestamp } from '../db/migrate.mjs'
import { isConfigValidated } from './env-guard.mjs'

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export const TURNSTILE_DEFAULTS = Object.freeze({
  timeoutMs: 5_000,
  // Turnstile tokens are valid for 300s; there is nothing to remember about one
  // that can no longer be redeemed anywhere.
  tokenTtlMs: 300_000,
  maxTokenLength: 2048,
  maxRememberedTokens: 10_000,
  sweepIntervalMs: 60_000,
  maxChallengeAgeSeconds: 300,
})

export const DEFAULT_POLICY = Object.freeze({
  switch: 'auto', // 'auto' | 'always' | 'off'
  rate: Object.freeze({ threshold: 3, windowMinutes: 60 }),
  history: Object.freeze({ rejectedThreshold: 1 }),
  trusted: Object.freeze({ afterAccepted: 5 }),
  otherwise: false,
})

export const VERIFY_REASONS = Object.freeze({
  OK: 'ok',
  DEVELOPMENT_BYPASS: 'development-bypass',
  MISSING_TOKEN: 'missing-token',
  MALFORMED_TOKEN: 'malformed-token',
  REPLAYED: 'replayed',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  HOSTNAME_MISMATCH: 'hostname-mismatch',
  ACTION_MISMATCH: 'action-mismatch',
  MISCONFIGURED: 'misconfigured',
  UNREACHABLE: 'unreachable',
})

export const REQUIRED_REASONS = Object.freeze({
  SWITCH_ALWAYS: 'operator-switch-always',
  SWITCH_OFF: 'operator-switch-off',
  INSUFFICIENT_EVIDENCE: 'insufficient-evidence',
  RATE: 'rate-over-window',
  HISTORY: 'submitter-history',
  TRUSTED: 'trusted-submitter',
  DEFAULT: 'default',
})

/**
 * createTurnstile(config) -> { mode, required, verify, policy }
 *
 * config:
 *   mode          'production' | 'development'   (required)
 *   siteKey       public, production only
 *   secretKey     secret, production only
 *   switch        'auto' | 'always' | 'off'
 *   policy        partial override of DEFAULT_POLICY
 *   limits        partial override of TURNSTILE_DEFAULTS
 *   expectedHostname / expectedAction   optional, checked against the verdict
 *   verifyUrl / fetchImpl               tests only; refused in production by env-guard
 *   development.simulate                a VERIFY_REASONS value to force a failure locally
 *
 * As with the danmaku source, development mode requires a config that
 * assertSafeConfig() has cleared.
 */
export function createTurnstile(config = {}) {
  const mode = config?.mode
  if (mode !== 'production' && mode !== 'development') {
    throw new TypeError(
      `createTurnstile: config.mode must be "production" or "development", got ${JSON.stringify(mode)}`,
    )
  }
  if (mode === 'development' && !isConfigValidated(config)) {
    throw new Error(
      'createTurnstile: the development (always-pass) verifier can only be built from a config ' +
        'that assertSafeConfig() has cleared. Call assertSafeConfig(config, { nodeEnv }) at the ' +
        'entry point first — it is what refuses this mode in production.',
    )
  }

  const limits = Object.freeze({ ...TURNSTILE_DEFAULTS, ...(config.limits ?? {}) })
  const policy = Object.freeze({
    ...DEFAULT_POLICY,
    ...(config.policy ?? {}),
    // The operator switch lives at the top level of the turnstile config because
    // env-guard watches that exact path; keeping a second copy inside `policy`
    // would give the banner and the rule list two different answers.
    switch: config.switch ?? config.policy?.switch ?? DEFAULT_POLICY.switch,
    rate: Object.freeze({ ...DEFAULT_POLICY.rate, ...(config.policy?.rate ?? {}) }),
    history: Object.freeze({ ...DEFAULT_POLICY.history, ...(config.policy?.history ?? {}) }),
    trusted: Object.freeze({ ...DEFAULT_POLICY.trusted, ...(config.policy?.trusted ?? {}) }),
  })

  if (mode === 'production') {
    if (typeof config.secretKey !== 'string' || config.secretKey.trim() === '') {
      throw new TypeError('createTurnstile: production mode needs config.secretKey')
    }
  }

  const verifyUrl = config.verifyUrl ?? SITEVERIFY_URL
  const fetchImpl = config.fetchImpl ?? globalThis.fetch
  if (mode === 'production' && typeof fetchImpl !== 'function') {
    throw new TypeError('createTurnstile: no fetch implementation available (Node 20+ provides one)')
  }

  const now = () => (typeof config.now === 'function' ? config.now() : new Date())

  // token -> epoch ms at which it was reserved. Per process: with more than one
  // replica this is a fast path only, and Cloudflare's own single-use enforcement
  // is what actually holds. Both layers report VERIFY_REASONS.REPLAYED, so the
  // caller does not have to care which one caught it.
  const seen = new Map()
  let lastSweep = 0

  function sweep(nowMs) {
    if (nowMs - lastSweep < limits.sweepIntervalMs && seen.size < limits.maxRememberedTokens) return
    lastSweep = nowMs
    for (const [token, at] of seen) {
      if (nowMs - at > limits.tokenTtlMs) seen.delete(token)
    }
    // A flood of distinct tokens must not grow this without bound. Evicting the
    // oldest weakens the fast path for those, not the guarantee: Cloudflare is
    // still the authority on duplicates.
    while (seen.size > limits.maxRememberedTokens) {
      const oldest = seen.keys().next()
      if (oldest.done) break
      seen.delete(oldest.value)
    }
  }

  /**
   * required(context) -> { required, reason, rule, evidence, evaluatedAt }
   *
   * context:
   *   submitter { acceptedCount, rejectedCount, blocked, firstSeenAt? }
   *   recent    { submissions, windowMinutes }   counted by the caller from the db
   *
   * The names are the submitters columns the caller read, not names invented
   * here: `blocked` is submitters.blocked. This module never reads the database;
   * the counts come in as numbers, which is also what makes the whole rule set
   * testable without one — and what makes a misspelt field silently absent, so
   * every field a rule reads is checked for presence before any rule runs.
   */
  function required(context = {}) {
    const at = toCanonicalTimestamp(now())
    const decide = (isRequired, reason, rule, evidence = {}) =>
      Object.freeze({
        required: isRequired,
        reason,
        rule,
        evidence: Object.freeze(evidence),
        evaluatedAt: at,
      })

    // 1. The manual switch. It is first because an operator reaching for it has
    //    already decided that the rules below are not serving them right now.
    if (policy.switch === 'always') {
      return decide(true, REQUIRED_REASONS.SWITCH_ALWAYS, 'switch')
    }
    if (policy.switch === 'off') {
      return decide(false, REQUIRED_REASONS.SWITCH_OFF, 'switch')
    }

    // 2. Do we have what the remaining rules need?
    const submitter = context.submitter
    const recent = context.recent
    const missing = []
    if (submitter === null || typeof submitter !== 'object') missing.push('submitter')
    else {
      if (!Number.isInteger(submitter.acceptedCount)) missing.push('submitter.acceptedCount')
      if (!Number.isInteger(submitter.rejectedCount)) missing.push('submitter.rejectedCount')
      if (readBlocked(submitter.blocked) === null) missing.push('submitter.blocked')
    }
    if (recent === null || typeof recent !== 'object') missing.push('recent')
    else {
      if (!Number.isInteger(recent.submissions)) missing.push('recent.submissions')
      if (!Number.isFinite(recent.windowMinutes)) missing.push('recent.windowMinutes')
      else if (recent.windowMinutes < policy.rate.windowMinutes) {
        // A count over a SHORTER window under-reports, which would let a flood
        // slip past a rule that thinks it saw an hour. A longer window
        // over-reports, which only over-challenges, so it is allowed.
        missing.push(
          `recent.windowMinutes (${recent.windowMinutes}) is shorter than the policy window (${policy.rate.windowMinutes})`,
        )
      }
    }
    if (missing.length > 0) {
      return decide(true, REQUIRED_REASONS.INSUFFICIENT_EVIDENCE, 'evidence', { missing })
    }

    // 3. Rate over a window. Before the trust rule on purpose: a submitter with a
    //    clean history who suddenly uploads forty clips is precisely the case
    //    where trust should not be the deciding fact.
    if (recent.submissions >= policy.rate.threshold) {
      return decide(true, REQUIRED_REASONS.RATE, 'rate', {
        submissions: recent.submissions,
        windowMinutes: recent.windowMinutes,
        threshold: policy.rate.threshold,
      })
    }

    // 4. The submitter's history: never accepted anything, has rejections, or is
    //    blocked.
    //
    //    `blocked` is a FLAG, not a window: submitters carries blocked /
    //    blocked_at / blocked_reason and nothing that says when a block lifts, so
    //    a block here holds until someone clears it. If a timed block is wanted,
    //    it needs a real `blocked_until TEXT` column (with the same
    //    second-precision GLOB CHECK the other timestamps carry) and a
    //    comparison against `at`; reading a field the schema does not have does
    //    not implement the timed block, it makes every block invisible, which is
    //    what the earlier `submitter.blockedUntil` did.
    const blocked = readBlocked(submitter.blocked)
    if (blocked || submitter.rejectedCount >= policy.history.rejectedThreshold || submitter.acceptedCount === 0) {
      return decide(true, REQUIRED_REASONS.HISTORY, 'history', {
        acceptedCount: submitter.acceptedCount,
        rejectedCount: submitter.rejectedCount,
        blocked,
      })
    }

    // 5. Earned quiet: enough accepted submissions and nothing against them.
    if (submitter.acceptedCount >= policy.trusted.afterAccepted) {
      return decide(false, REQUIRED_REASONS.TRUSTED, 'trusted', {
        acceptedCount: submitter.acceptedCount,
        afterAccepted: policy.trusted.afterAccepted,
      })
    }

    return decide(Boolean(policy.otherwise), REQUIRED_REASONS.DEFAULT, 'default')
  }

  /**
   * verify(token, ip) -> frozen verdict
   *
   * `ip` must be an address you actually trust — the one the ingress observed,
   * not a header a client can write. siteverify compares it with the address that
   * solved the challenge, so a spoofed X-Forwarded-For turns into a hard rejection
   * for a legitimate visitor. Omit it rather than pass a guess.
   */
  async function verify(token, ip) {
    const at = toCanonicalTimestamp(now())
    const verdict = (ok, reason, extra = {}) =>
      Object.freeze({
        ok,
        mode,
        // Never absent, never true in production: a caller that forgets to look
        // at `reason` still cannot read a development pass as a real verdict.
        simulated: mode === 'development',
        reason,
        checkedAt: at,
        errorCodes: Object.freeze(extra.errorCodes ?? []),
        hostname: extra.hostname ?? null,
        action: extra.action ?? null,
        challengeTs: extra.challengeTs ?? null,
      })

    if (mode === 'development') {
      const simulate = config.development?.simulate
      if (simulate) {
        // Exists so the caller's rejection branch is reachable locally. The
        // default is still "always passes"; without this knob the failure path is
        // dead code until production, which is where nobody wants to meet it.
        return verdict(false, simulate)
      }
      return verdict(true, VERIFY_REASONS.DEVELOPMENT_BYPASS)
    }

    if (typeof token !== 'string' || token.trim() === '') {
      return verdict(false, VERIFY_REASONS.MISSING_TOKEN)
    }
    if (token.length > limits.maxTokenLength) {
      return verdict(false, VERIFY_REASONS.MALFORMED_TOKEN)
    }

    const nowMs = now().getTime()
    sweep(nowMs)
    if (seen.has(token)) {
      return verdict(false, VERIFY_REASONS.REPLAYED)
    }
    seen.set(token, nowMs)

    const body = new URLSearchParams({ secret: config.secretKey, response: token })
    // Only when we were given one we trust.
    if (typeof ip === 'string' && ip.trim() !== '') body.set('remoteip', ip.trim())
    // No idempotency_key, because there is no retry. Adding a retry without one
    // is how a network blip becomes a self-inflicted timeout-or-duplicate; if a
    // retry is ever added it must carry one key per token, generated once.

    let payload
    try {
      const response = await fetchImpl(verifyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(limits.timeoutMs),
      })
      if (!response.ok) {
        return verdict(false, VERIFY_REASONS.UNREACHABLE, { errorCodes: [`http-${response.status}`] })
      }
      payload = await response.json()
    } catch (err) {
      return verdict(false, VERIFY_REASONS.UNREACHABLE, { errorCodes: [errorCode(err)] })
    }

    const errorCodes = Array.isArray(payload?.['error-codes']) ? payload['error-codes'] : []
    const details = {
      errorCodes,
      hostname: payload?.hostname ?? null,
      action: payload?.action ?? null,
      challengeTs: payload?.challenge_ts ?? null,
    }

    if (payload?.success !== true) {
      return verdict(false, mapErrorCodes(errorCodes), details)
    }
    if (config.expectedHostname && details.hostname !== config.expectedHostname) {
      return verdict(false, VERIFY_REASONS.HOSTNAME_MISMATCH, details)
    }
    if (config.expectedAction && details.action !== config.expectedAction) {
      return verdict(false, VERIFY_REASONS.ACTION_MISMATCH, details)
    }
    if (details.challengeTs) {
      const ageSeconds = (nowMs - Date.parse(details.challengeTs)) / 1000
      if (Number.isFinite(ageSeconds) && ageSeconds > limits.maxChallengeAgeSeconds) {
        return verdict(false, VERIFY_REASONS.EXPIRED, details)
      }
    }
    return verdict(true, VERIFY_REASONS.OK, details)
  }

  /**
   * The rule list as data, in evaluation order — so an operator (or an admin
   * page) can read the policy that is actually running instead of a paragraph
   * that describes the policy that used to run.
   */
  function describePolicy() {
    return Object.freeze([
      Object.freeze({
        order: 1,
        rule: 'switch',
        question: `operator switch is "${policy.switch}"`,
        effect: 'always -> challenge everyone; off -> challenge nobody; auto -> fall through',
      }),
      Object.freeze({
        order: 2,
        rule: 'evidence',
        question: 'did the caller supply the counts and the block flag the rules below read?',
        effect: 'no -> challenge (missing evidence is not a pass)',
      }),
      Object.freeze({
        order: 3,
        rule: 'rate',
        question: `${policy.rate.threshold} or more submissions in ${policy.rate.windowMinutes} minutes?`,
        effect: 'yes -> challenge',
      }),
      Object.freeze({
        order: 4,
        rule: 'history',
        question: `never accepted, or ${policy.history.rejectedThreshold} or more rejected, or blocked?`,
        effect: 'yes -> challenge',
      }),
      Object.freeze({
        order: 5,
        rule: 'trusted',
        question: `${policy.trusted.afterAccepted} or more accepted submissions and nothing against them?`,
        effect: 'yes -> no challenge',
      }),
      Object.freeze({
        order: 6,
        rule: 'default',
        question: 'nothing above matched',
        effect: policy.otherwise ? 'challenge' : 'no challenge',
      }),
    ])
  }

  return Object.freeze({
    mode,
    required,
    verify,
    policy: describePolicy,
  })
}

// ---------------------------------------------------------------------------

// Cloudflare's documented error codes, collapsed onto the closed set of reasons
// the caller branches on. `timeout-or-duplicate` is the one that matters: it is
// Cloudflare telling us the token was already spent, i.e. the same event our
// local map reports as REPLAYED.
function mapErrorCodes(codes) {
  if (codes.includes('timeout-or-duplicate')) return VERIFY_REASONS.REPLAYED
  if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) {
    return VERIFY_REASONS.MISCONFIGURED
  }
  if (codes.includes('internal-error')) return VERIFY_REASONS.UNREACHABLE
  return VERIFY_REASONS.REJECTED
}

function errorCode(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timeout'
  return err?.code ?? err?.name ?? 'fetch-failed'
}

// submitters.blocked is `INTEGER NOT NULL CHECK (blocked IN (0, 1))`, so 0/1 is
// what better-sqlite3 hands back; booleans are accepted too because a caller
// that maps its rows may have converted already. Anything else — absent,
// undefined, a string, null — is not evidence and comes back null, which the
// evidence check reports as missing rather than reading as "not blocked".
function readBlocked(value) {
  if (value === 0 || value === false) return false
  if (value === 1 || value === true) return true
  return null
}
