// SPDX-License-Identifier: MIT
//
// scripts/backup.mjs, run as a process against a real temporary volume.
//
// It is tested rather than trusted because of what it is for. A backup is only
// ever exercised on the worst day this site has, by an operator who has already
// lost the live volume, and the failure mode it had until now was invisible from
// every angle a reader could take: the snapshot said `themes: 1`, --verify said
// OK, the restore said it was done, and the owner's theme was gone anyway —
// because the row came back naming a wallpaper that did not, and saveTheme
// refuses such a row with `wallpaper_missing`. The recovery this system
// documents ("press save again — the stylesheet is rebuilt from the row") was
// the exact operation that failed.
//
// So these tests do not assert that the script printed a success line. They
// rebuild the owner's theme on the RESTORED directory and compare the resulting
// theme.css to the bytes that were live, which is the only claim worth making.
//
// Run as a SUBPROCESS, not imported: the script is a program — it reads
// process.argv, calls process.exit and does its work at module scope — and
// importing it would make its exit codes unobservable and its second run a
// cached no-op. What is asserted here is what an operator would see. Same
// reasoning, and the same shape, as test/import-snapshot.test.mjs.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'
import sharp from 'sharp'

import { migrate } from '../db/migrate.mjs'
import { saveTheme } from '../lib/theme-store.mjs'
import { THEME_TOKENS, validateTheme } from '../lib/theme.mjs'
import { storeWallpaper } from '../lib/wallpaper.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/backup.mjs', import.meta.url))
const APP_VUE = fileURLToPath(new URL('../../src/App.vue', import.meta.url))

// ---------------------------------------------------------------------------
// the volume

/**
 * The shipped palette, parsed out of src/App.vue's `:root` the way
 * test/theme.test.mjs does.
 *
 * Not hard-coded: the roster and the contrast rules are allowed to change, and a
 * fixture palette frozen here would start failing validateTheme for a reason
 * that has nothing to do with backups. Reading src/ is fine HERE — this is a
 * test, run from a checkout. It is not fine in server code, which ships in an
 * image that carries no src/.
 */
function shippedPalette() {
  const block = readFileSync(APP_VUE, 'utf8').match(/:root\s*\{([\s\S]*?)\}/)[1]
  const tokens = {}
  for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) tokens[name] = value
  // App.vue's `:root` does not declare --content-bg (the rule uses a fallback),
  // and a theme with a wallpaper must give the content an OPAQUE backing or
  // validateTheme refuses it with content_backing_translucent.
  tokens['--content-bg'] = '#ffffff'
  // Asserted rather than assumed, so that a future roster change fails HERE with
  // its own reason instead of surfacing as an unexplained refusal three calls
  // deeper inside saveTheme.
  const verdict = validateTheme({ name: 'fixture', tokens, wallpaperPath: null })
  assert.ok(
    verdict.ok,
    `the fixture palette must pass validateTheme; it did not: ${JSON.stringify(verdict.problems)}`,
  )
  assert.equal(Object.keys(tokens).length, THEME_TOKENS.length)
  return tokens
}

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A data directory with the shape config.mjs derives from DATA_DIR. */
function volume(t) {
  const dir = tempDir(t, 'joi-backup-data-')
  for (const sub of ['media', 'wallpaper', 'incoming']) mkdirSync(join(dir, sub), { recursive: true })
  const db = new Database(join(dir, 'joi.db'))
  migrate(db)
  t.after(() => {
    try {
      db.close()
    } catch {
      // Already closed by a test that needed to reopen it; not a failure.
    }
  })
  return { dir, db }
}

/** A distinct PNG per call, so two wallpapers never collide on their hash. */
async function wallpaperOnVolume(dir, colour) {
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: colour } })
    .png()
    .toBuffer()
  return (await storeWallpaper(png, { wallpaperDir: join(dir, 'wallpaper') })).path
}

/**
 * A media row and its blob, written straight to the volume.
 *
 * Deliberately NOT via scripts/import-snapshot.mjs: coupling this file to that
 * program would make a failure there show up here as a backup bug. storage_path
 * is a GENERATED column, so the file lands where the database's own arithmetic
 * says it does rather than where this helper guesses.
 */
