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
// WHY "CLOUDFLARE SAID NO" AND "CLOUDFLARE DID NOT ANSWER" ARE DIFFERENT FACTS.
// A failed challenge is a statement about a visitor. A timeout is a statement
// about a network, and it says nothing whatever about the person holding the
// token. Collapsing the two loses the only information an operator needs at 1am,
// so every verdict carries `degraded`: true means we reached a decision WITHOUT
// an answer about this token, and `reason` plus `errorCodes` say how. Cloudflare's
// own `internal-error` is on that side of the line too — it is Cloudflare
// reporting that it failed to decide, not reporting that the visitor failed.
//
// WHY THE UNREACHABLE POSTURE IS FAIL CLOSED, AND WHY THAT IS UNCOMFORTABLE.
// In production, `ok` is true only when Cloudflare answered `success: true`
// about this exact token. No configuration turns an unanswered call into
// ok:true, and none may: the field's whole meaning is "Cloudflare confirmed
// this". (The development verifier is the one thing that returns ok:true having
// asked nobody, which is the entire reason every verdict also carries
// `simulated` and the reason env-guard refuses that mode in production.)
//
// That default is not comfortable, and the sentence that used to live here was
// wrong about why. It claimed an outage degrades into "the suspicious minority
// cannot submit" because required() only challenges a few people. Read rule 4:
// it challenges every submitter with acceptedCount === 0, which is every
// first-time visitor. The audience is on Bilibili, largely inside mainland
// China, and challenges.cloudflare.com is not dependably reachable from every
// network a pod might sit on. So a systematic block is not a minority
// inconvenience — it is "nobody new can ever submit", indefinitely, with no
// error anyone can act on unless the verdict says which path it took. That is
// the whole reason `degraded` exists, and the reason UNREACHABLE is its own
// reason rather than a flavour of REJECTED.
//
// So why still closed? Because today a fail-open submission cannot be recorded
// truthfully, and an unrecordable posture lies about itself. batches.turnstile_
// verdict is CHECK (turnstile_verdict IN ('passed', 'failed', 'bypassed')), and
// batches_submit_needs_turnstile / batches_insert_submit_needs_turnstile ABORT
// any batch reaching 'submitted' with turnstile_required = 1 and a verdict that
// is NULL or 'failed'. The only value that would let a degraded submission land
// is 'passed' — writing, into the table the review queue and the audit read,
// that Cloudflare confirmed something it never saw. Refusing the submission at
// least tells the visitor the truth.
//
// `config.onUnreachable: 'review'` is the other posture, built and tested, and
// it moves `disposition` to 'review' while leaving `ok` false. It is therefore
// INERT until two things change, and both are outside this file: schema.sql
// needs a verdict value for "admitted without verification" (with the two
// triggers taught to allow it), and routes/public.mjs needs to branch on
// `disposition` instead of `ok`. Until then it records an intent and changes
// nothing — which also means it is not a bypass env-guard is failing to watch.
// When it becomes one, BYPASS_FLAGS needs a `turnstile.onUnreachable` entry at
// 'announce' severity, next to turnstile.switch.
//
// WHY A TOKEN IS BURNED AT RESERVATION AND NOT AT SUCCESS.
// The local seen-token map is marked BEFORE the network call. Cloudflare enforces
// single use itself (error code timeout-or-duplicate), so this map is a fast path
// and not the authority — but marking after a successful response leaves a window
// in which two concurrent requests carrying the same token are both in flight, and
// that window is exactly what a replay is. A token we have sent must be treated as
// spent even if we never learned the answer.
//
// WHAT THE LOCAL MAP DOES NOT COVER: a second pod. It is one Map in one process,
// so two replicas behind the same domain each have their own, and the same token
// presented to both is unknown to each. Cloudflare's timeout-or-duplicate is the
// only cross-process authority on that, and it is why this map is described as a
// fast path rather than as the single-use guarantee. Both report REPLAYED so the
// caller does not have to know which one caught it — but if this ever runs on
// more than one replica, the guarantee is Cloudflare's alone, and the degraded
// path above is then also the path on which single use is not enforced at all.
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
//     case goes red. Same for making `ok` depend on the posture at all: the
//     "'review' changes the disposition and never the ok flag" case goes red,
//     and with it the promise that turning the knob on cannot admit anything by
//     itself.
//   * Read `success` with `payload?.success !== true` instead of demanding a
//     boolean — red input: a body of `{}` (an interception page that happens to
//     be JSON) is then reported as REJECTED, i.e. as that visitor having failed
//     a challenge nobody ever asked Cloudflare about. It must be degraded.
//   * Fold `internal-error` in with `invalid-input-response` — the "Cloudflare
//     failing to decide is not the visitor failing" case goes red, because
//     internal-error would stop being degraded.
//   * Alphabetise SITEVERIFY_ERROR_CODES, or move `invalid-input-response` above
//     `invalid-input-secret` — the table's ORDER is its precedence, and the
//     "a wrong secret is an operator error even when a token error rides along"
//     case goes red.
//   * Drop the `Number.isFinite` check on the parsed challenge_ts, or the
//     negative-age branch — red input: challenge_ts 'not-a-date' makes the age
//     NaN and every comparison false, so the freshness check runs and can never
//     say no; a clock 10 minutes behind does the same thing with a real date.
//     A check that cannot fire is the phantom field wearing a different hat.
//   * Delete the `signal` from the fetch init — the bounded-call case goes red.
//     An unbounded fetch is a submission request held open for as long as the
//     peer feels like holding it.
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
  // The bound on one whole siteverify exchange, headers and body together. It
  // sits in the middle of a submit request a human is waiting on, so it is small
  // on purpose; the cost of being wrong is a degraded verdict, not a lost clip.
  timeoutMs: 5_000,
  // Turnstile tokens are valid for 300s; there is nothing to remember about one
  // that can no longer be redeemed anywhere.
  tokenTtlMs: 300_000,
  maxTokenLength: 2048,
  maxRememberedTokens: 10_000,
  sweepIntervalMs: 60_000,
  maxChallengeAgeSeconds: 300,
  // How far ahead of us a challenge may claim to have been solved before we call
  // it a broken clock rather than a fresh token. See the negative-age branch in
  // verify(): without a floor, a server running behind makes every age negative
  // and maxChallengeAgeSeconds unreachable.
  maxClockSkewSeconds: 60,
  // A siteverify answer is a few hundred bytes. This is not a parser limit — it
  // is a refusal to read a body that announces megabytes, which no real answer
  // does and an interception page might.
  maxResponseBytes: 64 * 1024,
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
  // The operator's secret is wrong or absent. Every challenge fails until a
  // human fixes it and no amount of visitor retrying helps, which is why it is
  // not folded in with REJECTED.
  MISCONFIGURED: 'misconfigured',
  // Our REQUEST to siteverify was wrong — also ours to fix, but a different fix
  // from a bad secret, and a visitor told "misconfigured" when the bug is in
  // this file's encoding has been told something untrue.
  MALFORMED_REQUEST: 'malformed-request',
  UNREACHABLE: 'unreachable',
})

