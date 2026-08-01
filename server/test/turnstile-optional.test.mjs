// SPDX-License-Identifier: MIT
//
// Running in production with the challenge switched OFF and no Turnstile account.
//
// THE DECISION THIS ENCODES. The owner ruled that danmaku verification already
// carries the abuse load — every submission is tied to an open_id that cost
// somebody a message in a live room — and that Turnstile is not worth a second
// external dependency for now. That is a product decision. What made it
// impossible was a guard: the two Turnstile keys were required whenever the real
// verifier was selected, and a production process may not select the development
// one, so a deployment that had ruled Turnstile out could not boot at all.
//
// WHY DROPPING THE REQUIREMENT IS SAFE, and both halves were read before the
// predicate was changed rather than assumed:
//
//   * `turnstile.switch: 'off'` short-circuits required() at its FIRST rule
//     (lib/turnstile.mjs), before the rate rule and before the new-submitter
//     rule. No challenge is ever demanded.
//   * routes/public.mjs calls verify() only inside `if (decision.required)`, so a
//     token a client sends unasked is ignored, not checked. siteverify is
//     unreachable, and the secret with it.
//
// WHY TURNING IT BACK ON IS STILL GATED. TURNSTILE_SWITCH is read by config.mjs
// at boot and nowhere else, and on the cluster it arrives through envFrom, which
// is injected when the container starts. There is no way to start challenging
// without a restart, and that restart runs the guard with the switch no longer
// 'off'. The last test here is that boot.
//
// WHAT IS ACTUALLY LOST, recorded so nobody has to re-derive it: with the switch
// off, the rate rule (three submissions in a window) and the first-time-submitter
// rule can still fire, and their verdict is discarded. A verified submitter can
// therefore fill the review queue up to the batch caps, and the answer to that is
// the admin block plus the review gate, not a challenge.

import assert from 'node:assert/strict'
import test from 'node:test'

import { CONFIG_EXTRA_REQUIREMENTS } from '../config.mjs'
import { assertSafeConfig } from '../lib/env-guard.mjs'
import { createTurnstile } from '../lib/turnstile.mjs'

/** A production-shaped config with every required key EXCEPT the Turnstile pair. */
function productionConfig({ turnstileSwitch, siteKey, secretKey } = {}) {
  const turnstile = { mode: 'production', switch: turnstileSwitch }
  if (siteKey !== undefined) turnstile.siteKey = siteKey
  if (secretKey !== undefined) turnstile.secretKey = secretKey

  return {
    nodeEnv: 'production',
    server: { port: 8080, host: '0.0.0.0', logLevel: 'info', trustProxy: 1 },
    database: { file: '/srv/shared/joi.db', instanceMode: 'production' },
    storage: {
      dataDir: '/srv/shared',
      mediaDir: '/srv/shared/media',
      catalogFile: '/srv/shared/catalog.json',
      stagingDir: '/srv/shared/incoming',
      themeCssFile: '/srv/shared/theme.css',
      wallpaperDir: '/srv/shared/wallpaper',
    },
    limits: { maxClipsPerBatch: 10, maxFileBytes: 5 * 1024 * 1024 },
    danmaku: {
      mode: 'production',
      roomId: 3622717,
      appId: 1787439765162,
      accessKeyId: 'k'.repeat(24),
      accessKeySecret: 's'.repeat(32),
      roomOwnerAuthCode: 'a'.repeat(32),
      codeTtlMinutes: 10,
    },
    turnstile,
    session: { secret: 'x'.repeat(43), ttlHours: 720, allowPlainHttp: false },
    admin: { openIds: ['open-owner'] },
  }
}

// extraRequirements is passed the way server.mjs passes it. Without it the base
// roster does not carry session.secret or danmaku.roomOwnerAuthCode, and a test
// that omitted it would be asserting against a weaker guard than the one that
// actually runs — which is how the "nothing else was relaxed" case below first
// failed for a reason that had nothing to do with the change.
const clear = (config) =>
  assertSafeConfig(config, {
    nodeEnv: 'production',
    instanceMode: 'production',
    env: {},
    extraRequirements: CONFIG_EXTRA_REQUIREMENTS,
  })

function problemPaths(run) {
  try {
    run()
    return null
  } catch (error) {
    return (error.problems ?? []).map((p) => p.path)
  }
}

