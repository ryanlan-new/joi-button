// The two-level batch state machine, at the level that enforces it.
//
// Two defects live here. A BEFORE UPDATE trigger says nothing about a row that
// ARRIVES in the state it guards, so one INSERT naming state = 'submitted' with
// turnstile_required = 1 and no verdict was accepted by this database. And
// `batches_resolve_needs_all_items_resolved` used to let an EMPTY batch through
// while v_batch_progress had always reported it as is_resolvable = 0 — two
// answers to the same question, one of them wrong.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  T0,
  T10,
  assertAccepted,
  assertRefused,
  dropTrigger,
  openDatabase,
  seed,
} from './helpers/temp-db.mjs'

const INSERT_BATCH = `
  INSERT INTO batches (
    id, submitter_id, state, created_at, submitted_at, resolved_at,
    turnstile_required, turnstile_verdict, turnstile_decided_at
  ) VALUES (@id, @submitter, @state, @created, @submitted, @resolved, @required, @verdict, @decided)
`

function batchRow(ids, overrides = {}) {
  return {
    id: 'bat-under-test',
    submitter: ids.submitter,
    state: 'draft',
    created: T0,
    submitted: null,
    resolved: null,
    required: 0,
    verdict: null,
    decided: null,
    ...overrides,
  }
}

function addItem(db, ids, { id = 'item-1', position = 1, media = ids.media, batch = ids.batch } = {}) {
  db.prepare(`
    INSERT INTO batch_items (id, batch_id, position, media_sha256, proposed_label, created_at)
    VALUES (?, ?, ?, ?, 'A proposed label', ?)
  `).run(id, batch, position, media, T0)
  return id
}

test('a batch cannot be INSERTED already submitted when the challenge it demanded has no verdict', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)

  assertRefused(
    () =>
      db
        .prepare(INSERT_BATCH)
        .run(batchRow(ids, { state: 'submitted', submitted: T0, required: 1 })),
    /turnstile was required and has not passed/,
    'a batch arrived submitted with an unmet challenge.',
  )
})

test('a batch cannot be INSERTED already submitted carrying a FAILED verdict', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)

  assertRefused(
    () =>
      db.prepare(INSERT_BATCH).run(
        batchRow(ids, {
          state: 'submitted',
          submitted: T0,
          required: 1,
          verdict: 'failed',
          decided: T0,
        }),
      ),
    /turnstile was required and has not passed/,
    'a batch arrived submitted with a failed challenge.',
  )
})

test('the same INSERT with a passed verdict is accepted, which is what proves the two refusals above are about the verdict', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)

  assertAccepted(
    () =>
      db.prepare(INSERT_BATCH).run(
        batchRow(ids, {
          state: 'submitted',
          submitted: T0,
          required: 1,
          verdict: 'passed',
          decided: T0,
        }),
      ),
    'a batch that really did pass its challenge was refused.',
  )
  assert.equal(db.prepare("SELECT state FROM batches WHERE id = 'bat-under-test'").get().state, 'submitted')
})

test('a draft batch cannot be UPDATEd to submitted while the challenge it demanded has no verdict', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  db.prepare('UPDATE batches SET turnstile_required = 1 WHERE id = ?').run(ids.batch)

  assertRefused(
    () =>
      db
        .prepare("UPDATE batches SET state = 'submitted', submitted_at = ? WHERE id = ?")
        .run(T0, ids.batch),
    /turnstile was required and has not passed/,
    'a draft batch was submitted past an unmet challenge.',
  )
  assert.equal(db.prepare('SELECT state FROM batches WHERE id = ?').get(ids.batch).state, 'draft')
})

test('a draft whose items are all decided cannot skip straight to resolved past an unmet challenge either', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  db.prepare('UPDATE batches SET turnstile_required = 1 WHERE id = ?').run(ids.batch)
  addItem(db, ids)
  db.prepare(`
    UPDATE batch_items SET state = 'rejected', resolved_at = ?, reviewer_note = 'no' WHERE id = 'item-1'
  `).run(T0)

  // 'resolved' is named alongside 'submitted' in the trigger precisely because
  // one statement can reach the reviewed state without ever passing through
  // the value a submitted-only guard would read.
  assertRefused(
    () =>
      db
        .prepare(
          "UPDATE batches SET state = 'resolved', submitted_at = ?, resolved_at = ? WHERE id = ?",
        )
        .run(T0, T10, ids.batch),
    /turnstile was required and has not passed/,
    'a batch reached the reviewed state past an unmet challenge.',
  )
})

