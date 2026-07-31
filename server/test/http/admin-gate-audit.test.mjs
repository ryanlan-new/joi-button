// SPDX-License-Identifier: MIT
//
// The admin surface over HTTP: what a stranger learns from it (nothing), and
// what the log records about everyone who does get in.
//
// The gate cases are written against the ASSEMBLED server rather than against a
// recording double, because the property under test here is not "is a check
// installed" — admin.test.mjs proves that where it is written — but "does a real
// request from a real non-admin session get an answer that tells them nothing".
// Those are different claims and only the second one can be made over the wire.
//
// The cookie name is not passed to routes/admin.mjs by the harness. app.mjs
// exports SESSION_COOKIE_NAME, routes/admin.mjs carries DEFAULT_COOKIE_NAME, and
// app.mjs's own header says the two are held in step "by this sentence alone
// until an integration test logs in and then reaches an admin route". Every
// owner request below is that test.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'

import { SESSION_COOKIE_NAME } from '../../app.mjs'
import { assertRefused } from '../helpers/temp-db.mjs'
import {
  OWNER,
  VISITOR,
  anItem,
  auditHigh,
  auditSince,
  boot,
  captions,
  get,
  login,
  metadata,
  postForm,
  postJson,
  seedGroup,
  wav,
} from './harness.mjs'

/** An id of the right SHAPE that names nothing. */
const ABSENT_ID = '00000000-0000-0000-0000-000000000000'

/**
 * The owner, a visitor, and one submitted batch of three clips waiting for a
 * decision. Everything is created through the HTTP surface, so the fixture is
 * itself an assertion that the surface composes.
 */
async function reviewDesk(t) {
  const ctx = await boot(t, { turnstileSwitch: 'off' })
  seedGroup(ctx.db, { id: 'voices-core', displayName: 'Core' })
  const owner = await login(ctx, OWNER)
  const visitor = await login(ctx, VISITOR)

  const parts = [metadata([1, 2, 3].map((n) => anItem({ key: `k${n}`, name: `Clip ${n}` })))]
  for (const n of [1, 2, 3]) {
    parts.push({ name: `file:k${n}`, filename: `${n}.wav`, value: wav({ seconds: n }) })
  }
  const submitted = await postForm(ctx.app, '/api/submit', { cookie: visitor, parts })
  assert.equal(submitted.statusCode, 200, submitted.payload.slice(0, 300))

  const queue = (await get(ctx.app, '/api/admin/queue', { cookie: owner })).json()
  const itemIds = queue.batches[0].items.map((item) => item.itemId)
  assert.equal(itemIds.length, 3)
  return { ...ctx, owner, visitor, itemIds }
}

// ---------------------------------------------------------------------------
// the gate

test("the owner reaches the admin surface with the cookie the login route minted, under the name both files default to", async (t) => {
  const { app, owner } = await reviewDesk(t)

  assert.equal(SESSION_COOKIE_NAME, owner.split('=')[0], 'app.mjs minted a cookie under a different name')
  const queue = await get(app, '/api/admin/queue', { cookie: owner })
  assert.equal(
    queue.statusCode,
    200,
    'the admin gate answered its own owner 404, which is what a cookie-name drift looks like',
  )
})