function mediaOnVolume(dir, db, bytes) {
  // Hashed locally rather than through lib/media.mjs: that module's sniffing is
  // not what this file tests, and the backup only ever compares a pooled name
  // to the name the database gave it.
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  db.prepare(
    `INSERT INTO media (sha256, ext, content_type, bytes, duration_seconds, uploaded_at)
     VALUES (?, 'mp3', 'audio/mpeg', ?, 1.5, '2026-01-01T00:00:00Z')`,
  ).run(sha256, bytes.length)
  const storagePath = db.prepare('SELECT storage_path FROM media WHERE sha256 = ?').get(sha256).storage_path
  const file = join(dir, 'media', storagePath)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, bytes)
  return storagePath
}

// ---------------------------------------------------------------------------
// the script

/**
 * Every variable that could move a path out from under DATA_DIR is DELETED, not
 * overridden. A developer with WALLPAPER_DIR or MEDIA_DIR exported (they are
 * real knobs — config.mjs reads all of them) would otherwise have this test
 * measure their volume instead of the one it just built.
 */
function childEnv(dataDir, backupDir) {
  const env = { ...process.env }
  for (const key of ['DB_FILE', 'MEDIA_DIR', 'CATALOG_FILE', 'STAGING_DIR', 'THEME_CSS_FILE', 'WALLPAPER_DIR', 'BACKUP_PRUNE_DAYS']) {
    delete env[key]
  }
  return { ...env, NODE_ENV: 'development', DATA_DIR: dataDir, BACKUP_DIR: backupDir }
}

/** Exit code and both streams, because a backup that fails quietly is the bug. */
function run(dataDir, backupDir, args = []) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: childEnv(dataDir, backupDir),
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, all: result.stdout + result.stderr }
}

function onlySnapshot(backupDir) {
  const names = readdirSync(join(backupDir, 'snapshots')).filter((n) => /^\d{8}T\d{6}Z$/.test(n)).sort()
  assert.equal(names.length, 1, `expected exactly one snapshot, found ${names.length}`)
  return names[0]
}

function manifestOf(backupDir, stamp) {
  return JSON.parse(readFileSync(join(backupDir, 'snapshots', stamp, 'manifest.json'), 'utf8'))
}

// ---------------------------------------------------------------------------

test('the owner can rebuild their theme from a restore, wallpaper and all', async (t) => {
  const { dir, db } = volume(t)
  const wallpaper = await wallpaperOnVolume(dir, '#336699')
  saveTheme(
    db,
    { name: 'Evening', tokens: shippedPalette(), wallpaperPath: wallpaper },
    { themeCssFile: join(dir, 'theme.css'), wallpaperDir: join(dir, 'wallpaper') },
  )
  const liveCss = readFileSync(join(dir, 'theme.css'), 'utf8')
  db.close()

  const backupDir = tempDir(t, 'joi-backup-out-')
  const taken = run(dir, backupDir)
  assert.equal(taken.status, 0, taken.all)
  assert.match(taken.stdout, /themes: 1/)
  assert.match(taken.stdout, /wallpapers: 1 referenced \(1 new, 0 already pooled\)/)

  const stamp = onlySnapshot(backupDir)
  const manifest = manifestOf(backupDir, stamp)
  assert.deepEqual(manifest.wallpaper.map((w) => w.path), [wallpaper])
  // Pooled by its own name, so a second snapshot of the same picture costs
  // nothing — the same property that makes the media pool affordable.
  assert.ok(existsSync(join(backupDir, 'wallpaper', wallpaper)))

  const into = tempDir(t, 'joi-backup-restore-')
  rmSync(into, { recursive: true, force: true })
  const restored = run(dir, backupDir, ['--restore', stamp, '--into', into])
  assert.equal(restored.status, 0, restored.all)
  assert.match(restored.stdout, /1\/1 wallpaper\(s\)/)

  // The bytes, not just the name.
  assert.deepEqual(
    readFileSync(join(into, 'wallpaper', wallpaper)),
    readFileSync(join(dir, 'wallpaper', wallpaper)),
  )

  // THE CLAIM WORTH MAKING: the documented recovery, performed on the restored
  // directory, produces the stylesheet that was live. This is the assertion that
  // was failing with `wallpaper_missing` before the wallpapers were pooled.
  const restoredDb = new Database(join(into, 'joi.db'))
  t.after(() => restoredDb.close())
  const row = restoredDb.prepare('SELECT name, tokens, wallpaper_path FROM themes WHERE is_active = 1').get()
  assert.equal(row.wallpaper_path, wallpaper)
  saveTheme(
    restoredDb,
    { name: row.name, tokens: JSON.parse(row.tokens), wallpaperPath: row.wallpaper_path },
    { themeCssFile: join(into, 'theme.css'), wallpaperDir: join(into, 'wallpaper') },
  )
  assert.equal(readFileSync(join(into, 'theme.css'), 'utf8'), liveCss)
})

