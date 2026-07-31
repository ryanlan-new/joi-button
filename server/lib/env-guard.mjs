// SPDX-License-Identifier: MIT
//
// The production guard: the boot-time refusal, and the one place that knows
// which flags are development bypasses.
//
// Two jobs, deliberately in one file because they are the same question asked
// twice — "is this configuration allowed to run here?":
//
//   1. assertSafeConfig() REFUSES to return when this process is production and
//      a development bypass is set. It throws; a thrown boot-path error is a
//      process that does not start.
//   2. It validates the whole required-key set and reports EVERY problem at
//      once, because a boot loop that reveals one missing key per attempt costs
//      an operator six restarts to learn what a single message could have said.
//
// WHAT "PRODUCTION" MEANS HERE, AND WHY IT IS NOT NODE_ENV.
// NODE_ENV has three values, and a three-valued environment variable is a
// three-valued permission: "test" used to be a fully permissive environment
// that nothing else cross-checked. So production-ness is the OR of two
// independent signals:
//
//   nodeEnv === 'production'   OR   the database's own instance.mode === 'production'
//
// instance.mode lives in the database file (schema.sql), is a one-way ratchet —
// development may become production, never the reverse — and the same file's
// triggers already refuse to RECORD a dev-bypass verification or a bypassed
// challenge when it says production. Consulting it here means the refusal and
// the triggers derive from one fact rather than two that can disagree.
//
// When neither a db handle nor a resolved instanceMode is supplied, the answer
// is production. Not because it probably is, but because the two errors are not
// symmetric: a development laptop wrongly called production loses its bypasses
// and says so; a production pod wrongly called development runs without an
// identity check. So a permissive environment must be ASSERTED (pass options.db,
// or options.instanceMode), never inferred from silence.
//
// WHY THE BYPASS CANNOT BE ENABLED IN PRODUCTION BY DISCIPLINE ALONE.
// Four layers, and only the first one is the obvious one:
//
//   (a) the refusal above — but that only fires if somebody calls this function,
//       so on its own it IS discipline;
//   (b) the clearance record below. assertSafeConfig() deep-freezes what it
//       clears and remembers a digest of the VALUES it cleared; the development
//       implementations in danmaku-source.mjs and turnstile.mjs refuse to
//       construct from a config this module has not cleared, and the clearance
//       is re-derived from the live values at that moment. So the pass-through
//       code paths are not reachable from a config that skipped the guard, nor
//       from one that changed after it — forgetting to call assertSafeConfig()
//       does not silently grant the bypass, it makes the bypass unconstructable;
//   (c) the enum validators. The bypass test for `danmaku.mode` is "not
//       production", and the required-key check independently pins the value to
//       exactly {production, development}. Without the enum, `mode: "Production"`
//       would be a live typo; without the "not production" phrasing, a new mode
//       added later would default to permitted. Each covers the other's blind
//       spot;
//   (d) the database. Even if every check above were removed, instance.mode
//       makes the bypassed rows unwritable on a production database.
//
// WHAT THIS DOES NOT DEFEND AGAINST, stated rather than implied: anyone who can
// edit this file can delete the check. This guard is against misconfiguration —
// the wrong values reaching the right code — not against a hostile deploy. The
// banner exists for the same reason: a bypass that is running should be visible
// to a human looking at the page, not only to a reader of the config.
//
// WHY AN UNSET NODE_ENV IS A REFUSAL AND NOT "development".
// `nodeEnv` must be supplied by the caller and must be one of the three known
// values. An unset NODE_ENV inside a container is the single most common way a
// production process ends up running the permissive branch, so the permissive
// branch is not the default of anything here. There is no `?? 'development'` in
// this file, on purpose. options.env DOES default to process.env, which is the
// same argument and not its opposite: an env bag that is not consulted can only
// hide a bypass, never invent one, so reading it by default can only add
// refusals.
//
// ---------------------------------------------------------------------------
// FIXES IN THIS REVISION. Each line names the input that proves it red: run it
// against the previous revision and it PASSES, which was the defect.
//
//   1. assertSafeConfig(cfgWithDanmakuModeDevelopment, { nodeEnv: 'test' }) —
//      returned a report and cleared the config, because "test" was neither
//      production nor watched by anything else. It now refuses: no db handle and
//      no instanceMode means production. So does the same call with
//      { nodeEnv: 'test', db } against a database stamped 'production'.
//   2a. assertSafeConfig(cleanCfg, { nodeEnv: 'production', instanceMode: 'production' })
//      followed by `cfg.danmaku.mode = 'development'` — the assignment used to
//      succeed and isConfigValidated(cfg.danmaku) stayed true. The cleared
//      sections are now deep-frozen, so the assignment throws TypeError where it
//      is written (module code is strict mode).
//   2b. A section whose mode is an accessor — `{ get mode() { return m } }` —
//      cleared while m === 'production', then m = 'development'. Freezing cannot
//      stop a getter, which is exactly why the mark alone was never enough:
//      isConfigValidated() re-reads the values and compares them against the
//      digest taken at clearance, and now returns false.
//   3. `grep -ril x-joi-bypass deploy/ server/` returned exactly one file, this
//      one, while the comment in buildBanner claimed the smoke test asserted the
//      header. The claim is now replaced by the assertion's exact text.
//   4. assertSafeConfig(cleanProdCfg, { nodeEnv: 'production', instanceMode: 'production',
//      env: { DEV_BYPASS_DANMAKU: '1' } }) — returned a report. The roster
//      watched danmaku.mode and never DEV_BYPASS_DANMAKU, which is the name
//      deploy/runtime.env.example publishes to the owner. Both names now refuse.
//   5. A banner string containing '@.lower:banner.envBypassUnverified' passed
//      assertVueI18nSafe. vue-i18n 8.21.1's linkKeyMatcher accepts @.mod: as a
//      link, so it would have rendered as one.
//   Also: checkedAt used Date#toISOString(), which emits milliseconds and fails
//      every timestamp CHECK in schema.sql. toCanonicalTimestamp() is the only
//      correct producer, so it is the one used.
// ---------------------------------------------------------------------------
// WHAT MAKES THIS GO RED (i.e. what breaks the guards this file asserts)
//
//   * Change `const env = options.nodeEnv` to `options.nodeEnv ?? 'development'`
//     — the "unset NODE_ENV is refused, not assumed friendly" case goes red.
//   * Make `production` read `env === 'production'` alone — the "NODE_ENV=test
//     against a production database refuses" case goes red.
//   * Make an unknown instance mode read as development — the "no db handle
//     means production" case goes red.
//   * Turn the throw in the production-bypass branch into a console.warn — the
//     refusal case goes red.
//   * Delete an entry from BYPASS_FLAGS — the flag-roster assertion goes red,
//     PROVIDED the test pins the roster literally. Do NOT drive that test from
//     BYPASS_FLAGS itself: a table-driven test over the same table stays green
//     when an entry is deleted, which is the exact shape of a gate that cannot
//     go red. Write the expected paths out by hand, both the config paths and
//     the DEV_BYPASS_* names.
//   * Report a secret's VALUE in a problem message (drop the `secret` check in
//     describeProblem) — the "no secret text ever appears in the refusal" case
//     goes red.
//   * Raise limits.maxClipsPerBatch's max above 10, or maxFileBytes' above
//     5 MiB — the ruled-ceiling cases go red.
//   * Return on the first problem instead of collecting — the "one message
//     lists all four missing keys" case goes red.
//   * Record the clearance before the problems check — the "a config that failed
//     validation cannot construct a dev bypass" case in danmaku-source/turnstile
//     goes red.
//   * Make isConfigValidated() answer from the WeakMap alone without re-deriving
//     the digest — case 2b above goes red.
//   * Put a `{`, `}`, `@:`, `@.mod:` or `|` into any banner string —
//     assertVueI18nSafe throws at banner-build time. That is deliberate: the
//     banner is rendered through vue-i18n, which reads those as interpolation, a
//     linked message and a plural separator respectively.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'

