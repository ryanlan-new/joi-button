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

/**
 * Colours that are real surfaces or inks in the rendered page but are NOT
 * tokens — no theme can move them, so a pair naming one is measuring a constant.
 *
 * An entry here is only legitimate when the CSS really is a literal, so each one
 * names the rule it comes from. Getting this wrong is not a cosmetic mistake: a
 * pair that names a literal where the stylesheet actually reads a TOKEN measures
 * a colour the owner cannot change instead of the one they can, and the gate is
 * green for every value of the token. That is exactly what
 * `['voice button, resting', '--plum-700', 'white', 4.5]` did until the roster
 * below was audited — see the --surface row.
 *
 *   white     src/App.vue:392  `.cate-body button:focus:not(:focus-visible)
 *                              { background-color: white }` — the mouse-click
 *                              state, the one button fill that is not --surface.
 *             src/App.vue:346  `.cate-header { color: white }`, :412
 *                              `.cate-body button:active { color: white }`, and
 *                              the same literal in my.vue's .state-bad and
 *                              submit.vue's .verdict-bad.
 *             bootstrap.css:3610 `.dropdown-menu { background-color: #fff }` —
 *                              the language and account panels. App.vue dresses
 *                              their items but never their panel fill.
 *   body-ink  bootstrap.css:1088 `body { color: #333333 }`. The default ink for
 *                              every paragraph, list and span on the site;
 *                              App.vue sets body's font and background and never
 *                              its colour, so this is what page copy is painted
 *                              in unless a rule names a token.
 */
export const LITERAL_COLOURS = Object.freeze({ white: '#ffffff', 'body-ink': '#333333' })

/** The one token whose value may be translucent; see effectiveBacking(). */
const CONTENT_BACKING = '--content-bg'

/** The token painted behind it, i.e. what shows through. */
const PAGE_FILL = '--cream'

