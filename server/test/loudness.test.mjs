// SPDX-License-Identifier: MIT
//
// The loudness pipeline, verified with its own ruler: every "it landed at
// target" assertion re-MEASURES the output file with the same replaygain
// analysis the pipeline decides from, rather than trusting the gain arithmetic
// that produced it. Fixtures are synthesized here with the same ffmpeg the
// normalizer spawns, at known levels, so every expectation is derived rather
// than copied from a previous run.
//
// Tolerance: ±0.8 dB. Two real effects live inside it — the encoder reshapes
// the waveform slightly (192 kbps lame on a sine measures ~0.1-0.3 dB off the
// PCM it was fed), and ReplayGain's own analysis quantizes. The baseline wall's
// own scatter is ±0.64 dB, so a tolerance tighter than that would demand more
// of the pipeline than the convention it preserves ever achieved.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { parseFile } from 'music-metadata'

import {
  AUDIO_TARGET_DB,
  REPLAYGAIN_REFERENCE_DB,
  createLoudnessNormalizer,
  decideGain,
} from '../lib/loudness.mjs'

const run = promisify(execFile)
const dir = mkdtempSync(join(tmpdir(), 'joi-loudness-'))
test.after(() => rmSync(dir, { recursive: true, force: true }))

const normalizer = createLoudnessNormalizer()

// TOOLING PARITY, made visible instead of assumed. The deployed API runs on
// Alpine's ffmpeg, which carries libmp3lame, libvorbis and aac (verified in the
// image before this feature was adopted). A dev machine's ffmpeg may be built
// without some of them — a Homebrew build without libvorbis is common — and the
// ogg/m4a legs genuinely cannot run there, because lib/loudness.mjs's ENCODERS
// spawn those very encoders. Rather than fake a pass or hard-fail on a laptop,
// each container leg is gated on the host actually having its encoder, and a
// skip is ANNOUNCED with the reason. mp3 (libmp3lame) and wav (pcm_s16le) are
// treated as always-present and are hard requirements: a host that cannot do
// those cannot develop this server at all. The four-container guarantee in the
// environment that ships is asserted by deploy/smoke-image.sh, inside the image.
const HOST_ENCODERS = await run('ffmpeg', ['-hide_banner', '-encoders']).then(
  (r) => r.stdout,
  () => '',
)
const hostHas = (encoder) => new RegExp(`^\\s*\\S*\\s+${encoder}\\b`, 'm').test(HOST_ENCODERS)

/** Synthesize a fixture at a chosen level, in a chosen container. */
async function tone(name, { duration = 1, gainDb = -20, codec = ['-c:a', 'libmp3lame', '-b:a', '128k'], muxer = 'mp3', source } = {}) {
  const path = join(dir, name)
  await run('ffmpeg', [
    '-hide_banner', '-nostats', '-y',
    '-f', 'lavfi', '-i', source ?? `sine=frequency=440:sample_rate=44100:duration=${duration}`,
    '-af', `volume=${gainDb}dB`,
    ...codec, '-f', muxer,
    path,
  ])
  return path
}

/** Where a file sits, in the wall's terms (dB, ReplayGain reference). */
async function levelOf(path) {
  const { trackGainDb } = await normalizer.measure(path)
  return REPLAYGAIN_REFERENCE_DB - trackGainDb
}

test('probe accepts a complete ffmpeg and names the gap on an incomplete one', async () => {
  // probe() now checks the four ENCODERS, not just the replaygain filter, so its
  // verdict depends on the host — and the test asserts the CORRECT verdict for
  // whichever host runs it. In the Alpine API image all four are present and
  // probe resolves; on a dev ffmpeg without (commonly) libvorbis it must REFUSE
  // and say which encoder is missing, which is the boot guarantee itself. Either
  // outcome is a pass; a silent boot on an incomplete binary would not be.
  const complete = ['libmp3lame', 'pcm_s16le', 'libvorbis', 'aac'].every(hostHas)
  if (complete) {
    await normalizer.probe()
  } else {
    await assert.rejects(() => normalizer.probe(), /missing encoder/)
  }
})

test('a quiet clip is brought up to the wall', async () => {
  const input = await tone('quiet.mp3', { gainDb: -30 })
  const out = await normalizer.normalize(input, { ext: 'mp3' })
  assert.ok(out.gainDb > 0, `expected a boost, got ${out.gainDb} dB`)
  const landed = await levelOf(out.path)
  assert.ok(Math.abs(landed - AUDIO_TARGET_DB) <= 0.8, `landed at ${landed.toFixed(2)} dB, wanted ${AUDIO_TARGET_DB}`)
})