test('--verify is RED when a pooled wallpaper is gone, and the restore refuses to be quiet about it', async (t) => {
  const { dir, db } = volume(t)
  const wallpaper = await wallpaperOnVolume(dir, '#aa3377')
  saveTheme(
    db,
    { name: 'Rose', tokens: shippedPalette(), wallpaperPath: wallpaper },
    { themeCssFile: join(dir, 'theme.css'), wallpaperDir: join(dir, 'wallpaper') },
  )
  db.close()

  const backupDir = tempDir(t, 'joi-backup-out-')
  assert.equal(run(dir, backupDir).status, 0)

  // GREEN first. A verifier that is red before the damage proves nothing.
  const before = run(dir, backupDir, ['--verify'])
  assert.equal(before.status, 0, before.all)
  assert.match(before.stdout, /OK .*wallpaper=1\/1/)

  rmSync(join(backupDir, 'wallpaper', wallpaper), { force: true })

  const after = run(dir, backupDir, ['--verify'])
  assert.equal(after.status, 1, `--verify stayed green with the wallpaper deleted:\n${after.all}`)
  assert.match(after.stdout, /BAD .*wallpaper=0\/1/)
  assert.match(after.stdout, /1 snapshots, 1 bad/)

  // And the restore says it too, loudly and with a non-zero exit — the operator
  // must not swap in a directory whose active theme cannot be re-saved.
  const into = tempDir(t, 'joi-backup-restore-')
  rmSync(into, { recursive: true, force: true })
  const restored = run(dir, backupDir, ['--restore', onlySnapshot(backupDir), '--into', into])
  assert.equal(restored.status, 1, restored.all)
  assert.match(restored.stdout, /0\/1 wallpaper\(s\)/)
  assert.match(restored.stderr, /wallpaper_missing/)
})

test('every themes row is covered, not only the active one', async (t) => {
  const { dir, db } = volume(t)
  const options = { themeCssFile: join(dir, 'theme.css'), wallpaperDir: join(dir, 'wallpaper') }
  const tokens = shippedPalette()
  const older = await wallpaperOnVolume(dir, '#112233')
  saveTheme(db, { name: 'Older', tokens, wallpaperPath: older }, options)
  const active = await wallpaperOnVolume(dir, '#445566')
  saveTheme(db, { name: 'Active', tokens, wallpaperPath: active }, options)
  // Deactivated rows are kept as history so a rollback is one UPDATE away; a
  // rollback that lands on a row whose picture was never backed up is refused.
  assert.equal(db.prepare('SELECT count(*) n FROM themes').get().n, 2)
  assert.equal(db.prepare('SELECT count(*) n FROM themes WHERE is_active = 1').get().n, 1)
  db.close()

  const backupDir = tempDir(t, 'joi-backup-out-')
  const taken = run(dir, backupDir)
  assert.equal(taken.status, 0, taken.all)

  const manifest = manifestOf(backupDir, onlySnapshot(backupDir))
  assert.deepEqual(manifest.wallpaper.map((w) => w.path).sort(), [older, active].sort())
})

test('a wallpaper a row names and the volume has lost is reported, and does not stop the backup', async (t) => {
  const { dir, db } = volume(t)
  const wallpaper = await wallpaperOnVolume(dir, '#00cc88')
  saveTheme(
    db,
    { name: 'Mint', tokens: shippedPalette(), wallpaperPath: wallpaper },
    { themeCssFile: join(dir, 'theme.css'), wallpaperDir: join(dir, 'wallpaper') },
  )
  db.close()
  // The live volume is already broken. Refusing to snapshot the rest of the site
  // over it would make that worse, not better — the same rule the media half has.
  rmSync(join(dir, 'wallpaper', wallpaper), { force: true })

  const backupDir = tempDir(t, 'joi-backup-out-')
  const taken = run(dir, backupDir)
  assert.equal(taken.status, 0, taken.all)
  assert.match(taken.stderr, new RegExp(wallpaper))

  const manifest = manifestOf(backupDir, onlySnapshot(backupDir))
  assert.deepEqual(manifest.wallpaper, [])
  assert.deepEqual(manifest.wallpapersMissingFromVolume, [wallpaper])
  // Not claimed and therefore not missing: --verify holds a snapshot to what it
  // said it held, and this one honestly says it holds no wallpaper.
  assert.equal(run(dir, backupDir, ['--verify']).status, 0)
})

