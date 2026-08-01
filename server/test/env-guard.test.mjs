// The boot-time refusal, and the clearance record that makes the bypass
// unconstructable rather than merely discouraged.
//
// Two shapes of defect are covered. The first is a permissive default:
// "test" used to be a fully permissive environment that nothing else
// cross-checked, and an unset NODE_ENV inside a container is the single most
// common way a production process ends up on the permissive branch. The second
// is a clearance that outlives the values it was granted for — a WeakSet
// answers "have I seen this object?", and the object can have said something
// else at the time.

import assert from 'node:assert/strict'
import test from 'node:test'

import { createDanmakuSource } from '../lib/danmaku-source.mjs'
import {
  BYPASS_FLAGS,
  InvalidConfigError,
  UnsafeConfigError,
  assertSafeConfig,
  describeRequirements,
  isConfigValidated,
} from '../lib/env-guard.mjs'
import { createTurnstile } from '../lib/turnstile.mjs'
import { clearedConfig, makeConfig, makeProductionConfig } from './helpers/config.mjs'
import { openDatabase } from './helpers/temp-db.mjs'

const MiB = 1024 * 1024
const NO_ENV = {}

function refuses(config, options, why) {
  const error = (() => {
    try {
      assertSafeConfig(config, options)
    } catch (caught) {
      return caught
    }
    return null
  })()
  assert.ok(error !== null, `${why}\n    assertSafeConfig RETURNED; it was supposed to refuse.`)
  return error
}

function assertUnsafe(config, options, why) {
  const error = refuses(config, options, why)
  assert.ok(
    error instanceof UnsafeConfigError,
    `${why}\n    refused, but as ${error.name}: ${error.message}`,
  )
  return error
}

// ---------------------------------------------------------------------------
// The bypass roster

test('the bypass roster is exactly these seven flags, under both the config names and the published DEV_BYPASS_* names', () => {
  // Written out by hand, not derived from BYPASS_FLAGS. A table-driven test
  // over the same table stays green when an entry is deleted, which is the
  // exact shape of a gate that cannot go red.
  assert.deepEqual(
    BYPASS_FLAGS.map((flag) => ({ path: flag.path, source: flag.source, severity: flag.severity })),
    [
      { path: 'danmaku.mode', source: 'config', severity: 'refuse' },
      { path: 'turnstile.mode', source: 'config', severity: 'refuse' },
      { path: 'DEV_BYPASS_DANMAKU', source: 'env', severity: 'refuse' },
      { path: 'DEV_BYPASS_TURNSTILE', source: 'env', severity: 'refuse' },
      { path: 'turnstile.verifyUrl', source: 'config', severity: 'refuse' },
      { path: 'turnstile.fetchImpl', source: 'config', severity: 'refuse' },
      { path: 'turnstile.switch', source: 'config', severity: 'announce' },
    ],
  )
})

test('assertSafeConfig refuses production with danmaku.mode set to development', () => {
  const error = assertUnsafe(
    makeProductionConfig({ danmaku: { mode: 'development' } }),
    { nodeEnv: 'production', instanceMode: 'production', env: NO_ENV },
    'a production process started with a simulated identity check.',
  )
  assert.deepEqual(error.flags.map((f) => f.path), ['danmaku.mode'])
  assert.match(error.message, /Submitter identity is simulated/)
})

test('assertSafeConfig refuses production with turnstile.mode set to development', () => {
  const error = assertUnsafe(
    makeProductionConfig({ turnstile: { mode: 'development' } }),
    { nodeEnv: 'production', instanceMode: 'production', env: NO_ENV },
    'a production process started with a simulated challenge verdict.',
  )
  assert.deepEqual(error.flags.map((f) => f.path), ['turnstile.mode'])
})

test('assertSafeConfig refuses production with DEV_BYPASS_DANMAKU=1, which is the name the operator actually types', () => {
  // The roster used to watch danmaku.mode and never DEV_BYPASS_DANMAKU — the
  // name deploy/runtime.env.example publishes to the owner. Note the config
  // here is otherwise clean: the env variable ALONE must refuse.
  const error = assertUnsafe(
    makeProductionConfig(),
    { nodeEnv: 'production', instanceMode: 'production', env: { DEV_BYPASS_DANMAKU: '1' } },
    'a production process started with DEV_BYPASS_DANMAKU=1 and a clean config.',
  )
  assert.deepEqual(error.flags.map((f) => f.path), ['DEV_BYPASS_DANMAKU'])
  assert.deepEqual(error.flags.map((f) => f.source), ['env'])
})

