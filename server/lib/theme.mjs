// SPDX-License-Identifier: MIT
//
// The site-wide theme: what the owner may change, what they may not, and the
// bytes the browser ends up reading.
//
// ===========================================================================
// THE DELIVERY CONTRACT (STORY-034 required this be stated, not implied)
// ===========================================================================
// The theme is a FILE on the shared volume — `theme.css` — served by the web pod
// with its own `no-cache` + ETag location, exactly like catalog.json. The
// alternative STORY-034 names, an API-rendered `:root` block inside the HTML,
// is not available in this architecture: nginx serves index.html off the image
// and never proxies to the API, so the API has nothing to render into.
//
// The consequences of the file form, stated so nobody has to rediscover them:
//
//   * It takes effect on the next page load, not in up to an hour. The generic
//     `*.json` rule that would have given an hour does not apply — theme.css has
//     an exact-match location of its own, the same fix catalog.json got.
//   * It survives the API being down, because the web pod reads the volume.
//   * It is a SECOND request on first paint. Deliberate: inlining it would mean
//     the API rendering HTML, and a `<link>` the browser can cache-validate in
//     one conditional request is cheaper than the machinery that would take.
//
// ===========================================================================
// WHAT CANNOT BE CHANGED, AND WHY THAT IS A FEATURE
// ===========================================================================
// The tokens are a CLOSED roster. An unknown token name is refused rather than
// passed through, because `--anything: <value>` in a stylesheet the site loads
// is a way to write arbitrary CSS, and this file's whole job is to make that
// impossible from the admin form.
//
// Every palette is contrast-checked against server/lib/contrast.mjs — the same
// roster and the same arithmetic the build gate uses on the default palette —
// and a palette that fails is refused with the failing pairs named. The owner
// cannot make their own site unreadable through this form. That is not
// paternalism: they cannot see every one of the eighteen pairings by eye, and a
// theme that ships a 2:1 button label is discovered by a visitor, not by them.
//
// ===========================================================================
// THE WALLPAPER, AND STORY-035's RULING ("正文坐实底")
// ===========================================================================
// The wallpaper is only ever behind the page. Content sits on `--content-bg`,
// which must be OPAQUE whenever a wallpaper is set — so body contrast is decided
// by the tokens and is independent of whatever the image happens to contain.
//
// That ruling replaced "sample the uploaded image and check contrast against
// it", which was dropped because it is not well defined: every pixel is a
// different colour, so any single number is an approximation presented as a
// guarantee. An opaque backing needs no approximation.

import { evaluatePalette, isHexColour, isTranslucent } from './contrast.mjs'

/**
 * Every token the owner may set, and what it is.
 *
 * CLOSED. Anything not here is refused. The list is derived from src/App.vue's
 * :root block — these are the values that block declares — and the descriptions
 * are what the admin form shows, so a translator and a reviewer read the same
 * words.
 */
export const THEME_TOKENS = Object.freeze([
  { name: '--cream', role: 'page', label: 'page background' },
  { name: '--amber', role: 'chrome', label: 'navbar fill' },
  { name: '--amber-deep', role: 'chrome', label: 'footer fill' },
  { name: '--candy-red', role: 'accent', label: 'category header and button border' },
  { name: '--candy-red-line', role: 'accent', label: 'category header outline' },
  { name: '--pink', role: 'state', label: 'button hover' },
  { name: '--blue', role: 'state', label: 'button keyboard focus' },
  { name: '--lilac', role: 'state', label: 'control button, mode engaged' },
  { name: '--plum-700', role: 'ink', label: 'button label' },
  { name: '--plum-900', role: 'ink', label: 'label on an engaged control' },
  { name: '--cocoa-700', role: 'ink', label: 'navbar and footer text' },
  { name: '--cocoa-900', role: 'ink', label: 'focus ring' },
  { name: '--surface', role: 'surface', label: 'button face' },
  { name: '--surface-alt', role: 'surface', label: 'menu item hover' },
  { name: '--track', role: 'surface', label: 'volume slider track' },
  // NOT in :root today: it is read by `.main-content` with a `transparent`
  // fallback, which is correct with no wallpaper and wrong with one. It is the
  // one token allowed to be translucent, and only when there is no wallpaper —
  // see the exemption in validateTheme.
  { name: '--content-bg', role: 'surface', label: 'backing behind the page content' },
].map(Object.freeze))

