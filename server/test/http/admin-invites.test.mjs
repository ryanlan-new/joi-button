// SPDX-License-Identifier: MIT
//
// Online admin invitations, end to end through the assembled server.

import assert from 'node:assert/strict'
import test from 'node:test'

import { OWNER, boot, get, login, postJson } from './harness.mjs'

const CANDIDATE = { openId: 'open-candidate', displayName: 'Candidate' }

/** Create an invite and drive the room to listening, returning the live invite. */
async function openInvite(ctx, cookie) {
  const created = await postJson(ctx.app, '/api/admin/invites', { cookie })
  assert.equal(created.statusCode, 200, created.payload)
  const invite = created.json()
  assert.ok(invite.challengeText.includes('橘子'), `phrase should carry 橘子: ${invite.challengeText}`)
  assert.equal(invite.state, 'pending')

  // The lease is acquired in the background; a clock tick brings it to listening.
  await ctx.clock.advance(1)
  const live = (await get(ctx.app, `/api/admin/invites/${invite.id}`, { cookie })).json()
  assert.equal(live.listening, true, `room not listening: ${JSON.stringify(live)}`)
  return invite
}

test('the full invite: an admin opens it, a candidate claims it by danmaku, the admin confirms', async (t) => {
  const ctx = await boot(t)
  const ownerCookie = await login(ctx, OWNER)

  const invite = await openInvite(ctx, ownerCookie)

  // The candidate posts the phrase as a danmaku. It moves to 'claimed' and
  // records who claimed it — but does NOT make them an admin yet.
  ctx.danmaku.control.emitDanmaku({ ...CANDIDATE, text: invite.challengeText })
  await ctx.clock.advance(1)

  const claimed = (await get(ctx.app, `/api/admin/invites/${invite.id}`, { cookie: ownerCookie })).json()
  assert.equal(claimed.state, 'claimed')
  assert.equal(claimed.candidate.openId, CANDIDATE.openId)

  // Not an admin until the confirm: logging in as the candidate now shows a
  // non-admin, and the desk still 404s for them.
  const preConfirm = await login(ctx, CANDIDATE)
  assert.equal((await get(ctx.app, '/api/me', { cookie: preConfirm })).json().submitter.admin, false)
  assert.equal((await get(ctx.app, '/api/admin/admins', { cookie: preConfirm })).statusCode, 404)

  // The admin confirms.
  const confirmed = await postJson(ctx.app, `/api/admin/invites/${invite.id}/confirm`, { cookie: ownerCookie })
  assert.equal(confirmed.statusCode, 200, confirmed.payload)
  assert.equal(confirmed.json().openId, CANDIDATE.openId)

  // Now they ARE an admin, immediately — no redeploy. /api/me says so and the
  // desk answers them.
  const after = await login(ctx, CANDIDATE)
  assert.equal((await get(ctx.app, '/api/me', { cookie: after })).json().submitter.admin, true)
  assert.equal((await get(ctx.app, '/api/admin/admins', { cookie: after })).statusCode, 200)
})

test('the roster shows the seed as non-removable and the invited admin as removable', async (t) => {
  const ctx = await boot(t)
  const ownerCookie = await login(ctx, OWNER)
  const invite = await openInvite(ctx, ownerCookie)
  ctx.danmaku.control.emitDanmaku({ ...CANDIDATE, text: invite.challengeText })
  await ctx.clock.advance(1)
  await postJson(ctx.app, `/api/admin/invites/${invite.id}/confirm`, { cookie: ownerCookie })

  const roster = (await get(ctx.app, '/api/admin/admins', { cookie: ownerCookie })).json().admins
  const seed = roster.find((a) => a.openId === OWNER.openId)
  const invited = roster.find((a) => a.openId === CANDIDATE.openId)
  assert.equal(seed.source, 'seed')
  assert.equal(seed.removable, false)
  assert.equal(seed.you, true)
  assert.equal(invited.source, 'invite')
  assert.equal(invited.removable, true)
  assert.equal(invited.invitedBy, OWNER.openId)
})

test('a seed admin cannot be removed, and neither can the last admin', async (t) => {
  const ctx = await boot(t)
  const ownerCookie = await login(ctx, OWNER)

  // The seed (env) admin is refused outright.
  const seedTry = await postJson(ctx.app, `/api/admin/admins/${OWNER.openId}/revoke`, { cookie: ownerCookie })
  assert.equal(seedTry.statusCode, 403)
  assert.equal(seedTry.json().error, 'cannot_remove_seed_admin')

  // An open_id that is not an admin here is a 404, not a silent success.
  const ghost = await postJson(ctx.app, '/api/admin/admins/open-nobody/revoke', { cookie: ownerCookie })
  assert.equal(ghost.statusCode, 404)
})

test('an invited admin can be revoked, and loses the desk immediately', async (t) => {
  const ctx = await boot(t)
  const ownerCookie = await login(ctx, OWNER)
  const invite = await openInvite(ctx, ownerCookie)
  ctx.danmaku.control.emitDanmaku({ ...CANDIDATE, text: invite.challengeText })
  await ctx.clock.advance(1)
  await postJson(ctx.app, `/api/admin/invites/${invite.id}/confirm`, { cookie: ownerCookie })

  const candidateCookie = await login(ctx, CANDIDATE)
  assert.equal((await get(ctx.app, '/api/admin/admins', { cookie: candidateCookie })).statusCode, 200)

  const revoked = await postJson(ctx.app, `/api/admin/admins/${CANDIDATE.openId}/revoke`, { cookie: ownerCookie })
  assert.equal(revoked.statusCode, 200, revoked.payload)

  // The gate reads the table per request, so the very next call from the revoked
  // admin 404s.
  assert.equal((await get(ctx.app, '/api/admin/admins', { cookie: candidateCookie })).statusCode, 404)
  assert.equal((await get(ctx.app, '/api/me', { cookie: candidateCookie })).json().submitter.admin, false)
})

test('confirm refuses an invite nobody has claimed', async (t) => {
  const ctx = await boot(t)
  const ownerCookie = await login(ctx, OWNER)
  const invite = await openInvite(ctx, ownerCookie)

  const early = await postJson(ctx.app, `/api/admin/invites/${invite.id}/confirm`, { cookie: ownerCookie })
  assert.equal(early.statusCode, 409)
  assert.equal(early.json().error, 'invite_not_claimed')
})

test('a non-admin cannot open, read, or confirm invitations — every route 404s', async (t) => {
  const ctx = await boot(t)
  const visitorCookie = await login(ctx, CANDIDATE) // a signed-in NON-admin

  assert.equal((await postJson(ctx.app, '/api/admin/invites', { cookie: visitorCookie })).statusCode, 404)
  assert.equal((await get(ctx.app, '/api/admin/invites/anything', { cookie: visitorCookie })).statusCode, 404)
  assert.equal(
    (await postJson(ctx.app, '/api/admin/invites/anything/confirm', { cookie: visitorCookie })).statusCode,
    404,
  )
  assert.equal((await get(ctx.app, '/api/admin/admins', { cookie: visitorCookie })).statusCode, 404)
})
