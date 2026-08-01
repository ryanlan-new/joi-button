// SPDX-License-Identifier: MIT
//
// The v1 -> v2 upgrade path, actually run.
//
// A fresh database is born at SCHEMA_VERSION straight from schema.sql, so the
// POST_BASELINE step fires in no other test — which means the one database that
// matters for it, the deployed one that predates the column, was the one
// database nothing exercised.
//
// HOW THE v1 FIXTURE IS BUILT, and why not the obvious way. The first attempt
// migrated to current and then `ALTER TABLE themes DROP COLUMN wallpaper_path`.
// SQLite refuses that — measured, not assumed:
//
//     error in table t after drop column: no such column: w
//
// because the table carries a CHECK constraint that names the column, and
// dropping it would leave the constraint dangling. (ADD COLUMN *with* a CHECK is
// accepted, which is what the step relies on; that was measured in the same
// probe.)
//
// So v1 is reconstructed from the schema TEXT instead: the two v2 additions are
// removed from schema.sql before it is executed, and each removal is asserted to
// have changed something. Without those assertions a silent no-op would leave
// this test migrating v2 to v2 and passing for the wrong reason — the exact
// failure mode it exists to catch elsewhere.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import Database from 'better-sqlite3'

import {
  MIN_COMPATIBLE_SCHEMA_VERSION,
  POST_BASELINE_STEPS,
  SCHEMA_VERSION,
  applyConnectionPragmas,
  migrate,
} from '../db/migrate.mjs'

/** schema.sql as it stood at v1: the v2 (wallpaper) and v3 (challenge_text)
 * additions taken back out, so migrate() has real work to do. */
function schemaAtV1() {
  const current = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8')

  const columnDecl = '    wallpaper_path TEXT,\n'
  assert.ok(
    current.includes(columnDecl),
    'schema.sql no longer declares wallpaper_path the way this fixture strips it',
  )
  let v1 = current.replace(columnDecl, '')

  const checkStart = v1.indexOf('    CHECK (wallpaper_path IS NULL OR (')
  assert.notEqual(checkStart, -1, 'schema.sql no longer carries the wallpaper_path CHECK')
  const tail = v1.indexOf('length(wallpaper_path) <= 69))', checkStart)
  assert.notEqual(tail, -1, 'the wallpaper_path CHECK no longer ends the way this fixture finds it')
  const checkEnd = v1.indexOf('\n', tail)
  // The clause before it ends with a comma that must go with the clause after.
  v1 = v1.slice(0, checkStart).replace(/,\n$/, '\n') + v1.slice(checkEnd + 1)

  assert.equal(v1.includes('wallpaper_path'), false, 'the v1 fixture still mentions wallpaper_path')

  // v3: the challenge_text column and its unique index. Both lines name the
  // column and nothing else does, so dropping every line that mentions it takes
  // exactly those two lines; the comments above them are inert SQL either way.
  assert.ok(v1.includes('challenge_text'), 'schema.sql no longer carries challenge_text for this fixture to strip')
  v1 = v1
    .split('\n')
    .filter((line) => !line.includes('challenge_text'))
    .join('\n')
  assert.equal(v1.includes('challenge_text'), false, 'the v1 fixture still mentions challenge_text')

  assert.ok(v1.includes('CREATE TABLE IF NOT EXISTS themes'), 'the strip removed more than it should have')
  assert.ok(v1.includes('CREATE TABLE IF NOT EXISTS clips'), 'the strip removed more than it should have')
  assert.ok(v1.includes('CREATE TABLE IF NOT EXISTS verify_codes'), 'the strip removed more than it should have')
  return v1
}

function openV1(t) {
  const dir = mkdtempSync(join(tmpdir(), 'joi-migrate-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const db = new Database(join(dir, 'joi.db'))
  t.after(() => db.close())
  applyConnectionPragmas(db)

  db.exec(schemaAtV1())
  // Stamped by hand: this is what readSchemaVersion() reports on a deployment
  // created before v2 existed.
  db.prepare(`
    INSERT INTO schema_version (id, version, min_compatible_version, applied_at)
    VALUES (1, 1, 1, '2026-07-31T00:00:00Z')
  `).run()

  assert.equal(
    db.prepare("SELECT count(*) n FROM pragma_table_info('themes') WHERE name='wallpaper_path'").get().n,
    0,
    'the fixture is not actually v1',
  )
  return db
}

test('the version roster is self-consistent', () => {
  assert.equal(SCHEMA_VERSION, 4)
  // MIN_COMPATIBLE stays 1 on purpose: the theme/verify_codes columns and the
  // two admin tables are all invisible to a catalogue reader, and src/catalog.mjs
  // only refuses a document whose minCompatibleVersion EXCEEDS what it knows.
  // Bumping it would make every tab holding a year-cached chunk refuse a
  // catalogue it can read perfectly well.
  assert.equal(MIN_COMPATIBLE_SCHEMA_VERSION, 1)
  assert.deepEqual(POST_BASELINE_STEPS.map((step) => step.version), [2, 3, 4])
})

test('a v1 database gains themes.wallpaper_path from the post-baseline step', (t) => {
  const db = openV1(t)

  const report = migrate(db, { mode: 'development', now: '2026-08-01T00:00:01Z' })
  assert.equal(report.from, 1)
  // A v1 database now climbs all the way to the current version, applying every
  // post-baseline step in order (v2's wallpaper column, then v3's challenge_text).
  assert.equal(report.to, SCHEMA_VERSION)
  assert.equal(report.applied, true)

  assert.equal(
    db.prepare("SELECT count(*) n FROM pragma_table_info('themes') WHERE name='wallpaper_path'").get().n,
    1,
  )
  // v3's column arrived on the same climb.
  assert.equal(
    db.prepare("SELECT count(*) n FROM pragma_table_info('verify_codes') WHERE name='challenge_text'").get().n,
    1,
  )
})

test('the CHECK came with the column, so an upgraded table refuses what a fresh one refuses', (t) => {
  const db = openV1(t)
  migrate(db, { mode: 'development', now: '2026-08-01T00:00:01Z' })

  const sha = 'a'.repeat(64)
  const insert = db.prepare(
    'INSERT INTO themes (id, name, tokens, created_at, wallpaper_path) VALUES (?, ?, ?, ?, ?)',
  )

  insert.run('good', 'T', '{}', '2026-08-01T00:00:02Z', `${sha}.png`)
  assert.equal(db.prepare('SELECT count(*) n FROM themes').get().n, 1)

  // The three shapes the constraint exists for. The value is a FILENAME here —
  // the serving prefix belongs to nginx and the directory to config.mjs — so
  // something that could escape the directory has no legal spelling.
  for (const [why, value] of [
    ['a traversal', `../${sha}.png`],
    ['an extension outside the allow-list', `${sha}.svg`],
    ['a non-hex name', `${'z'.repeat(64)}.png`],
  ]) {
    assert.throws(
      () => insert.run(`bad-${why.replace(/\W+/g, '-')}`, 'T', '{}', '2026-08-01T00:00:03Z', value),
      /CHECK/,
      `the upgraded table stored ${why}`,
    )
  }
  assert.equal(db.prepare('SELECT count(*) n FROM themes').get().n, 1)
})

test('migrating an already-current database is a no-op, not a second ALTER', (t) => {
  const db = openV1(t)
  migrate(db, { mode: 'development', now: '2026-08-01T00:00:01Z' })
  const again = migrate(db, { mode: 'development', now: '2026-08-01T00:00:04Z' })
  assert.equal(again.applied, false)
  assert.equal(again.from, SCHEMA_VERSION)
})