test('a non-admin cannot tell an item that exists from one that does not, or either from a route that does not exist', async (t) => {
  const { app, db, visitor, owner, itemIds, paths } = await reviewDesk(t)

  const shapeOf = (answer) => ({
    status: answer.statusCode,
    contentType: answer.headers['content-type'],
    // requestId is per request by construction, so the comparison is over the
    // rest of the document — and over its key set, so a field added to one
    // branch and not the other would show up.
    keys: Object.keys(answer.json()).sort(),
    error: answer.json().error,
  })

  const present = shapeOf(await get(app, `/api/admin/item/${itemIds[0]}`, { cookie: visitor }))
  const absent = shapeOf(await get(app, `/api/admin/item/${ABSENT_ID}`, { cookie: visitor }))
  const unrouted = shapeOf(await get(app, '/api/admin/no-such-route-at-all', { cookie: visitor }))
  const anonymous = shapeOf(await get(app, `/api/admin/item/${itemIds[0]}`))

  assert.deepEqual(present, absent, 'a non-admin learned whether the item exists')
  // Identical BY CONSTRUCTION rather than by two bodies that happen to agree:
  // the gate answers with fastify's own not-found handler, which is the same
  // code path an unrouted URL takes.
  assert.deepEqual(present, unrouted, 'a non-admin learned that a route exists at that path')
  assert.deepEqual(present, anonymous, 'having a session at all changed the answer')

  // The counter-proof. Without it this passes against a server that answers 404
  // to everyone forever, which is a gate whose predicate can never be false.
  const adminPresent = await get(app, `/api/admin/item/${itemIds[0]}`, { cookie: owner })
  const adminAbsent = await get(app, `/api/admin/item/${ABSENT_ID}`, { cookie: owner })
  assert.equal(adminPresent.statusCode, 200)
  assert.equal(adminAbsent.statusCode, 404)
  assert.equal(adminAbsent.json().error, 'not_found')
  assert.notDeepEqual(adminAbsent.json(), absent.error)

  // The same holds for every other route the plugin registers, including the
  // ones that would change something.
  const before = auditHigh(db)
  const mutations = [
    await postJson(app, `/api/admin/item/${itemIds[0]}`, {
      cookie: visitor,
      body: { decision: 'reject', reason: 'not yours to reject' },
    }),
    await postJson(app, `/api/admin/item/${ABSENT_ID}`, {
      cookie: visitor,
      body: { decision: 'reject', reason: 'not yours to reject' },
    }),
    await postJson(app, '/api/admin/publish', { cookie: visitor }),
    await get(app, '/api/admin/queue', { cookie: visitor }),
    await get(app, '/api/admin/audit', { cookie: visitor }),
  ]
  for (const answer of mutations) {
    assert.deepEqual(shapeOf(answer), present, 'an admin route answered a stranger with something else')
  }

  assert.equal(db.prepare('SELECT state FROM batch_items WHERE id = ?').get(itemIds[0]).state, 'pending')
  assert.equal(db.prepare('SELECT count(*) AS n FROM clips').get().n, 0)
  assert.equal(existsSync(paths.catalogFile), false)
  // A refusal BY THE GATE is deliberately not logged: the caller is an
  // unauthenticated stranger, and an append-only table anybody on the internet
  // can add a row to is a disk-fill primitive, not a log.
  assert.deepEqual(auditSince(db, before), [])
})

// ---------------------------------------------------------------------------
// the log

