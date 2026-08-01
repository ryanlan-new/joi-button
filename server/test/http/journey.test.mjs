// SPDX-License-Identifier: MIT
//
// One test that walks the entire product, in order, through the assembled
// server: a visitor with no identity at all becomes a verified submitter by
// sending a danmaku, uploads three clips, the owner reviews them, and the two
// that survived appear in catalog.json on disk.
//
// It is deliberately ONE test rather than nine. Every step below is the
// precondition of the next one, and a suite that sets each step up with a
// fixture proves that the steps work in isolation while proving nothing about
// whether they compose — which is the only thing left to doubt once the unit
// suites are green.
//
// WHAT MAKES THIS GO RED
//
//   * Reveal the code from POST /api/login/start, or before acquire() resolves
//     — the third assertion fails. Observable only because the development
//     transport is given a 4-second start latency here: against an instantly
//     ready source, "the code is not shown before the socket is listening" could
//     never be evaluated in a world where it could be false.
//   * Record a Turnstile verdict of 'bypassed' for a real siteverify pass, or
//     'passed' for a simulated one — the verdict assertion fails. The stub runs
//     the PRODUCTION verify() path, so `simulated` is false and 'passed' is the
//     only honest answer.
//   * Publish the rejected item's blob, or leave the approved pair out — the
//     catalogue assertions fail on the exact clip ids.
//   * Emit `""` for a locale nobody wrote — the caption-key assertion fails; the
//     document must omit the key, because main.js only assigns a message when
//     the locale is `!== undefined` and there is no fallbackLocale.

import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { LOGIN_STATES } from '../../routes/public.mjs'
import { assertRefused } from '../helpers/temp-db.mjs'
import {
  OWNER,
  VISITOR,
  anItem,
  boot,
  captions,
  cookieOf,
  get,
  login,
  metadata,
  postForm,
  postJson,
  seedGroup,
  wav,
} from './harness.mjs'

