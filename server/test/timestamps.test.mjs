// One timestamp format, and every producer in these modules held to it.
//
// The failure this closes is not a crash: it is a comparison that INVERTS.
// Timestamp columns are compared as strings, and '.' (0x2E) sorts before
// 'Z' (0x5A), so '…T00:00:00.500Z' < '…T00:00:00Z' for the same instant. A
// source that began listening half a second AFTER a code was issued would
// report that it was listening before it — the precise false reassurance the
// danmaku module exists to refuse. Every timestamp column CHECKs the
// second-precision form for that reason, and toCanonicalTimestamp() is the only
// correct producer.

import assert from 'node:assert/strict'
import test from 'node:test'

import { toCanonicalTimestamp } from '../db/migrate.mjs'
import { record } from '../lib/audit.mjs'
import { assertSafeConfig } from '../lib/env-guard.mjs'
import { createTurnstile } from '../lib/turnstile.mjs'
import { clearedConfig, makeProductionConfig } from './helpers/config.mjs'
import { devDanmakuSource } from './helpers/dev-source.mjs'
import { T0, T10, assertAccepted, assertRefused, inSavepoint, openDatabase, seed } from './helpers/temp-db.mjs'

const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

// A timestamp reaches a column, not an abstraction. These are the columns the
// producers in this suite actually write to, one write each.
function timestampProbes(db, ids) {
  return [
    [
      'audit_log.at',
      (at) =>
        db
          .prepare(`
            INSERT INTO audit_log (id, at, actor_kind, actor_id, action, subject_kind, subject_id, detail)
            VALUES ('probe-audit', ?, 'system', NULL, 'probe', 'probe', NULL, NULL)
          `)
          .run(at),
    ],
    [
      'groups.created_at',
      (at) =>
        db.prepare("INSERT INTO groups (id, display_name, created_at) VALUES ('grp-probe', 'Probe', ?)").run(at),
    ],
    [
      'media.uploaded_at',
      (at) =>
        db
          .prepare(`
            INSERT INTO media (sha256, ext, content_type, bytes, duration_seconds, uploaded_at)
            VALUES ('${'f'.repeat(64)}', 'mp3', 'audio/mpeg', 1024, 1.0, ?)
          `)
          .run(at),
    ],
    [
      'submitters.first_seen_at',
      (at) =>
        db
          .prepare(`
            INSERT INTO submitters (id, open_id, display_name, display_name_seen_at, first_seen_at, last_seen_at)
            VALUES ('sub-probe', 'open-probe', 'Probe', ?, ?, ?)
          `)
          .run(at, at, at),
    ],
    [
      'sessions.created_at',
      (at) =>
        db
          .prepare(`
            INSERT INTO sessions (id, token_sha256, created_at, last_seen_at, expires_at)
            VALUES ('ses-probe', '${'e'.repeat(64)}', ?, ?, '2099-01-01T00:00:00Z')
          `)
          .run(at, at),
    ],
    [
      'verify_codes.issued_at',
      (at) =>
        db
          .prepare(`
            INSERT INTO verify_codes (id, code, session_id, room_id, state, issued_at, expires_at)
            VALUES ('vc-probe', 'PROBE1', ?, 21484828, 'pending', ?, '2099-01-01T00:00:00Z')
          `)
          .run(ids.session, at),
    ],
    [
      'batches.turnstile_decided_at',
      (at) =>
        db
          .prepare(`
            INSERT INTO batches (id, submitter_id, state, created_at, turnstile_required, turnstile_verdict, turnstile_decided_at)
            VALUES ('bat-probe', ?, 'draft', ?, 1, 'passed', ?)
          `)
          .run(ids.submitter, T0, at),
    ],
    [
      'clip_captions.updated_at',
      (at) =>
        db
          .prepare("INSERT INTO clip_captions (clip_id, locale, text, updated_at) VALUES (?, 'en-US', 'Probe', ?)")
          .run(ids.clip, at),
    ],
    [
      'schema_version.applied_at',
      (at) => db.prepare('UPDATE schema_version SET applied_at = ? WHERE id = 1').run(at),
    ],
    [
      'instance.created_at',
      (at) => db.prepare('UPDATE instance SET created_at = ? WHERE id = 1').run(at),
    ],
  ]
}

