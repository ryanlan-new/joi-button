// SPDX-License-Identifier: MIT
//
// The theme: what the owner may set, and the three things they must not be able
// to do through a form that takes sixteen colours.
//
//   1. write arbitrary CSS (the token roster is closed, and the renderer
//      re-checks every value even though the validator already did)
//   2. ship a palette nobody can read (the same contrast roster the build gate
//      uses on the default palette, applied to theirs)
//   3. put text on top of a picture (STORY-035: with a wallpaper, the content
//      backing must be opaque, so body contrast is decided by tokens)
//
// The default palette is used as the "good" fixture throughout, read from
// src/App.vue rather than retyped — if the defaults ever stopped passing their
// own gate, these tests would be asserting against a palette the site does not
// ship.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { CONTRAST_PAIRS, contrastRatio, evaluatePalette, isTranslucent } from '../lib/contrast.mjs'
import { THEME_REJECTIONS, TOKEN_NAMES, renderThemeCss, validateTheme } from '../lib/theme.mjs'

function defaultTokens() {
  const css = readFileSync(new URL('../../src/App.vue', import.meta.url), 'utf8')
  const block = css.match(/:root\s*\{([\s\S]*?)\}/)
  assert.ok(block, 'src/App.vue has no :root block')
  const tokens = {}
  for (const [, name, value] of block[1].matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    tokens[name] = value
  }
  // --content-bg is read by .main-content with a `transparent` fallback and is
  // not declared in :root, so a theme has to supply it. White is what the page
  // effectively has today.
  tokens['--content-bg'] = '#ffffff'
  return tokens
}

const GOOD = { name: 'Default', tokens: defaultTokens() }

test('the shipped defaults pass the theme validator, so the good fixture is really good', () => {
  // If this fails, every "refused for reason X" case below could be passing for
  // reason Y and nobody would know.
  const verdict = validateTheme(GOOD)
  assert.deepEqual(verdict.problems, [])
  assert.equal(verdict.ok, true)
})

test('the token roster is closed: an unknown name is refused, by name', () => {
  const verdict = validateTheme({ ...GOOD, tokens: { ...GOOD.tokens, '--evil': '#000000' } })
  assert.equal(verdict.ok, false)
  const problem = verdict.problems.find((p) => p.code === THEME_REJECTIONS.unknown_token)
  assert.ok(problem, JSON.stringify(verdict.problems))
  assert.equal(problem.token, '--evil')
})

test('a value that is not a colour is refused, and so is the CSS-injection shape', () => {
  // The reason the roster is closed AND the values are pattern-checked: either
  // alone leaves a hole. This is the payload that would close the :root block
  // and open a rule of its own.
  for (const payload of ['red', '#12345', 'url(x)', '#000; } body { display:none', '', null, 42, {}]) {
    const verdict = validateTheme({ ...GOOD, tokens: { ...GOOD.tokens, '--cream': payload } })
    assert.equal(verdict.ok, false, JSON.stringify(payload))
    assert.ok(
      verdict.problems.some((p) => p.code === THEME_REJECTIONS.not_a_colour && p.token === '--cream'),
      `${JSON.stringify(payload)} was not refused as a colour: ${JSON.stringify(verdict.problems)}`,
    )
  }
})

test('a translucent token is refused, because it has no single contrast ratio', () => {
  assert.equal(isTranslucent('#ffffff80'), true)
  assert.equal(isTranslucent('#ffffffff'), false)
  assert.equal(isTranslucent('#ffffff'), false)

  const verdict = validateTheme({ ...GOOD, tokens: { ...GOOD.tokens, '--surface': '#ffffff80' } })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.problems.some((p) => p.code === THEME_REJECTIONS.translucent && p.token === '--surface'))
})

test('a missing token is named rather than defaulted', () => {
  const tokens = { ...GOOD.tokens }
  delete tokens['--track']
  const verdict = validateTheme({ ...GOOD, tokens })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.problems.some((p) => p.code === THEME_REJECTIONS.missing_token && p.token === '--track'))
})

test('EVERY problem is reported, not the first', () => {
  // Sixteen colour inputs and one problem per save is a form nobody reads the
  // messages on.
  const tokens = { ...GOOD.tokens, '--cream': 'red', '--amber': 'blue', '--extra': '#000000' }
  delete tokens['--pink']
  const verdict = validateTheme({ name: '', tokens })
  const codes = new Set(verdict.problems.map((p) => p.code))
  assert.ok(codes.has(THEME_REJECTIONS.name_empty), [...codes].join())
  assert.ok(codes.has(THEME_REJECTIONS.not_a_colour))
  assert.ok(codes.has(THEME_REJECTIONS.unknown_token))
  assert.ok(codes.has(THEME_REJECTIONS.missing_token))
  assert.ok(verdict.problems.length >= 5)
})

