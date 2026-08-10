import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  VISITOR,
  anItem,
  boot,
  cookieOf,
  get,
  login,
  metadata,
  multipart,
  postForm,
  postJson,
  seedGroup,
  wav,
  PNG,
} from './harness.mjs'

const CHANNELS = Object.freeze(['cookie', 'bearer'])

/** The API challenge is deliberately driven in the same way as the product. */
async function issueApiToken(ctx, client, identity = VISITOR, { text = (value) => value } = {}) {
  const pending = postJson(ctx.app, '/api/auth/challenge', { body: { client } })
  await ctx.clock.tick()
  await ctx.clock.advance(1)
  const challenge = await pending
  assert.equal(challenge.statusCode, 200, challenge.payload)
  const body = challenge.json()
  assert.equal(body.state, 'waiting')

  ctx.danmaku.control.emitDanmaku({
    openId: identity.openId,
    displayName: identity.displayName,
    text: text(body.challenge),
  })
  await ctx.clock.advance(1)

  const polled = await postJson(ctx.app, '/api/auth/poll', { body: { pollToken: body.pollToken } })
  assert.equal(polled.statusCode, 200, polled.payload)
  assert.equal(polled.json().state, 'verified')
  return { token: polled.json().token, challenge: body }
}

async function authenticate(ctx, channel, identity = VISITOR, options = {}) {
  if (channel === 'cookie') return { cookie: await login(ctx, identity) }
  const issued = await issueApiToken(ctx, `inc015-${channel}`, identity, options)
  return { headers: { authorization: `Bearer ${issued.token}`, 'user-agent': 'inc015-test/1.0' } }
}

function itemFiles(keys, { badKey } = {}) {
  return keys.map((key, index) => ({
    name: `file:${key}`,
    filename: `${key}.${key === badKey ? 'png' : 'wav'}`,
    value: key === badKey ? PNG : wav({ seconds: 0.5 + index / 2 }),
  }))
}

function fullWidthDigits(value) {
  return `【 ${value.replace(/[0-9]/g, (digit) => String.fromCodePoint(digit.codePointAt(0) + 0xfee0))} 】`
}

test('INC-015: item 3 failure preserves items 1, 2, 4 and 5 on both channels', async (t) => {
  for (const channel of CHANNELS) {
    const ctx = await boot(t)
    seedGroup(ctx.db, { id: 'voices-core', displayName: 'Voices' })
    const auth = await authenticate(ctx, channel)
    const items = [1, 2, 3, 4, 5].map((position) => anItem({ key: `k${position}`, name: `Clip ${position}` }))
    const response = await postForm(ctx.app, '/api/submit', {
      ...auth,
      parts: [metadata(items), ...itemFiles(['k1', 'k2', 'k3', 'k4', 'k5'], { badKey: 'k3' })],
    })
    const body = response.json()

    assert.equal(response.statusCode, 200, `${channel}: ${response.payload}`)
    assert.equal(body.accepted, 4)
    assert.equal(body.rejected, 1)
    assert.equal(body.items.find((item) => item.key === 'k3').code, 'unsupported_audio_format')
    assert.deepEqual(
      ctx.db.prepare('SELECT position FROM batch_items ORDER BY position').all().map((row) => row.position),
      [1, 2, 4, 5],
    )
  }
})

test('INC-015: duplicate media in one batch is rejected on both channels', async (t) => {
  for (const channel of CHANNELS) {
    const ctx = await boot(t)
    seedGroup(ctx.db, { id: 'voices-core', displayName: 'Voices' })
    const auth = await authenticate(ctx, channel)
    const bytes = wav({ seconds: 2 })
    const response = await postForm(ctx.app, '/api/submit', {
      ...auth,
      parts: [
        metadata([anItem({ key: 'a' }), anItem({ key: 'b' })]),
        { name: 'file:a', filename: 'a.wav', value: bytes },
        { name: 'file:b', filename: 'b.wav', value: bytes },
      ],
    })

    assert.equal(response.statusCode, 200, `${channel}: ${response.payload}`)
    assert.equal(response.json().accepted, 1)
    assert.equal(response.json().items.find((item) => item.key === 'b').code, 'duplicate_in_batch')
  }
})