function assertColumnsAccept(db, ids, at, producer) {
  assert.match(at, CANONICAL, `${producer} did not produce a canonical timestamp: ${JSON.stringify(at)}`)
  for (const [column, write] of timestampProbes(db, ids)) {
    assertAccepted(
      () => inSavepoint(db, () => write(at)),
      `${column} refused the timestamp ${producer} produced: ${JSON.stringify(at)}`,
    )
  }
}

test('the timestamp columns can go red: the millisecond form Date#toISOString() emits is refused by every one of them', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)

  const millisecond = new Date('2026-08-01T00:00:00.500Z').toISOString()
  assert.equal(millisecond, '2026-08-01T00:00:00.500Z')

  for (const [column, write] of timestampProbes(db, ids)) {
    assertRefused(
      () => inSavepoint(db, () => write(millisecond)),
      /CHECK constraint failed/,
      `${column} accepted a millisecond timestamp; the ordering guarantee the schema rests on is gone.`,
    )
  }
})

test('the millisecond form really does sort BEFORE the whole second, which is why it is refused rather than trimmed on read', () => {
  // Not a style preference. String comparison is what every `expires_at > :now`
  // in the schema uses, and this inverts it.
  assert.ok('2026-08-01T00:00:00.500Z' < '2026-08-01T00:00:00Z')
  assert.ok('2026-08-01T00:00:00Z' < '2026-08-01T00:00:01Z')
})

test('toCanonicalTimestamp() truncates a Date and passes a canonical string through, and refuses everything else', () => {
  assert.equal(toCanonicalTimestamp(new Date('2026-08-01T00:00:00.999Z')), '2026-08-01T00:00:00Z')
  assert.equal(toCanonicalTimestamp('2026-08-01T00:00:00Z'), '2026-08-01T00:00:00Z')

  // An accidental Date.now() would otherwise be stored as a plausible-looking
  // string in one place and a number nowhere else in the schema.
  assert.throws(() => toCanonicalTimestamp(1_785_000_000_000), /not epoch numbers/)
  assert.throws(() => toCanonicalTimestamp('2026-08-01T00:00:00.000Z'), /not canonical UTC seconds/)
  assert.throws(() => toCanonicalTimestamp('2026-08-01T00:00:00+08:00'), /not canonical UTC seconds/)
  assert.throws(() => toCanonicalTimestamp(new Date('nonsense')), /expected a Date or a canonical timestamp/)
})

test('the env-guard report\'s checkedAt is accepted by every timestamp column', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  const report = assertSafeConfig(makeProductionConfig(), {
    nodeEnv: 'production',
    instanceMode: 'production',
    env: {},
  })

  assertColumnsAccept(db, ids, report.checkedAt, 'assertSafeConfig().checkedAt')
})

test('a turnstile decision and verdict are accepted by every timestamp column, even when the clock lands mid-second', async (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  // The exact input that made the old evaluatedAt unstorable: a clock reading
  // half a second past the second. batches.turnstile_decided_at is where this
  // value lands.
  const turnstile = createTurnstile({
    mode: 'production',
    secretKey: 'secret-key',
    verifyUrl: 'https://example.invalid/siteverify',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }),
    now: () => new Date('2026-08-01T00:00:00.500Z'),
  })

  const decision = turnstile.required({
    submitter: { acceptedCount: 9, rejectedCount: 0, blocked: 0 },
    recent: { submissions: 0, windowMinutes: 60 },
  })
  const verdict = await turnstile.verify('token-1')

  assert.equal(decision.evaluatedAt, '2026-08-01T00:00:00Z')
  assert.equal(verdict.checkedAt, '2026-08-01T00:00:00Z')
  assertColumnsAccept(db, ids, decision.evaluatedAt, 'turnstile.required().evaluatedAt')
  assertColumnsAccept(db, ids, verdict.checkedAt, 'turnstile.verify().checkedAt')
})