test('media and the database come back exactly as they did before', (t) => {
  const { dir, db } = volume(t)
  const one = mediaOnVolume(dir, db, Buffer.from('first blob'))
  const two = mediaOnVolume(dir, db, Buffer.from('second blob'))
  db.close()

  const backupDir = tempDir(t, 'joi-backup-out-')
  const taken = run(dir, backupDir)
  assert.equal(taken.status, 0, taken.all)
  assert.match(taken.stdout, /2 blobs \(2 new, 0 already pooled\)/)

  const stamp = onlySnapshot(backupDir)
  const manifest = manifestOf(backupDir, stamp)
  assert.deepEqual(manifest.media.map((m) => m.path).sort(), [one, two].sort())
  assert.equal(manifest.database.counts.media, 2)
  // The pools stay apart: an audio blob in the wallpaper pool would be restored
  // to the wrong directory and satisfy the manifest while breaking the site.
  assert.deepEqual(manifest.wallpaper, [])
  assert.deepEqual(readdirSync(join(backupDir, 'wallpaper')), [])

  // Still excluded, still saying why. This map is the only place a restore can
  // learn what was left out on purpose.
  assert.deepEqual(Object.keys(manifest.excluded).sort(), ['catalog.json', 'incoming/', 'theme.css'])

  const into = tempDir(t, 'joi-backup-restore-')
  rmSync(into, { recursive: true, force: true })
  const restored = run(dir, backupDir, ['--restore', stamp, '--into', into])
  assert.equal(restored.status, 0, restored.all)
  assert.match(restored.stdout, /joi.db \+ 2\/2 blobs/)

  for (const path of [one, two]) {
    assert.deepEqual(readFileSync(join(into, 'media', path)), readFileSync(join(dir, 'media', path)))
  }
  assert.equal(existsSync(join(into, 'incoming')), true)
  assert.equal(existsSync(join(into, 'catalog.json')), false)
  assert.equal(existsSync(join(into, 'theme.css')), false)

  const restoredDb = new Database(join(into, 'joi.db'), { readonly: true })
  t.after(() => restoredDb.close())
  assert.equal(restoredDb.pragma('integrity_check', { simple: true }), 'ok')
  assert.equal(restoredDb.prepare('SELECT count(*) n FROM media').get().n, 2)
})

test('a reclaimed blob (collected_at set, file gone on purpose) is not read as corruption', (t) => {
  const { dir, db } = volume(t)
  const present = mediaOnVolume(dir, db, Buffer.from('kept blob'))
  // A blob the media GC reclaimed (STORY-077): row present, collected_at set, its
  // file removed on purpose. It must NOT look like a file the volume lost.
  const gone = Buffer.from('reclaimed blob')
  const goneSha = createHash('sha256').update(gone).digest('hex')
  db.prepare(
    `INSERT INTO media (sha256, ext, content_type, bytes, duration_seconds, uploaded_at, collected_at)
     VALUES (?, 'mp3', 'audio/mpeg', ?, 1.5, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')`,
  ).run(goneSha, gone.length)
  db.close()

  const backupDir = tempDir(t, 'joi-backup-out-')
  const taken = run(dir, backupDir)
  assert.equal(taken.status, 0, taken.all)
  // The corruption warning must stay meaningful: an intentional absence does not
  // trip it, and only the present blob is pooled.
  assert.doesNotMatch(taken.stderr, /not on the volume/)
  const manifest = manifestOf(backupDir, onlySnapshot(backupDir))
  assert.deepEqual(manifest.media.map((m) => m.path), [present])
  assert.deepEqual(manifest.missingFromVolume, [])
  // Both rows still ride along in the database dump — reclamation removes the
  // file, never the row.
  assert.equal(manifest.database.counts.media, 2)
})

