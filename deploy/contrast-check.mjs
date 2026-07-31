#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// The palette's contrast gate.
//
// It reads the tokens out of src/App.vue's :root block — the same bytes the
// browser reads — and asserts every foreground/background pairing the site
// actually renders. It is deliberately NOT a snapshot of "what the numbers were
// when someone last looked": change a token and the arithmetic changes with it,
// so the gate goes red on the edit rather than on a later review.
//
//   node deploy/contrast-check.mjs          # or: npm run contrast
//
// THRESHOLDS. Nothing on this site earns WCAG's large-text allowance —
// Bootstrap's .btn is 14px normal, .navbar-brand 18px normal, .cate-header 20px
// normal — so text is held to 4.5:1 (SC 1.4.3) and non-text UI, which here means
// borders and focus rings, to 3:1 (SC 1.4.11).
//
// WHY THIS IS AN ABSOLUTE THRESHOLD AND NOT A "NO REGRESSION" BASELINE. Before
// the palette repair, four of these pairs failed — including the resting label
// of every voice button at 2.75:1 — so a 4.5:1 gate could not have been green in
// a world it was certain to be evaluated in, and a gate like that teaches people
// to ignore red. The defaults were fixed first; only then does an absolute
// threshold become satisfiable, and only then is it worth enforcing.
//
// KNOWN EXCLUSION, stated rather than quietly omitted: the slider TRACK against
// the button face is 1.32:1 and no grey fixes it — lifting the track toward the
// bar starts failing the thumb against the track, which is the pairing SC 1.4.11
// actually asks about. The track is declared decorative and the thumb is gated.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(REPO, 'src/App.vue'), 'utf8')

const rootBlock = css.match(/:root\s*\{([\s\S]*?)\}/)
if (!rootBlock) fail('could not find the :root token block in src/App.vue')

const T = {}
for (const [, name, value] of rootBlock[1].matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
  T[name] = value
}

// Values that are not tokens but are real surfaces in the rendered page.
const LITERAL = { white: '#ffffff' }

const srgb = (hex) => {
  const h = hex.replace('#', '')
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
}
const lum = (hex) =>
  srgb(hex)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
    .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0)
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
const val = (k) => LITERAL[k] ?? T[k] ?? fail(`unknown colour "${k}" — is the token still declared in :root?`)

// [ what it is, foreground, background, threshold ]
const PAIRS = [
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
  // NOT gated: --candy-red-line against --candy-red is 1.48:1. Deliberately
  // excluded, on the same reasoning as the slider track. SC 1.4.11 covers
  // visual information required to IDENTIFY a component or its state; the
  // section header is identified by its fill and its white text, and its
  // lighter outline carries neither identity nor status. Delete the outline
  // entirely and nothing becomes ambiguous. Gating it would force either a
  // colour the design does not want or a permanently-red gate — and a gate
  // people learn to ignore protects nothing.
  ['focus ring vs button border', '--cocoa-900', '--candy-red', 3],
  ['focus ring vs focus fill', '--cocoa-900', '--blue', 3],
  ['focus ring vs mode-engaged fill', '--cocoa-900', '--lilac', 3],
  ['focus ring vs navbar fill', '--cocoa-900', '--amber', 3],
  ['slider thumb vs track', '--plum-700', '--track', 3],
]

let failures = 0
const rows = PAIRS.map(([what, fg, bg, bar]) => {
  const r = ratio(val(fg), val(bg))
  const ok = r >= bar
  if (!ok) failures++
  return { what, fg, bg, bar, r: r.toFixed(2), ok }
})

const w = Math.max(...rows.map((x) => x.what.length))
for (const x of rows) {
  process.stdout.write(
    `  ${x.ok ? 'PASS' : 'FAIL'}  ${x.what.padEnd(w)}  ${String(x.r).padStart(6)}:1  (need ${x.bar}:1)  ${val(x.fg)} on ${val(x.bg)}\n`,
  )
}
process.stdout.write(`\nCONTRAST_RESULT pairs=${rows.length} fail=${failures}\n`)
if (failures) {
  process.stdout.write(
    'A failing pair means the palette cannot be shipped as-is, not that the gate needs relaxing.\n',
  )
  process.exit(1)
}

function fail(msg) {
  process.stderr.write(`contrast-check: ${msg}\n`)
  process.exit(2)
}