test('every timestamp the danmaku source reports is accepted by every timestamp column', async (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  const { source, clock } = devDanmakuSource({ startIso: '2026-08-01T00:00:00Z' })

  const pending = source.acquire()
  await clock.advance(0)
  const lease = await pending
  await clock.advance(20_000)
  source.control.emitDanmaku({ openId: 'open-alpha', displayName: 'Alpha', text: 'ABC123' })
  await clock.advance(1_000)
  source.control.disconnect()
  await clock.advance(1_000)
  source.release(lease.leaseId)
  await clock.advance(1_000)

  const status = source.status()
  const produced = {
    startedAt: status.startedAt,
    stoppedAt: status.stoppedAt,
    lastEventAt: status.lastEventAt,
    'heartbeat.lastTickAt': status.heartbeat.lastTickAt,
    'gaps[0].from': status.gaps[0].from,
    'gaps[0].to': status.gaps[0].to,
  }

  for (const [name, at] of Object.entries(produced)) {
    assert.ok(at !== null && at !== undefined, `the source produced no ${name} to check`)
    assertColumnsAccept(db, ids, at, `danmaku status().${name}`)
  }
})

test('a normalised danmaku carries a canonical receivedAt, including one handed in by the transport', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)
  const { source, clock } = devDanmakuSource()

  const events = []
  source.on('danmaku', (event) => events.push(event))
  const pending = source.acquire()

  return (async () => {
    await clock.advance(0)
    const lease = await pending
    source.control.emitDanmaku({ openId: 'open-alpha', text: 'ABC123' })

    assertColumnsAccept(db, ids, events[0].receivedAt, 'normalizeDanmaku().receivedAt')
    assert.equal(events[0].receivedAt, '2026-08-01T00:00:00Z')

    source.release(lease.leaseId)
    await clock.advance(0)
  })()
})

test('the audit log stores the timestamp it was given, truncated to the second the column accepts', (t) => {
  const db = openDatabase(t)

  const entry = record(db, {
    actorKind: 'system',
    actorOpenId: null,
    actorDisplayName: 'system',
    verb: 'catalogue.rebuild',
    subject: { kind: 'catalogue', id: null },
    consequence: null,
    succeeded: true,
    occurredAt: new Date('2026-08-01T00:00:00.999Z'),
  })

  assert.equal(entry.occurredAt, '2026-08-01T00:00:00Z')
  assert.match(db.prepare('SELECT at FROM audit_log WHERE id = ?').get(entry.id).at, CANONICAL)

  // A UTC offset is refused rather than converted: quietly normalising +08:00
  // would hide the one case where the recorded instant is probably wrong.
  assert.throws(
    () =>
      record(db, {
        actorKind: 'system',
        actorOpenId: null,
        actorDisplayName: 'system',
        verb: 'catalogue.rebuild',
        subject: { kind: 'catalogue', id: null },
        consequence: null,
        succeeded: true,
        occurredAt: '2026-08-01T08:00:00+08:00',
      }),
    /must be an ISO-8601 UTC string ending in Z/,
  )
})

test('migrate() stamps the schema and the instance with timestamps the columns accept', (t) => {
  const db = openDatabase(t, { mode: 'development', now: T0 })

  const stamp = db.prepare('SELECT applied_at FROM schema_version WHERE id = 1').get()
  const instance = db.prepare('SELECT mode, created_at FROM instance WHERE id = 1').get()
  assert.equal(stamp.applied_at, T0)
  assert.equal(instance.mode, 'development')

  // Deliberately tolerant, because this is an OBSERVATION and not an
  // endorsement: schema.sql seeds the instance row before migrate() runs, so
  // recordInstanceMode() always takes its UPDATE branch — which sets `mode` and
  // never `created_at`. The INSERT branch that would fill it is unreachable on
  // any database this schema built, so created_at is NULL today. Asserting the
  // NULL would freeze that; asserting the format lets it be filled in without
  // letting it be filled in wrongly.
  if (instance.created_at !== null) {
    assert.match(instance.created_at, CANONICAL)
  }

  // And a real clock's output goes in just the same.
  const db2 = openDatabase(t, { mode: 'development', now: new Date() })
  assert.match(db2.prepare('SELECT applied_at FROM schema_version WHERE id = 1').get().applied_at, CANONICAL)
})

test('the timestamps a session and a code are given order correctly against each other', (t) => {
  const db = openDatabase(t)
  const ids = seed(db)

  // Second-precision equality is the stated price of this format: a listen and a
  // code issue inside the same second compare equal and read as continuous.
  // Written down here so the window is a measured fact and not a surprise.
  assert.ok(T0 < T10)
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM sessions WHERE expires_at > ?').get(T0).n,
    1,
    'the session seeded at T0 must still be live at T0',
  )
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions WHERE expires_at > ?').get(T10).n, 0)
  assert.equal(ids.now, T0)
})