test('a loud clip is brought down to the wall', async () => {
  // MEASURED while writing this test: a FULL-SCALE 440 Hz sine sits at only
  // ≈82.3 dB in ReplayGain terms (the psychoacoustic weighting does not reward
  // a pure tone), so 0 dBFS is the loudest sine there is and it is still just
  // 2-ish dB above this wall. The first draft used −3 dBFS as "loud" and was
  // told, correctly, that 79.3 dB wants a BOOST.
  const input = await tone('loud.mp3', { gainDb: 0 })
  const out = await normalizer.normalize(input, { ext: 'mp3' })
  assert.ok(out.gainDb < 0, `expected a cut, got ${out.gainDb} dB`)
  const landed = await levelOf(out.path)
  assert.ok(Math.abs(landed - AUDIO_TARGET_DB) <= 0.8, `landed at ${landed.toFixed(2)} dB, wanted ${AUDIO_TARGET_DB}`)
})

test('a sub-second clip measures sanely — the case that disqualified EBU R128', async () => {
  // 0.24 s, the length of the baseline clip "Ei?". ebur128 reports -70 LUFS
  // (its gating floor) for material this short; a pipeline built on it would
  // decide +50 dB from that sentinel. ReplayGain's 50 ms windows just measure.
  // −15 dBFS sits ≈ 12.7 dB under the wall (from the full-scale-sine ≈ 82.3
  // measurement above). If the analysis answered a sentinel the way ebur128's
  // −70 LUFS is one, the decided gain would be +40-ish; a real measurement of
  // THIS fixture cannot legitimately exceed ~25.
  const input = await tone('blip.mp3', { duration: 0.24, gainDb: -15 })
  const out = await normalizer.normalize(input, { ext: 'mp3' })
  assert.ok(out.gainDb > 0 && out.gainDb < 25, `a 0.24 s clip decided ${out.gainDb} dB — sentinel arithmetic`)
  const landed = await levelOf(out.path)
  assert.ok(Math.abs(landed - AUDIO_TARGET_DB) <= 1.5, `landed at ${landed.toFixed(2)} dB`)
})

test('the same input twice produces byte-identical output — what keeps dedupe honest', async () => {
  const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
  const input = await tone('twice.mp3')
  const a = await normalizer.normalize(input, { ext: 'mp3' })
  const first = sha(a.path)
  rmSync(a.path)
  const b = await normalizer.normalize(input, { ext: 'mp3' })
  assert.equal(first, sha(b.path), 'the re-encode is not deterministic; duplicate detection is broken')
})

test('submitter metadata does not survive into the output', async () => {
  const bare = await tone('tagged-src.mp3')
  const tagged = join(dir, 'tagged.mp3')
  await run('ffmpeg', ['-hide_banner', '-nostats', '-y', '-i', bare,
    '-metadata', 'title=SHOULD-NOT-SURVIVE', '-metadata', 'artist=NOBODY',
    '-c:a', 'copy', '-f', 'mp3', tagged])
  const before = await parseFile(tagged)
  assert.equal(before.common.title, 'SHOULD-NOT-SURVIVE', 'the fixture failed to carry a tag at all')

  const out = await normalizer.normalize(tagged, { ext: 'mp3' })
  const after = await parseFile(out.path)
  assert.equal(after.common.title, undefined, 'the title tag survived the re-encode')
  assert.equal(after.common.artist, undefined, 'the artist tag survived the re-encode')
})

test('a peaky-but-quiet clip is boosted only to the clipping ceiling, not to target', async () => {
  // Single-sample spikes at 0.95, one per 50 ms window, silence between.
  // ReplayGain's 95th-percentile-of-50ms-RMS reads this as very quiet (each
  // window's RMS is 0.95/√2205 ≈ −34 dBFS) and asks for a huge boost — but the
  // PEAK is already 0.95, so headroom is ≈ 0.25 dB and decideGain must stop
  // there. The first draft used 1 ms pulses and learned that ReplayGain rates
  // a 1 ms-per-window pulse train as LOUD (84.7 dB): the 95th percentile is
  // built to track the loudest windows, and every window held a pulse.
  const input = await tone('spikes.wav', {
    source: 'aevalsrc=0.95*eq(mod(n\\,2205)\\,0):s=44100:d=1',
    gainDb: 0,
    codec: ['-c:a', 'pcm_s16le'],
    muxer: 'wav',
  })
  const { trackGainDb, trackPeak } = await normalizer.measure(input)
  const decided = decideGain(trackGainDb, trackPeak)
  const unclamped = trackGainDb - (REPLAYGAIN_REFERENCE_DB - AUDIO_TARGET_DB)
  assert.ok(decided < unclamped, `nothing was clamped (decided ${decided}, unclamped ${unclamped})`)

  const out = await normalizer.normalize(input, { ext: 'wav' })
  const { trackPeak: peakAfter } = await normalizer.measure(out.path)
  assert.ok(peakAfter <= 1.0, `output peak ${peakAfter} — the ceiling did not hold`)
})