/**
 * What the caller should DO. Separate from `ok` because they answer different
 * questions: `ok` is "did Cloudflare confirm this token", `disposition` is "may
 * this submission proceed, and how". They differ on exactly one path — an
 * unanswered call under the 'review' posture — and that is the path the header
 * explains at length.
 */
export const VERIFY_DISPOSITIONS = Object.freeze({
  ACCEPT: 'accept',
  REJECT: 'reject',
  REVIEW: 'review',
})

/** What to do when siteverify gives us no answer about a token. */
export const UNREACHABLE_POSTURES = Object.freeze({
  CLOSED: 'closed',
  REVIEW: 'review',
})

/**
 * Cloudflare's documented siteverify error codes — the complete table, verbatim,
 * from developers.cloudflare.com/turnstile/get-started/server-side-validation/
 * (read 2026-08-01; seven entries, no more). A code arriving that is NOT a key
 * here is reported in the verdict's `unrecognizedCodes` rather than quietly
 * absorbed, because the day Cloudflare adds an eighth, the interesting thing is
 * the word, not our shrug.
 *
 * THE ORDER OF THIS TABLE IS ITS PRECEDENCE. A failure may carry several codes,
 * and classification takes the first one present reading down. Operator errors
 * are at the top deliberately: with a wrong secret every response carries
 * invalid-input-secret, and answering "your challenge failed" to each visitor
 * while that is on the wire turns one broken deployment into what looks like a
 * wave of suspicious people. Sorting this table alphabetically would silently
 * change what visitors are told.
 *
 * The three columns are three different questions:
 *   reason         what this becomes in the closed set above
 *   degraded       did we learn anything about THIS visitor?
 *   operatorAlert  must a human act before anyone can get through?
 */
