// SPDX-License-Identifier: MIT
//
// Loudness normalization for submitted clips: what MP3GainGUI did by hand, done
// by the intake pipeline so nobody has to be told to do it.
//
// ===========================================================================
// THE TARGET IS 80 dB, AND THAT NUMBER WAS MEASURED, NOT COPIED FROM PROSE
// ===========================================================================
// The pre-rebuild README told contributors to normalize with MP3Gain to "80".
// Prose like that goes stale, so the 12 baseline clips were measured before this
// file was written (2026-08-01, ffmpeg -af replaygain over public/voices/*.mp3):
// track_gain came back +8.39 .. +9.64 dB relative to ReplayGain's 89 dB SPL
// reference, mean +8.85 — the wall really does sit at ≈ 80.1 dB, so the prose
// was true and the convention is kept. The scatter (±0.6 dB) is MP3Gain's own
// 1.5 dB step granularity; this pipeline lands exactly on target instead.
//
// PREMISE this constant depends on: the baseline import (import-snapshot.mjs)
// hashes public/voices/*.mp3 as they are. If those files are ever re-mastered
// to a different level, re-measure and move this constant with them — a target
// that matches neither the old wall nor the new one is worse than either.
export const AUDIO_TARGET_DB = 80.0

/** ReplayGain's reference level. track_gain values are relative to this. */
export const REPLAYGAIN_REFERENCE_DB = 89.0

// ===========================================================================
// WHY ReplayGain ANALYSIS AND NOT EBU R128 / loudnorm
// ===========================================================================
// Measured, same session: the baseline clip "Ei?" is 0.24 s long. ffmpeg's
// ebur128 filter reports its integrated loudness as -70.0 LUFS — the gating
// floor, i.e. "unmeasurable" — because R128 integration needs 400 ms blocks and
// the whole clip is shorter than that. loudnorm would read that -70 and slam
// +50 dB of gain into it. A voice-button site is MADE of sub-second clips, so
// R128 is disqualified by the content, not by preference. ReplayGain 1
// (50 ms RMS windows, 95th percentile) measured the same 0.24 s clip at +9.59 dB
// — consistent with its 8-second siblings. It is also what MP3Gain used, so new
// clips are measured with the same ruler the baseline was.
//
// ===========================================================================
// WHY EVERY ACCEPTED UPLOAD IS RE-ENCODED, EVEN ONE ALREADY AT TARGET
// ===========================================================================
// MP3Gain's lossless trick (rewriting the per-frame global_gain field) was
// considered and deliberately not used, for three reasons:
//
//   1. Coverage. classifyAudio admits four containers (mp3/wav/ogg/m4a); the
//      lossless-gain family covers mp3 (mp3gain, in Alpine) and ogg
//      (vorbisgain) but not m4a (aacgain is NOT in Alpine — checked 2026-08-01)
//      and the concept does not exist for WAV. One engine that handles all four
//      beats two engines and a gap.
//   2. Posture. The wallpaper pipeline re-encodes every image and strips EXIF
//      on purpose (lib/wallpaper.mjs). Audio passed through losslessly would
//      publish the submitter's original bytes — ID3/Vorbis tags included, which
//      can carry anything — into an immutable, content-addressed, publicly
//      cached URL. Re-encoding with -map_metadata -1 gives audio the same
//      property images already have: nothing a submitter embeds survives.
//   3. The published file is the server's product, uniformly. No "this one was
//      touched, that one wasn't" split for a reviewer to reason about.
//
// The cost is one lossy re-encode of clips that are stream-rip memes capped at
// 5 MB / ~18 s, at 192 kbps — accepted with eyes open.
//
// Determinism: -bitexact on both muxer and codec strips encoder-version tags
// and timestamps, so the same input bytes produce the same output bytes on the
// same ffmpeg build. That is what keeps duplicate detection working: the same
// original submitted twice normalizes to the same sha256, and `duplicate_in_
// batch` / `already_published` still mean what they say.
//
// The deployed binary is Alpine's ffmpeg (8.1.2 at adoption, +48.3 MiB on the
// api image — 72.7 -> 121.1 MiB by docker image inspect .Size, and accepted as
// the price of the whole feature). The replaygain filter, libmp3lame, native
// aac and libvorbis were all confirmed present in that build before this file
// was written.

import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** ffmpeg stderr → the two numbers the replaygain filter prints. */
const TRACK_GAIN = /track_gain = ([+-]?\d+(?:\.\d+)?) dB/
const TRACK_PEAK = /track_peak = (\d+(?:\.\d+)?)/

