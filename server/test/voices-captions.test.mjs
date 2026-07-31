// Every caption the site already ships must survive the new gate.
//
// This is the false-positive test, and a false positive here is a real defect:
// the constraints in schema.sql are calibrated to accept everything
// escapeForI18n can emit, "because a backstop that refuses the sanctioned
// pipeline's own output is not a backstop, it is an outage". The catalogue that
// exists today is the sanctioned pipeline's oldest output.
//
// The counts are asserted before anything else. A loop over an empty list
// passes every assertion inside it, so "45 captions were checked" has to be a
// claim this file makes and not one the reader infers.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { CAPTION_MAX_LENGTH, escapeForI18n, validateCaption } from '../lib/text-safety.mjs'
import { T0, assertAccepted, assertRefused, inSavepoint, openDatabase } from './helpers/temp-db.mjs'

const EXPECTED_GROUPS = 3
const EXPECTED_CLIPS = 12
const EXPECTED_LOCALES = ['en-US', 'ja-JP', 'zh-CN']

function loadCatalogue() {
  const raw = JSON.parse(readFileSync(new URL('../../src/voices.json', import.meta.url), 'utf8'))
  const groups = raw.voices.map((group, index) => ({
    id: `grp-${index}`,
    name: group.categoryName,
    captions: group.categoryDescription,
  }))
  const clips = []
  for (const [groupIndex, group] of raw.voices.entries()) {
    for (const voice of group.voiceList) {
      clips.push({
        id: `clip-${clips.length}`,
        groupId: `grp-${groupIndex}`,
        name: voice.name,
        captions: voice.description,
      })
    }
  }
  return { groups, clips }
}

function everyCaption({ groups, clips }) {
  const all = []
  for (const subject of [...groups, ...clips]) {
    for (const [locale, text] of Object.entries(subject.captions)) {
      all.push({ subject: subject.id, name: subject.name, locale, text })
    }
  }
  return all
}

test('src/voices.json still holds the 3 groups and 12 clips this suite claims to have checked', () => {
  const catalogue = loadCatalogue()
  assert.equal(catalogue.groups.length, EXPECTED_GROUPS)
  assert.equal(catalogue.clips.length, EXPECTED_CLIPS)

  const captions = everyCaption(catalogue)
  assert.equal(
    captions.length,
    (EXPECTED_GROUPS + EXPECTED_CLIPS) * EXPECTED_LOCALES.length,
    'the loops below are only worth as much as the number of captions they run over',
  )
  for (const subject of [...catalogue.groups, ...catalogue.clips]) {
    assert.deepEqual(
      Object.keys(subject.captions).sort(),
      [...EXPECTED_LOCALES].sort(),
      `${subject.id} does not carry all three locales; a missing locale renders as a raw key path`,
    )
  }
})

test('every caption in src/voices.json passes validateCaption', () => {
  const captions = everyCaption(loadCatalogue())

  for (const caption of captions) {
    const verdict = validateCaption(caption.text)
    assert.equal(
      verdict.ok,
      true,
      `validateCaption refused a caption the site already publishes: ${caption.subject}/${caption.locale} = ${JSON.stringify(caption.text)} (reason: ${verdict.reason})`,
    )
  }

  const longest = Math.max(...captions.map((c) => [...c.text].length))
  assert.equal(longest, 54, 'the longest shipped caption is 54 code points; CAPTION_MAX_LENGTH is sized against it')
  assert.ok(
    longest <= CAPTION_MAX_LENGTH,
    `CAPTION_MAX_LENGTH (${CAPTION_MAX_LENGTH}) is now below the longest caption the owner has actually written (${longest})`,
  )
})

test('escapeForI18n leaves every shipped caption alone apart from trimming, so nothing on the site is being rewritten', () => {
  for (const caption of everyCaption(loadCatalogue())) {
    assert.equal(
      escapeForI18n(caption.text),
      caption.text.trim(),
      `escapeForI18n rewrote a shipped caption: ${caption.subject}/${caption.locale} = ${JSON.stringify(caption.text)} — today's catalogue contains no vue-i18n metacharacter, and if that changed this is where to find out`,
    )
  }
})

