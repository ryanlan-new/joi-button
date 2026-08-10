import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_DIR = resolve(SERVER_DIR, '..')
const BASELINE_PATH = join(SERVER_DIR, 'test-count-baseline.json')

// These are deliberately repeated in executable code. The baseline JSON is the
// readable, reviewed record; this small anchor makes changing its number alone
// fail closed instead of turning the guard into a comparison with itself.
export const CANONICAL_BASELINE = Object.freeze({
  baselineCommit: '4a5cc60',
  baselineTests: 460,
  baselineDeclarations: 449,
  runnerAdjustment: 11,
})

export function loadBaseline(path = BASELINE_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Count top-level node:test declarations in a committed test tree. */
export function countDeclarationsAtCommit(commit, { repoDir = REPO_DIR } = {}) {
  const result = spawnSync(
    'git',
    ['-C', repoDir, 'grep', '-h', '-E', '^[[:space:]]*test[[:space:]]*\\(', commit, '--', 'server/test'],
    { encoding: 'utf8' },
  )
  // git grep returns 1 for no matches; a missing commit or another git error is
  // a gate failure, not a zero-test baseline.
  if (result.error !== undefined) throw result.error
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`could not inspect test baseline ${commit}: ${result.stderr || `git exit ${result.status}`}`)
  }
  return result.stdout.split('\n').filter((line) => line.length > 0).length
}

function validateRegistration(registration) {
  const seen = new Set()
  for (const item of registration) {
    if (typeof item?.path !== 'string' || item.path === '') throw new Error('test-count gate: deletion path is required')
    if (seen.has(item.path)) throw new Error(`test-count gate: duplicate deletion registration ${item.path}`)
    seen.add(item.path)
    if (!Number.isInteger(item.tests) || item.tests < 0) {
      throw new Error(`test-count gate: deletion count is invalid for ${item.path}`)
    }
    if (typeof item.reason !== 'string' || item.reason.trim() === '') {
      throw new Error(`test-count gate: deletion reason is required for ${item.path}`)
    }
  }
  return registration
}

export function evaluateTestCount({
  baseline,
  currentTests,
  baselineCommitDeclarations,
  registeredDeletions = baseline.registeredDeletions,
} = {}) {
  const failures = []
  const registration = validateRegistration(registeredDeletions ?? [])
  const known = baseline.knownDeletions ?? [
    ...(baseline.registeredDeletions ?? []).filter((item) => item.class !== 'authorized'),
  ]
  const registeredPaths = new Set(registration.map((item) => item.path))
  const unregistered = known.filter((item) => !registeredPaths.has(item.path))
  const unregisteredUnauthorized = unregistered.filter((item) => item.class !== 'authorized')

  if (baseline.baselineCommit !== CANONICAL_BASELINE.baselineCommit) {
    failures.push(`baseline commit changed from ${CANONICAL_BASELINE.baselineCommit}`)
  }
  if (baseline.baselineTests !== CANONICAL_BASELINE.baselineTests) {
    failures.push(
      `baseline tests changed from ${CANONICAL_BASELINE.baselineTests} to ${baseline.baselineTests} without changing the executable anchor`,
    )
  }
  if (baseline.baselineDeclarations !== CANONICAL_BASELINE.baselineDeclarations) {
    failures.push(`baseline declaration count changed from ${CANONICAL_BASELINE.baselineDeclarations}`)
  }
  if (baseline.runnerAdjustment !== CANONICAL_BASELINE.runnerAdjustment) {
    failures.push(`runner adjustment changed from ${CANONICAL_BASELINE.runnerAdjustment}`)
  }
  if (
    Number.isInteger(baselineCommitDeclarations) &&
    baselineCommitDeclarations !== baseline.baselineDeclarations
  ) {
    failures.push(
      `baseline commit has ${baselineCommitDeclarations} declarations, but the committed record says ${baseline.baselineDeclarations}`,
    )
  }
  if (baseline.baselineTests - baseline.baselineDeclarations !== baseline.runnerAdjustment) {
    failures.push('baseline tests, declarations, and runner adjustment do not reconcile')
  }
  if (!Number.isInteger(currentTests) || currentTests < 0) failures.push('current test count is not an integer')

  const registeredTests = registration.reduce((sum, item) => sum + item.tests, 0)
  const minimum = baseline.baselineTests - registeredTests
  if (currentTests < minimum) {
    failures.push(`current tests ${currentTests} are below the registered floor ${minimum}`)
  }
  if (currentTests < baseline.baselineTests && unregistered.length > 0) {
    failures.push(
      `current tests are below baseline with unregistered deletion items: ${unregistered
        .map((item) => `${item.path} (${item.tests})`)
        .join(', ')}`,
    )
  }

  return {
    ok: failures.length === 0,
    failures,
    baselineTests: baseline.baselineTests,
    currentTests,
    registeredTests,
    minimum,
    unregistered,
    unregisteredUnauthorized,
  }
}

export function formatGateResult(result) {
  const headline = `TEST_COUNT_GATE ${result.ok ? 'pass' : 'fail'} baseline=${result.baselineTests} current=${result.currentTests} registered=${result.registeredTests} floor=${result.minimum}`
  if (result.ok) return headline
  const details = result.failures.map((failure) => `- ${failure}`).join('\n')
  return `${headline}\n${details}`
}
