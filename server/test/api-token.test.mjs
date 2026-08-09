import assert from 'node:assert/strict'
import test from 'node:test'

import { createApiTokenService, API_TOKEN_LIMIT, API_TOKEN_TTL_MINUTES } from '../lib/api-token.mjs'

const SECRET = 'test-session-secret-'.padEnd(48, 'x')

test('API tokens are signed in their own domain and only the raw value verifies', () => {
  const service = createApiTokenService(SECRET)
  const token = service.mint('a'.repeat(43))

  assert.match(token, /^jbat_[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/)
  assert.equal(service.verify(token), true)
  assert.equal(service.verify(token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a')), false)
  assert.equal(service.verify('browser-session-token'), false)
  assert.equal(service.hash(token).length, 64)
})

test('API credential policy is explicit', () => {
  assert.equal(API_TOKEN_TTL_MINUTES, 30 * 24 * 60)
  assert.equal(API_TOKEN_LIMIT, 5)
  assert.throws(() => createApiTokenService('short'), /session secret/)
})