test('branding.json and its favicon round-trip through take and restore', (t) => {
  const { dir, db } = volume(t)
  db.close()
  // Written into DATA_DIR exactly as lib/branding.mjs does: branding.json at the
  // root, the favicon content-addressed under branding/. This is authored state
  // with NO database row, so only the backup can carry it across a disaster.
  const faviconBytes = Buffer.from('a tiny favicon')
  const faviconName = `${createHash('sha256').update(faviconBytes).digest('hex')}.png`
  writeFileSync(
    join(dir, 'branding.json'),
    JSON.stringify({ navTitle: { 'zh-CN': '轴伊按钮' }, channel: { href: 'https://example.test' }, faviconPath: faviconName }),
  )
  mkdirSync(join(dir, 'branding'), { recursive: true })
  writeFileSync(join(dir, 'branding', faviconName), faviconBytes)

  const backupDir = tempDir(t, 'joi-backup-out-')
  const taken = run(dir, backupDir)
  assert.equal(taken.status, 0, taken.all)
  const stamp = onlySnapshot(backupDir)
  const manifest = manifestOf(backupDir, stamp)
  assert.deepEqual(manifest.branding, { favicon: faviconName })
  assert.deepEqual(manifest.brandingMissingFavicon, [])

  const into = tempDir(t, 'joi-backup-restore-')
  rmSync(into, { recursive: true, force: true })
  const restored = run(dir, backupDir, ['--restore', stamp, '--into', into])
  assert.equal(restored.status, 0, restored.all)
  // Both come back byte-identical, so the restored site keeps its identity.
  assert.deepEqual(readFileSync(join(into, 'branding.json')), readFileSync(join(dir, 'branding.json')))
  assert.deepEqual(readFileSync(join(into, 'branding', faviconName)), faviconBytes)
  // And --verify holds the snapshot to it.
  assert.equal(run(dir, backupDir, ['--verify']).status, 0)
})

test('a branding favicon the volume has lost is reported, and does not stop the backup', (t) => {
  const { dir, db } = volume(t)
  db.close()
  // branding.json names a favicon whose file is gone — the wallpaper story, one
  // notch softer: the site falls back to the bundle icon rather than breaking.
  const faviconName = `${'a'.repeat(64)}.png`
  writeFileSync(join(dir, 'branding.json'), JSON.stringify({ faviconPath: faviconName }))

  const backupDir = tempDir(t, 'joi-backup-out-')
  const taken = run(dir, backupDir)
  assert.equal(taken.status, 0, taken.all)
  const manifest = manifestOf(backupDir, onlySnapshot(backupDir))
  assert.deepEqual(manifest.branding, { favicon: faviconName })
  assert.deepEqual(manifest.brandingMissingFavicon, [faviconName])
})

test('pruning a snapshot collects the wallpapers no surviving manifest names', async (t) => {
  const { dir, db } = volume(t)
  const options = { themeCssFile: join(dir, 'theme.css'), wallpaperDir: join(dir, 'wallpaper') }
  const tokens = shippedPalette()
  const abandoned = await wallpaperOnVolume(dir, '#ff0055')
  saveTheme(db, { name: 'First', tokens, wallpaperPath: abandoned }, options)
  db.close()

  const backupDir = tempDir(t, 'joi-backup-out-')
  assert.equal(run(dir, backupDir).status, 0)
  const old = onlySnapshot(backupDir)

  // Age the first snapshot: rename the directory (its name IS its timestamp) and
  // rewrite the takenAt the pruner actually reads. Both, because the two are one
  // fact — and the rename is also what lets the next backup run at all, since a
  // snapshot stamp is per-second and this test takes less than a second.
  const aged = '20200101T000000Z'
  const manifest = manifestOf(backupDir, old)
  manifest.takenAt = '2020-01-01T00:00:00Z'
  renameSync(join(backupDir, 'snapshots', old), join(backupDir, 'snapshots', aged))
  writeFileSync(join(backupDir, 'snapshots', aged, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  // Then move the site onto a different picture and delete the first one's row,
  // so nothing living names the abandoned wallpaper.
  const live = new Database(join(dir, 'joi.db'))
  const kept = await wallpaperOnVolume(dir, '#0055ff')
  saveTheme(live, { name: 'Second', tokens, wallpaperPath: kept }, options)
  live.prepare('DELETE FROM themes WHERE wallpaper_path = ?').run(abandoned)
  live.close()

  const second = run(dir, backupDir, ['--prune-days', '1'])
  assert.equal(second.status, 0, second.all)
  assert.match(second.stdout, /pruned 1 snapshot\(s\).*and 1 pooled wallpaper\(s\)/)

  // Collected only AFTER the last manifest naming it was pruned — never before,
  // or the pool would lose bytes a surviving snapshot still promises.
  assert.equal(existsSync(join(backupDir, 'wallpaper', abandoned)), false)
  assert.equal(existsSync(join(backupDir, 'wallpaper', kept)), true)
  assert.equal(run(dir, backupDir, ['--verify']).status, 0)
})
