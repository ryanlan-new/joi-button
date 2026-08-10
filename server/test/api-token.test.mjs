import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { createSessionCookie } from '../app.mjs'
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

  // The token and browser-cookie services intentionally share the session
  // secret but not the signing domain. These are the cross-service properties
  // the original self-contained assertions could not observe.
  const cookies = createSessionCookie({ secret: SECRET, secure: false, ttlHours: 1 })
  const cookieValue = cookies.mint()
  const apiValue = service.mint('b'.repeat(43))
  assert.equal(cookies.verify(apiValue), false)
  assert.equal(service.verify(cookieValue), false)
})

test('API credential policy is explicit', () => {
  assert.equal(API_TOKEN_TTL_MINUTES, 30 * 24 * 60)
  assert.equal(API_TOKEN_LIMIT, 5)
  assert.throws(() => createApiTokenService('short'), /session secret/)
})

test('the cross-service signing-domain assertions remain present in this test file', () => {
  const source = readFileSync(new URL('./api-token.test.mjs', import.meta.url), 'utf8')
  assert.match(source, /assert\.equal\(\s*cookies\.verify\(\s*apiValue/)
  assert.match(source, /assert\.equal\(\s*service\.verify\(\s*cookieValue/)
})