test('assertSafeConfig refuses production with DEV_BYPASS_TURNSTILE=1', () => {
  const error = assertUnsafe(
    makeProductionConfig(),
    { nodeEnv: 'production', instanceMode: 'production', env: { DEV_BYPASS_TURNSTILE: '1' } },
    'a production process started with DEV_BYPASS_TURNSTILE=1 and a clean config.',
  )
  assert.deepEqual(error.flags.map((f) => f.path), ['DEV_BYPASS_TURNSTILE'])
})

test('a DEV_BYPASS_* value that is neither 0 nor 1 still refuses, because an unrecognised value is not a promise that the bypass is off', () => {
  for (const value of ['true', 'yes', 'on', '2', ' 1 ']) {
    const error = assertUnsafe(
      makeProductionConfig(),
      { nodeEnv: 'production', instanceMode: 'production', env: { DEV_BYPASS_DANMAKU: value } },
      `DEV_BYPASS_DANMAKU=${JSON.stringify(value)} was read as "off".`,
    )
    assert.deepEqual(error.flags.map((f) => f.path), ['DEV_BYPASS_DANMAKU'])
  }
})

test('DEV_BYPASS_*=0, an empty assignment and a value with stray whitespace are all read as off', () => {
  for (const env of [{ DEV_BYPASS_DANMAKU: '0' }, { DEV_BYPASS_DANMAKU: '' }, { DEV_BYPASS_DANMAKU: ' 0 ' }, {}]) {
    const report = assertSafeConfig(makeProductionConfig(), {
      nodeEnv: 'production',
      instanceMode: 'production',
      env,
    })
    assert.deepEqual(report.bypasses, [], `${JSON.stringify(env)} was read as a bypass`)
  }
})

test('assertSafeConfig refuses production with turnstile.verifyUrl or turnstile.fetchImpl present', () => {
  const withUrl = assertUnsafe(
    makeProductionConfig({ turnstile: { verifyUrl: 'https://example.invalid/siteverify' } }),
    { nodeEnv: 'production', instanceMode: 'production', env: NO_ENV },
    'a production process would read the challenge verdict from a host other than Cloudflare.',
  )
  assert.deepEqual(withUrl.flags.map((f) => f.path), ['turnstile.verifyUrl'])

  const withFetch = assertUnsafe(
    makeProductionConfig({ turnstile: { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) } }),
    { nodeEnv: 'production', instanceMode: 'production', env: NO_ENV },
    'a production process would run a substitute HTTP client in front of siteverify.',
  )
  assert.deepEqual(withFetch.flags.map((f) => f.path), ['turnstile.fetchImpl'])
})

test('every refuse-severity bypass at once produces ONE refusal that names all of them', () => {
  const error = assertUnsafe(
    makeProductionConfig({
      danmaku: { mode: 'development' },
      turnstile: { mode: 'development', verifyUrl: 'https://example.invalid/s', fetchImpl: async () => ({}) },
    }),
    {
      nodeEnv: 'production',
      instanceMode: 'production',
      env: { DEV_BYPASS_DANMAKU: '1', DEV_BYPASS_TURNSTILE: '1' },
    },
    'six simultaneous bypasses started a production process.',
  )
  assert.deepEqual(error.flags.map((f) => f.path), [
    'danmaku.mode',
    'turnstile.mode',
    'DEV_BYPASS_DANMAKU',
    'DEV_BYPASS_TURNSTILE',
    'turnstile.verifyUrl',
    'turnstile.fetchImpl',
  ])
})

// ---------------------------------------------------------------------------
// What "production" means

test('an UNSET nodeEnv is refused, never read as development', () => {
  for (const missing of [undefined, null, '', '   ']) {
    const error = refuses(
      makeProductionConfig(),
      { nodeEnv: missing, instanceMode: 'development', env: NO_ENV },
      `nodeEnv ${JSON.stringify(missing)} was accepted.`,
    )
    assert.ok(error instanceof InvalidConfigError)
    assert.match(error.message, /An unset NODE_ENV is NOT read as "development" here/)
  }
})