test('every caption in src/voices.json survives the CHECK on the column it is written to', (t) => {
  const db = openDatabase(t)
  const catalogue = loadCatalogue()

  for (const [index, group] of catalogue.groups.entries()) {
    db.prepare('INSERT INTO groups (id, display_name, sort_order, created_at) VALUES (?, ?, ?, ?)').run(
      group.id,
      group.name,
      index,
      T0,
    )
  }
  for (const [index, clip] of catalogue.clips.entries()) {
    const sha = String(index).padStart(64, '0')
    db.prepare(
      'INSERT INTO media (sha256, ext, content_type, bytes, duration_seconds, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(sha, 'mp3', 'audio/mpeg', 4096, 1.5, T0)
    db.prepare('INSERT INTO clips (id, group_id, media_sha256, label, created_at) VALUES (?, ?, ?, ?, ?)').run(
      clip.id,
      clip.groupId,
      sha,
      clip.name,
      T0,
    )
  }

  const insertGroupCaption = db.prepare(
    'INSERT INTO group_captions (group_id, locale, text, updated_at) VALUES (?, ?, ?, ?)',
  )
  const insertClipCaption = db.prepare(
    'INSERT INTO clip_captions (clip_id, locale, text, updated_at) VALUES (?, ?, ?, ?)',
  )

  for (const group of catalogue.groups) {
    for (const [locale, text] of Object.entries(group.captions)) {
      // The RAW form first, inside a savepoint: admin-authored translations
      // reach this column without necessarily passing through the gate, so the
      // column has to accept the untouched string too.
      assertAccepted(
        () => inSavepoint(db, () => insertGroupCaption.run(group.id, locale, text, T0)),
        `group_captions.text refused the RAW form of ${group.id}/${locale} = ${JSON.stringify(text)}`,
      )
      // Then the stored form, for real: escapeForI18n(raw) is the pipeline.
      assertAccepted(
        () => insertGroupCaption.run(group.id, locale, escapeForI18n(text), T0),
        `group_captions.text refused ${group.id}/${locale} = ${JSON.stringify(text)}`,
      )
    }
  }
  for (const clip of catalogue.clips) {
    for (const [locale, text] of Object.entries(clip.captions)) {
      assertAccepted(
        () => inSavepoint(db, () => insertClipCaption.run(clip.id, locale, text, T0)),
        `clip_captions.text refused the RAW form of ${clip.id}/${locale} = ${JSON.stringify(text)}`,
      )
      assertAccepted(
        () => insertClipCaption.run(clip.id, locale, escapeForI18n(text), T0),
        `clip_captions.text refused ${clip.id}/${locale} = ${JSON.stringify(text)}`,
      )
    }
  }

  assert.equal(db.prepare('SELECT count(*) AS n FROM group_captions').get().n, EXPECTED_GROUPS * 3)
  assert.equal(db.prepare('SELECT count(*) AS n FROM clip_captions').get().n, EXPECTED_CLIPS * 3)
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM v_missing_captions').get().n,
    0,
    'every subject/locale pair is filled, so nothing renders as a raw key path',
  )
})

test('the caption sweep can go red: a caption carrying a linked message is refused by the gate AND by the column', (t) => {
  const db = openDatabase(t)
  db.prepare('INSERT INTO groups (id, display_name, created_at) VALUES (?, ?, ?)').run('grp-0', 'Alpha', T0)

  // The loops above assert "accepted" 45 times. If the column accepted
  // everything, they would pass just the same — so here is the input that must
  // NOT get through, run against the same statement.
  const poisoned = 'shoutout to @:info.title'
  assert.equal(validateCaption(poisoned).reason, 'linked_message')
  assertRefused(
    () =>
      db
        .prepare('INSERT INTO group_captions (group_id, locale, text, updated_at) VALUES (?, ?, ?, ?)')
        .run('grp-0', 'en-US', poisoned, T0),
    /CHECK constraint failed/,
    'group_captions.text accepted a linked message.',
  )

  // And an unknown locale is a foreign key failure, not a caption row no page
  // will ever read.
  assertRefused(
    () =>
      db
        .prepare('INSERT INTO group_captions (group_id, locale, text, updated_at) VALUES (?, ?, ?, ?)')
        .run('grp-0', 'en_us', 'fine', T0),
    /FOREIGN KEY constraint failed/,
    'group_captions accepted a locale that is not in the controlled vocabulary.',
  )
})
