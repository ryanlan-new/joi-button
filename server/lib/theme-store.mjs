// SPDX-License-Identifier: MIT
//
// The active theme: the row that records it, and the stylesheet the browser
// reads. This module's whole job is keeping those two the same fact.
//
// lib/theme.mjs owns WHAT a theme may be — the closed token roster, the contrast
// rules, the renderer. This file owns WHERE it lives and IN WHAT ORDER it is
// written. Nothing here re-decides a validation question; it calls validateTheme
// and reports what comes back.
//
// ===========================================================================
// THE ORDER, AND WHICH FAILURE IT CHOOSES
// ===========================================================================
// A save is two writes that cannot be one transaction — a SQLite row and a file
// on a shared volume — so one of them is ahead of the other whenever a save is
// interrupted, and the only question is WHICH.
//
//   ROW FIRST (what this does). The row says the theme is active while theme.css
//   still holds the previous one. The site looks unchanged, the desk shows the
//   new theme as active, and PRESSING SAVE AGAIN FIXES IT: the stylesheet is a
//   pure function of the row's tokens and wallpaper_path, so the retry produces
//   exactly the bytes that were missing. A reconciler could do it unattended.
//
//   FILE FIRST. The site would be wearing a palette no row records. The desk
//   would show the previous theme — or none — so the owner cannot even name what
//   visitors are seeing, and nothing later corrects it: the next save writes a
//   DIFFERENT theme, and a delete is the only way back to a known state.
//
// The first failure is recoverable and the second is not, so the recoverable one
// is chosen deliberately. routes/admin.mjs's publishCatalogue makes the identical
// argument about the catalogue ("DB-ahead means the site serves the previous
// catalogue until the next publish, and the next publish fixes it"), and
// lib/catalog.mjs makes it about the media files. One rule, three places.
//
// The stylesheet TEXT is rendered before the transaction opens, not after it
// commits. renderThemeCss throws on anything it will not put in a stylesheet, and
// a throw after the commit would be the one shape this order does not defend
// against: a row that is active and a stylesheet that can never be produced from
// it, so the retry fails too.
//
// ===========================================================================
// WHAT MAKES THIS GO RED
// ===========================================================================
//   * Write the stylesheet before the row — the "a palette that fails contrast
//     changes nothing on disk" case in test/http/theme.test.mjs goes red, because
//     that file would already have been replaced by the time anything refused.
//   * Skip the wallpaper existence check — "a wallpaperPath that is not on the
//     volume is a 400, not a stored row" goes red, and the site would ask for a
//     background image that 404s.
//   * Rewrite or delete the previous row on save — "the row keeps its history"
//     goes red. themes rows are history; deactivation clears is_active and leaves
//     activated_at, so a rollback is one UPDATE away and lands on exactly the
//     bytes that were live.
//   * Replace the temp+rename with writeFileSync — a reader gets a partial
//     stylesheet, which is a page with half a palette rather than none.

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import { toCanonicalTimestamp } from '../db/migrate.mjs'
import { EMPTY_THEME_CSS, renderThemeCss, validateTheme, wallpaperUrl } from './theme.mjs'

/**
 * The shape themes.wallpaper_path holds: a BARE content-addressed filename.
 *
 * The same shape schema.sql CHECKs and the same one theme.mjs's renderer refuses
 * to build a url() out of anything else from. Three statements of one rule is two
 * too many in general; here it is deliberate, because the three of them are the
 * database, the renderer and the door, and a traversal has to get past all three.
 */
const WALLPAPER_FILENAME = /^[0-9a-f]{64}\.(?:png|jpg|webp)$/

/** Reason codes this module adds to the ones lib/theme.mjs already defines. */
export const THEME_STORE_REJECTIONS = Object.freeze({
  wallpaper_malformed: 'wallpaper_malformed',
  wallpaper_missing: 'wallpaper_missing',
  stylesheet_unwritten: 'stylesheet_unwritten',
})

export class ThemeStoreError extends Error {
  constructor(message, code, problems = [], options = {}) {
    super(message, options)
    this.name = 'ThemeStoreError'
    this.code = code
    /** Every problem, in validateTheme's shape: {code, token?, detail?}. */
    this.problems = Object.freeze([...problems])
  }
}

