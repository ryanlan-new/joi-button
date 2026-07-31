// SPDX-License-Identifier: MIT
//
// POST /api/submit, over the assembled server: who may reach it, what the
// challenge costs, and what happens to the other four clips when one of them is
// bad.
//
// The Turnstile double here is a PRODUCTION-mode verifier with an injected
// fetch (see harness.mjs). That matters for one case in particular: the
// development verifier returns its verdict before it ever reaches the
// single-use token map, so a replay test run against it would pass with the
// whole reservation deleted.

import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'

import { PUBLIC_REASONS } from '../../routes/public.mjs'
import {
  VISITOR,
  anItem,
  boot,
  cookieOf,
  get,
  login,
  metadata,
  postForm,
  seedGroup,
  wav,
  wavOfBytes,
  PNG,
} from './harness.mjs'

const MiB = 1024 * 1024

/** The state of the shared directory: what landed, and what was left behind. */
function onDisk(mediaDir) {
  if (!existsSync(mediaDir)) return { entries: [], temp: [] }
  const entries = readdirSync(mediaDir).sort()
  const tempDir = join(mediaDir, 'tmp')
  return { entries, temp: existsSync(tempDir) ? readdirSync(tempDir) : [] }
}

async function ready(t, options = {}) {
  const ctx = await boot(t, options)
  seedGroup(ctx.db, { id: 'voices-core', displayName: 'Core' })
  const cookie = await login(ctx, VISITOR)
  return { ...ctx, cookie }
}

// ---------------------------------------------------------------------------
// identity

test('submitting without an identity is refused, and a session that has not verified yet is not an identity', async (t) => {
  const ctx = await boot(t, { turnstileSwitch: 'off' })
  seedGroup(ctx.db, { id: 'voices-core', displayName: 'Core' })
  const { app, db, clock } = ctx

  const anonymous = await postForm(app, '/api/submit', {
    parts: [metadata([anItem()]), { name: 'file:a', filename: 'a.wav', value: wav() }],
  })
  assert.equal(anonymous.statusCode, 401)
  assert.equal(anonymous.json().error.code, 'identity_required')
  assert.equal(anonymous.json().error.message, PUBLIC_REASONS.identity_required)

  // A session exists — the cookie is real and the row is in `sessions` — and it
  // is still not an identity: submitter_id is null until a danmaku carrying the
  // code arrives. Submission REQUIRES identity, and a session is not one.
  const started = await app.inject({ method: 'POST', url: '/api/login/start' })
  const cookie = cookieOf(started)
  await clock.advance(1)
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 1)
  assert.equal(db.prepare('SELECT submitter_id FROM sessions').get().submitter_id, null)

  const unverified = await postForm(app, '/api/submit', {
    cookie,
    parts: [metadata([anItem()]), { name: 'file:a', filename: 'a.wav', value: wav() }],
  })
  assert.equal(unverified.statusCode, 401)
  assert.equal(unverified.json().error.code, 'identity_required')

  for (const url of ['/api/submit/preflight', '/api/my/submissions']) {
    const answer = await get(app, url, { cookie })
    assert.equal(answer.statusCode, 401, url)
    assert.equal(answer.json().error.code, 'identity_required')
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM batches').get().n, 0)
})

// ---------------------------------------------------------------------------
// the challenge