test('a readable-looking palette that fails a real pairing is refused, with the pairing named', () => {
  // A pale ink on white: plausible in a colour picker, 2.24:1 on the button face
  // that every visitor reads. This is the case the owner cannot catch by eye,
  // and it is why the form is gated rather than advisory.
  const tokens = { ...GOOD.tokens, '--plum-700': '#c9a0cc' }
  assert.ok(contrastRatio('#c9a0cc', '#ffffff') < 4.5)

  const verdict = validateTheme({ ...GOOD, tokens })
  assert.equal(verdict.ok, false)
  const failures = verdict.problems.filter((p) => p.code === THEME_REJECTIONS.contrast)
  assert.ok(failures.length >= 1, JSON.stringify(verdict.problems))
  assert.match(failures[0].detail, /voice button, resting: 2\.24:1/)
})

test('the contrast rules the theme uses ARE the ones the build gate uses', () => {
  // The whole reason server/lib/contrast.mjs exists rather than a second copy in
  // deploy/. If these ever became two rosters, the build would gate one set of
  // pairings and the API another, and the site would ship a palette the build
  // considered fine.
  assert.ok(CONTRAST_PAIRS.length >= 18)
  const { rows, failures, missing } = evaluatePalette(GOOD.tokens)
  assert.deepEqual(missing, [])
  assert.equal(rows.length, CONTRAST_PAIRS.length)
  assert.equal(failures, 0)
})

test('the content backing may be transparent WITHOUT a wallpaper and not WITH one (STORY-035)', () => {
  // Both directions, because a rule that only ever refuses is indistinguishable
  // from a token that is simply banned — and this one was exactly that until the
  // blanket translucency check exempted --content-bg. A transparent backing over
  // the plain page colour is what the site does today; it is only once there is
  // a picture behind it that the text's contrast would depend on the picture.
  const transparent = { ...GOOD.tokens, '--content-bg': '#ffffff00' }
  const wallpaperPath = `ab/cd/${'f'.repeat(64)}.png`

  assert.equal(validateTheme({ ...GOOD, tokens: transparent }).ok, true, 'no wallpaper: transparent is fine')
  assert.equal(validateTheme({ ...GOOD, wallpaperPath }).ok, true, 'wallpaper + opaque backing is fine')

  const verdict = validateTheme({ ...GOOD, wallpaperPath, tokens: transparent })
  assert.equal(verdict.ok, false, 'wallpaper + transparent backing was accepted')
  assert.deepEqual(
    verdict.problems.map((p) => p.code),
    [THEME_REJECTIONS.content_backing_translucent],
    'the ONLY problem should be this one; anything else means it fired for the wrong reason',
  )
})

test('the rendered stylesheet contains only the roster, in one :root block', () => {
  const css = renderThemeCss(GOOD)
  assert.equal((css.match(/:root/g) || []).length, 1)
  assert.equal((css.match(/\{/g) || []).length, 1, 'a second block would be a second rule')
  for (const name of TOKEN_NAMES) {
    assert.match(css, new RegExp(`${name}: #[0-9a-f]{3,8};`), name)
  }
  // Nothing else got in.
  for (const line of css.split('\n')) {
    if (line.trim().startsWith('--')) {
      assert.match(line, /^\s{2}--[a-z0-9-]+: #[0-9a-f]{3,8};$/, line)
    }
  }
})

test('the renderer refuses a value the validator would have caught, rather than emitting it', () => {
  // A renderer that trusts its input is one refactor away from being the
  // injection point. This is the assertion that the second check is real.
  assert.throws(
    () => renderThemeCss({ tokens: { ...GOOD.tokens, '--cream': '#000; } body { display:none' } }),
    /not a colour/,
  )
})

test('a wallpaper renders as a fixed backdrop, and only from a content-addressed path', () => {
  const url = '/media/ab/cd/' + 'f'.repeat(64) + '.png'
  const css = renderThemeCss({ tokens: GOOD.tokens, wallpaperUrl: url })
  assert.match(css, new RegExp(`background-image: url\\("${url.replace(/\//g, '\\/')}"\\)`))
  assert.match(css, /background-attachment: fixed/)

  // Anything else is refused. A ')' or a '"' in the url would end the url() and
  // start whatever came next.
  for (const bad of [
    'https://elsewhere.example/x.png',
    '/media/../../etc/passwd',
    '/media/ab/cd/x.png',
    `/media/ab/cd/${'f'.repeat(64)}.svg`,
    `/media/ab/cd/${'f'.repeat(64)}.png") ; body { display:none } a:hover { background: url("`,
  ]) {
    assert.throws(() => renderThemeCss({ tokens: GOOD.tokens, wallpaperUrl: bad }), /content-addressed/, bad)
  }
})

test('no wallpaper means no body rule at all', () => {
  const css = renderThemeCss({ tokens: GOOD.tokens })
  assert.equal(css.includes('background-image'), false)
  assert.equal(css.includes('body'), false)
})
