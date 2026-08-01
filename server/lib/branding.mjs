// SPDX-License-Identifier: MIT
//
// Site branding an admin can edit without a rebuild: the navbar title, the
// document <title>, the channel link, and the favicon. It is delivered exactly
// the way the catalogue and the theme are — the API writes one file to DATA_DIR,
// the web pod serves it read-only at a stable URL, and the frontend applies it
// on load. When the file is absent (a first deploy, or nothing edited yet) the
// frontend keeps the values compiled into its bundle, so a deploy with no
// branding.json renders exactly as the site shipped.
//
// The favicon is content-addressed (`<sha256>.<ext>`) so it can be cached
// immutably, the same promise /wallpaper/ and /media/ keep. branding.json itself
// changes in place at a stable name and is served no-cache, like theme.css.

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export class BrandingError extends Error {
  constructor(message, code, details = null) {
    super(message)
    this.name = 'BrandingError'
    this.code = code
    this.details = details
  }
}

// The three locales the site ships. A branding text field is a map over exactly
// these; an unknown locale key is dropped rather than stored.
export const BRANDING_LOCALES = Object.freeze(['zh-CN', 'en-US', 'ja-JP'])

const TEXT_MAX = 80
const HREF_MAX = 300
const FAVICON_MAX_BYTES = 256 * 1024

export const FAVICON_URL_PREFIX = '/branding/'
const FAVICON_NAME_PATTERN = /^[0-9a-f]{64}\.(?:png|ico)$/

// Temp files during the atomic writes below carry a LEADING dot so the web pod's
// dotfile guard (nginx `location ~ /\.` inside `^~ /branding/`) refuses to serve
// a crash-leftover — the same joint lib/wallpaper.mjs's TEMP_NAME_PREFIX guards.
// Both writeBranding and storeFavicon build their temp names from this.
export const BRANDING_TEMP_PREFIX = '.branding-'

// The empty shape. Every field blank means "use the bundle's default", so a
// fresh install and a cleared field render identically.
export function emptyBranding() {
  const langs = () => Object.fromEntries(BRANDING_LOCALES.map((l) => [l, '']))
  return {
    navTitle: langs(),
    docTitle: langs(),
    channel: { label: langs(), href: '' },
    faviconPath: null,
  }
}