for (const [name, ext, codec, muxer, encoder] of [
  ['a.mp3', 'mp3', ['-c:a', 'libmp3lame', '-b:a', '128k'], 'mp3', 'libmp3lame'],
  ['a.wav', 'wav', ['-c:a', 'pcm_s16le'], 'wav', 'pcm_s16le'],
  ['a.ogg', 'ogg', ['-c:a', 'libvorbis', '-q:a', '4'], 'ogg', 'libvorbis'],
  ['a.m4a', 'm4a', ['-c:a', 'aac', '-b:a', '128k'], 'mp4', 'aac'],
]) {
  test(`container ${ext} round-trips in kind and lands on the wall`, { skip: hostHas(encoder) ? false : `host ffmpeg has no ${encoder} encoder — covered by deploy/smoke-image.sh in the Alpine image` }, async () => {
    const input = await tone(name, { codec, muxer })
    const out = await normalizer.normalize(input, { ext })
    assert.ok(statSync(out.path).size > 0, `${ext}: empty output`)
    const landed = await levelOf(out.path)
    assert.ok(Math.abs(landed - AUDIO_TARGET_DB) <= 0.8, `${ext}: landed at ${landed.toFixed(2)} dB`)
  })
}

// A stand-in ffmpeg that answers the three call shapes normalize()/probe() make,
// so the failure paths — which a real ffmpeg does not take on a valid input —
// can be exercised deterministically on any host. Written to the temp dir (no
// package.json above it, so the shebang runs it as CJS) and made executable.
function writeFakeFfmpeg(name, { encoders = ['aac', 'libmp3lame', 'pcm_s16le', 'libvorbis'], encodeExit = 1 } = {}) {
  const path = join(dir, name)
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
if (args.includes('-filters')) { process.stdout.write(' T.. replaygain        A->A  ReplayGain scanner.\\n'); process.exit(0) }
if (args.includes('-encoders')) { process.stdout.write(${JSON.stringify(encoders.map((e) => ` A....D ${e}  x`).join('\n') + '\n')}); process.exit(0) }
if (args.includes('replaygain') && args.includes('null')) { process.stderr.write('track_gain = -5.00 dB\\ntrack_peak = 0.500000\\n'); process.exit(0) }
// encode: last arg is the .norm output. Write a PARTIAL file, then fail, exactly
// as a killed/erroring real ffmpeg would leave one behind.
fs.writeFileSync(args[args.length - 1], Buffer.alloc(4096, 7))
process.exit(${encodeExit})
`,
  )
  chmodSync(path, 0o755)
  return path
}

test('a re-encode failure removes its own partial .norm — no orphan on the volume', async () => {
  // The MEDIUM finding from the loudness review: normalize() throwing after
  // ffmpeg opened its output stranded a partial .norm forever, because the
  // caller has no handle to it. This fake writes the partial and exits non-zero,
  // the shape a timeout (SIGTERM) or encoder error produces.
  const fake = writeFakeFfmpeg('ff-encode-fail', { encodeExit: 1 })
  const n = createLoudnessNormalizer({ ffmpegPath: fake })
  const input = join(dir, 'leak-input')
  writeFileSync(input, Buffer.alloc(1024, 3))
  await assert.rejects(() => n.normalize(input, { ext: 'mp3' }), /could not re-encode/)
  assert.equal(existsSync(`${input}.norm`), false, 'a partial .norm was left behind after a failed re-encode')
})

test('probe refuses a build that has the filter but is missing an encoder it will spawn', async () => {
  // The LOW finding: probe() checked only the replaygain filter, so an ffmpeg
  // without (say) libvorbis booted "healthy" and failed the first ogg upload.
  const fake = writeFakeFfmpeg('ff-no-vorbis', { encoders: ['aac', 'libmp3lame', 'pcm_s16le'] })
  const n = createLoudnessNormalizer({ ffmpegPath: fake })
  await assert.rejects(() => n.probe(), /missing encoder.*libvorbis/)
})

test('probe accepts the fake when all four encoders are present', async () => {
  const fake = writeFakeFfmpeg('ff-complete')
  await createLoudnessNormalizer({ ffmpegPath: fake }).probe()
})

test('decideGain arithmetic, at the edges the process tests cannot reach', () => {
  // Plain target math: a clip at 89 (gain 0 to reference) is 9 above an 80 target.
  assert.equal(decideGain(0, 0.1), -9)
  // Digital silence: replaygain answers a huge boost and peak 0; the sanity
  // ceiling holds and the log10(0) branch is never taken.
  assert.equal(decideGain(51, 0), 40)
  assert.equal(decideGain(-51, 0.5), -40)
  // The clamp direction: turning DOWN is never limited by peak.
  assert.equal(decideGain(-10, 1.0), -19)
})