import { readInstanceMode, toCanonicalTimestamp } from '../db/migrate.mjs'

const MiB = 1024 * 1024

const KNOWN_ENVS = Object.freeze(['production', 'development', 'test'])

// The values instance.mode may hold. Deliberately NOT 'test': the database
// distinguishes two deployments, and a third would be a third permission.
const INSTANCE_MODES = Object.freeze(['production', 'development'])

// The complete roster of development bypasses. `isUnsafe` is only consulted when
// the key is actually present; an absent key is handled by the required-key
// check, which reports it as missing rather than as a bypass.
//
// `severity: 'refuse'` means the process must not start in production.
// `severity: 'announce'` means it MAY run in production but must be visible —
// turnstile.switch = "off" is an operator's 1am kill switch, not a fake verdict:
// no challenge is demanded, but a token that IS sent is still really verified.
//
// `source` says where the value is read from. Two vocabularies describe the same
// two bypasses and both must trip the refusal: the config paths this process
// actually branches on, and the DEV_BYPASS_* environment variables that
// deploy/runtime.env.example publishes to the owner. The published names are the
// ones a human sets by hand, so watching only the internal paths meant watching
// the names nobody types. Neither is a translation of the other here — either
// one alone refuses.
export const BYPASS_FLAGS = Object.freeze([
  Object.freeze({
    path: 'danmaku.mode',
    source: 'config',
    enumerated: true,
    severity: 'refuse',
    isUnsafe: (value) => value !== 'production',
    effect:
      'Submitter identity is simulated. Any visitor can claim to be any open_id, ' +
      'so every attribution in the catalogue becomes unfounded.',
  }),
  Object.freeze({
    path: 'turnstile.mode',
    source: 'config',
    enumerated: true,
    severity: 'refuse',
    isUnsafe: (value) => value !== 'production',
    effect:
      'The Turnstile verdict is simulated. Every challenge passes without ' +
      'Cloudflare ever being asked.',
  }),
  Object.freeze({
    path: 'DEV_BYPASS_DANMAKU',
    source: 'env',
    enumerated: true,
    // The vocabulary deploy/runtime.env.example publishes. `isUnsafe` is
    // deliberately WIDER than it: anything present that is not exactly "0"
    // counts as on, because an unrecognised value is not a promise that the
    // bypass is off, and this is the direction where guessing wrong is free.
    // Narrowing isUnsafe to `value === '1'` makes DEV_BYPASS_DANMAKU=true a
    // silent no-op, which is the defect this pair exists to prevent.
    values: Object.freeze(['0', '1']),
    severity: 'refuse',
    isUnsafe: (value) => value !== '0',
    effect:
      'Submitter identity is simulated. This is the operator-facing name for that ' +
      'bypass, the one published in deploy/runtime.env.example.',
  }),
  Object.freeze({
    path: 'DEV_BYPASS_TURNSTILE',
    source: 'env',
    enumerated: true,
    values: Object.freeze(['0', '1']), // see DEV_BYPASS_DANMAKU above
    severity: 'refuse',
    isUnsafe: (value) => value !== '0',
    effect:
      'The Turnstile verdict is simulated. This is the operator-facing name for ' +
      'that bypass, the one published in deploy/runtime.env.example.',
  }),
  Object.freeze({
    path: 'turnstile.verifyUrl',
    source: 'config',
    enumerated: false,
    severity: 'refuse',
    isUnsafe: (value) => value !== undefined,
    effect:
      'The challenge verdict would be read from a host other than Cloudflare. ' +
      'In production the endpoint is a constant and this key must be absent.',
  }),
  Object.freeze({
    path: 'turnstile.fetchImpl',
    source: 'config',
    enumerated: false,
    severity: 'refuse',
    isUnsafe: (value) => value !== undefined,
    effect:
      'A substitute HTTP client is installed in front of siteverify, which can ' +
      'return any verdict at all. It exists for tests.',
  }),
  Object.freeze({
    path: 'turnstile.switch',
    source: 'config',
    enumerated: true,
    severity: 'announce',
    isUnsafe: (value) => value === 'off',
    effect:
      'No challenge is ever demanded of anyone. Tokens are still really ' +
      'verified when one is presented.',
  }),
])

