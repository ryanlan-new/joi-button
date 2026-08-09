// SPDX-License-Identifier: MIT
//
// /api/healthz, /api/readyz and /api/health, over the assembled server.
//
// These three were the only routes in the application with no test at all, and
// they are the three an operator's tooling depends on: deploy/k8s/api-deployment.yaml
// points its startup and readiness probes at readyz and its liveness probe at
// healthz, and deploy/deploy-k3s.sh greps a SUBSTRING out of the readyz body
// after every deploy. That grep is the reason this file pins the serialised
// shape and not just the parsed one — a key reordered inside `checks.database`
// would leave every assertion on `json.checks.database.status` green while
// silently turning the deploy gate into one that can never pass.
//
// The split the probes depend on:
//   healthz  a constant document. It proves the process is alive and it CANNOT
//            fail on a broken database — which is why it is the liveness probe.
//            A liveness probe that watched the database would restart the pod
//            over a volume problem a restart does not fix.
//   readyz   opens a savepoint on the real database, writes, and rolls back. It
//            is the readiness probe, and it is what takes the pod out of the
//            service when the volume is gone or read-only.
//
// Both halves are exercised here in BOTH directions: the database is closed
// under the running app to make readyz go red while healthz stays green.

import assert from 'node:assert/strict'
import test from 'node:test'

import { boot, get } from './harness.mjs'

// The exact byte sequence deploy/deploy-k3s.sh matches on after a rollout.
// Copied here as a literal rather than built from parts, because the point is to
// notice when the bytes change.
const DEPLOY_GATE_SUBSTRING = '"database":{"status":"ok"'

test('healthz proves the process and says nothing about the database', async (t) => {
  const { app } = await boot(t)

  const answer = await get(app, '/api/healthz')
  assert.equal(answer.statusCode, 200)

  const body = answer.json()
  assert.equal(body.status, 'ok')
  assert.equal(body.check, 'process')
  assert.equal(typeof body.uptimeSeconds, 'number')
  assert.ok(body.uptimeSeconds >= 0)
  // Second-precision canonical timestamps, the same producer the rest of the
  // system uses. A millisecond form here would be a second timestamp dialect in
  // a document operators diff against log lines.
  for (const field of ['startedAt', 'checkedAt']) {
    assert.match(body[field], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, field)
  }

  // The claim in app.mjs's own comment, asserted rather than believed: this
  // document must not mention the database at all, or a liveness probe would
  // start depending on it by accident.
  assert.equal('checks' in body, false)
  assert.equal(answer.payload.includes('database'), false)
})

test('readyz reports the database check, in the exact bytes the deploy gate greps for', async (t) => {
  const { app } = await boot(t)

  const answer = await get(app, '/api/readyz')
  assert.equal(answer.statusCode, 200)

  const body = answer.json()
  assert.equal(body.status, 'ok')
  assert.deepEqual(body.readiness, ['process', 'database'])
  assert.equal(body.checks.process.status, 'ok')
  assert.equal(body.checks.database.status, 'ok')
  assert.equal(body.checks.database.writable, true)
  assert.equal(body.checks.database.code, null)
  assert.equal(typeof body.checks.database.schemaVersion, 'number')

  // instance.mode is a deployment fact and this document is published; app.mjs
  // keeps it out on purpose.
  assert.equal(answer.payload.includes('"mode"'), false)

  assert.ok(
    answer.payload.includes(DEPLOY_GATE_SUBSTRING),
    `deploy/deploy-k3s.sh greps for ${DEPLOY_GATE_SUBSTRING} after every rollout and this body does not contain it: ${answer.payload}`,
  )
})

test('readyz goes red on a database it cannot use, and healthz does not', async (t) => {
  const { app, db } = await boot(t)

  // The failure a shared PVC actually has, reproduced from the one side a test
  // can reach: the handle stops working under the running app. probeDatabase's
  // first branch answers DATABASE_CLOSED for it.
  db.close()

  const ready = await get(app, '/api/readyz')
  assert.equal(ready.statusCode, 503, 'a pod with an unusable database stayed in the service')
  const body = ready.json()
  assert.equal(body.status, 'error')
  assert.equal(body.checks.database.status, 'error')
  assert.equal(body.checks.database.writable, false)
  assert.equal(body.checks.database.code, 'DATABASE_CLOSED')
  // The deploy gate's substring must NOT be present now. Without this the gate
  // could be satisfied by a body that also carried a red check somewhere else.
  assert.equal(ready.payload.includes(DEPLOY_GATE_SUBSTRING), false)

  // The other half of the split: liveness is unaffected, so kubelet does not
  // restart a pod over a volume problem that a restart cannot fix.
  const live = await get(app, '/api/healthz')
  assert.equal(live.statusCode, 200)
  assert.equal(live.json().status, 'ok')
})

test('health carries the limits and the bypass banner, and the room session is reported rather than counted', async (t) => {
  const { app } = await boot(t)

  const answer = await get(app, '/api/health')
  assert.equal(answer.statusCode, 200)

  const body = answer.json()
  assert.equal(body.status, 'ok')
  // roomSession is in `checks` but NOT in `readiness`. The room is listened to
  // on demand — started when a visitor asks for a code, stopped on success or at
  // the ruled 10-minute expiry — so "not listening" is its normal state, and
  // folding it into readiness would take the pod out of service for behaving as
  // designed. This asserts that separation directly.
  assert.deepEqual(body.readiness, ['process', 'database'])
  assert.ok('roomSession' in body.checks)
  assert.equal(body.checks.roomSession.listening, false)
  assert.equal(body.checks.roomSession.expected, false)

  assert.equal(body.limits.maxClipsPerBatch, 10)
  assert.equal(body.limits.maxFileBytes, 5 * 1024 * 1024)
  assert.equal(typeof body.storage.totalBytes, 'number')
  assert.equal(typeof body.storage.usedBytes, 'number')
  assert.equal(typeof body.storage.availableBytes, 'number')
  assert.equal(body.storage.reserveBytes, 256 * 1024 * 1024)
  assert.equal(typeof body.storage.inflightBytes, 'number')
  assert.equal(typeof body.storage.refusing, 'boolean')
  assert.equal(body.readiness.includes('storage'), false)

  // This harness runs the development danmaku bypass, so the banner MUST be
  // present here. A null banner in this
  // fixture would mean the banner is not being produced at all, and the
  // production-side guarantee — env-guard refuses to start with a bypass in
  // production — would be the only thing left holding, with nothing observable
  // to confirm the other half of its contract.
  assert.notEqual(body.banner, null, 'a bypassed build published no banner')
  assert.equal(
    answer.headers['x-joi-bypass'] !== undefined,
    true,
    'the banner header is the other half of the contract and it is missing',
  )
})