test('a batch cannot be resolved while any of its items is still pending', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  addItem(db, ids, { id: 'item-1', position: 1, media: ids.media })
  addItem(db, ids, { id: 'item-2', position: 2, media: ids.media2 })
  db.prepare(`
    UPDATE batch_items SET state = 'rejected', resolved_at = ?, reviewer_note = 'no' WHERE id = 'item-1'
  `).run(T0)

  assertRefused(
    () =>
      db
        .prepare(
          "UPDATE batches SET state = 'resolved', submitted_at = ?, resolved_at = ? WHERE id = ?",
        )
        .run(T0, T10, ids.batch),
    /this one has none, or has pending ones/,
    'a batch resolved while an item was still under review.',
  )
})

test('a batch with no items at all cannot be resolved — it was abandoned, not reviewed', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  assert.equal(db.prepare('SELECT count(*) AS n FROM batch_items WHERE batch_id = ?').get(ids.batch).n, 0)

  assertRefused(
    () =>
      db
        .prepare(
          "UPDATE batches SET state = 'resolved', submitted_at = ?, resolved_at = ? WHERE id = ?",
        )
        .run(T0, T10, ids.batch),
    /this one has none, or has pending ones/,
    'an empty batch resolved.',
  )
})

test('v_batch_progress and the resolve trigger give the SAME answer about an empty batch', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)

  const empty = db.prepare('SELECT * FROM v_batch_progress WHERE batch_id = ?').get(ids.batch)
  assert.equal(empty.item_count, 0)
  assert.equal(empty.pending_count, 0, 'sum() over an empty batch is NULL; the view coalesces it to 0')
  assert.equal(empty.is_resolvable, 0, 'the view has always said an empty batch is not resolvable')

  addItem(db, ids)
  const pending = db.prepare('SELECT * FROM v_batch_progress WHERE batch_id = ?').get(ids.batch)
  assert.equal(pending.is_resolvable, 0)

  db.prepare(`
    UPDATE batch_items SET state = 'rejected', resolved_at = ?, reviewer_note = 'no' WHERE id = 'item-1'
  `).run(T0)
  const decided = db.prepare('SELECT * FROM v_batch_progress WHERE batch_id = ?').get(ids.batch)
  assert.equal(decided.is_resolvable, 1)
  assert.equal(decided.rejected_count, 1)
})

test('a batch whose items are all decided resolves, so the refusals above are about the items and not about resolving', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  addItem(db, ids)
  db.prepare(`
    UPDATE batch_items SET state = 'rejected', resolved_at = ?, reviewer_note = 'no' WHERE id = 'item-1'
  `).run(T0)

  assertAccepted(
    () =>
      db
        .prepare(
          "UPDATE batches SET state = 'resolved', submitted_at = ?, resolved_at = ? WHERE id = ?",
        )
        .run(T0, T10, ids.batch),
    'a fully decided batch could not be resolved.',
  )
  assert.equal(db.prepare('SELECT state FROM batches WHERE id = ?').get(ids.batch).state, 'resolved')
})

test('a batch cannot be INSERTED resolved at all, because its items cannot exist before it does', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)

  assertRefused(
    () =>
      db
        .prepare(INSERT_BATCH)
        .run(batchRow(ids, { state: 'resolved', submitted: T0, resolved: T10 })),
    /this one has none, or has pending ones/,
    'a batch arrived resolved.',
  )
})

test('items may only be added to a draft batch, so the set under review is frozen once it is submitted', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  addItem(db, ids)
  db.prepare("UPDATE batches SET state = 'submitted', submitted_at = ? WHERE id = ?").run(T0, ids.batch)

  assertRefused(
    () => addItem(db, ids, { id: 'item-2', position: 2, media: ids.media2 }),
    /items may only be added to a draft batch/,
    'an item was appended to a batch that was already under review.',
  )
})

test('the batch refusals can go red: with the triggers dropped, a submitted-with-no-verdict batch and an empty resolve both land', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)

  dropTrigger(db, 'batches_insert_submit_needs_turnstile')
  dropTrigger(db, 'batches_resolve_needs_all_items_resolved')

  db.prepare(INSERT_BATCH).run(batchRow(ids, { state: 'submitted', submitted: T0, required: 1 }))
  assert.equal(
    db.prepare("SELECT turnstile_verdict FROM batches WHERE id = 'bat-under-test'").get().turnstile_verdict,
    null,
    'without the trigger a batch with an unmet challenge must arrive submitted — otherwise the test above proves nothing',
  )

  db.prepare("UPDATE batches SET state = 'resolved', submitted_at = ?, resolved_at = ? WHERE id = ?").run(
    T0,
    T10,
    ids.batch,
  )
  assert.equal(db.prepare('SELECT state FROM batches WHERE id = ?').get(ids.batch).state, 'resolved')
})