test('every admin request appends exactly the entries its events deserve, and reads append none', async (t) => {
  const { app, db, owner, itemIds, paths } = await reviewDesk(t)
  const [one, two, three] = itemIds

  /** Run one request and report the verbs it appended, in order. */
  const verbs = async (send) => {
    const before = auditHigh(db)
    const answer = await send()
    assert.ok(answer.statusCode < 500, `${answer.statusCode}: ${answer.payload.slice(0, 300)}`)
    return { answer, appended: auditSince(db, before) }
  }

  // Reads change nothing, so they log nothing. An entry per GET would bury the
  // entries that record a change.
  for (const url of ['/api/admin/queue', `/api/admin/item/${one}`, '/api/admin/audit']) {
    const read = await verbs(() => get(app, url, { cookie: owner }))
    assert.equal(read.answer.statusCode, 200, url)
    assert.deepEqual(read.appended.map((row) => row.action), [], `${url} wrote to the log`)
  }

  // One approval into a group that already exists: ONE entry.
  const approved = await verbs(() =>
    postJson(app, `/api/admin/item/${one}`, {
      cookie: owner,
      body: { decision: 'approve', label: 'One', captions: captions('One'), groupId: 'voices-core' },
    }),
  )
  assert.deepEqual(approved.appended.map((row) => row.action), ['admin.item.approve'])
  const clipOne = approved.answer.json().clipId
  assert.equal(approved.appended[0].actor_id, OWNER.openId)
  assert.equal(approved.appended[0].subject_id, one)
  assert.equal(JSON.parse(approved.appended[0].detail).consequence, `clip:${clipOne}`)
  assert.equal(JSON.parse(approved.appended[0].detail).succeeded, true)
  const approvalEntryId = approved.appended[0].id

  // An approval that also mints a group is TWO events, and they are recorded as
  // two: a group appearing on the page is a change in its own right, and a
  // single entry could only claim one of them.
  const withGroup = await verbs(() =>
    postJson(app, `/api/admin/item/${two}`, {
      cookie: owner,
      body: {
        decision: 'approve',
        label: 'Two',
        captions: captions('Two'),
        newGroup: { id: 'voices-new', displayName: 'New', captions: captions('New group') },
      },
    }),
  )
  assert.deepEqual(withGroup.appended.map((row) => row.action), ['admin.group.create', 'admin.item.approve'])

  const rejected = await verbs(() =>
    postJson(app, `/api/admin/item/${three}`, { cookie: owner, body: { decision: 'reject', reason: 'too quiet' } }),
  )
  assert.deepEqual(rejected.appended.map((row) => row.action), ['admin.item.reject'])

  const edited = await verbs(() =>
    postJson(app, `/api/admin/item/${one}`, { cookie: owner, body: { label: 'One (retake)' } }),
  )
  assert.deepEqual(edited.appended.map((row) => row.action), ['admin.clip.edit'])

  // A dry run is not a mutation, so it is not logged — and it must not have
  // written anything either.
  const dry = await verbs(() => postJson(app, '/api/admin/publish', { cookie: owner, body: { dryRun: true } }))
  assert.equal(dry.answer.json().dryRun, true)
  assert.deepEqual(dry.appended.map((row) => row.action), [])
  assert.equal(existsSync(paths.catalogFile), false)

  // Publishing is two events with different failure modes — the promotion is a
  // committed transaction, the write is a filesystem rename — so it is two
  // entries. The promotion's entry must NOT claim the catalogue, because at the
  // moment it is written the file does not exist yet.
  const published = await verbs(() => postJson(app, '/api/admin/publish', { cookie: owner }))
  assert.deepEqual(published.appended.map((row) => row.action), ['admin.clip.publish', 'admin.catalog.write'])
  assert.equal(JSON.parse(published.appended[0].detail).consequence, null)
  assert.equal(
    JSON.parse(published.appended[1].detail).consequence,
    `catalog:${published.answer.json().catalog.catalogSha256}`,
  )

  // Nothing left to promote: the write is still an event and is still recorded,
  // with `changed: false`, which is what makes a re-run readable in the log.
  const again = await verbs(() => postJson(app, '/api/admin/publish', { cookie: owner }))
  assert.deepEqual(again.appended.map((row) => row.action), ['admin.catalog.write'])
  assert.equal(JSON.parse(again.appended[0].detail).diff.changed.after, false)

  // A mutation an admin asked for and did not get is worth one line, marked as
  // a failure — unlike a refusal by the gate.
  const refused = await verbs(() =>
    postJson(app, `/api/admin/item/${three}`, { cookie: owner, body: { decision: 'approve', label: 'x' } }),
  )
  assert.equal(refused.answer.statusCode, 409)
  assert.deepEqual(refused.appended.map((row) => row.action), ['admin.refused'])
  assert.equal(JSON.parse(refused.appended[0].detail).succeeded, false)
  assert.equal(db.prepare('SELECT state FROM batch_items WHERE id = ?').get(three).state, 'rejected')

  // -------------------------------------------------------------------------
  // and the log is append-only, in the database and not merely in the module.
  const stored = db.prepare('SELECT seq, action, actor_id, detail FROM audit_log WHERE id = ?').get(approvalEntryId)
  assertRefused(
    () => db.prepare('UPDATE audit_log SET action = ? WHERE id = ?').run('admin.item.reject', approvalEntryId),
    /append-only/,
    'an audit entry was rewritten after the fact',
  )
  assertRefused(
    () => db.prepare('UPDATE audit_log SET detail = ? WHERE id = ?').run('{}', approvalEntryId),
    /append-only/,
    'the detail of an audit entry was rewritten after the fact',
  )
  assertRefused(
    () => db.prepare('DELETE FROM audit_log WHERE id = ?').run(approvalEntryId),
    /append-only/,
    'an audit entry was deleted',
  )
  assert.deepEqual(
    db.prepare('SELECT seq, action, actor_id, detail FROM audit_log WHERE id = ?').get(approvalEntryId),
    stored,
    'the row changed even though every statement against it was refused',
  )

  // The whole log, read back through the route that publishes it, newest first.
  const log = (await get(app, '/api/admin/audit', { cookie: owner })).json()
  assert.deepEqual(
    log.entries.map((entry) => entry.verb),
    [
      'admin.refused',
      'admin.catalog.write',
      'admin.catalog.write',
      'admin.clip.publish',
      'admin.clip.edit',
      'admin.item.reject',
      'admin.item.approve',
      'admin.group.create',
      'admin.item.approve',
      // The submitter's own two entries: the identity they proved, and the batch
      // they sent. Both were appended by routes/public.mjs, and this is where
      // that shows: one log, two actors.
      'submit.batch',
      'identity.verify',
      'identity.verify',
    ],
  )
  assert.deepEqual(
    [...new Set(log.entries.map((entry) => entry.actorKind))].sort(),
    ['owner', 'submitter'],
  )
})
