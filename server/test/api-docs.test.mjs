import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { PUBLIC_REASONS } from '../routes/public.mjs'

const docs = readFileSync(join(import.meta.dirname, '../../docs/api.md'), 'utf8')
const example = readFileSync(join(import.meta.dirname, '../../docs/api-client.mjs'), 'utf8')

test('the API error table is exactly the server contract', () => {
  const documented = [...docs.matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map((match) => match[1])
  assert.deepEqual(documented, Object.keys(PUBLIC_REASONS).sort())
})

test('the dependency-free client follows the live contract and token flow', () => {
  for (const marker of [
    '/api/submit/contract',
    '/api/auth/challenge',
    '/api/auth/poll',
    '/api/submit',
    'Authorization: `Bearer ${verified.token}`',
    "'User-Agent': userAgent",
    "form.set('file:clip-1'",
    'batchId',
  ]) {
    assert.ok(example.includes(marker), `example is missing ${marker}`)
  }
  assert.equal(/SESSION_SECRET|joi\.db|10\.\d+\.\d+\.\d+/.test(example), false)
})
