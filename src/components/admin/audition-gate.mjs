// SPDX-License-Identifier: MIT
//
// The listen-before-approve decision, as two plain functions.
//
// Extracted out of ClipAudition.vue so it can be tested. It is the piece with
// real arithmetic in it and the piece that was wrong: the component's own
// comment claimed a truncated file produces no `ended` at all, and the opposite
// is true — a file cut short on the volume fires `ended` EARLY, at whatever
// length the browser decoded. Measured on this repository's own media: the whole
// file ends at 18.49s, the same bytes cut to 35% end at 6.22s, `ended` both
// times. The wall-clock stall estimate cannot catch that, because it only trips
// on an OVERRUN.
//
// Everything about playback stays in the component; what is here is only "given
// what the element reported, was this clip actually heard?".

/**
 * How far short of the recorded length still counts as "heard".
 *
 * Two terms, because the error being tolerated has two sources. The absolute
 * floor covers rounding: the server records duration from the decoded stream at
 * acceptance and the browser reports its own, and mp3 frame boundaries make
 * those disagree by tens of milliseconds routinely. The proportional term covers
 * the same effect on a long clip.
 *
 * Generous on purpose. This must not fire on a clip that played fine, or the
 * reviewer learns to ignore it — and a warning that is ignored is worse than no
 * warning. A truncation worth catching is a file cut off on the volume, short by
 * a third or more, not by half a second.
 */
export const SHORTFALL_FLOOR_SECONDS = 0.5
export const SHORTFALL_FRACTION = 0.05

/**
 * How much audio the media element says it played, or null when it will not say.
 *
 * currentTime first: at `ended` it IS the played length, and it stays correct if
 * a browser ever reports a duration the playhead did not reach. duration is the
 * fallback. Anything non-finite or non-positive — a live stream, a browser that
 * reports NaN before metadata — returns null.
 *
 * @param {{currentTime?: number, duration?: number}|null|undefined} played
 * @returns {number|null} seconds, or null when unmeasurable
 */
export function playedLength(played) {
  if (played === null || typeof played !== 'object') return null
  for (const value of [played.currentTime, played.duration]) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return null
}

/**
 * Rounding slack for a clip of this recorded length.
 *
 * @param {number} durationSeconds as recorded in the database at acceptance
 */
export function shortfallTolerance(durationSeconds) {
  const recorded = typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)
    ? durationSeconds
    : 0
  return Math.max(SHORTFALL_FLOOR_SECONDS, recorded * SHORTFALL_FRACTION)
}

/**
 * Did this `ended` mean the clip was heard?
 *
 * @param {{currentTime?: number, duration?: number}|null|undefined} played
 *        what App.vue read off the media element when it fired `ended`
 * @param {number} durationSeconds the length recorded when the file was accepted
 * @returns {{heard: boolean, playedSeconds: number|null}}
 *
 * `heard: true` with `playedSeconds: null` is the UNMEASURABLE case, and it is
 * deliberately permissive: a browser that reports neither a finite currentTime
 * nor a finite duration gives nothing to compare, and blocking on that would
 * make the desk unusable on it. This is a guard against approving by reflex on
 * the fortieth clip of an evening, not an access control — server/routes/admin.mjs
 * will accept an approval from a client that never played anything, and nothing
 * decided here is sent to it.
 */
export function judgeEnded(played, durationSeconds) {
  const playedSeconds = playedLength(played)
  if (playedSeconds === null) return { heard: true, playedSeconds: null }

  const recorded = typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)
    ? durationSeconds
    : 0
  // Only SHORT counts. A clip that plays LONGER than recorded is not a
  // truncation — it is the same rounding in the other direction, or a duration
  // the server under-measured, and refusing to credit it would block approval of
  // a file that is entirely present.
  const short = recorded - playedSeconds > shortfallTolerance(recorded)
  return { heard: !short, playedSeconds }
}
