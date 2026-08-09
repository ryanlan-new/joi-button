// Config shapes for the guard tests, and the one legitimate way to get a
// development source built.
//
// makeConfig() returns a FRESH object every call on purpose: assertSafeConfig()
// deep-freezes what it clears and records a digest against that exact object,
// so a shared fixture would carry one test's clearance into the next.

import { assertSafeConfig } from '../../lib/env-guard.mjs'

const MiB = 1024 * 1024

/** Everything REQUIREMENTS asks for, with the development doubles selected. */
export function makeConfig({
  database = {},
  storage = {},
  limits = {},
  danmaku = {},
} = {}) {
  return {
    database: { file: '/srv/joi/joi.db', ...database },
    storage: {
      mediaDir: '/srv/joi/media',
      catalogFile: '/srv/joi/catalog.json',
      // A sibling of mediaDir, not a child: the web pod publishes mediaDir.
      stagingDir: '/srv/joi/incoming',
      themeCssFile: '/srv/joi/theme.css',
      wallpaperDir: '/srv/joi/wallpaper',
      ...storage,
    },
    limits: { maxClipsPerBatch: 10, maxFileBytes: 5 * MiB, ...limits },
    danmaku: { mode: 'development', codeTtlMinutes: 10, ...danmaku },
  }
}

/** The same roster with the production credentials the `when` clauses demand. */
export function makeProductionConfig(sections = {}) {
  return makeConfig({
    ...sections,
    danmaku: {
      mode: 'production',
      roomId: 21484828,
      appId: 1787439765162,
      accessKeyId: 'access-key-id',
      accessKeySecret: 'access-key-secret',
      codeTtlMinutes: 10,
      ...(sections.danmaku ?? {}),
    },
  })
}

/**
 * A config that has been through the guard, which is the only kind the
 * development danmaku source will build from.
 *
 * `env: {}` rather than the ambient process.env, so a DEV_BYPASS_* left set in
 * a developer's shell cannot change what these tests measure.
 */
export function clearedConfig(sections = {}, options = {}) {
  const config = makeConfig(sections)
  const report = assertSafeConfig(config, {
    nodeEnv: 'development',
    instanceMode: 'development',
    env: {},
    ...options,
  })
  return { config, report }
}
