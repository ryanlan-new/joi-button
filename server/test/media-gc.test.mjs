// Media reclamation (STORY-077): what is collectable, and what a sweep does.
//
// The invariant test below is the one that matters: a blob any clip or any live
// item still points at must NEVER be collectable, and it is driven in both
// directions so it goes red if the predicate ever widens to include one.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { reviewItem } from '../routes/admin.mjs'
import {
  RECYCLE_RETENTION_DAYS,
  collectMedia,
  listCollectable,
  reclaimablePreview,
} from '../lib/media-gc.mjs'
import { T0, openDatabase, seed } from './helpers/temp-db.mjs'

const ADMIN = Object.freeze({ openId: 'open-alpha', displayName: 'Owner' })
const DAY_MS = 24 * 60 * 60 * 1000
const AGED = () => new Date(Date.parse(T0) + (RECYCLE_RETENTION_DAYS + 1) * DAY_MS)
const FRESH = () => new Date(Date.parse(T0) + 1 * DAY_MS)
const at0 = () => new Date(T0)

function putMedia(db, content, { now = T0 } = {}) {
  const bytes = Buffer.from(content, 'utf8')
  const digest = createHash('sha256').update(bytes).digest('hex')
  db.prepare(
    'INSERT INTO media (sha256, ext, content_type, bytes, duration_seconds, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(digest, 'mp3', 'audio/mpeg', bytes.length, 2.25, now)
  const storagePath = db.prepare('SELECT storage_path FROM media WHERE sha256 = ?').get(digest).storage_path
  return { sha256: digest, bytes, storagePath }
}

function addItem(db, batchId, position, media, { now = T0 } = {}) {
  const id = `${batchId}-item-${position}`
  db.prepare(
    'INSERT INTO batch_items (id, batch_id, position, media_sha256, proposed_label, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, batchId, position, media.sha256, `Proposed ${position}`, now)
  return id
}

function submitBatch(db, batchId, submittedAt = T0) {
  db.prepare("UPDATE batches SET state = 'submitted', submitted_at = ? WHERE id = ?").run(submittedAt, batchId)
}

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'joi-media-gc-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, mediaDir: join(dir, 'media') }
}

function place(root, storagePath, bytes) {
  const target = join(root, storagePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, bytes)
}

const has = (list, sha) => list.some((c) => c.sha256 === sha)

test('a blob any clip or live item still points at is NEVER collectable; a rejected, aged one is', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  // seed leaves an unreferenced blob floating (ids.media2); drop it so this test
  // reasons only about the rows it makes.
  db.prepare('DELETE FROM media WHERE sha256 = ?').run(ids.media2)

  // seed's clip-alpha references ids.media as a DRAFT. Build the other states.
  const pendingMedia = putMedia(db, 'still-pending')
  addItem(db, ids.batch, 1, pendingMedia)
  const rejectedMedia = putMedia(db, 'rejected-and-old')
  const rejectedItem = addItem(db, ids.batch, 2, rejectedMedia)
  submitBatch(db, ids.batch)
  reviewItem(db, rejectedItem, { decision: 'reject', reason: 'no' }, { actor: ADMIN, now: at0 })

  // AT THE RETENTION HORIZON, only the rejected blob has aged out. The clip's
  // (draft) blob and the pending blob are referenced, so they are not even in the
  // unreferenced set.
  let collectable = listCollectable(db, { now: AGED })
  assert.equal(has(collectable, rejectedMedia.sha256), true, 'a rejected, aged blob is collectable')
  assert.equal(has(collectable, ids.media), false, 'a clip still points at ids.media')
  assert.equal(has(collectable, pendingMedia.sha256), false, 'a pending item still points at its blob')

  // The clip's state does not matter: published or retired, the row still points
  // at the blob, so it stays out of the collectable set. (This is the promise the
  // whole "clips are retired, not deleted" design rests on.)
  db.prepare("UPDATE clips SET state = 'published', published_at = ?, retired_at = NULL WHERE media_sha256 = ?").run(T0, ids.media)
  assert.equal(has(listCollectable(db, { now: AGED }), ids.media), false, 'a published clip still protects its blob')

  db.prepare("UPDATE clips SET state = 'retired', published_at = ?, retired_at = ? WHERE media_sha256 = ?").run(T0, T0, ids.media)
  assert.equal(has(listCollectable(db, { now: AGED }), ids.media), false, 'a retired clip still protects its blob')
})

test('the retention window holds a recent rejection back until it ages out', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  db.prepare('DELETE FROM media WHERE sha256 = ?').run(ids.media2)
  const media = putMedia(db, 'rejected-recently')
  const item = addItem(db, ids.batch, 1, media)
  submitBatch(db, ids.batch)
  reviewItem(db, item, { decision: 'reject', reason: 'no' }, { actor: ADMIN, now: at0 })

  assert.equal(has(listCollectable(db, { now: FRESH }), media.sha256), false, 'one day on, still within the window')
  assert.equal(has(listCollectable(db, { now: AGED }), media.sha256), true, 'past the window, collectable')
})