// The boot contract as of STORY-047. A story that adds configuration adds it
// here, or passes it as options.extraRequirements at the call site; either way
// a forgotten key fails at boot rather than at 3am on the first submission.
//
// `when` makes a requirement conditional — production credentials are not
// required to run the development doubles, and demanding them would push
// developers into inventing plausible fake secrets, which is how a fake secret
// eventually gets committed.
const prodDanmaku = (config) => read(config, 'danmaku.mode').value === 'production'
const prodTurnstile = (config) => read(config, 'turnstile.mode').value === 'production'

const REQUIREMENTS = Object.freeze([
  {
    path: 'database.file',
    kind: 'string',
    why: 'SQLite is the sole authority for the published catalogue.',
  },
  {
    path: 'storage.mediaDir',
    kind: 'path',
    why: 'Content-addressed media on the shared PVC; the web pod mounts it read-only.',
  },
  {
    path: 'storage.catalogFile',
    kind: 'path',
    why: 'catalog.json on the shared PVC; the web pod serves this file.',
  },
  {
    path: 'limits.maxClipsPerBatch',
    kind: 'integer',
    min: 1,
    max: 10,
    why: 'Ruled ceiling: at most 10 clips per batch. Lower is allowed, higher is not.',
  },
  {
    path: 'limits.maxFileBytes',
    kind: 'integer',
    min: 1,
    max: 5 * MiB,
    why: 'Ruled ceiling: 5 MB per file. Lower is allowed, higher is not.',
  },
  {
    path: 'danmaku.mode',
    kind: 'enum',
    values: ['production', 'development'],
    why: 'Selects the room listener. See BYPASS_FLAGS: "development" is a bypass.',
  },
  {
    path: 'danmaku.roomId',
    kind: 'integer',
    min: 1,
    when: prodDanmaku,
    why: 'The owner\'s live room; the only room whose danmaku confer identity.',
  },
  {
    path: 'danmaku.appId',
    kind: 'integer',
    min: 1,
    when: prodDanmaku,
    why: 'Bilibili Open Platform project id.',
  },
  {
    path: 'danmaku.accessKeyId',
    kind: 'string',
    secret: true,
    when: prodDanmaku,
    why: 'Open Platform credential.',
  },
  {
    path: 'danmaku.accessKeySecret',
    kind: 'string',
    secret: true,
    when: prodDanmaku,
    why: 'Open Platform credential.',
  },
  {
    path: 'danmaku.codeTtlMinutes',
    kind: 'integer',
    min: 1,
    max: 10,
    why: 'Ruled ceiling: the one-time code and its room session expire after 10 minutes.',
  },
  {
    path: 'turnstile.mode',
    kind: 'enum',
    values: ['production', 'development'],
    why: 'Selects the challenge verifier. See BYPASS_FLAGS: "development" is a bypass.',
  },
  {
    path: 'turnstile.siteKey',
    kind: 'string',
    when: prodTurnstile,
    why: 'Public sitekey; the frontend widget needs it. Not a secret.',
  },
  {
    path: 'turnstile.secretKey',
    kind: 'string',
    secret: true,
    when: prodTurnstile,
    why: 'siteverify credential.',
  },
  {
    path: 'turnstile.switch',
    kind: 'enum',
    values: ['auto', 'always', 'off'],
    why: 'The operator\'s manual override over the on-demand challenge policy.',
  },
])

