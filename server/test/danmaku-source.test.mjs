// The on-demand room session: reference counting, the start race, and the
// verdict a waiting visitor is allowed to be told.
//
// Every case here needs the programmable double to be slow, to fail, to hang or
// to drop. A double that is ready instantly and never drops makes two of the
// real implementation's guards vacuously true — "the code must not be shown
// before the socket is listening" cannot fail against a source that is
// listening before you finish asking, and "never tell a visitor who did
// everything right that they are probably muted" cannot fail against a source
// that never disconnects.
//
// The clock is injected for the same reason: without it "the start that never
// becomes ready" costs ten real seconds and gets skipped.

import assert from 'node:assert/strict'
import test from 'node:test'

import { toCanonicalTimestamp } from '../db/migrate.mjs'
import { VISITOR_VERDICTS, createDanmakuSource, normalizeDanmaku } from '../lib/danmaku-source.mjs'
import { settledState } from './helpers/clock.mjs'
import { collect, devDanmakuSource } from './helpers/dev-source.mjs'

/** Start a session and let the transport become ready. */
async function listening(source, clock, ms = 0) {
  const pending = source.acquire()
  await clock.advance(ms)
  return pending
}

// ---------------------------------------------------------------------------
// Reference counting

test('acquire() does not resolve until the transport is listening, so the code is never shown to a visitor we cannot hear', async () => {
  const { source, clock } = devDanmakuSource({ development: { startLatencyMs: 50 } })

  const pending = source.acquire()
  await clock.tick()
  assert.equal(source.status().state, 'starting')
  assert.equal(source.status().visitor.verdict, VISITOR_VERDICTS.STARTING)
  assert.equal(await settledState(pending), 'pending', 'acquire() resolved before the socket was listening')

  await clock.advance(49)
  assert.equal(await settledState(pending), 'pending', 'acquire() resolved one millisecond early')

  await clock.advance(1)
  const lease = await pending
  assert.equal(source.status().state, 'listening')
  assert.equal(lease.status.listening, true)
  assert.equal(source.control.isListening(), true)
})

test('two waiters arriving at once open ONE socket', async () => {
  const { source, clock } = devDanmakuSource({ development: { startLatencyMs: 10 } })

  const first = source.acquire()
  const second = source.acquire()
  await clock.advance(10)
  await Promise.all([first, second])

  assert.equal(source.control.startCount(), 1, 'the in-flight start was not deduplicated')
  assert.equal(source.status().waiters, 2)
})

test('a release by the first waiter does not tear the session down under the second', async () => {
  const { source, clock } = devDanmakuSource()
  const first = await listening(source, clock)
  const second = await source.acquire()

  assert.equal(source.release(first.leaseId), true)
  await clock.advance(0)

  assert.equal(source.status().state, 'listening', 'the session closed while a second visitor was still waiting')
  assert.equal(source.status().waiters, 1)
  assert.equal(source.control.stopCount(), 0)
  assert.equal(source.control.isListening(), true)

  assert.equal(source.release(second.leaseId), true)
  await clock.advance(0)
  assert.equal(source.status().state, 'stopped')
  assert.equal(source.control.stopCount(), 1)
})

test('a double release is a no-op, because a refcount that trusts its callers will be released twice', async () => {
  const { source, clock } = devDanmakuSource()
  const first = await listening(source, clock)
  const second = await source.acquire()

  assert.equal(source.release(first.leaseId), true)
  assert.equal(source.release(first.leaseId), false, 'the second release of one lease was counted')
  assert.equal(source.release('a-lease-that-was-never-issued'), false)
  await clock.advance(0)

  assert.equal(source.status().state, 'listening', 'a repeated release tore down a live session')
  assert.equal(source.status().waiters, 1)
  assert.equal(source.control.leaseCount(), 1)

  source.release(second.leaseId)
  await clock.advance(0)
  assert.equal(source.status().state, 'stopped')
})

test('stop() refuses while a waiter holds a lease, which is the failure the reference count exists to prevent', async () => {
  const { source, clock } = devDanmakuSource()
  const lease = await listening(source, clock)

  await assert.rejects(source.stop(), /refusing to stop while 1 waiter\(s\) hold a lease/)
  assert.equal(source.status().state, 'listening')

  source.release(lease.leaseId)
  await clock.advance(0)
})