export const TOKEN_NAMES = Object.freeze(THEME_TOKENS.map((t) => t.name))

/** Reason codes, so the admin form can render a sentence per problem. */
export const THEME_REJECTIONS = Object.freeze({
  not_an_object: 'not_an_object',
  unknown_token: 'unknown_token',
  missing_token: 'missing_token',
  not_a_colour: 'not_a_colour',
  translucent: 'translucent',
  contrast: 'contrast',
  content_backing_translucent: 'content_backing_translucent',
  name_too_long: 'name_too_long',
  name_empty: 'name_empty',
})

const NAME_MAX = 120

/**
 * Validate a theme the owner submitted.
 *
 * @param {{name?: string, tokens?: object, wallpaperPath?: string|null}} theme
 *        wallpaperPath is the bare `<sha256>.<ext>` stored in the column, not a
 *        URL: only its PRESENCE matters here, and building a URL is the caller's
 *        job (see WALLPAPER_URL_PREFIX).
 * @returns {{ok: boolean, problems: Array<{code: string, token?: string, detail?: string}>}}
 *
 * EVERY problem, not the first. The form shows sixteen colour inputs and a
 * reviewer who has to press save sixteen times to learn about sixteen mistakes
 * will stop reading the messages.
 */
export function validateTheme(theme) {
  const problems = []
  const push = (code, extra = {}) => problems.push({ code, ...extra })

  if (theme === null || typeof theme !== 'object') {
    return { ok: false, problems: [{ code: THEME_REJECTIONS.not_an_object }] }
  }

  const name = typeof theme.name === 'string' ? theme.name.trim() : ''
  if (name === '') push(THEME_REJECTIONS.name_empty)
  else if ([...name].length > NAME_MAX) push(THEME_REJECTIONS.name_too_long, { detail: String(NAME_MAX) })

  const tokens = theme.tokens
  if (tokens === null || typeof tokens !== 'object' || Array.isArray(tokens)) {
    push(THEME_REJECTIONS.not_an_object, { detail: 'tokens' })
    return { ok: false, problems }
  }

  // Unknown FIRST. A theme carrying `--x: red; } body { … }` is the reason this
  // roster is closed, and naming the offending key is more useful than a
  // downstream syntax complaint.
  for (const key of Object.keys(tokens)) {
    if (!TOKEN_NAMES.includes(key)) push(THEME_REJECTIONS.unknown_token, { token: key })
  }
  for (const name of TOKEN_NAMES) {
    if (!(name in tokens)) {
      push(THEME_REJECTIONS.missing_token, { token: name })
      continue
    }
    const value = tokens[name]
    if (!isHexColour(value)) {
      push(THEME_REJECTIONS.not_a_colour, { token: name })
      continue
    }
    // Refused rather than composited: a translucent token has no single contrast
    // ratio, because what it resolves to depends on what is behind it — which,
    // with a wallpaper, is an image. Accepting one would make every number this
    // module reports something other than what the visitor sees.
    //
    // --content-bg IS EXEMPT, and the exemption is what makes STORY-035's rule
    // mean anything. It is the backing behind the content and appears in no
    // contrast pair, so with no wallpaper a transparent value is not merely
    // allowed — it is what the site does today (`.main-content` reads it with a
    // `transparent` fallback), and the page colour shows through. It is only
    // once there is a picture back there that it has to be opaque. Refusing it
    // here as well would have made the wallpaper rule below unreachable: a gate
    // whose predicate can never be true.
    if (name !== '--content-bg' && isTranslucent(value)) push(THEME_REJECTIONS.translucent, { token: name })
  }

  // Only if every token is a usable colour; otherwise the ratios would be
  // computed from values that are already being reported as broken.
  if (problems.length === 0) {
    const { rows, failures } = evaluatePalette(tokens)
    if (failures > 0) {
      for (const row of rows.filter((r) => !r.ok)) {
        push(THEME_REJECTIONS.contrast, {
          token: row.fg,
          detail: `${row.what}: ${row.ratio.toFixed(2)}:1 against ${row.bg}, needs ${row.threshold}:1`,
        })
      }
    }
  }

  // STORY-035's ruling, enforced rather than documented: with a wallpaper behind
  // the page, the content backing has to be opaque or the text's contrast
  // depends on the picture. Evaluated OUTSIDE the `problems.length === 0` guard
  // above, because it is about this one token and does not need the rest of the
  // palette to be sound first — and because leaving it inside would have meant a
  // theme with any other mistake never reached it.
  const wallpaper = typeof theme.wallpaperPath === 'string' && theme.wallpaperPath !== ''
  if (wallpaper && isTranslucent(tokens['--content-bg'])) {
    push(THEME_REJECTIONS.content_backing_translucent, { token: '--content-bg' })
  }

  return { ok: problems.length === 0, problems }
}