export class InvalidConfigError extends Error {
  constructor(message, problems = []) {
    super(message)
    this.name = 'InvalidConfigError'
    this.problems = Object.freeze([...problems])
  }
}

export class UnsafeConfigError extends Error {
  constructor(message, flags = [], problems = []) {
    super(message)
    this.name = 'UnsafeConfigError'
    this.flags = Object.freeze([...flags])
    this.problems = Object.freeze([...problems])
  }
}

// What assertSafeConfig() cleared, keyed by the object it cleared: the
// environment it was cleared for, and a digest of the VALUES that made the
// clearance true. A WeakMap rather than a property on the object: nothing is
// added to the config, nothing shows up in JSON.stringify or a deepEqual in
// somebody else's test, and a config that goes out of scope is collectable.
//
// It records the digest and not only the identity because identity is not the
// thing that was checked. A WeakSet answers "have I seen this object?", and the
// object can have said something else at the time.
const clearances = new WeakMap()

/**
 * True when `value` is a config object (or a section of one) that
 * assertSafeConfig() cleared in this process AND that still holds the values it
 * was cleared for.
 *
 * The development implementations call this. It is not a permission check on
 * behalf of the caller — it is the answer to "did the environment guard clear
 * THIS, as it is now?", and "no" is not a safe answer for a bypass.
 *
 * Never throws: a question that cannot be answered is answered "no".
 */
export function isConfigValidated(value) {
  if (typeof value !== 'object' || value === null) return false

  const record = clearances.get(value)
  if (record === undefined) return false

  // A clearance issued in production can never authorise a bypass. It should be
  // unreachable — assertSafeConfig() throws before recording one when a
  // refuse-severity flag is set — so this is the belt to that brace, and it
  // costs one comparison.
  if (record.production) return false

  // A section this module could not freeze is a section whose values it cannot
  // vouch for between clearance and construction.
  if (!Object.isFrozen(value)) return false

  try {
    return clearanceDigest(value, record) === record.digest
  } catch {
    return false
  }
}

/**
 * Validate configuration and refuse to proceed when production carries a
 * development bypass.
 *
 * NOTE: this function deep-freezes the config it clears (see recordClearance).
 * Attach everything before calling it, not after.
 *
 * @param {object} config   the whole API config, a plain object
 * @param {object} options
 * @param {string} options.nodeEnv            required; 'production'|'development'|'test'
 * @param {object} [options.db]               better-sqlite3 handle; its instance.mode is read
 * @param {string} [options.instanceMode]     'production'|'development', when the caller already read it
 * @param {object} [options.env]              environment bag for the DEV_BYPASS_* flags; defaults to process.env
 * @param {Array}  [options.requirements]     replaces the base requirement list
 * @param {Array}  [options.extraRequirements] appended to it
 * @returns {object} frozen report: { nodeEnv, production, productionSignals, checkedAt, bypasses, banner }
 * @throws {InvalidConfigError} when keys are missing or malformed
 * @throws {UnsafeConfigError}  when production carries a refuse-severity bypass
 *
 * Neither options list can weaken the bypass refusal: the refusal is evaluated
 * after them and reads BYPASS_FLAGS, which is not a parameter. That is what
 * makes it safe to hand a focused test a short requirement list. options.db and
 * options.instanceMode can only ADD production-ness, never remove it — the OR
 * still has nodeEnv in it.
 */