test('a required challenge with no token is refused, hands back the site key, and persists nothing', async (t) => {
  const { app, db, cookie, paths, siteverifyCalls } = await ready(t)

  const answer = await postForm(app, '/api/submit', {
    cookie,
    parts: [metadata([anItem()]), { name: 'file:a', filename: 'a.wav', value: wav({ seconds: 2 }) }],
  })

  assert.equal(answer.statusCode, 403)
  assert.equal(answer.json().error.code, 'challenge_required')
  assert.equal(answer.json().error.message, PUBLIC_REASONS.challenge_required)
  // The key travels WITH the refusal: this is the race the preflight cannot
  // close, and making the visitor call it again to learn the key would be a
  // round trip for nothing.
  assert.equal(answer.json().error.siteKey, 'site-key-for-the-widget')

  assert.equal(siteverifyCalls.length, 0, 'siteverify was called for a token nobody sent')
  assert.equal(db.prepare('SELECT count(*) AS n FROM batches').get().n, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM media').get().n, 0)
  // Swept BEFORE the response, not after it: "gone by the time the submitter is
  // told" is checkable, "gone shortly afterwards" is not.
  assert.deepEqual(onDisk(paths.mediaDir).temp, [], 'the refused upload was left on disk')
})

test('the challenge is re-decided at submit time rather than taken from the client', async (t) => {
  // A submitter the rules would wave through — five accepted, nothing against
  // them — asks the preflight, and then crosses the rate threshold before
  // pressing submit. Trusting the preflight's answer skips the challenge.
  const { app, db, cookie } = await ready(t)
  db.prepare('UPDATE submitters SET approved_count = 5 WHERE open_id = ?').run(VISITOR.openId)

  const relaxed = (await get(app, '/api/submit/preflight', { cookie })).json()
  assert.equal(relaxed.challengeRequired, false)
  assert.equal(relaxed.reason, 'trusted-submitter')
  assert.equal(relaxed.siteKey, null, 'the site key was published to somebody who is not being challenged')

  // Three submissions inside the policy window is the rate rule's threshold.
  const submitterId = db.prepare('SELECT id FROM submitters WHERE open_id = ?').get(VISITOR.openId).id
  const insert = db.prepare(
    "INSERT INTO batches (id, submitter_id, state, created_at, submitted_at) VALUES (?, ?, 'submitted', ?, ?)",
  )
  for (const n of [1, 2, 3]) insert.run(`bat-rate-${n}`, submitterId, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')

  const answer = await postForm(app, '/api/submit', {
    cookie,
    parts: [metadata([anItem()]), { name: 'file:a', filename: 'a.wav', value: wav({ seconds: 2 }) }],
  })
  assert.equal(answer.statusCode, 403, answer.payload.slice(0, 300))
  assert.equal(answer.json().error.code, 'challenge_required')
})

test('a Turnstile token is single-use, and the replay is refused without asking Cloudflare a second time', async (t) => {
  const { app, db, cookie, siteverifyCalls } = await ready(t)

  const submit = (key, seconds) =>
    postForm(app, '/api/submit', {
      cookie,
      parts: [
        metadata([anItem({ key })]),
        { name: 'turnstileToken', value: 'one-shot-token' },
        { name: `file:${key}`, filename: `${key}.wav`, value: wav({ seconds }) },
      ],
    })

  const first = await submit('a', 2)
  assert.equal(first.statusCode, 200, first.payload.slice(0, 300))
  assert.deepEqual(first.json().turnstile, { required: true, verdict: 'passed' })
  assert.equal(siteverifyCalls.length, 1)

  const replayed = await submit('b', 3)
  assert.equal(replayed.statusCode, 403, replayed.payload.slice(0, 300))
  assert.equal(replayed.json().error.code, 'challenge_failed')
  assert.equal(replayed.json().error.detail, 'replayed')
  // The token was burned at RESERVATION, before the first network call, so the
  // replay never reaches siteverify. Marking it after a successful response
  // leaves a window in which two requests carrying one token are both in
  // flight — and that window is exactly what a replay is.
  assert.equal(siteverifyCalls.length, 1, 'the replay was sent to siteverify instead of being refused here')

  assert.equal(db.prepare('SELECT count(*) AS n FROM batches').get().n, 1, 'the replayed submission was stored')
  assert.equal(db.prepare('SELECT count(*) AS n FROM batch_items').get().n, 1)
})

test('two submissions racing with one token: exactly one lands', async (t) => {
  // The case the sequential replay above CANNOT distinguish. Marking a token
  // spent after a successful response instead of before the request leaves a
  // window in which two requests carrying one token are both in flight — and
  // that window is exactly what a replay is. Sequentially the two are
  // indistinguishable, because the first has already come back.
  //
  // The window is held open on purpose: the first request to reach siteverify
  // parks there until a second one arrives, or for 300ms if none ever does
  // (which is what a correct implementation produces, because the second request
  // is refused before it can get here).
  let arrived = 0
  let openTheWindow
  const secondArrived = new Promise((resolve) => {
    openTheWindow = resolve
  })

  const { app, db, cookie, siteverifyCalls } = await ready(t, {
    siteverify: async () => {
      arrived += 1
      if (arrived >= 2) openTheWindow()
      await Promise.race([secondArrived, sleep(300)])
      return { success: true, hostname: 'localhost' }
    },
  })

  const submit = (key, seconds) =>
    postForm(app, '/api/submit', {
      cookie,
      parts: [
        metadata([anItem({ key })]),
        { name: 'turnstileToken', value: 'the-only-token' },
        { name: `file:${key}`, filename: `${key}.wav`, value: wav({ seconds }) },
      ],
    })

  const settled = []
  const track = (name, sent) =>
    sent.then((answer) => {
      settled.push({ name, status: answer.statusCode })
      return answer
    })

  const [left, right] = await Promise.all([
    track('left', submit('left', 2)),
    track('right', submit('right', 3)),
  ])
  const statuses = [left.statusCode, right.statusCode].sort()

  assert.deepEqual(
    statuses,
    [200, 403],
    `both halves of the race were answered ${statuses.join(' and ')}; one token bought two submissions`,
  )
  const refusal = (left.statusCode === 403 ? left : right).json()
  assert.equal(refusal.error.code, 'challenge_failed')
  assert.equal(refusal.error.detail, 'replayed')
  assert.equal(db.prepare('SELECT count(*) AS n FROM batches').get().n, 1)
  assert.equal(siteverifyCalls.length, 1, 'the same token was presented to siteverify twice')
  assert.equal(arrived, 1)

  // THE OVERLAP GUARD. The loser came back FIRST — while the winner was still
  // parked inside siteverify — which is what makes this a race rather than the
  // sequential replay above wearing a different hat. If the two had not
  // overlapped, the winner would have finished before the loser started and the
  // 200/403 split above would prove nothing new.
  assert.equal(
    settled[0].status,
    403,
    'the two submissions did not overlap: the refusal arrived after the submission it was racing',
  )
})

test('a development Turnstile pass is recorded as bypassed and can never be read as a real verdict', async (t) => {
  const { app, db, cookie } = await ready(t, { turnstile: 'development' })

  const answer = await postForm(app, '/api/submit', {
    cookie,
    parts: [
      metadata([anItem()]),
      { name: 'turnstileToken', value: 'anything-at-all' },
      { name: 'file:a', filename: 'a.wav', value: wav({ seconds: 2 }) },
    ],
  })
  assert.equal(answer.statusCode, 200, answer.payload.slice(0, 300))
  assert.equal(answer.json().turnstile.verdict, 'bypassed')
  assert.deepEqual(db.prepare('SELECT turnstile_required, turnstile_verdict FROM batches').get(), {
    turnstile_required: 1,
    turnstile_verdict: 'bypassed',
  })
})

// ---------------------------------------------------------------------------
// the envelope limits

test('an eleventh file is refused by the framework, and not one of the ten before it lands', async (t) => {
  const { app, db, cookie, paths } = await ready(t, { turnstileSwitch: 'off' })

  const parts = [metadata(Array.from({ length: 11 }, (_, i) => anItem({ key: `k${i}` })))]
  for (let i = 0; i < 11; i += 1) {
    parts.push({ name: `file:k${i}`, filename: `${i}.wav`, value: wav({ seconds: 0.25 }) })
  }

  const answer = await postForm(app, '/api/submit', { cookie, parts })
  assert.equal(answer.statusCode, 413, answer.payload.slice(0, 300))
  // The RULED cap, named. The multipart `parts` limit is set above files+fields
  // precisely so that this is not reported as a rule the submitter has never
  // heard of.
  assert.equal(answer.json().error.code, 'too_many_files')
  assert.equal(answer.json().error.message, PUBLIC_REASONS.too_many_files)

  // busboy aborts the iteration with ten temp files already drained to disk. A
  // partial landing would be ten blobs on the volume and no row that names them
  // — an orphan no janitor can find, because v_unreferenced_media cannot see a
  // file with no media row.
  assert.equal(db.prepare('SELECT count(*) AS n FROM batches').get().n, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM batch_items').get().n, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM media').get().n, 0)
  const disk = onDisk(paths.mediaDir)
  assert.deepEqual(disk.temp, [], 'the drained parts of a refused batch were left on the volume')
  assert.deepEqual(
    disk.entries.filter((entry) => entry !== 'tmp'),
    [],
    'a content-addressed blob landed for a batch that was refused whole',
  )
})

test('a 6 MB file is refused and loses only itself', async (t) => {
  const { app, db, cookie, paths } = await ready(t, { turnstileSwitch: 'off' })
  const oversized = wavOfBytes(6_000_000)
  assert.ok(oversized.length > 5 * MiB, 'the fixture is not actually over the ruled ceiling')

  const answer = await postForm(app, '/api/submit', {
    cookie,
    parts: [
      metadata([anItem({ key: 'ok' }), anItem({ key: 'big' })]),
      { name: 'file:ok', filename: 'ok.wav', value: wav({ seconds: 2 }) },
      { name: 'file:big', filename: 'big.wav', value: oversized },
    ],
  })

  assert.equal(answer.statusCode, 200, answer.payload.slice(0, 300))
  const items = Object.fromEntries(answer.json().items.map((item) => [item.key, item]))
  assert.equal(items.big.state, 'rejected')
  assert.equal(items.big.code, 'file_too_large')
  assert.equal(items.big.message, PUBLIC_REASONS.file_too_large)
  // The per-item rule is a property of this ROUTE, not of whoever registered
  // @fastify/multipart: app.mjs registers it with throwFileSizeLimit true, under
  // which one oversized file throws and takes its neighbours with it.
  assert.equal(items.ok.state, 'pending')

  const media = db.prepare('SELECT bytes FROM media').all()
  assert.equal(media.length, 1, 'the truncated prefix of an oversized file was stored')
  assert.ok(media[0].bytes < 5 * MiB)
  assert.deepEqual(onDisk(paths.mediaDir).temp, [])
})

test('a file whose bytes are not audio is refused however it is named', async (t) => {
  const { app, db, cookie } = await ready(t, { turnstileSwitch: 'off' })

  const answer = await postForm(app, '/api/submit', {
    cookie,
    parts: [
      metadata([anItem({ key: 'png' })]),
      // music-metadata's parseFile() TRUSTS a path's extension, so the route
      // streams to a temp file with NO extension and classifies on the bytes.
      // Believing this name again would store a PNG as audio/mpeg.
      { name: 'file:png', filename: 'totally-a-song.mp3', value: PNG },
    ],
  })

  assert.equal(answer.statusCode, 422, answer.payload.slice(0, 300))
  assert.equal(answer.json().error.code, 'no_valid_items')
  assert.equal(answer.json().items[0].code, 'unsupported_audio_format')
  assert.equal(answer.json().items[0].message, PUBLIC_REASONS.unsupported_audio_format)
  // No batch at all: batches_resolve_needs_all_items_resolved makes an empty one
  // unresolvable for the life of the database, so it would sit in 'submitted'
  // forever waiting for items that are never coming.
  assert.equal(db.prepare('SELECT count(*) AS n FROM batches').get().n, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM media').get().n, 0)
})

// ---------------------------------------------------------------------------
// per item

test('item 3 failing leaves items 1, 2, 4 and 5 stored, and every item is answered for by name', async (t) => {
  const { app, db, cookie, paths } = await ready(t, { turnstileSwitch: 'off' })

  const items = [1, 2, 3, 4, 5].map((n) => anItem({ key: `k${n}`, name: `Clip ${n}` }))
  const parts = [metadata(items)]
  for (const n of [1, 2, 3, 4, 5]) {
    parts.push({
      name: `file:k${n}`,
      filename: `${n}.wav`,
      // Item 3 is a PNG. Every part is still drained to its end: abandoning one
      // makes busboy stop parsing, which would silently drop items 4 and 5.
      value: n === 3 ? PNG : wav({ seconds: n / 2 }),
    })
  }

  const answer = await postForm(app, '/api/submit', { cookie, parts })
  assert.equal(answer.statusCode, 200, answer.payload.slice(0, 400))
  const body = answer.json()

  assert.equal(body.accepted, 4)
  assert.equal(body.rejected, 1)
  // Every item, answered by its own key — not a count of failures.
  assert.deepEqual(
    body.items.map((item) => [item.key, item.state]),
    [['k1', 'pending'], ['k2', 'pending'], ['k3', 'rejected'], ['k4', 'pending'], ['k5', 'pending']],
  )
  const failed = body.items[2]
  assert.equal(failed.code, 'unsupported_audio_format')
  assert.ok(failed.message.length > 0, 'a per-item refusal carried a code with no sentence beside it')

  // The submitter's own numbering, holes and all: compacting to 1..4 would hide
  // which of the five did not make it.
  assert.deepEqual(
    db.prepare('SELECT position FROM batch_items ORDER BY position').all().map((row) => row.position),
    [1, 2, 4, 5],
  )
  assert.equal(db.prepare('SELECT count(*) AS n FROM media').get().n, 4)
  for (const row of db.prepare('SELECT storage_path FROM media').all()) {
    assert.ok(
      existsSync(join(paths.mediaDir, row.storage_path)),
      `a media row points at bytes that are not there: ${row.storage_path}`,
    )
  }
  assert.deepEqual(onDisk(paths.mediaDir).temp, [])

  // …and the submitter is told the same thing when they come back for it.
  const mine = (await get(app, '/api/my/submissions', { cookie })).json()
  assert.deepEqual(
    mine.submissions[0].items.map((item) => [item.position, item.name]),
    [[1, 'Clip 1'], [2, 'Clip 2'], [4, 'Clip 4'], [5, 'Clip 5']],
  )
})
