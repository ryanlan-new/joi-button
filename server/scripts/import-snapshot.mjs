#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Put the twelve clips the site already ships into the database.
//
//   node server/scripts/import-snapshot.mjs [--dry-run]
//
// ===========================================================================
// WHY THIS HAS TO EXIST, AND WHAT HAPPENS WITHOUT IT
// ===========================================================================
// src/voices.json holds the catalogue this site has always served: three
// groups, twelve clips, three languages each, with the audio in public/voices/.
// It is compiled into the bundle, and src/catalog.mjs treats it as the FLOOR —
// what the page paints when /catalog.json cannot be fetched.
//
// The moment the API publishes, /catalog.json exists, and the fetched document
// REPLACES that floor wholesale (installCatalog uses setLocaleMessage, and the
// header there explains why replacing rather than merging is correct: a retired
// clip has to be able to disappear). So on a fresh database the owner's FIRST
// publish would swap twelve clips for however many they had just approved, and
// the button wall the site is for would be gone. Nothing warns them; the
// publish succeeds and does exactly what it says.
//
// This closes that. Run it once, before the first publish, and the twelve are
// rows like any other — playable, retirable, editable in the review desk, and
// carried through every publish from then on.
//
// ===========================================================================
// WHAT IT DOES NOT DO
// ===========================================================================
//   * It does not COPY the audio out of public/voices/. It hashes those files
//     and writes them into MEDIA_DIR under the content-addressed path the
//     `media` table computes, because that is where deploy/nginx.conf serves
//     from (/media/ → the shared volume). The originals stay in the image; from
//     here the site plays the volume's copy like it does for a submission.
//   * It does not delete anything, ever, and it does not update a row that
//     already exists. Re-running it is a no-op that says so. That is what makes
//     it safe to leave in a deploy runbook.
//   * It attributes nothing to a submitter. clips.submitter_id stays null: these
//     predate the submission flow and inventing a submitter would put a name in
//     the credit line that nobody typed.
//
// ===========================================================================
// IDS
// ===========================================================================
// groups.id and clips.id are `[a-z0-9_-]{1,64}` — they end up as vue-i18n key
// paths. The names in voices.json are prose ("Cute Hummings", "Arctic
// Eggs_I can't bear it (premium ver.)"), so they are slugged, and a collision
// is a REFUSAL rather than a suffix: two clips silently merging into one id
// would lose a button, and the twelve are few enough that a human can rename
// one. The slug is derived from the name and not from the array position, so
// re-running after an edit to voices.json does not renumber everything.

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'
import { parseFile } from 'music-metadata'

import { CONFIG_EXTRA_REQUIREMENTS, loadConfig } from '../config.mjs'
import { applyConnectionPragmas, migrate, toCanonicalTimestamp } from '../db/migrate.mjs'
import { assertSafeConfig } from '../lib/env-guard.mjs'
import { escapeForI18n } from '../lib/text-safety.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SNAPSHOT = join(REPO_ROOT, 'src/voices.json')
const AUDIO_ROOT = join(REPO_ROOT, 'public/voices')

const DRY_RUN = process.argv.includes('--dry-run')

/**
 * Prose to a legal id.
 *
 * Only what the CHECK allows: lower case, digits, '-' and '_'. Everything else
 * becomes a single '-', and the result is trimmed of leading and trailing ones
 * so "Ei?" does not become "ei-".
 */
function slug(text) {
  const out = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return out
}

/**
 * A caption the schema will accept.
 *
 * escapeForI18n is the sanctioned pipeline's own escaper — the same one
 * routes/admin.mjs runs a reviewer's text through — so anything it emits passes
 * the CHECKs by construction. test/voices-captions.test.mjs already asserts that
 * for all 45 strings in this file, which is why this script does not need to
 * validate them a second time.
 */
function caption(text) {
  return escapeForI18n(String(text))
}

function fail(message) {
  process.stderr.write(`import-snapshot: ${message}\n`)
  process.exit(1)
}

// --- read the snapshot ------------------------------------------------------

if (!existsSync(SNAPSHOT)) fail(`${SNAPSHOT} does not exist`)
const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
if (!Array.isArray(snapshot.voices)) fail('src/voices.json has no `voices` array')

const groups = []
const clips = []
const seenGroupIds = new Map()
const seenClipIds = new Map()