export function assertSafeConfig(config, options = {}) {
  const env = options.nodeEnv
  if (typeof env !== 'string' || env.trim() === '') {
    throw new InvalidConfigError(
      refusalHeader() +
        '\n  - nodeEnv was not supplied.\n' +
        '    Pass it explicitly at the entry point: assertSafeConfig(config, { nodeEnv: process.env.NODE_ENV, db }).\n' +
        '    An unset NODE_ENV is NOT read as "development" here; that assumption is how a\n' +
        '    production container ends up running the bypass.',
      [{ path: 'nodeEnv', problem: 'missing' }],
    )
  }
  if (!KNOWN_ENVS.includes(env)) {
    throw new InvalidConfigError(
      refusalHeader() +
        `\n  - nodeEnv is "${env}", which is not one of ${KNOWN_ENVS.join(', ')}.\n` +
        '    An unrecognised environment is refused rather than treated as non-production.',
      [{ path: 'nodeEnv', problem: 'not-allowed' }],
    )
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new InvalidConfigError(
      refusalHeader() + '\n  - config must be a plain object.',
      [{ path: '', problem: 'wrong-type' }],
    )
  }

  const signals = resolveProduction(env, options)
  const production = signals.production
  const envBag = options.env ?? globalThis.process?.env ?? {}

  const requirements = [
    ...(options.requirements ?? REQUIREMENTS),
    ...(options.extraRequirements ?? []),
  ]

  const problems = []
  for (const req of requirements) {
    if (typeof req.when === 'function' && !req.when(config)) continue
    const problem = checkRequirement(config, req, { production })
    if (problem) problems.push(problem)
  }

  const bypasses = []
  for (const flag of BYPASS_FLAGS) {
    const { present, value } = readFlag(flag, config, envBag)
    if (!present || value === undefined) continue
    if (!flag.isUnsafe(value)) continue
    bypasses.push(
      Object.freeze({
        path: flag.path,
        source: flag.source,
        // Sanitised at capture rather than at render. This value can come from
        // an environment variable, i.e. from an operator's keyboard, and it
        // reaches both an HTTP header and vue-i18n. Refusing to build the banner
        // over a stray character would delete the warning while the bypass ran,
        // so operator input is mangled here where developer-authored banner text
        // is refused in assertVueI18nSafe. Escape what you cannot control.
        value: flag.enumerated ? sanitizeFlagValue(value) : null,
        severity: flag.severity,
        effect: flag.effect,
      }),
    )
  }

  const refusals = bypasses.filter((b) => b.severity === 'refuse')
  if (production && refusals.length > 0) {
    throw new UnsafeConfigError(unsafeMessage(refusals, problems, signals), refusals, problems)
  }
  if (problems.length > 0) {
    throw new InvalidConfigError(problemMessage(problems), problems)
  }

  recordClearance(config, {
    env,
    production,
    requirements,
    envBag,
  })

  return Object.freeze({
    nodeEnv: env,
    production,
    productionSignals: Object.freeze({
      nodeEnv: env === 'production',
      instanceMode: signals.instanceMode,
      instanceModeSource: signals.source,
      defaulted: signals.defaulted,
    }),
    // Second-precision UTC, from the one producer the schema accepts.
    // Date#toISOString() emits milliseconds and fails every timestamp CHECK in
    // schema.sql, so a report written to the audit log would be rejected there
    // rather than here.
    checkedAt: toCanonicalTimestamp(new Date()),
    bypasses: Object.freeze(bypasses),
    banner: buildBanner(env, bypasses),
    requirementCount: requirements.length,
  })
}

/**
 * The requirement roster as data, without values — for an ops page or a
 * generated deployment README, so the list of keys has one source and not two.
 */
export function describeRequirements() {
  return Object.freeze(
    REQUIREMENTS.map((r) =>
      Object.freeze({
        path: r.path,
        kind: r.kind,
        secret: r.secret === true,
        conditional: typeof r.when === 'function',
        why: r.why,
      }),
    ),
  )
}

// ---------------------------------------------------------------------------

// production = nodeEnv OR the database's own mark, with an unknown mark reading
// production. See the header for why the default leans this way.
function resolveProduction(env, options) {
  const nodeEnvIsProduction = env === 'production'
  let instanceMode = null
  let source = 'none'

  if (options.instanceMode !== undefined && options.instanceMode !== null) {
    if (!INSTANCE_MODES.includes(options.instanceMode)) {
      throw new InvalidConfigError(
        refusalHeader() +
          `\n  - instanceMode is ${JSON.stringify(options.instanceMode)}, which is not one of ${INSTANCE_MODES.join(', ')}.\n` +
          '    It mirrors instance.mode in the database, which is CHECKed to those two values.',
        [{ path: 'instanceMode', problem: 'not-allowed' }],
      )
    }
    instanceMode = options.instanceMode
    source = 'option'
  } else if (options.db !== undefined && options.db !== null) {
    try {
      instanceMode = readInstanceMode(options.db)
      source = instanceMode === null ? 'database-unstamped' : 'database'
    } catch {
      // A handle that cannot answer has not said "development". Swallowing the
      // cause is deliberate: the outcome is the strictest one available, so
      // there is nothing to recover from and nothing to decide.
      instanceMode = null
      source = 'database-unreadable'
    }
  }

  const defaulted = instanceMode === null
  return Object.freeze({
    production: nodeEnvIsProduction || instanceMode === 'production' || defaulted,
    instanceMode,
    source,
    defaulted,
    because: describeProductionCause(env, nodeEnvIsProduction, instanceMode, source, defaulted),
  })
}

function describeProductionCause(env, nodeEnvIsProduction, instanceMode, source, defaulted) {
  const parts = []
  if (nodeEnvIsProduction) parts.push('NODE_ENV is production')
  if (instanceMode === 'production') parts.push(`the database is marked production (from ${source})`)
  if (defaulted) {
    parts.push(
      source === 'none'
        ? 'no db handle and no instanceMode were supplied, so this process is treated as production'
        : `the deployment mode could not be read (${source}), so this process is treated as production`,
    )
  }
  if (parts.length === 0) {
    return `NODE_ENV is ${env} and the database is marked ${instanceMode}`
  }
  return parts.join('; ')
}