/**
 * Sanity ceiling on applied gain, either direction. The replaygain filter
 * itself answers +51 dB for digital silence; amplifying silence by 51 dB is
 * still silence, but there is no reason to hand an encoder a wilder number
 * than ±40 ever needs to be for real speech.
 */
const MAX_GAIN_DB = 40

/**
 * Headroom kept below full scale when a gain increase would push the measured
 * peak against 1.0. In dB. Clipping a clip to make it louder is the one way
 * this pipeline could make audio WORSE than submitted; the margin is why it
 * cannot.
 */
const PEAK_MARGIN_DB = 0.2

/**
 * Encoder/muxer per accepted container. Keyed by the `ext` classifyAudio
 * assigns, which is also the extension the media store will serve under, so
 * the output must genuinely be that container.
 *
 * The muxer is forced with -f because staged files are EXTENSIONLESS on
 * purpose (routes/public.mjs sniffs bytes, never names), and ffmpeg would
 * otherwise refuse to guess an output container.
 */
const ENCODERS = Object.freeze({
  mp3: Object.freeze({ muxer: 'mp3', args: Object.freeze(['-c:a', 'libmp3lame', '-b:a', '192k']) }),
  wav: Object.freeze({ muxer: 'wav', args: Object.freeze(['-c:a', 'pcm_s16le']) }),
  ogg: Object.freeze({ muxer: 'ogg', args: Object.freeze(['-c:a', 'libvorbis', '-q:a', '5']) }),
  m4a: Object.freeze({ muxer: 'mp4', args: Object.freeze(['-c:a', 'aac', '-b:a', '160k']) }),
})

export class LoudnessError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause })
    this.name = 'LoudnessError'
  }
}

/**
 * The gain to apply, from a measurement. Exported bare because it is the one
 * piece of this file that is arithmetic rather than process management, and
 * the tests for the clamp belong to the arithmetic.
 *
 * @param {number} trackGainDb  replaygain's answer: dB to reach 89
 * @param {number} trackPeak    linear peak, 0..~1
 * @param {number} targetDb     where this site's wall sits
 * @returns {number} dB to apply, rounded to 0.01 (argument stability)
 */
export function decideGain(trackGainDb, trackPeak, targetDb = AUDIO_TARGET_DB) {
  let gain = trackGainDb - (REPLAYGAIN_REFERENCE_DB - targetDb)
  if (trackPeak > 0) {
    // The most this clip can be turned up before its measured peak hits full
    // scale, minus the margin. Only an upper bound: turning DOWN never clips.
    const headroom = -20 * Math.log10(trackPeak) - PEAK_MARGIN_DB
    if (gain > headroom) gain = headroom
  }
  if (gain > MAX_GAIN_DB) gain = MAX_GAIN_DB
  if (gain < -MAX_GAIN_DB) gain = -MAX_GAIN_DB
  return Math.round(gain * 100) / 100
}

/**
 * @param {object} [options]
 * @param {string} [options.ffmpegPath]  binary to spawn; PATH-resolved name by default
 * @param {number} [options.targetDb]
 * @param {number} [options.timeoutMs]   per ffmpeg invocation; uploads are ≤5 MB
 */
