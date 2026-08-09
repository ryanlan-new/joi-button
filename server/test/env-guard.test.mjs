import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BYPASS_FLAGS,
  UnsafeConfigError,
  assertSafeConfig,
  describeRequirements,
  isConfigValidated,
} from '../lib/env-guard.mjs'
import { makeConfig, makeProductionConfig } from './helpers/config.mjs'

test('the bypass roster contains only the live danmaku development switch', () => {
  assert.deepEqual(BYPASS_FLAGS.map((flag) => `${flag.source}:${flag.path}`), [
    'config:danmaku.mode',
    'env:DEV_BYPASS_DANMAKU',
  ])
  const retiredName = ['TURN', 'STILE'].join('')
  assert.equal(describeRequirements().some((entry) => entry.path.includes(retiredName)), false)
})

test('a development config is cleared and announces its identity bypass', () => {
  const config = makeConfig()
  const report = assertSafeConfig(config, {
    nodeEnv: 'development',
    instanceMode: 'development',
    env: {},
  })

  assert.equal(report.production, false)
  assert.equal(report.bypasses.length, 1)
  assert.equal(report.bypasses[0].path, 'danmaku.mode')
  assert.notEqual(report.banner, null)
  assert.equal(isConfigValidated(config.danmaku), true)
  assert.equal(Object.isFrozen(config), true)
})

test('production refuses both the config and operator spellings of the bypass', () => {
  const config = makeProductionConfig({ danmaku: { mode: 'development' } })
  assert.throws(
    () => assertSafeConfig(config, { nodeEnv: 'production', instanceMode: 'production', env: { DEV_BYPASS_DANMAKU: '1' } }),
    (error) => {
      assert.equal(error instanceof UnsafeConfigError, true)
      assert.deepEqual(error.flags.map((flag) => flag.path), ['danmaku.mode', 'DEV_BYPASS_DANMAKU'])
      return true
    },
  )
})

test('missing production credentials are reported without exposing secret values', () => {
  const config = makeConfig({ danmaku: { mode: 'production', roomId: 1, appId: 2 } })
  const secret = 'never-print-this-secret'
  assert.throws(
    () => assertSafeConfig(config, { nodeEnv: 'production', instanceMode: 'production', env: {}, extraRequirements: [] }),
    (error) => {
      assert.equal(error.message.includes(secret), false)
      assert.equal(error.message.includes('danmaku.accessKeyId'), true)
      assert.equal(error.message.includes('danmaku.accessKeySecret'), true)
      return true
    },
  )
})

test('an unstamped or missing deployment mode is treated as production', () => {
  assert.throws(
    () => assertSafeConfig(makeConfig(), { nodeEnv: 'test', env: {} }),
    (error) => error instanceof UnsafeConfigError,
  )
})
