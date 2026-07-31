// What a spent code PROVED is as terminal as the fact that it was spent.
//
// Guarding `state` alone left the proof itself writable: a verified row could
// keep its state and be re-pointed at a different submitter, or have its
// observed_open_id rewritten to someone who never sent a danmaku, and the
// history would still read as a clean verification.

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

const REWRITE_REFUSED = /the identity a spent code proved is not rewritable/

function insertVerified(db, ids, { id = 'vc-verified', code = 'ABC123' } = {}) {
  db.prepare(`
    INSERT INTO verify_codes (
      id, code, session_id, room_id, state, issued_at, expires_at, closed_at, consumed_at,
      submitter_id, observed_open_id, observed_display_name, verified_via
    ) VALUES (?, ?, ?, 21484828, 'verified', ?, ?, ?, ?, ?, 'open-alpha', 'Alpha', 'danmaku')
  `).run(id, code, ids.session, T0, T10, T0, T0, ids.submitter)
  return id
}

function insertPending(db, ids, { id = 'vc-pending', code = 'PEND01' } = {}) {
  db.prepare(`
    INSERT INTO verify_codes (id, code, session_id, room_id, state, issued_at, expires_at)
    VALUES (?, ?, ?, 21484828, 'pending', ?, ?)
  `).run(id, code, ids.session, T0, T10)
  return id
}

test('a verified code cannot be re-pointed at a different submitter', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  insertVerified(db, ids)

  assertRefused(
    () => db.prepare("UPDATE verify_codes SET submitter_id = ? WHERE id = 'vc-verified'").run(ids.submitter2),
    REWRITE_REFUSED,
    'a spent proof of identity was reassigned to someone else.',
  )
  assert.equal(
    db.prepare("SELECT submitter_id FROM verify_codes WHERE id = 'vc-verified'").get().submitter_id,
    ids.submitter,
  )
})

test('a verified code cannot have the open_id it observed rewritten', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  insertVerified(db, ids)

  assertRefused(
    () =>
      db
        .prepare("UPDATE verify_codes SET observed_open_id = 'open-someone-else' WHERE id = 'vc-verified'")
        .run(),
    REWRITE_REFUSED,
    'the open_id a code observed was rewritten to someone who never sent a danmaku.',
  )
})

test('a verified code cannot have its observed display name, its verified_via or its consumed_at rewritten', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  insertVerified(db, ids)

  assertRefused(
    () =>
      db.prepare("UPDATE verify_codes SET observed_display_name = 'Someone' WHERE id = 'vc-verified'").run(),
    REWRITE_REFUSED,
    'the observed nickname on a spent code was rewritten.',
  )
  assertRefused(
    () => db.prepare("UPDATE verify_codes SET verified_via = NULL WHERE id = 'vc-verified'").run(),
    REWRITE_REFUSED,
    'the means by which a code was verified was erased.',
  )
  assertRefused(
    () => db.prepare('UPDATE verify_codes SET consumed_at = ? WHERE id = ?').run(T10, 'vc-verified'),
    REWRITE_REFUSED,
    'the moment a code was spent was moved.',
  )
})

test('a code that expired without ever verifying cannot have an identity filled in afterwards', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  insertPending(db, ids)
  db.prepare("UPDATE verify_codes SET state = 'expired', closed_at = ? WHERE id = 'vc-pending'").run(T10)

  // This is the case `IS NOT` exists for. Every one of these columns is NULL on
  // a code that never verified, and `NEW.observed_open_id <> OLD.observed_open_id`
  // against NULL is NULL — so a plain comparison let the identity of an expired
  // or cancelled code be written after the fact, which is a verification that
  // never happened.
  assertRefused(
    () =>
      db
        .prepare("UPDATE verify_codes SET observed_open_id = 'open-fabricated' WHERE id = 'vc-pending'")
        .run(),
    REWRITE_REFUSED,
    'an expired code was given an identity it never proved.',
  )
  assertRefused(
    () => db.prepare('UPDATE verify_codes SET submitter_id = ? WHERE id = ?').run(ids.submitter, 'vc-pending'),
    REWRITE_REFUSED,
    'an expired code was attached to a submitter after the fact.',
  )
})

test('a PENDING code can still be verified, so the guard stops rewrites and not the verification itself', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  insertPending(db, ids)

  assertAccepted(
    () =>
      db
        .prepare(`
          UPDATE verify_codes SET
            state = 'verified', closed_at = @at, consumed_at = @at,
            submitter_id = @submitter, observed_open_id = 'open-alpha',
            observed_display_name = 'Alpha', verified_via = 'danmaku'
          WHERE id = 'vc-pending'
        `)
        .run({ at: T0, submitter: ids.submitter }),
    'the verification path itself was refused.',
  )

  const row = db.prepare("SELECT state, verified_via FROM verify_codes WHERE id = 'vc-pending'").get()
  assert.equal(row.state, 'verified')
  assert.equal(row.verified_via, 'danmaku')

  // …and now it is spent, so the second attempt is refused. Same row, same
  // statement shape, opposite outcome: that is the guard being observed.
  assertRefused(
    () => db.prepare("UPDATE verify_codes SET observed_open_id = 'open-other' WHERE id = 'vc-pending'").run(),
    REWRITE_REFUSED,
    'a code that had just been spent was still rewritable.',
  )
})

test('state is terminal once a code leaves pending, so a replayed danmaku cannot re-verify it', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  insertVerified(db, ids)

  assertRefused(
    () => db.prepare("UPDATE verify_codes SET state = 'pending' WHERE id = 'vc-verified'").run(),
    /state is terminal once it leaves pending/,
    'a spent code re-entered pending.',
  )
})

test('verify_codes.code is immutable, because a code that can be rewritten can be reissued', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  insertPending(db, ids)

  assertRefused(
    () => db.prepare("UPDATE verify_codes SET code = 'OTHER1' WHERE id = 'vc-pending'").run(),
    /code is immutable/,
    'a one-time code was rewritten.',
  )
})

test('the identity refusals can go red: with verify_codes_terminal_identity dropped, the rewrite lands', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  insertVerified(db, ids)
  dropTrigger(db, 'verify_codes_terminal_identity')

  db.prepare("UPDATE verify_codes SET observed_open_id = 'open-someone-else' WHERE id = 'vc-verified'").run()
  assert.equal(
    db.prepare("SELECT observed_open_id FROM verify_codes WHERE id = 'vc-verified'").get().observed_open_id,
    'open-someone-else',
    'without the trigger the rewrite must land — otherwise the tests above prove nothing',
  )
})

test('v_room_demand counts exactly the pending codes, which is the reference count the room listener runs on', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  insertPending(db, ids, { id: 'vc-a', code: 'AAAA11' })
  insertPending(db, ids, { id: 'vc-b', code: 'BBBB22' })
  insertVerified(db, ids)

  assert.equal(db.prepare('SELECT count(*) AS n FROM v_room_demand').get().n, 2)
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM v_room_demand WHERE expires_at > ?').get(T10).n,
    0,
    'demand is derived from rows and an absolute expiry, never from a stored counter',
  )
})
