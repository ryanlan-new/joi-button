// audit_log is append-only, and the database is what says so.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { record, verifyAppendOnly } from '../lib/audit.mjs'
import {
  T0,
  assertRefused,
  dropTrigger,
  openDatabase,
} from './helpers/temp-db.mjs'

function appendRow(db, { id = randomUUID(), action = 'clip.publish' } = {}) {
  db.prepare(`
    INSERT INTO audit_log (id, at, actor_kind, actor_id, action, subject_kind, subject_id, detail)
    VALUES (?, ?, 'owner', 'open-owner', ?, 'clip', 'clip-alpha', NULL)
  `).run(id, T0, action)
  return id
}

test('audit_log refuses an UPDATE, so a wrong entry can only be superseded and never rewritten', (t) => {
  const db = openDatabase(t)
  const id = appendRow(db)

  assertRefused(
    () => db.prepare('UPDATE audit_log SET action = ? WHERE id = ?').run('tampered', id),
    /append-only: UPDATE is refused/,
    'audit_log accepted an UPDATE.',
  )

  // The refusal is worth nothing if it left the row changed anyway.
  assert.equal(db.prepare('SELECT action FROM audit_log WHERE id = ?').get(id).action, 'clip.publish')
})

test('audit_log refuses a DELETE, so the trail cannot be shortened after the fact', (t) => {
  const db = openDatabase(t)
  const id = appendRow(db)

  assertRefused(
    () => db.prepare('DELETE FROM audit_log WHERE id = ?').run(id),
    /append-only: DELETE is refused/,
    'audit_log accepted a DELETE.',
  )
  assertRefused(
    () => db.exec('DELETE FROM audit_log'),
    /append-only: DELETE is refused/,
    'audit_log accepted an unqualified DELETE.',
  )

  assert.equal(db.prepare('SELECT count(*) AS n FROM audit_log').get().n, 1)
})

test('an UPDATE that matches no row raises nothing, which is why every probe here inserts its own row first', (t) => {
  const db = openDatabase(t)

  // A BEFORE UPDATE trigger fires per row. Against an empty log both statements
  // succeed, so a test that skipped the INSERT would report the guards as
  // present on a database that has none of them.
  const updated = db.prepare("UPDATE audit_log SET action = 'x' WHERE id = 'absent'").run()
  const deleted = db.prepare("DELETE FROM audit_log WHERE id = 'absent'").run()
  assert.equal(updated.changes, 0)
  assert.equal(deleted.changes, 0)
})

test('the append-only assertions above can go red: with the triggers dropped, the same UPDATE and DELETE land', (t) => {
  const db = openDatabase(t)
  const id = appendRow(db)

  dropTrigger(db, 'audit_log_no_update')
  dropTrigger(db, 'audit_log_no_delete')

  db.prepare('UPDATE audit_log SET action = ? WHERE id = ?').run('tampered', id)
  assert.equal(
    db.prepare('SELECT action FROM audit_log WHERE id = ?').get(id).action,
    'tampered',
    'without the trigger the UPDATE must land — otherwise the test above proves nothing',
  )

  db.prepare('DELETE FROM audit_log WHERE id = ?').run(id)
  assert.equal(db.prepare('SELECT count(*) AS n FROM audit_log').get().n, 0)
})

test('verifyAppendOnly() finds both guards on a freshly migrated database and leaves no probe row behind', (t) => {
  const db = openDatabase(t)

  assert.doesNotThrow(() => verifyAppendOnly(db))
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM audit_log').get().n,
    0,
    'the probe row must be rolled back; an audit log that grows when it is checked is not an audit log',
  )
})

test('verifyAppendOnly() reports the log as tampered-with when the UPDATE guard is gone', (t) => {
  const db = openDatabase(t)
  dropTrigger(db, 'audit_log_no_update')

  assert.throws(() => verifyAppendOnly(db), /accepted a UPDATE/)
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM audit_log').get().n,
    0,
    'the savepoint must roll back even when the probe fails',
  )
})

test('record() writes a row the table accepts, and audit.mjs never issues an UPDATE to fix one', (t) => {
  const db = openDatabase(t)

  const entry = record(db, {
    actorKind: 'owner',
    actorOpenId: 'open-owner',
    actorDisplayName: 'Owner',
    verb: 'clip.publish',
    subject: { kind: 'clip', id: 'clip-alpha' },
    before: { state: 'draft' },
    after: { state: 'published' },
    consequence: null,
    succeeded: true,
    occurredAt: T0,
  })

  const row = db.prepare('SELECT at, action, detail FROM audit_log WHERE id = ?').get(entry.id)
  assert.equal(row.at, T0, 'audit rows carry second-precision timestamps; the column CHECK refuses anything else')
  assert.equal(row.action, 'clip.publish')
  assert.deepEqual(JSON.parse(row.detail).diff, { state: { before: 'draft', after: 'published' } })
})