test('a lease nobody releases expires with the code, so a waiter that went away cannot pin the socket open', async () => {
  const { source, clock } = devDanmakuSource()
  await listening(source, clock)
  assert.equal(source.status().waiters, 1)

  // The ruled ceiling: a code, and the room session it holds open, expire after
  // ten minutes.
  await clock.advance(10 * 60_000)

  assert.equal(source.status().waiters, 0)
  assert.equal(source.status().state, 'stopped')
  assert.equal(source.control.stopCount(), 1)
})

// ---------------------------------------------------------------------------
// The start race

test('a stop during an in-flight start settles acquire() at once rather than parking it for the whole start timeout', async () => {
  const { source, clock } = devDanmakuSource({ development: { startBehaviour: 'hang' } })
  const startedAtMs = clock.nowMs()

  const pending = source.acquire()
  await clock.advance(0)
  assert.equal(source.status().state, 'starting')
  assert.equal(await settledState(pending), 'pending')

  await source.stop({ force: true })

  // No clock advance between the stop and this line. Without the startAbort()
  // call in stop(), `pending` stays parked until the full startTimeoutMs and
  // this reads 'pending' — a waiter blocked on a session that was torn down
  // before the wait began.
  assert.equal(await settledState(pending), 'rejected', 'acquire() was left waiting on a session that no longer exists')
  await assert.rejects(pending, /the start was cancelled by a stop/)
  assert.ok(
    clock.nowMs() - startedAtMs < 10_000,
    'the waiter was only released by the start timeout, which is the defect and not the fix',
  )
  assert.equal(source.status().state, 'stopped')
  assert.equal(source.status().waiters, 0)
})

test('a stop that loses a generation race does not re-mark a cleanly stopped source as failed', async () => {
  const { source, clock } = devDanmakuSource({ development: { startBehaviour: 'fail' } })

  // The rejection handler is attached BEFORE the clock moves. Time only passes
  // inside advance(), so a handler attached afterwards arrives a full turn late
  // and the rejection is reported as unhandled instead of as this assertion.
  const failed = source.acquire()
  const rejected = assert.rejects(failed, /simulated start failure/)
  await clock.advance(0)
  await rejected
  await clock.tick()
  assert.equal(source.status().state, 'failed')

  // Two stops in flight at once, the FIRST of which settles LAST. Its finally
  // captured cameFromFailure = true, so without the `gen === generation` guard
  // it lands after the second stop has already recorded a clean shutdown and
  // overwrites it — our side blamed for a teardown that worked.
  source.control.setStopLatencyMs(10)
  const slow = source.stop()
  source.control.setStopLatencyMs(1)
  const quick = source.stop()

  await clock.advance(20)
  await Promise.all([slow, quick])

  assert.equal(source.status().state, 'stopped')
  assert.equal(source.status().visitor.verdict, VISITOR_VERDICTS.NOT_LISTENING)
})

test('a start that fails is reported as ours, with the transport error kept', async () => {
  const { source, clock } = devDanmakuSource({
    development: { startBehaviour: 'fail', startFailureMessage: 'room 21484828 refused the app session' },
  })

  const pending = source.acquire()
  const rejected = assert.rejects(pending, /room 21484828 refused the app session/)
  await clock.advance(0)
  await rejected
  await clock.tick()

  const status = source.status({ since: toCanonicalTimestamp(clock.now()) })
  assert.equal(status.visitor.verdict, VISITOR_VERDICTS.FAILED)
  assert.equal(
    status.visitor.canAssertNotSeen,
    false,
    'a source that never started must never license "we would have seen it"',
  )
  assert.match(status.lastError.message, /refused the app session/)
  assert.equal(source.control.leaseCount(), 0, 'a failed start left a lease behind, so the count never returns to zero')
})

test('a start that never becomes ready times out on the injected clock, not on a real ten seconds', async () => {
  const { source, clock } = devDanmakuSource({ development: { startBehaviour: 'hang' } })

  const pending = source.acquire()
  await clock.advance(0)
  assert.equal(await settledState(pending), 'pending')

  await clock.advance(10_000)
  await assert.rejects(pending, /the transport did not become ready within 10000ms/)
  assert.equal(source.status().state, 'failed')
})

// ---------------------------------------------------------------------------
// What a waiting visitor is told

