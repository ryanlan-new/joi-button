// SPDX-License-Identifier: MIT
//
// The challenge-phrase generator and matcher.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ACTION,
  CHALLENGE_ENTROPY_BITS,
  SCENE,
  danmakuCarriesPhrase,
  generateChallengePhrase,
  normalizeForMatch,
} from '../lib/challenge-phrase.mjs'

test('every phrase carries 橘子 — the owner-facing marker and the ask', () => {
  for (let i = 0; i < 500; i += 1) {
    assert.ok(generateChallengePhrase().includes('橘子'), 'a phrase came out without 橘子')
  }
})

test('a phrase is all Chinese-and-digits — no bare letter runs a filter reads as a code', () => {
  // The whole point: it must NOT look like XK7RPM. Allow CJK, the fixed
  // template glyphs, and the digits of the number slot; forbid ASCII letters.
  for (let i = 0; i < 300; i += 1) {
    const phrase = generateChallengePhrase()
    assert.ok(!/[A-Za-z]/.test(phrase), `phrase has a latin letter run: ${phrase}`)
    assert.ok(/^[一-鿿0-9]+$/.test(phrase), `phrase has an unexpected character: ${phrase}`)
    assert.ok([...phrase].length <= 16, `phrase is ${[...phrase].length} chars — too long for a low-level account: ${phrase}`)
  }
})

test('entropy floor holds, so a future bank edit cannot silently shrink the space', () => {
  // Computed from the banks, not hand-written. If someone trims a bank this
  // fails rather than quietly weakening every code.
  assert.ok(CHALLENGE_ENTROPY_BITS >= 17, `entropy dropped to ${CHALLENGE_ENTROPY_BITS.toFixed(2)} bits`)
})

test('no duplicate words within a bank — a dup is dead entropy pretending to be alive', () => {
  assert.equal(new Set(SCENE).size, SCENE.length, 'SCENE has a duplicate')
  assert.equal(new Set(ACTION).size, ACTION.length, 'ACTION has a duplicate')
})

test('the space is actually exercised — a big sample stays highly distinct', () => {
  const seen = new Set()
  for (let i = 0; i < 2000; i += 1) seen.add(generateChallengePhrase())
  // With ~225k phrases, 2000 draws collide only a handful of times (birthday).
  assert.ok(seen.size > 1950, `only ${seen.size}/2000 distinct — the generator is not spreading`)
})

test('pick is injectable, so a test can pin an exact phrase', () => {
  const phrase = generateChallengePhrase(() => 0)
  assert.equal(phrase, `${SCENE[0]}的第2颗橘子${ACTION[0]}`)
})

test('a danmaku that contains the phrase matches; a near-miss does not', () => {
  const phrase = generateChallengePhrase(() => 0)
  assert.ok(danmakuCarriesPhrase(phrase, phrase), 'exact phrase should match')
  assert.ok(danmakuCarriesPhrase(`今天也发一句：${phrase} 加油`, phrase), 'phrase wrapped in chatter should match')
  assert.ok(danmakuCarriesPhrase(phrase.replace('第2颗', '第 2 颗'), phrase), 'internal spaces should not defeat the match')
  assert.ok(!danmakuCarriesPhrase(phrase.replace('橘子', '苹果'), phrase), 'a substituted word must NOT match')
  assert.ok(!danmakuCarriesPhrase('深海的橘子', phrase), 'a partial phrase must NOT match')
})

test('NFKC folds full-width digits the danmaku box inserts', () => {
  const phrase = `${SCENE[0]}的第7颗橘子${ACTION[0]}`
  const fullwidthSeven = `${SCENE[0]}的第７颗橘子${ACTION[0]}`
  assert.ok(danmakuCarriesPhrase(fullwidthSeven, phrase), 'a full-width 7 should match a plain 7')
  assert.equal(normalizeForMatch('第７颗'), '第7颗')
})

test('normalizeForMatch is total — non-strings fold to empty rather than throwing', () => {
  assert.equal(normalizeForMatch(undefined), '')
  assert.equal(normalizeForMatch(null), '')
  assert.equal(danmakuCarriesPhrase(undefined, undefined), false)
})
