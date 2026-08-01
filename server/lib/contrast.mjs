// SPDX-License-Identifier: MIT
//
// The palette's contrast rules, as data plus the arithmetic that reads them.
//
// ===========================================================================
// WHY THIS IS A MODULE AND NOT A SCRIPT
// ===========================================================================
// It used to be one file, deploy/contrast-check.mjs, run at build time against
// the tokens in src/App.vue. That was enough while the palette was a constant.
// It is not enough now: the theming feature lets the owner replace those tokens
// at RUN time, and a build-time gate cannot see a value that arrives afterwards.
//
// Two checkers with two rosters would be worse than one checker in the wrong
// place — the build would gate one set of pairings and the API another, and the
// day they drifted the site would ship a palette the build considered fine. So
// the roster and the arithmetic live here, and both callers read them:
//
//   deploy/contrast-check.mjs   the DEFAULT palette, at build time
//   server/lib/theme.mjs        an OWNER-SUBMITTED palette, before it is stored
//
// ===========================================================================
// THRESHOLDS
// ===========================================================================
// Nothing on this site earns WCAG's large-text allowance — Bootstrap's .btn is
// 14px normal, .navbar-brand 18px normal, .cate-header 20px normal — so text is
// held to 4.5:1 (SC 1.4.3) and non-text UI, which here means borders and focus
// rings, to 3:1 (SC 1.4.11).

/** Colours that are real surfaces in the rendered page but are not tokens. */
export const LITERAL_COLOURS = Object.freeze({ white: '#ffffff' })

/**
 * Every foreground/background pairing the site actually renders, as
 * [description, foreground, background, minimum ratio].
 *
 * TWO DELIBERATE EXCLUSIONS, stated rather than quietly omitted:
 *
 *   * the slider TRACK against the button face is 1.32:1 and no grey fixes it —
 *     lifting the track toward the bar starts failing the thumb against the
 *     track, which is the pairing SC 1.4.11 actually asks about. The track is
 *     declared decorative and the thumb is gated.
 *   * --candy-red-line against --candy-red is 1.48:1. SC 1.4.11 covers visual
 *     information required to IDENTIFY a component or its state; the section
 *     header is identified by its fill and its white text, and its lighter
 *     outline carries neither. Delete the outline and nothing becomes ambiguous.
 *
 * Both would force either a colour the design does not want or a permanently red
 * gate, and a gate people learn to ignore protects nothing.
 */
export const CONTRAST_PAIRS = Object.freeze([
  ['voice button, resting', '--plum-700', 'white', 4.5],
  ['voice button, hover', '--plum-700', '--pink', 4.5],
  ['voice button, keyboard focus', '--plum-700', '--blue', 4.5],
  ['voice button, pressed / playing', 'white', '--candy-red', 4.5],
  ['control button, mode engaged', '--plum-900', '--lilac', 4.5],
  ['category header', 'white', '--candy-red', 4.5],
  ['navbar link and brand', '--cocoa-700', '--amber', 4.5],
  ['navbar link, hover / focus pill', '--cocoa-700', '--cream', 4.5],
  ['language menu item', '--cocoa-700', 'white', 4.5],
  ['language menu item, hover', '--cocoa-700', '--surface-alt', 4.5],
  ['footer text and links', '--cocoa-700', '--amber-deep', 4.5],
  ['footer link, hover', '--plum-700', '--amber-deep', 4.5],
  // non-text: borders and the focus ring against every surface it can land on
  ['button border vs page', '--candy-red', '--cream', 3],
  ['focus ring vs button border', '--cocoa-900', '--candy-red', 3],
  ['focus ring vs focus fill', '--cocoa-900', '--blue', 3],
  ['focus ring vs mode-engaged fill', '--cocoa-900', '--lilac', 3],
  ['focus ring vs navbar fill', '--cocoa-900', '--amber', 3],
  ['slider thumb vs track', '--plum-700', '--track', 3],
].map(Object.freeze))

/** Every token name any pair mentions. A theme has to supply all of them. */
export const REQUIRED_TOKENS = Object.freeze(
  [...new Set(CONTRAST_PAIRS.flatMap(([, fg, bg]) => [fg, bg]))]
    .filter((name) => name.startsWith('--'))
    .sort(),
)

/**
 * #rgb, #rrggbb, #rrggbbaa — the forms src/App.vue's :root block uses.
 *
 * ALPHA IS PARSED AND THEN REFUSED by validateColour below rather than being
 * silently composited. A translucent token has no single contrast ratio: what it
 * resolves to depends on whatever is behind it, which for a wallpaper the owner
 * uploads is an image nobody can compute against. Accepting one would mean this
 * whole module reports a number that is not what the visitor sees.
 */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

export function isHexColour(value) {
  return typeof value === 'string' && HEX.test(value.trim())
}

/** True when the colour carries an alpha channel that is not fully opaque. */
export function isTranslucent(value) {
  const hex = String(value).trim().replace('#', '')
  if (hex.length !== 8) return false
  return parseInt(hex.slice(6, 8), 16) !== 255
}

function channels(hex) {
  const h = String(hex).trim().replace('#', '')
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
}

/** WCAG relative luminance. */
export function luminance(hex) {
  return channels(hex)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
}

/** WCAG contrast ratio, 1..21. Order-independent. */
export function contrastRatio(a, b) {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/**
 * Evaluate a whole palette.
 *
 * @param {Record<string,string>} tokens  token name -> hex colour
 * @returns {{rows: Array, failures: number, missing: string[]}}
 *
 * A missing token is reported as `missing` rather than thrown: the caller
 * decides whether that is a build failure or a 400, and both want to name every
 * problem at once rather than the first one.
 */
export function evaluatePalette(tokens) {
  const resolve = (name) => LITERAL_COLOURS[name] ?? tokens[name]
  const missing = []
  const rows = []

  for (const [what, fg, bg, threshold] of CONTRAST_PAIRS) {
    const fgValue = resolve(fg)
    const bgValue = resolve(bg)
    for (const [name, value] of [[fg, fgValue], [bg, bgValue]]) {
      if (!isHexColour(value) && !missing.includes(name)) missing.push(name)
    }
    if (!isHexColour(fgValue) || !isHexColour(bgValue)) continue
    const ratio = contrastRatio(fgValue, bgValue)
    rows.push({ what, fg, bg, fgValue, bgValue, threshold, ratio, ok: ratio >= threshold })
  }

  return { rows, failures: rows.filter((r) => !r.ok).length, missing }
}
