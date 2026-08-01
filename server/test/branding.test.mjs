// Unit coverage for lib/branding.mjs — the pieces the admin routes lean on and
// the two joints a review found thin: the atomic-write temp name (which must
// stay a dot-file so nginx refuses a crash-leftover) and readBranding's refusal,
// which must THROW on an unreadable file rather than pretend the file is empty,
// because the route above relies on that throw reaching the error envelope.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  BRANDING_TEMP_PREFIX,
  BrandingError,
  emptyBranding,
  readBranding,
  storeFavicon,
  writeBranding,
} from '../lib/branding.mjs'

function dir(t) {
  const d = mkdtempSync(join(tmpdir(), 'joi-button-branding-'))
  t.after(() => rmSync(d, { recursive: true, force: true }))
  return d
}

// Eight magic bytes are all faviconFormat reads for PNG; storeFavicon never
// decodes, so a header plus padding is a legal favicon for its purposes.
function png() {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 7)])
}

test('a favicon temp name keeps the leading dot that deploy/nginx.conf refuses', async (t) => {
  // The /branding/ location's nested `location ~ /\.` is the only thing between a
  // crash-leftover temp and a partial icon served `public, immutable` for a year,
  // and it keys on the LEADING dot. Nothing mechanical ties the two files, so a
  // temp renamed to `branding-tmp-<pid>` would slip out from under the guard with
  // every other test still green. This is the line that goes red instead.
  assert.equal(BRANDING_TEMP_PREFIX.startsWith('.'), true, 'nginx refuses dot segments; the temp must be one')

  const faviconDir = join(dir(t), 'branding')
  const stored = await storeFavicon(png(), { faviconDir })
  // A successful store leaves the published file and nothing else — so the prefix
  // is really the name in use, not decoration off to the side.
  assert.deepEqual(readdirSync(faviconDir), [stored.path])
  assert.equal(stored.path.startsWith(BRANDING_TEMP_PREFIX), false, 'a temp name was published')
  assert.match(stored.path, /^[0-9a-f]{64}\.png$/)
})

test('readBranding returns the empty shape when branding.json is absent', async (t) => {
  const branding = await readBranding(join(dir(t), 'branding.json'))
  assert.deepEqual(branding, emptyBranding())
})

test('readBranding surfaces an unreadable file as read_failed rather than pretending it is empty', async (t) => {
  // ENOENT is "nothing edited yet" and answers empty; any other read failure is a
  // real fault the route must turn into an error envelope. A directory where the
  // file is expected raises EISDIR, which stands in for the EACCES a wrong-owner
  // volume would raise in production.
  const asDir = join(dir(t), 'branding.json')
  mkdirSync(asDir)
  await assert.rejects(readBranding(asDir), (error) => {
    assert.ok(error instanceof BrandingError)
    assert.equal(error.code, 'read_failed')
    return true
  })
})

test('a hand-corrupted branding.json degrades to empty rather than bricking the form', async (t) => {
  const file = join(dir(t), 'branding.json')
  writeFileSync(file, '{ this is not json')
  assert.deepEqual(await readBranding(file), emptyBranding())
})

test('writeBranding round-trips and refuses a non-http(s) channel href before writing a byte', async (t) => {
  const file = join(dir(t), 'branding.json')
  const written = await writeBranding(file, {
    navTitle: { 'zh-CN': '轴伊按钮' },
    channel: { href: 'https://space.bilibili.com/61639371' },
  })
  assert.equal(written.channel.href, 'https://space.bilibili.com/61639371')
  assert.equal(written.navTitle['zh-CN'], '轴伊按钮')
  assert.deepEqual(await readBranding(file), written)

  await assert.rejects(
    writeBranding(file, { channel: { href: 'javascript:alert(1)' } }),
    (error) => error instanceof BrandingError && error.code === 'invalid_request',
  )
  // The refused write left the good document in place, untouched.
  assert.equal((await readBranding(file)).channel.href, 'https://space.bilibili.com/61639371')
})
