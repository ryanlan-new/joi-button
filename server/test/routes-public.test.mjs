// The visitor-facing API: identity through the live room, the on-demand
// challenge, the batch upload, and the submitter's own history.
//
// Two things this file is built around, because both are cases where a green
// test would otherwise mean nothing:
//
//   1. THE DEVELOPMENT DANMAKU SOURCE IS DRIVEN, NOT MERELY PRESENT. Its start
//      latency, its failure mode and its mid-wait disconnect are all set from
//      here. "The code is not shown before the socket is listening" cannot fail
//      against a source that is listening before you finish asking, and "never
//      tell a visitor who did everything right that they are probably muted"
//      cannot fail against a source that never drops. Both guards would sit green
//      forever, never having been evaluated in a world where they could be false.
//
//   2. THE AUDIO FIXTURES ARE REAL BYTES. A WAV built by hand, a genuine MPEG
//      Layer III elementary stream, a genuine MPEG Layer II one, and a PNG. The
//      Layer II fixture is the whole point of the Layer 3 test in classifyAudio:
//      it reports `container: 'MPEG'` with a plausible duration and is not an
//      mp3, so a classifier that stops at the container stores it on the PVC
//      under an extension that lies about it. Without that fixture the test
//      passes with the check deleted.
//
// The refusals are enumerated rather than sampled: every reason code this route
// can answer with has a case here that makes it answer with it, and every one of
// them is checked to carry a human sentence beside the code.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import Fastify from 'fastify'

import { createDanmakuSource } from '../lib/danmaku-source.mjs'
import { createLoudnessNormalizer } from '../lib/loudness.mjs'
import { createTurnstile } from '../lib/turnstile.mjs'
import publicRoutes, { LOGIN_STATES, PUBLIC_REASONS, readSubmitterNote } from '../routes/public.mjs'
import { createTestClock } from './helpers/clock.mjs'
import { clearedConfig } from './helpers/config.mjs'
import { openDatabase } from './helpers/temp-db.mjs'

const T0 = '2026-08-01T00:00:00Z'
const ROOM_ID = 3622717

// ---------------------------------------------------------------------------
// Fixtures

/** A RIFF/WAVE file of exactly the requested length, built byte by byte. */
function wav({ sampleRate = 8000, seconds = 1, channels = 1, bits = 8 } = {}) {
  const blockAlign = channels * (bits / 8)
  const dataLength = Math.round(sampleRate * seconds) * blockAlign
  const buffer = Buffer.alloc(44 + dataLength)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataLength, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * blockAlign, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bits, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataLength, 40)
  buffer.fill(128, 44)
  return buffer
}

/**
 * An MPEG-1 audio elementary stream.
 *
 * `layerBits` is the two-bit layer field: 01 is Layer III (an mp3), 10 is
 * Layer II (an .mp2). Both parse, both report container 'MPEG', both have a real
 * duration — and only one of them is a file this site may store.
 */
function mpeg({ layerBits, frames = 40 }) {
  const frameLength = Math.floor((144 * 128000) / 44100)
  const out = []
  for (let i = 0; i < frames; i += 1) {
    const frame = Buffer.alloc(frameLength)
    frame[0] = 0xff
    // sync | version 11 (MPEG-1) | layer | protection 1 (no CRC)
    frame[1] = 0xe0 | (0b11 << 3) | (layerBits << 1) | 1
    frame[2] = 8 << 4 // 128 kbps, 44100 Hz, no padding
    frame[3] = 0xc0 // mono
    out.push(frame)
  }
  return Buffer.concat(out)
}

// A REAL mp3 for the should-succeed paths, encoded here by the same ffmpeg the
// normalizer spawns. It used to be mpeg({ layerBits: 0b01 }) — crafted frames
// with zeroed side info — which music-metadata's sniff accepts but no decoder
// can play. The loudness step decodes every accepted upload, so those bytes
// now land where they always belonged: rejected, as audio_processing_failed.
// That is the pipeline getting STRICTER (a formerly publishable undecodable
// blob no longer is), and the fixture for "a good mp3" has to actually be one.
// -20 dB so the normalizer has real gain to apply rather than a no-op.
const MP3 = await (async () => {
  const dir = mkdtempSync(join(tmpdir(), 'joi-mp3-fixture-'))
  const path = join(dir, 'tone.mp3')
  await promisify(execFile)('ffmpeg', [
    '-hide_banner', '-nostats',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=0.4',
    '-af', 'volume=-20dB',
    '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3',
    path,
  ])
  const bytes = readFileSync(path)
  rmSync(dir, { recursive: true, force: true })
  return bytes
})()
// The Layer II stream STAYS crafted: its whole point is to be refused by
// classifyAudio's Layer 3 test — upstream of any decoder — and crafted frames
// are exactly good enough to reach that check.
const MP2 = mpeg({ layerBits: 0b10 })
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(512, 7)])

// ---------------------------------------------------------------------------
// Harness

function multipart(parts) {
  const boundary = `----joi${Math.random().toString(36).slice(2)}`
  const chunks = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`))
    chunks.push(
      Buffer.from(
        part.filename === undefined
          ? `Content-Disposition: form-data; name="${part.name}"\r\n\r\n`
          : `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            'Content-Type: application/octet-stream\r\n\r\n',
      ),
    )
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(String(part.value)))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}

// Cookie AND content-type assembled in one place. Spreading a multipart result
// over a `headers` object silently replaces it, which costs eleven tests their
// session and reports it as identity_required.
function post(app, url, { cookie, parts }) {
  const body = multipart(parts)
  const headers = { 'content-type': body.contentType }
  if (cookie !== undefined) headers.cookie = cookie
  return app.inject({ method: 'POST', url, headers, payload: body.payload })
}

function cookieOf(response) {
  const raw = response.headers['set-cookie']
  const one = Array.isArray(raw) ? raw[0] : raw
  return one === undefined ? null : one.split(';')[0]
}

