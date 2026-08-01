#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// A consistent snapshot of everything this site cannot rebuild.
//
//   node server/scripts/backup.mjs [--prune-days N]      take one
//   node server/scripts/backup.mjs --verify              check every one
//   node server/scripts/backup.mjs --restore <stamp> --into <dir>
//
// Reads DATA_DIR (and the derived DB_FILE / MEDIA_DIR / WALLPAPER_DIR) exactly
// as the API does, and writes under BACKUP_DIR.
//
// Exercised as a process by test/backup.test.mjs, which restores a snapshot and
// then performs the recovery this file's contract promises, rather than checking
// that it printed a success line.
//
// ===========================================================================
// WHAT IS BACKED UP, AND WHAT IS DELIBERATELY NOT
// ===========================================================================
//   joi.db        YES, via `VACUUM INTO`. Not `cp`: the database runs in WAL
//                 mode with the API writing to it, so copying the file gives a
//                 torn read plus a -wal nobody copied. VACUUM INTO takes a read
//                 transaction and writes a fully-checkpointed, defragmented
//                 database — one file, consistent as of one instant, with no
//                 need to stop the API.
//   media/        YES, but ONCE PER BLOB. The filenames are sha256 of their own
//                 contents and nothing ever rewrites one, so the backup keeps a
//                 single pool and every snapshot references into it. Ten
//                 snapshots of a 400MB library cost 400MB, not 4GB.
//   wallpaper/    YES, pooled exactly like media/ and for the same reason: the
//                 filenames are sha256 of their own contents. These bytes are
//                 NOT derived — a wallpaper exists nowhere but the volume, and
//                 saveTheme refuses a themes row whose wallpaper_path is not on
//                 the volume (`wallpaper_missing`). A snapshot that took the row
//                 and left the picture therefore restores to an ACTIVE theme the
//                 owner cannot re-save, which is the one recovery this system
//                 documents. EVERY row's wallpaper, not just the active one:
//                 deactivated rows are kept so a rollback can reach them, and a
//                 rollback needs the picture that was live with it.
//   branding.json AND branding/<sha>.png|ico
//                 YES. Like the wallpaper, these are NOT derived: there is no
//                 branding table, so nothing in the database dump carries the
//                 nav/doc titles, the channel link, or the custom favicon an
//                 admin set. branding.json is small and mutable, so it rides
//                 per snapshot beside joi.db; the favicon is content-addressed
//                 and pooled like a wallpaper. A snapshot that took neither
//                 restores to the bundle defaults — a fresh install, not a loss.
//   incoming/     NO, and this is a decision rather than an oversight. Those are
//                 bytes mid-request: routes/public.mjs discards them before it
//                 answers, so anything there belongs to a request still in
//                 flight or to one that died. Restoring them would put refused
//                 and abandoned uploads back on the volume with no row naming
//                 them — invisible to the site and invisible to the janitor.
//   catalog.json  NO. It is DERIVED: lib/catalog.mjs regenerates it from the
//                 database, byte-identically, and the publish path rewrites it.
//                 Backing up a derived artefact invites restoring a stale one
//                 beside a newer database.
//   theme.css     NO, for catalog.json's reason and no other. It is DERIVED: a
//                 pure function of the active themes row's tokens and
//                 wallpaper_path, which is precisely why lib/theme-store.mjs
//                 writes the row first and treats a re-save as the fix. Pressing
//                 Save once after a restore reproduces the exact bytes — and
//                 that only works because the wallpaper above came back too.
//
// ===========================================================================
// WHAT THIS PROTECTS AGAINST, AND WHAT IT DOES NOT
// ===========================================================================
// Stated plainly because a backup that is trusted for the wrong failure is
// worse than none. Written to BACKUP_DIR, which on the cluster is its own PVC,
// this protects against LOGICAL loss: a bad migration, a delete nobody meant, a
// corrupted database. It does NOT protect against losing the node — k3s's
// local-path provisioner puts every PVC on the same disk, so a dead disk takes
// the backups with the data.
//
// Off-site is a PULL, not a push, and it is the operator's action: they can
// reach the node and the node cannot reach them. deploy/k8s/README.md carries
// the rsync. Until that pull has run at least once, this is a snapshot
// mechanism and not a disaster-recovery one.
//
// ===========================================================================
// RETENTION, AND WHY IT IS BOUNDED
// ===========================================================================
// A backup that outlives a deletion policy undoes it: restore a snapshot from
// before the deletion and the deleted rows are back, which for submitter data is
// the difference between "we removed it" and "we had another copy".
//
// There is no automatic deletion in this system TODAY — schema.sql publishes
// `v_unreferenced_media`, which NAMES collectable blobs, and nothing acts on it.
// So the rule is written before the policy it has to respect rather than after:
// --prune-days bounds how far back a restore can reach, and the restore runbook
// must re-run whatever deletion policy exists at restore time. Both halves are
// necessary; neither is sufficient.

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import Database from 'better-sqlite3'