test('a production process boots with the challenge OFF and no Turnstile keys at all', () => {
  // The deployment the owner actually asked for. Before this change it threw
  // with turnstile.siteKey/secretKey missing, so the site could not start.
  const report = clear(productionConfig({ turnstileSwitch: 'off' }))
  assert.ok(report, 'the guard refused a production config that has nothing left to refuse')

  // It boots AND it says so. The switch is registered in BYPASS_FLAGS at
  // 'announce' severity — not 'refuse' — which is the distinction that lets this
  // deployment exist while still putting it on the health document and in the
  // X-Joi-Bypass header. I asserted zero entries here at first, which was a
  // guess about a roster I had not read.
  const announced = report.bypasses.filter((b) => b.path === 'turnstile.switch')
  assert.equal(announced.length, 1, JSON.stringify(report.bypasses))
  assert.equal(announced[0].severity, 'announce')
  // And nothing at refuse severity got through, which is the property that
  // matters: an announced operator switch is not a development bypass.
  assert.deepEqual(report.bypasses.filter((b) => b.severity === 'refuse'), [])
})

test('the same config still builds the real verifier, which needs no secret to exist', () => {
  const config = productionConfig({ turnstileSwitch: 'off' })
  clear(config)
  const turnstile = createTurnstile(config.turnstile)
  // The switch decides at rule 1, before anything that would need a credential.
  const verdict = turnstile.required({
    submitter: { acceptedCount: 0, rejectedCount: 0, blocked: 0 },
    recent: { submissions: 99, windowMinutes: 60 },
  })
  assert.equal(verdict.required, false, 'the switch did not short-circuit')
  assert.equal(verdict.reason, 'operator-switch-off')
  // A brand-new submitter at 99 submissions in the window is the strongest case
  // the rule list has for challenging somebody. If THAT is not challenged, the
  // switch is genuinely in front of every rule.
})

for (const position of ['auto', 'always']) {
  test(`with the switch at "${position}", the keys are required again and BOTH are named`, () => {
    const paths = problemPaths(() => clear(productionConfig({ turnstileSwitch: position })))
    assert.ok(paths, `the guard accepted a production config that can challenge with no keys (${position})`)
    assert.ok(paths.includes('turnstile.siteKey'), paths.join())
    assert.ok(paths.includes('turnstile.secretKey'), paths.join())
  })
}

test('this is the restart that catches turning challenges back on', () => {
  // TURNSTILE_SWITCH is read at boot and nowhere else, and on the cluster it
  // arrives through envFrom — injected when the container starts. So the only
  // way from "off, no keys" to "challenging" is a restart, and the restart is
  // this call. There is no window where a visitor is asked to solve a widget the
  // deployment cannot verify.
  const off = productionConfig({ turnstileSwitch: 'off' })
  assert.ok(clear(off), 'the off configuration should boot')

  const turnedOn = productionConfig({ turnstileSwitch: 'auto' })
  const paths = problemPaths(() => clear(turnedOn))
  assert.deepEqual(
    paths.filter((p) => p.startsWith('turnstile.')).sort(),
    ['turnstile.secretKey', 'turnstile.siteKey'],
  )
})

test('switching off does NOT relax anything else — the danmaku credentials are still required', () => {
  // The narrowing has to be exactly one requirement wide. A guard that quietly
  // stopped asking for the identity credentials too would let a production
  // instance boot with no way to verify anybody, which is the opposite of the
  // decision being encoded.
  const config = productionConfig({ turnstileSwitch: 'off' })
  delete config.danmaku.roomOwnerAuthCode
  delete config.session.secret

  const paths = problemPaths(() => clear(config))
  assert.ok(paths, 'the guard accepted a production config with no auth code and no session secret')
  assert.ok(paths.includes('session.secret'), paths.join())
  assert.ok(paths.includes('danmaku.roomOwnerAuthCode'), paths.join())
  // And NOT the turnstile keys, which is what makes this test about the narrowing
  // rather than about the guard in general.
  assert.equal(paths.some((p) => p.startsWith('turnstile.')), false, paths.join())
})

test('a development bypass is still refused in production, switch or no switch', () => {
  // The switch is an operator control, not a bypass, and this is the line
  // between them: it must not have become a way to run the always-pass verifier.
  const config = productionConfig({ turnstileSwitch: 'off' })
  config.turnstile.mode = 'development'
  assert.throws(() => clear(config), /production/i)
})

test('verify() refuses if it is ever reached without a secret, so the invariant only moved', async () => {
  // The construction check used to carry this. Moving it means the property has
  // to be asserted where it now lives, or narrowing the constructor would have
  // simply deleted a safety check.
  const config = productionConfig({ turnstileSwitch: 'off' })
  clear(config)
  const turnstile = createTurnstile(config.turnstile)
  await assert.rejects(() => turnstile.verify('some-token', '203.0.113.9'), /no secretKey/)
})

test('a production verifier that CAN challenge still refuses to be built without a secret', async () => {
  // The other direction. If this passed, the narrowing would have removed the
  // check rather than conditioned it.
  const config = productionConfig({ turnstileSwitch: 'auto', siteKey: 'site' })
  assert.throws(() => createTurnstile({ ...config.turnstile, mode: 'production' }), /secretKey/)
})