/**
 * A migrated database, a hand-driven clock, and the plugin wired to both.
 *
 * The database is stamped 'development' so the dev doubles are constructable and
 * so a 'bypassed' verdict is writable — on a production database schema.sql
 * refuses that row outright, which is the layer under the one this file tests.
 */
async function boot(
  t,
  { turnstileSwitch = 'auto', simulate, roomId = ROOM_ID, maxFileBytes, maxPendingCodes } = {},
) {
  const db = openDatabase(t, { mode: 'development', now: T0 })
  // dataDir with media/ and incoming/ inside it, mirroring config.mjs's own
  // derivation. Staging is a SIBLING of the published tree, never a child: the
  // web pod serves mediaDir at /media/ with a one-year immutable label.
  const dataDir = mkdtempSync(join(tmpdir(), 'joi-public-media-'))
  const mediaDir = join(dataDir, 'media')
  const stagingDir = join(dataDir, 'incoming')
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))

  const clock = createTestClock(T0)
  const { config } = clearedConfig({
    storage: { mediaDir, stagingDir, catalogFile: join(dataDir, 'catalog.json') },
    ...(maxFileBytes === undefined ? {} : { limits: { maxClipsPerBatch: 10, maxFileBytes } }),
    danmaku: {
      mode: 'development',
      codeTtlMinutes: 10,
      clock,
      ...(roomId === null ? {} : { roomId }),
    },
    turnstile: {
      mode: 'development',
      switch: turnstileSwitch,
      ...(simulate === undefined ? {} : { development: { simulate } }),
    },
  })

  const source = createDanmakuSource(config.danmaku)
  const app = Fastify({ logger: false })
  await app.register(publicRoutes, {
    db,
    config,
    danmakuSource: source,
    turnstile: createTurnstile(config.turnstile),
    // The REAL normalizer, not a stand-in: these tests upload real (synthetic)
    // audio, and the pipeline's promise is that what lands in media/ is
    // re-encoded at the wall's loudness. A fake here would green-light a suite
    // whose sha/bytes/duration flow never met the code that computes them in
    // production. Costs the suite a working ffmpeg — which the API image has by
    // construction, and a dev machine gets with `brew install ffmpeg`.
    normalizer: createLoudnessNormalizer(),
    now: clock.now,
    ...(maxPendingCodes === undefined ? {} : { maxPendingCodes }),
  })
  await app.ready()
  t.after(() => app.close())

  return { app, db, source, clock, config, mediaDir, stagingDir }
}

/** Boot, log in through a real danmaku, and seed one group to file clips under. */
async function loggedIn(t, options = {}) {
  const context = await boot(t, options)
  const started = await context.app.inject({ method: 'POST', url: '/api/login/start' })
  const cookie = cookieOf(started)
  await context.clock.advance(1)
  const live = (
    await context.app.inject({ method: 'GET', url: '/api/login/status', headers: { cookie } })
  ).json()
  assert.equal(live.state, LOGIN_STATES.WAITING, 'the fixture could not obtain a code')
  context.source.control.emitDanmaku({ openId: 'open-sub', displayName: 'Sub', text: live.code })
  context.db
    .prepare('INSERT INTO groups (id, display_name, created_at) VALUES (?, ?, ?)')
    .run('grp-a', 'Alpha', T0)
  return { ...context, cookie }
}

const anItem = (overrides = {}) => ({
  key: 'a',
  name: 'Clip A',
  caption: { locale: 'zh-CN', text: '测试' },
  groupId: 'grp-a',
  ...overrides,
})

const metadata = (items) => ({ name: 'metadata', value: JSON.stringify({ items }) })

// ---------------------------------------------------------------------------
// login

test('the code is not handed over before the socket is listening', async (t) => {
  const { app, source, clock } = await boot(t)
  // Only observable because the double can be told to be slow. Against a source
  // that is ready instantly, this guard could never be evaluated in a world where
  // it could be false.
  source.control.setStartLatencyMs(5000)

  const started = await app.inject({ method: 'POST', url: '/api/login/start' })
  const opening = started.json()
  assert.equal(opening.state, LOGIN_STATES.PREPARING)
  assert.equal(opening.code, undefined, 'a code was issued while the socket was still opening')
  assert.equal(opening.roomId, ROOM_ID)
  const cookie = cookieOf(started)

  await clock.advance(1000)
  const midway = await app.inject({
    method: 'GET',
    url: `/api/login/status?token=${opening.pollToken}`,
    headers: { cookie },
  })
  assert.equal(midway.json().state, LOGIN_STATES.PREPARING)
  assert.equal(midway.json().code, undefined)

  await clock.advance(5000)
  const live = (
    await app.inject({
      method: 'GET',
      url: `/api/login/status?token=${opening.pollToken}`,
      headers: { cookie },
    })
  ).json()

  assert.equal(live.state, LOGIN_STATES.WAITING)
  assert.match(live.code, /^[A-Z0-9]{6}$/)
  assert.equal(live.canAssertNotSeen, true)
  // Asked at t=0, listening began at t=5, revealed at t=6. Only one of those
  // three is the ruled answer, and it is the middle one.
  assert.equal(live.issuedAt, '2026-08-01T00:00:05Z', 'the ten minutes did not start when listening began')
  assert.equal(live.expiresAt, '2026-08-01T00:10:05Z')
})

