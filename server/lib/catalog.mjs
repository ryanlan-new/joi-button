// SPDX-License-Identifier: MIT
//
// The published catalogue: the document the site reads, and the act of putting
// it (and the audio it names) on the shared directory the web pod mounts.
//
// SQLite is the sole authority. Nothing here reads src/voices.json, GitHub or
// the existing PVC to decide what is published — those are outputs or historical
// inputs. buildCatalog() is a pure function of the database; writeCatalog() is
// the only thing in this file that touches a disk.
//
// ===========================================================================
// WHAT THE PAGE CONSUMES TODAY, AND WHICH PART OF IT IS LOAD-BEARING
// ===========================================================================
// Measured against src/main.js and src/components/home.vue as they stand.
// voices.json is `{ voices: [ { categoryName, categoryDescription: {locale:
// text}, voiceList: [ { name, path, description: {locale: text} } ] } ] }`, and
// the page does four things with it:
//
//   1. main.js folds the text into the vue-i18n bundles, one message per
//      subject: `voicecategory[categoryName] = categoryDescription[locale]` and
//      `voice[name] = description[locale]` — and ONLY when that locale key is
//      `!== undefined`.
//   2. home.vue renders `$t('voicecategory.' + category.categoryName)` as the
//      heading and `$t('voice.' + voiceItem.name)` as the button label.
//   3. home.vue plays `clip.src`, which the catalogue composes as
//      `mediaBaseUrl + path`. For the clips COMPILED INTO THE BUNDLE that is
//      still 'voices/' + path, the image's own static folder; for anything this
//      API publishes it is '/media/' + path, the shared volume. Two trees, two
//      prefixes, and the document carries which one it means.
//   4. home.vue iterates the arrays in order: `v-for="category in voices"`, then
//      `v-for="voiceItem in category.voiceList"`. Array order IS page order.
//
// So the LOAD-BEARING parts of the shape below, the ones a rewrite may not
// quietly change, are:
//
//   * `id` on a group and on a clip is the vue-i18n KEY, not a label. It is
//     substituted into `voicecategory.<id>` / `voice.<id>`, and vue-i18n
//     resolves a key as a PATH — a '.' or '[]' in an id resolves to a nested
//     lookup that misses, and the page renders the raw key path. schema.sql
//     CHECKs the charset for exactly this reason, so the document inherits the
//     property rather than re-asserting it.
//   * `captions` is a map keyed by locale code, and a locale the owner has not
//     written yet is an ABSENT KEY — never `""`. main.js only assigns a message
//     when the locale is `!== undefined`, and VueI18n is constructed with no
//     fallbackLocale, so an empty string renders an empty button (a hole nobody
//     can see) while an absent key renders the key path (a hole everybody can
//     see). The second is the one that gets fixed. `label` /`displayName` ride
//     along as the last-resort text for that case, which is what schema.sql says
//     they are for.
//   * ORDER. `groups` is the order the headings appear in, and the clips of one
//     group are the order its buttons appear in. There is no sort field the
//     consumer is expected to apply; the document is already in page order.
//   * `mediaBaseUrl + clip.path` is the audio url. It is ROOT-RELATIVE
//     ('/media/'), never scheme-relative and never absolute: an absolute url
//     would bake in a scheme and host that only the ingress knows, and
//     src/catalog.mjs refuses one outright.
//     It used to be 'voices/', which was wrong in two ways at once — it named
//     the image's own static folder rather than the volume the web pod
//     publishes, and being path-relative it resolved against whatever ROUTE the
//     visitor was on, so the same clip was a different URL on /admin than on /.
//
// Everything else (sha256, bytes, durationSeconds, contentType, sortOrder) is
// informational: a consumer may show it, and nothing breaks if it ignores it.
//
// ===========================================================================
// WHY THE DOCUMENT CARRIES NO "generatedAt"
// ===========================================================================
// v_catalog_groups and v_catalog_clips carry their ORDER BY so that "every
// publisher produces byte-identical output from identical data". A timestamp
// stamped at build time would defeat that on its own: every rebuild would
// differ, every rebuild would churn the cache, and "did anything actually
// change?" would stop being answerable by comparing bytes. So the document is a
// pure function of the database, writeCatalog() reports the sha256 it wrote, and
// it does not rewrite a file whose bytes are already correct. When the catalogue
// was last published is a question for the audit log, which records it with an
// actor attached.
//
// ===========================================================================
// WHY THE WRITES ARE ATOMIC, AND WHY MEDIA GOES FIRST
// ===========================================================================
// The web pod mounts this directory read-only and is serving catalog.json to
// somebody at the moment we write it. `open(…, 'w')` truncates in place, so a
// reader between the truncate and the last byte gets a partial document — and a
// partial JSON document is not a slightly-wrong page, it is a parse error and a
// blank site. Writing a temp file in the SAME directory, fsync-ing it, and
// rename()-ing over the target makes the swap atomic for every reader: rename is
// atomic within one filesystem, which is why the temp file cannot live in /tmp.
// The directory is fsync-ed afterwards so the rename itself survives a power
// loss, not just the bytes.
//
// The temp name starts with a dot on purpose: deploy/nginx.conf answers 404 for
// any path segment beginning with '.', so a temp file that somehow outlives a
// crash is unservable rather than being a half-written document with a URL.
//
// Media is written BEFORE catalog.json, always. The document is the manifest a
// browser reads first; publishing it before the bytes it names opens a window in
// which a button 404s. The other order costs nothing: a blob nothing references
// yet is invisible.
//
// ===========================================================================
// WHAT MAKES THIS GO RED
// ===========================================================================
//   * Write catalog.json before the media files — the "a catalogue is never
//     published ahead of the audio it names" case goes red (the test asserts the
//     media file exists at the moment the catalogue lands).
//   * Replace the temp+rename with a direct writeFileSync — the "an interrupted
//     write leaves the previous catalogue intact" case goes red.
//   * Put the temp file in os.tmpdir() — rename() across filesystems throws
//     EXDEV, which the atomicity case catches.
//   * Emit `""` for a locale with no caption row instead of omitting the key —
//     the "a missing translation is a missing key, not an empty string" case
//     goes red.
//   * Stop refusing when a referenced blob is absent from mediaDir — the
//     "publishing refuses to name a file that is not there" case goes red.
//   * Add any field to the document that changes between two builds of the same
//     data — the byte-identical-rebuild case goes red.

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import { readSchemaStamp, toCanonicalTimestamp } from '../db/migrate.mjs'

