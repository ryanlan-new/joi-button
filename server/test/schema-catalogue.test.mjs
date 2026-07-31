// The rules that keep the published catalogue and the PVC agreeing with each
// other: what counts as a reference to a blob, and what may be published where.
//
// The defect in v_unreferenced_media was a leak with no end. Cancelling is what
// happens INSTEAD of reviewing, so a cancelled batch's items keep state
// 'pending' for the life of the database; reading that as a live reference
// meant the view never listed their blobs and the janitor never collected a
// byte of an abandoned upload.

import assert from 'node:assert/strict'
import test from 'node:test'

import { T0, T10, assertAccepted, assertRefused, openDatabase, seed } from './helpers/temp-db.mjs'

function addMedia(db, sha, { now = T0 } = {}) {
  db.prepare(`
    INSERT INTO media (sha256, ext, content_type, bytes, duration_seconds, uploaded_at)
    VALUES (?, 'mp3', 'audio/mpeg', 4096, 1.5, ?)
  `).run(sha, now)
  return sha
}

function unreferenced(db) {
  return db
    .prepare('SELECT sha256 FROM v_unreferenced_media ORDER BY sha256')
    .all()
    .map((row) => row.sha256)
}

test('a blob held only by a CANCELLED batch is collectable, because cancelling is what happens instead of reviewing', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)

  const abandoned = addMedia(db, 'c'.repeat(64))
  db.prepare(`
    INSERT INTO batches (id, submitter_id, state, created_at, submitted_at)
    VALUES ('bat-cancelled', ?, 'draft', ?, NULL)
  `).run(ids.submitter, T0)
  db.prepare(`
    INSERT INTO batch_items (id, batch_id, position, media_sha256, proposed_label, created_at)
    VALUES ('item-abandoned', 'bat-cancelled', 1, ?, 'Abandoned', ?)
  `).run(abandoned, T0)
  db.prepare("UPDATE batches SET state = 'cancelled' WHERE id = 'bat-cancelled'").run()

  // The item is still 'pending' and always will be: nothing reviews a cancelled
  // batch. That is the state the old view read as a live reference.
  assert.equal(
    db.prepare("SELECT state FROM batch_items WHERE id = 'item-abandoned'").get().state,
    'pending',
  )
  assert.ok(
    unreferenced(db).includes(abandoned),
    'the janitor can never collect an abandoned upload, and nothing else ever will',
  )
})

test('a blob held by a live pending item, a published clip or a RETIRED clip is not collectable', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)

  // seed() already points clip-alpha at ids.media.
  const pendingBlob = addMedia(db, 'd'.repeat(64))
  db.prepare(`
    INSERT INTO batch_items (id, batch_id, position, media_sha256, proposed_label, created_at)
    VALUES ('item-live', ?, 1, ?, 'Under review', ?)
  `).run(ids.batch, pendingBlob, T0)

  const retiredBlob = addMedia(db, 'e'.repeat(64))
  db.prepare(`
    INSERT INTO clips (id, group_id, media_sha256, label, state, created_at, published_at, retired_at)
    VALUES ('clip-retired', ?, ?, 'Retired', 'retired', ?, ?, ?)
  `).run(ids.group, retiredBlob, T0, T0, T10)

  const collectable = unreferenced(db)
  assert.ok(!collectable.includes(ids.media), 'a blob a clip plays was offered to the janitor')
  assert.ok(!collectable.includes(pendingBlob), 'a blob under review was offered to the janitor')
  assert.ok(
    !collectable.includes(retiredBlob),
    'a retired clip\'s file is cached immutable for a year and is still being played',
  )
  // ids.media2 is seeded and pointed at by nothing, which is what a genuinely
  // unreferenced blob looks like — without it this test could pass on a view
  // that lists nothing at all.
  assert.deepEqual(collectable, [ids.media2])
})

