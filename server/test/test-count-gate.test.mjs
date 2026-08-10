import assert from 'node:assert/strict'
import test from 'node:test'

import {
  countDeclarationsAtCommit,
  evaluateTestCount,
  loadBaseline,
} from '../scripts/test-count-gate.mjs'

const baseline = loadBaseline()

test('INC-014: the gate rejects a09fd5c and names all seven unauthorized deletion items', () => {
  const result = evaluateTestCount({
    baseline,
    currentTests: 301,
    baselineCommitDeclarations: countDeclarationsAtCommit(baseline.baselineCommit),
    registeredDeletions: [],
  })

  assert.equal(result.ok, false)
  assert.deepEqual(
    result.unregisteredUnauthorized.map((item) => item.path),
    [
      'server/test/routes-public.test.mjs',
      'server/test/http/submit.test.mjs',
      'server/test/http/journey.test.mjs',
      'server/test/timestamps.test.mjs',
      'server/test/schema-dev-bypass.test.mjs',
      'server/test/env-guard.test.mjs',
      'server/test/schema-batches.test.mjs',
    ],
  )
})

test('INC-014: the same 301-test state passes only after every deletion is registered with a reason', () => {
  const result = evaluateTestCount({
    baseline,
    currentTests: 301,
    baselineCommitDeclarations: countDeclarationsAtCommit(baseline.baselineCommit),
  })
  assert.equal(result.ok, true)
  assert.equal(result.registeredTests, 175)
  assert.equal(result.minimum, 285)
})

test('INC-014: editing the baseline number to 301 without registration remains red', () => {
  const edited = { ...baseline, baselineTests: 301, registeredDeletions: [] }
  const result = evaluateTestCount({
    baseline: edited,
    currentTests: 301,
    baselineCommitDeclarations: countDeclarationsAtCommit(baseline.baselineCommit),
    registeredDeletions: [],
  })

  assert.equal(result.ok, false)
  assert.match(result.failures.join('\n'), /baseline tests changed|reconcile/)
})

test('INC-014: removing the comparison-to-baseline leg is mutation-red', () => {
  const result = evaluateTestCount({
    baseline,
    currentTests: 301,
    baselineCommitDeclarations: countDeclarationsAtCommit(baseline.baselineCommit),
    registeredDeletions: [],
  })
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((failure) => failure.includes('unregistered deletion items')))
})