for (const [groupIndex, group] of snapshot.voices.entries()) {
  const id = slug(group.categoryName)
  if (id === '') fail(`group ${groupIndex} ("${group.categoryName}") slugs to an empty id`)
  if (seenGroupIds.has(id)) {
    fail(`groups "${seenGroupIds.get(id)}" and "${group.categoryName}" both slug to "${id}"; rename one in src/voices.json`)
  }
  seenGroupIds.set(id, group.categoryName)
  groups.push({
    id,
    displayName: group.categoryName,
    sortOrder: groupIndex,
    captions: group.categoryDescription ?? {},
  })

  for (const [clipIndex, voice] of (group.voiceList ?? []).entries()) {
    const clipId = slug(voice.name)
    if (clipId === '') fail(`clip "${voice.name}" in "${group.categoryName}" slugs to an empty id`)
    if (seenClipIds.has(clipId)) {
      fail(`clips "${seenClipIds.get(clipId)}" and "${voice.name}" both slug to "${clipId}"; rename one in src/voices.json`)
    }
    seenClipIds.set(clipId, voice.name)
    clips.push({
      id: clipId,
      groupId: id,
      label: voice.name,
      sortOrder: clipIndex,
      captions: voice.description ?? {},
      file: join(AUDIO_ROOT, voice.path),
      sourceName: voice.path,
    })
  }
}

process.stdout.write(`import-snapshot: ${groups.length} groups, ${clips.length} clips in src/voices.json\n`)

// --- config, database -------------------------------------------------------

const { config, env } = loadConfig()
const db = new Database(config.database.file)
applyConnectionPragmas(db)
migrate(db, { mode: config.database.instanceMode })
assertSafeConfig(config, {
  nodeEnv: config.nodeEnv,
  db,
  env,
  extraRequirements: CONFIG_EXTRA_REQUIREMENTS,
})

const mediaDir = config.storage.mediaDir
const now = toCanonicalTimestamp(new Date())

// --- hash and measure, BEFORE the transaction -------------------------------
// Reading twelve files and decoding their metadata takes long enough that doing
// it inside a write transaction would hold the database open for no reason.
// Nothing here writes.

for (const clip of clips) {
  if (!existsSync(clip.file)) fail(`${clip.sourceName} is named by src/voices.json and is not in public/voices/`)
  const bytes = readFileSync(clip.file)
  clip.sha256 = createHash('sha256').update(bytes).digest('hex')
  clip.bytes = bytes.length

  // The extension is derived from the file the repository ships, and the
  // `media` CHECK is the allow-list: a format with no row there can never reach
  // the volume. Every file in public/voices/ is an mp3 today; anything else
  // stops here rather than being renamed into one.
  const ext = clip.sourceName.slice(clip.sourceName.lastIndexOf('.') + 1).toLowerCase()
  if (ext !== 'mp3') fail(`${clip.sourceName} is not an mp3; the media table's allow-list would refuse it`)
  clip.ext = 'mp3'
  clip.contentType = 'audio/mpeg'

  const metadata = await parseFile(clip.file, { duration: true })
  const duration = metadata?.format?.duration
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    fail(`${clip.sourceName} has no readable duration; media.duration_seconds is CHECKed > 0`)
  }
  // Two decimals, matching what the submission path stores.
  clip.durationSeconds = Math.round(duration * 100) / 100
  clip.storagePath = `${clip.sha256.slice(0, 2)}/${clip.sha256.slice(2, 4)}/${clip.sha256}.mp3`
}

// Two clips with identical bytes would violate clips.media_sha256 UNIQUE, and
// the message SQLite gives for that names a constraint rather than a file.
const bySha = new Map()
for (const clip of clips) {
  if (bySha.has(clip.sha256)) {
    fail(`${clip.sourceName} and ${bySha.get(clip.sha256)} are byte-identical; one clip per distinct blob`)
  }
  bySha.set(clip.sha256, clip.sourceName)
}

// --- what is already there --------------------------------------------------

const existingGroups = new Set(db.prepare('SELECT id FROM groups').all().map((r) => r.id))
const existingClips = new Set(db.prepare('SELECT id FROM clips').all().map((r) => r.id))
const existingMedia = new Set(db.prepare('SELECT sha256 FROM media').all().map((r) => r.sha256))
// clips.media_sha256 is UNIQUE — one clip per distinct blob — so a bundled clip
// whose audio somebody has already submitted and had approved cannot be
// imported: the button already exists, under whatever the reviewer called it.
// SQLite would report that as a constraint name; this reports it as the two
// clips involved, and SKIPS rather than failing, because one such collision must
// not stop the other eleven.
const claimedBlobs = new Map(
  db.prepare('SELECT media_sha256, id FROM clips').all().map((r) => [r.media_sha256, r.id]),
)

