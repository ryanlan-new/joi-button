import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  countDeclarationsAtCommit,
  evaluateTestCount,
  formatGateResult,
  loadBaseline,
} from './test-count-gate.mjs'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const run = spawnSync(process.execPath, ['--test', ...args], {
  cwd: serverDir,
  encoding: 'utf8',
})

if (run.stdout) process.stdout.write(run.stdout)
if (run.stderr) process.stderr.write(run.stderr)

const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
const counts = [...output.matchAll(/\btests\s+(\d+)/g)]
const currentTests = counts.length === 0 ? Number.NaN : Number(counts.at(-1)[1])
let gate
try {
  const baseline = loadBaseline()
  gate = evaluateTestCount({
    baseline,
    currentTests,
    baselineCommitDeclarations: countDeclarationsAtCommit(baseline.baselineCommit),
  })
  console.log(formatGateResult(gate))
} catch (error) {
  console.error(`TEST_COUNT_GATE fail: ${error.message}`)
  gate = { ok: false }
}

const testStatus = run.status === null ? 1 : run.status
process.exitCode = testStatus === 0 && gate.ok ? 0 : 1
