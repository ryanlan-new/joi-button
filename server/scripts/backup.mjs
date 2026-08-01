#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// A consistent snapshot of everything this site cannot rebuild.
//
//   node server/scripts/backup.mjs [--prune-days N]      take one
//   node server/scripts/backup.mjs --verify              check every one
//   node server/scripts/backup.mjs --restore <stamp> --into <dir>
//
// Reads DATA_DIR (and the derived DB_FILE / MEDIA_DIR) exactly as the API does,
// and writes under BACKUP_DIR.
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
const backupDir = process.env.BACKUP_DIR ?? join(config.storage.dataDir, 'backups')

const POOL = join(backupDir, 'media')
const SNAPSHOTS = join(backupDir, 'snapshots')

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
    const ok = digestOk && missing.length === 0 && integrity === 'ok'
    if (!ok) bad += 1
    process.stdout.write(
      `  ${name}  ${ok ? 'OK  ' : 'BAD '} db=${digestOk ? 'match' : 'MISMATCH'} ` +
        `integrity=${integrity} media=${manifest.media.length - missing.length}/${manifest.media.length}\n`,
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
  // incoming/ is deliberately absent from the snapshot; the directory is created
  // so the API does not have to on its first write.
  mkdirSync(join(RESTORE_INTO, 'incoming'), { recursive: true })

  log(`restored ${RESTORE} into ${RESTORE_INTO}: joi.db + ${restored}/${manifest.media.length} blobs`)
  if (absent.length > 0) {
    process.stderr.write(
      `backup: ${absent.length} blob(s) named by the manifest are not in the pool — the restored ` +
        'catalogue will have buttons with no audio:\n' + absent.map((p) => `  ${p}\n`).join(''),
    )
  }
  log('catalog.json is NOT restored: it is derived. Point the API at this directory and publish once.')
  log('Then re-run whatever deletion policy exists, or this restore has undone it.')
  process.exit(absent.length === 0 ? 0 : 1)
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
// Every blob the database references. NOT everything in mediaDir: a file with no
// row is either mid-upload or already collectable, and a backup is not the place
// to resurrect either.
const referenced = source.prepare('SELECT sha256, ext, storage_path, bytes FROM media ORDER BY sha256').all()
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

// --- the manifest ----------------------------------------------------------
// Written LAST. A snapshot with no manifest is one that was interrupted, and
// both the verifier and the pruner treat it as unusable rather than as empty.
const manifest = {
  schemaVersion: 'joi-button.backup.v1',
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
  // Named in the manifest so a restore does not have to guess what was left out.
  excluded: {
    'incoming/': 'in-flight uploads; restoring them would resurrect refused and abandoned files',
    'catalog.json': 'derived from the database by lib/catalog.mjs; regenerate it by publishing',
  },
  missingFromVolume,
}
writeFileSync(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

log(`snapshot ${stamp}: db ${manifest.database.bytes} bytes, ${referenced.length} blobs (${copied} new, ${deduped} already pooled)`)
for (const [table, n] of Object.entries(counts)) log(`  ${table}: ${n}`)
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
for (const name of snapshots()) {
  const manifestOf = readManifest(name)
  if (manifestOf === null) continue
  for (const blob of manifestOf.media) stillReferenced.add(blob.path)
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

log(`pruned ${dropped} snapshot(s) older than ${PRUNE_DAYS} days, collected ${collected} pooled blob(s)`)
log(`RETENTION IS A POLICY, NOT A CONVENIENCE: a restore reaches back at most ${PRUNE_DAYS} days, and`)
log('anything deleted from the live data within that window comes back with it. Re-run the deletion')
log('policy after a restore.')
