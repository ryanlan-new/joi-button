// The admin surface. Every route here can refuse, so every refusal has a case
// that makes it happen — and where a refusal is supposed to leave the database
// untouched, the case asserts that too, because "it threw" and "it changed
// nothing" are different claims.
//
// The gate cases are written against the plugin as fastify will drive it (a hook
// plus routes), with a recording double in place of fastify: the property under
// test is WHERE the check is installed, and that is visible in what the plugin
// registers, not in what any one handler returns.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import adminRoutes, {
  AdminError,
  createAdminGate,
  httpStatusFor,
  parseCookieHeader,
  publishCatalogue,
  readAuditPage,
  readItem,
  readQueue,
  reviewItem,
} from '../routes/admin.mjs'
import { listByActor, record } from '../lib/audit.mjs'
import { CatalogError } from '../lib/catalog.mjs'
import { T0, T10, openDatabase, seed } from './helpers/temp-db.mjs'

const ADMIN = Object.freeze({ openId: 'open-alpha', displayName: 'Owner' })
const T5 = '2026-08-01T00:05:00Z'
const at = () => new Date(T0)

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function putMedia(db, content, { now = T0 } = {}) {
  const bytes = Buffer.from(content, 'utf8')
  const digest = createHash('sha256').update(bytes).digest('hex')
  db.prepare(
    'INSERT INTO media (sha256, ext, content_type, bytes, duration_seconds, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(digest, 'mp3', 'audio/mpeg', bytes.length, 2.25, now)
  const storagePath = db.prepare('SELECT storage_path FROM media WHERE sha256 = ?').get(digest).storage_path
  return { sha256: digest, bytes, storagePath }
}

function addItem(db, batchId, position, media, extra = {}) {
  const id = `${batchId}-item-${position}`
  db.prepare(`
    INSERT INTO batch_items (id, batch_id, position, media_sha256, proposed_label, proposed_group_id, submitter_note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    batchId,
    position,
    media.sha256,
    extra.label ?? `Proposed ${position}`,
    extra.groupId ?? null,
    extra.note ?? null,
    extra.now ?? T0,
  )
  return id
}

function submitBatch(db, batchId, submittedAt = T0) {
  db.prepare("UPDATE batches SET state = 'submitted', submitted_at = ? WHERE id = ?").run(submittedAt, batchId)
}

/** One submitted batch with one pending item, which is the shape the desk sees. */
function pendingFixture(t) {
  const db = openDatabase(t)
  const ids = seed(db)
  const media = putMedia(db, 'pending-audio')
  const itemId = addItem(db, ids.batch, 1, media, {
    groupId: ids.group,
    // The real shape routes/public.mjs writes into this column: a caption, a
    // free-text note and the name of a group the submitter is PROPOSING (which
    // has no id yet, which is why it cannot live in proposed_group_id).
    note: JSON.stringify({
      caption: { locale: 'zh-CN', text: '他在煎蛋' },
      note: '第一次投稿',
      proposedGroup: '极地煎蛋',
    }),
  })
  submitBatch(db, ids.batch)
  return { db, ids, media, itemId }
}

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'joi-button-admin-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, mediaDir: join(dir, 'media'), catalogFile: join(dir, 'catalog.json') }
}

function place(root, storagePath, bytes) {
  const target = join(root, storagePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, bytes)
}

const CAPTIONS = { 'en-US': 'Ei?', 'zh-CN': '欸？', 'ja-JP': 'え？' }

// ---------------------------------------------------------------------------
// the gate

// Fastify's routing verbs. Anything on this list that the double does not
// implement is a LOUD stub, not an absent property, because of what happened the
// last time one was merely absent: the plugin gained a DELETE route, this double
// had no `delete`, routes/admin.mjs took its `typeof fastify.delete === 'function'`
// fallback, and the roster assertion below went on passing while never once
// seeing the only route that turns the theme off. The fallback's warning could
// not report it either — it goes through `fastify.log?.warn?.`, and the double
// had no `log`, so the optional chaining written to be defensive was the thing
// doing the hiding. A double that silently absorbs a call it does not model
// turns a coverage gate into a gate over whatever the double happens to support.
const UNSUPPORTED_VERBS = ['put', 'patch', 'head', 'options', 'all', 'route']

function fakeFastify() {
  const routes = []
  const hooks = []
  // Recorded rather than discarded: routes/admin.mjs uses `log.warn` to report
  // states it chooses to serve through instead of throwing (an empty
  // ADMIN_OPEN_IDS list, derived theme paths), and a test that wants to assert
  // one of those happened needs somewhere for it to land.
  const warnings = []
  const fastify = {
    routes,
    hooks,
    warnings,
    log: {
      warn(...args) {
        warnings.push(args)
      },
    },
    addHook(name, fn) {
      hooks.push({ name, fn })
    },
    get(url, handler) {
      routes.push({ method: 'GET', url, handler })
    },
    post(url, handler) {
      routes.push({ method: 'POST', url, handler })
    },
    delete(url, handler) {
      routes.push({ method: 'DELETE', url, handler })
    },
  }
  for (const verb of UNSUPPORTED_VERBS) {
    fastify[verb] = (url) => {
      throw new Error(
        `fakeFastify: the plugin registered ${verb.toUpperCase()} ${url}, which this double does not model. ` +
          'Add it to fakeFastify and to the expected roster — do not let it vanish, because a route ' +
          'the double drops is a route the gate assertions never evaluate.',
      )
    }
  }
  return fastify
}

function fakeReply() {
  const state = { status: null, body: undefined, notFound: 0 }
  const reply = {
    state,
    code(status) {
      state.status = status
      return reply
    },
    send(body) {
      state.body = body
      return reply
    },
    callNotFound() {
      state.notFound += 1
      return reply
    },
  }
  return reply
}

function bindSession(db, { id = 'ses-admin', token, submitterId, createdAt = T0, expiresAt = T10, revokedAt = null }) {
  db.prepare(`
    INSERT INTO sessions (id, token_sha256, submitter_id, bound_at, created_at, last_seen_at, expires_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, sha256(token), submitterId, createdAt, createdAt, createdAt, expiresAt, revokedAt)
}

test('the plugin puts ONE gate in front of every route it registers, and registers exactly the documented ones', async (t) => {
  const { db } = pendingFixture(t)
  const fastify = fakeFastify()
  await adminRoutes(fastify, {
    db,
    adminOpenIds: [ADMIN.openId],
    paths: { catalogFile: '/dev/null/catalog.json', mediaDir: '/dev/null/media' },
    now: at,
  })

  assert.deepEqual(
    fastify.routes.map((route) => `${route.method} ${route.url}`),
    [
      'GET /api/admin/queue',
      'GET /api/admin/item/:id',
      'POST /api/admin/item/:id',
      'POST /api/admin/publish',
      'GET /api/admin/audit',
      'GET /api/admin/theme',
      'POST /api/admin/theme',
      'DELETE /api/admin/theme',
      'POST /api/admin/theme/wallpaper',
      // Admin roster management. These register unconditionally. The FOUR invite
      // routes (POST /api/admin/invites, GET/confirm/cancel) register only when a
      // danmakuSource is wired — this call passes none, so they are absent here;
      // the http harness, which wires the source, exercises them.
      'GET /api/admin/admins',
      'POST /api/admin/admins/:openId/revoke',
    ],
  )
  // Named on its own because it is the one the double used to swallow: DELETE is
  // the route that turns the theme off, and it is the route whose absence nobody
  // would notice from the other three working.
  assert.ok(
    fastify.routes.some((route) => route.method === 'DELETE' && route.url === '/api/admin/theme'),
    'the plugin must register DELETE /api/admin/theme on a host that can take it',
  )
  // One onRequest hook and no per-route check. The coverage property is
  // fastify's: an onRequest hook added inside an encapsulated plugin runs for
  // every route registered in that plugin, including ones added later — which is
  // why the check is a hook and not something each route has to remember.
  assert.deepEqual(fastify.hooks.map((hook) => hook.name), ['onRequest'])
})

// The roster assertion above is only worth its runtime if the double cannot
// quietly drop what it is handed. This case is about the double, not the plugin:
// it fixes the property that made the DELETE hole possible in the first place,
// so the next verb this file has not modelled yet stops the suite instead of
// evaporating out of `fastify.routes`.
test('the fastify double refuses a verb it does not model instead of swallowing the route', () => {
  const fastify = fakeFastify()
  for (const verb of UNSUPPORTED_VERBS) {
    assert.throws(
      () => fastify[verb]('/api/admin/example'),
      /does not model/,
      `${verb} must throw, not absorb the registration`,
    )
  }
  assert.deepEqual(fastify.routes, [], 'a refused registration must not leave a half-recorded route behind')
})

test('a non-admin gets the answer a missing route gets, produced by fastify\'s own not-found handler', async (t) => {
  const { db, ids } = pendingFixture(t)
  bindSession(db, { token: 'stranger-token', submitterId: ids.submitter2 }) // sub-beta: not on the list
  const fastify = fakeFastify()
  await adminRoutes(fastify, {
    db,
    adminOpenIds: [ADMIN.openId],
    paths: { catalogFile: '/dev/null/catalog.json', mediaDir: '/dev/null/media' },
    now: at,
  })
  const gate = fastify.hooks[0].fn

  for (const [why, headers] of [
    ['no cookie at all', {}],
    ['a cookie naming nothing', { cookie: 'joi_session=not-a-real-token' }],
    ['a session belonging to somebody not on the allow-list', { cookie: 'joi_session=stranger-token' }],
  ]) {
    const request = { headers }
    const reply = fakeReply()
    await gate(request, reply)
    assert.equal(reply.state.notFound, 1, `${why}: the refusal did not go through the not-found handler`)
    assert.equal(reply.state.status, null, `${why}: a hand-written status would differ from a real 404`)
    assert.equal(request.adminIdentity, undefined, `${why}: the handler would have run`)
  }
})

test('an allow-listed admin passes the gate, and stops passing it when the session expires or is revoked', async (t) => {
  const { db, ids } = pendingFixture(t)
  bindSession(db, { id: 'ses-live', token: 'owner-token', submitterId: ids.submitter })
  // expires_at > created_at is a column CHECK, so an already-expired session is
  // one that was created before "now" and ran out before it, not one that
  // expires at the instant it was made.
  bindSession(db, {
    id: 'ses-old',
    token: 'expired-token',
    submitterId: ids.submitter,
    createdAt: '2026-07-31T00:00:00Z',
    expiresAt: '2026-07-31T12:00:00Z',
  })
  bindSession(db, { id: 'ses-gone', token: 'revoked-token', submitterId: ids.submitter, revokedAt: T0 })

  const gate = createAdminGate({ db, adminOpenIds: [ADMIN.openId], now: at })

  const admitted = await gate({ headers: { cookie: 'joi_session=owner-token' } })
  assert.equal(admitted.openId, ADMIN.openId)
  assert.equal(admitted.submitterId, ids.submitter)

  assert.equal(await gate({ headers: { cookie: 'joi_session=expired-token' } }), null)
  assert.equal(await gate({ headers: { cookie: 'joi_session=revoked-token' } }), null)
})

test('an empty allow-list builds a gate that admits nobody, rather than refusing to build', async (t) => {
  // THIS TEST WAS INVERTED. It used to assert that an empty list THROWS, on the
  // argument that an unset ADMIN_OPEN_IDS is "safe and useless" and should be
  // refused loudly. The argument holds for the steady state and fails for the
  // one state every deployment begins in: an open_id is issued per Open Platform
  // project and there is no console that shows it — deploy/runtime.env.example
  // says "You obtain your own by logging in once through the danmaku flow" — so
  // on a first deploy the list is NECESSARILY empty. Throwing meant the API
  // would not start, so the owner could not log in, so they could never learn
  // the value. The documented first deploy could not be walked.
  //
  // What is asserted instead is the property that mattered: the gate exists and
  // admits nobody. Fail-closed, and startable.
  const { db, ids } = pendingFixture(t)
  // A live session for the owner, so the two gates below are asked about a
  // request that a configured list really does admit — otherwise "admits
  // nobody" would be satisfied by a fixture nobody could pass either way.
  bindSession(db, { id: 'ses-live', token: 'owner-token', submitterId: ids.submitter })
  const ask = (gate) => gate({ headers: { cookie: 'joi_session=owner-token' } })

  const gate = createAdminGate({ db, adminOpenIds: [], now: at })
  assert.equal(typeof gate, 'function')
  assert.equal(await ask(gate), null, 'an empty allow-list admitted somebody')
  // Whitespace-only entries are the same as none.
  assert.equal(await ask(createAdminGate({ db, adminOpenIds: ['  ', ''], now: at })), null)

  // The same cookie IS admitted once the list is configured — so this is a gate
  // that can go both ways rather than one that always answers null.
  const configured = createAdminGate({ db, adminOpenIds: [ADMIN.openId], now: at })
  assert.equal((await ask(configured)).openId, ADMIN.openId)

  // A NON-array is still refused: that is a caller mistake, not a deployment
  // state, and it has no bootstrap to protect.
  assert.throws(() => createAdminGate({ db, adminOpenIds: undefined }), /must be an array/)
})

test('registering the plugin under a prefix is refused, because the symptom would look like a working gate', async (t) => {
  const { db } = pendingFixture(t)
  await assert.rejects(
    adminRoutes(fakeFastify(), {
      db,
      adminOpenIds: [ADMIN.openId],
      paths: { catalogFile: '/x', mediaDir: '/y' },
      prefix: '/api/admin',
    }),
    /register this plugin WITHOUT a prefix/,
  )
})

test('cookie parsing takes the first value and survives a malformed one', () => {
  // Spread into an ordinary object: the parser returns a null-prototype bag so a
  // cookie called '__proto__' or 'constructor' is a key and not a hazard, and
  // deepStrictEqual compares prototypes.
  assert.deepEqual({ ...parseCookieHeader('a=1; b=two') }, { a: '1', b: 'two' })
  assert.equal(Object.getPrototypeOf(parseCookieHeader('a=1')), null)
  assert.equal(parseCookieHeader('joi_session=abc; joi_session=injected').joi_session, 'abc')
  assert.equal(parseCookieHeader('joi_session="quoted"').joi_session, 'quoted')
  assert.equal(parseCookieHeader('joi_session=%E6%AC%B8').joi_session, '欸')
  assert.equal(parseCookieHeader('joi_session=%E6%AC').joi_session, '%E6%AC')
  assert.deepEqual({ ...parseCookieHeader(undefined) }, {})
})

// ---------------------------------------------------------------------------
// the queue

test('the queue is arrival order, and a submitter with a spotless history does not jump it', (t) => {
  const { db, ids, itemId } = pendingFixture(t)

  // A later batch from a submitter with 99 approvals and nothing against them —
  // the exact profile any "rank by trust" would float to the top.
  db.prepare('UPDATE submitters SET approved_count = 99, submitted_count = 99 WHERE id = ?').run(ids.submitter2)
  db.prepare("INSERT INTO batches (id, submitter_id, state, created_at) VALUES ('bat-later', ?, 'draft', ?)").run(
    ids.submitter2,
    T5,
  )
  const laterItem = addItem(db, 'bat-later', 1, putMedia(db, 'later-audio'), { now: T5 })
  submitBatch(db, 'bat-later', T5)

  const queue = readQueue(db)
  assert.deepEqual(queue.batches.map((batch) => batch.batchId), [ids.batch, 'bat-later'])
  assert.deepEqual(
    queue.batches.flatMap((batch) => batch.items.map((item) => item.itemId)),
    [itemId, laterItem],
  )
  assert.equal(queue.itemCount, 2)
})

test('the queue shows only what is actually waiting, and each item with what a reviewer needs to judge it', (t) => {
  const { db, ids, media, itemId } = pendingFixture(t)

  // A draft batch (never submitted) and a cancelled one (never will be) both
  // hold items in state 'pending' forever. Neither is waiting for a decision.
  for (const [batchId, state] of [['bat-draft', 'draft'], ['bat-cancelled', 'cancelled']]) {
    db.prepare("INSERT INTO batches (id, submitter_id, state, created_at) VALUES (?, ?, 'draft', ?)").run(
      batchId,
      ids.submitter,
      T0,
    )
    addItem(db, batchId, 1, putMedia(db, `${batchId}-audio`))
    if (state !== 'draft') db.prepare('UPDATE batches SET state = ? WHERE id = ?').run(state, batchId)
  }

  const queue = readQueue(db)
  assert.deepEqual(queue.batches.map((b) => b.batchId), [ids.batch])

  const [item] = queue.batches[0].items
  assert.equal(item.itemId, itemId)

  // PARSED, never the raw column. batch_items.submitter_note is a JSON document
  // and the desk used to render it as text, so a reviewer read
  // `{"caption":{"locale":"zh-CN","text":"…"},"note":"…","proposedGroup":"…"}`
  // in the notes column — while the column headed "which group they want" said
  // "not specified", because proposed_group_id is null for a group that does not
  // exist yet and the proposal only ever lived inside that blob.
  assert.deepEqual(item.submitterNote, {
    caption: { locale: 'zh-CN', text: '他在煎蛋' },
    note: '第一次投稿',
    proposedGroup: '极地煎蛋',
  })
  // The desk's audition panel plays this url. It has to name the volume the web
  // pod publishes ('/media/'), not the image's own static folder ('voices/',
  // what this was) — otherwise the audio 404s, no `ended` ever arrives, and the
  // listen-before-approve gate can never open for anything a submitter sent.
  assert.equal(item.media.audioUrl, `/media/${media.storagePath}`)
  assert.equal(item.media.bytes, media.bytes.length)
  assert.equal(item.media.durationSeconds, 2.25)
  // Stated, not silently dropped: nothing in this system measures amplitude and
  // `media` has no column for one. See routes/admin.mjs.
  assert.equal(item.media.peakDbfs, null)

  const submitter = queue.batches[0].submitter
  assert.deepEqual(submitter.counts, { submittedCount: 0, approvedCount: 0, rejectedCount: 0 })
  // The stored counters are what the anti-abuse rules read; the view beside them
  // is the truth. Here they disagree — two batches of this submitter's have left
  // draft (the submitted one and the cancelled one, which v_submitter_counts_expected
  // counts as `state <> 'draft'`) and no counter was ever bumped. The desk says
  // so rather than quietly repairing it, because a silent repair hides the bug
  // that caused the drift.
  assert.equal(submitter.countsExpected.submittedCount, 2)
  assert.equal(submitter.countsDrifted, true)
})

// ---------------------------------------------------------------------------
// the review desk

test('rejecting needs a reason, and the refusal leaves the item pending', (t) => {
  const { db, itemId } = pendingFixture(t)

  for (const reason of [undefined, '', '   ']) {
    assert.throws(
      () => reviewItem(db, itemId, { decision: 'reject', reason }, { actor: ADMIN, now: at }),
      (error) => {
        assert.ok(error instanceof AdminError)
        assert.equal(error.code, 'invalid_request')
        assert.equal(error.details.field, 'reason')
        return true
      },
      'a refusal the submitter cannot read is a refusal nobody can appeal',
    )
  }
  assert.equal(db.prepare('SELECT state FROM batch_items WHERE id = ?').get(itemId).state, 'pending')
  assert.equal(db.prepare('SELECT count(*) AS n FROM audit_log').get().n, 0)
})

test('rejecting records the reason, counts it against the submitter, resolves the batch and is audited', (t) => {
  const { db, ids, itemId } = pendingFixture(t)

  const result = reviewItem(db, itemId, { decision: 'reject', reason: 'clipped at the end' }, { actor: ADMIN, now: at })
  assert.equal(result.outcome, 'rejected')
  assert.equal(result.batchResolved, true)

  const item = db.prepare('SELECT state, reviewer_note, resolved_at FROM batch_items WHERE id = ?').get(itemId)
  assert.equal(item.state, 'rejected')
  assert.equal(item.reviewer_note, 'clipped at the end')
  assert.equal(item.resolved_at, T0)
  assert.equal(db.prepare('SELECT rejected_count FROM submitters WHERE id = ?').get(ids.submitter).rejected_count, 1)
  // The batch resolves when its items do, not when someone says so.
  assert.equal(db.prepare('SELECT state FROM batches WHERE id = ?').get(ids.batch).state, 'resolved')

  const entry = db.prepare('SELECT action, actor_id, subject_id, detail FROM audit_log ORDER BY seq DESC').get()
  assert.equal(entry.action, 'admin.item.reject')
  assert.equal(entry.actor_id, ADMIN.openId)
  assert.equal(entry.subject_id, itemId)
  assert.equal(JSON.parse(entry.detail).succeeded, true)
})

test('a decision is only available while the item is pending and its batch is submitted', (t) => {
  const { db, ids, itemId } = pendingFixture(t)
  reviewItem(db, itemId, { decision: 'reject', reason: 'no' }, { actor: ADMIN, now: at })

  assert.throws(
    () => reviewItem(db, itemId, { decision: 'approve', label: 'x', captions: CAPTIONS, groupId: ids.group }, { actor: ADMIN, now: at }),
    (error) => error.code === 'conflict' && error.status === 409,
    're-deciding a resolved item would double-count the submitter and need a clip under a rejected item',
  )

  // A cancelled batch keeps its items 'pending' for the life of the database.
  db.prepare("INSERT INTO batches (id, submitter_id, state, created_at) VALUES ('bat-dead', ?, 'draft', ?)").run(ids.submitter, T0)
  const deadItem = addItem(db, 'bat-dead', 1, putMedia(db, 'dead-audio'))
  db.prepare("UPDATE batches SET state = 'cancelled' WHERE id = 'bat-dead'").run()
  assert.throws(
    () => reviewItem(db, deadItem, { decision: 'reject', reason: 'no' }, { actor: ADMIN, now: at }),
    /is cancelled, not submitted/,
  )
})

test('a caption carrying a linked message is refused, and one carrying a pipe is stored neutralised', (t) => {
  const { db, ids, itemId } = pendingFixture(t)
  const approve = (captions) =>
    reviewItem(db, itemId, { decision: 'approve', label: 'Ei?', captions, groupId: ids.group }, { actor: ADMIN, now: at })

  assert.throws(
    () => approve({ ...CAPTIONS, 'en-US': 'shoutout to @:info.title' }),
    (error) => {
      assert.equal(error.code, 'invalid_text')
      assert.equal(error.details.reason, 'linked_message')
      return true
    },
    'a linked message reads a message the submitter does not own into the page',
  )
  assert.equal(db.prepare('SELECT count(*) AS n FROM clips WHERE id <> ?').get(ids.clip).n, 0)

  // '|' is the plural separator on the $tc path: "left|right" would render as
  // "left" with the rest silently deleted. It is legitimate prose, so it is
  // escaped rather than refused — and what lands in the column is the escaped
  // form, not what was typed.
  approve({ ...CAPTIONS, 'en-US': 'left|right' })
  const stored = db
    .prepare("SELECT text FROM clip_captions WHERE locale = 'en-US' AND clip_id <> ?")
    .get(ids.clip).text
  assert.equal(stored, 'left｜right')
  assert.equal(stored.includes('|'), false)
})

test('approving mints a DRAFT clip with its captions, links the item to it, and is audited with the clip it produced', (t) => {
  const { db, ids, media, itemId } = pendingFixture(t)

  const result = reviewItem(
    db,
    itemId,
    { decision: 'approve', label: 'Ei?', captions: CAPTIONS, groupId: ids.group, reason: 'good take' },
    { actor: ADMIN, now: at },
  )
  assert.equal(result.outcome, 'approved')

  const clip = db.prepare('SELECT * FROM clips WHERE id = ?').get(result.clipId)
  // draft, not published: approving item 1 of 5 must not put a button on the
  // live site while the reviewer is still looking at item 2.
  assert.equal(clip.state, 'draft')
  assert.equal(clip.published_at, null)
  assert.equal(clip.media_sha256, media.sha256)
  assert.equal(clip.group_id, ids.group)
  assert.equal(clip.submitter_id, ids.submitter)
  assert.equal(clip.submitted_at, T0)

  assert.deepEqual(
    db.prepare('SELECT locale, text FROM clip_captions WHERE clip_id = ? ORDER BY locale').all(result.clipId),
    [
      { locale: 'en-US', text: 'Ei?' },
      { locale: 'ja-JP', text: 'え？' },
      { locale: 'zh-CN', text: '欸？' },
    ],
  )

  const item = db.prepare('SELECT state, clip_id, reviewer_note FROM batch_items WHERE id = ?').get(itemId)
  assert.equal(item.state, 'approved')
  assert.equal(item.clip_id, result.clipId)
  assert.equal(item.reviewer_note, 'good take')
  assert.equal(db.prepare('SELECT approved_count FROM submitters WHERE id = ?').get(ids.submitter).approved_count, 1)

  const entry = db.prepare("SELECT detail FROM audit_log WHERE action = 'admin.item.approve'").get()
  assert.equal(JSON.parse(entry.detail).consequence, `clip:${result.clipId}`)

  // What the submitter proposed is an INPUT record and survives the review.
  assert.equal(db.prepare('SELECT proposed_label FROM batch_items WHERE id = ?').get(itemId).proposed_label, 'Proposed 1')
})

test('approving into a new group mints the group and its captions in the same transaction', (t) => {
  const { db, itemId } = pendingFixture(t)

  const result = reviewItem(
    db,
    itemId,
    {
      decision: 'approve',
      label: 'Ei?',
      captions: CAPTIONS,
      newGroup: { id: 'cute-hummings', displayName: 'Cute Hummings', captions: { 'en-US': 'Cute Hummings' } },
    },
    { actor: ADMIN, now: at },
  )
  assert.equal(result.createdGroup, 'cute-hummings')
  assert.equal(db.prepare('SELECT state FROM groups WHERE id = ?').get('cute-hummings').state, 'active')
  assert.deepEqual(
    db.prepare('SELECT locale, text FROM group_captions WHERE group_id = ?').all('cute-hummings'),
    [{ locale: 'en-US', text: 'Cute Hummings' }],
  )
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'admin.group.create'").get().n, 1)
})

test('the approval is one transaction: a failure at the last write leaves no clip and no group behind', (t) => {
  const { db, itemId } = pendingFixture(t)

  // A defect in the caller rather than in the input: audit.record() refuses an
  // entry it cannot attribute, and it is the LAST write of the transaction, so
  // everything before it has already happened by the time it throws.
  assert.throws(
    () =>
      reviewItem(
        db,
        itemId,
        {
          decision: 'approve',
          label: 'Ei?',
          captions: CAPTIONS,
          newGroup: { id: 'ghost-group', displayName: 'Ghost' },
        },
        { actor: { openId: ADMIN.openId, displayName: '' }, now: at },
      ),
    /actorDisplayName/,
  )

  assert.equal(db.prepare('SELECT count(*) AS n FROM groups WHERE id = ?').get('ghost-group').n, 0)
  assert.equal(db.prepare("SELECT count(*) AS n FROM clip_captions WHERE text = 'Ei?'").get().n, 0)
  assert.equal(db.prepare('SELECT state FROM batch_items WHERE id = ?').get(itemId).state, 'pending')
})

test('the desk refuses the group choices that would produce an unreachable or duplicate button', (t) => {
  const { db, ids, itemId } = pendingFixture(t)
  const approve = (extra) =>
    reviewItem(db, itemId, { decision: 'approve', label: 'Ei?', captions: CAPTIONS, ...extra }, { actor: ADMIN, now: at })

  assert.throws(() => approve({}), /exactly one of groupId/)
  assert.throws(() => approve({ groupId: ids.group, newGroup: { displayName: 'Both' } }), /exactly one of groupId/)
  assert.throws(() => approve({ groupId: 'no-such-group' }), /no group no-such-group/)
  // vue-i18n resolves a key as a path, so a dotted id would silently resolve to
  // a nested lookup that misses.
  assert.throws(() => approve({ newGroup: { id: 'Cute.Hummings', displayName: 'X' } }), /not usable as a vue-i18n key/)
  assert.throws(
    () => approve({ newGroup: { displayName: 'alpha' } }),
    /already called "alpha"/,
    'two live groups with one visible name is how a clip gets filed under the wrong one',
  )
  assert.throws(() => approve({ groupId: ids.group, captions: { 'en_us': 'oops' } }), /not a locale this site publishes/)

  // A retired group: the clip would be a button nobody can find. (Retiring is
  // allowed here because seed()'s own clip is a draft — the trigger only blocks
  // retiring a group that has PUBLISHED clips in it.)
  db.prepare("UPDATE groups SET state = 'retired', retired_at = ? WHERE id = ?").run(T10, ids.group)
  assert.throws(() => approve({ groupId: ids.group }), /is retired/)

  assert.equal(db.prepare('SELECT count(*) AS n FROM clips WHERE id <> ?').get(ids.clip).n, 0)
  assert.equal(db.prepare('SELECT state FROM batch_items WHERE id = ?').get(itemId).state, 'pending')
})

test('approving the same audio twice is refused and says which clip already plays it', (t) => {
  const { db, ids } = pendingFixture(t)
  // seed() already points clip-alpha at ids.media; this item carries the same
  // blob. It needs its own batch: items may only be added to a DRAFT batch, and
  // the fixture's batch has already been submitted.
  db.prepare("INSERT INTO batches (id, submitter_id, state, created_at) VALUES ('bat-dup', ?, 'draft', ?)").run(
    ids.submitter,
    T0,
  )
  const duplicate = addItem(db, 'bat-dup', 1, { sha256: ids.media })
  submitBatch(db, 'bat-dup')

  assert.throws(
    () =>
      reviewItem(
        db,
        duplicate,
        { decision: 'approve', label: 'Again', captions: CAPTIONS, groupId: ids.group },
        { actor: ADMIN, now: at },
      ),
    (error) => {
      assert.equal(error.code, 'conflict')
      assert.equal(error.details.clipId, ids.clip)
      return true
    },
  )
})

test('an approved clip can still be edited, and the edit is audited with what changed', (t) => {
  const { db, ids, itemId } = pendingFixture(t)
  const { clipId } = reviewItem(
    db,
    itemId,
    { decision: 'approve', label: 'Ei?', captions: { 'en-US': 'Ei?' }, groupId: ids.group },
    { actor: ADMIN, now: at },
  )

  const edited = reviewItem(
    db,
    itemId,
    { label: 'Ei!', captions: { 'en-US': 'Ei!', 'ja-JP': 'え！' } },
    { actor: ADMIN, now: () => new Date(T10) },
  )
  assert.equal(edited.outcome, 'updated')
  assert.equal(edited.clip.label, 'Ei!')
  assert.deepEqual(edited.clip.captions, { 'en-US': 'Ei!', 'ja-JP': 'え！' })
  assert.deepEqual(edited.clip.missingLocales, ['zh-CN'])

  const detail = JSON.parse(db.prepare("SELECT detail FROM audit_log WHERE action = 'admin.clip.edit'").get().detail)
  assert.deepEqual(detail.diff.label, { before: 'Ei?', after: 'Ei!' })
  assert.equal(Object.hasOwn(detail.diff, 'groupId'), false, 'an unchanged field belongs nowhere in a diff')

  assert.throws(() => reviewItem(db, itemId, {}, { actor: ADMIN, now: at }), /nothing to change/)
  assert.equal(db.prepare('SELECT label FROM clips WHERE id = ?').get(clipId).label, 'Ei!')
})

test('the review desk hands back the item, the choices and the holes', (t) => {
  const { db, ids, itemId } = pendingFixture(t)
  assert.equal(readItem(db, 'no-such-item'), null)

  const desk = readItem(db, itemId)
  assert.equal(desk.item.itemId, itemId)
  assert.equal(desk.item.state, 'pending')
  assert.equal(desk.clip, null)
  assert.equal(desk.batch.progress.pending_count, 1)
  assert.deepEqual(desk.groups.map((g) => g.id), [ids.group])
  assert.deepEqual(desk.locales.map((l) => l.code), ['en-US', 'zh-CN', 'ja-JP'])

  reviewItem(db, itemId, { decision: 'approve', label: 'Ei?', captions: { 'en-US': 'Ei?' }, groupId: ids.group }, { actor: ADMIN, now: at })
  const after = readItem(db, itemId)
  assert.equal(after.clip.state, 'draft')
  assert.deepEqual(after.clip.missingLocales, ['ja-JP', 'zh-CN'])
})

// ---------------------------------------------------------------------------
// publish

function readyToPublish(t) {
  const { db, ids, media, itemId } = pendingFixture(t)
  const paths = workspace(t)
  place(paths.mediaDir, media.storagePath, media.bytes)
  for (const locale of ['en-US', 'zh-CN', 'ja-JP']) {
    db.prepare('INSERT INTO group_captions (group_id, locale, text, updated_at) VALUES (?, ?, ?, ?)').run(
      ids.group,
      locale,
      `alpha ${locale}`,
      T0,
    )
  }
  // seed()'s own clip is a draft with no captions and no file; retiring it keeps
  // this fixture about the one clip under test. (A draft cannot be retired
  // without being published first, so it is simply removed.)
  db.prepare('DELETE FROM clips WHERE id = ?').run(ids.clip)
  const { clipId } = reviewItem(
    db,
    itemId,
    { decision: 'approve', label: 'Ei?', captions: CAPTIONS, groupId: ids.group },
    { actor: ADMIN, now: at },
  )
  return { db, ids, media, itemId, clipId, paths }
}

test('publishing promotes the drafts, writes the catalogue, and logs the promotion and the write separately', (t) => {
  const { db, clipId, paths } = readyToPublish(t)

  const result = publishCatalogue(db, paths, { actor: ADMIN, now: at })
  assert.deepEqual(result.plan.promoting, [clipId])
  assert.equal(result.catalog.catalogChanged, true)
  assert.equal(result.catalog.clips, 1)

  const clip = db.prepare('SELECT state, published_at FROM clips WHERE id = ?').get(clipId)
  assert.equal(clip.state, 'published')
  assert.equal(clip.published_at, T0)

  const document = JSON.parse(readFileSync(paths.catalogFile, 'utf8'))
  assert.deepEqual(document.clips.map((c) => c.id), [clipId])
  assert.deepEqual(Object.keys(document.clips[0].captions), ['en-US', 'zh-CN', 'ja-JP'])

  // Two events with different failure modes, so two entries. The promotion's
  // entry must not claim a catalogue it had not written yet.
  const entries = db.prepare('SELECT action, subject_id, detail FROM audit_log ORDER BY seq').all()
  const verbs = entries.map((e) => e.action)
  assert.deepEqual(verbs, ['admin.item.approve', 'admin.clip.publish', 'admin.catalog.write'])
  assert.equal(JSON.parse(entries[1].detail).consequence, null)
  // The promotion entry has to name what it promoted. diffFields omits a field
  // whose value did not change, so an entry that listed the same clip ids on
  // both sides would record the state change and lose the clips.
  assert.deepEqual(JSON.parse(entries[1].detail).diff.clipIds, { after: [clipId] })
  assert.equal(JSON.parse(entries[2].detail).consequence, `catalog:${result.catalog.catalogSha256}`)
  assert.equal(entries[2].subject_id, result.catalog.catalogSha256)

  // Publishing again is a no-op rather than a rewrite, which is what makes a
  // failed publish safe to re-run.
  const again = publishCatalogue(db, paths, { actor: ADMIN, now: () => new Date(T10) })
  assert.deepEqual(again.plan.promoting, [])
  assert.equal(again.catalog.catalogChanged, false)
})

test('publishing refuses to put a clip on the page with a missing translation, and promotes nothing', (t) => {
  const { db, clipId, paths } = readyToPublish(t)
  db.prepare("DELETE FROM clip_captions WHERE clip_id = ? AND locale = 'ja-JP'").run(clipId)

  assert.throws(
    () => publishCatalogue(db, paths, { actor: ADMIN, now: at }),
    (error) => {
      assert.equal(error.code, 'conflict')
      assert.deepEqual(error.details.blockingHoles, [{ subject_kind: 'clip', subject_id: clipId, locale: 'ja-JP' }])
      return true
    },
    'with no fallbackLocale a missing translation renders as the raw key path',
  )
  assert.equal(db.prepare('SELECT state FROM clips WHERE id = ?').get(clipId).state, 'draft')
  assert.equal(existsSync(paths.catalogFile), false)
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_log WHERE action LIKE 'admin.c%'").get().n, 0)
})

test('a hole that is already on the page is reported, not used to block the publish that would fix something else', (t) => {
  const { db, ids, clipId, paths } = readyToPublish(t)
  publishCatalogue(db, paths, { actor: ADMIN, now: at })

  // The group is live and now loses a translation. Refusing every future publish
  // over it would not close the hole; it would only stop the owner shipping the
  // fix for anything else.
  db.prepare("DELETE FROM group_captions WHERE group_id = ? AND locale = 'ja-JP'").run(ids.group)
  db.prepare("UPDATE clips SET label = 'Ei!' WHERE id = ?").run(clipId)

  const result = publishCatalogue(db, paths, { actor: ADMIN, now: () => new Date(T10) })
  assert.deepEqual(result.plan.blockingHoles, [])
  assert.deepEqual(result.warnings, [{ subject_kind: 'group', subject_id: ids.group, locale: 'ja-JP' }])
  assert.equal(result.catalog.catalogChanged, true)
})

test('publishing refuses when the audio a clip names is not on the volume', (t) => {
  const { db, media, clipId, paths } = readyToPublish(t)
  rmSync(join(paths.mediaDir, media.storagePath))

  assert.throws(
    () => publishCatalogue(db, paths, { actor: ADMIN, now: at }),
    (error) => {
      assert.equal(error.code, 'conflict')
      assert.deepEqual(error.details.mediaProblems.map((p) => p.problem), ['missing'])
      return true
    },
  )
  assert.equal(db.prepare('SELECT state FROM clips WHERE id = ?').get(clipId).state, 'draft')
  assert.equal(existsSync(paths.catalogFile), false)
})

test('a dry run promotes nothing, writes nothing and is not logged as a change', (t) => {
  const { db, clipId, paths } = readyToPublish(t)
  const before = db.prepare('SELECT count(*) AS n FROM audit_log').get().n

  const preview = publishCatalogue(db, paths, { actor: ADMIN, now: at, dryRun: true })
  assert.equal(preview.dryRun, true)
  assert.deepEqual(preview.plan.promoting, [clipId])
  assert.equal(db.prepare('SELECT state FROM clips WHERE id = ?').get(clipId).state, 'draft')
  assert.equal(existsSync(paths.catalogFile), false)
  assert.equal(db.prepare('SELECT count(*) AS n FROM audit_log').get().n, before)
})

// ---------------------------------------------------------------------------
// the log

function threeEntries(db) {
  for (const verb of ['admin.one', 'admin.two', 'admin.three']) {
    record(db, {
      actorKind: 'owner',
      actorOpenId: ADMIN.openId,
      actorDisplayName: ADMIN.displayName,
      verb,
      subject: { kind: 'clip', id: `clip-${verb}` },
      before: null,
      after: null,
      consequence: null,
      succeeded: true,
      occurredAt: T0,
    })
  }
}

test('the log reads newest first and filters on what it is asked to', (t) => {
  const { db } = pendingFixture(t)
  threeEntries(db)
  record(db, {
    actorKind: 'system',
    actorOpenId: null,
    actorDisplayName: 'janitor',
    verb: 'system.sweep',
    subject: { kind: 'media', id: 'blob' },
    before: null,
    after: null,
    consequence: null,
    succeeded: true,
    occurredAt: T10,
  })

  const all = readAuditPage(db)
  assert.deepEqual(all.entries.map((e) => e.verb), ['system.sweep', 'admin.three', 'admin.two', 'admin.one'])
  assert.equal(all.nextCursor, null)

  assert.deepEqual(readAuditPage(db, { actorKind: 'system' }).entries.map((e) => e.verb), ['system.sweep'])
  assert.deepEqual(readAuditPage(db, { actorOpenId: ADMIN.openId }).entries.length, 3)
  assert.deepEqual(readAuditPage(db, { verb: 'admin.two' }).entries.map((e) => e.verb), ['admin.two'])
  assert.deepEqual(readAuditPage(db, { subjectKind: 'media' }).entries.map((e) => e.verb), ['system.sweep'])
  // Timestamps compare as strings, which is chronological only because every
  // one of them is the same canonical second-precision UTC form.
  assert.deepEqual(readAuditPage(db, { since: T10 }).entries.map((e) => e.verb), ['system.sweep'])
  assert.deepEqual(readAuditPage(db, { until: T0 }).entries.length, 3)
})

test('the cursor this pager issues and the one lib/audit.mjs issues are the same cursor', (t) => {
  const { db } = pendingFixture(t)
  threeEntries(db)

  const mine = readAuditPage(db, { limit: 1 })
  assert.deepEqual(mine.entries.map((e) => e.verb), ['admin.three'])
  // Their pager continues from my cursor ...
  const theirs = listByActor(db, { actorOpenId: ADMIN.openId, limit: 1, cursor: mine.nextCursor })
  assert.deepEqual(theirs.entries.map((e) => e.verb), ['admin.two'])
  // ... and mine continues from theirs.
  const back = readAuditPage(db, { limit: 1, cursor: theirs.nextCursor })
  assert.deepEqual(back.entries.map((e) => e.verb), ['admin.one'])
  assert.equal(back.nextCursor, null)
})

test('the log refuses a page size and a cursor it cannot honour', (t) => {
  const { db } = pendingFixture(t)
  for (const limit of [0, -1, 201, 'lots', 1.5]) {
    assert.throws(() => readAuditPage(db, { limit }), /limit must be an integer/)
  }
  assert.throws(() => readAuditPage(db, { cursor: 'not-a-cursor' }), /malformed cursor/)
  // Decodes cleanly and means nothing: without the shape check this would drop
  // the keyset predicate and silently restart the caller at page one.
  const wrongShape = Buffer.from(JSON.stringify({ page: 2 }), 'utf8').toString('base64url')
  assert.throws(() => readAuditPage(db, { cursor: wrongShape }), /malformed cursor/)
  assert.throws(() => readAuditPage(db, { actorKind: 'robot' }), /actorKind must be one of/)
  assert.throws(() => readAuditPage(db, { since: '2026-08-01T00:00:00.000Z' }), /canonical UTC timestamp/)
})

// ---------------------------------------------------------------------------

test('a route that refuses answers with the refusal, not with a 500, and an admin\'s refusal is logged', async (t) => {
  const { db, ids, itemId } = pendingFixture(t)
  const fastify = fakeFastify()
  await adminRoutes(fastify, {
    db,
    adminOpenIds: [ADMIN.openId],
    paths: workspace(t),
    now: at,
  })
  const route = (method, url) => fastify.routes.find((r) => r.method === method && r.url === url).handler
  const call = async (method, url, request) => {
    const reply = fakeReply()
    const body = await route(method, url)({ adminIdentity: ADMIN, ...request }, reply)
    return { reply, body }
  }

  // A page size this route cannot honour is the caller's mistake, not a defect.
  const bad = await call('GET', '/api/admin/queue', { query: { limit: '9000' } })
  assert.equal(bad.reply.state.status, 400)
  assert.equal(bad.reply.state.body.error, 'invalid_request')

  const missing = await call('GET', '/api/admin/item/:id', { params: { id: 'nope' } })
  assert.equal(missing.reply.state.status, 404)

  const ok = await call('GET', '/api/admin/queue', { query: {} })
  assert.equal(ok.reply.state.status, null, 'a successful read must not set a status of its own')
  assert.equal(ok.body.itemCount, 1)

  // A mutation an admin asked for and did not get is worth a line in the log —
  // unlike a refusal by the gate, where the caller is a stranger and the log
  // would be a disk-fill primitive.
  const refused = await call('POST', '/api/admin/item/:id', {
    params: { id: itemId },
    body: { decision: 'reject' },
  })
  assert.equal(refused.reply.state.status, 400)
  const entry = db.prepare("SELECT actor_id, detail FROM audit_log WHERE action = 'admin.refused'").get()
  assert.equal(entry.actor_id, ADMIN.openId)
  assert.equal(JSON.parse(entry.detail).succeeded, false)
  assert.equal(db.prepare('SELECT state FROM batch_items WHERE id = ?').get(itemId).state, 'pending')
  assert.equal(ids.batch, db.prepare('SELECT batch_id FROM batch_items WHERE id = ?').get(itemId).batch_id)
})

test('an error only becomes an HTTP answer when this module knows what it means', () => {
  assert.equal(httpStatusFor(new AdminError('x', { code: 'not_found', status: 404 })), 404)
  assert.equal(httpStatusFor(new AdminError('x', {})), 400)
  assert.equal(httpStatusFor(new CatalogError('x', 'media_missing')), 409)
  assert.equal(httpStatusFor(new CatalogError('x', 'schema_unstamped')), 500)
  assert.equal(httpStatusFor(Object.assign(new Error('x'), { code: 'SQLITE_CONSTRAINT_TRIGGER' })), 409)
  // A defect is not a 4xx. Answering one would tell the caller their request was
  // wrong when it was this code that was.
  assert.equal(httpStatusFor(new TypeError('undefined is not a function')), null)
})