test('a visitor arriving while the socket is already open gets their own ten minutes', async (t) => {
  const { app, clock } = await boot(t)

  const first = await app.inject({ method: 'POST', url: '/api/login/start' })
  const cookieOne = cookieOf(first)
  await clock.advance(1)
  const liveOne = (
    await app.inject({ method: 'GET', url: '/api/login/status', headers: { cookie: cookieOne } })
  ).json()
  assert.equal(liveOne.issuedAt, T0)

  // Five minutes later the source is still listening, for somebody else.
  await clock.advance(5 * 60 * 1000)
  const second = await app.inject({ method: 'POST', url: '/api/login/start' })
  const cookieTwo = cookieOf(second)
  await clock.advance(1)
  const liveTwo = (
    await app.inject({ method: 'GET', url: '/api/login/status', headers: { cookie: cookieTwo } })
  ).json()

  assert.equal(liveTwo.state, LOGIN_STATES.WAITING)
  // Inheriting listeningSince here would hand this visitor five minutes instead
  // of ten, and would make status() read as continuous for a window they were
  // never in. The request time is the floor for exactly that reason.
  assert.equal(liveTwo.issuedAt, '2026-08-01T00:05:00Z', "the second visitor inherited the first one's clock")
  assert.equal(liveTwo.expiresAt, '2026-08-01T00:15:00Z')
  assert.equal(liveTwo.canAssertNotSeen, true)
})

test('a danmaku carrying the code verifies the session and gives the socket back', async (t) => {
  const { app, source, clock, db } = await boot(t)
  const started = await app.inject({ method: 'POST', url: '/api/login/start' })
  const cookie = cookieOf(started)
  await clock.advance(1)
  const live = (await app.inject({ method: 'GET', url: '/api/login/status', headers: { cookie } })).json()

  source.control.emitDanmaku({ openId: 'open-1', displayName: 'Viewer', text: `my code is ${live.code} !` })

  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/login/status', headers: { cookie } })).json().state,
    LOGIN_STATES.VERIFIED,
  )
  const me = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json()
  assert.equal(me.submitter.openId, 'open-1')
  assert.equal(me.submitter.displayName, 'Viewer')

  const row = db.prepare('SELECT state, verified_via, observed_open_id, consumed_at FROM verify_codes').get()
  assert.equal(row.state, 'verified')
  // Never 'dev-bypass': the development double delivers a real danmaku through
  // the real matcher, so the production path is what ran.
  assert.equal(row.verified_via, 'danmaku')
  assert.equal(row.observed_open_id, 'open-1')
  assert.equal(source.status().waiters, 0, 'the room lease survived a successful verification')
})

test('a code retyped on an IME, in the wrong case, still matches', async (t) => {
  const { app, source, clock } = await boot(t)
  const started = await app.inject({ method: 'POST', url: '/api/login/start' })
  const cookie = cookieOf(started)
  await clock.advance(1)
  const live = (await app.inject({ method: 'GET', url: '/api/login/status', headers: { cookie } })).json()

  // Fullwidth Ａ-Ｚ and ０-９, lowercased, wrapped in fullwidth brackets. To the
  // person typing it this is the code they were shown.
  const fullwidth = [...live.code].map((c) => String.fromCodePoint(c.codePointAt(0) + 0xfee0)).join('')
  source.control.emitDanmaku({ openId: 'open-2', displayName: 'IME', text: `【${fullwidth.toLowerCase()}】` })

  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/login/status', headers: { cookie } })).json().state,
    LOGIN_STATES.VERIFIED,
  )
})

test('a gap in our listening is never reported as "you have not sent it yet"', async (t) => {
  const { app, source, clock } = await boot(t)
  const started = await app.inject({ method: 'POST', url: '/api/login/start' })
  const cookie = cookieOf(started)
  await clock.advance(1)
  const read = async () =>
    (await app.inject({ method: 'GET', url: '/api/login/status', headers: { cookie } })).json()

  assert.equal((await read()).canAssertNotSeen, true)

  source.control.disconnect({ reason: 'simulated' })
  const down = await read()
  assert.equal(down.state, LOGIN_STATES.ROOM_UNREACHABLE, 'a deaf socket was reported as waiting')
  assert.equal(down.code.length, 6, 'the code was withdrawn, which makes the UI flicker for no reason')

  await clock.advance(2000) // the reconnect lands
  const recovered = await read()
  assert.equal(recovered.state, LOGIN_STATES.WAITING)
  // We ARE listening now, and there was a window in which we were not. A danmaku
  // sent during it is gone, and the visitor did nothing wrong.
  assert.equal(recovered.canAssertNotSeen, false, 'a gap in our listening was reported as continuous')
  assert.equal(recovered.resend, true)
})

test('a source that cannot start is room-unreachable and says so as its own state', async (t) => {
  const { app, source, clock } = await boot(t)
  source.control.setStartBehaviour('fail')

  const started = await app.inject({ method: 'POST', url: '/api/login/start' })
  const cookie = cookieOf(started)
  await clock.advance(1)

  const answer = (
    await app.inject({
      method: 'GET',
      url: `/api/login/status?token=${started.json().pollToken}`,
      headers: { cookie },
    })
  ).json()
  assert.equal(answer.state, LOGIN_STATES.ROOM_UNREACHABLE)
  assert.equal(answer.lastError, undefined, 'our own error text was handed to a visitor')
})

test('cancel releases the lease even when the start is still in flight', async (t) => {
  const { app, source, clock } = await boot(t)
  source.control.setStartLatencyMs(3000)

  const started = await app.inject({ method: 'POST', url: '/api/login/start' })
  const cancelled = await app.inject({
    method: 'POST',
    url: '/api/login/cancel',
    headers: { cookie: cookieOf(started) },
  })
  assert.equal(cancelled.json().cancelled, true)

  await clock.advance(4000)
  assert.equal(source.status().waiters, 0, 'a start nobody is waiting for pinned the room session')
})

test('a code that runs out of time reports expired and stops demanding a listener', async (t) => {
  const { app, source, clock, db } = await boot(t)
  const started = await app.inject({ method: 'POST', url: '/api/login/start' })
  const cookie = cookieOf(started)
  await clock.advance(1)
  await clock.advance(11 * 60 * 1000)

  const answer = (
    await app.inject({ method: 'GET', url: '/api/login/status', headers: { cookie } })
  ).json()
  assert.equal(answer.state, LOGIN_STATES.EXPIRED)
  assert.equal(db.prepare('SELECT state FROM verify_codes').get().state, 'expired')
  // v_room_demand is the reference count; a row left 'pending' would make it lie.
  assert.equal(db.prepare('SELECT count(*) AS n FROM v_room_demand').get().n, 0)
  assert.equal(source.status().waiters, 0)
})

