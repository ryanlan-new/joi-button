// Text that reaches vue-i18n 8.21.1, and the two halves that keep it safe.
//
// submitters.display_name used to be exempt from the caption rules, on the
// reasoning that refusing a nickname would break identity verification for a
// user whose name contains '|'. The hole in that: the name is rendered into a
// credit line through vue-i18n, so a nickname of '@:info.notOfficial' reads a
// different message into the page.
//
// Both halves are the remedy and they are not alternatives — the danmaku source
// SUBSTITUTES (so the nickname still verifies) and the column REFUSES the raw
// form (for the day that stops happening). This file tests both, and tests that
// the column's refusal is narrow enough not to refuse ordinary prose.

import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeDanmaku } from '../lib/danmaku-source.mjs'
import { escapeForI18n, validateCaption } from '../lib/text-safety.mjs'
import { T0, assertAccepted, assertRefused, inSavepoint, openDatabase, seed } from './helpers/temp-db.mjs'
import { collect, devDanmakuSource } from './helpers/dev-source.mjs'

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

// Every construct vue-i18n gives syntactic meaning, plus the modifier ladder at
// both ends of the range the schema spells out.
const REFUSED_NAMES = [
  ['a named interpolation slot', 'cost is {price}'],
  ['a stray closing brace', 'Joi} the streamer'],
  ['a plural separator', '100% | done'],
  ['a bare linked message', '@:info.title'],
  ['a linked message mid-string', 'shoutout to @:info.title !'],
  ['a modified linked message', '@.upper:info.title'],
  ['the longest modifier vue-i18n defines', '@.capitalize:info.title'],
  ['a twelve-letter modifier, the stated ceiling of the ladder', '@.abcdefghijkl:info.title'],
]

// Prose that LOOKS like the constructs above and is not. The single pattern
// '*@.[a-zA-Z]*:*' reads like the same rule and is not — its '*' spans the rest
// of the string, so any '@.' plus any later ':' matches. It refused the first
// entry here, which passes validateCaption and which escapeForI18n returns
// byte-identical: an outage, not a guard.
const ACCEPTED_NAMES = [
  ['an address followed by a clock time', 'Joi@.jp 11:00 開始'],
  ['a bare "@." that begins no modifier', 'Joi@.com'],
  ['an ordinary mention', 'thanks @Joi'],
  ['an email address', 'a@b.com'],
  ['a colon with no @ anywhere', '11:00 開始'],
]

