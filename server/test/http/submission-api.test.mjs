import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import test from 'node:test'

import sharp from 'sharp'

import { STORAGE_RESERVE_BYTES } from '../../lib/storage-guard.mjs'
import {
  OWNER,
  VISITOR,
  anItem,
  boot,
  get,
  login,
  metadata,
  postForm,
  postJson,
  seedGroup,
  wav,
} from './harness.mjs'

function uploadParts(key = 'a') {
  return [
    metadata([anItem({ key })]),
    { name: `file:${key}`, filename: `${key}.wav`, value: wav() },
  ]
}

async function issueApiToken(ctx, client = 'joi-test', identity = VISITOR) {
  // The API route deliberately waits for the room listener before returning a
  // phrase. The development transport's zero-latency start still uses the
  // injected clock, so drive it while the request is waiting.
  const pending = postJson(ctx.app, '/api/auth/challenge', { body: { client } })
  await ctx.clock.tick()
  await ctx.clock.advance(1)
  const started = await pending
  assert.equal(started.statusCode, 200, started.payload)
  const challenge = started.json()
  assert.equal(challenge.state, 'waiting')
  assert.equal(typeof challenge.challenge, 'string')

  ctx.danmaku.control.emitDanmaku({
    openId: identity.openId,
    displayName: identity.displayName,
    text: challenge.challenge,
  })
  await ctx.clock.advance(1)

  const polled = await postJson(ctx.app, '/api/auth/poll', { body: { pollToken: challenge.pollToken } })
  assert.equal(polled.statusCode, 200, polled.payload)
  assert.equal(polled.json().state, 'verified')
  return { challenge, response: polled, token: polled.json().token }
}

test('the public contract exposes the live limits and the common sixty-second rate gate', async (t) => {
  const ctx = await boot(t)
  seedGroup(ctx.db, { id: 'voices-core', displayName: 'Voices' })
  const cookie = await login(ctx, VISITOR)

  const contract = await get(ctx.app, '/api/submit/contract')
  assert.equal(contract.statusCode, 200)
  assert.equal(contract.json().contractVersion, 1)
  assert.equal(contract.json().limits.batchesPerMinute, 1)
  assert.equal(contract.json().groups.some((group) => group.id === 'voices-core'), true)
  assert.deepEqual(contract.json().locales.map((locale) => locale.code), ['en-US', 'zh-CN', 'ja-JP'])

  const preflight = await get(ctx.app, '/api/submit/preflight', { cookie })
  assert.equal(preflight.statusCode, 200, preflight.payload)
  assert.equal(preflight.json().rate.allowed, true)

  const first = await postForm(ctx.app, '/api/submit', { cookie, parts: uploadParts() })
  assert.equal(first.statusCode, 200, first.payload)
  assert.equal(first.json().accepted, 1)

  const blocked = await get(ctx.app, '/api/submit/preflight', { cookie })
  assert.equal(blocked.statusCode, 200)
  assert.equal(blocked.json().rate.allowed, false, blocked.payload)
  assert.ok(blocked.json().rate.retryAfterSeconds >= 1)

  const second = await postForm(ctx.app, '/api/submit', { cookie, parts: uploadParts('b') })
  assert.equal(second.statusCode, 429, second.payload)
  assert.equal(second.headers['retry-after'], String(second.json().retryAfterSeconds))
  assert.equal(second.json().error, 'rate_limited')
})