function readFlag(flag, config, envBag) {
  if (flag.source !== 'env') return read(config, flag.path)

  const raw = envBag === null || typeof envBag !== 'object' ? undefined : envBag[flag.path]
  if (raw === undefined || raw === null) return { present: false, value: undefined }
  // An empty assignment in an env file (DEV_BYPASS_DANMAKU=) is an absent flag,
  // not a flag set to the empty string; and trailing whitespace from a mounted
  // Secret must not turn "0" into an unrecognised value.
  const value = String(raw).trim()
  if (value === '') return { present: false, value: undefined }
  return { present: true, value }
}

function read(config, path) {
  let node = config
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object' || !(part in node)) {
      return { present: false, value: undefined }
    }
    node = node[part]
  }
  return { present: true, value: node }
}

function checkRequirement(config, req, { production }) {
  const { value } = read(config, req.path)
  const at = (problem, detail) => ({ path: req.path, problem, detail, secret: req.secret === true, why: req.why })

  if (value === undefined || value === null) return at('missing')

  switch (req.kind) {
    case 'string':
      if (typeof value !== 'string' || value.trim() === '') {
        return at('wrong-type', 'expected a non-empty string')
      }
      return null
    case 'path': {
      if (typeof value !== 'string' || value.trim() === '') {
        return at('wrong-type', 'expected a non-empty filesystem path')
      }
      // Relative paths resolve against the process cwd, which in a container is
      // whatever the image's WORKDIR happens to be. Locally that is merely
      // untidy; on the shared PVC it means writing the catalogue somewhere the
      // web pod does not mount.
      if (production && !value.startsWith('/')) {
        return at('not-allowed', `must be an absolute path in production, got "${value}"`)
      }
      return null
    }
    case 'integer':
      if (!Number.isInteger(value)) return at('wrong-type', `expected an integer, got ${JSON.stringify(value)}`)
      if (req.min !== undefined && value < req.min) return at('out-of-range', `${value} is below the minimum ${req.min}`)
      if (req.max !== undefined && value > req.max) return at('out-of-range', `${value} exceeds the ceiling ${req.max}`)
      return null
    case 'enum':
      if (!req.values.includes(value)) {
        return at('not-allowed', `expected one of ${req.values.map((v) => `"${v}"`).join(', ')}, got ${JSON.stringify(value)}`)
      }
      return null
    case 'boolean':
      if (typeof value !== 'boolean') return at('wrong-type', 'expected true or false')
      return null
    default:
      return at('wrong-type', `unknown requirement kind "${req.kind}"`)
  }
}

// ---------------------------------------------------------------------------
// Clearance: freeze what was cleared, remember what it said.

/**
 * Deep-freeze the config and every top-level section, then record a digest of
 * the values the clearance rested on — so that createDanmakuSource(config.danmaku)
 * and createTurnstile(config.turnstile) can both ask, and get an answer about
 * the values rather than about the object.
 *
 * Both halves are needed and neither is redundant: freezing stops an ordinary
 * assignment at the assignment, and the digest catches everything freezing
 * cannot reach — an accessor property, a Proxy, a section this walk declined to
 * freeze.
 */
function recordClearance(config, { env, production, requirements, envBag }) {
  const paths = decisionPaths(requirements)
  const envNames = BYPASS_FLAGS.filter((f) => f.source === 'env').map((f) => f.path)

  deepFreezeData(config)

  register(config, { env, production, paths, envBag, envNames })

  for (const [key, section] of Object.entries(config)) {
    if (section === null || typeof section !== 'object' || Array.isArray(section)) continue
    // The section's own record carries the paths that live inside it, relative
    // to it, so re-deriving the digest needs the section alone and never a
    // reference back to the whole config.
    register(section, {
      env,
      production,
      paths: pathsWithin(paths, key),
      envBag: null,
      envNames: [],
    })
  }
}

function register(target, record) {
  const entry = {
    env: record.env,
    production: record.production,
    paths: Object.freeze([...record.paths]),
    envBag: record.envBag,
    envNames: Object.freeze([...record.envNames]),
    digest: '',
  }
  entry.digest = clearanceDigest(target, entry)
  clearances.set(target, Object.freeze(entry))
}

// Every path the clearance decision read: the config-sourced bypass flags and
// every requirement, present or absent. Absence is recorded too, so a key that
// appears after the guard ran is a change like any other.
function decisionPaths(requirements) {
  const seen = new Set()
  for (const flag of BYPASS_FLAGS) {
    if (flag.source === 'config') seen.add(flag.path)
  }
  for (const req of requirements) {
    if (typeof req.path === 'string') seen.add(req.path)
  }
  return [...seen].sort()
}

function pathsWithin(paths, key) {
  const prefix = `${key}.`
  return paths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length))
}