test('NODE_ENV=test with a bypass refuses, because no db handle and no instanceMode means production', () => {
  // "test" used to be a fully permissive environment that nothing else
  // cross-checked. A permissive environment must be ASSERTED, never inferred
  // from silence.
  const error = assertUnsafe(
    makeConfig({ danmaku: { mode: 'development' } }),
    { nodeEnv: 'test', env: NO_ENV },
    'NODE_ENV=test with no stated deployment mode ran the bypass.',
  )
  assert.match(error.message, /no db handle and no instanceMode were supplied/)
})

test("NODE_ENV='Production' is refused as unrecognised rather than being read as non-production", () => {
  // Without the enum, `mode: "Production"` would be a live typo; the enum and
  // the "not production" phrasing each cover the other's blind spot.
  const error = refuses(
    makeProductionConfig(),
    { nodeEnv: 'Production', instanceMode: 'production', env: NO_ENV },
    "nodeEnv 'Production' was accepted.",
  )
  assert.ok(error instanceof InvalidConfigError)
  assert.match(error.message, /which is not one of production, development, test/)
})

test('NODE_ENV=development still refuses when the DATABASE says the instance is production', (t) => {
  const db = openDatabase(t, { mode: 'production' })

  const error = assertUnsafe(
    makeConfig({ danmaku: { mode: 'development' } }),
    { nodeEnv: 'development', db, env: NO_ENV },
    'a development NODE_ENV pointed at a production database ran the bypass.',
  )
  assert.match(error.message, /the database is marked production \(from database\)/)
})

test('NODE_ENV=test against a production database refuses too', (t) => {
  const db = openDatabase(t, { mode: 'production' })
  assertUnsafe(
    makeConfig({ turnstile: { mode: 'development' } }),
    { nodeEnv: 'test', db, env: NO_ENV },
    'NODE_ENV=test against a production database ran the bypass.',
  )
})

test('a database whose mode cannot be read is treated as production, not as "no opinion"', () => {
  const unreadable = {
    prepare() {
      throw new Error('database is locked')
    },
  }
  const error = assertUnsafe(
    makeConfig({ danmaku: { mode: 'development' } }),
    { nodeEnv: 'development', db: unreadable, env: NO_ENV },
    'a handle that could not answer was taken to have said "development".',
  )
  assert.match(error.message, /could not be read \(database-unreadable\)/)
})

test('an UNSTAMPED database is treated as production', (t) => {
  const db = openDatabase(t, { mode: 'development' })
  db.prepare('UPDATE instance SET mode = NULL WHERE id = 1').run()

  const error = assertUnsafe(
    makeConfig({ danmaku: { mode: 'development' } }),
    { nodeEnv: 'development', db, env: NO_ENV },
    'an unstamped database was taken to be a development deployment.',
  )
  assert.match(error.message, /could not be read \(database-unstamped\)/)
})

test('a stamped development database with NODE_ENV=development is the one combination that clears the bypass', (t) => {
  const db = openDatabase(t, { mode: 'development' })

  const report = assertSafeConfig(makeConfig({ danmaku: { mode: 'development' } }), {
    nodeEnv: 'development',
    db,
    env: NO_ENV,
  })
  assert.equal(report.production, false)
  assert.deepEqual(report.productionSignals, {
    nodeEnv: false,
    instanceMode: 'development',
    instanceModeSource: 'database',
    defaulted: false,
  })
  // Both doubles are selected in makeConfig(), and both are reported: a
  // cleared bypass is still an announced one.
  assert.deepEqual(report.bypasses.map((b) => b.path), ['danmaku.mode', 'turnstile.mode'])
})

test('an instanceMode outside the two values the column CHECKs is refused', () => {
  const error = refuses(
    makeConfig(),
    { nodeEnv: 'development', instanceMode: 'test', env: NO_ENV },
    "instanceMode 'test' was accepted; the database has no such mode.",
  )
  assert.ok(error instanceof InvalidConfigError)
  assert.match(error.message, /which is not one of production, development/)
})

// ---------------------------------------------------------------------------
// The required-key contract