test('API challenge, Bearer resolution, user-agent binding, one-time polling and revoke work end to end', async (t) => {
  const ctx = await boot(t)
  const issued = await issueApiToken(ctx, 'automation-client')
  const token = issued.token

  const session = ctx.db.prepare("SELECT kind, client_label, token_issued_at FROM sessions WHERE kind = 'api'").get()
  assert.deepEqual(session, { kind: 'api', client_label: 'automation-client', token_issued_at: '2026-08-01T00:00:00Z' })

  const noAgent = await get(ctx.app, '/api/me', {
    headers: { authorization: `Bearer ${token}`, 'user-agent': '' },
  })
  assert.equal(noAgent.statusCode, 400)
  assert.equal(noAgent.json().error.code, 'user_agent_required')

  const me = await get(ctx.app, '/api/me', {
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'joi-test/1.0' },
  })
  assert.equal(me.statusCode, 200, me.payload)
  assert.equal(me.json().submitter.openId, VISITOR.openId)

  const adminToken = (await issueApiToken(ctx, 'owner-automation', OWNER)).token
  const apiAsCookie = await get(ctx.app, '/api/admin/queue', { cookie: `joi_session=${adminToken}` })
  assert.equal(apiAsCookie.statusCode, 404)
  const apiAsBearer = await get(ctx.app, '/api/admin/queue', {
    headers: { authorization: `Bearer ${adminToken}`, 'user-agent': 'joi-test/1.0' },
  })
  assert.equal(apiAsBearer.statusCode, 404)

  const replay = await postJson(ctx.app, '/api/auth/poll', { body: { pollToken: issued.challenge.pollToken } })
  assert.equal(replay.statusCode, 409)
  assert.equal(replay.json().error.code, 'token_already_issued')

  const cookie = await login(ctx, VISITOR)
  const invalidWithCookie = await get(ctx.app, '/api/me', {
    cookie,
    headers: { authorization: 'Bearer not-a-token', 'user-agent': 'joi-test/1.0' },
  })
  assert.equal(invalidWithCookie.statusCode, 401)
  assert.equal(invalidWithCookie.json().error.code, 'invalid_api_token')
  assert.equal(invalidWithCookie.json().submitter, undefined)

  const revoked = await postJson(ctx.app, '/api/auth/revoke', {
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'joi-test/1.0' },
  })
  assert.equal(revoked.statusCode, 200)
  assert.equal(revoked.json().revoked, true)

  const after = await get(ctx.app, '/api/me', {
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'joi-test/1.0' },
  })
  assert.equal(after.statusCode, 401)
  assert.equal(after.json().error.code, 'invalid_api_token')
})

test('an API token is rejected after its fixed thirty-day lifetime', async (t) => {
  const ctx = await boot(t)
  const issued = await issueApiToken(ctx, 'expiry-client')

  await ctx.clock.advance(30 * 24 * 60 * 60 * 1000)
  const expired = await get(ctx.app, '/api/me', {
    headers: { authorization: `Bearer ${issued.token}`, 'user-agent': 'joi-test/1.0' },
  })
  assert.equal(expired.statusCode, 401)
  assert.equal(expired.json().error.code, 'invalid_api_token')
})

test('API submissions keep their source channel and the admin storage card is read-only evidence', async (t) => {
  const ctx = await boot(t)
  seedGroup(ctx.db, { id: 'voices-core', displayName: 'Voices' })
  const issued = await issueApiToken(ctx, 'nightly-import')

  const submitted = await postForm(ctx.app, '/api/submit', {
    headers: { authorization: `Bearer ${issued.token}`, 'user-agent': 'joi-test/1.0' },
    parts: uploadParts(),
  })
  assert.equal(submitted.statusCode, 200, submitted.payload)

  const webCookie = await login(ctx, VISITOR)
  const crossChannel = await postForm(ctx.app, '/api/submit', { cookie: webCookie, parts: uploadParts('b') })
  assert.equal(crossChannel.statusCode, 429)
  assert.equal(crossChannel.json().error, 'rate_limited')

  const ownerCookie = await login(ctx, OWNER)
  const queue = await get(ctx.app, '/api/admin/queue', { cookie: ownerCookie })
  assert.equal(queue.statusCode, 200, queue.payload)
  assert.deepEqual(queue.json().batches[0].source, { channel: 'api', clientClaim: 'nightly-import' })

  const storage = await get(ctx.app, '/api/admin/storage', { cookie: ownerCookie })
  assert.equal(storage.statusCode, 200, storage.payload)
  assert.equal(storage.json().storage.reserveBytes, STORAGE_RESERVE_BYTES)
  assert.equal(storage.json().storage.inflightBytes, 0)
  assert.equal(typeof storage.json().storage.availableBytes, 'number')
  assert.equal(typeof storage.json().reclaimable.count, 'number')
})