/**
 * The stylesheet.
 *
 * Every value has already been through validateTheme, so this is a renderer and
 * not a sanitiser — but it re-checks each one against the hex pattern anyway and
 * throws on a miss. A renderer that trusts its input is one refactor away from
 * being the injection point, and the cost is sixteen regex tests.
 *
 * @param {{tokens: object, wallpaperUrl?: string|null}} theme
 */
export function renderThemeCss(theme) {
  const tokens = theme?.tokens ?? {}
  const lines = []
  for (const name of TOKEN_NAMES) {
    const value = tokens[name]
    if (value === undefined) continue
    if (!isHexColour(value)) {
      throw new Error(`theme: ${name} is ${JSON.stringify(value)}, which is not a colour; validateTheme should have refused this`)
    }
    lines.push(`  ${name}: ${value.trim().toLowerCase()};`)
  }

  const out = [
    '/* Generated by the review desk. Edit the theme there, not this file:',
    '   the API rewrites it whole on every save. */',
    ':root {',
    ...lines,
    '}',
  ]

  const url = theme?.wallpaperUrl
  if (typeof url === 'string' && url !== '') {
    // The URL is built by the caller from a content-addressed FILENAME, never
    // from anything a form supplied — see routes/admin.mjs. This still refuses
    // anything that is not the shape it expects, because a `)` or a `"` here
    // would end the url() and start whatever follows it.
    //
    // /wallpaper/ and not /media/: the two are different trees with different
    // cache rules and different nginx aliases, and mixing them would mean a
    // wallpaper could be reached under the path published for approved audio.
    // themes.wallpaper_path stores the bare `<sha256>.<ext>` — no slash, so the
    // database CHECK alone makes a traversal unspellable — and the serving
    // prefix belongs to nginx.
    if (!/^\/wallpaper\/[0-9a-f]{64}\.(?:png|jpg|webp)$/.test(url)) {
      throw new Error(`theme: refusing to render a wallpaper url that is not a content-addressed wallpaper path: ${JSON.stringify(url)}`)
    }
    out.push(
      '',
      'body {',
      `  background-image: url("${url}");`,
      // fixed + cover, so the picture behaves like a backdrop rather than
      // tiling. The page content has its own opaque backing (--content-bg),
      // which is what keeps the text readable over any image at all.
      '  background-size: cover;',
      '  background-position: center;',
      '  background-attachment: fixed;',
      '  background-repeat: no-repeat;',
      '}',
    )
  }

  return `${out.join('\n')}\n`
}

/**
 * The theme the site falls back to.
 *
 * NOT a copy of the default palette. src/App.vue's :root block is the default,
 * it is compiled into the bundle, and theme.css only ever OVERRIDES it — so the
 * absence of a theme is the correct fallback and there is nothing to duplicate.
 * This exists so the admin form can open pre-filled with what is on screen.
 */
/**
 * Where nginx publishes the wallpaper directory.
 *
 * Exported so routes/admin.mjs builds the URL from the same constant the
 * renderer validates against, rather than from a second string literal that can
 * drift from it. deploy/nginx.conf carries the matching `location ^~ /wallpaper/`.
 */
export const WALLPAPER_URL_PREFIX = '/wallpaper/'

/** `<sha256>.<ext>` -> the URL the stylesheet may reference. */
export function wallpaperUrl(path) {
  if (typeof path !== 'string' || path === '') return null
  return `${WALLPAPER_URL_PREFIX}${path}`
}

export const EMPTY_THEME_CSS = '/* No theme is active; the site uses the palette compiled into its bundle. */\n'