/**
 * '/media/', and both halves of that matter.
 *
 * WHERE: deploy/nginx.conf publishes the shared volume's media at
 * `location ^~ /media/`, aliased to /srv/shared/media/. 'voices/' — what this
 * was — is the image's OWN static folder, holding the clips compiled into the
 * bundle. Nothing on the volume is reachable under that prefix, so every
 * submitted clip 404'd: on the site, and in the review desk's audition panel,
 * where the listen-before-approve gate would then never open.
 *
 * ROOT-relative: a leading slash. Without it the browser resolves the url
 * against the DOCUMENT's path, so a clip is '/media/ab/cd/x.mp3' on '/' and
 * '/admin/media/ab/cd/x.mp3' on '/admin'. src/catalog.mjs still refuses a
 * mediaBaseUrl that is absolute or scheme-relative — a leading slash is neither,
 * and it keeps every url on this origin, which is the property that check is
 * protecting.
 */
export const MEDIA_BASE_URL = '/media/'

export class CatalogError extends Error {
  constructor(message, code, details = null) {
    super(message)
    this.name = 'CatalogError'
    this.code = code
    this.details = details
  }
}

/**
 * The catalogue document, built from the database and nothing else.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ mediaBaseUrl?: string }} [options]
 * @returns {object} plain JSON-ready object, in the key order it serialises in
 */