const newGroups = groups.filter((g) => !existingGroups.has(g.id))
const skipped = clips.filter((c) => !existingClips.has(c.id) && claimedBlobs.has(c.sha256))
for (const clip of skipped) {
  process.stdout.write(
    `import-snapshot: skipping ${clip.id} — its audio is already clip "${claimedBlobs.get(clip.sha256)}"` +
      ' (one clip per distinct blob). Nothing is lost: that button plays these bytes.\n',
  )
}
const newClips = clips.filter((c) => !existingClips.has(c.id) && !claimedBlobs.has(c.sha256))
const newMedia = newClips.filter((c) => !existingMedia.has(c.sha256))

if (newGroups.length === 0 && newClips.length === 0) {
  process.stdout.write('import-snapshot: nothing to do — every group and clip is already in the database.\n')
  db.close()
  process.exit(0)
}

process.stdout.write(
  `import-snapshot: will add ${newGroups.length} groups, ${newClips.length} clips, ${newMedia.length} media files\n`,
)
for (const clip of newClips) {
  process.stdout.write(`  ${clip.groupId}/${clip.id}  ${clip.durationSeconds}s  ${clip.bytes} bytes\n`)
}

if (DRY_RUN) {
  process.stdout.write('import-snapshot: --dry-run, nothing written.\n')
  db.close()
  process.exit(0)
}

// --- the audio onto the volume ---------------------------------------------
// BEFORE the rows, deliberately, and it is the same ordering lib/catalog.mjs
// argues for at publish time: a row that names a file which is not there is a
// button that 404s, while a file no row names is invisible and harmless. If this
// dies half way, re-running finishes the job.

for (const clip of newMedia) {
  const target = join(mediaDir, clip.storagePath)
  mkdirSync(dirname(target), { recursive: true })
  if (existsSync(target) && statSync(target).size === clip.bytes) continue
  copyFileSync(clip.file, target)
}

// --- the rows, in one transaction ------------------------------------------

const insertGroup = db.prepare(
  'INSERT INTO groups (id, display_name, sort_order, state, created_at) VALUES (?, ?, ?, ?, ?)',
)
const insertGroupCaption = db.prepare(
  'INSERT INTO group_captions (group_id, locale, text, updated_at) VALUES (?, ?, ?, ?)',
)
const insertMedia = db.prepare(
  'INSERT INTO media (sha256, ext, content_type, bytes, duration_seconds, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)',
)
const insertClip = db.prepare(
  `INSERT INTO clips (id, group_id, media_sha256, label, sort_order, state, created_at, published_at)
   VALUES (?, ?, ?, ?, ?, 'published', ?, ?)`,
)
const insertClipCaption = db.prepare(
  'INSERT INTO clip_captions (clip_id, locale, text, updated_at) VALUES (?, ?, ?, ?)',
)
const knownLocales = new Set(db.prepare('SELECT code FROM locales').all().map((r) => r.code))

const run = db.transaction(() => {
  for (const group of newGroups) {
    insertGroup.run(group.id, group.displayName, group.sortOrder, 'active', now)
    for (const [locale, text] of Object.entries(group.captions)) {
      // A locale the database does not know is a REFERENCES failure with a
      // message about a foreign key; naming it here is cheaper to act on.
      if (!knownLocales.has(locale)) {
        throw new Error(`group "${group.id}" has a caption in locale "${locale}", which is not in the locales table`)
      }
      insertGroupCaption.run(group.id, locale, caption(text), now)
    }
  }

  for (const clip of newClips) {
    if (!existingMedia.has(clip.sha256)) {
      insertMedia.run(clip.sha256, clip.ext, clip.contentType, clip.bytes, clip.durationSeconds, now)
      existingMedia.add(clip.sha256)
    }
    // 'published' with a published_at, not 'draft': these are already on the
    // site. Importing them as drafts would mean the next publish is what puts
    // the site's own existing content live, which reads as if it had been down.
    insertClip.run(clip.id, clip.groupId, clip.sha256, clip.label, clip.sortOrder, now, now)
    for (const [locale, text] of Object.entries(clip.captions)) {
      if (!knownLocales.has(locale)) {
        throw new Error(`clip "${clip.id}" has a caption in locale "${locale}", which is not in the locales table`)
      }
      insertClipCaption.run(clip.id, locale, caption(text), now)
    }
  }
})

run()
db.close()

process.stdout.write(
  `import-snapshot: done. ${newGroups.length} groups and ${newClips.length} clips are now rows.\n` +
    'They are state=published, so they survive the next publish. Run the publish once to write catalog.json.\n',
)