test('one refusal lists all four missing keys, so an operator learns everything in one restart', () => {
  const config = makeProductionConfig()
  delete config.database.file
  delete config.storage.mediaDir
  delete config.danmaku.accessKeySecret
  delete config.turnstile.secretKey

  const error = refuses(
    config,
    { nodeEnv: 'production', instanceMode: 'production', env: NO_ENV },
    'a config missing four required keys was accepted.',
  )
  assert.ok(error instanceof InvalidConfigError)
  assert.deepEqual(error.problems.map((p) => p.path).sort(), [
    'danmaku.accessKeySecret',
    'database.file',
    'storage.mediaDir',
    'turnstile.secretKey',
  ])
  for (const path of ['database.file', 'storage.mediaDir', 'danmaku.accessKeySecret', 'turnstile.secretKey']) {
    assert.match(error.message, new RegExp(path.replace('.', '\\.')))
  }
})

test('production credentials are not demanded of the development doubles, so nobody has to invent a plausible fake secret', () => {
  const config = makeConfig()
  assert.equal(config.danmaku.accessKeySecret, undefined)
  const report = assertSafeConfig(config, { nodeEnv: 'development', instanceMode: 'development', env: NO_ENV })
  assert.equal(report.production, false)
})

test('the ruled ceilings hold: 10 clips per batch and 5 MiB per file are accepted, one more is not', () => {
  for (const [path, section, key, ceiling] of [
    ['limits.maxClipsPerBatch', 'limits', 'maxClipsPerBatch', 10],
    ['limits.maxFileBytes', 'limits', 'maxFileBytes', 5 * MiB],
  ]) {
    assert.doesNotThrow(() =>
      assertSafeConfig(makeProductionConfig({ [section]: { [key]: ceiling } }), {
        nodeEnv: 'production',
        instanceMode: 'production',
        env: NO_ENV,
      }),
    )
    const error = refuses(
      makeProductionConfig({ [section]: { [key]: ceiling + 1 } }),
      { nodeEnv: 'production', instanceMode: 'production', env: NO_ENV },
      `${path} accepted ${ceiling + 1}, which is above the ruled ceiling.`,
    )
    assert.deepEqual(error.problems.map((p) => p.path), [path])
    assert.match(error.message, /exceeds the ceiling/)
  }
})

test('a relative storage path is refused in production and allowed in development', () => {
  const error = refuses(
    makeProductionConfig({ storage: { catalogFile: 'catalog.json' } }),
    { nodeEnv: 'production', instanceMode: 'production', env: NO_ENV },
    'a relative catalogue path was accepted in production.',
  )
  assert.deepEqual(error.problems.map((p) => p.path), ['storage.catalogFile'])

  assert.doesNotThrow(() =>
    assertSafeConfig(makeConfig({ storage: { catalogFile: 'catalog.json' } }), {
      nodeEnv: 'development',
      instanceMode: 'development',
      env: NO_ENV,
    }),
  )
})

test('a secret key\'s VALUE never appears in the refusal message', () => {
  // Constructed with an extra requirement rather than one from the base roster:
  // every secret in REQUIREMENTS is kind 'string', and the string branch never
  // prints the value, so the base roster cannot make this case go red. The
  // integer branch does print it — which is what makes this a real test of
  // describeProblem's secret check rather than a restatement of the roster.
  const config = makeProductionConfig()
  config.danmaku.tokenSeed = 987654321

  const error = refuses(
    config,
    {
      nodeEnv: 'production',
      instanceMode: 'production',
      env: NO_ENV,
      extraRequirements: [
        { path: 'danmaku.tokenSeed', kind: 'integer', max: 10, secret: true, why: 'Open Platform credential.' },
      ],
    },
    'an out-of-range secret was accepted.',
  )
  assert.ok(!error.message.includes('987654321'), 'a refusal message carried the value of a secret')
  assert.match(error.message, /value withheld: this key is a secret/)

  // …and a non-secret out-of-range value DOES show its value, which is what
  // proves the line above is about the `secret` flag.
  const plain = refuses(
    makeProductionConfig({ limits: { maxClipsPerBatch: 987654321 } }),
    { nodeEnv: 'production', instanceMode: 'production', env: NO_ENV },
    'an out-of-range limit was accepted.',
  )
  assert.match(plain.message, /987654321/)
})

test('describeRequirements() reports the roster without any values, for an ops page that must not print secrets', () => {
  const described = describeRequirements()
  const secrets = described.filter((r) => r.secret).map((r) => r.path)
  assert.deepEqual(secrets, ['danmaku.accessKeyId', 'danmaku.accessKeySecret', 'turnstile.secretKey'])
  for (const requirement of described) {
    assert.deepEqual(Object.keys(requirement).sort(), ['conditional', 'kind', 'path', 'secret', 'why'])
  }
})

