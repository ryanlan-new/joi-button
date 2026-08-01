// SPDX-License-Identifier: MIT
//
// The review desk's listen-before-approve decision.
//
// This is the first test in the frontend, and it exists because the defect it
// covers survived a full component review: ClipAudition.vue's own header
// asserted that a truncated file produces no `ended` event, so approval would
// stay blocked by the wall-clock stall estimate. The opposite is true. Measured
// in Chrome against this repository's own media
// (public/voices/Arctic Eggs_I can't bear it (premium ver.).mp3, 453,049 bytes):
//
//   whole file        `ended` at currentTime 18.49, duration 18.49
//   first 35% of it   `ended` at currentTime  6.22, duration  6.22
//
// Both fire `ended`. The stall estimate only trips on an OVERRUN, so a clip that
// ends at 6.22s against a recorded 18.49s never trips it, and the gate opened
// after a third of the audio.
//
// Those two measured pairs are the fixtures below, so this file goes red if the
// comparison is removed or inverted.
//
//   node --test test/

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SHORTFALL_FLOOR_SECONDS,
  adoptsEnded,
  judgeEnded,
  playedLength,
  shortfallTolerance,
  standsDownFor,
} from '../src/components/admin/audition-gate.mjs'

// The two measurements above, verbatim.
const WHOLE = { currentTime: 18.49, duration: 18.49 }
const TRUNCATED_TO_35_PERCENT = { currentTime: 6.22, duration: 6.22 }
const RECORDED_SECONDS = 18.49

test('the whole file opens the gate', () => {
  const verdict = judgeEnded(WHOLE, RECORDED_SECONDS)
  assert.equal(verdict.heard, true)
  assert.equal(verdict.playedSeconds, 18.49)
})

test('the same bytes cut to 35% do NOT open the gate', () => {
  const verdict = judgeEnded(TRUNCATED_TO_35_PERCENT, RECORDED_SECONDS)
  assert.equal(verdict.heard, false, 'a clip that stopped at 6.22s of 18.49s was credited as heard')
  // The number is reported, not just the refusal: the reviewer is shown both
  // lengths, because "it stopped early" is a claim they should be able to check.
  assert.equal(verdict.playedSeconds, 6.22)
})

test('rounding does not fire the warning, in either direction', () => {
  // The server records duration from the decoded stream at acceptance and the
  // browser reports its own; mp3 frame boundaries make those disagree by tens of
  // milliseconds routinely. A warning that fires on that is a warning the
  // reviewer learns to ignore.
  for (const drift of [0, 0.01, 0.2, 0.49]) {
    const verdict = judgeEnded({ currentTime: RECORDED_SECONDS - drift, duration: RECORDED_SECONDS }, RECORDED_SECONDS)
    assert.equal(verdict.heard, true, `a ${drift}s shortfall was treated as a truncation`)
  }

  // LONGER than recorded is not a truncation. It is the same rounding the other
  // way, or a duration the server under-measured, and refusing to credit it
  // would block approval of a file that is entirely present.
  const long = judgeEnded({ currentTime: RECORDED_SECONDS + 5, duration: RECORDED_SECONDS + 5 }, RECORDED_SECONDS)
  assert.equal(long.heard, true)
})

test('the tolerance is proportional above the floor and flat below it', () => {
  // A 2-second clip gets the floor (0.5s), not 5% of 2s = 0.1s — otherwise the
  // shortest clips would be the ones most likely to warn falsely, which is
  // backwards: they are the ones where frame-boundary rounding is the largest
  // share of the total.
  assert.equal(shortfallTolerance(2), SHORTFALL_FLOOR_SECONDS)
  assert.equal(shortfallTolerance(60), 3)
  // Nonsense in, floor out. Never NaN, which would make every comparison false
  // and silently reopen the gate.
  for (const bad of [undefined, null, NaN, Infinity, 'ten']) {
    assert.equal(shortfallTolerance(bad), SHORTFALL_FLOOR_SECONDS, String(bad))
  }
})

test('a 60-second clip that stopped at 40 seconds is caught', () => {
  // The proportional term matters here: 5% of 60s is 3s, so this is not near the
  // boundary — but a flat 0.5s tolerance would ALSO catch it, and a test that
  // only used a short clip could not tell the two rules apart.
  assert.equal(judgeEnded({ currentTime: 40, duration: 40 }, 60).heard, false)
  // Just inside the proportional tolerance.
  assert.equal(judgeEnded({ currentTime: 57.5, duration: 60 }, 60).heard, true)
  // Just outside it.
  assert.equal(judgeEnded({ currentTime: 56.9, duration: 60 }, 60).heard, false)
})

test('currentTime is preferred over duration', () => {
  // The case this ordering exists for: a browser reports a full duration for a
  // file whose playhead never got there. Reading duration would credit it.
  const verdict = judgeEnded({ currentTime: 6.22, duration: 18.49 }, RECORDED_SECONDS)
  assert.equal(verdict.heard, false)
  assert.equal(verdict.playedSeconds, 6.22)
})

test('an unmeasurable ended is credited, and says so by reporting no length', () => {
  // A live stream, or a browser that reports NaN before metadata. There is
  // nothing to compare, and blocking on that would make the desk unusable on
  // that browser. Stated as a ceiling in audition-gate.mjs rather than hidden.
  for (const played of [null, undefined, {}, { currentTime: NaN, duration: NaN }, { currentTime: 0, duration: Infinity }, 'ended']) {
    const verdict = judgeEnded(played, RECORDED_SECONDS)
    assert.equal(verdict.heard, true, JSON.stringify(played))
    assert.equal(verdict.playedSeconds, null, JSON.stringify(played))
  }
})

test('playedLength reads only finite positive numbers', () => {
  assert.equal(playedLength({ currentTime: 3, duration: 9 }), 3)
  assert.equal(playedLength({ currentTime: 0, duration: 9 }), 9)
  assert.equal(playedLength({ duration: 9 }), 9)
  assert.equal(playedLength({ currentTime: -1, duration: -1 }), null)
  assert.equal(playedLength({ currentTime: '3', duration: '9' }), null)
})

// --- attribution: which audition owns an `ended` (STORY-076 contamination) ---

test('only an audition with playback in flight adopts an ended', () => {
  assert.equal(adoptsEnded('playing'), true)
  assert.equal(adoptsEnded('stalled'), true)
  // Everything else has nothing in flight and must ignore the shared bus event.
  for (const phase of ['idle', 'paused', 'heard', 'truncated']) {
    assert.equal(adoptsEnded(phase), false, phase)
  }
})

test('an audition stands down when a DIFFERENT owner seizes the shared player, and only then', () => {
  // The bug this guards: the queue desk, left playing under v-show, must leave
  // 'playing'/'stalled'/'paused' when the recycle desk starts a clip — or it
  // adopts that clip's `ended` (playing/stalled), or resumes it (paused). A
  // takeover counts against any audition with a live or suspended playback
  // context...
  for (const phase of ['playing', 'stalled', 'paused']) {
    assert.equal(standsDownFor(phase, 'recycle-audition', 'queue-audition'), true, phase)
  }
  // ...not against one that is idle or done (nothing to lose)...
  for (const phase of ['idle', 'heard', 'truncated']) {
    assert.equal(standsDownFor(phase, 'recycle-audition', 'queue-audition'), false, phase)
  }
  // ...and never against its OWN play, or every playFromStart would cancel itself.
  assert.equal(standsDownFor('playing', 'queue-audition', 'queue-audition'), false)
  assert.equal(standsDownFor('paused', 'queue-audition', 'queue-audition'), false)
})