test('an approved item and the clip it became outlive neither of them alone', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)

  db.prepare(`
    INSERT INTO batch_items (id, batch_id, position, media_sha256, proposed_label, state, created_at, resolved_at, clip_id)
    VALUES ('item-approved', ?, 1, ?, 'Approved', 'approved', ?, ?, ?)
  `).run(ids.batch, ids.media2, T0, T10, ids.clip)

  // The correction this asserts: the column said ON DELETE SET NULL, which
  // could never once have fired — nulling clip_id on an approved item violates
  // the paired CHECK, so the delete aborted anyway, with 'CHECK constraint
  // failed', which names the wrong thing and sends the reader to the wrong line.
  const error = assertRefused(
    () => db.prepare('DELETE FROM clips WHERE id = ?').run(ids.clip),
    /FOREIGN KEY constraint failed/,
    'a clip an approved item became was deleted out from under it.',
  )
  assert.doesNotMatch(
    error.message,
    /CHECK constraint failed/,
    'the refusal must name the relationship, not a CHECK on a column the deleter never mentioned',
  )
  // Measured, not assumed: SQLite implements ON DELETE RESTRICT with an
  // internal trigger, so the code is SQLITE_CONSTRAINT_TRIGGER even though the
  // message says FOREIGN KEY. The message is what a reader sees, so the message
  // is what this asserts on.
  assert.equal(error.code, 'SQLITE_CONSTRAINT_TRIGGER')
})

test('a clip cannot be published into a retired group, whether it arrives that way or is moved there', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  db.prepare("INSERT INTO groups (id, display_name, state, created_at, retired_at) VALUES ('grp-retired', 'Retired', 'retired', ?, ?)").run(
    T0,
    T10,
  )

  assertRefused(
    () =>
      db
        .prepare(`
          INSERT INTO clips (id, group_id, media_sha256, label, state, created_at, published_at)
          VALUES ('clip-into-retired', 'grp-retired', ?, 'Nope', 'published', ?, ?)
        `)
        .run(ids.media2, T0, T0),
    /cannot publish into a retired group/,
    'a clip arrived published in a retired group.',
  )

  db.prepare(`
    INSERT INTO clips (id, group_id, media_sha256, label, created_at) VALUES ('clip-draft', ?, ?, 'Draft', ?)
  `).run(ids.group, ids.media2, T0)
  assertRefused(
    () =>
      db
        .prepare(
          "UPDATE clips SET state = 'published', published_at = ?, group_id = 'grp-retired' WHERE id = 'clip-draft'",
        )
        .run(T0),
    /cannot publish into a retired group/,
    'a clip was published into a retired group by moving it there.',
  )

  assertAccepted(
    () => db.prepare("UPDATE clips SET state = 'published', published_at = ? WHERE id = 'clip-draft'").run(T0),
    'publishing into an ACTIVE group was refused.',
  )
})

test('a group with published clips cannot be retired, which is the same rule from the other end', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  db.prepare("UPDATE clips SET state = 'published', published_at = ? WHERE id = ?").run(T0, ids.clip)

  assertRefused(
    () => db.prepare("UPDATE groups SET state = 'retired', retired_at = ? WHERE id = ?").run(T10, ids.group),
    /retire the published clips in this group first/,
    'a group was retired out from under a published clip, leaving a button nobody can find.',
  )

  db.prepare("UPDATE clips SET state = 'retired', retired_at = ? WHERE id = ?").run(T10, ids.clip)
  assertAccepted(
    () => db.prepare("UPDATE groups SET state = 'retired', retired_at = ? WHERE id = ?").run(T10, ids.group),
    'a group with nothing published in it could not be retired.',
  )
})