test('status() tells "we are not listening" apart from "you have not sent it yet"', async () => {
  const { source, clock } = devDanmakuSource()
  const since = toCanonicalTimestamp(clock.now())

  const idle = source.status({ since })
  assert.equal(idle.visitor.verdict, VISITOR_VERDICTS.NOT_LISTENING)
  assert.equal(idle.visitor.canAssertNotSeen, false)
  assert.equal(idle.listeningSince, null)

  const lease = await listening(source, clock)
  const live = source.status({ since })
  assert.equal(live.visitor.verdict, VISITOR_VERDICTS.LISTENING_NO_MATCH)
  assert.equal(live.visitor.canAssertNotSeen, true, 'only uninterrupted listening licenses "we would have seen it"')
  assert.equal(source.status().visitor.verdict, VISITOR_VERDICTS.LISTENING, 'with no code issued there is nothing to miss')

  assert.notEqual(VISITOR_VERDICTS.NOT_LISTENING, VISITOR_VERDICTS.LISTENING_NO_MATCH)

  source.release(lease.leaseId)
  await clock.advance(0)
  const after = source.status({ since })
  assert.equal(after.visitor.verdict, VISITOR_VERDICTS.NOT_LISTENING)
  assert.equal(
    after.listeningSince,
    null,
    'the marker is never cleared, so status() must hide it rather than claim a "listening since" for a stopped source',
  )
})