test('INC-015: an already-published input sha is rejected on both channels', async (t) => {
  for (const channel of CHANNELS) {
    const ctx = await boot(t)
    seedGroup(ctx.db, { id: 'grp-a', displayName: 'Baseline' })
    const auth = await authenticate(ctx, channel)
    const bytes = wav({ seconds: 2 })
    const sha = createHash('sha256').update(bytes).digest('hex')
    ctx.db.prepare(
      'INSERT INTO media (sha256, ext, content_type, bytes, duration_seconds, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(sha, 'wav', 'audio/wav', bytes.length, 2, '2026-08-01T00:00:00Z')
    ctx.db.prepare(
      'INSERT INTO clips (id, group_id, media_sha256, label, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('clip-baseline', 'grp-a', sha, 'Baseline', '2026-08-01T00:00:00Z')

    const response = await postForm(ctx.app, '/api/submit', {
      ...auth,
      parts: [metadata([anItem()]), { name: 'file:a', filename: 'a.wav', value: bytes }],
    })
    assert.equal(response.statusCode, 422, `${channel}: ${response.payload}`)
    assert.equal(response.json().items[0].code, 'already_published')
  }
})

test('INC-015: a blocked submitter receives a classified 403 on both channels', async (t) => {
  for (const channel of CHANNELS) {
    const ctx = await boot(t)
    seedGroup(ctx.db, { id: 'voices-core', displayName: 'Voices' })
    const auth = await authenticate(ctx, channel)
    ctx.db.prepare('UPDATE submitters SET blocked = 1, blocked_at = ?, blocked_reason = ?').run(
      '2026-08-01T00:00:00Z',
      'spam',
    )

    const response = await postForm(ctx.app, '/api/submit', {
      ...auth,
      parts: [metadata([anItem()]), { name: 'file:a', filename: 'a.wav', value: wav() }],
    })
    assert.equal(response.statusCode, 403, `${channel}: ${response.payload}`)
    assert.equal(response.json().error.code, 'submitter_blocked')
  }
})

test('INC-015: multipart limits retain specific error codes on both channels', async (t) => {
  for (const channel of CHANNELS) {
    const ctx = await boot(t)
    const auth = await authenticate(ctx, channel)

    const elevenFiles = [metadata([anItem()])]
    for (let index = 0; index < 11; index += 1) {
      elevenFiles.push({ name: `file:k${index}`, filename: `${index}.wav`, value: wav({ seconds: 0.25 }) })
    }
    const tooManyFiles = await postForm(ctx.app, '/api/submit', { ...auth, parts: elevenFiles })
    assert.equal(tooManyFiles.statusCode, 413, `${channel}: ${tooManyFiles.payload}`)
    assert.equal(tooManyFiles.json().error.code, 'too_many_files')

    const tooManyFields = await postForm(ctx.app, '/api/submit', {
      ...auth,
      parts: Array.from({ length: 65 }, (_, index) => ({ name: `field-${index}`, value: 'x' })),
    })
    assert.equal(tooManyFields.statusCode, 400, `${channel}: ${tooManyFields.payload}`)
    assert.equal(tooManyFields.json().error.code, 'too_many_fields')

    const body = multipart([metadata([anItem()]), { name: 'file:a', filename: 'a.wav', value: wav() }])
    const malformed = await ctx.app.inject({
      method: 'POST',
      url: '/api/submit',
      headers: { ...auth.headers, ...(auth.cookie === undefined ? {} : { cookie: auth.cookie }), 'content-type': body.contentType },
      payload: body.payload.subarray(0, body.payload.length - 400),
    })
    assert.equal(malformed.statusCode, 400, `${channel}: ${malformed.payload}`)
    assert.equal(malformed.json().error.code, 'malformed_multipart')
  }
})

test('INC-015: submitter text is stored in escaped form on both channels', async (t) => {
  for (const channel of CHANNELS) {
    const ctx = await boot(t)
    seedGroup(ctx.db, { id: 'voices-core', displayName: 'Voices' })
    const auth = await authenticate(ctx, channel)
    const response = await postForm(ctx.app, '/api/submit', {
      ...auth,
      parts: [
        metadata([anItem({ name: 'cost is {price}', caption: { locale: 'en-US', text: 'left|right' } })]),
        { name: 'file:a', filename: 'a.wav', value: wav({ seconds: 2 }) },
      ],
    })
    assert.equal(response.statusCode, 200, `${channel}: ${response.payload}`)
    const stored = ctx.db.prepare('SELECT proposed_label, submitter_note FROM batch_items').get()
    assert.equal(stored.proposed_label, 'cost is ｛price｝')
    assert.deepEqual(JSON.parse(stored.submitter_note).caption, { locale: 'en-US', text: 'left｜right' })
  }
})

test('INC-015: one submitter cannot read another submitter history on either channel', async (t) => {
  const other = Object.freeze({ openId: 'open-other', displayName: 'Other' })
  for (const channel of CHANNELS) {
    const ctx = await boot(t)
    seedGroup(ctx.db, { id: 'voices-core', displayName: 'Voices' })
    const first = await authenticate(ctx, channel, VISITOR)
    const firstResponse = await postForm(ctx.app, '/api/submit', {
      ...first,
      parts: [metadata([anItem({ name: 'Visitor clip' })]), { name: 'file:a', filename: 'a.wav', value: wav() }],
    })
    assert.equal(firstResponse.statusCode, 200, `${channel}: ${firstResponse.payload}`)

    const second = await authenticate(ctx, channel, other)
    const secondResponse = await postForm(ctx.app, '/api/submit', {
      ...second,
      parts: [metadata([anItem({ name: 'Other clip' })]), { name: 'file:a', filename: 'a.wav', value: wav({ seconds: 2 }) }],
    })
    assert.equal(secondResponse.statusCode, 200, `${channel}: ${secondResponse.payload}`)

    const history = await get(ctx.app, '/api/my/submissions', first)
    assert.equal(history.statusCode, 200, `${channel}: ${history.payload}`)
    assert.equal(history.json().submissions.length, 1)
    assert.equal(history.json().submissions[0].items[0].name, 'Visitor clip')
  }
})

test('INC-015: preflight, submit and history reject without identity on both channels', async (t) => {
  for (const channel of CHANNELS) {
    const ctx = await boot(t)
    for (const url of ['/api/submit/preflight', '/api/my/submissions']) {
      const response = await get(ctx.app, url)
      assert.equal(response.statusCode, 401, `${channel} ${url}: ${response.payload}`)
      assert.equal(response.json().error.code, 'identity_required')
    }

    const response = await postForm(ctx.app, '/api/submit', {
      parts: [metadata([anItem()]), { name: 'file:a', filename: 'a.wav', value: wav() }],
    })
    assert.equal(response.statusCode, 401, `${channel} submit: ${response.payload}`)
    assert.equal(response.json().error.code, 'identity_required')

    const invalid = channel === 'bearer'
      ? { headers: { authorization: 'Bearer not-a-real-token', 'user-agent': 'inc015-test/1.0' } }
      : { cookie: 'joi_session=not-a-session' }
    const invalidPreflight = await get(ctx.app, '/api/submit/preflight', invalid)
    assert.equal(invalidPreflight.statusCode, 401)
    assert.equal(invalidPreflight.json().error.code, channel === 'bearer' ? 'invalid_api_token' : 'identity_required')
  }
})

test('INC-015: verification waits for listening and folds full-width IME digits on both channels', async (t) => {
  for (const channel of CHANNELS) {
    const ctx = await boot(t)
    ctx.danmaku.control.setStartLatencyMs(5000)

    if (channel === 'cookie') {
      const started = await ctx.app.inject({ method: 'POST', url: '/api/login/start' })
      const cookie = cookieOf(started)
      assert.equal(started.json().state, 'preparing')
      assert.equal(started.json().code, undefined)
      await ctx.clock.advance(1000)
      const opening = await get(ctx.app, `/api/login/status?token=${started.json().pollToken}`, { cookie })
      assert.equal(opening.json().state, 'preparing')
      assert.equal(opening.json().code, undefined)
      await ctx.clock.advance(4000)
      const live = await get(ctx.app, `/api/login/status?token=${started.json().pollToken}`, { cookie })
      assert.equal(live.json().state, 'waiting')
      ctx.danmaku.control.emitDanmaku({ openId: VISITOR.openId, displayName: VISITOR.displayName, text: fullWidthDigits(live.json().code) })
      await ctx.clock.advance(1)
      assert.equal((await get(ctx.app, '/api/login/status', { cookie })).json().state, 'verified')
    } else {
      const pending = postJson(ctx.app, '/api/auth/challenge', { body: { client: 'inc015-timing' } })
      await ctx.clock.tick()
      await ctx.clock.advance(1000)
      assert.equal(ctx.danmaku.status().listening, false)
      assert.equal(ctx.db.prepare("SELECT count(*) AS n FROM verify_codes WHERE state = 'pending'").get().n, 0)
      await ctx.clock.advance(4000)
      await ctx.clock.tick()
      const challenge = await pending
      assert.equal(challenge.statusCode, 200, challenge.payload)
      const body = challenge.json()
      ctx.danmaku.control.emitDanmaku({ openId: VISITOR.openId, displayName: VISITOR.displayName, text: fullWidthDigits(body.challenge) })
      await ctx.clock.advance(1)
      const polled = await postJson(ctx.app, '/api/auth/poll', { body: { pollToken: body.pollToken } })
      assert.equal(polled.statusCode, 200, polled.payload)
      assert.equal(polled.json().state, 'verified')
    }
    assert.equal(ctx.danmaku.status().waiters, 0, `${channel}: verification did not return its lease`)
  }
})

test('INC-015: verification leases are returned on success and cancellation on both channels', async (t) => {
  // Cookie has an explicit cancellation route; Bearer has the same lease
  // release on its successful challenge path. Both are asserted in the loop so
  // the shared room source cannot be accidentally covered only by web login.
  for (const channel of CHANNELS) {
    const ctx = await boot(t)
    if (channel === 'cookie') {
      const started = await ctx.app.inject({ method: 'POST', url: '/api/login/start' })
      const cookie = cookieOf(started)
      await ctx.clock.advance(1)
      assert.equal(ctx.danmaku.status().waiters, 1)
      const cancelled = await ctx.app.inject({ method: 'POST', url: '/api/login/cancel', headers: { cookie } })
      assert.equal(cancelled.json().cancelled, true)
      assert.equal(ctx.danmaku.status().waiters, 0)

      const verifiedCookie = await login(ctx, VISITOR)
      assert.ok(verifiedCookie)
      assert.equal(ctx.danmaku.status().waiters, 0)
    } else {
      await issueApiToken(ctx, 'inc015-lease', VISITOR)
      assert.equal(ctx.danmaku.status().waiters, 0)
    }
  }
})