/**
 * Every foreground/background pairing the site actually renders, as
 * [description, foreground, background, minimum ratio].
 *
 * ===========================================================================
 * THE AUDIT — all sixteen tokens, against what src/ renders
 * ===========================================================================
 * A pair that names no token is a pair no theme can break, and a TOKEN that
 * appears in no pair is a colour the owner can set to anything at all with every
 * gate staying green. Both mistakes were live here, so the roster is now stated
 * against the rules rather than assembled from memory:
 *
 *   --cream        page fill (App.vue:208) and the navbar hover/focus pill
 *                  (:231,:237). GATED: 'navbar link, hover / focus pill',
 *                  'button border vs page'.
 *   --amber        navbar fill (:312). GATED: 'navbar link and brand',
 *                  'focus ring vs navbar fill'.
 *   --amber-deep   footer fill (:321). GATED: 'footer text and links',
 *                  'footer link, hover'.
 *   --candy-red    section-header fill (:345), button border (:367),
 *                  pressed/playing fill (:411), and the same three in
 *                  submit.vue/my.vue. GATED: 'category header', 'voice button,
 *                  pressed / playing', 'button border vs page', 'focus ring vs
 *                  button border'.
 *   --pink         hover fill (:385). GATED: 'voice button, hover'.
 *   --blue         keyboard-focus fill (:397). GATED: 'voice button, keyboard
 *                  focus', 'focus ring vs focus fill'.
 *   --lilac        mode-engaged fill (:406), my.vue's .state-ok,
 *                  submit.vue's .verdict-ok. GATED: 'control button, mode
 *                  engaged', 'focus ring vs mode-engaged fill'.
 *   --plum-700     button label (:366), footer link hover (:334), slider thumb
 *                  (home.vue:110), .btn-link/.field-bad/.the-code (submit.vue),
 *                  .state-wait (my.vue). GATED as a foreground in six rows.
 *   --plum-900     ink on --lilac (:407, submit.vue, my.vue). GATED: 'control
 *                  button, mode engaged'.
 *   --cocoa-700    navbar/footer ink, menu-item ink, and the .muted / .field-hint
 *                  small print on cards. GATED in six rows.
 *   --cocoa-900    the focus ring (:238,:285,:336,:402). GATED against all four
 *                  fills it can land on.
 *   --surface      the VOICE BUTTON FACE (:363) and every card on the site —
 *                  .panel-block/.clip-row/.notice-block (submit.vue),
 *                  .panel-block/.batch-block/.state-wait (my.vue). GATED: 'voice
 *                  button, resting', 'card body text', 'card small print'.
 *                  ---> This token was in NO pair, while 'voice button, resting'
 *                  measured --plum-700 against the LITERAL 'white'. So
 *                  `--surface: #6f2f74` — the label's own colour — stored 200,
 *                  every gate green, every button label at 1.00:1. That hole is
 *                  what this audit exists to close, and it is why the roster is
 *                  now written token-first.
 *   --surface-alt  menu-item hover fill (:249,:275) and my.vue's .review-note.
 *                  GATED: 'language menu item, hover', 'reviewer note'.
 *   --track        slider track (home.vue:91), submit.vue's .progress-track,
 *                  my.vue's .clip-item rule. GATED: 'slider thumb vs track';
 *                  see the exclusions below for the two it is NOT gated against.
 *   --content-bg   the backing behind ALL page content (App.vue:432,
 *                  `.main-content { background-color: var(--content-bg,
 *                  transparent) }`). GATED: the three 'on the content backing'
 *                  rows. It is the one token that may be TRANSLUCENT, so it is
 *                  resolved through effectiveBacking() rather than read raw.
 *   --candy-red-line  section-header outline only (:351). NOT GATED — see below.
 *
 * ===========================================================================
 * DELIBERATE EXCLUSIONS, stated rather than quietly omitted
 * ===========================================================================
 *   * the slider TRACK against the button face is 1.32:1 and no grey fixes it —
 *     lifting the track toward the bar starts failing the thumb against the
 *     track, which is the pairing SC 1.4.11 actually asks about. The track is
 *     declared decorative and the thumb is gated. The same reading covers
 *     submit.vue's .progress-fill on .progress-track: the percentage is written
 *     out beside the bar, so the fill carries no information by itself.
 *   * --candy-red-line against --candy-red is 1.48:1. SC 1.4.11 covers visual
 *     information required to IDENTIFY a component or its state; the section
 *     header is identified by its fill and its white text, and its lighter
 *     outline carries neither. Delete the outline and nothing becomes ambiguous.
 *   * --candy-red (the button border) against --surface (the button face) is not
 *     gated, and neither is --surface against --cream. Both are the INNER and
 *     OUTER edges of one 3px border whose OUTER edge is already held to 3:1 by
 *     'button border vs page', so the control's boundary is perceivable for
 *     every palette that passes — SC 1.4.11 asks whether the component can be
 *     identified, not whether every edge of its outline can.
 *   * the focus ring against --surface-alt (App.vue:280, the account menu's
 *     inset ring) is not a row because it cannot fail while 'language menu item,
 *     hover' passes: that pair forces --surface-alt's luminance above 0.317
 *     against --cocoa-700, and at that floor --cocoa-900 is already 4.8:1. A
 *     permanently-green row is a row people stop reading.
 *
 * ===========================================================================
 * THE GAP THIS ROSTER CANNOT HOLD, named so nobody reads its silence as safety
 * ===========================================================================
 * Bootstrap declares colours that no token overrides and that therefore sit on
 * themed fills unchecked. The measured one: `.navbar-default .navbar-toggle
 * .icon-bar { background-color: #888 }` on --amber is 1.82:1 ON THE SHIPPED
 * DEFAULT — so the hamburger that is the only way to reach the menu below 768px
 * already fails 3:1 before any theme exists. It is NOT a row here because a gate
 * that is red the day it is written is a gate people learn to ignore
 * (deploy/contrast-check.mjs's header makes the same argument for why the
 * absolute threshold was only adopted after the defaults were repaired). Fixing
 * src/App.vue to paint those bars with a token is the prerequisite; the row
 * belongs here the moment it can be green.
 *
 * The consequence for the claim in server/lib/theme.mjs's header: what this
 * module guarantees is that no pairing THIS SITE'S OWN STYLESHEETS DECLARE can
 * be made unreadable, not that nothing on the page can be.
 */