export const SITEVERIFY_ERROR_CODES = Object.freeze({
  'invalid-input-secret': Object.freeze({
    meaning: 'The secret key is invalid or expired.',
    reason: VERIFY_REASONS.MISCONFIGURED,
    degraded: false,
    operatorAlert: true,
  }),
  'missing-input-secret': Object.freeze({
    meaning: 'The secret parameter was not provided.',
    reason: VERIFY_REASONS.MISCONFIGURED,
    degraded: false,
    operatorAlert: true,
  }),
  'bad-request': Object.freeze({
    meaning: 'The request was malformed.',
    reason: VERIFY_REASONS.MALFORMED_REQUEST,
    degraded: false,
    operatorAlert: true,
  }),
  'missing-input-response': Object.freeze({
    // verify() refuses an empty token before it ever posts, so this cannot be a
    // visitor sending nothing — it is this file having sent a request Cloudflare
    // could not read the token out of. That makes it ours, and loud.
    meaning: 'The response parameter (the token) was not provided.',
    reason: VERIFY_REASONS.MALFORMED_REQUEST,
    degraded: false,
    operatorAlert: true,
  }),
  'timeout-or-duplicate': Object.freeze({
    // The same event the local map reports, seen from the only place that can
    // see it across processes.
    meaning: 'The token was already validated, or is older than its 300s life.',
    reason: VERIFY_REASONS.REPLAYED,
    degraded: false,
    operatorAlert: false,
  }),
  'internal-error': Object.freeze({
    // Above invalid-input-response: if Cloudflare says it broke, that is what
    // happened, and the token is unjudged rather than bad.
    meaning: 'Cloudflare hit an internal error and did not decide.',
    reason: VERIFY_REASONS.UNREACHABLE,
    degraded: true,
    operatorAlert: false,
  }),
  'invalid-input-response': Object.freeze({
    meaning: 'The token is invalid, malformed or expired.',
    reason: VERIFY_REASONS.REJECTED,
    degraded: false,
    operatorAlert: false,
  }),
})

/**
 * The codes this module puts in `errorCodes` itself, when Cloudflare gave it
 * none. Exported so a test can hold them disjoint from the documented seven: a
 * reader of one log line should never have to work out whose vocabulary a code
 * belongs to. Two more appear that are not constants — `http-<status>` for a
 * non-2xx answer, and whatever `err.code` a transport failure carried
 * (ECONNRESET, ENOTFOUND, UND_ERR_*), which is Node's vocabulary and not ours.
 */