export function createLoudnessNormalizer({
  ffmpegPath = 'ffmpeg',
  targetDb = AUDIO_TARGET_DB,
  timeoutMs = 30_000,
} = {}) {
  const exec = (args) =>
    run(ffmpegPath, ['-hide_banner', '-nostats', ...args], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      // No shell: file paths travel as argv entries, never through a parser.
    })

  /**
   * Boot-time check that the binary exists and is a build that can do this
   * job. server.mjs calls this once and refuses to start without it, because
   * "every upload fails at the normalize step" discovered at first submission
   * is strictly worse than "the process would not boot" discovered at deploy.
   */
  async function probe() {
    let filters
    try {
      ;({ stdout: filters } = await exec(['-filters']))
    } catch (error) {
      throw new LoudnessError(
        `loudness: ${ffmpegPath} could not be executed. The submission pipeline normalizes ` +
          'every clip and cannot run without it. In the API image it comes from `apk add ffmpeg`; ' +
          'on a dev machine, `brew install ffmpeg` (macOS) or the distro package.',
        { cause: error },
      )
    }
    if (!/\breplaygain\b/.test(filters)) {
      throw new LoudnessError(
        `loudness: ${ffmpegPath} exists but has no replaygain filter; this build cannot measure clips.`,
      )
    }

    // The filter measures; the ENCODERS re-encode. A build can have replaygain
    // and still lack an encoder for one of the four accepted containers — a
    // Homebrew ffmpeg without libvorbis is the common case, and this test file's
    // own container legs skip on exactly that. Checking only the filter would
    // let such a build boot "healthy" and then reject the first ogg upload with
    // audio_processing_failed, which is precisely the "discovered at first
    // submission" failure this probe exists to prevent. The names come from
    // ENCODERS itself (the -c:a argument), so the check cannot drift from what
    // normalize() actually spawns.
    const required = [...new Set(Object.values(ENCODERS).map((e) => e.args[e.args.indexOf('-c:a') + 1]))]
    let encoders
    try {
      ;({ stdout: encoders } = await exec(['-encoders']))
    } catch (error) {
      throw new LoudnessError(`loudness: ${ffmpegPath} would not list its encoders`, { cause: error })
    }
    const missing = required.filter((name) => !new RegExp(`^\\s*\\S*\\s+${name}\\b`, 'm').test(encoders))
    if (missing.length > 0) {
      throw new LoudnessError(
        `loudness: ${ffmpegPath} has the replaygain filter but is missing encoder(s) [${missing.join(', ')}], ` +
          'so uploads in the matching container(s) would be rejected at normalize time. The Alpine build in ' +
          'the API image carries all four; a dev ffmpeg may not (Homebrew often omits libvorbis).',
      )
    }
  }

  /**
   * Measure one file. Exposed on the instance because the tests and the smoke
   * path verify OUTPUT loudness with the same ruler the pipeline measures with.
   *
   * @returns {{ trackGainDb: number, trackPeak: number }}
   */
  async function measure(path) {
    let stderr
    try {
      ;({ stderr } = await exec(['-i', path, '-map', '0:a:0', '-af', 'replaygain', '-f', 'null', '-']))
    } catch (error) {
      throw new LoudnessError(`loudness: ffmpeg could not decode this file for measurement`, {
        cause: error,
      })
    }
    const gain = TRACK_GAIN.exec(stderr)
    const peak = TRACK_PEAK.exec(stderr)
    if (gain === null || peak === null) {
      throw new LoudnessError('loudness: ffmpeg decoded the file but the replaygain filter reported nothing')
    }
    return { trackGainDb: Number(gain[1]), trackPeak: Number(peak[1]) }
  }

  /**
   * Measure, decide, re-encode. Writes `${inPath}.norm` (same directory, so the
   * caller's later rename into the media store stays on one filesystem) and
   * returns what was done. Never touches the input file.
   *
   * @param {string} inPath  staged upload (extensionless)
   * @param {{ ext: string }} kind  classifyAudio's verdict for the INPUT
   */
  async function normalize(inPath, kind) {
    const encoder = ENCODERS[kind.ext]
    if (encoder === undefined) {
      throw new LoudnessError(`loudness: no encoder for container '${kind.ext}'`)
    }
    const { trackGainDb, trackPeak } = await measure(inPath)
    const gainDb = decideGain(trackGainDb, trackPeak, targetDb)
    const outPath = `${inPath}.norm`
    try {
      await exec([
        '-y',
        '-i', inPath,
        // First audio stream only. -vn drops embedded cover art, which mp3s
        // carry as a video stream and which would otherwise survive into the
        // published file after -map_metadata already removed the tags.
        '-map', '0:a:0',
        '-vn',
        '-map_metadata', '-1',
        '-fflags', '+bitexact',
        '-flags:a', '+bitexact',
        '-af', `volume=${gainDb}dB`,
        ...encoder.args,
        '-f', encoder.muxer,
        outPath,
      ])
    } catch (error) {
      // ffmpeg opens outPath at mux start, so a timeout (SIGTERM), an encoder
      // error or ENOSPC leaves a PARTIAL .norm behind. This is the only place
      // that file's name is known — the caller catches an exception and has no
      // `result` to clean. If it is not removed here it is stranded forever:
      // staging is a PVC, nothing sweeps incoming/ (backup.mjs documents that
      // it relies on the request path discarding), and a submitter with an
      // input that reliably times out the re-encode could fill the one writable
      // volume one orphan at a time. The producer cleans its own mess.
      await rm(outPath, { force: true }).catch(() => {})
      throw new LoudnessError('loudness: ffmpeg could not re-encode this file', { cause: error })
    }
    return { path: outPath, gainDb, trackGainDb, trackPeak }
  }

  return Object.freeze({ probe, measure, normalize, targetDb })
}