import { loadConfig } from '../config.mjs'
import { toCanonicalTimestamp } from '../db/migrate.mjs'
import { brandingPathsFrom } from '../lib/branding.mjs'

const args = process.argv.slice(2)
const VERIFY_ONLY = args.includes('--verify')
const flag = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? null : args[i + 1] ?? null
}
const RESTORE = flag('--restore')
const RESTORE_INTO = flag('--into')
const pruneIndex = args.indexOf('--prune-days')
const PRUNE_DAYS = pruneIndex === -1 ? Number(process.env.BACKUP_PRUNE_DAYS ?? 30) : Number(args[pruneIndex + 1])

if (!Number.isFinite(PRUNE_DAYS) || PRUNE_DAYS < 1) {
  process.stderr.write('backup: --prune-days must be a positive number of days\n')
  process.exit(2)
}

function log(message) {
  process.stdout.write(`backup: ${message}\n`)
}
function fail(message) {
  process.stderr.write(`backup: ${message}\n`)
  process.exit(1)
}

// The API's own config reader, so DATA_DIR means here what it means there.
// assertSafeConfig is NOT called: this process opens the database read-only and
// starts no listener, and the guard's job is to refuse a SERVING process with a
// bypass. Requiring a session secret to take a backup would mean the backup
// stops working the day somebody rotates one.
const { config } = loadConfig()
const dbFile = config.database.file
const mediaDir = config.storage.mediaDir
const wallpaperDir = config.storage.wallpaperDir
// branding.json and the branding/ favicons derive from catalog.json's directory,
// exactly as the API derives them — so a rename of DATA_DIR moves both together.
const brandingPaths = brandingPathsFrom(config.storage.catalogFile)
const backupDir = process.env.BACKUP_DIR ?? join(config.storage.dataDir, 'backups')

const POOL = join(backupDir, 'media')
// A SIBLING pool, not a corner of the media one. Both are content-addressed, but
// media.storage_path is `aa/bb/<sha>.<ext>` (two levels of fan-out, because that
// table grows without bound) and themes.wallpaper_path is a bare `<sha>.<ext>`.
// Sharing one directory would put flat names beside the collector's three-deep
// walk, and the restore has to reproduce the volume's own layout anyway — where
// wallpaper/ is a sibling of media/ for the reasons config.mjs states.
const WALLPAPER_POOL = join(backupDir, 'wallpaper')
// Branding favicons are content-addressed like wallpapers, so they pool the same
// way; branding.json itself is authored and mutable, so it rides per-snapshot.
const BRANDING_POOL = join(backupDir, 'branding')
const SNAPSHOTS = join(backupDir, 'snapshots')

/**
 * The wallpapers a manifest claims, tolerating manifests written before there
 * were any.
 *
 * A v1 snapshot never held wallpapers and never said it did, so it is read as
 * claiming none. Inventing entries for it would make an old, intact snapshot
 * fail --verify for content it never promised — the manifest is the record of
 * what a snapshot claimed, and the verifier's whole job is holding it to that.
 */