// A digest rather than the values themselves: the requirement paths include
// access keys, and a second in-process copy of a secret is a second place it can
// be printed from.
function clearanceDigest(target, record) {
  const parts = [`env=${record.env}`, `production=${record.production ? '1' : '0'}`]

  for (const path of record.paths) {
    const { present, value } = read(target, path)
    parts.push(`cfg:${path}=${present ? tagOf(value) : '<absent>'}`)
  }
  for (const name of record.envNames) {
    const raw = record.envBag === null || typeof record.envBag !== 'object' ? undefined : record.envBag[name]
    parts.push(`env:${name}=${raw === undefined || raw === null ? '<absent>' : tagOf(String(raw))}`)
  }

  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

// A stable tag for a config leaf. Bounded on purpose: this runs on every
// development construction, and a config leaf is a scalar in every case the
// roster describes.
function tagOf(value, depth = 0, seen = new Set()) {
  if (value === null) return 'null'
  const type = typeof value
  if (type === 'string') return `s:${value}`
  if (type === 'number') return `n:${Object.is(value, -0) ? '-0' : String(value)}`
  if (type === 'boolean') return `b:${value}`
  if (type === 'bigint') return `i:${value}`
  if (type === 'undefined') return 'undefined'
  if (type === 'symbol') return `y:${String(value)}`
  // A function's behaviour lives in its closure, which nothing here can inspect.
  // What the roster decides on is whether one is present at all.
  if (type === 'function') return 'fn'
  if (seen.has(value)) return '<cycle>'
  if (depth >= 6) return '<deep>'
  seen.add(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => tagOf(item, depth + 1, seen)).join(',')}]`
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return `x:${proto?.constructor?.name ?? 'object'}`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${k}:${tagOf(value[k], depth + 1, seen)}`).join(',')}}`
}

/**
 * Freeze the plain-data spine of the config, in place.
 *
 * Deliberately partial, and the omissions are the point:
 *
 *   * functions are left alone. Freezing one protects nothing — its behaviour is
 *     in its closure — and it breaks a test double that records its own calls,
 *     i.e. the doubles that exercise the very paths this guard protects.
 *   * class instances, Map, Set, Date and anything else non-plain are left
 *     alone. Freezing an injected clock or a live handle breaks the thing
 *     without protecting any value the guard read.
 *
 * Whatever this walk declines to freeze is still covered, because the digest is
 * re-derived from the live object at construction time.
 *
 * Getters are never invoked here: the walk reads property descriptors, so a
 * side-effecting accessor is not fired by the act of freezing.
 */
function deepFreezeData(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return value

  const proto = Object.getPrototypeOf(value)
  const plain = Array.isArray(value) || proto === Object.prototype || proto === null
  if (!plain) return value

  seen.add(value)
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && 'value' in descriptor) deepFreezeData(descriptor.value, seen)
  }
  return Object.freeze(value)
}

// ---------------------------------------------------------------------------

// A problem line never contains the value of a secret. It says the key is wrong
// and stops there: a refusal message goes to stderr, stderr goes to the cluster
// log, and a cluster log is not a place to put an access key.
function describeProblem(p) {
  const head = `  - ${p.path}: ${p.problem}`
  if (p.secret) {
    const suffix = p.problem === 'missing' ? '' : ' (value withheld: this key is a secret)'
    return `${head}${suffix}${p.why ? `\n      ${p.why}` : ''}`
  }
  const detail = p.detail ? ` — ${p.detail}` : ''
  return `${head}${detail}${p.why ? `\n      ${p.why}` : ''}`
}

function refusalHeader() {
  return 'joi-button API refused to start.'
}

function problemMessage(problems) {
  const n = problems.length
  return [
    refusalHeader(),
    '',
    `${n} configuration ${n === 1 ? 'problem' : 'problems'}, all of them listed here so you only have to start once more:`,
    '',
    ...problems.map(describeProblem),
    '',
  ].join('\n')
}

function unsafeMessage(flags, problems, signals) {
  const lines = [
    refusalHeader(),
    '',
    `This process is PRODUCTION and ${flags.length} development ${flags.length === 1 ? 'bypass is' : 'bypasses are'} set.`,
    `Production because: ${signals.because}.`,
    '',
  ]
  for (const flag of flags) {
    const where = flag.source === 'env' ? 'environment' : 'config'
    lines.push(`  - ${where} ${flag.path}${flag.value === null ? ' is set' : ` = "${flag.value}"`}`)
    lines.push(`      ${flag.effect}`)
  }
  lines.push('')
  lines.push('These exist so the rest of the submission path can be exercised without a live')
  lines.push('room and without Cloudflare. There is deliberately no production override: an')
  lines.push('override is the thing that eventually gets used.')
  if (signals.defaulted) {
    lines.push('')
    lines.push('If this really is a development instance, say so rather than leaving it unsaid:')
    lines.push('pass the database handle (options.db) — migrate() marks it, and the mark is a')
    lines.push('one-way ratchet — or pass options.instanceMode when you have already read it.')
    lines.push('An unstated deployment mode is read as production, always.')
  }
  if (problems.length > 0) {
    lines.push('')
    lines.push(`The configuration also has ${problems.length} other ${problems.length === 1 ? 'problem' : 'problems'}:`)
    lines.push('')
    lines.push(...problems.map(describeProblem))
  }
  lines.push('')
  return lines.join('\n')
}

// vue-i18n reads `{name}` as an interpolation slot, `@:key` AND `@.mod:key` as
// linked messages (its linkKeyMatcher accepts an optional modifier between the @
// and the colon: `@.lower:some.key`), and `|` as a plural separator. Banner text
// is authored here and rendered there, so it is checked here.
//
// NOT a duplicate of text-safety.mjs's escapeForI18n, and must not be replaced
// by it: that one neutralises text a submitter wrote, where mangling the input
// is the correct outcome. This one refuses text a DEVELOPER wrote, where silent
// mangling would ship a garbled security banner. Same hazard, opposite remedy —
// escape what you cannot control, refuse what you can.
function assertVueI18nSafe(text, where) {
  const offenders = []
  if (/[{}]/.test(text)) offenders.push('{ or }')
  if (/@(?:\.[A-Za-z]+)?:/.test(text)) offenders.push('@: or @.modifier:')
  if (/\|/.test(text)) offenders.push('|')
  if (offenders.length > 0) {
    throw new Error(
      `env-guard: banner text (${where}) contains vue-i18n syntax [${offenders.join(', ')}]. ` +
        'The frontend renders this string through $t; rewrite it without those characters.',
    )
  }
  return text
}

// The other half of the i18n rule, for values this file did not author. One
// allowlist covers both hazards at once: it drops every vue-i18n metacharacter
// AND every byte that could split an HTTP header, since this same string is
// emitted as X-Joi-Bypass. Capped, because an env var has no length limit and a
// banner is read by a human.
const UNSAFE_FLAG_VALUE = /[^A-Za-z0-9._:=,-]/g

function sanitizeFlagValue(value) {
  return String(value).replace(UNSAFE_FLAG_VALUE, '?').slice(0, 64)
}

// A descriptor, not markup: the API can serve it, the frontend can render it,
// and both can translate it from `messageKey` — which is a pinned immutable id
// for exactly the reason the catalogue's i18n keys are.
function buildBanner(nodeEnv, bypasses) {
  if (bypasses.length === 0) return null

  const refusing = bypasses.some((b) => b.severity === 'refuse')
  const headline = refusing
    ? 'IDENTITY AND CHALLENGE CHECKS ARE BYPASSED - do not accept a release against this environment'
    : 'CHALLENGE POLICY IS OVERRIDDEN BY AN OPERATOR SWITCH'
  const detail = refusing
    ? 'This build accepts submissions without verifying who sent them. Nothing seen here is evidence that the production path works.'
    : 'Submissions are accepted without demanding a Turnstile challenge. Tokens that are presented are still verified.'

  return Object.freeze({
    id: 'env-bypass',
    messageKey: refusing ? 'banner.envBypassUnverified' : 'banner.envChallengeOff',
    severity: refusing ? 'bypass' : 'degraded',
    nodeEnv,
    headline: assertVueI18nSafe(headline, 'headline'),
    detail: assertVueI18nSafe(detail, 'detail'),
    flags: Object.freeze(
      bypasses.map((b) =>
        Object.freeze({
          path: b.path,
          source: b.source,
          value: b.value,
          effect: assertVueI18nSafe(b.effect, `effect of ${b.path}`),
        }),
      ),
    ),
    // NOTHING CONSUMES THIS TODAY, and saying so is the whole point of this
    // comment: the text that stood here claimed the smoke test asserted the
    // header, and `grep -ril x-joi-bypass deploy/ server/` returns exactly one
    // file — this one. A claimed assertion that does not exist is worse than an
    // absent one, because it is counted as covered.
    //
    // The contract an HTTP layer owes this object when it arrives: when
    // report.banner is not null, set the header on EVERY response —
    //     res.setHeader(report.banner.httpHeader.name, report.banner.httpHeader.value)
    // — and serve report.banner itself as the `banner` field of the health
    // document, so the answer is available to a machine and to a human.
    //
    // The assertion deploy/smoke-image.sh should then adopt VERBATIM (its hdr /
    // check / refute helpers are defined at smoke-image.sh:77-96):
    //
    //     refute "production sends no bypass header"  "x-joi-bypass"  "$(hdr /api/healthz)"
    //     check  "development does send the header"   "x-joi-bypass"  "$(hdr /api/healthz)"
    //
    // Both lines, not the first alone. The refute passes against a container
    // that serves no such header for any reason at all, including a typo in the
    // name and a build where the header was never wired up — that is a gate that
    // cannot go red. The check, run against a container started with a
    // development instance, is what proves the refute can fail.
    httpHeader: Object.freeze({
      name: 'X-Joi-Bypass',
      value: bypasses.map((b) => (b.value === null ? b.path : `${b.path}=${b.value}`)).join(','),
    }),
  })
}
