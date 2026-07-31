// Throwaway databases, and the two assertions every schema test is made of.
//
// Every database here is a FILE in a fresh temporary directory, never :memory:.
// migrate() sets journal_mode = WAL, which is persisted in the file header and
// which an in-memory database can never report — assertConnectionPragmas()
// exempts 'memory' so tests CAN run that way, and taking the exemption would
// mean the tests never exercise the mode the deployment actually runs in.
//
// The directory is removed in t.after(), which also collects the -wal and -shm
// files WAL leaves beside the database.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'

import { migrate } from '../../db/migrate.mjs'

/** A fixed instant, so a failure message never depends on when it ran. */
export const T0 = '2026-08-01T00:00:00Z'
export const T10 = '2026-08-01T00:10:00Z'

let probeSeq = 0

/**
 * A migrated database in its own temporary directory.
 *
 * `mode` is what migrate() stamps into `instance`, which is the fact the
 * dev-bypass triggers in schema.sql consult. It defaults to 'production' for
 * the same reason migrate() does: the failure of guessing wrong is
 * one-directional.
 */
export function openDatabase(t, { mode = 'production', now = T0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'joi-button-server-test-'))
  const db = new Database(join(dir, 'joi.db'))
  t.after(() => {
    if (db.open) db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  migrate(db, { mode, now })
  return db
}

/** A 64-character lowercase-hex blob id, which is what media.sha256 CHECKs for. */
export function hex64(seed) {
  return String(seed).padStart(64, '0').slice(-64).replace(/[^0-9a-f]/g, '0')
}

/**
 * One row in every table a submission touches, so a test can write the single
 * row it is actually about.
 */
export function seed(db, { now = T0, later = T10 } = {}) {
  const ids = {
    group: 'grp-alpha',
    clip: 'clip-alpha',
    media: hex64('a1'),
    media2: hex64('b2'),
    submitter: 'sub-alpha',
    submitter2: 'sub-beta',
    session: 'ses-alpha',
    batch: 'bat-alpha',
    now,
    later,
  }

  db.prepare('INSERT INTO groups (id, display_name, created_at) VALUES (?, ?, ?)').run(
    ids.group,
    'Alpha',
    now,
  )
  const media = db.prepare(
    'INSERT INTO media (sha256, ext, content_type, bytes, duration_seconds, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  media.run(ids.media, 'mp3', 'audio/mpeg', 4096, 1.25, now)
  media.run(ids.media2, 'mp3', 'audio/mpeg', 8192, 2.5, now)

  const submitter = db.prepare(`
    INSERT INTO submitters (id, open_id, display_name, display_name_seen_at, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  submitter.run(ids.submitter, 'open-alpha', 'Alpha', now, now, now)
  submitter.run(ids.submitter2, 'open-beta', 'Beta', now, now, now)

  db.prepare(`
    INSERT INTO sessions (id, token_sha256, created_at, last_seen_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(ids.session, hex64('c3'), now, now, later)

  db.prepare(`
    INSERT INTO batches (id, submitter_id, session_id, state, created_at)
    VALUES (?, ?, ?, 'draft', ?)
  `).run(ids.batch, ids.submitter, ids.session, now)

  db.prepare(`
    INSERT INTO clips (id, group_id, media_sha256, label, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(ids.clip, ids.group, ids.media, 'Alpha clip', now)

  return ids
}

/** Run `fn` and roll back whatever it wrote, so a probe leaves no row behind. */
export function inSavepoint(db, fn) {
  const name = `probe_${(probeSeq += 1)}`
  db.exec(`SAVEPOINT ${name}`)
  try {
    return fn()
  } finally {
    db.exec(`ROLLBACK TO ${name}`)
    db.exec(`RELEASE ${name}`)
  }
}

export function caught(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  return null
}

/**
 * The database refused this write, and refused it as a CONSTRAINT.
 *
 * The code check is not ceremony. audit.mjs makes the argument for it: any
 * error would let a STRUCTURAL refusal stand in for a guard — an audit_log
 * replaced by a view rejects UPDATE too, while its backing table stays wide
 * open — and a test that accepts "something threw" cannot tell those apart.
 */
export function assertRefused(fn, expected, why) {
  const error = caught(fn)
  assert.ok(error !== null, `${why}\n    the statement was ACCEPTED; nothing refused it.`)
  assert.ok(
    typeof error.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT'),
    `${why}\n    it was refused, but not by a constraint: ${error.code ?? '(no code)'} — ${error.message}`,
  )
  if (expected !== null && expected !== undefined) {
    assert.match(error.message, expected, `${why}\n    refused by the wrong rule.`)
  }
  return error
}

export function assertAccepted(fn, why) {
  const error = caught(fn)
  assert.equal(
    error,
    null,
    `${why}\n    it was REFUSED: ${error?.code ?? ''} ${error?.message ?? ''}`,
  )
}

/**
 * The counter-proof for a trigger test: with the trigger gone, the write that
 * was just refused lands. Without this, a refusal test cannot tell "the trigger
 * stopped it" from "nothing could ever have written this row anyway", and a
 * guard whose predicate can only ever be true is not a guard.
 */
export function dropTrigger(db, name) {
  const before = db
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name = ?")
    .get(name).n
  assert.equal(before, 1, `expected trigger ${name} to exist before dropping it`)
  db.exec(`DROP TRIGGER ${name}`)
}