test('the ids that are i18n keys are immutable and cannot contain a path separator', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)

  assertRefused(
    () => db.prepare("UPDATE groups SET id = 'grp-renamed' WHERE id = ?").run(ids.group),
    /groups\.id is the i18n key and is immutable/,
    'a published i18n key was renamed rather than a new one being minted.',
  )
  assertRefused(
    () => db.prepare("UPDATE clips SET id = 'clip-renamed' WHERE id = ?").run(ids.clip),
    /clips\.id is the i18n key and is immutable/,
    'a published clip key was renamed.',
  )

  // vue-i18n resolves a key as a PATH, so an id containing a dot would silently
  // resolve to a nested lookup that misses and the page would render the raw
  // key path.
  for (const bad of ['grp.alpha', 'grp[0]', 'Grp-Alpha', 'grp alpha']) {
    assertRefused(
      () => db.prepare('INSERT INTO groups (id, display_name, created_at) VALUES (?, ?, ?)').run(bad, bad, T0),
      /CHECK constraint failed/,
      `groups.id accepted ${JSON.stringify(bad)}, which is not resolvable as a flat vue-i18n key.`,
    )
  }
})

test('two ACTIVE groups cannot share a visible name, and a retired one releases it', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)

  assertRefused(
    () => db.prepare('INSERT INTO groups (id, display_name, created_at) VALUES (?, ?, ?)').run('grp-dup', 'alpha', T0),
    /UNIQUE constraint failed/,
    'two live groups share a visible name, which is how a reviewer files a clip under the wrong one.',
  )

  db.prepare("UPDATE groups SET state = 'retired', retired_at = ? WHERE id = ?").run(T10, ids.group)
  assertAccepted(
    () => db.prepare('INSERT INTO groups (id, display_name, created_at) VALUES (?, ?, ?)').run('grp-dup', 'Alpha', T0),
    'a name could not be reused after the group holding it retired.',
  )
})

test('exactly one theme is active at a time, and rollback is one statement', (t) => {
  const db = openDatabase(t)
  const insert = db.prepare(
    'INSERT INTO themes (id, name, tokens, created_at, is_active, activated_at) VALUES (?, ?, ?, ?, ?, ?)',
  )

  insert.run('theme-a', 'A', '{"bg":"#000"}', T0, 1, T0)
  insert.run('theme-b', 'B', '{"bg":"#fff"}', T0, 1, T10)
  assert.deepEqual(
    db.prepare('SELECT id FROM themes WHERE is_active = 1').all().map((r) => r.id),
    ['theme-b'],
  )

  db.prepare('UPDATE themes SET is_active = 1, activated_at = ? WHERE id = ?').run(T10, 'theme-a')
  assert.deepEqual(
    db.prepare('SELECT id FROM themes WHERE is_active = 1').all().map((r) => r.id),
    ['theme-a'],
    'the BEFORE trigger must clear the previous active row before the unique index sees two',
  )

  assertRefused(
    () => insert.run('theme-c', 'C', 'not json at all', T0, 0, null),
    /CHECK constraint failed/,
    'an unparseable theme was stored, which means it can be activated.',
  )
})

test('the catalogue views order deterministically, so a rebuild from identical data is byte-identical', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  db.prepare("UPDATE clips SET state = 'published', published_at = ? WHERE id = ?").run(T0, ids.clip)
  db.prepare(`
    INSERT INTO clips (id, group_id, media_sha256, label, sort_order, state, created_at, published_at)
    VALUES ('clip-second', ?, ?, 'Second', 0, 'published', ?, ?)
  `).run(ids.group, ids.media2, T0, T0)

  // sort_order alone is not unique; the id is the tiebreak, and without one an
  // unstable sort would reshuffle catalog.json on every rebuild.
  assert.deepEqual(
    db.prepare('SELECT id FROM v_catalog_clips').all().map((r) => r.id),
    ['clip-alpha', 'clip-second'],
  )
  assert.deepEqual(
    db.prepare('SELECT id, storage_path FROM v_catalog_clips').all().map((r) => r.storage_path),
    [`${ids.media.slice(0, 2)}/${ids.media.slice(2, 4)}/${ids.media}.mp3`, `${ids.media2.slice(0, 2)}/${ids.media2.slice(2, 4)}/${ids.media2}.mp3`],
    'storage_path is generated from the hash, so it cannot drift from the blob it names',
  )
})
