// A clock the test drives by hand.
//
// danmaku-source.mjs takes its timers through config.clock for one reason it
// states outright: "the start that never becomes ready" would otherwise cost a
// real ten seconds and get skipped. Every knob the module exposes for tests
// (start latency, stop latency, the start timeout) is only observable if time
// can be advanced deliberately, so this is not a convenience — the guards those
// knobs exist for are unfalsifiable without it.
//
// advance() drains the microtask queue between timer callbacks. The module's
// lifecycle is a promise chain hung off timer callbacks (transport.start
// resolves inside a setTimeout, and start()'s handlers run on the microtask
// queue after it), so firing timers without letting promises settle would
// observe states that never exist in the real thing.

const settle = () => new Promise((resolve) => setImmediate(resolve))

export function createTestClock(startIso = '2026-08-01T00:00:00Z') {
  let nowMs = Date.parse(startIso)
  let nextId = 0
  const timers = new Map()

  const delay = (ms) => (Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0)

  return {
    now: () => new Date(nowMs),
    setTimeout(fn, ms) {
      const id = (nextId += 1)
      timers.set(id, { at: nowMs + delay(ms), fn, every: null })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    setInterval(fn, ms) {
      const id = (nextId += 1)
      const every = Math.max(1, delay(ms))
      timers.set(id, { at: nowMs + every, fn, every })
      return id
    },
    clearInterval(id) {
      timers.delete(id)
    },

    // --- the test surface -------------------------------------------------

    /** Move simulated time forward, firing everything due, oldest first. */
    async advance(ms) {
      const target = nowMs + delay(ms)
      for (let guard = 0; guard < 10_000; guard += 1) {
        let dueId = null
        let dueAt = Infinity
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < dueAt) {
            dueAt = timer.at
            dueId = id
          }
        }
        if (dueId === null) break
        const timer = timers.get(dueId)
        nowMs = Math.max(nowMs, timer.at)
        if (timer.every === null) timers.delete(dueId)
        else timer.at = nowMs + timer.every
        timer.fn()
        await settle()
      }
      nowMs = Math.max(nowMs, target)
      await settle()
    },

    /** Let pending promise chains settle without moving time. */
    async tick() {
      await settle()
      await settle()
    },

    nowMs: () => nowMs,
    pending: () => timers.size,
  }
}

/**
 * Did this promise settle already, or is it still parked?
 *
 * Used instead of awaiting a promise that a defect would leave pending forever:
 * `node --test` has no default per-test timeout, so awaiting it would hang the
 * whole run rather than fail one case, and a suite that hangs reports nothing.
 */
export async function settledState(promise) {
  const marker = Symbol('pending')
  const outcome = await Promise.race([
    promise.then(
      () => 'resolved',
      () => 'rejected',
    ),
    settle().then(() => settle()).then(() => marker),
  ])
  return outcome === marker ? 'pending' : outcome
}