// ---------------------------------------------------------------------------
// The clearance record

test('a config that never went through the guard cannot construct either development double', () => {
  const config = makeConfig()
  assert.equal(isConfigValidated(config.danmaku), false)

  assert.throws(() => createDanmakuSource(config.danmaku), /assertSafeConfig\(\) has cleared/)
  assert.throws(() => createTurnstile(config.turnstile), /assertSafeConfig\(\) has cleared/)
})

test('a config that FAILED validation cannot construct a development double either', () => {
  const config = makeConfig()
  delete config.database.file

  assert.throws(() => assertSafeConfig(config, { nodeEnv: 'development', instanceMode: 'development', env: NO_ENV }))
  // The clearance is recorded after the problems check, so this config was
  // never cleared at all.
  assert.equal(isConfigValidated(config.danmaku), false)
  assert.throws(() => createDanmakuSource(config.danmaku), /assertSafeConfig\(\) has cleared/)
})

test('a config cleared in PRODUCTION cannot construct a development double, even though it was cleared', () => {
  const config = makeProductionConfig()
  const report = assertSafeConfig(config, { nodeEnv: 'production', instanceMode: 'production', env: NO_ENV })
  assert.equal(report.production, true)

  // The sections are registered, so the WeakMap has an entry — and the answer
  // is still no.
  assert.equal(isConfigValidated(config.danmaku), false)
  assert.equal(isConfigValidated(config.turnstile), false)
})

test('a cleared config is frozen, so the ordinary way of changing it afterwards throws where it is written', () => {
  const { config } = clearedConfig()
  assert.equal(isConfigValidated(config.danmaku), true)

  assert.throws(() => {
    config.danmaku.mode = 'production'
  }, TypeError)
  assert.throws(() => {
    config.limits.maxClipsPerBatch = 999
  }, TypeError)
  assert.throws(() => {
    config.turnstile.switch = 'off'
  }, TypeError)

  assert.equal(config.danmaku.mode, 'development')
  assert.equal(isConfigValidated(config.danmaku), true)
})

test('a config cleared through an ACCESSOR and then mutated in place does not construct a development source', () => {
  // Freezing cannot stop a getter, which is exactly why the mark alone was
  // never enough: isConfigValidated() re-reads the values and compares them
  // against the digest taken at clearance.
  let danmakuMode = 'production'
  const danmaku = {
    get mode() {
      return danmakuMode
    },
    roomId: 21484828,
    appId: 1787439765162,
    accessKeyId: 'access-key-id',
    accessKeySecret: 'access-key-secret',
    codeTtlMinutes: 10,
  }
  const config = makeConfig({ turnstile: { mode: 'production', siteKey: 's', secretKey: 'k', switch: 'auto' } })
  config.danmaku = danmaku

  assertSafeConfig(config, { nodeEnv: 'development', instanceMode: 'development', env: NO_ENV })
  assert.equal(isConfigValidated(config.danmaku), true, 'the clearance it was actually granted')

  danmakuMode = 'development'
  assert.equal(config.danmaku.mode, 'development', 'the getter really did change what the section says')
  assert.equal(
    isConfigValidated(config.danmaku),
    false,
    'a clearance that survives the values it was granted for is a clearance for nothing',
  )
  assert.throws(() => createDanmakuSource(config.danmaku), /assertSafeConfig\(\) has cleared/)
})

test('the same accessor trick on the turnstile section does not construct a development verifier', () => {
  let turnstileMode = 'production'
  const turnstile = {
    get mode() {
      return turnstileMode
    },
    siteKey: 'site-key',
    secretKey: 'secret-key',
    switch: 'auto',
  }
  const config = makeProductionConfig()
  config.turnstile = turnstile

  assertSafeConfig(config, { nodeEnv: 'development', instanceMode: 'development', env: NO_ENV })
  turnstileMode = 'development'

  assert.equal(isConfigValidated(config.turnstile), false)
  assert.throws(() => createTurnstile(config.turnstile), /assertSafeConfig\(\) has cleared/)
})

test('isConfigValidated() answers "no" to anything that is not a cleared object, and never throws', () => {
  for (const value of [null, undefined, 'danmaku', 42, [], () => {}, Object.freeze({ mode: 'development' })]) {
    assert.equal(isConfigValidated(value), false, `isConfigValidated said yes to ${String(value)}`)
  }
})