// Read branding.json, or the empty shape when it is absent or unreadable — the
// frontend treats both the same, and a corrupt file must not take the admin
// form down. A parse failure is surfaced (thrown) only through writeBranding's
// validation, never here.
export async function readBranding(brandingFile) {
  let text
  try {
    text = await readFile(brandingFile, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyBranding()
    throw new BrandingError(`branding: cannot read ${brandingFile}`, 'read_failed', { detail: error?.message ?? null })
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // A hand-corrupted file should not brick the form. Report the empty shape;
    // the next save overwrites the bad bytes.
    return emptyBranding()
  }
  return normalise(parsed)
}

// Validate and write branding.json atomically (temp + rename), 0600 like the
// runtime secret's siblings. Returns the normalised branding it wrote.
export async function writeBranding(brandingFile, input) {
  const branding = validateBranding(input)
  await mkdir(dirname(brandingFile), { recursive: true })
  // Leading-dot temp name, and unlink it if the write or rename fails: the web
  // pod's dotfile guard (nginx `location ~ /\.`) refuses to serve a leading-dot
  // file, so a crash mid-write cannot leave a half-written temp publicly
  // fetchable — the convention lib/wallpaper.mjs set and storeFavicon shares.
  const tmp = join(dirname(brandingFile), `${BRANDING_TEMP_PREFIX}write-${process.pid}`)
  try {
    await writeFile(tmp, JSON.stringify(branding), { mode: 0o644 })
    await rename(tmp, brandingFile)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
  return branding
}

// Coerce an arbitrary parsed object into the branding shape, dropping anything
// unexpected. Used on READ, where leniency is right: an older or partial file
// should yield usable defaults, not an error.
function normalise(raw) {
  const base = emptyBranding()
  if (raw === null || typeof raw !== 'object') return base
  const langMap = (value) => {
    const out = {}
    for (const l of BRANDING_LOCALES) {
      out[l] = raw && typeof value === 'object' && value !== null && typeof value[l] === 'string'
        ? value[l].slice(0, TEXT_MAX)
        : ''
    }
    return out
  }
  base.navTitle = langMap(raw.navTitle)
  base.docTitle = langMap(raw.docTitle)
  const channel = raw.channel && typeof raw.channel === 'object' ? raw.channel : {}
  base.channel = {
    label: langMap(channel.label),
    href: typeof channel.href === 'string' ? channel.href.slice(0, HREF_MAX) : '',
  }
  base.faviconPath =
    typeof raw.faviconPath === 'string' && FAVICON_NAME_PATTERN.test(raw.faviconPath) ? raw.faviconPath : null
  return base
}

// Validate on WRITE, where strictness is right: a value that cannot be stored is
// refused with a message naming the field, not silently dropped.
export function validateBranding(input) {
  if (input === null || typeof input !== 'object') {
    throw new BrandingError('branding must be an object', 'invalid_request', { field: null })
  }
  const cleanLangMap = (value, field) => {
    const out = {}
    for (const l of BRANDING_LOCALES) {
      const v = value && typeof value === 'object' ? value[l] : ''
      if (v === undefined || v === null || v === '') { out[l] = ''; continue }
      if (typeof v !== 'string') {
        throw new BrandingError(`${field}.${l} must be a string`, 'invalid_request', { field: `${field}.${l}` })
      }
      const trimmed = v.trim()
      if (trimmed.length > TEXT_MAX) {
        throw new BrandingError(`${field}.${l} is longer than ${TEXT_MAX} characters`, 'invalid_request', {
          field: `${field}.${l}`,
        })
      }
      out[l] = trimmed
    }
    return out
  }

  const channel = input.channel && typeof input.channel === 'object' ? input.channel : {}
  const href = channel.href
  let cleanHref = ''
  if (href !== undefined && href !== null && href !== '') {
    if (typeof href !== 'string') {
      throw new BrandingError('channel.href must be a string', 'invalid_request', { field: 'channel.href' })
    }
    const trimmed = href.trim()
    if (trimmed.length > HREF_MAX) {
      throw new BrandingError(`channel.href is longer than ${HREF_MAX} characters`, 'invalid_request', {
        field: 'channel.href',
      })
    }
    // http/https ONLY. A javascript: or data: href in a link the whole site
    // renders is a stored-XSS vector; the scheme is checked here, before the byte
    // is ever written, rather than trusted in the template.
    let url
    try {
      url = new URL(trimmed)
    } catch {
      throw new BrandingError('channel.href must be an absolute http(s) URL', 'invalid_request', {
        field: 'channel.href',
      })
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BrandingError('channel.href must use http or https', 'invalid_request', { field: 'channel.href' })
    }
    cleanHref = trimmed
  }

  let faviconPath = null
  if (input.faviconPath !== undefined && input.faviconPath !== null && input.faviconPath !== '') {
    if (typeof input.faviconPath !== 'string' || !FAVICON_NAME_PATTERN.test(input.faviconPath)) {
      throw new BrandingError('faviconPath must be a stored favicon name (<sha256>.png|ico)', 'invalid_request', {
        field: 'faviconPath',
      })
    }
    faviconPath = input.faviconPath
  }

  return {
    navTitle: cleanLangMap(input.navTitle, 'navTitle'),
    docTitle: cleanLangMap(input.docTitle, 'docTitle'),
    channel: { label: cleanLangMap(channel.label, 'channel.label'), href: cleanHref },
    faviconPath,
  }
}

// Store an uploaded favicon by its content hash. png and ico only, validated by
// their magic bytes (not the filename, which the caller never provides, and not
// a declared content-type, which the uploader typed). Written to faviconDir as
// `<sha256>.<ext>`; returns { path, bytes, format }.
export async function storeFavicon(buffer, { faviconDir } = {}) {
  if (typeof faviconDir !== 'string' || faviconDir.trim() === '') {
    throw new BrandingError('branding: options.faviconDir must be a non-empty path', 'bad_argument')
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new BrandingError('The upload was empty.', 'empty')
  }
  if (buffer.length > FAVICON_MAX_BYTES) {
    throw new BrandingError(
      `That icon is ${buffer.length} bytes; the limit is ${FAVICON_MAX_BYTES} (256 KiB).`,
      'too_large',
      { bytes: buffer.length, limit: FAVICON_MAX_BYTES },
    )
  }

  const ext = faviconFormat(buffer)
  if (ext === null) {
    throw new BrandingError('A favicon must be a PNG or an ICO file.', 'unsupported_format')
  }

  const sha = createHash('sha256').update(buffer).digest('hex')
  const name = `${sha}.${ext}`
  await mkdir(faviconDir, { recursive: true })
  const target = join(faviconDir, name)
  // Leading dot so the /branding/ dotfile guard hides this temp. A suffix name
  // like `<sha>.png.tmp.<pid>` has no `/.` in its URL and would be served 200
  // with a one-year immutable cache if a crash orphaned it; a leading-dot name
  // is refused. Unlink on any failure so a rename error leaves nothing behind.
  const tmp = join(faviconDir, `${BRANDING_TEMP_PREFIX}tmp-${process.pid}-${name}`)
  try {
    await writeFile(tmp, buffer, { mode: 0o644 })
    await rename(tmp, target)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
  return { path: name, bytes: buffer.length, format: ext }
}

// Magic bytes only. PNG: 89 50 4E 47 0D 0A 1A 0A. ICO: 00 00 01 00 (an icon
// directory; 00 00 02 00 is a cursor, which is refused).
function faviconFormat(buffer) {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return 'png'
  }
  if (buffer.length >= 4 && buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) {
    return 'ico'
  }
  return null
}

export function faviconUrl(path) {
  if (typeof path !== 'string' || !FAVICON_NAME_PATTERN.test(path)) {
    throw new BrandingError('branding: not a stored favicon name', 'bad_argument', { path })
  }
  return `${FAVICON_URL_PREFIX}${path}`
}

// Where branding lives, DERIVED from DATA_DIR — the directory catalog.json sits
// in — so no new config key or env-guard entry is needed. Exactly the derivation
// resolveThemePaths falls back to. branding.json is a sibling of catalog.json;
// the favicons go in a `branding/` subdirectory served under /branding/.
export function brandingPathsFrom(catalogFile) {
  const dataDir = dirname(catalogFile)
  return {
    brandingFile: join(dataDir, 'branding.json'),
    faviconDir: join(dataDir, 'branding'),
  }
}