export function buildCatalog(db, options = {}) {
  const mediaBaseUrl = options.mediaBaseUrl ?? MEDIA_BASE_URL

  // The version pair travels with the document because a tab left open across a
  // deploy is running a JS chunk cached `immutable` for a year: it has to be
  // able to ask "can I still read this?" without guessing. Refusing when the
  // stamp is absent rather than defaulting to 1 — an unstamped database is one
  // migrate() never touched, and publishing from it would put a confident
  // version number on a document nobody can vouch for.
  const stamp = readSchemaStamp(db)
  if (stamp === null) {
    throw new CatalogError(
      'catalog: this database carries no schema_version row; run migrate() before publishing',
      'schema_unstamped',
    )
  }

  const locales = db
    .prepare('SELECT code, label, sort_order, is_ui_default FROM locales ORDER BY sort_order, code')
    .all()
  const localeOrder = locales.map((row) => row.code)

  const groupRows = db.prepare('SELECT id, display_name, sort_order FROM v_catalog_groups').all()
  const clipRows = db
    .prepare(
      'SELECT id, group_id, label, sort_order, sha256, storage_path, bytes, duration_seconds FROM v_catalog_clips',
    )
    .all()

  const groupCaptions = collectCaptions(
    db.prepare('SELECT group_id AS subject_id, locale, text FROM group_captions').all(),
    localeOrder,
  )
  const clipCaptions = collectCaptions(
    db.prepare('SELECT clip_id AS subject_id, locale, text FROM clip_captions').all(),
    localeOrder,
  )

  const groupPosition = new Map(groupRows.map((row, index) => [row.id, index]))

  // The view orders clips by (group_id, sort_order, id) — a total order, but
  // group_id sorts lexicographically, which is not the order the headings appear
  // in. Re-keying on the group's POSITION makes array order equal page order end
  // to end, so a consumer can render the document straight through; the order
  // WITHIN a group is the view's own and is untouched.
  const orderedClips = [...clipRows].sort((a, b) => {
    const ga = groupPosition.get(a.group_id)
    const gb = groupPosition.get(b.group_id)
    if (ga !== gb) return ga - gb
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  for (const clip of clipRows) {
    // Two triggers in schema.sql make this unreachable (a clip cannot be
    // published into a retired group, and a group with published clips cannot
    // retire). Asserting it costs one Map lookup and turns "the impossible
    // happened" into a message that says so, instead of a button rendered under
    // a heading the document does not contain.
    if (!groupPosition.has(clip.group_id)) {
      throw new CatalogError(
        `catalog: published clip ${clip.id} belongs to group ${clip.group_id}, which is not an active group`,
        'orphaned_clip',
        { clipId: clip.id, groupId: clip.group_id },
      )
    }
  }

  return {
    schemaVersion: stamp.version,
    minCompatibleVersion: stamp.minCompatibleVersion,
    mediaBaseUrl,
    locales: locales.map((row) => ({
      code: row.code,
      label: row.label,
      sortOrder: row.sort_order,
      isUiDefault: row.is_ui_default === 1,
    })),
    groups: groupRows.map((row) => ({
      id: row.id,
      sortOrder: row.sort_order,
      // Not a key and not a translation: the reviewer-facing name, carried as
      // the last-resort text for a locale with no caption row (schema.sql,
      // groups.display_name).
      displayName: row.display_name,
      captions: groupCaptions.get(row.id) ?? {},
    })),
    clips: orderedClips.map((row) => ({
      id: row.id,
      groupId: row.group_id,
      sortOrder: row.sort_order,
      label: row.label,
      path: row.storage_path,
      sha256: row.sha256,
      bytes: row.bytes,
      durationSeconds: row.duration_seconds,
      captions: clipCaptions.get(row.id) ?? {},
    })),
  }
}

/**
 * The exact bytes catalog.json holds.
 *
 * Two spaces and a trailing newline: the file is read by machines but diffed by
 * people, and `git diff` on a one-line 40KB document tells nobody anything.
 */
export function serializeCatalog(document) {
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8')
}

/**
 * Is every blob the catalogue names actually on the shared directory?
 *
 * Returns a list of problems rather than throwing, so a caller can report all of
 * them at once instead of one per attempt.
 *
 * `verify`:
 *   'stat'    size must match media.bytes. Cheap, catches absence and truncation.
 *   'sha256'  re-hash the file. Honest, and O(total bytes) — offered rather than
 *             imposed, because a publish is not the moment to read every blob on
 *             the volume.
 *
 * @returns {Array<{sha256: string, path: string, problem: string, detail?: string}>}
 */
export function checkMedia(db, { mediaDir, verify = 'stat' } = {}, shaList = null) {
  requireDir(mediaDir, 'mediaDir')
  if (verify !== 'stat' && verify !== 'sha256') {
    throw new CatalogError(`catalog: unknown media verification mode ${JSON.stringify(verify)}`, 'bad_argument')
  }

  const rows =
    shaList === null
      ? db.prepare('SELECT sha256, storage_path, bytes FROM v_catalog_clips').all()
      : shaList.map((sha) => {
          const row = db
            .prepare('SELECT sha256, storage_path, bytes FROM media WHERE sha256 = ?')
            .get(sha)
          if (!row) {
            throw new CatalogError(`catalog: no media row for ${sha}`, 'unknown_media', { sha256: sha })
          }
          return row
        })

  const problems = []
  for (const row of rows) {
    const target = join(mediaDir, row.storage_path)
    let stats
    try {
      stats = statSync(target)
    } catch {
      problems.push({ sha256: row.sha256, path: row.storage_path, problem: 'missing' })
      continue
    }
    if (stats.size !== row.bytes) {
      problems.push({
        sha256: row.sha256,
        path: row.storage_path,
        problem: 'wrong_size',
        detail: `the database says ${row.bytes} bytes, the file is ${stats.size}`,
      })
      continue
    }
    if (verify === 'sha256') {
      const actual = createHash('sha256').update(readFileSync(target)).digest('hex')
      if (actual !== row.sha256) {
        problems.push({
          sha256: row.sha256,
          path: row.storage_path,
          problem: 'wrong_content',
          detail: `the file hashes to ${actual}`,
        })
      }
    }
  }
  return problems
}

/**
 * Materialise the catalogue: the media files first, then catalog.json, both
 * atomically.
 *
 * paths:
 *   catalogFile  absolute path of catalog.json on the shared directory
 *   mediaDir     absolute path of the content-addressed media tree
 *   sourceDir    OPTIONAL staging tree, laid out identically (<ab>/<cd>/<sha>.<ext>).
 *                When given, a blob missing from mediaDir is copied from here and
 *                its hash is checked on the way past — the copy is the one moment
 *                a corrupt staging file can still be caught, because afterwards
 *                the name is served `immutable` for a year.
 *
 * options:
 *   dryRun       build, verify and report; write nothing.
 *   verifyMedia  'stat' (default) | 'sha256'; see checkMedia.
 *   now          Date or canonical timestamp, for a deterministic test.
 *
 * Idempotent: identical data produces identical bytes, and a catalog.json whose
 * bytes are already correct is left alone (`catalogChanged: false`) rather than
 * rewritten — a needless rename churns every cache that revalidated on the ETag.
 * That is also what makes a failed publish safe to re-run.
 */
export function writeCatalog(db, paths = {}, options = {}) {
  const { catalogFile, mediaDir, sourceDir = null } = paths
  requireDir(mediaDir, 'mediaDir')
  if (typeof catalogFile !== 'string' || catalogFile.trim() === '') {
    throw new CatalogError('catalog: paths.catalogFile must be a non-empty path', 'bad_argument')
  }

  const dryRun = options.dryRun === true
  const document = buildCatalog(db, options)
  const bytes = serializeCatalog(document)
  const catalogSha256 = createHash('sha256').update(bytes).digest('hex')

  const referenced = db.prepare('SELECT sha256, storage_path, bytes FROM v_catalog_clips').all()

  // The copy pass runs before the verification pass, so that a blob which is
  // legitimately still in staging is not reported as a missing file.
  const copied = []
  if (sourceDir !== null && !dryRun) {
    for (const row of referenced) {
      const target = join(mediaDir, row.storage_path)
      if (existsSync(target)) continue
      const from = join(sourceDir, row.storage_path)
      if (!existsSync(from)) continue // reported by checkMedia below, with everything else
      const payload = readFileSync(from)
      const actual = createHash('sha256').update(payload).digest('hex')
      if (actual !== row.sha256) {
        throw new CatalogError(
          `catalog: staged file ${row.storage_path} hashes to ${actual}, not to the name it is filed under`,
          'media_corrupt',
          { sha256: row.sha256, actual },
        )
      }
      writeFileAtomic(target, payload)
      copied.push(row.sha256)
    }
  }

  const problems = checkMedia(db, { mediaDir, verify: options.verifyMedia ?? 'stat' })
  if (problems.length > 0) {
    // Refused BEFORE catalog.json is touched. A catalogue that names a file
    // which is not there is a page of buttons that 404 — strictly worse than a
    // catalogue that is one publish out of date, because the stale one at least
    // plays.
    throw new CatalogError(
      `catalog: ${problems.length} referenced media file(s) are missing or do not match the database; nothing was published`,
      'media_missing',
      problems,
    )
  }

  const existing = readIfPresent(catalogFile)
  const catalogChanged = existing === null || !existing.equals(bytes)

  if (!dryRun && catalogChanged) {
    writeFileAtomic(catalogFile, bytes)
  }

  return {
    dryRun,
    writtenAt: toCanonicalTimestamp(options.now ?? new Date()),
    catalogFile,
    catalogSha256,
    catalogBytes: bytes.length,
    catalogChanged,
    groups: document.groups.length,
    clips: document.clips.length,
    media: { referenced: referenced.length, copied },
    document,
  }
}

// ---------------------------------------------------------------------------

function collectCaptions(rows, localeOrder) {
  const byLocale = new Map()
  for (const row of rows) {
    if (!byLocale.has(row.subject_id)) byLocale.set(row.subject_id, new Map())
    byLocale.get(row.subject_id).set(row.locale, row.text)
  }
  const out = new Map()
  for (const [subjectId, captions] of byLocale) {
    const ordered = {}
    // Locale order is fixed, so two builds of the same data serialise the same
    // bytes; a locale with no row is simply absent (see the header).
    for (const code of localeOrder) {
      if (captions.has(code)) ordered[code] = captions.get(code)
    }
    out.set(subjectId, ordered)
  }
  return out
}

function readIfPresent(file) {
  try {
    return readFileSync(file)
  } catch (err) {
    if (err?.code === 'ENOENT') return null
    throw err
  }
}

function requireDir(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CatalogError(`catalog: paths.${name} must be a non-empty path`, 'bad_argument')
  }
}

/**
 * Write `data` to `target` so that a concurrent reader sees either the whole
 * previous file or the whole new one, and never a prefix of either.
 *
 * The temp file lives in the target's own directory (rename is atomic only
 * within one filesystem) and is named with a leading dot (nginx answers 404 for
 * dotted segments, so a leftover is unservable rather than half a document with
 * a URL).
 */
function writeFileAtomic(target, data) {
  const dir = dirname(target)
  mkdirSync(dir, { recursive: true })
  const temp = join(dir, `.catalog-tmp-${randomUUID()}`)

  // 'wx' — refuse to open an existing file. The name carries a uuid, so a
  // collision means something else is writing here, and clobbering it is how two
  // publishers produce one interleaved file.
  const fd = openSync(temp, 'wx', 0o644)
  try {
    writeSync(fd, data)
    // The rename below is what a reader observes, but the rename can be durable
    // while the CONTENT is not: without this fsync a power loss can leave the
    // new name pointing at zeroes.
    fsyncSync(fd)
  } catch (err) {
    closeSync(fd)
    unlinkSync(temp)
    throw err
  }
  closeSync(fd)

  try {
    renameSync(temp, target)
  } catch (err) {
    unlinkSync(temp)
    throw err
  }

  fsyncDirectory(dir)
}

// Best-effort, and stated as such: this flushes the DIRECTORY entry so the
// rename itself survives a host power loss. The bytes and the rename have both
// already landed by the time this runs, so a platform that will not let us open
// a directory (Windows) loses crash-durability of the last publish, not the
// publish. Failing the whole write here would trade a real outcome for a
// hypothetical one.
function fsyncDirectory(dir) {
  let fd
  try {
    fd = openSync(dir, 'r')
  } catch {
    return
  }
  try {
    fsyncSync(fd)
  } catch {
    // see above
  } finally {
    closeSync(fd)
  }
}