function manifestWallpapers(manifest) {
  return Array.isArray(manifest.wallpaper) ? manifest.wallpaper : []
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Snapshot directories, newest last. Their names ARE their timestamps. */
function snapshots() {
  if (!existsSync(SNAPSHOTS)) return []
  return readdirSync(SNAPSHOTS)
    .filter((name) => /^\d{8}T\d{6}Z$/.test(name))
    .sort()
}

function readManifest(name) {
  const path = join(SNAPSHOTS, name, 'manifest.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

// The favicon branding.json points at, IF it is a plain content-addressed name.
// The pattern is the guard: a hand-edited branding.json with a `../` in it must
// not make the backup copy a file from outside the favicon directory.
function faviconNameFrom(brandingBytes) {
  try {
    const parsed = JSON.parse(brandingBytes.toString('utf8'))
    const name = parsed && typeof parsed.faviconPath === 'string' ? parsed.faviconPath : null
    return name !== null && /^[0-9a-f]{64}\.(?:png|ico)$/.test(name) ? name : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// verify

if (VERIFY_ONLY) {
  const names = snapshots()
  if (names.length === 0) fail(`no snapshots under ${SNAPSHOTS}`)

  let bad = 0
  for (const name of names) {
    const manifest = readManifest(name)
    if (manifest === null) {
      process.stderr.write(`  ${name}  MANIFEST UNREADABLE\n`)
      bad += 1
      continue
    }
    const dbPath = join(SNAPSHOTS, name, 'joi.db')
    // The digest FIRST: a database that has rotted is not a database whose row
    // counts are worth reading.
    const digest = existsSync(dbPath) ? sha256File(dbPath) : null
    const digestOk = digest === manifest.database.sha256
    // Then the pool. A manifest naming a blob the pool does not hold is a
    // snapshot that restores to a catalogue with a missing button.
    const missing = manifest.media.filter((m) => !existsSync(join(POOL, m.path)))
    // Same question for the wallpapers, and it is not the same consequence: a
    // missing audio blob is a button with no sound, a missing wallpaper is a
    // themes row that saveTheme will not accept, so the restored site cannot be
    // re-saved into a consistent state at all.
    const wallpapers = manifestWallpapers(manifest)
    const wallpaperMissing = wallpapers.filter((w) => !existsSync(join(WALLPAPER_POOL, w.path)))
    // The branding favicon, if the snapshot claims one: a manifest naming a
    // favicon the pool has lost restores to the bundle icon, a soft loss but a
    // snapshot that no longer holds what it says it holds.
    const brandingFavicon = manifest.branding && manifest.branding.favicon ? [manifest.branding.favicon] : []
    const brandingMissing = brandingFavicon.filter((f) => !existsSync(join(BRANDING_POOL, f)))
    // And the database has to still OPEN, which a digest match cannot tell you
    // if the digest was recorded from an already-broken file.
    let integrity = 'unopened'
    if (digestOk) {
      try {
        const db = new Database(dbPath, { readonly: true })
        integrity = db.pragma('integrity_check', { simple: true })
        db.close()
      } catch (error) {
        integrity = `open failed: ${error?.code ?? error?.message ?? 'unknown'}`
      }
    }
    const ok = digestOk && missing.length === 0 && wallpaperMissing.length === 0
      && brandingMissing.length === 0 && integrity === 'ok'
    if (!ok) bad += 1
    process.stdout.write(
      `  ${name}  ${ok ? 'OK  ' : 'BAD '} db=${digestOk ? 'match' : 'MISMATCH'} ` +
        `integrity=${integrity} media=${manifest.media.length - missing.length}/${manifest.media.length} ` +
        `wallpaper=${wallpapers.length - wallpaperMissing.length}/${wallpapers.length}` +
        `${brandingFavicon.length ? ` branding=${brandingFavicon.length - brandingMissing.length}/${brandingFavicon.length}` : ''}\n`,
    )
  }
  log(`${names.length} snapshots, ${bad} bad`)
  process.exit(bad === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------------
// restore
//
// Into a DIRECTORY THE CALLER NAMES, never over DATA_DIR. Restoring in place
// means the only copy of the current state is destroyed by the command meant to
// recover from destroying it — so this writes a complete data directory beside
// the live one and the operator swaps them, having looked at both. It refuses to
// write into a directory that already holds a joi.db for the same reason.

if (RESTORE !== null) {
  if (RESTORE_INTO === null) fail('--restore <stamp> also needs --into <dir>')
  const from = join(SNAPSHOTS, RESTORE)
  const manifest = readManifest(RESTORE)
  if (manifest === null) fail(`${from} has no readable manifest; it is not a complete snapshot`)

  const dbTargetPath = join(RESTORE_INTO, 'joi.db')
  if (existsSync(dbTargetPath)) {
    fail(`${dbTargetPath} already exists. Restore into an empty directory and swap it in; this command will not overwrite a database.`)
  }

  // The digest BEFORE the copy. Restoring bytes that do not match the manifest
  // and discovering it afterwards is how a bad backup becomes the live data.
  const dbSource = join(from, 'joi.db')
  if (!existsSync(dbSource)) fail(`${dbSource} is missing`)
  const digest = sha256File(dbSource)
  if (digest !== manifest.database.sha256) {
    fail(`${dbSource} does not match its manifest (${digest} vs ${manifest.database.sha256}); refusing to restore it`)
  }

  mkdirSync(join(RESTORE_INTO, 'media'), { recursive: true })
  copyFileSync(dbSource, dbTargetPath)
  let restored = 0
  const absent = []
  for (const blob of manifest.media) {
    const src = join(POOL, blob.path)
    if (!existsSync(src)) {
      absent.push(blob.path)
      continue
    }
    const dst = join(RESTORE_INTO, 'media', blob.path)
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
    restored += 1
  }
  // The wallpapers, into the sibling directory config.mjs derives from DATA_DIR.
  // Unconditionally created, even for a snapshot that claims none: the API's
  // upload path expects the directory to be there, and an empty one is the
  // honest statement "this restore carries no wallpapers".
  mkdirSync(join(RESTORE_INTO, 'wallpaper'), { recursive: true })
  const wallpapers = manifestWallpapers(manifest)
  let wallpapersRestored = 0
  const wallpapersAbsent = []
  for (const blob of wallpapers) {
    const src = join(WALLPAPER_POOL, blob.path)
    if (!existsSync(src)) {
      wallpapersAbsent.push(blob.path)
      continue
    }
    copyFileSync(src, join(RESTORE_INTO, 'wallpaper', blob.path))
    wallpapersRestored += 1
  }

  // branding.json (per-snapshot) and its favicon (pooled). Absent branding is
  // fine — the site falls back to the bundle defaults, as a fresh deploy does.
  // The directory is created unconditionally so the favicon upload path has it.
  mkdirSync(join(RESTORE_INTO, 'branding'), { recursive: true })
  const brandingFaviconAbsent = []
  if (manifest.branding) {
    const brandingSrc = join(from, 'branding.json')
    if (existsSync(brandingSrc)) copyFileSync(brandingSrc, join(RESTORE_INTO, 'branding.json'))
    const favicon = manifest.branding.favicon
    if (favicon) {
      const src = join(BRANDING_POOL, favicon)
      if (existsSync(src)) copyFileSync(src, join(RESTORE_INTO, 'branding', favicon))
      else brandingFaviconAbsent.push(favicon)
    }
  }

  // incoming/ is deliberately absent from the snapshot; the directory is created
  // so the API does not have to on its first write.
  mkdirSync(join(RESTORE_INTO, 'incoming'), { recursive: true })

  log(
    `restored ${RESTORE} into ${RESTORE_INTO}: joi.db + ${restored}/${manifest.media.length} blobs + ` +
      `${wallpapersRestored}/${wallpapers.length} wallpaper(s)` +
      `${manifest.branding ? ' + branding' : ''}`,
  )
  if (absent.length > 0) {
    process.stderr.write(
      `backup: ${absent.length} blob(s) named by the manifest are not in the pool — the restored ` +
        'catalogue will have buttons with no audio:\n' + absent.map((p) => `  ${p}\n`).join(''),
    )
  }
  if (wallpapersAbsent.length > 0) {
    // Named as loudly as the audio, because the consequence is worse: the owner
    // cannot press Save to fix it. saveTheme refuses a row whose wallpaper is
    // not on the volume, so the recovery below is the operation that fails.
    process.stderr.write(
      `backup: ${wallpapersAbsent.length} wallpaper(s) named by the manifest are not in the pool — a ` +
        'themes row pointing at one cannot be re-saved (wallpaper_missing); clear the wallpaper or ' +
        'upload it again:\n' + wallpapersAbsent.map((p) => `  ${p}\n`).join(''),
    )
  }
  if (brandingFaviconAbsent.length > 0) {
    // Softer than a missing wallpaper: the site simply falls back to the bundle
    // icon, and a new favicon can be uploaded. Reported so the operator is not
    // surprised the custom icon is gone.
    process.stderr.write(
      `backup: the branding favicon (${brandingFaviconAbsent.join(', ')}) named by the manifest is not ` +
        'in the pool; the restored site shows the built-in icon until a new one is uploaded.\n',
    )
  }
  log('catalog.json is NOT restored: it is derived. Point the API at this directory and publish once.')
  log('theme.css is NOT restored either, for the same reason: press Save once in the theme desk and it')
  log('is rebuilt from the active themes row — the wallpapers it names came back above.')
  log('Then re-run whatever deletion policy exists, or this restore has undone it.')
  process.exit(absent.length === 0 && wallpapersAbsent.length === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------------
// take a snapshot

if (!existsSync(dbFile)) fail(`${dbFile} does not exist; there is nothing to back up`)

// Colons are legal on every filesystem this runs on but make the directory a
// nuisance in a shell and in a URL, so the timestamp is the compact form.
const now = toCanonicalTimestamp(new Date())
const stamp = now.replace(/[-:]/g, '')
const target = join(SNAPSHOTS, stamp)
if (existsSync(target)) fail(`${target} already exists; a snapshot was taken this second`)

mkdirSync(target, { recursive: true })
mkdirSync(POOL, { recursive: true })
mkdirSync(WALLPAPER_POOL, { recursive: true })

// --- the database ----------------------------------------------------------
// READ-ONLY, and VACUUM INTO still works from a read-only handle: it writes to
// the target, not to the source. Opening read-write here would let a bug in this
// script damage the thing it is backing up.
const source = new Database(dbFile, { readonly: true })
const dbTarget = join(target, 'joi.db')
// The parameter is bound, not interpolated: the path comes from the environment
// and a quote in it would otherwise end the SQL string.
source.prepare('VACUUM INTO ?').run(dbTarget)

const schema = source.prepare('SELECT version, min_compatible_version FROM schema_version').get()
const counts = {}
for (const table of ['groups', 'clips', 'media', 'submitters', 'batches', 'batch_items', 'audit_log', 'themes']) {
  counts[table] = source.prepare(`SELECT count(*) AS n FROM ${table}`).get().n
}
// Every blob the database references AND still holds on the volume. NOT
// everything in mediaDir: a file with no row is either mid-upload or already
// collectable, and a backup is not the place to resurrect either. And NOT a
// reclaimed blob (collected_at set, STORY-077): its row is backed up with the
// database, but the media GC removed its file ON PURPOSE, so its absence is
// expected — counting it here would fill missingFromVolume below, the signal
// reserved for a file the volume LOST, with files nobody lost.
const referenced = source
  .prepare('SELECT sha256, ext, storage_path, bytes FROM media WHERE collected_at IS NULL ORDER BY sha256')
  .all()
// Every wallpaper any themes row names, active or not. DISTINCT because two rows
// may share a picture (the filename is its sha256), and not `WHERE is_active = 1`
// because deactivated rows are the rollback path and a rollback that lands on a
// row whose wallpaper was never backed up is refused by saveTheme.
const wallpapersReferenced = source
  .prepare('SELECT DISTINCT wallpaper_path FROM themes WHERE wallpaper_path IS NOT NULL ORDER BY wallpaper_path')
  .all()
  .map((row) => row.wallpaper_path)
source.close()

// --- the media pool --------------------------------------------------------
let copied = 0
let deduped = 0
const missingFromVolume = []
for (const blob of referenced) {
  const from = join(mediaDir, blob.storage_path)
  const to = join(POOL, blob.storage_path)
  if (!existsSync(from)) {
    // Reported, not fatal. The database naming a file the volume does not hold
    // is a real problem — and it is a problem with the LIVE data, which a
    // refusal to take a backup would make worse rather than better.
    missingFromVolume.push(blob.storage_path)
    continue
  }
  if (existsSync(to) && statSync(to).size === blob.bytes) {
    deduped += 1
    continue
  }
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
  copied += 1
}

// --- the wallpaper pool ----------------------------------------------------
// Same dedup story as media/, for the same reason: the names are sha256 of the
// contents, so a snapshot that changes nothing copies nothing.
let wallpaperCopied = 0
let wallpaperDeduped = 0
const wallpaperPooled = []
const wallpapersMissingFromVolume = []
for (const path of wallpapersReferenced) {
  const from = join(wallpaperDir, path)
  const to = join(WALLPAPER_POOL, path)
  if (!existsSync(from)) {
    // Reported, not fatal, exactly as for media: a themes row naming a file the
    // volume does not hold is already broken live, and refusing to snapshot the
    // rest of the site over it makes that worse.
    wallpapersMissingFromVolume.push(path)
    continue
  }
  const bytes = statSync(from).size
  if (existsSync(to) && statSync(to).size === bytes) {
    wallpaperDeduped += 1
  } else {
    copyFileSync(from, to)
    wallpaperCopied += 1
  }
  // No separate sha256 field: the filename IS the digest, so recording it beside
  // the path would be one fact written twice and free to disagree.
  wallpaperPooled.push({ path, bytes })
}

// --- the manifest ----------------------------------------------------------
// Written LAST. A snapshot with no manifest is one that was interrupted, and
// both the verifier and the pruner treat it as unusable rather than as empty.
// --- branding (STORY-068) --------------------------------------------------
// Authored, non-derived state with no database row, so it must be captured here
// or a disaster restore loses it silently and there is nowhere to regenerate it
// from. branding.json rides per-snapshot beside joi.db; its favicon pools like a
// wallpaper. A referenced favicon the volume has lost is reported, not fatal —
// the restored site falls back to the bundle icon, which is a soft loss.
let branding = null
const brandingMissingFavicon = []
if (existsSync(brandingPaths.brandingFile)) {
  copyFileSync(brandingPaths.brandingFile, join(target, 'branding.json'))
  const favicon = faviconNameFrom(readFileSync(brandingPaths.brandingFile))
  if (favicon !== null) {
    const from = join(brandingPaths.faviconDir, favicon)
    if (existsSync(from)) {
      mkdirSync(BRANDING_POOL, { recursive: true })
      const to = join(BRANDING_POOL, favicon)
      if (!(existsSync(to) && statSync(to).size === statSync(from).size)) copyFileSync(from, to)
    } else {
      brandingMissingFavicon.push(favicon)
    }
  }
  branding = { favicon }
}

// v3 because the manifest now carries `branding` too. Older snapshots stay
// readable — a missing `branding` key reads as "no branding" and
// manifestWallpapers() reads a missing `wallpaper` as "no wallpapers", each of
// which is exactly what those snapshots held — so bumping this costs no backup.
const manifest = {
  schemaVersion: 'joi-button.backup.v3',
  takenAt: now,
  database: {
    file: 'joi.db',
    sha256: sha256File(dbTarget),
    bytes: statSync(dbTarget).size,
    schema: { version: schema.version, minCompatibleVersion: schema.min_compatible_version },
    counts,
  },
  media: referenced
    .filter((blob) => !missingFromVolume.includes(blob.storage_path))
    .map((blob) => ({ sha256: blob.sha256, path: blob.storage_path, bytes: blob.bytes })),
  // Every wallpaper any themes row names. Kept out of `media` rather than merged
  // into it: they live in a different directory, are collected on a different
  // predicate, and a restore that put them in media/ would satisfy the manifest
  // while leaving the site's themes still broken.
  wallpaper: wallpaperPooled,
  // Named in the manifest so a restore does not have to guess what was left out.
  // Anything absent from a restored volume and absent from this map is a bug in
  // this script, not a decision — which is the only reason the map is worth
  // maintaining.
  excluded: {
    'incoming/': 'in-flight uploads; restoring them would resurrect refused and abandoned files',
    'catalog.json': 'derived from the database by lib/catalog.mjs; regenerate it by publishing',
    'theme.css': 'derived from the active themes row by lib/theme-store.mjs; regenerate it by saving the theme once',
  },
  missingFromVolume,
  // Separate from missingFromVolume because it is a different repair: a media
  // blob is gone for good, a wallpaper the owner still has can be re-uploaded.
  wallpapersMissingFromVolume,
  // Site branding (STORY-068): authored volume state with no database row. null
  // when nothing was set; { favicon } names the pooled icon (or a null favicon
  // for text-only branding). brandingMissingFavicon is the wallpaper story again
  // — a branding.json naming a favicon the volume has lost.
  branding,
  brandingMissingFavicon,
}
writeFileSync(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

log(`snapshot ${stamp}: db ${manifest.database.bytes} bytes, ${referenced.length} blobs (${copied} new, ${deduped} already pooled)`)
log(
  `  wallpapers: ${wallpapersReferenced.length} referenced ` +
    `(${wallpaperCopied} new, ${wallpaperDeduped} already pooled)`,
)
for (const [table, n] of Object.entries(counts)) log(`  ${table}: ${n}`)
if (wallpapersMissingFromVolume.length > 0) {
  process.stderr.write(
    `backup: WARNING — ${wallpapersMissingFromVolume.length} wallpaper(s) are named by a themes row and ` +
      'not on the volume; a restore cannot bring back what is already gone:\n' +
      wallpapersMissingFromVolume.map((p) => `  ${p}\n`).join(''),
  )
}
if (missingFromVolume.length > 0) {
  process.stderr.write(
    `backup: WARNING — ${missingFromVolume.length} blob(s) are in the database and not on the volume:\n` +
      missingFromVolume.map((p) => `  ${p}\n`).join(''),
  )
}

// --- prune -----------------------------------------------------------------
// Snapshots first, then the pool, and never the other way round: a pool entry is
// only unreferenced once the last manifest naming it is gone, and collecting
// before pruning would read a manifest that is about to be deleted.
const cutoff = Date.now() - PRUNE_DAYS * 24 * 60 * 60 * 1000
let dropped = 0
for (const name of snapshots()) {
  if (name === stamp) continue
  const manifestOf = readManifest(name)
  // A snapshot with no readable manifest is an interrupted one; it is pruned by
  // its directory timestamp rather than kept forever because it cannot be read.
  const takenAt = manifestOf === null ? statSync(join(SNAPSHOTS, name)).mtimeMs : Date.parse(manifestOf.takenAt)
  if (takenAt >= cutoff) continue
  rmSync(join(SNAPSHOTS, name), { recursive: true, force: true })
  dropped += 1
}

const stillReferenced = new Set()
const wallpapersStillReferenced = new Set()
for (const name of snapshots()) {
  const manifestOf = readManifest(name)
  if (manifestOf === null) continue
  for (const blob of manifestOf.media) stillReferenced.add(blob.path)
  for (const blob of manifestWallpapers(manifestOf)) wallpapersStillReferenced.add(blob.path)
}
let collected = 0
if (existsSync(POOL)) {
  for (const a of readdirSync(POOL)) {
    const aDir = join(POOL, a)
    if (!statSync(aDir).isDirectory()) continue
    for (const b of readdirSync(aDir)) {
      const bDir = join(aDir, b)
      if (!statSync(bDir).isDirectory()) continue
      for (const file of readdirSync(bDir)) {
        const rel = `${a}/${b}/${file}`
        if (stillReferenced.has(rel)) continue
        rmSync(join(bDir, file), { force: true })
        collected += 1
      }
    }
  }
}

// The wallpaper pool is FLAT, so it is its own loop rather than a parameter of
// the one above — a shared walker would have to be told how deep to go, and
// getting that argument wrong deletes backed-up bytes.
let wallpapersCollected = 0
if (existsSync(WALLPAPER_POOL)) {
  for (const file of readdirSync(WALLPAPER_POOL)) {
    if (wallpapersStillReferenced.has(file)) continue
    const path = join(WALLPAPER_POOL, file)
    if (!statSync(path).isFile()) continue
    rmSync(path, { force: true })
    wallpapersCollected += 1
  }
}

log(
  `pruned ${dropped} snapshot(s) older than ${PRUNE_DAYS} days, collected ${collected} pooled blob(s) ` +
    `and ${wallpapersCollected} pooled wallpaper(s)`,
)
log(`RETENTION IS A POLICY, NOT A CONVENIENCE: a restore reaches back at most ${PRUNE_DAYS} days, and`)
log('anything deleted from the live data within that window comes back with it. Re-run the deletion')
log('policy after a restore.')
