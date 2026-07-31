// The published catalogue: the shape the page consumes, and the two properties
// that make publishing safe to repeat — determinism, and a swap no reader can
// see half of.
//
// Every "these two builds are identical" assertion is paired with a change that
// makes them differ. Without the pair, a builder that emitted `{}` would satisfy
// the first one forever.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import Database from 'better-sqlite3'

import { CatalogError, MEDIA_BASE_URL, buildCatalog, checkMedia, serializeCatalog, writeCatalog } from '../lib/catalog.mjs'
import { T0, T10, openDatabase } from './helpers/temp-db.mjs'

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'joi-button-catalog-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return {
    dir,
    mediaDir: join(dir, 'media'),
    sourceDir: join(dir, 'staging'),
    catalogFile: join(dir, 'catalog.json'),
  }
}

/** A media row whose sha256 is the real hash of `content`, so the tests can lie to nobody. */
function putMedia(db, content, { now = T0 } = {}) {
  const bytes = Buffer.from(content, 'utf8')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  db.prepare(
    'INSERT INTO media (sha256, ext, content_type, bytes, duration_seconds, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(sha256, 'mp3', 'audio/mpeg', bytes.length, 1.5, now)
  const storagePath = db.prepare('SELECT storage_path FROM media WHERE sha256 = ?').get(sha256).storage_path
  return { sha256, bytes, storagePath }
}

function place(root, storagePath, bytes) {
  const target = join(root, storagePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, bytes)
  return target
}

/**
 * Two groups, three clips, captions with a deliberate hole in one locale.
 */
function seedCatalogue(db) {
  const insertGroup = db.prepare('INSERT INTO groups (id, display_name, sort_order, created_at) VALUES (?, ?, ?, ?)')
  insertGroup.run('hummings', 'Cute Hummings', 2, T0)
  insertGroup.run('alarms', 'Joi Alarm', 1, T0)

  const groupCaption = db.prepare('INSERT INTO group_captions (group_id, locale, text, updated_at) VALUES (?, ?, ?, ?)')
  for (const locale of ['en-US', 'zh-CN', 'ja-JP']) {
    groupCaption.run('hummings', locale, `hummings ${locale}`, T0)
    groupCaption.run('alarms', locale, `alarms ${locale}`, T0)
  }

  const media = {
    ei: putMedia(db, 'ei-audio'),
    wake: putMedia(db, 'wake-audio'),
    late: putMedia(db, 'late-audio'),
  }
  const insertClip = db.prepare(`
    INSERT INTO clips (id, group_id, media_sha256, label, sort_order, state, created_at, published_at)
    VALUES (?, ?, ?, ?, ?, 'published', ?, ?)
  `)
  insertClip.run('clip-ei', 'hummings', media.ei.sha256, 'Ei?', 0, T0, T0)
  insertClip.run('clip-wake', 'alarms', media.wake.sha256, 'Wake up', 1, T0, T0)
  insertClip.run('clip-late', 'alarms', media.late.sha256, 'Late', 0, T0, T0)

  const clipCaption = db.prepare('INSERT INTO clip_captions (clip_id, locale, text, updated_at) VALUES (?, ?, ?, ?)')
  for (const locale of ['en-US', 'zh-CN', 'ja-JP']) {
    clipCaption.run('clip-ei', locale, `ei ${locale}`, T0)
    clipCaption.run('clip-wake', locale, `wake ${locale}`, T0)
  }
  // clip-late is deliberately missing ja-JP: the hole this document must report
  // by OMISSION and never as an empty string.
  clipCaption.run('clip-late', 'en-US', 'late en-US', T0)
  clipCaption.run('clip-late', 'zh-CN', 'late zh-CN', T0)

  return media
}

test('the document carries the shape home.vue consumes: ids as i18n keys, per-locale captions, page order', (t) => {
  const db = openDatabase(t)
  const media = seedCatalogue(db)
  const doc = buildCatalog(db)

  // The version pair travels with the document; a cached parser compares itself
  // against minCompatibleVersion to decide whether it must reload.
  assert.equal(doc.schemaVersion, db.prepare('SELECT version FROM schema_version WHERE id = 1').get().version)
  assert.equal(doc.minCompatibleVersion, 1)

  // groups[] is the order the headings appear in: 'alarms' has sort_order 1 and
  // must come before 'hummings' at 2, whatever the ids sort like.
  assert.deepEqual(doc.groups.map((g) => g.id), ['alarms', 'hummings'])

  // clips[] is page order end to end — grouped in the same sequence as groups[],
  // and by sort_order within a group.
  assert.deepEqual(doc.clips.map((c) => c.id), ['clip-late', 'clip-wake', 'clip-ei'])
  assert.deepEqual(doc.clips.map((c) => c.groupId), ['alarms', 'alarms', 'hummings'])

  // main.js writes `voice[<key>]` and home.vue renders `$t('voice.' + key)`, so
  // the id has to be resolvable as a FLAT vue-i18n key — no dots, no brackets.
  for (const subject of [...doc.groups, ...doc.clips]) {
    assert.match(subject.id, /^[a-z0-9_-]+$/, `${subject.id} is not usable as a flat vue-i18n key`)
  }

  // The audio url is exactly the string home.vue builds today: 'voices/' + path.
  const late = doc.clips.find((c) => c.id === 'clip-late')
  assert.equal(doc.mediaBaseUrl, MEDIA_BASE_URL)
  assert.equal(`${doc.mediaBaseUrl}${late.path}`, `voices/${media.late.storagePath}`)
  assert.match(late.path, /^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.mp3$/)
})

test('a locale the owner has not written is an ABSENT key, never an empty string', (t) => {
  const db = openDatabase(t)
  seedCatalogue(db)
  const doc = buildCatalog(db)

  const late = doc.clips.find((c) => c.id === 'clip-late')
  assert.deepEqual(Object.keys(late.captions), ['en-US', 'zh-CN'])
  assert.equal(Object.hasOwn(late.captions, 'ja-JP'), false)

  // Why it matters, in one line: main.js only assigns a message when the locale
  // is `!== undefined`, and VueI18n is built with no fallbackLocale. An empty
  // string would render an empty button — a hole nobody can see. The absent key
  // renders 'voice.clip-late', which is the hole that gets fixed.
  const wake = doc.clips.find((c) => c.id === 'clip-wake')
  assert.deepEqual(Object.keys(wake.captions), ['en-US', 'zh-CN', 'ja-JP'])
  assert.equal(
    JSON.stringify(doc).includes('""'),
    false,
    'an empty caption reached the document, which renders as a button with no text',
  )
})

test('two builds of identical data are byte-identical, and a single edited caption is not', (t) => {
  const db = openDatabase(t)
  seedCatalogue(db)

  const first = serializeCatalog(buildCatalog(db))
  const second = serializeCatalog(buildCatalog(db))
  assert.ok(first.equals(second), 'a rebuild from identical data differed, which churns every cache for nothing')

  // The counter-proof. Without it, a builder that emitted a constant would pass
  // the assertion above forever.
  db.prepare("UPDATE clip_captions SET text = 'ei changed' WHERE clip_id = 'clip-ei' AND locale = 'en-US'").run()
  assert.ok(!serializeCatalog(buildCatalog(db)).equals(first), 'an edited caption did not change the document')
})

test('locale key order inside a caption map is fixed, so the same data cannot serialise two ways', (t) => {
  const db = openDatabase(t)
  seedCatalogue(db)
  const before = serializeCatalog(buildCatalog(db))

  // Rewrite the same captions in a different physical order. Ordering by rowid
  // would reshuffle the JSON; ordering by the locales table cannot.
  db.prepare("DELETE FROM clip_captions WHERE clip_id = 'clip-wake'").run()
  const insert = db.prepare('INSERT INTO clip_captions (clip_id, locale, text, updated_at) VALUES (?, ?, ?, ?)')
  for (const locale of ['ja-JP', 'en-US', 'zh-CN']) insert.run('clip-wake', locale, `wake ${locale}`, T0)

  assert.ok(serializeCatalog(buildCatalog(db)).equals(before), 'row order leaked into the document')
})

test('a database that migrate() never stamped cannot be published from', () => {
  const db = new Database(':memory:')
  try {
    assert.throws(() => buildCatalog(db), (error) => {
      assert.ok(error instanceof CatalogError)
      assert.equal(error.code, 'schema_unstamped')
      return true
    })
  } finally {
    db.close()
  }
})

test('writeCatalog puts catalog.json and the media on the shared directory, and skips a file that is already correct', (t) => {
  const db = openDatabase(t)
  const media = seedCatalogue(db)
  const paths = workspace(t)
  for (const blob of Object.values(media)) place(paths.mediaDir, blob.storagePath, blob.bytes)

  const first = writeCatalog(db, paths, { now: new Date(T0) })
  assert.equal(first.catalogChanged, true)
  assert.equal(first.clips, 3)
  assert.equal(first.groups, 2)

  const written = readFileSync(paths.catalogFile)
  assert.equal(createHash('sha256').update(written).digest('hex'), first.catalogSha256)
  assert.deepEqual(JSON.parse(written.toString('utf8')), buildCatalog(db))

  // The atomic write leaves nothing behind: a temp file that survived would be
  // both a leak and, but for its leading dot, a servable half-document.
  assert.deepEqual(readdirSync(paths.dir).filter((name) => name.startsWith('.')), [])

  // Unchanged data must not rewrite the file. The inode is the honest witness:
  // a rename would replace it, and every cache that revalidated on the ETag
  // would pay for a publish that changed nothing.
  const inodeBefore = statSync(paths.catalogFile).ino
  const second = writeCatalog(db, paths, { now: new Date(T10) })
  assert.equal(second.catalogChanged, false)
  assert.equal(second.catalogSha256, first.catalogSha256)
  assert.equal(statSync(paths.catalogFile).ino, inodeBefore)

  // ... and a real change does rewrite it, so the assertion above is not
  // measuring a writeCatalog that never writes anything.
  db.prepare("UPDATE clips SET label = 'Ei!' WHERE id = 'clip-ei'").run()
  const third = writeCatalog(db, paths, { now: new Date(T10) })
  assert.equal(third.catalogChanged, true)
  assert.notEqual(statSync(paths.catalogFile).ino, inodeBefore)
})

test('publishing refuses to name a file that is not on the volume, and leaves the previous catalogue in place', (t) => {
  const db = openDatabase(t)
  const media = seedCatalogue(db)
  const paths = workspace(t)
  for (const blob of Object.values(media)) place(paths.mediaDir, blob.storagePath, blob.bytes)

  const good = writeCatalog(db, paths, { now: new Date(T0) })
  const previous = readFileSync(paths.catalogFile)

  // A fourth clip whose blob never made it to the volume.
  const orphan = putMedia(db, 'never-uploaded')
  db.prepare(`
    INSERT INTO clips (id, group_id, media_sha256, label, sort_order, state, created_at, published_at)
    VALUES ('clip-orphan', 'alarms', ?, 'Orphan', 9, 'published', ?, ?)
  `).run(orphan.sha256, T0, T0)
  db.prepare('INSERT INTO clip_captions (clip_id, locale, text, updated_at) VALUES (?, ?, ?, ?)').run(
    'clip-orphan',
    'en-US',
    'orphan',
    T0,
  )

  assert.throws(
    () => writeCatalog(db, paths, { now: new Date(T10) }),
    (error) => {
      assert.ok(error instanceof CatalogError)
      assert.equal(error.code, 'media_missing')
      assert.deepEqual(error.details.map((p) => p.problem), ['missing'])
      assert.equal(error.details[0].sha256, orphan.sha256)
      return true
    },
    'a catalogue naming a file that 404s is worse than one that is a publish out of date',
  )
  assert.ok(readFileSync(paths.catalogFile).equals(previous), 'the refusal still rewrote catalog.json')
  assert.equal(good.catalogSha256, createHash('sha256').update(previous).digest('hex'))
})

test('the media lands before the manifest that names it', (t) => {
  const db = openDatabase(t)
  const media = seedCatalogue(db)
  const paths = workspace(t)
  // Everything is staged and nothing is on the volume yet.
  for (const blob of Object.values(media)) place(paths.sourceDir, blob.storagePath, blob.bytes)

  // catalog.json cannot be written: its parent is a FILE. So the run fails at
  // the manifest, after the media pass — which is how the ORDER becomes
  // observable at all. Reverse the two and the copies never happen.
  const blocker = join(paths.dir, 'blocked')
  writeFileSync(blocker, 'not a directory')
  const doomed = { ...paths, catalogFile: join(blocker, 'catalog.json') }

  assert.throws(() => writeCatalog(db, doomed, { now: new Date(T0) }))
  for (const blob of Object.values(media)) {
    assert.ok(
      existsSync(join(paths.mediaDir, blob.storagePath)),
      'the manifest was attempted before the audio it names was in place',
    )
  }
  assert.equal(existsSync(doomed.catalogFile), false)
})

test('a staged file that does not hash to the name it is filed under is refused rather than frozen for a year', (t) => {
  const db = openDatabase(t)
  const media = seedCatalogue(db)
  const paths = workspace(t)
  place(paths.sourceDir, media.ei.storagePath, media.ei.bytes)
  place(paths.sourceDir, media.wake.storagePath, media.wake.bytes)
  // Same name, different bytes: corruption that only the hash can see.
  place(paths.sourceDir, media.late.storagePath, Buffer.from('tampered-audio-x', 'utf8'))

  assert.throws(
    () => writeCatalog(db, paths, { now: new Date(T0) }),
    (error) => {
      assert.equal(error.code, 'media_corrupt')
      assert.equal(error.details.sha256, media.late.sha256)
      return true
    },
    '/voices/ is served immutable for a year, so the copy is the last moment this is catchable',
  )
})

test('checkMedia sees truncation with a stat and substitution only with a hash', (t) => {
  const db = openDatabase(t)
  const media = seedCatalogue(db)
  const paths = workspace(t)
  for (const blob of Object.values(media)) place(paths.mediaDir, blob.storagePath, blob.bytes)

  assert.deepEqual(checkMedia(db, { mediaDir: paths.mediaDir }), [])

  // Truncated: the size no longer matches, which the cheap mode catches.
  writeFileSync(join(paths.mediaDir, media.ei.storagePath), media.ei.bytes.subarray(0, 3))
  const truncated = checkMedia(db, { mediaDir: paths.mediaDir })
  assert.deepEqual(truncated.map((p) => [p.sha256, p.problem]), [[media.ei.sha256, 'wrong_size']])

  // Substituted, same length: invisible to a stat, and the reason the expensive
  // mode is offered at all.
  writeFileSync(join(paths.mediaDir, media.ei.storagePath), Buffer.alloc(media.ei.bytes.length, 0x41))
  assert.deepEqual(checkMedia(db, { mediaDir: paths.mediaDir }), [])
  assert.deepEqual(
    checkMedia(db, { mediaDir: paths.mediaDir, verify: 'sha256' }).map((p) => p.problem),
    ['wrong_content'],
  )
})

test('a dry run reports what would be written and touches nothing', (t) => {
  const db = openDatabase(t)
  const media = seedCatalogue(db)
  const paths = workspace(t)
  for (const blob of Object.values(media)) place(paths.mediaDir, blob.storagePath, blob.bytes)

  const preview = writeCatalog(db, paths, { dryRun: true, now: new Date(T0) })
  assert.equal(preview.dryRun, true)
  assert.equal(preview.clips, 3)
  assert.equal(existsSync(paths.catalogFile), false, 'a dry run wrote the file it promised not to')
})