test('a double-clicked button does not mint a second code', async (t) => {
  const { app, clock, db } = await boot(t)
  const first = await app.inject({ method: 'POST', url: '/api/login/start' })
  const cookie = cookieOf(first)
  await clock.advance(1)
  await app.inject({ method: 'POST', url: '/api/login/start', headers: { cookie } })
  await clock.advance(1)
  assert.equal(db.prepare('SELECT count(*) AS n FROM verify_codes').get().n, 1)
})

test("one session may not poll another session's token", async (t) => {
  const { app, clock } = await boot(t)
  const first = await app.inject({ method: 'POST', url: '/api/login/start' })
  const second = await app.inject({ method: 'POST', url: '/api/login/start' })
  assert.notEqual(cookieOf(first), cookieOf(second))

  const stolen = await app.inject({
    method: 'GET',
    url: `/api/login/status?token=${first.json().pollToken}`,
    headers: { cookie: cookieOf(second) },
  })
  assert.equal(stolen.statusCode, 404, "a token belonging to another browser was answered")
  assert.equal(stolen.json().error.code, 'unknown_poll_token')
  await clock.advance(1)
})

test('a deployment with no live room refuses to issue a code rather than invent one', async (t) => {
  // verify_codes.room_id records the room an identity was proved in, so that the
  // history survives the owner changing rooms. There is no honest value to write.
  const { app } = await boot(t, { roomId: null })
  const answer = await app.inject({ method: 'POST', url: '/api/login/start' })
  assert.equal(answer.statusCode, 503)
  assert.equal(answer.json().error.code, 'room_not_configured')
  assert.ok(answer.json().error.message.length > 0)
})

test('polling with no verification in progress is refused, not answered with a state', async (t) => {
  const { app } = await boot(t)
  // A browser that has never asked for a code has no verification to report on,
  // and "expired" would be a lie about something that never started.
  const answer = await app.inject({ method: 'GET', url: '/api/login/status' })
  assert.equal(answer.statusCode, 404)
  assert.equal(answer.json().error.code, 'no_verification_in_progress')
  assert.equal(answer.json().error.message, PUBLIC_REASONS.no_verification_in_progress)
})

test('the number of codes waiting at once is bounded', async (t) => {
  // Not a rate limit: the room socket is refcounted and stays at one however many
  // are waiting. This is what stops an endless supply of fresh cookies from
  // growing verify_codes without limit.
  const { app, clock } = await boot(t, { maxPendingCodes: 1 })
  await app.inject({ method: 'POST', url: '/api/login/start' })
  await clock.advance(1)

  const second = await app.inject({ method: 'POST', url: '/api/login/start' })
  assert.equal(second.statusCode, 503)
  assert.equal(second.json().error.code, 'verification_capacity')
  assert.equal(second.json().error.message, PUBLIC_REASONS.verification_capacity)
  await clock.advance(1)
})

test('logout revokes the session', async (t) => {
  const { app, cookie } = await loggedIn(t)
  assert.ok((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json().submitter)

  await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } })
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json().submitter,
    null,
  )
})

test('every lease this plugin took is given back when it closes', async (t) => {
  const { app, source, clock } = await boot(t)
  await app.inject({ method: 'POST', url: '/api/login/start' })
  await clock.advance(1)
  assert.equal(source.status().waiters, 1)

  await app.close()
  assert.equal(source.status().waiters, 0, 'a lease outlived the plugin that took it')
})

// ---------------------------------------------------------------------------
// preflight

test('preflight, submit and the history all refuse without an identity', async (t) => {
  const { app } = await boot(t)
  for (const url of ['/api/submit/preflight', '/api/my/submissions']) {
    const answer = await app.inject({ method: 'GET', url })
    assert.equal(answer.statusCode, 401, url)
    assert.equal(answer.json().error.code, 'identity_required')
    assert.ok(answer.json().error.message.length > 0)
  }
  const submitted = await post(app, '/api/submit', { parts: [metadata([anItem()])] })
  assert.equal(submitted.statusCode, 401)
  assert.equal(submitted.json().error.code, 'identity_required')
})

test('a submitter with nothing accepted yet is challenged, and the thresholds are not published', async (t) => {
  const { app, cookie } = await loggedIn(t)
  const answer = (
    await app.inject({ method: 'GET', url: '/api/submit/preflight', headers: { cookie } })
  ).json()

  assert.equal(answer.challengeRequired, true)
  assert.equal(answer.reason, 'submitter-history')
  // The rule that fired, never its evidence: the evidence carries the numbers,
  // and a probe that reports them is a probe that tunes against them.
  assert.equal(answer.evidence, undefined)
})

// ---------------------------------------------------------------------------
// submit

test('the challenge is re-decided at submit time, so a missing token is refused', async (t) => {
  const { app, cookie, db } = await loggedIn(t)
  const answer = await post(app, '/api/submit', {
    cookie,
    parts: [metadata([anItem()]), { name: 'file:a', filename: 'a.mp3', value: MP3 }],
  })

  assert.equal(answer.statusCode, 403)
  assert.equal(answer.json().error.code, 'challenge_required')
  assert.equal(db.prepare('SELECT count(*) AS n FROM batches').get().n, 0)
})