test('API tokens cap at five active credentials and revoke-all spends a fresh danmaku proof', async (t) => {
  const ctx = await boot(t)
  const issued = []
  for (let index = 0; index < 6; index += 1) {
    if (index > 0) await ctx.clock.advance(1_000)
    issued.push(await issueApiToken(ctx, `cap-client-${index}`))
  }

  const oldest = ctx.db.prepare("SELECT id FROM sessions WHERE kind = 'api' AND client_label = 'cap-client-0'").get()
  assert.equal(issued[5].response.json().revokedOldest.id, oldest.id)
  assert.equal(issued[5].response.json().revokedOldest.clientLabel, 'cap-client-0')
  assert.equal(
    ctx.db.prepare("SELECT count(*) AS n FROM sessions WHERE kind = 'api' AND token_issued_at IS NOT NULL AND revoked_at IS NULL").get().n,
    5,
  )

  const oldToken = issued[0].token
  const oldResponse = await get(ctx.app, '/api/me', {
    headers: { authorization: `Bearer ${oldToken}`, 'user-agent': 'joi-test/1.0' },
  })
  assert.equal(oldResponse.statusCode, 401)

  const challengePending = postJson(ctx.app, '/api/auth/revoke-all', { body: {} })
  await ctx.clock.tick()
  await ctx.clock.advance(1_000)
  const challenge = await challengePending
  assert.equal(challenge.statusCode, 200, challenge.payload)
  assert.equal(challenge.json().action, 'revoke-all')
  ctx.danmaku.control.emitDanmaku({
    openId: VISITOR.openId,
    displayName: VISITOR.displayName,
    text: challenge.json().challenge,
  })
  await ctx.clock.advance(1)

  const revoked = await postJson(ctx.app, '/api/auth/revoke-all', {
    body: { pollToken: challenge.json().pollToken },
  })
  assert.equal(revoked.statusCode, 200, revoked.payload)
  assert.equal(revoked.json().revoked, 5)

  for (const credential of issued.slice(1)) {
    const response = await get(ctx.app, '/api/me', {
      headers: { authorization: `Bearer ${credential.token}`, 'user-agent': 'joi-test/1.0' },
    })
    assert.equal(response.statusCode, 401)
  }
  const replay = await postJson(ctx.app, '/api/auth/revoke-all', {
    body: { pollToken: challenge.json().pollToken },
  })
  assert.equal(replay.statusCode, 401)
  assert.equal(replay.json().error.code, 'expired_poll_token')
})

test('low storage refuses public and admin uploads before disk writes, while reclaim stays available', async (t) => {
  const calls = { reserve: 0, release: 0 }
  const storageGuard = {
    async reserve() {
      calls.reserve += 1
      return { allowed: false }
    },
    release() {
      calls.release += 1
    },
    async snapshot() {
      return {
        totalBytes: 1_000,
        usedBytes: 900,
        availableBytes: 100,
        reserveBytes: STORAGE_RESERVE_BYTES,
        inflightBytes: 0,
        refusing: true,
        lastRefusalAt: '2026-08-01T00:00:00Z',
      }
    },
  }
  const ctx = await boot(t, { storageGuard })
  seedGroup(ctx.db, { id: 'voices-core', displayName: 'Voices' })
  const visitor = await login(ctx, VISITOR)
  const owner = await login(ctx, OWNER)
  const before = existsSync(ctx.paths.stagingDir) ? readdirSync(ctx.paths.stagingDir).sort() : []

  const submission = await postForm(ctx.app, '/api/submit', { cookie: visitor, parts: uploadParts() })
  assert.equal(submission.statusCode, 503)
  assert.equal(submission.json().error, 'storage_exhausted')
  const after = existsSync(ctx.paths.stagingDir) ? readdirSync(ctx.paths.stagingDir).sort() : []
  assert.deepEqual(after, before)

  const picture = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#fedcae' } }).png().toBuffer()
  const wallpaper = await postForm(ctx.app, '/api/admin/theme/wallpaper', {
    cookie: owner,
    parts: [{ name: 'file', filename: 'wallpaper.png', value: picture }],
  })
  assert.equal(wallpaper.statusCode, 503)
  assert.equal(wallpaper.json().error.code, 'storage_exhausted')

  const reclaim = await postJson(ctx.app, '/api/admin/reclaim', { cookie: owner })
  assert.equal(reclaim.statusCode, 200, reclaim.payload)
  assert.equal(calls.reserve, 2)
  assert.equal(calls.release, 0)
})
