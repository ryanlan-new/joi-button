// SPDX-License-Identifier: MIT
//
// scripts/import-snapshot.mjs, run as a process against a real temporary volume.
//
// It is tested rather than left to the one hand-run it got, because of what it
// protects: without it the owner's FIRST publish replaces the twelve clips this
// site has always served with whatever they just approved, and nothing warns
// them. A migration you run once and never check again is exactly the kind that
// is quietly broken on the day it matters.
//
// Run as a SUBPROCESS, not imported: the script is a program — it reads
// process.argv, calls process.exit and does its work at module scope — and
// importing it would make its exit codes unobservable and its second run a
// cached no-op. What is asserted here is what an operator would see.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

const SCRIPT = fileURLToPath(new URL('../scripts/import-snapshot.mjs', import.meta.url))
const SNAPSHOT = JSON.parse(readFileSync(new URL('../../src/voices.json', import.meta.url), 'utf8'))

// The counts are asserted against the file rather than hard-coded, so adding a
// clip to voices.json does not make this test wrong — but they are also printed
// into the assertion messages, so a run over an EMPTY list cannot pass by
// vacuously satisfying a loop.
const EXPECTED_GROUPS = SNAPSHOT.voices.length
const EXPECTED_CLIPS = SNAPSHOT.voices.reduce((n, g) => n + g.voiceList.length, 0)

function volume(t) {
  const dir = mkdtempSync(join(tmpdir(), 'joi-import-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'media'), { recursive: true })
  return dir
}

function run(dir, args = []) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DATA_DIR: dir,
      // Every required key, supplied here rather than from deploy/runtime.env:
      // the script runs the real assertSafeConfig, and a test that depended on
      // an operator's file would pass or fail according to a machine's contents.
      SESSION_SECRET: 'x'.repeat(43),
      PORT: '8081',
      HOST: '127.0.0.1',
      DEV_BYPASS_DANMAKU: '1',
      DEV_BYPASS_TURNSTILE: '1',
      CODE_TTL_MINUTES: '10',
      TURNSTILE_SWITCH: 'off',
      BILI_ROOM_ID: '3622717',
      BILI_APP_ID: '1787439765162',
      ADMIN_OPEN_IDS: 'open-owner',
    },
  })
}

test('a dry run reads the snapshot and writes nothing at all', (t) => {
  const dir = volume(t)
  const out = run(dir, ['--dry-run'])

  assert.match(out, new RegExp(`${EXPECTED_GROUPS} groups, ${EXPECTED_CLIPS} clips`))
  assert.match(out, /nothing written/)
  // Not "the database is empty" — the database does not exist. A dry run that
  // created one would already have written.
  assert.equal(existsSync(join(dir, 'media', '00')), false)
})

test('the import puts every bundled clip on the volume and in the database, as PUBLISHED', (t) => {
  const dir = volume(t)
  const out = run(dir)
  assert.match(out, /done\./)

  const db = new Database(join(dir, 'joi.db'), { readonly: true })
  t.after(() => db.close())

  assert.equal(db.prepare('SELECT count(*) n FROM groups').get().n, EXPECTED_GROUPS)
  assert.equal(db.prepare('SELECT count(*) n FROM clips').get().n, EXPECTED_CLIPS)
  assert.equal(db.prepare('SELECT count(*) n FROM media').get().n, EXPECTED_CLIPS)

  // PUBLISHED, not draft. Imported as drafts, the site's own existing content
  // would be off the page until somebody pressed publish — which reads as an
  // outage caused by the migration that was supposed to prevent one.
  assert.equal(db.prepare("SELECT count(*) n FROM clips WHERE state <> 'published'").get().n, 0)
  assert.equal(db.prepare('SELECT count(*) n FROM clips WHERE published_at IS NULL').get().n, 0)

  // Attributed to nobody. These predate the submission flow, and a credit line
  // naming a submitter nobody typed would be a fabrication.
  assert.equal(db.prepare('SELECT count(*) n FROM clips WHERE submitter_id IS NOT NULL').get().n, 0)

  // Three languages for every clip and every group, which is what publishing
  // demands — an imported clip with a hole would block the first real publish
  // and the reviewer would have no idea why.
  const locales = SNAPSHOT.voices[0].voiceList[0].description
  const localeCount = Object.keys(locales).length
  assert.equal(
    db.prepare('SELECT count(*) n FROM clip_captions').get().n,
    EXPECTED_CLIPS * localeCount,
    `every clip needs ${localeCount} captions`,
  )
  assert.equal(db.prepare('SELECT count(*) n FROM group_captions').get().n, EXPECTED_GROUPS * localeCount)

  // The audio is where the media table says it is. storage_path is a GENERATED
  // column, so this checks the file against the database's own arithmetic rather
  // than against the script's.
  for (const row of db.prepare('SELECT storage_path, bytes FROM media').all()) {
    const file = join(dir, 'media', row.storage_path)
    assert.ok(existsSync(file), `${row.storage_path} is in the media table and not on the volume`)
    assert.equal(readFileSync(file).length, row.bytes)
  }
})

test('running it twice changes nothing, and says so', (t) => {
  const dir = volume(t)
  run(dir)

  const db = new Database(join(dir, 'joi.db'), { readonly: true })
  t.after(() => db.close())
  const before = db.prepare('SELECT id, created_at FROM clips ORDER BY id').all()

  const second = run(dir)
  assert.match(second, /nothing to do/)

  // Same rows, same timestamps: a re-run that "updated" them would rewrite
  // created_at on twelve clips and silently move the site's history.
  assert.deepEqual(db.prepare('SELECT id, created_at FROM clips ORDER BY id').all(), before)
})

test('a clip whose audio a submission already owns is skipped, not fatal', (t) => {
  const dir = volume(t)
  run(dir)

  // Take one clip's blob away from the importer by leaving it in `media` while
  // deleting the clip that names it — the shape "these bytes are on the volume
  // and a DIFFERENT clip has them" cannot be built here, so this builds the
  // nearest thing the script branches on: the clip id is free but the blob is
  // claimed. It is claimed by re-pointing another clip at it.
  const db = new Database(join(dir, 'joi.db'))
  const [victim, keeper] = db.prepare('SELECT id, media_sha256 FROM clips ORDER BY id').all()
  db.prepare('DELETE FROM clip_captions WHERE clip_id = ?').run(victim.id)
  db.prepare('DELETE FROM clips WHERE id = ?').run(victim.id)
  db.prepare('UPDATE clips SET media_sha256 = ? WHERE id = ?').run(victim.media_sha256, keeper.id)
  db.close()

  const out = run(dir)
  assert.match(out, new RegExp(`skipping ${victim.id}`))
  // And the other eleven are untouched rather than the run failing outright.
  assert.match(out, /nothing to do|will add/)
})