export const CONTRAST_PAIRS = Object.freeze([
  // text
  ['voice button, resting', '--plum-700', '--surface', 4.5],
  ['voice button, hover', '--plum-700', '--pink', 4.5],
  ['voice button, keyboard focus', '--plum-700', '--blue', 4.5],
  // The one button fill that really is a literal: App.vue:392 keeps a mouse
  // click from leaving the button stuck in the focus colour by painting it
  // `white`, not var(--surface). A theme cannot move it, and it is measured
  // separately from the resting state for exactly that reason.
  ['voice button, after a mouse click', '--plum-700', 'white', 4.5],
  ['voice button, pressed / playing', 'white', '--candy-red', 4.5],
  ['control button, mode engaged', '--plum-900', '--lilac', 4.5],
  ['category header', 'white', '--candy-red', 4.5],
  ['navbar link and brand', '--cocoa-700', '--amber', 4.5],
  ['navbar link, hover / focus pill', '--cocoa-700', '--cream', 4.5],
  ['language menu item', '--cocoa-700', 'white', 4.5],
  ['language menu item, hover', '--cocoa-700', '--surface-alt', 4.5],
  ['footer text and links', '--cocoa-700', '--amber-deep', 4.5],
  ['footer link, hover', '--plum-700', '--amber-deep', 4.5],
  // the cards: submit.vue's .panel-block / .clip-row / .notice-block and my.vue's
  // .panel-block / .batch-block, all painted --surface. Their paragraphs carry
  // Bootstrap's body ink; their .muted / .field-hint small print carries
  // --cocoa-700; their links and codes carry --plum-700, which the resting-button
  // row above already measures against the same fill.
  ['card body text', 'body-ink', '--surface', 4.5],
  ['card small print', '--cocoa-700', '--surface', 4.5],
  ['reviewer note', 'body-ink', '--surface-alt', 4.5],
  // the content backing. All three inks that appear as page copy OUTSIDE a card
  // are measured against it, because none of the three is implied by the others:
  // body-ink is a literal the owner cannot move, while --cocoa-700 and
  // --plum-700 are tokens they can move independently of it.
  ['page copy on the content backing', 'body-ink', CONTENT_BACKING, 4.5],
  ['muted copy on the content backing', '--cocoa-700', CONTENT_BACKING, 4.5],
  ['link on the content backing', '--plum-700', CONTENT_BACKING, 4.5],
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
 * ALPHA IS PARSED AND THEN REFUSED — by validateTheme in server/lib/theme.mjs,
 * which owns the refusal — rather than being silently composited. A translucent
 * token has no single contrast ratio: what it resolves to depends on whatever is
 * behind it, which for a wallpaper the owner uploads is an image nobody can
 * compute against. Accepting one would mean this whole module reports a number
 * that is not what the visitor sees.
 *
 * THE ONE EXCEPTION, and the reason it is not a hole: --content-bg. That token
 * is exempt from the refusal (it is the backing, and transparent is what the
 * site ships), and it is the one case where the layer underneath is KNOWN and is
 * itself a flat colour — `body { background-color: var(--cream) }`. So
 * effectiveBacking() below composites it exactly instead of guessing. The rule
 * above is "do not composite against an unknown"; it was never "alpha is
 * uncomputable".
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

/** Composite a translucent colour onto an opaque one, the way a browser does. */
function compositeOver(value, behind) {
  const alpha = parseInt(String(value).trim().replace('#', '').slice(6, 8), 16) / 255
  const front = channels(value)
  const back = channels(behind)
  const mixed = front.map((c, i) => Math.round((c * alpha + back[i] * (1 - alpha)) * 255))
  return `#${mixed.map((n) => n.toString(16).padStart(2, '0')).join('')}`
}

/**
 * What a visitor actually sees behind the page content.
 *
 * --content-bg is the ONE token allowed to be translucent (see the exemption in
 * server/lib/theme.mjs's validateTheme), and it is also the backing every
 * paragraph on the site sits on. Those two facts together are why it needs a
 * resolver rather than a raw lookup:
 *
 *   * UNSET is the shipped state — src/App.vue's :root does not declare it, and
 *     .main-content reads it as `var(--content-bg, transparent)`. Reading it raw
 *     would put it in `missing` and turn deploy/contrast-check.mjs red on a
 *     palette that is fine.
 *   * TRANSLUCENT is legal without a wallpaper. Reading it raw would measure the
 *     colour's own channels and ignore its alpha — luminance() cannot see alpha
 *     — so `#00000000`, a perfectly legal fully-transparent backing, would be
 *     measured as opaque BLACK and refuse a theme that renders identically to
 *     today's site.
 *
 * Both cases resolve through what is behind: `body { background-color:
 * var(--cream) }`. Compositing is exact here in a way it is not for any other
 * token — this is the one place the layer underneath is KNOWN and is itself a
 * flat colour, which is why the blanket "alpha is refused, never composited"
 * rule above does not apply to it.
 *
 * THE APPROXIMATION, stated: body also carries body_bg.svg over --cream, so the
 * true backdrop is that artwork rather than the flat fill. This module already
 * makes that same approximation in 'button border vs page', and the alternative
 * — a number derived from an image — is the thing STORY-035 rejected.
 */
function effectiveBacking(tokens) {
  const value = tokens[CONTENT_BACKING]
  const behind = tokens[PAGE_FILL]
  // Not declared: `.main-content`'s own `transparent` fallback wins.
  if (value === undefined) return behind
  // Present and unusable: handed back untouched so the caller reports it as
  // missing. Substituting the page fill here would paper over a broken value.
  if (!isHexColour(value)) return value
  if (!isTranslucent(value)) return value
  if (!isHexColour(behind)) return undefined
  return compositeOver(value, behind)
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
  const resolve = (name) => {
    // hasOwn and not `in`: `'constructor' in LITERAL_COLOURS` is true and would
    // resolve to a function. No pair name comes from a request today, and this
    // is what keeps that from being the reason it is safe.
    if (Object.hasOwn(LITERAL_COLOURS, name)) return LITERAL_COLOURS[name]
    if (name === CONTENT_BACKING) return effectiveBacking(tokens)
    return tokens[name]
  }
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