test('a drop while the visitor is waiting downgrades the verdict instead of blaming them for our disconnect', async () => {
  const { source, clock } = devDanmakuSource()
  const since = toCanonicalTimestamp(clock.now())
  const lease = await listening(source, clock)

  assert.equal(source.status({ since }).visitor.verdict, VISITOR_VERDICTS.LISTENING_NO_MATCH)

  await clock.advance(2_000)
  source.control.disconnect({ reason: 'simulated-disconnect' })

  const dropped = source.status({ since })
  assert.equal(dropped.state, 'reconnecting', 'a drop with a waiter still holding a lease must reconnect')
  assert.equal(dropped.visitor.verdict, VISITOR_VERDICTS.RECONNECTING)
  assert.equal(dropped.visitor.canAssertNotSeen, false)

  await clock.advance(1_000)

  const recovered = source.status({ since })
  assert.equal(recovered.state, 'listening')
  assert.equal(
    recovered.listeningSince,
    '2026-08-01T00:00:03Z',
    'listeningSince is written on EVERY ready, which is what makes the downgrade arithmetic rather than memory',
  )
  assert.equal(recovered.visitor.verdict, VISITOR_VERDICTS.LISTENING_AFTER_GAP)
  assert.equal(
    recovered.visitor.canAssertNotSeen,
    false,
    'a recovered source claimed it would have seen a danmaku sent during the gap',
  )
  assert.deepEqual(
    recovered.gaps.map((gap) => [gap.reason, gap.from, gap.to]),
    [
      ['never-started', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'],
      ['simulated-disconnect', '2026-08-01T00:00:02Z', '2026-08-01T00:00:03Z'],
    ],
    'the gap is recorded with the reason the transport gave, not with the lifecycle default',
  )

  source.release(lease.leaseId)
  await clock.advance(0)
})

test('a disconnect with nobody waiting is a stop, not a reconnect loop', async () => {
  const { source, clock } = devDanmakuSource()

  const started = source.start()
  await clock.advance(0)
  await started
  assert.equal(source.status().state, 'listening')
  assert.equal(source.status().waiters, 0)

  source.control.disconnect()
  assert.equal(source.status().state, 'stopped')

  await clock.advance(60_000)
  assert.equal(source.control.startCount(), 1, 'the source kept retrying with nobody waiting for it')
})

// ---------------------------------------------------------------------------
// The heartbeat

test('a clean stop stops the heartbeat too, not only the socket', async () => {
  const { source, clock } = devDanmakuSource()
  const lease = await listening(source, clock)

  await clock.advance(60_000)
  assert.equal(source.status().heartbeat.ticks, 3, 'the heartbeat did not run on the interval it reports')
  assert.equal(source.status().heartbeat.errors, 0)
  assert.equal(source.control.transportHeartbeatCount(), 3)

  source.release(lease.leaseId)
  await clock.advance(0)
  const ticksAtStop = source.status().heartbeat.ticks
  assert.equal(source.status().heartbeat.running, false)

  await clock.advance(200_000)
  // `ticks` and not `errors` or the transport's count: ticks are counted BEFORE
  // the call and counted even when it throws, so a leaked interval whose work
  // fails every time is still visible here. A success counter would have stayed
  // put through exactly the bug this asserts against.
  assert.equal(source.status().heartbeat.ticks, ticksAtStop, 'the heartbeat timer outlived the session')
})

// ---------------------------------------------------------------------------
// Fidelity of the double

test('the double refuses to deliver a danmaku once the source has stopped, because the real transport could not either', async () => {
  const { source, clock } = devDanmakuSource()
  const events = collect(source, 'danmaku')
  const lease = await listening(source, clock)

  source.control.emitDanmaku({ openId: 'open-alpha', displayName: 'Alpha', text: 'ABC123' })
  assert.equal(events.length, 1)
  assert.equal(events[0].text, 'ABC123')

  source.release(lease.leaseId)
  await clock.advance(0)
  assert.equal(source.status().state, 'stopped')

  // AFTER a stop, not merely before the first start: before the first start
  // there is no callback to call, so a test that only checked that path would
  // pass with the listening check deleted.
  assert.throws(
    () => source.control.emitDanmaku({ openId: 'open-alpha', text: 'ABC123' }),
    /refusing to emit a danmaku while not listening/,
  )
  assert.equal(events.length, 1)
})

test('a malformed frame is counted and routed to error listeners without stopping the session', async () => {
  const { source, clock } = devDanmakuSource()
  const errors = collect(source, 'error')
  const events = collect(source, 'danmaku')
  const lease = await listening(source, clock)

  source.control.emitDanmaku({ openId: '', text: 'ABC123' })
  source.control.emitDanmaku({ openId: 'open-alpha', text: 'x'.repeat(513) })
  source.control.emitDanmaku({ openId: 'open-alpha', text: 'ABC123' })

  assert.equal(source.status().events.malformed, 2)
  assert.equal(source.status().events.received, 1)
  assert.equal(events.length, 1)
  assert.equal(source.status().state, 'listening', 'one bad frame from upstream stopped the session')
  assert.match(errors[0].message, /open_id is missing or empty/)
  assert.match(errors[1].message, /text exceeds 512 characters/)

  source.release(lease.leaseId)
  await clock.advance(0)
})

test('normalizeDanmaku accepts the Open Platform wire names as well as the normalised ones', () => {
  const wire = normalizeDanmaku({ open_id: 'open-alpha', uname: 'Alpha', msg: 'ABC123' })
  const normalised = normalizeDanmaku({ openId: 'open-alpha', displayName: 'Alpha', text: 'ABC123' })

  assert.equal(wire.openId, normalised.openId)
  assert.equal(wire.displayName, normalised.displayName)
  assert.equal(wire.text, normalised.text)
  assert.notEqual(wire.id, normalised.id, 'each event carries its own id')
})

test('normalizeDanmaku refuses a frame that could push an unbounded string into the caller\'s matcher', () => {
  assert.throws(() => normalizeDanmaku(null), /expected an object/)
  assert.throws(() => normalizeDanmaku({ text: 'ABC' }), /open_id is missing or empty/)
  assert.throws(() => normalizeDanmaku({ openId: 'a'.repeat(129), text: 'ABC' }), /open_id exceeds 128 characters/)
  assert.throws(() => normalizeDanmaku({ openId: 'open-alpha' }), /text is missing or not a string/)
  assert.throws(
    () => normalizeDanmaku({ openId: 'open-alpha', displayName: 42, text: 'ABC' }),
    /display name is not a string/,
  )
})

// ---------------------------------------------------------------------------
// Which implementation you can get

test('the production transport is not implemented and says so at construction, not at the first visitor', () => {
  assert.throws(
    () => createDanmakuSource({ mode: 'production' }),
    /the production Bilibili Open Platform transport is not implemented/,
  )
})

test('a source must name its mode, and neither implementation is the default', () => {
  assert.throws(() => createDanmakuSource({}), /config\.mode must be "production" or "development"/)
  assert.throws(() => createDanmakuSource({ mode: 'dev' }), /config\.mode must be "production" or "development"/)
})

test('the programmable surface is frozen onto the source, so nothing downstream can bolt one on later', () => {
  const { source } = devDanmakuSource()

  assert.ok(Object.isFrozen(source))
  assert.ok(Object.isFrozen(source.control))
  assert.throws(() => {
    source.control = { emitDanmaku() {} }
  }, TypeError)
  // There is no production source to check the other half against: today
  // createDanmakuSource({ mode: 'production' }) throws before one exists, which
  // is the stronger statement and the one asserted above.
  assert.equal(source.mode, 'development')
})
