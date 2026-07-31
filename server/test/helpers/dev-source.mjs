// A development danmaku source wired to a hand-driven clock.

import { createDanmakuSource } from '../../lib/danmaku-source.mjs'
import { createTestClock } from './clock.mjs'
import { clearedConfig } from './config.mjs'

/**
 * @param {{ lifecycle?: object, development?: object, startIso?: string }} options
 * @returns {{ source: object, clock: object, config: object }}
 */
export function devDanmakuSource({ lifecycle = {}, development = {}, startIso } = {}) {
  const clock = createTestClock(startIso)
  const { config } = clearedConfig({
    danmaku: { mode: 'development', codeTtlMinutes: 10, clock, lifecycle, development },
  })
  return { source: createDanmakuSource(config.danmaku), clock, config }
}

/** Collect every event of one kind, so a test can assert on what was delivered. */
export function collect(source, event) {
  const seen = []
  source.on(event, (payload) => seen.push(payload))
  return seen
}