/**
 * The theme that is live, or null.
 *
 * @returns {{id, name, tokens, wallpaperPath, wallpaperUrl, isActive, activatedAt, createdAt}|null}
 */
export function readActiveTheme(db) {
  const row = db
    .prepare(
      'SELECT id, name, tokens, created_at, is_active, activated_at, wallpaper_path FROM themes WHERE is_active = 1',
    )
    .get()
  return row === undefined ? null : themeView(row)
}

/**
 * Store a theme, make it the active one, and rewrite the stylesheet.
 *
 * @param {object} db
 * @param {{name: string, tokens: object, wallpaperPath?: string|null}} input
 * @param {{now?: Date|string, themeCssFile: string, wallpaperDir: string,
 *          audit?: (theme: object) => void}} options
 *        `audit` runs INSIDE the row's transaction, which is what routes/admin.mjs
 *        requires of every mutation: an entry can then never claim a save that
 *        rolled back. It is called with the stored theme.
 * @returns {object} the stored theme, in readActiveTheme's shape
 * @throws {ThemeStoreError} with `problems` listing EVERY reason, never the first
 */
export function saveTheme(db, input = {}, { now, themeCssFile, wallpaperDir, audit } = {}) {
  requirePath(themeCssFile, 'themeCssFile')
  requirePath(wallpaperDir, 'wallpaperDir')

  const at = toCanonicalTimestamp(now ?? new Date())
  const wallpaperPath = normaliseWallpaperPath(input.wallpaperPath)

  // EVERY problem in one answer, for the reason lib/theme.mjs states about its
  // own sixteen colour inputs: a reviewer who has to press save once per mistake
  // stops reading the messages. So the palette's problems and the wallpaper's are
  // collected together rather than reported one refusal at a time.
  const problems = [...validateTheme({ name: input.name, tokens: input.tokens, wallpaperPath }).problems]

  if (wallpaperPath === undefined) {
    problems.push({
      code: THEME_STORE_REJECTIONS.wallpaper_malformed,
      detail: 'a wallpaper is named by the content-addressed filename the upload returned, or by null',
    })
  } else if (wallpaperPath !== null && !existsSync(join(wallpaperDir, wallpaperPath))) {
    // Checked against the volume rather than trusted. The upload route is the
    // only thing that puts a file there, and a request that names one it did not
    // get from that route is either a stale form or somebody guessing — either
    // way the site would end up asking the browser for a background that 404s.
    problems.push({ code: THEME_STORE_REJECTIONS.wallpaper_missing, detail: wallpaperPath })
  }

  if (problems.length > 0) {
    throw new ThemeStoreError(
      `That theme was refused: ${problems.length} problem(s).`,
      'theme_invalid',
      problems,
    )
  }

  const tokens = pickTokens(input.tokens)
  // Rendered BEFORE the transaction: see the header. renderThemeCss re-checks
  // every value and throws on anything it will not put in a stylesheet, and that
  // throw must not be able to land after the row is committed.
  const css = renderThemeCss({ tokens, wallpaperUrl: wallpaperUrl(wallpaperPath) })

  const id = randomUUID()
  const store = db.transaction(() => {
    // is_active = 1 on the way in; the BEFORE INSERT trigger in schema.sql clears
    // the previous active row first, so the partial unique index never sees two.
    // The previous row is NOT deleted or rewritten — it is history, and it keeps
    // its activated_at so a rollback lands on exactly the bytes that were live.
    db.prepare(`
      INSERT INTO themes (id, name, tokens, created_at, is_active, activated_at, wallpaper_path)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(id, String(input.name).trim(), JSON.stringify(tokens), at, at, wallpaperPath)

    const stored = readActiveTheme(db)
    if (typeof audit === 'function') audit(stored)
    return stored
  })

  const theme = store.immediate()

  try {
    writeFileAtomic(themeCssFile, Buffer.from(css, 'utf8'))
  } catch (error) {
    // The row is committed and the theme IS active; only the stylesheet is
    // behind. Said in those words, because the recovery is "press save again"
    // and an operator who reads this as "the save failed" will retype the palette
    // they already stored.
    throw new ThemeStoreError(
      `The theme was stored and activated, but ${themeCssFile} could not be rewritten (${error?.code ?? 'unknown error'}). ` +
        'The site is still showing the previous palette. Press save again — the stylesheet is rebuilt from the row.',
      THEME_STORE_REJECTIONS.stylesheet_unwritten,
      [],
      { cause: error },
    )
  }

  return theme
}

/**
 * Turn the active theme off.
 *
 * The row STAYS. themes carries activated_at history and a deactivated row is
 * what a rollback is one UPDATE away from; deleting it would make "go back to
 * what we had last week" a retyping exercise.
 *
 * theme.css becomes EMPTY_THEME_CSS rather than being unlinked. The file is
 * `<link>`ed unconditionally by the page and deploy/nginx.conf answers 404 when
 * it is absent — which works, and puts a red line in every visitor's console for
 * a state that is not an error.
 *
 * @returns {object|null} the theme that was deactivated, or null if none was
 */
export function deactivate(db, { now, themeCssFile, audit } = {}) {
  requirePath(themeCssFile, 'themeCssFile')
  toCanonicalTimestamp(now ?? new Date()) // refuse a bad clock here, not mid-write

  const store = db.transaction(() => {
    const previous = readActiveTheme(db)
    if (previous !== null) {
      db.prepare('UPDATE themes SET is_active = 0 WHERE id = ?').run(previous.id)
    }
    if (typeof audit === 'function') audit(previous)
    return previous
  })

  const previous = store.immediate()

  // Row first here too, and for the same reason: a cleared row with a stale
  // stylesheet is fixed by pressing delete again.
  writeFileAtomic(themeCssFile, Buffer.from(EMPTY_THEME_CSS, 'utf8'))
  return previous
}

// ---------------------------------------------------------------------------

function themeView(row) {
  return {
    id: row.id,
    name: row.name,
    tokens: JSON.parse(row.tokens),
    wallpaperPath: row.wallpaper_path,
    // Built here so no consumer has to know the prefix; theme.mjs owns it, and
    // the renderer validates against the same constant.
    wallpaperUrl: wallpaperUrl(row.wallpaper_path),
    isActive: row.is_active === 1,
    activatedAt: row.activated_at,
    createdAt: row.created_at,
  }
}

/**
 * null, the filename, or `undefined` meaning "this is not a wallpaper path".
 *
 * Three outcomes rather than a throw, so the caller can report a malformed path
 * BESIDE the palette's problems rather than instead of them.
 */
function normaliseWallpaperPath(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') return undefined
  return WALLPAPER_FILENAME.test(value) ? value : undefined
}

/**
 * The tokens, in the roster's order and with nothing else in them.
 *
 * validateTheme has already refused an unknown key, so this is not a second
 * filter — it is what makes the stored JSON a canonical document: the same
 * palette always serialises to the same bytes, whatever order the form's fields
 * arrived in.
 */
function pickTokens(tokens) {
  const out = {}
  for (const name of Object.keys(tokens).sort()) out[name] = String(tokens[name]).trim().toLowerCase()
  return out
}

function requirePath(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ThemeStoreError(`theme-store: options.${name} must be a non-empty path`, 'bad_argument')
  }
}

/**
 * Identical to lib/catalog.mjs's writeFileAtomic, and copied for the same reason
 * lib/wallpaper.mjs copies it: that function is not exported and that file
 * belongs to the catalogue.
 *
 * Temp file in the target's own directory (rename is atomic only within one
 * filesystem — os.tmpdir() throws EXDEV), fsync the bytes before the rename, and
 * a leading dot on the temp name so deploy/nginx.conf's dot-segment 404 makes a
 * leftover unservable.
 */
function writeFileAtomic(target, data) {
  const dir = dirname(target)
  mkdirSync(dir, { recursive: true })
  const temp = join(dir, `.theme-tmp-${randomUUID()}`)

  const fd = openSync(temp, 'wx', 0o644)
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } catch (error) {
    closeSync(fd)
    unlinkSync(temp)
    throw error
  }
  closeSync(fd)

  try {
    renameSync(temp, target)
  } catch (error) {
    unlinkSync(temp)
    throw error
  }

  fsyncDirectory(dir)
}

function fsyncDirectory(dir) {
  let fd
  try {
    fd = openSync(dir, 'r')
  } catch {
    return
  }
  try {
    fsyncSync(fd)
  } catch {
    // Best effort, exactly as lib/catalog.mjs argues: the bytes and the rename
    // have both landed, so this is crash-durability of the last save.
  } finally {
    closeSync(fd)
  }
}
