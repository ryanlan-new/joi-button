// SPDX-License-Identifier: MIT
//
// What reaches catalog.json, and how it gets there.
//
// Two separate claims, and the second one is the reason this file spawns a
// process:
//
//   1. NOTHING in the published document carries vue-i18n syntax. The page folds
//      every string in it into the locale bundles and renders them through $t,
//      where "{x}" is an interpolation slot, "|" is a plural separator and
//      "@:key" is a READ OF SOMEBODY ELSE'S MESSAGE. The first two garble the
//      author's own sentence; the third splices in text they do not own.
//   2. The write is ATOMIC. The web pod mounts this directory read-only and is
//      serving catalog.json to somebody at the moment it is replaced, and a
//      partial JSON document is not a slightly-wrong page — it is a parse error
//      and a blank site.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { join } from 'node:path'
import test from 'node:test'

import { readSubmitterNote } from '../../routes/public.mjs'
import {
  OWNER,
  VISITOR,
  anItem,
  boot,
  captions,
  get,
  login,
  metadata,
  postForm,
  postJson,
  seedGroup,
  wav,
} from './harness.mjs'

/** The three constructs vue-i18n gives syntactic meaning to. */
const INTERPOLATION = /[{}]/
const PLURAL_SEPARATOR = /\|/
const LINKED_MESSAGE = /@(?:\.[A-Za-z]+)?:/

/** Every string in a JSON document, with the path it was found at. */
function* strings(value, path = '$') {
  if (typeof value === 'string') {
    yield [path, value]
    return
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* strings(item, `${path}[${index}]`)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) yield* strings(item, `${path}.${key}`)
  }
}

/** One submitted item, waiting for a decision, plus the owner's cookie. */
async function oneWaitingItem(t) {
  const ctx = await boot(t, { turnstileSwitch: 'off' })
  seedGroup(ctx.db, { id: 'voices-core', displayName: 'Core' })
  const owner = await login(ctx, OWNER)
  const visitor = await login(ctx, VISITOR)

  const submitted = await postForm(ctx.app, '/api/submit', {
    cookie: visitor,
    parts: [
      metadata([
        anItem({
          key: 'a',
          // Submitter text, on the way in. It is ESCAPED rather than refused:
          // braces and pipes are plausible prose and the damage is to the
          // submitter's own sentence.
          name: 'costs {price} — left|right',
          caption: { locale: 'zh-CN', text: '一半{x}一半|另一半' },
        }),
      ]),
      { name: 'file:a', filename: 'a.wav', value: wav({ seconds: 2 }) },
    ],
  })
  assert.equal(submitted.statusCode, 200, submitted.payload.slice(0, 300))

  const queue = (await get(ctx.app, '/api/admin/queue', { cookie: owner })).json()
  return { ...ctx, owner, visitor, itemId: queue.batches[0].items[0].itemId }
}

// ---------------------------------------------------------------------------
// escaping