export const SYNTHETIC_ERROR_CODES = Object.freeze([
  'timeout',
  'fetch-failed',
  'oversized-response',
  'unparseable-body',
  'malformed-response',
  'malformed-challenge-ts',
  'challenge-ts-in-future',
])

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
 *   onUnreachable 'closed' | 'review'   what to do when siteverify does not answer
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

  // Refused rather than defaulted: `onUnreachable: 'open'` is a plausible thing
  // to write, and silently reading it as 'closed' would mean an operator who
  // believed they had chosen a posture had chosen nothing. A safe default is only
  // safe when it was not asked to be something else.
  const posture = config.onUnreachable ?? UNREACHABLE_POSTURES.CLOSED
  if (posture !== UNREACHABLE_POSTURES.CLOSED && posture !== UNREACHABLE_POSTURES.REVIEW) {
    throw new TypeError(
      `createTurnstile: config.onUnreachable must be "closed" or "review", got ${JSON.stringify(config.onUnreachable)}`,
    )
  }

  const verifyUrl = config.verifyUrl ?? SITEVERIFY_URL
  const fetchImpl = config.fetchImpl ?? globalThis.fetch
  if (mode === 'production' && typeof fetchImpl !== 'function') {
    throw new TypeError('createTurnstile: no fetch implementation available (Node 20+ provides one)')
  }

  const now = () => (typeof config.now === 'function' ? config.now() : new Date())

  // token -> epoch ms at which it was reserved.
  //
  // ONE MAP IN ONE PROCESS. It does not cover a second pod: two replicas each
  // keep their own, and a token replayed against the other one is a token this
  // map has never heard of. Cloudflare's timeout-or-duplicate is the only
  // authority that spans processes; this is a fast path in front of it, and on
  // the degraded path (no answer from Cloudflare) it is the ONLY single-use
  // check there is. Both layers report VERIFY_REASONS.REPLAYED, so the caller
  // does not have to care which one caught it.
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
    const verdict = (ok, reason, extra = {}) => {
      const degraded = extra.degraded === true
      return Object.freeze({
        // In production: "Cloudflare confirmed this token", and nothing else,
        // under any posture. In development: the bypass, which is what
        // `simulated` below is for.
        ok,
        mode,
        // Never absent, never true in production: a caller that forgets to look
        // at `reason` still cannot read a development pass as a real verdict.
        simulated: mode === 'development',
        reason,
        // What to DO. Derived here rather than at each call site so the posture
        // is decided in one place; it departs from `ok` on exactly one path.
        disposition: ok
          ? VERIFY_DISPOSITIONS.ACCEPT
          : degraded && posture === UNREACHABLE_POSTURES.REVIEW
            ? VERIFY_DISPOSITIONS.REVIEW
            : VERIFY_DISPOSITIONS.REJECT,
        // "We decided without an answer about this token." A refusal we made
        // ourselves — missing token, oversized token, a replay our own map
        // caught — is NOT degraded: it is a sound decision that needed nobody.
        degraded,
        // Recorded on every verdict, including the ones that never needed it, so
        // a stored verdict says which posture produced it rather than leaving a
        // future reader to guess from the config of the day they are reading.
        posture,
        operatorAlert: extra.operatorAlert === true,
        checkedAt: at,
        errorCodes: Object.freeze(extra.errorCodes ?? []),
        unrecognizedCodes: Object.freeze(extra.unrecognizedCodes ?? []),
        hostname: extra.hostname ?? null,
        action: extra.action ?? null,
        challengeTs: extra.challengeTs ?? null,
      })
    }

    // Every branch that reaches this had a token it could not get a verdict on.
    const noAnswer = (extra) => verdict(false, VERIFY_REASONS.UNREACHABLE, { ...extra, degraded: true })

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

    let response
    try {
      response = await fetchImpl(verifyUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        // The bound on the WHOLE exchange, not just the headers: the signal is
        // handed to fetch, so aborting it errors the response body stream too.
        // Without it, a peer that accepts the connection and then says nothing
        // holds a visitor's submit request open for as long as it likes — and
        // "as long as it likes" is the documented behaviour of several kinds of
        // middlebox this traffic may meet.
        signal: AbortSignal.timeout(limits.timeoutMs),
        body,
      })
    } catch (err) {
      return noAnswer({ errorCodes: [transportCode(err)] })
    }

    if (!response.ok) {
      // A band, not a status. 5xx and 429 are Cloudflare having a bad time; a
      // 4xx is either our request being wrong or something on the path
      // answering on Cloudflare's behalf. Both are "no answer about this
      // visitor", and only the second needs a human — saying which is the point
      // of splitting them, since a 400 that nobody looks at never gets better.
      return noAnswer({
        errorCodes: [`http-${response.status}`],
        operatorAlert: response.status >= 400 && response.status < 500 && response.status !== 429,
      })
    }

    // Only when the peer declares a length. A chunked body is bounded by the
    // timeout above and by nothing else, which is stated rather than implied.
    const declaredBytes = Number(response.headers?.get?.('content-length') ?? Number.NaN)
    if (Number.isFinite(declaredBytes) && declaredBytes > limits.maxResponseBytes) {
      return noAnswer({ errorCodes: ['oversized-response'] })
    }

    let payload
    try {
      payload = await response.json()
    } catch (err) {
      // Not JSON is not a verdict: a captive portal, an interception page, a
      // truncated read. If the abort fired while the body was still arriving
      // this is the timeout wearing a parse error's clothes, and reporting it as
      // a malformed answer would send an operator looking at the wrong thing.
      return noAnswer({ errorCodes: [isAbortError(err) ? 'timeout' : 'unparseable-body'] })
    }

    if (payload === null || typeof payload !== 'object' || typeof payload.success !== 'boolean') {
      // `success` ABSENT is not `success: false`. Read as a rejection, every
      // JSON-shaped interception page becomes "that visitor failed a challenge"
      // — a claim about a person, made from a body Cloudflare never wrote.
      return noAnswer({ errorCodes: ['malformed-response'] })
    }

    const errorCodes = Array.isArray(payload['error-codes'])
      ? payload['error-codes'].filter((code) => typeof code === 'string')
      : []
    const details = {
      errorCodes,
      unrecognizedCodes: errorCodes.filter((code) => !Object.hasOwn(SITEVERIFY_ERROR_CODES, code)),
      hostname: typeof payload.hostname === 'string' ? payload.hostname : null,
      action: typeof payload.action === 'string' ? payload.action : null,
      challengeTs: typeof payload.challenge_ts === 'string' ? payload.challenge_ts : null,
    }

    if (payload.success === false) {
      const handling = classifySiteverifyFailure(errorCodes)
      return verdict(false, handling.reason, {
        ...details,
        degraded: handling.degraded,
        operatorAlert: handling.operatorAlert,
      })
    }
    if (config.expectedHostname && details.hostname !== config.expectedHostname) {
      return verdict(false, VERIFY_REASONS.HOSTNAME_MISMATCH, details)
    }
    if (config.expectedAction && details.action !== config.expectedAction) {
      return verdict(false, VERIFY_REASONS.ACTION_MISMATCH, details)
    }
    if (details.challengeTs !== null) {
      const solvedAtMs = Date.parse(details.challengeTs)
      if (!Number.isFinite(solvedAtMs)) {
        // A timestamp we cannot read is not a fresh one. Guarding on
        // Number.isFinite(age) instead — the shape this used to have — makes an
        // unparseable challenge_ts skip the whole check silently, so the code
        // below runs and can never say no.
        return noAnswer({ ...details, errorCodes: ['malformed-challenge-ts'] })
      }
      const ageSeconds = (nowMs - solvedAtMs) / 1000
      if (ageSeconds > limits.maxChallengeAgeSeconds) {
        return verdict(false, VERIFY_REASONS.EXPIRED, details)
      }
      if (ageSeconds < -limits.maxClockSkewSeconds) {
        // Solved in our future by more than the skew we tolerate. The visitor is
        // not at fault and cannot fix it: our clock is wrong, and while it is,
        // every age this computes is negative and the expiry check above is
        // unreachable. Loud, because a clock that far out also breaks the
        // second-precision timestamps every CHECK in schema.sql reads.
        return verdict(false, VERIFY_REASONS.EXPIRED, {
          ...details,
          errorCodes: [...details.errorCodes, 'challenge-ts-in-future'],
          operatorAlert: true,
        })
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

// Cloudflare answered, and said no, in a vocabulary this file has not been
// taught. Refusing is the conservative reading of a real answer — but the codes
// ride along in `unrecognizedCodes` so the next person sees the word rather than
// a shrug, and so "we handle the documented set" stays a checkable claim instead
// of a comment that was true once.
const UNCLASSIFIED_FAILURE = Object.freeze({
  reason: VERIFY_REASONS.REJECTED,
  degraded: false,
  operatorAlert: false,
})

/**
 * A siteverify failure, classified by the FIRST documented code present reading
 * down SITEVERIFY_ERROR_CODES. See that table for why its order is precedence.
 *
 * `success: false` with no codes at all lands here too and is refused: it is
 * still Cloudflare declining, just without saying why.
 */
function classifySiteverifyFailure(codes) {
  for (const code of Object.keys(SITEVERIFY_ERROR_CODES)) {
    if (codes.includes(code)) return SITEVERIFY_ERROR_CODES[code]
  }
  return UNCLASSIFIED_FAILURE
}

// AbortSignal.timeout() raises TimeoutError; an explicitly aborted signal raises
// AbortError. Both mean the bound fired, and both can surface either from the
// fetch or from the body read.
function isAbortError(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError'
}

function transportCode(err) {
  if (isAbortError(err)) return 'timeout'
  // Node's own vocabulary, passed through rather than translated: ECONNRESET and
  // ENOTFOUND say different things about a network and flattening them to
  // 'fetch-failed' would throw away the only diagnosis in the verdict.
  //
  // err.cause.code FIRST, and that ordering is the whole point. undici raises
  // `TypeError: fetch failed` with err.code undefined and the real errno on
  // err.cause — so reading err.code first recorded the string 'TypeError' for
  // EVERY network failure in production, which is neither Node's vocabulary nor
  // Cloudflare's, and defeated the check that our invented codes never collide
  // with theirs. Measured against the real global fetch: a refused connection
  // and an unresolvable host were indistinguishable. This matters exactly where
  // this module says it does — an operator facing a systematic block cannot act
  // on 'TypeError'.
  return err?.cause?.code ?? err?.code ?? err?.name ?? 'fetch-failed'
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