test('a development pass is recorded as bypassed and never as a real one', async (t) => {
  const { app, cookie, db } = await loggedIn(t)
  const answer = await post(app, '/api/submit', {
    cookie,
    parts: [
      metadata([anItem()]),
      { name: 'turnstileToken', value: 'anything-at-all' },
      { name: 'file:a', filename: 'a.mp3', value: MP3 },
    ],
  })

  assert.equal(answer.statusCode, 200, answer.payload)
  assert.equal(answer.json().turnstile.verdict, 'bypassed', 'a simulated pass was recorded as a real one')
  assert.deepEqual(db.prepare('SELECT turnstile_required, turnstile_verdict, state FROM batches').get(), {
    turnstile_required: 1,
    turnstile_verdict: 'bypassed',
    state: 'submitted',
  })
  assert.equal(db.prepare('SELECT submitted_count FROM submitters').get().submitted_count, 1)
})

test('a failed challenge refuses and persists nothing at all', async (t) => {
  const { app, cookie, db, mediaDir, stagingDir } = await loggedIn(t, { simulate: 'rejected' })
  const answer = await post(app, '/api/submit', {
    cookie,
    parts: [
      metadata([anItem()]),
      { name: 'turnstileToken', value: 'bad' },
      { name: 'file:a', filename: 'a.mp3', value: MP3 },
    ],
  })

  assert.equal(answer.statusCode, 403)
  assert.equal(answer.json().error.code, 'challenge_failed')
  assert.equal(db.prepare('SELECT count(*) AS n FROM batches').get().n, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM media').get().n, 0)
  assert.deepEqual((existsSync(stagingDir) ? readdirSync(stagingDir) : []), [], 'the refused upload was left on disk')
})

test('item 3 failing does not lose items 1, 2, 4 and 5', async (t) => {
  const { app, cookie, db, mediaDir, stagingDir } = await loggedIn(t, { turnstileSwitch: 'off' })
  const items = [1, 2, 3, 4, 5].map((n) => anItem({ key: `k${n}`, name: `Clip ${n}` }))
  const parts = [metadata(items)]
  for (const n of [1, 2, 4, 5]) {
    parts.push({ name: `file:k${n}`, filename: `${n}.wav`, value: wav({ seconds: n / 2 }) })
  }
  parts.splice(3, 0, { name: 'file:k3', filename: '3.mp3', value: PNG })

  const answer = await post(app, '/api/submit', { cookie, parts })
  const body = answer.json()

  assert.equal(answer.statusCode, 200, answer.payload)
  assert.equal(body.accepted, 4)
  assert.equal(body.rejected, 1)
  const failed = body.items.find((entry) => entry.key === 'k3')
  assert.equal(failed.state, 'rejected')
  assert.equal(failed.code, 'unsupported_audio_format')
  assert.ok(failed.message.length > 0)

  // The submitter's own numbering, holes and all. Compacting to 1..4 would hide
  // which of the five did not make it.
  assert.deepEqual(
    db.prepare('SELECT position FROM batch_items ORDER BY position').all().map((r) => r.position),
    [1, 2, 4, 5],
  )
  for (const row of db.prepare('SELECT storage_path FROM media').all()) {
    assert.ok(existsSync(join(mediaDir, row.storage_path)), `a media row points at bytes that are not there: ${row.storage_path}`)
  }
  // Swept before the response, not after it, so this is a fact and not a race.
  assert.deepEqual((existsSync(stagingDir) ? readdirSync(stagingDir) : []), [])
})

test('an oversized file loses only itself', async (t) => {
  const { app, cookie } = await loggedIn(t, { turnstileSwitch: 'off', maxFileBytes: 40_000 })
  const answer = await post(app, '/api/submit', {
    cookie,
    parts: [
      metadata([anItem({ key: 'small' }), anItem({ key: 'big' })]),
      { name: 'file:small', filename: 's.wav', value: wav({ seconds: 1 }) },
      { name: 'file:big', filename: 'b.wav', value: wav({ seconds: 30 }) },
    ],
  })

  const body = answer.json()
  assert.equal(answer.statusCode, 200, answer.payload)
  assert.equal(body.items.find((entry) => entry.key === 'big').code, 'file_too_large')
  assert.equal(body.items.find((entry) => entry.key === 'small').state, 'pending')
})

test('an mp3 is stored as audio/mpeg, and an MPEG Layer 2 stream is refused', async (t) => {
  const { app, cookie, db } = await loggedIn(t, { turnstileSwitch: 'off' })
  const answer = await post(app, '/api/submit', {
    cookie,
    parts: [
      metadata([anItem({ key: 'good' }), anItem({ key: 'mp2' })]),
      { name: 'file:good', filename: 'g.mp3', value: MP3 },
      { name: 'file:mp2', filename: 'm.mp3', value: MP2 },
    ],
  })

  const body = answer.json()
  assert.equal(body.items.find((entry) => entry.key === 'good').state, 'pending', answer.payload)
  // container 'MPEG', a real duration, and still not an mp3. A classifier that
  // stops at the container puts this on the PVC under an extension that lies.
  assert.equal(body.items.find((entry) => entry.key === 'mp2').code, 'unsupported_audio_format')

  const media = db.prepare('SELECT ext, content_type, storage_path FROM media').all()
  assert.deepEqual(media.map((row) => [row.ext, row.content_type]), [['mp3', 'audio/mpeg']])
  assert.match(media[0].storage_path, /^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.mp3$/)
})

test('the same file twice in one batch, and a blob that is already a clip, are both refused', async (t) => {
  const { app, cookie, db } = await loggedIn(t, { turnstileSwitch: 'off' })
  const bytes = wav({ seconds: 3 })

  const duplicated = await post(app, '/api/submit', {
    cookie,
    parts: [
      metadata([anItem({ key: 'a' }), anItem({ key: 'b' })]),
      { name: 'file:a', filename: 'a.wav', value: bytes },
      { name: 'file:b', filename: 'b.wav', value: bytes },
    ],
  })
  // UNIQUE (batch_id, media_sha256) would refuse this with a raw SQLite error at
  // the end of an otherwise successful submission.
  assert.equal(duplicated.json().items.find((entry) => entry.key === 'b').code, 'duplicate_in_batch')

  const sha = db.prepare('SELECT sha256 FROM media').get().sha256
  db.prepare('INSERT INTO clips (id, group_id, media_sha256, label, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('clip-x', 'grp-a', sha, 'X', T0)

  const again = await post(app, '/api/submit', {
    cookie,
    parts: [metadata([anItem({ key: 'c' })]), { name: 'file:c', filename: 'c.wav', value: bytes }],
  })
  // clips.media_sha256 is UNIQUE, so this could never become a second clip.
  assert.equal(again.json().items[0].code, 'already_published')
})

test('a blocked submitter is refused', async (t) => {
  const { app, cookie, db } = await loggedIn(t, { turnstileSwitch: 'off' })
  db.prepare('UPDATE submitters SET blocked = 1, blocked_at = ?, blocked_reason = ?').run(T0, 'spam')

  const answer = await post(app, '/api/submit', {
    cookie,
    parts: [metadata([anItem()]), { name: 'file:a', filename: 'a.wav', value: wav() }],
  })
  assert.equal(answer.statusCode, 403)
  assert.equal(answer.json().error.code, 'submitter_blocked')
})

test('every whole-request refusal answers with a code and a human sentence', async (t) => {
  const { app, cookie } = await loggedIn(t, { turnstileSwitch: 'off' })
  const cases = [
    [400, 'metadata_required', [{ name: 'x', value: '1' }]],
    [400, 'metadata_malformed', [{ name: 'metadata', value: 'not json' }]],
    // two items sharing one key: the document is ambiguous, not one item wrong
    [400, 'metadata_malformed', [metadata([anItem(), anItem()])]],
    [413, 'too_many_items', [metadata(Array.from({ length: 11 }, (_, i) => anItem({ key: `k${i}` })))]],
    [400, 'no_items', [metadata([])]],
    [422, 'no_valid_items', [metadata([anItem()]), { name: 'file:a', filename: 'a', value: PNG }]],
  ]

  for (const [status, code, parts] of cases) {
    const answer = await post(app, '/api/submit', { cookie, parts })
    assert.equal(answer.statusCode, status, `${code}: ${answer.payload.slice(0, 200)}`)
    assert.equal(answer.json().error.code, code)
    assert.equal(answer.json().error.message, PUBLIC_REASONS[code])
  }

  const wrongType = await app.inject({
    method: 'POST',
    url: '/api/submit',
    headers: { cookie, 'content-type': 'application/json' },
    payload: '{}',
  })
  assert.equal(wrongType.statusCode, 415)
  assert.equal(wrongType.json().error.code, 'multipart_required')
})

test('the multipart limits refuse as their own reasons rather than as a bare 400', async (t) => {
  const { app, cookie } = await loggedIn(t, { turnstileSwitch: 'off' })

  // An eleventh file. The ruled cap is 10, and busboy stops the whole request
  // rather than truncating one part, so this is a whole-request refusal.
  const eleven = [metadata([anItem()])]
  for (let i = 0; i < 11; i += 1) {
    eleven.push({ name: `file:k${i}`, filename: `${i}.wav`, value: wav({ seconds: 0.25 }) })
  }
  const tooMany = await post(app, '/api/submit', { cookie, parts: eleven })
  assert.equal(tooMany.statusCode, 413)
  assert.equal(tooMany.json().error.code, 'too_many_files')
  assert.equal(tooMany.json().error.message, PUBLIC_REASONS.too_many_files)

  const fields = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}`, value: 'x' }))
  const tooManyFields = await post(app, '/api/submit', { cookie, parts: fields })
  assert.equal(tooManyFields.statusCode, 400)
  assert.equal(tooManyFields.json().error.code, 'too_many_fields')

  // A body that stops before its closing boundary: busboy never emits 'finish',
  // so this has to end the iteration rather than hang it.
  const whole = multipart([metadata([anItem()]), { name: 'file:a', filename: 'a.wav', value: wav() }])
  const truncated = await app.inject({
    method: 'POST',
    url: '/api/submit',
    headers: { cookie, 'content-type': whole.contentType },
    payload: whole.payload.subarray(0, whole.payload.length - 400),
  })
  assert.equal(truncated.statusCode, 400, truncated.payload.slice(0, 200))
  assert.equal(truncated.json().error.code, 'malformed_multipart')
})

test('an item whose text does not fit the column it is stored in is refused, not truncated', async (t) => {
  const { app, cookie } = await loggedIn(t, { turnstileSwitch: 'off' })
  // Each field is inside its own cap; JSON escaping is what pushes the envelope
  // past submitter_note's 500. That is why the budget is MEASURED on the
  // serialised bytes rather than argued from the per-field limits.
  const answer = await post(app, '/api/submit', {
    cookie,
    parts: [
      metadata([anItem({ note: '\\'.repeat(200), newGroup: 'G'.repeat(120), groupId: null })]),
      { name: 'file:a', filename: 'a.wav', value: wav() },
    ],
  })
  const reported = answer.json().items[0]
  assert.equal(reported.code, 'note_too_long', answer.payload.slice(0, 300))
  assert.equal(reported.message, PUBLIC_REASONS.note_too_long)
})

test('every per-item refusal answers with a code and a human sentence', async (t) => {
  const { app, cookie, db } = await loggedIn(t, { turnstileSwitch: 'off' })
  db.prepare(
    'INSERT INTO groups (id, display_name, state, created_at, retired_at) VALUES (?, ?, ?, ?, ?)',
  ).run('grp-old', 'Old', 'retired', T0, T0)

  const good = { name: 'file:a', filename: 'a', value: wav() }
  const cases = [
    ['missing_file', [anItem()], []],
    ['empty_file', [anItem()], [{ name: 'file:a', filename: 'a', value: Buffer.alloc(0) }]],
    ['unreadable_audio', [anItem()], [{ name: 'file:a', filename: 'a', value: Buffer.from('plain text, not audio') }]],
    ['unsupported_audio_format', [anItem()], [{ name: 'file:a', filename: 'a', value: PNG }]],
    ['unreadable_duration', [anItem()], [{ name: 'file:a', filename: 'a', value: wav({ seconds: 0 }) }]],
    // vue-i18n reads this as a read of a message the submitter does not own
    ['invalid_name', [anItem({ name: 'shoutout to @:info.title' })], [good]],
    ['invalid_caption', [anItem({ caption: { locale: 'zh-CN', text: '   ' } })], [good]],
    ['unknown_locale', [anItem({ caption: { locale: 'xx-XX', text: 'hi' } })], [good]],
    // a retired group is refused as firmly as one that never existed
    ['unknown_group', [anItem({ groupId: 'grp-old' })], [good]],
    ['group_choice_required', [anItem({ groupId: null })], [good]],
    ['group_choice_ambiguous', [anItem({ newGroup: 'New' })], [good]],
    ['invalid_group_name', [anItem({ groupId: null, newGroup: 'a@:b.c' })], [good]],
    ['invalid_note', [anItem({ note: 'x'.repeat(400) })], [good]],
    ['metadata_missing', [anItem()], [good, { name: 'file:zz', filename: 'z', value: wav({ seconds: 2 }) }]],
  ]

  for (const [code, items, files] of cases) {
    const answer = await post(app, '/api/submit', { cookie, parts: [metadata(items), ...files] })
    const reported = (answer.json().items ?? []).find((entry) => entry.code === code)
    assert.ok(reported, `${code}: not reported — ${answer.payload.slice(0, 300)}`)
    assert.equal(reported.message, PUBLIC_REASONS[code])
    assert.equal(reported.state, 'rejected')
  }
})

test('submitter text is stored in the escaped form, not the raw one', async (t) => {
  const { app, cookie, db } = await loggedIn(t, { turnstileSwitch: 'off' })
  await post(app, '/api/submit', {
    cookie,
    parts: [
      metadata([anItem({ name: 'cost is {price}', caption: { locale: 'en-US', text: 'left|right' } })]),
      { name: 'file:a', filename: 'a.wav', value: wav({ seconds: 2 }) },
    ],
  })

  const row = db.prepare('SELECT proposed_label, submitter_note FROM batch_items').get()
  // Fullwidth look-alikes: vue-i18n 8 has no escape syntax, so substitution is
  // the only mechanism there is.
  assert.equal(row.proposed_label, 'cost is ｛price｝')
  assert.equal(readSubmitterNote(row.submitter_note).caption.text, 'left｜right')
})

// ---------------------------------------------------------------------------
// the submitter's own history

test('a submission comes back with its caption, its group proposal and its state', async (t) => {
  const { app, cookie } = await loggedIn(t, { turnstileSwitch: 'off' })
  await post(app, '/api/submit', {
    cookie,
    parts: [
      metadata([anItem({ groupId: null, newGroup: '新分类', note: '来自直播间' })]),
      { name: 'file:a', filename: 'a.wav', value: wav({ seconds: 2 }) },
    ],
  })

  const mine = (await app.inject({ method: 'GET', url: '/api/my/submissions', headers: { cookie } })).json()
  assert.equal(mine.submissions.length, 1)
  const item = mine.submissions[0].items[0]
  assert.equal(item.state, 'pending')
  assert.equal(item.name, 'Clip A')
  assert.deepEqual(item.caption, { locale: 'zh-CN', text: '测试' })
  // A proposal, never a row in `groups`: minting an active group from submitter
  // text would hand any verified visitor a lever on the catalogue's shape.
  assert.equal(item.proposedGroup, '新分类')
  assert.equal(item.groupId, null)
  assert.equal(item.note, '来自直播间')
  assert.equal(item.reviewerNote, null)
  assert.match(item.media.storagePath, /^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.wav$/)
})

test('a rejected item comes back carrying the sentence the reviewer had to write', async (t) => {
  const { app, cookie, db } = await loggedIn(t, { turnstileSwitch: 'off' })
  await post(app, '/api/submit', {
    cookie,
    parts: [metadata([anItem()]), { name: 'file:a', filename: 'a.wav', value: wav({ seconds: 2 }) }],
  })
  db.prepare('UPDATE batch_items SET state = ?, resolved_at = ?, reviewer_note = ?')
    .run('rejected', '2026-08-01T01:00:00Z', 'too quiet')

  const mine = (await app.inject({ method: 'GET', url: '/api/my/submissions', headers: { cookie } })).json()
  const item = mine.submissions[0].items[0]
  assert.equal(item.state, 'rejected')
  // "A refusal the submitter cannot read is a refusal nobody can appeal."
  assert.equal(item.reviewerNote, 'too quiet')
})

test('one submitter never sees another submitter\'s history', async (t) => {
  const { app, cookie, db, source, clock } = await loggedIn(t, { turnstileSwitch: 'off' })
  await post(app, '/api/submit', {
    cookie,
    parts: [metadata([anItem()]), { name: 'file:a', filename: 'a.wav', value: wav({ seconds: 2 }) }],
  })
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/my/submissions', headers: { cookie } })).json()
      .submissions.length,
    1,
  )

  const other = await app.inject({ method: 'POST', url: '/api/login/start' })
  const otherCookie = cookieOf(other)
  await clock.advance(1)
  const live = (
    await app.inject({ method: 'GET', url: '/api/login/status', headers: { cookie: otherCookie } })
  ).json()
  source.control.emitDanmaku({ openId: 'open-other', displayName: 'Other', text: live.code })

  const theirs = (
    await app.inject({ method: 'GET', url: '/api/my/submissions', headers: { cookie: otherCookie } })
  ).json()
  assert.deepEqual(theirs.submissions, [])
  assert.equal(db.prepare('SELECT count(*) AS n FROM submitters').get().n, 2)
})

// ---------------------------------------------------------------------------
// the module's own guard

// ---------------------------------------------------------------------------
// composition with the assembled server
//
// app.mjs registers @fastify/multipart at the ROOT and mints the session cookie
// itself, and its own header says the coupling between the two files is "held by
// this sentence alone" until an integration test logs in and then reaches an
// admin route. These are that test's first half.

async function assembled(t, { maxFileBytes = 5 * 1024 * 1024 } = {}) {
  const { createApp, createSessionCookie, SESSION_COOKIE_NAME } = await import('../app.mjs')
  const db = openDatabase(t, { mode: 'development', now: T0 })
  const dataDir = mkdtempSync(join(tmpdir(), 'joi-public-app-'))
  const mediaDir = join(dataDir, 'media')
  const stagingDir = join(dataDir, 'incoming')
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))

  const clock = createTestClock(T0)
  const { config } = clearedConfig({
    storage: { mediaDir, stagingDir, catalogFile: join(dataDir, 'catalog.json') },
    limits: { maxClipsPerBatch: 10, maxFileBytes },
    danmaku: { mode: 'development', roomId: ROOM_ID, codeTtlMinutes: 10, clock },
    turnstile: { mode: 'development', switch: 'off' },
  })
  // createApp asks for two sections env-guard's roster does not cover.
  const whole = {
    ...config,
    server: { trustProxy: false },
    session: { secret: 's'.repeat(32), ttlHours: 336, allowPlainHttp: true },
  }

  const danmaku = createDanmakuSource(config.danmaku)
  const app = createApp({
    config: whole,
    db,
    danmaku,
    turnstile: createTurnstile(config.turnstile),
    logger: false,
    report: { production: false, banner: null },
    routes: [
      { plugin: publicRoutes, options: { db, config: whole, danmakuSource: danmaku, turnstile: createTurnstile(config.turnstile), normalizer: createLoudnessNormalizer(), now: clock.now } },
    ],
  })
  await app.ready()
  t.after(() => app.close())
  return { app, db, danmaku, clock, mediaDir, stagingDir, createSessionCookie, cookieName: SESSION_COOKIE_NAME }
}

test('the plugin registers onto a server that already has multipart, and keeps its per-item rule there', async (t) => {
  // A second @fastify/multipart registration is FST_ERR_CTP_ALREADY_PRESENT at
  // boot — the whole app, not one route. And app.mjs registers it with
  // throwFileSizeLimit TRUE, under which one oversized file throws and takes the
  // rest of the batch with it, so the override has to travel per request.
  const { app, danmaku, clock, db } = await assembled(t, { maxFileBytes: 40_000 })

  const started = await app.inject({ method: 'POST', url: '/api/login/start' })
  const cookie = cookieOf(started)
  await clock.advance(1)
  const live = (await app.inject({ method: 'GET', url: '/api/login/status', headers: { cookie } })).json()
  danmaku.control.emitDanmaku({ openId: 'open-app', displayName: 'App', text: live.code })
  db.prepare('INSERT INTO groups (id, display_name, created_at) VALUES (?, ?, ?)').run('grp-a', 'Alpha', T0)

  const answer = await post(app, '/api/submit', {
    cookie,
    parts: [
      metadata([anItem({ key: 'small' }), anItem({ key: 'big' })]),
      { name: 'file:small', filename: 's.wav', value: wav({ seconds: 1 }) },
      { name: 'file:big', filename: 'b.wav', value: wav({ seconds: 30 }) },
    ],
  })
  assert.equal(answer.statusCode, 200, answer.payload.slice(0, 300))
  assert.equal(answer.json().items.find((entry) => entry.key === 'big').code, 'file_too_large')
  assert.equal(answer.json().items.find((entry) => entry.key === 'small').state, 'pending')
})

test('a session this route mints is one the rest of the server can read', async (t) => {
  const { app, db, createSessionCookie, cookieName } = await assembled(t)
  const started = await app.inject({ method: 'POST', url: '/api/login/start' })
  const header = started.headers['set-cookie']
  const value = (Array.isArray(header) ? header[0] : header).split(';')[0].slice(cookieName.length + 1)

  // Signed by the server's own minter, so app.mjs's parse() accepts it. An
  // unsigned value would be refused here while still hashing to a row admin.mjs
  // could find — the admin gate answering 404 to its owner.
  const service = createSessionCookie({ secret: 's'.repeat(32), secure: false, ttlHours: 336 })
  assert.equal(service.verify(value), true, 'the session cookie was not minted by this server')
  assert.equal(service.parse(`${cookieName}=${value}`), value)

  // And the sha256 of the WHOLE value is what the row holds, which is how any
  // module that hashes the raw cookie finds the same session.
  const row = db.prepare('SELECT id FROM sessions WHERE token_sha256 = ?').get(service.hash(value))
  assert.ok(row, 'hashing the cookie the way admin.mjs does did not find the session row')
})

test('a reason sentence carrying vue-i18n syntax cannot reach a deploy', () => {
  // The frontend renders these through $t. This file authored them, so they are
  // refused rather than escaped — the split env-guard.mjs draws between developer
  // text and observed text. Every sentence in the table is checked at import.
  for (const [code, sentence] of Object.entries(PUBLIC_REASONS)) {
    assert.doesNotMatch(sentence, /[{}|]/, `${code} carries an interpolation slot or a plural separator`)
    assert.doesNotMatch(sentence, /@(?:\.[A-Za-z]+)?:/, `${code} carries a linked message`)
    assert.ok(sentence.length > 0)
  }
})

test('readSubmitterNote answers all-nulls for a row that is not in the envelope shape', () => {
  // A note written by hand, or by something predating the envelope. The caller
  // wanted a caption, not an outage.
  for (const raw of [null, '', 'just a sentence', '{"caption":"wrong shape"}', '[]']) {
    assert.deepEqual(readSubmitterNote(raw), { caption: null, note: null, proposedGroup: null })
  }
})