test('a caption carrying a linked message is refused outright, and no clip is minted by the attempt', async (t) => {
  const { app, db, owner, itemId } = await oneWaitingItem(t)

  const refused = await postJson(app, `/api/admin/item/${itemId}`, {
    cookie: owner,
    body: {
      decision: 'approve',
      label: 'Ei',
      captions: { ...captions('Ei'), 'en-US': 'shoutout to @:info.title' },
      groupId: 'voices-core',
    },
  })

  assert.equal(refused.statusCode, 400, refused.payload)
  assert.equal(refused.json().error, 'invalid_text')
  // The reason, named: this is a read of a message the author does not own, and
  // "@.upper:info.title" would apply a modifier on top of it.
  assert.equal(refused.json().details.reason, 'linked_message')
  assert.equal(refused.json().details.field, 'captions.en-US')

  // Refused, not stored-then-cleaned: an approval is one transaction and this
  // one never opened.
  assert.equal(db.prepare('SELECT count(*) AS n FROM clips').get().n, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM clip_captions').get().n, 0)
  assert.equal(db.prepare('SELECT state FROM batch_items WHERE id = ?').get(itemId).state, 'pending')

  // The label is held to the same rule, and so is a group's visible name.
  const label = await postJson(app, `/api/admin/item/${itemId}`, {
    cookie: owner,
    body: { decision: 'approve', label: 'see @:info.title', captions: captions('Ei'), groupId: 'voices-core' },
  })
  assert.equal(label.statusCode, 400)
  assert.equal(label.json().details.field, 'label')

  const groupName = await postJson(app, `/api/admin/item/${itemId}`, {
    cookie: owner,
    body: {
      decision: 'approve',
      label: 'Ei',
      captions: captions('Ei'),
      newGroup: { id: 'sneaky', displayName: '@.upper:info.title', captions: captions('S') },
    },
  })
  assert.equal(groupName.statusCode, 400)
  assert.equal(groupName.json().details.field, 'newGroup.displayName')
  assert.equal(db.prepare('SELECT count(*) AS n FROM groups WHERE id = ?').get('sneaky').n, 0)
})

test('no string anywhere in catalog.json carries an interpolation slot, a plural separator or a linked message', async (t) => {
  const { app, db, owner, itemId, paths } = await oneWaitingItem(t)

  // Braces and pipes in the reviewer's own text, and in the name of a group they
  // are creating. Both are legitimate prose, so both are neutralised rather than
  // refused — vue-i18n 8 has no escape syntax at all, which is why the mechanism
  // is substitution of a look-alike code point.
  const approved = await postJson(app, `/api/admin/item/${itemId}`, {
    cookie: owner,
    body: {
      decision: 'approve',
      label: 'cost is {price}',
      captions: {
        'en-US': 'left|right',
        'zh-CN': '一半{x}一半',
        'ja-JP': '50%{price} off|now',
      },
      newGroup: {
        id: 'braces-and-pipes',
        displayName: 'A {group} | B',
        captions: { 'en-US': 'a {x} b', 'zh-CN': 'c|d', 'ja-JP': 'e {y} f' },
      },
    },
  })
  assert.equal(approved.statusCode, 200, approved.payload.slice(0, 400))

  // What LANDED is the escaped form. If escapeForI18n were dropped the column's
  // own CHECK would refuse the INSERT, so this goes red either way — as a
  // mismatch here, or as a 409 above.
  const clipId = approved.json().clipId
  assert.equal(db.prepare('SELECT label FROM clips WHERE id = ?').get(clipId).label, 'cost is ｛price｝')
  assert.equal(
    db.prepare("SELECT text FROM clip_captions WHERE clip_id = ? AND locale = 'en-US'").get(clipId).text,
    'left｜right',
  )
  // Substitution also rescues the '%' that vue-i18n's rails-syntax skip would
  // otherwise swallow in "50%{price}".
  assert.equal(
    db.prepare("SELECT text FROM clip_captions WHERE clip_id = ? AND locale = 'ja-JP'").get(clipId).text,
    '50%｛price｝ off｜now',
  )

  // The submitter's own text took the same route on the way in.
  const item = db.prepare('SELECT proposed_label, submitter_note FROM batch_items WHERE id = ?').get(itemId)
  assert.equal(item.proposed_label, 'costs ｛price｝ — left｜right')
  assert.equal(readSubmitterNote(item.submitter_note).caption.text, '一半｛x｝一半｜另一半')

  const published = await postJson(app, '/api/admin/publish', { cookie: owner })
  assert.equal(published.statusCode, 200, published.payload.slice(0, 400))

  const document = JSON.parse(readFileSync(paths.catalogFile, 'utf8'))
  // Every string, not a sample of them: the claim is about the document, and a
  // check that names three fields would miss the fourth one somebody adds.
  const seen = [...strings(document)]
  assert.ok(seen.length > 10, 'the sweep found almost nothing, so it is not sweeping the document')
  for (const [path, text] of seen) {
    assert.doesNotMatch(text, INTERPOLATION, `${path} carries an interpolation slot: ${JSON.stringify(text)}`)
    assert.doesNotMatch(text, PLURAL_SEPARATOR, `${path} carries a plural separator: ${JSON.stringify(text)}`)
    assert.doesNotMatch(text, LINKED_MESSAGE, `${path} carries a linked message: ${JSON.stringify(text)}`)
  }

  // …and the text is still THERE, escaped rather than deleted. A sweep that
  // passed because the captions were empty would prove nothing.
  const clip = document.clips.find((entry) => entry.id === clipId)
  assert.equal(clip.label, 'cost is ｛price｝')
  assert.equal(clip.captions['en-US'], 'left｜right')
  assert.equal(document.groups.find((group) => group.id === 'braces-and-pipes').displayName, 'A ｛group｝ ｜ B')
})

// ---------------------------------------------------------------------------
// atomicity

test('a reader holding the catalogue open across a publish still sees the whole previous document', async (t) => {
  const { app, owner, itemId, paths } = await oneWaitingItem(t)

  const approved = await postJson(app, `/api/admin/item/${itemId}`, {
    cookie: owner,
    body: { decision: 'approve', label: 'Take one', captions: captions('One'), groupId: 'voices-core' },
  })
  assert.equal(approved.statusCode, 200, approved.payload.slice(0, 300))
  assert.equal((await postJson(app, '/api/admin/publish', { cookie: owner })).statusCode, 200)

  const before = readFileSync(paths.catalogFile, 'utf8')
  // A reader that opened the file just before the swap — which is the web pod,
  // every time.
  const held = openSync(paths.catalogFile, 'r')
  t.after(() => {
    try {
      closeSync(held)
    } catch {
      /* already closed */
    }
  })
  const inodeBefore = fstatSync(held).ino

  await postJson(app, `/api/admin/item/${itemId}`, { cookie: owner, body: { label: 'Take two' } })
  const republished = await postJson(app, '/api/admin/publish', { cookie: owner })
  assert.equal(republished.json().catalog.catalogChanged, true, 'nothing was rewritten, so nothing was raced')

  // The held descriptor still points at the OLD inode, and that file is intact.
  // With open(…, 'w') the same descriptor would be looking at a file that was
  // truncated to zero and refilled — the reader would see a prefix, or the new
  // document, and the old one would be gone.
  const seenByTheHolder = readFileSync(held, 'utf8')
  assert.equal(seenByTheHolder, before, 'the file a reader had already opened was rewritten underneath them')
  JSON.parse(seenByTheHolder)

  const nowOnDisk = readFileSync(paths.catalogFile, 'utf8')
  assert.notEqual(nowOnDisk, before)
  assert.equal(JSON.parse(nowOnDisk).clips[0].label, 'Take two')
  assert.notEqual(statSync(paths.catalogFile).ino, inodeBefore, 'the document was rewritten in place')

  // The temp file lives in the target's own directory (rename is atomic only
  // within one filesystem) and must not survive the swap.
  assert.deepEqual(
    readdirSync(paths.dataDir).filter((name) => name.startsWith('.catalog-tmp-')),
    [],
    'a temp catalogue was left on the shared directory',
  )
  closeSync(held)
})

test('a reader racing sixty publishes never observes a document that was not published whole', async (t) => {
  const { app, owner, itemId, paths } = await oneWaitingItem(t)

  const approved = await postJson(app, `/api/admin/item/${itemId}`, {
    cookie: owner,
    body: { decision: 'approve', label: 'Take zero', captions: captions('Zero'), groupId: 'voices-core' },
  })
  assert.equal(approved.statusCode, 200, approved.payload.slice(0, 300))
  const first = await postJson(app, '/api/admin/publish', { cookie: owner })
  assert.equal(first.statusCode, 200)

  // A separate PROCESS, because the write is synchronous: a reader on this
  // thread cannot observe an intermediate state that only exists between two
  // syscalls, so a same-thread test would pass against writeFileSync too.
  const readerSource = `
    const { existsSync, readFileSync, writeFileSync } = require('node:fs')
    const { createHash } = require('node:crypto')
    const [file, stopFile, readyFile] = process.argv.slice(1)
    let reads = 0
    let invalid = 0
    const seen = new Set()
    writeFileSync(readyFile, '')
    const deadline = Date.now() + 30000
    while (!existsSync(stopFile) && Date.now() < deadline) {
      for (let i = 0; i < 40; i += 1) {
        let text
        try {
          text = readFileSync(file, 'utf8')
        } catch (error) {
          if (error.code !== 'ENOENT') invalid += 1
          continue
        }
        reads += 1
        try {
          const document = JSON.parse(text)
          if (!Array.isArray(document.clips)) { invalid += 1; continue }
        } catch {
          invalid += 1
          continue
        }
        seen.add(createHash('sha256').update(text, 'utf8').digest('hex'))
      }
    }
    process.stdout.write(JSON.stringify({ reads, invalid, distinct: [...seen] }))
  `

  const stopFile = join(paths.dataDir, 'reader-stop')
  const readyFile = join(paths.dataDir, 'reader-ready')
  const reader = spawn(process.execPath, ['-e', readerSource, paths.catalogFile, stopFile, readyFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => reader.kill('SIGKILL'))
  let out = ''
  let err = ''
  reader.stdout.on('data', (chunk) => {
    out += chunk
  })
  reader.stderr.on('data', (chunk) => {
    err += chunk
  })

  // Start publishing only once the reader is actually reading, so the overlap is
  // arranged rather than hoped for.
  for (let waited = 0; !existsSync(readyFile) && waited < 5000; waited += 10) await sleep(10)
  assert.ok(existsSync(readyFile), 'the reader process never started')

  const publishedShas = new Set([first.json().catalog.catalogSha256])
  for (let take = 1; take <= 60; take += 1) {
    await postJson(app, `/api/admin/item/${itemId}`, { cookie: owner, body: { label: `Take ${take}` } })
    const answer = await postJson(app, '/api/admin/publish', { cookie: owner })
    assert.equal(answer.statusCode, 200, answer.payload.slice(0, 200))
    publishedShas.add(answer.json().catalog.catalogSha256)
  }
  writeFileSync(stopFile, '')

  const exitCode = await new Promise((resolve) => reader.on('close', resolve))
  assert.equal(exitCode, 0, `the reader process failed: ${err}`)
  const report = JSON.parse(out)

  assert.equal(report.invalid, 0, `${report.invalid} of ${report.reads} reads saw a document that would not parse`)
  // Every snapshot the reader ever held was a document this server published
  // whole — not a prefix of one, not a mixture of two.
  for (const sha of report.distinct) {
    assert.ok(
      publishedShas.has(sha),
      'the reader observed bytes that were never a complete published catalogue',
    )
  }
  // The vacuity guard: without it this passes against a reader that saw one
  // unchanging file and never raced anything at all.
  assert.ok(
    report.distinct.length >= 2,
    `the reader saw only ${report.distinct.length} distinct document(s) across ${report.reads} reads, so no swap was observed`,
  )
  assert.equal(publishedShas.size, 61)
})