test('an abandoned upload in a cancelled batch ages out and is collectable', (t) => {
  // A cancelled batch keeps its items pending forever, so they never resolve and
  // v_unreferenced_media only counts a pending item while its batch is live.
  const db = openDatabase(t)
  const ids = seed(db)
  db.prepare('DELETE FROM media WHERE sha256 = ?').run(ids.media2)
  const media = putMedia(db, 'abandoned')
  addItem(db, ids.batch, 1, media)
  submitBatch(db, ids.batch)
  db.prepare("UPDATE batches SET state = 'cancelled' WHERE id = ?").run(ids.batch)

  // No resolved_at (still pending), so the age anchor falls back to created_at.
  assert.equal(has(listCollectable(db, { now: AGED }), media.sha256), true)
  assert.equal(has(listCollectable(db, { now: FRESH }), media.sha256), false)
})

test('collectMedia marks, audits and removes the file — then a re-run collects nothing', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  db.prepare('DELETE FROM media WHERE sha256 = ?').run(ids.media2)
  const paths = workspace(t)
  const media = putMedia(db, 'to-be-collected')
  place(paths.mediaDir, media.storagePath, media.bytes)
  const item = addItem(db, ids.batch, 1, media)
  submitBatch(db, ids.batch)
  reviewItem(db, item, { decision: 'reject', reason: 'no' }, { actor: ADMIN, now: at0 })

  const preview = reclaimablePreview(db, { now: AGED })
  assert.equal(preview.count, 1)
  assert.equal(preview.totalBytes, media.bytes.length)
  assert.equal(preview.retentionDays, RECYCLE_RETENTION_DAYS)

  const result = collectMedia(db, paths.mediaDir, { actor: ADMIN, now: AGED })
  assert.equal(result.count, 1)
  assert.equal(result.freedBytes, media.bytes.length)
  assert.deepEqual(result.failures, [])

  // The row stays; only its file and its mark change.
  assert.equal(existsSync(join(paths.mediaDir, media.storagePath)), false, 'the file is gone')
  assert.notEqual(db.prepare('SELECT collected_at FROM media WHERE sha256 = ?').get(media.sha256).collected_at, null)

  const entry = db.prepare("SELECT subject_id, actor_kind, detail FROM audit_log WHERE action = 'admin.media.collect'").get()
  assert.equal(entry.subject_id, media.sha256)
  assert.equal(entry.actor_kind, 'owner')
  assert.equal(JSON.parse(entry.detail).succeeded, true)

  // Collected, so no longer listed, and a second sweep is a clean no-op.
  assert.equal(has(listCollectable(db, { now: AGED }), media.sha256), false)
  assert.equal(collectMedia(db, paths.mediaDir, { actor: ADMIN, now: AGED }).count, 0)

  // And clearing the mark (what a re-submit does in routes/public.mjs) makes it
  // collectable again — collected_at was the only thing hiding it.
  db.prepare('UPDATE media SET collected_at = NULL WHERE sha256 = ?').run(media.sha256)
  assert.equal(has(listCollectable(db, { now: AGED }), media.sha256), true)
})

test('a blob whose file cannot be removed is a failure, not freed, though its row is still marked', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  db.prepare('DELETE FROM media WHERE sha256 = ?').run(ids.media2)
  const paths = workspace(t)
  const media = putMedia(db, 'cannot-remove')
  // A DIRECTORY where the file should be: unlinkSync then throws a non-ENOENT
  // error (EPERM/EISDIR), standing in for a read-only mount or a locked file.
  mkdirSync(join(paths.mediaDir, media.storagePath), { recursive: true })
  const item = addItem(db, ids.batch, 1, media)
  submitBatch(db, ids.batch)
  reviewItem(db, item, { decision: 'reject', reason: 'no' }, { actor: ADMIN, now: at0 })

  const result = collectMedia(db, paths.mediaDir, { actor: ADMIN, now: AGED })
  // The un-removable blob is a failure and NOT counted as freed — the "freed X"
  // the panel shows must be bytes that actually left the disk.
  assert.equal(result.count, 0)
  assert.equal(result.freedBytes, 0)
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].sha256, media.sha256)
  // The row is marked collected regardless (source-of-truth ordering), so it is
  // not swept again; a re-submit or a hand sweep reclaims the leaked bytes.
  assert.notEqual(db.prepare('SELECT collected_at FROM media WHERE sha256 = ?').get(media.sha256).collected_at, null)
  assert.equal(existsSync(join(paths.mediaDir, media.storagePath)), true)
})
