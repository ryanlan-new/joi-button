// API credentials are deliberately a different signing domain from browser
// sessions. The raw value is returned only at issuance time; the database stores
// its SHA-256, just like it stores browser-session hashes.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const TOKEN_PREFIX = 'jbat_'
const TOKEN_PATTERN = /^jbat_[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/

export function createApiTokenService(secret) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new TypeError('api token service needs the session secret')
  }

  const domainKey = createHmac('sha256', secret).update('api-token').digest()

  function sign(body) {
    return createHmac('sha256', domainKey).update(body).digest('base64url')
  }

  function mint(seed = randomBytes(32).toString('base64url')) {
    const body = `${TOKEN_PREFIX}${seed}`
    return `${body}.${sign(body)}`
  }

  function verify(value) {
    if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) return false
    const dot = value.lastIndexOf('.')
    const body = value.slice(0, dot)
    const supplied = Buffer.from(value.slice(dot + 1), 'base64url')
    const expected = Buffer.from(sign(body), 'base64url')
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  }

  return Object.freeze({
    mint,
    verify,
    hash(value) {
      return createHash('sha256').update(value, 'utf8').digest('hex')
    },
  })
}

export const API_TOKEN_TTL_MINUTES = 30 * 24 * 60
export const API_TOKEN_LIMIT = 5
