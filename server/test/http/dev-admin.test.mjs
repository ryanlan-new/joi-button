// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from '../../app.mjs'
import { boot, get, cookieOf } from './harness.mjs'

test('an assembled development server admits the local admin without a login cookie', async (t) => {
  const { app } = await boot(t, { adminOpenIds: [], devAdminBypass: true })

  const me = await get(app, '/api/me')
  assert.equal(me.statusCode, 200)
  assert.match(cookieOf(me) ?? '', /^joi_session=/)
  assert.equal(me.json().submitter.openId, 'local-dev-admin')
  assert.equal(me.json().submitter.admin, true)

  const queue = await get(app, '/api/admin/queue')
  assert.equal(queue.statusCode, 200)
  assert.equal(queue.json().itemCount, 0)
})

test('the local admin bypass is rejected when the guard reports production', async (t) => {
  const { config, db, danmaku, storageGuard, report } = await boot(t)

  assert.throws(() => createApp({
    config,
    db,
    danmaku,
    storageGuard,
    logger: false,
    report: { ...report, nodeEnv: 'production', production: true },
    devAdminBypass: true,
  }), /devAdminBypass is only valid for a development report/)
})