function insertName(db, name, id = 'sub-under-test') {
  db.prepare(`
    INSERT INTO submitters (id, open_id, display_name, display_name_seen_at, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, `open-${id}`, name, T0, T0, T0)
}

test('submitters.display_name refuses every vue-i18n construct, exactly as the caption columns do', (t) => {
  const db = openDatabase(t)
  seed(db)

  for (const [what, name] of REFUSED_NAMES) {
    assertRefused(
      () => inSavepoint(db, () => insertName(db, name)),
      /CHECK constraint failed/,
      `submitters.display_name accepted ${what}: ${JSON.stringify(name)}`,
    )
  }
})

test('submitters.display_name accepts prose that only looks like a linked message', (t) => {
  const db = openDatabase(t)
  seed(db)

  for (const [what, name] of ACCEPTED_NAMES) {
    assertAccepted(
      () => inSavepoint(db, () => insertName(db, name)),
      `submitters.display_name refused ${what}: ${JSON.stringify(name)} — a backstop that refuses ordinary prose is an outage, not a guard.`,
    )
    assert.equal(
      validateCaption(name).ok,
      true,
      `validateCaption refused ${JSON.stringify(name)}; the column and the gate must agree about this one`,
    )
    assert.equal(
      escapeForI18n(name),
      name,
      `escapeForI18n rewrote ${JSON.stringify(name)}; the backstop is calibrated to accept exactly what the sanitiser emits`,
    )
  }
})

test('the modifier ladder stops at twelve letters, and validateCaption is the unbounded check that does not', (t) => {
  const db = openDatabase(t)
  seed(db)

  const thirteen = '@.abcdefghijklm:info.title'
  // Stated ceiling, not a proof. An UNREGISTERED modifier still links, so this
  // really would render as a linked message — the column lets it through and
  // the gate on the way in is what catches it. Written down here so the limit
  // is a measured fact rather than an implication.
  assertAccepted(
    () => inSavepoint(db, () => insertName(db, thirteen)),
    'the ladder claims to stop at twelve letters; this asserts where it actually stops.',
  )
  assert.equal(validateCaption(thirteen).ok, false)
  assert.equal(validateCaption(thirteen).reason, 'linked_message')
  assert.equal(escapeForI18n(thirteen), '＠.abcdefghijklm:info.title')

  // And the escaped form of that same name is what the column would store.
  assertAccepted(
    () => inSavepoint(db, () => insertName(db, escapeForI18n(thirteen))),
    'the escaped form of a 13-letter modifier must still be storable.',
  )
})

test('the escaped form of a hostile nickname is accepted, so escaping keeps identity verification working', (t) => {
  const db = openDatabase(t)
  seed(db)

  for (const [, name] of REFUSED_NAMES) {
    const stored = escapeForI18n(name)
    assertAccepted(
      () => inSavepoint(db, () => insertName(db, stored)),
      `escapeForI18n(${JSON.stringify(name)}) produced ${JSON.stringify(stored)}, which the column refuses — the sanitiser and the backstop have drifted apart.`,
    )
  }
})

test('normalizeDanmaku escapes an observed nickname of @:info.title before it can reach the column', (t) => {
  const db = openDatabase(t)
  seed(db)

  const event = normalizeDanmaku({ open_id: 'open-hostile', uname: '@:info.title', msg: 'ABC123' })

  assert.equal(event.displayName, '＠:info.title')
  assert.ok(!event.displayName.includes('@:'), 'the ASCII trigger must be gone')
  assert.equal(event.text, 'ABC123', 'the message text is handed over verbatim, or the code would not match')

  assertAccepted(
    () => insertName(db, event.displayName, 'sub-hostile'),
    'the escaped nickname was refused by the column.',
  )
  assertRefused(
    () => inSavepoint(db, () => insertName(db, '@:info.title', 'sub-raw')),
    /CHECK constraint failed/,
    'the RAW nickname must be refused — that is what makes the escaping above load-bearing.',
  )
})

test('a live development source escapes the nickname on its way out of the room', async (t) => {
  const db = openDatabase(t)
  seed(db)
  const { source, clock } = devDanmakuSource()
  t.after(() => source.stop({ force: true }))

  const events = collect(source, 'danmaku')
  // The clock is hand-driven, so the transport's start timer only fires when
  // this advances it; acquire() cannot resolve before then, which is the point.
  const pending = source.acquire()
  await clock.advance(0)
  const lease = await pending

  source.control.emitDanmaku({ openId: 'open-hostile', displayName: '@:info.title', text: 'ABC123' })

  assert.equal(events.length, 1)
  assert.equal(events[0].displayName, '＠:info.title')
  assertAccepted(
    () => insertName(db, events[0].displayName, 'sub-from-room'),
    'a nickname delivered by the source was refused by the column it is written to.',
  )

  source.release(lease.leaseId)
  await clock.advance(0)
})

test('a nickname longer than the column is truncated by CODE POINTS, and never emits a lone surrogate', (t) => {
  const db = openDatabase(t)
  seed(db)

  // 131 code points of astral plane. String#slice(0, 120) counts UTF-16 units
  // and would cut the 60th surrogate pair in half; the half that survives
  // becomes U+FFFD when the row is encoded as UTF-8, corrupting the name rather
  // than shortening it.
  const astral = `a${'\u{1D4A5}'.repeat(130)}`
  const event = normalizeDanmaku({ open_id: 'open-long', uname: astral, msg: 'ABC123' })

  assert.equal([...event.displayName].length, 120)
  assert.ok(!LONE_SURROGATE.test(event.displayName), 'truncation cut a surrogate pair in half')
  assertAccepted(
    () => insertName(db, event.displayName, 'sub-astral'),
    'the truncated astral nickname was refused by the column.',
  )
})

test('a 121-character nickname fails the column raw and fits once the source has truncated it', (t) => {
  const db = openDatabase(t)
  seed(db)

  const raw = '名'.repeat(121)
  assertRefused(
    () => inSavepoint(db, () => insertName(db, raw, 'sub-raw-long')),
    /CHECK constraint failed/,
    'the column claims to cap display_name at 120 characters.',
  )

  const event = normalizeDanmaku({ open_id: 'open-121', uname: raw, msg: 'ABC123' })
  assert.equal([...event.displayName].length, 120)
  assertAccepted(
    () => insertName(db, event.displayName, 'sub-trunc-long'),
    'a limit looser than the column\'s is not a limit, it is a deferral.',
  )
})

test('no text column is exempt: every column that reaches vue-i18n refuses a linked message', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  const hostile = '@:info.title'

  const writes = [
    [
      'groups.display_name',
      () =>
        db
          .prepare('INSERT INTO groups (id, display_name, created_at) VALUES (?, ?, ?)')
          .run('grp-hostile', hostile, T0),
    ],
    [
      'group_captions.text',
      () =>
        db
          .prepare('INSERT INTO group_captions (group_id, locale, text, updated_at) VALUES (?, ?, ?, ?)')
          .run(ids.group, 'en-US', hostile, T0),
    ],
    [
      'clips.label',
      () =>
        db
          .prepare('INSERT INTO clips (id, group_id, media_sha256, label, created_at) VALUES (?, ?, ?, ?, ?)')
          .run('clip-hostile', ids.group, ids.media2, hostile, T0),
    ],
    [
      'clip_captions.text',
      () =>
        db
          .prepare('INSERT INTO clip_captions (clip_id, locale, text, updated_at) VALUES (?, ?, ?, ?)')
          .run(ids.clip, 'en-US', hostile, T0),
    ],
    [
      'batch_items.proposed_label',
      () =>
        db
          .prepare(`
            INSERT INTO batch_items (id, batch_id, position, media_sha256, proposed_label, created_at)
            VALUES ('item-hostile', ?, 1, ?, ?, ?)
          `)
          .run(ids.batch, ids.media2, hostile, T0),
    ],
  ]

  for (const [column, write] of writes) {
    assertRefused(
      () => inSavepoint(db, write),
      /CHECK constraint failed/,
      `${column} accepted a linked message.`,
    )
  }
})

test('a caption is a single line: a newline is refused by the caption columns and by the gate', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)

  assertRefused(
    () =>
      inSavepoint(db, () =>
        db
          .prepare('INSERT INTO clip_captions (clip_id, locale, text, updated_at) VALUES (?, ?, ?, ?)')
          .run(ids.clip, 'en-US', 'first\nsecond', T0),
      ),
    /CHECK constraint failed/,
    'clip_captions.text accepted an interior newline.',
  )
  assert.equal(validateCaption('first\nsecond').reason, 'control_character')
  assert.equal(escapeForI18n('first\nsecond'), 'firstsecond')
})