test('the whole path: identity from the room, a batch of three, a review, and a catalogue holding exactly the approved two', async (t) => {
  const ctx = await boot(t)
  const { app, db, clock, danmaku, paths, siteverifyCalls } = ctx

  seedGroup(db, { id: 'voices-core', displayName: 'Core', sortOrder: 1 })
  seedGroup(db, { id: 'voices-extra', displayName: 'Extra', sortOrder: 2 })

  // -------------------------------------------------------------------------
  // 1. the owner takes an identity the same way everyone else does.
  //
  // There is no admin password anywhere in this system: the allow-list is over
  // open_id values, and an open_id is obtained by sending a danmaku. So the
  // owner's session is minted by the public login route and read by the admin
  // gate, which is the coupling app.mjs says is held "by this sentence alone".
  const ownerCookie = await login(ctx, OWNER)

  // -------------------------------------------------------------------------
  // 2. the visitor asks for a code while the socket is still opening.
  danmaku.control.setStartLatencyMs(4000)

  const started = await app.inject({ method: 'POST', url: '/api/login/start' })
  const visitorCookie = cookieOf(started)
  const opening = started.json()
  assert.equal(opening.state, LOGIN_STATES.PREPARING)
  assert.equal(opening.code, undefined, 'a code was handed over before the socket was listening')
  assert.equal(opening.roomId, 3622717)
  assert.equal(danmaku.status().listening, false)

  await clock.advance(1000)
  const midway = (
    await get(app, `/api/login/status?token=${opening.pollToken}`, { cookie: visitorCookie })
  ).json()
  assert.equal(midway.state, LOGIN_STATES.PREPARING)
  assert.equal(midway.code, undefined, 'the code appeared one second into a four-second start')

  await clock.advance(4000)
  const live = (await get(app, '/api/login/status', { cookie: visitorCookie })).json()
  assert.equal(live.state, LOGIN_STATES.WAITING)
  assert.ok(live.code.includes('橘子'), `expected a natural-language phrase carrying 橘子, got ${live.code}`)
  assert.equal(danmaku.status().listening, true, 'a code was live while our side was deaf')
  // The ten minutes start when LISTENING began, not when the request arrived —
  // a start that took four seconds costs this visitor nothing. Read off the
  // source's own marker rather than a literal, so this states the rule instead
  // of restating the arithmetic of the clock. (The other half of that max() —
  // that a visitor arriving onto an already-open socket does not inherit an
  // earlier marker — is proved in login-room.test.mjs, where it can be false.)
  assert.equal(live.issuedAt, danmaku.status().listeningSince)
  assert.equal(Date.parse(live.expiresAt) - Date.parse(live.issuedAt), 10 * 60 * 1000)
  assert.equal(live.canAssertNotSeen, true)

  // -------------------------------------------------------------------------
  // 3. the danmaku arrives and the identity is real.
  danmaku.control.emitDanmaku({
    openId: VISITOR.openId,
    displayName: VISITOR.displayName,
    text: `hi! my code is ${live.code}`,
  })
  await clock.advance(1)

  assert.equal(
    (await get(app, '/api/login/status', { cookie: visitorCookie })).json().state,
    LOGIN_STATES.VERIFIED,
  )
  const me = (await get(app, '/api/me', { cookie: visitorCookie })).json()
  assert.equal(me.submitter.openId, VISITOR.openId)
  assert.equal(me.submitter.displayName, VISITOR.displayName)
  // Never 'dev-bypass': a real danmaku went through the real matcher.
  assert.equal(db.prepare('SELECT verified_via FROM verify_codes WHERE state = ?').get('verified').verified_via, 'danmaku')
  assert.equal(danmaku.status().waiters, 0, 'the room lease survived a successful verification')

  // -------------------------------------------------------------------------
  // 4. the challenge decision, then the batch of three.
  const preflight = (await get(app, '/api/submit/preflight', { cookie: visitorCookie })).json()
  assert.equal(preflight.challengeRequired, true, 'a submitter with nothing accepted yet must be challenged')
  assert.equal(preflight.reason, 'submitter-history')
  assert.equal(preflight.siteKey, 'site-key-for-the-widget')

  const clips = [
    { key: 'k1', name: 'Ei', seconds: 1, caption: 'first' },
    { key: 'k2', name: 'Eh', seconds: 2, caption: 'second' },
    { key: 'k3', name: 'Uu', seconds: 3, caption: 'third' },
  ]
  const submitted = await postForm(app, '/api/submit', {
    cookie: visitorCookie,
    parts: [
      metadata(
        clips.map((clip) =>
          anItem({
            key: clip.key,
            name: clip.name,
            caption: { locale: 'zh-CN', text: clip.caption },
            groupId: 'voices-core',
          }),
        ),
      ),
      { name: 'turnstileToken', value: 'journey-token' },
      ...clips.map((clip) => ({
        name: `file:${clip.key}`,
        filename: `${clip.key}.wav`,
        value: wav({ seconds: clip.seconds }),
      })),
    ],
  })

  assert.equal(submitted.statusCode, 200, submitted.payload.slice(0, 400))
  const receipt = submitted.json()
  assert.equal(receipt.accepted, 3)
  assert.equal(receipt.rejected, 0)
  assert.deepEqual(receipt.items.map((item) => item.state), ['pending', 'pending', 'pending'])
  // The PRODUCTION verify path ran against the stub, so this is a real verdict.
  assert.deepEqual(receipt.turnstile, { required: true, verdict: 'passed' })
  assert.equal(siteverifyCalls.length, 1)
  assert.equal(siteverifyCalls[0].token, 'journey-token')
  assert.equal(siteverifyCalls[0].remoteip, '127.0.0.1')

  // Bytes on the shared directory, at the content-addressed path the database
  // generated. A media row pointing at bytes that are not there is the one state
  // the write order exists to make impossible.
  const media = db.prepare('SELECT sha256, storage_path, bytes FROM media ORDER BY bytes').all()
  assert.equal(media.length, 3)
  for (const row of media) {
    const file = join(paths.mediaDir, row.storage_path)
    assert.ok(existsSync(file), `a media row points at bytes that are not there: ${row.storage_path}`)
    assert.equal(statSync(file).size, row.bytes)
  }

  // -------------------------------------------------------------------------
  // 5. the owner sees exactly one batch, oldest first, in the submitter's order.
  const queue = (await get(app, '/api/admin/queue', { cookie: ownerCookie })).json()
  assert.equal(queue.batchCount, 1)
  assert.equal(queue.itemCount, 3)
  assert.equal(queue.batches[0].submitter.openId, VISITOR.openId)
  assert.deepEqual(queue.batches[0].items.map((item) => item.position), [1, 2, 3])
  assert.deepEqual(queue.batches[0].items.map((item) => item.proposedLabel), ['Ei', 'Eh', 'Uu'])
  const [first, second, third] = queue.batches[0].items.map((item) => item.itemId)

  // -------------------------------------------------------------------------
  // 6. two approvals and one rejection.
  const approveFirst = await postJson(app, `/api/admin/item/${first}`, {
    cookie: ownerCookie,
    body: { decision: 'approve', label: 'Ei', captions: captions('Ei'), groupId: 'voices-core' },
  })
  assert.equal(approveFirst.statusCode, 200, approveFirst.payload)
  const clipOne = approveFirst.json().clipId

  const approveSecond = await postJson(app, `/api/admin/item/${second}`, {
    cookie: ownerCookie,
    body: { decision: 'approve', label: 'Eh', captions: captions('Eh'), groupId: 'voices-core' },
  })
  assert.equal(approveSecond.statusCode, 200, approveSecond.payload)
  const clipTwo = approveSecond.json().clipId

  const rejected = await postJson(app, `/api/admin/item/${third}`, {
    cookie: ownerCookie,
    body: { decision: 'reject', reason: 'the last second is clipped' },
  })
  assert.equal(rejected.statusCode, 200, rejected.payload)
  assert.equal(rejected.json().outcome, 'rejected')
  // The batch resolves when its items do, not when anyone says so.
  assert.equal(rejected.json().batchResolved, true)

  // Approved, not published: approving item 1 of 3 must not put a button on the
  // live site while the reviewer is still looking at item 2.
  assert.deepEqual(
    db.prepare('SELECT state FROM clips ORDER BY created_at, id').all().map((row) => row.state),
    ['draft', 'draft'],
  )
  assert.equal(existsSync(paths.catalogFile), false, 'a clip reached the page before anyone published')

  // -------------------------------------------------------------------------
  // 7. the owner fixes a caption and moves the second clip to another group.
  const edited = await postJson(app, `/api/admin/item/${first}`, {
    cookie: ownerCookie,
    body: { captions: { ...captions('Ei'), 'en-US': 'Ei? (retake)' } },
  })
  assert.equal(edited.statusCode, 200, edited.payload)
  assert.equal(edited.json().clip.captions['en-US'], 'Ei? (retake)')

  const reassigned = await postJson(app, `/api/admin/item/${second}`, {
    cookie: ownerCookie,
    body: { groupId: 'voices-extra' },
  })
  assert.equal(reassigned.statusCode, 200, reassigned.payload)
  assert.equal(reassigned.json().clip.groupId, 'voices-extra')

  // -------------------------------------------------------------------------
  // 8. publish.
  const published = await postJson(app, '/api/admin/publish', { cookie: ownerCookie })
  assert.equal(published.statusCode, 200, published.payload.slice(0, 500))
  assert.deepEqual(published.json().plan.promoting.sort(), [clipOne, clipTwo].sort())
  assert.equal(published.json().catalog.catalogChanged, true)

  const document = JSON.parse(readFileSync(paths.catalogFile, 'utf8'))

  // Exactly the approved two, in page order: groups in (sort_order, id) order,
  // and the clips of a group in the group's own order. Array order IS page order
  // — there is no sort field the consumer is expected to apply.
  assert.deepEqual(document.groups.map((group) => group.id), ['voices-core', 'voices-extra'])
  assert.deepEqual(document.clips.map((clip) => clip.id), [clipOne, clipTwo])
  assert.deepEqual(document.clips.map((clip) => clip.groupId), ['voices-core', 'voices-extra'])
  assert.deepEqual(document.clips.map((clip) => clip.label), ['Ei', 'Eh'])

  // The id IS the vue-i18n key: it is substituted into `voice.<id>`, and vue-i18n
  // resolves a key as a PATH, so the charset is the one schema.sql CHECKs.
  for (const clip of document.clips) {
    assert.match(clip.id, /^[a-z0-9_-]{1,64}$/, `${clip.id} is not usable as a vue-i18n key`)
  }
  for (const group of document.groups) {
    assert.match(group.id, /^[a-z0-9_-]{1,64}$/)
  }
  // …and it is immutable, so a document that has been served can never be talked
  // about with a different key.
  assertRefused(
    () => db.prepare('UPDATE clips SET id = ? WHERE id = ?').run('renamed-clip', clipOne),
    /immutable/,
    'a published i18n key was renameable',
  )

  // Every locale, present as a key — the owner's edit included.
  assert.deepEqual(Object.keys(document.clips[0].captions), ['en-US', 'zh-CN', 'ja-JP'])
  assert.equal(document.clips[0].captions['en-US'], 'Ei? (retake)')
  assert.deepEqual(Object.keys(document.clips[1].captions), ['en-US', 'zh-CN', 'ja-JP'])

  // The rejected clip's audio is named nowhere in the document, and its blob is
  // still on the volume (nothing here deletes bytes).
  const rejectedSha = db
    .prepare('SELECT media_sha256 FROM batch_items WHERE id = ?')
    .get(third).media_sha256
  assert.equal(
    readFileSync(paths.catalogFile, 'utf8').includes(rejectedSha),
    false,
    'the catalogue names the audio of an item the owner rejected',
  )
  assert.equal(document.clips.length, 2)

  // Every path the document names resolves to bytes of the size it claims, under
  // the prefix deploy/nginx.conf publishes the shared volume at. Root-relative,
  // so the same clip is the same url on every route — a path-relative prefix
  // resolves against the DOCUMENT, and the review desk lives on /admin.
  assert.equal(document.mediaBaseUrl, '/media/')
  for (const clip of document.clips) {
    const file = join(paths.mediaDir, clip.path)
    assert.ok(existsSync(file), `catalog.json names ${clip.path}, which is not on the volume`)
    assert.equal(statSync(file).size, clip.bytes)
  }

  // -------------------------------------------------------------------------
  // 9. the submitter is told what happened, in their own numbering.
  const mine = (await get(app, '/api/my/submissions', { cookie: visitorCookie })).json()
  assert.equal(mine.submissions.length, 1)
  assert.equal(mine.submissions[0].state, 'resolved')
  assert.deepEqual(
    mine.submissions[0].items.map((item) => [item.position, item.state]),
    [[1, 'approved'], [2, 'approved'], [3, 'rejected']],
  )
  // "A refusal the submitter cannot read is a refusal nobody can appeal."
  assert.equal(mine.submissions[0].items[2].reviewerNote, 'the last second is clipped')
  assert.deepEqual(
    mine.submissions[0].items.map((item) => item.clipId),
    [clipOne, clipTwo, null],
  )

  // -------------------------------------------------------------------------
  // 10. publishing again is a no-op, and the keys survive the rebuild.
  const again = await postJson(app, '/api/admin/publish', { cookie: ownerCookie })
  assert.equal(again.statusCode, 200, again.payload.slice(0, 300))
  assert.deepEqual(again.json().plan.promoting, [])
  assert.equal(
    again.json().catalog.catalogChanged,
    false,
    'a rebuild of identical data rewrote the file, which churns every cache that revalidated on the ETag',
  )
  assert.deepEqual(
    JSON.parse(readFileSync(paths.catalogFile, 'utf8')).clips.map((clip) => clip.id),
    [clipOne, clipTwo],
  )
})
