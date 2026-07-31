// The development bypasses cannot be RECORDED in production — decided by the
// database file, not by the process asking it.
//
// The defect these cover: the triggers read `(SELECT mode FROM instance ...)`
// bare. On a database with no instance row that subquery is NULL,
// `NULL <> 'development'` is NULL, and every one of these triggers quietly did
// not fire — the bypasses were open on precisely the databases nobody had
// migrated. Each refusal below is paired with the same write on a stamped
// development instance, because a refusal that would have happened anyway
// proves nothing about the trigger.

import assert from 'node:assert/strict'
import test from 'node:test'

import { migrate, readInstanceMode } from '../db/migrate.mjs'
import {
  T0,
  T10,
  assertAccepted,
  assertRefused,
  dropTrigger,
  openDatabase,
  seed,
} from './helpers/temp-db.mjs'

function insertBypassVerification(db, ids, { id = 'vc-bypass' } = {}) {
  db.prepare(`
    INSERT INTO verify_codes (
      id, code, session_id, room_id, state, issued_at, expires_at, closed_at, consumed_at,
      submitter_id, observed_open_id, observed_display_name, verified_via
    ) VALUES (?, 'BYP1', ?, 21484828, 'verified', ?, ?, ?, ?, ?, 'open-alpha', 'Alpha', 'dev-bypass')
  `).run(id, ids.session, T0, T10, T0, T0, ids.submitter)
}

function insertBypassedBatch(db, ids, { id = 'bat-bypassed' } = {}) {
  db.prepare(`
    INSERT INTO batches (id, submitter_id, state, created_at, turnstile_required, turnstile_verdict, turnstile_decided_at)
    VALUES (?, ?, 'draft', ?, 1, 'bypassed', ?)
  `).run(id, ids.submitter, T0, T0)
}

test('a dev-bypass verification is refused on a production instance', (t) => {
  const db = openDatabase(t, { mode: 'production' })
  const ids = seed(db)

  assertRefused(
    () => insertBypassVerification(db, ids),
    /dev-bypass identity is refused in production/,
    'a production database recorded a self-declared dev-bypass identity.',
  )
})

test('a dev-bypass verification is refused when the instance row is MISSING — the fail-open case', (t) => {
  const db = openDatabase(t, { mode: 'development' })
  const ids = seed(db)

  // A database built by hand, or one somebody emptied. This is the state the
  // bare subquery read as "no opinion" and therefore as permission.
  db.exec('DELETE FROM instance')
  assert.equal(readInstanceMode(db), null)

  assertRefused(
    () => insertBypassVerification(db, ids),
    /dev-bypass identity is refused in production/,
    'a database with no instance row recorded a dev-bypass identity.',
  )
})

test('a dev-bypass verification is refused when the instance row exists but was never stamped', (t) => {
  const db = openDatabase(t, { mode: 'development' })
  const ids = seed(db)

  // The state schema.sql itself seeds: a row, no mode yet. The ratchet permits
  // this write only because the row is not production; that is what makes the
  // unstamped state reachable, and reachable states are the ones worth testing.
  db.prepare('UPDATE instance SET mode = NULL WHERE id = 1').run()
  assert.equal(readInstanceMode(db), null)

  assertRefused(
    () => insertBypassVerification(db, ids),
    /dev-bypass identity is refused in production/,
    'an unstamped database recorded a dev-bypass identity.',
  )
})

test('a bypassed turnstile verdict is refused on a production instance, on INSERT and on UPDATE alike', (t) => {
  const db = openDatabase(t, { mode: 'production' })
  const ids = seed(db)

  assertRefused(
    () => insertBypassedBatch(db, ids),
    /bypassed turnstile is refused in production/,
    'a production database recorded a bypassed challenge at INSERT.',
  )

  db.prepare(`
    INSERT INTO batches (id, submitter_id, state, created_at, turnstile_required)
    VALUES ('bat-later', ?, 'draft', ?, 1)
  `).run(ids.submitter, T0)

  assertRefused(
    () =>
      db
        .prepare(
          "UPDATE batches SET turnstile_verdict = 'bypassed', turnstile_decided_at = ? WHERE id = 'bat-later'",
        )
        .run(T0),
    /bypassed turnstile is refused in production/,
    'a production database recorded a bypassed challenge at UPDATE.',
  )

  assert.equal(
    db.prepare("SELECT turnstile_verdict FROM batches WHERE id = 'bat-later'").get().turnstile_verdict,
    null,
  )
})

test('a bypassed turnstile verdict is refused when the instance row is missing', (t) => {
  const db = openDatabase(t, { mode: 'development' })
  const ids = seed(db)
  db.exec('DELETE FROM instance')

  assertRefused(
    () => insertBypassedBatch(db, ids),
    /bypassed turnstile is refused in production/,
    'a database with no instance row recorded a bypassed challenge.',
  )
})

test('both bypasses ARE accepted on a stamped development instance, which is what proves the refusals above are not vacuous', (t) => {
  const db = openDatabase(t, { mode: 'development' })
  const ids = seed(db)
  assert.equal(readInstanceMode(db), 'development')

  assertAccepted(
    () => insertBypassVerification(db, ids),
    'a development database refused the honest dev-bypass path.',
  )
  assertAccepted(
    () => insertBypassedBatch(db, ids),
    'a development database refused a bypassed challenge.',
  )

  assert.equal(
    db.prepare("SELECT verified_via FROM verify_codes WHERE id = 'vc-bypass'").get().verified_via,
    'dev-bypass',
  )
})

test('instance.mode is a one-way ratchet: production cannot be talked back into development, nor out through NULL', (t) => {
  const db = openDatabase(t, { mode: 'development' })

  // Development may become production…
  assertAccepted(
    () => db.prepare("UPDATE instance SET mode = 'production' WHERE id = 1").run(),
    'the ratchet refused the direction it is supposed to allow.',
  )

  // …and then never the reverse, including the two-step route through NULL:
  // with a plain '<>' that first hop would not have fired, because
  // NULL <> 'production' is NULL.
  assertRefused(
    () => db.prepare("UPDATE instance SET mode = 'development' WHERE id = 1").run(),
    /cannot be moved out of production/,
    'a production database was re-marked development.',
  )
  assertRefused(
    () => db.prepare('UPDATE instance SET mode = NULL WHERE id = 1').run(),
    /cannot be moved out of production/,
    'a production database was un-marked through NULL.',
  )

  assert.equal(readInstanceMode(db), 'production')
})

test('migrate() refuses to re-mark a production database as development, and says which way round it is', (t) => {
  const db = openDatabase(t, { mode: 'production' })

  assert.throws(
    () => migrate(db, { mode: 'development', now: T0 }),
    /marked 'production' and cannot be re-marked 'development'/,
  )
  assert.equal(readInstanceMode(db), 'production')
})

test('the bypass refusals can go red: with the triggers dropped, both bypassed rows land on a production database', (t) => {
  const db = openDatabase(t, { mode: 'production' })
  const ids = seed(db)

  dropTrigger(db, 'verify_codes_no_bypass_in_production')
  dropTrigger(db, 'batches_no_bypass_in_production')

  insertBypassVerification(db, ids)
  insertBypassedBatch(db, ids)

  assert.equal(
    db.prepare("SELECT count(*) AS n FROM verify_codes WHERE verified_via = 'dev-bypass'").get().n,
    1,
    'without the trigger the bypassed verification must land — otherwise the refusal test proves nothing',
  )
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM batches WHERE turnstile_verdict = 'bypassed'").get().n,
    1,
  )
})