// ---------------------------------------------------------------------------
// The banner

test('an announce-severity switch does not refuse production, but it does raise a banner', () => {
  const report = assertSafeConfig(makeProductionConfig({ turnstile: { switch: 'off' } }), {
    nodeEnv: 'production',
    instanceMode: 'production',
    env: NO_ENV,
  })

  assert.deepEqual(report.bypasses.map((b) => b.path), ['turnstile.switch'])
  assert.equal(report.banner.severity, 'degraded')
  assert.equal(report.banner.messageKey, 'banner.envChallengeOff')

  // The detail used to promise "Tokens that are presented are still verified",
  // and that was never true: routes/public.mjs calls verify() only inside
  // `if (decision.required)`, and this switch makes that false before any rule
  // runs. The sentence now says what actually happens, and names what IS still
  // protecting the endpoint — a banner an operator reads to judge a deployment
  // must not overstate the remaining checks.
  assert.match(report.banner.detail, /ignored rather than checked/)
  assert.match(report.banner.detail, /Identity is still required/)
  assert.equal(/still verified/.test(report.banner.detail), false)
})

test('a refuse-severity bypass running in development raises the stronger banner', () => {
  const { report } = clearedConfig({ danmaku: { mode: 'development' } })
  assert.equal(report.banner.severity, 'bypass')
  assert.equal(report.banner.messageKey, 'banner.envBypassUnverified')
  assert.equal(report.banner.httpHeader.name, 'X-Joi-Bypass')
  assert.match(report.banner.httpHeader.value, /danmaku\.mode=development/)
})

test('no banner string carries vue-i18n syntax, because the frontend renders every one of them through $t', () => {
  const { report: refusing } = clearedConfig(
    { danmaku: { mode: 'development' }, turnstile: { mode: 'development', switch: 'off' } },
    { env: { DEV_BYPASS_DANMAKU: '1', DEV_BYPASS_TURNSTILE: '1' } },
  )
  // Both banners, because buildBanner picks a different headline and detail for
  // each severity and a test that only ever builds one of them leaves the other
  // pair unread.
  const degraded = assertSafeConfig(makeProductionConfig({ turnstile: { switch: 'off' } }), {
    nodeEnv: 'production',
    instanceMode: 'production',
    env: NO_ENV,
  })

  const strings = [
    refusing.banner.headline,
    refusing.banner.detail,
    ...refusing.banner.flags.map((f) => f.effect),
    degraded.banner.headline,
    degraded.banner.detail,
    ...degraded.banner.flags.map((f) => f.effect),
  ]
  assert.equal(refusing.banner.severity, 'bypass')
  assert.equal(degraded.banner.severity, 'degraded')
  assert.ok(strings.length >= 9)
  for (const text of strings) {
    assert.doesNotMatch(text, /[{}|]/, `banner string contains an interpolation slot or a plural separator: ${text}`)
    assert.doesNotMatch(text, /@(?:\.[A-Za-z]+)?:/, `banner string contains a linked message: ${text}`)
  }
})

test('an operator-supplied flag value is MANGLED rather than allowed to delete the warning it appears in', () => {
  // Escape what you cannot control, refuse what you can: developer-authored
  // banner text is refused for these characters, operator input is sanitised.
  // Building no banner at all would remove the warning while the bypass ran.
  const { report } = clearedConfig(
    {},
    { env: { DEV_BYPASS_DANMAKU: '1|@:info.title\r\nX-Injected: yes' } },
  )

  const value = report.bypasses[0].value
  assert.doesNotMatch(value, /[@|{}]/, 'a vue-i18n metacharacter survived into the banner')
  assert.doesNotMatch(value, /[\r\n]/, 'a header-splitting byte survived into X-Joi-Bypass')
  assert.doesNotMatch(report.banner.httpHeader.value, /[\r\n]/)
  assert.ok(value.length <= 64)
})

test('a report is frozen, and reports the requirement count it actually evaluated', () => {
  const { report } = clearedConfig()
  assert.ok(Object.isFrozen(report))
  assert.ok(Object.isFrozen(report.bypasses))
  assert.equal(report.nodeEnv, 'development')
  assert.equal(report.requirementCount, describeRequirements().length)
})
