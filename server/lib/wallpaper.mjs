// SPDX-License-Identifier: MIT
//
// The wallpaper upload pipeline: bytes an owner handed us, bytes we produced.
//
// ===========================================================================
// WHAT STORY-035 RULED, AND WHY EACH HALF OF IT IS HERE
// ===========================================================================
// "Reject image/svg+xml, strip EXIF, re-encode server-side, cap the dimensions."
// Four rules that are really one rule seen from four sides: NOTHING the uploader
// supplied is ever served back. What lands on the volume is a file this process
// encoded, from pixels it decoded, at a name it computed.
//
//   * SVG IS REFUSED BY NAME. It is a script container, not an image: an
//     `<svg><script>alert(document.cookie)</script></svg>` served from
//     /wallpaper/ is same-origin JavaScript, and the site's own CSP would be
//     letting it run because the file came from the site's own volume. There is
//     no sanitiser here that would make it safe — the answer is that it is not an
//     image format we accept, said in those words so the owner does not spend an
//     afternoon wondering why their logo will not upload.
//
//   * RE-ENCODED, NOT PASSED THROUGH. This is what actually removes EXIF, ICC,
//     XMP and any trailing polyglot payload — not a metadata-stripping pass over
//     the uploader's bytes, but the fact that the OUTPUT BYTES ARE OURS. A JPEG
//     with a ZIP appended to it, a PNG with a comment chunk full of PHP, an image
//     whose EXIF carries the photographer's GPS coordinates: none of them survive
//     a decode-to-pixels-and-re-encode, because none of them are pixels.
//     sharp strips metadata by default, so `.withMetadata()` / `.keepExif()` must
//     never appear in this file. There is a test that proves the stored file has
//     no EXIF, rather than a test that asserts this comment exists.
//
//   * .rotate() WITH NO ARGUMENT, AND IT IS NOT DECORATION. It applies the EXIF
//     orientation tag and then the tag is dropped with the rest of the metadata.
//     Without it, a photo taken sideways on a phone — where the sensor data is
//     rotated and the tag says "turn me" — would be stored rotated, because we
//     kept the pixels and threw away the instruction that made sense of them.
//
//   * CAPPED IN BOTH DIRECTIONS, AND THEY ARE DIFFERENT LIMITS. Input bytes stop
//     someone from posting a 400 MiB file at all. Dimensions stop a legitimately
//     encoded 24-megapixel camera original from becoming a 96 MB decode and then
//     a wallpaper nobody's phone can download. limitInputPixels stops the third
//     thing, which the other two cannot see: a decode BOMB, a few hundred bytes
//     whose header claims 100000x100000 — small enough to pass the byte cap, and
//     fatal the moment anything allocates for it. See LIMIT_INPUT_PIXELS.
//
// ===========================================================================
// WHY THE NAME IS THE HASH OF THE OUTPUT
// ===========================================================================
// The file is served `immutable` under /wallpaper/<name>, so the name has to
// identify the bytes at that URL for as long as any cache holds them. The hash of
// the INPUT names something this site never serves — a browser fetching it would
// get bytes whose digest is not its filename, which quietly makes the one
// property content-addressing exists for false. Two uploads of the same picture
// therefore also converge on one file, which is a consequence rather than a goal.
//
// ===========================================================================
// WHAT MAKES THIS GO RED
// ===========================================================================
//   * Delete BOTH SVG branches — "an SVG is refused by name" goes red, because
//     that case asserts the CODE and not merely that something threw.
//     WHAT IT DOES NOT DO IS LET THE PAYLOAD THROUGH, and the previous version of
//     this bullet said it did. There is a third layer neither branch is: the
//     ACCEPTED_FORMATS allow-list. sharp reports `format: 'svg'`, the lookup
//     misses, and the refusal becomes `unsupported_format` — MEASURED with both
//     branches deleted on darwin/arm64 AND in-container on linux/musl/x64, the
//     platform this ships to; libvips 8.18.3 carries librsvg on both, so both
//     answer identically. The branches earn their place on the SENTENCE, not on
//     the outcome: "SVG can carry script" sends the owner to convert their file,
//     "that is a svg file, upload a PNG" sends them to file a bug. Overstating
//     the failure mode is how a defence gets deleted as paranoia by the next
//     reader, so the claim here is the measured one.
//   * Add .withMetadata() / .keepExif() — "a JPEG carrying EXIF loses it" goes
//     red, and it reads the stored file back through sharp rather than trusting
//     that this file called the right method.
//   * Name the output by createHash(buffer) instead of by the re-encoded bytes —
//     the EXIF case goes red on its second assertion, which is exactly the case
//     where the two hashes are guaranteed to differ.
//   * Raise limitInputPixels to sharp's default, or drop the dimension check —
//     the decode-bomb case goes red (its header claims 10 gigapixels in 69 bytes).
//   * writeFileSync instead of the temp+rename below, or a temp file in
//     os.tmpdir() — same two failures lib/catalog.mjs names: a reader sees a
//     prefix, or rename() throws EXDEV across filesystems.
//   * Write anything before the last refusal — "nothing is left in the directory
//     after any refusal" goes red; it pre-creates the directory so the assertion
//     is about EMPTINESS and not about absence.

// ===========================================================================
// WHAT NOTHING HERE DOES: RECLAIM AN ORPHAN
// ===========================================================================
// Every accepted upload stays on the volume forever. There is no delete route,
// no sweep, and no reference count — an owner who uploads six wallpapers while
// choosing one leaves six files, and the five nobody references are
// indistinguishable from the one that is live except by reading `themes`.
//
// Measured, not suspected: five storeWallpaper() calls with no save at all leave
// five files, and `grep -rn 'unlink|rmSync'` across this module,
// lib/theme-store.mjs and routes/admin.mjs finds only the temp-file cleanup on
// the write path.
//
// It is stated here rather than fixed here because a reclaim is not a one-liner
// and the wrong one loses data. The awkward part is not finding the orphans —
// `SELECT wallpaper_path FROM themes` is the whole reference set, and themes
// keeps its history deliberately, so a "retired" theme's wallpaper is still
// referenced and must NOT be collected. The awkward part is that the backup pool
// is a SEPARATE tree with its own GC (server/scripts/backup.mjs collects
// unreferenced blobs there), so a sweep here and a prune there can disagree
// about what is still recoverable.
//
// The bound in the meantime: each file is capped at MAX_OUTPUT_BYTES and there
// is exactly one uploader — the owner, behind the admin gate. This grows at the
// rate one person clicks Upload, not at the rate the internet does.
// JOI-BUTTON-STORY-051 carries the sweep.

import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

import sharp from 'sharp'

const MiB = 1024 * 1024

/** Reason codes, so the admin form can render a sentence per refusal. */
export const WALLPAPER_REJECTIONS = Object.freeze({
  empty: 'empty',
  too_large: 'too_large',
  svg_refused: 'svg_refused',
  unsupported_format: 'unsupported_format',
  not_an_image: 'not_an_image',
  dimensions_too_large: 'dimensions_too_large',
  reencoded_too_large: 'reencoded_too_large',
})

/**
 * The upload ceiling, in bytes.
 *
 * 5 MiB, which is also config.limits.maxFileBytes' default and the fileSize limit
 * app.mjs gives @fastify/multipart — so in the running server the framework
 * refuses an over-size body before a byte of it reaches this module. The check
 * here is not redundant with that one: this function is also called directly, and
 * a limit enforced only by the transport is a limit that disappears the day
 * somebody calls the library.
 */
export const MAX_INPUT_BYTES = 5 * MiB

/**
 * The ceiling on what we produce.
 *
 * Re-encoding usually shrinks a file and is not guaranteed to: a PNG saved by a
 * tool with a better compressor than ours comes back larger. A wallpaper is
 * fetched by every visitor on first paint, so a 12 MB one is a refusal and not a
 * shrug — and it is refused rather than silently re-compressed harder, because
 * "we quietly degraded your picture" is a worse surprise than "that is too big".
 */
export const MAX_OUTPUT_BYTES = 5 * MiB

/** The largest picture that may be stored. 4K, and the page scales it with `cover`. */
export const MAX_WIDTH = 3840
export const MAX_HEIGHT = 2160

/**
 * The pixel count libvips will parse a header for at all.
 *
 * DELIBERATELY ABOVE the accepted cap (3840x2160 = 8.3 MP) and far below sharp's
 * own default (0x3FFF squared, ~268 MP), and both halves of that are the point.
 *
 * Above the cap, because sharp raises "Input image exceeds pixel limit" from
 * metadata() itself — measured, not assumed — so a limit set AT the cap would
 * mean an ordinary 24 MP camera original could never be reported back to the
 * owner with its own dimensions in the message. It would be a libvips error
 * string instead of "5000x3000 is larger than 3840x2160".
 *
 * Far below the default, because that is the decode bomb: a 69-byte PNG header
 * declaring 100000x100000 passes every byte-count check ever written, and the
 * first thing to allocate for it dies. Nothing decodes above the cap in this
 * module — the dimension check below runs on the HEADER and refuses before
 * toBuffer() is reached — so this number governs only what we are willing to
 * look at, and 40 MP is generous for that.
 */
export const LIMIT_INPUT_PIXELS = 40_000_000

/**
 * The formats we accept, mapped to the extension the file is stored under.
 *
 * The keys are sharp's own format names ('jpeg', not 'jpg'); the values are what
 * themes.wallpaper_path's CHECK allows and what deploy/nginx.conf serves.
 */
export const ACCEPTED_FORMATS = Object.freeze({ png: 'png', jpeg: 'jpg', webp: 'webp' })

/**
 * The prefix of the temp file the atomic write below uses.
 *
 * A CONSTANT RATHER THAN A LITERAL because two things outside this module key on
 * its leading dot: deploy/nginx.conf's nested `location ~ /\.` inside the
 * `^~ /wallpaper/` block, and the fixture deploy/smoke-image.sh seeds to prove
 * that rule. Neither of them can import this — nginx does not read JavaScript,
 * and the smoke script would have to load sharp to get here — so the coupling
 * cannot be made mechanical. It can at least be made VISIBLE: this is the one
 * place the name is chosen, and the test below asserts the property those two
 * consumers depend on rather than the spelling they do not.
 */
export const TEMP_NAME_PREFIX = '.wallpaper-tmp-'

export class WallpaperError extends Error {
  constructor(message, code, details = null) {
    super(message)
    this.name = 'WallpaperError'
    this.code = code
    this.details = details
  }
}

/**
 * Is this a markup document that declares an <svg> root?
 *
 * Exported because it is a rule rather than a detail, and because a test that can
 * only reach it through storeWallpaper cannot show it seeing past an XML
 * declaration and a DOCTYPE.
 *
 * WHY WE SNIFF FOR SVG OURSELVES when sharp identifies it perfectly well
 * (metadata().format is 'svg', measured on darwin/arm64 AND on linux/musl/x64 —
 * the linuxmusl-x64 binaries this project ships to the cluster DO carry
 * librsvg): sharp reads SVG only when the libvips it was built against carries
 * librsvg, and whether a given build has it is not a fact this file should
 * depend on. Where it is absent, metadata() throws and the answer becomes
 * "refused as an unreadable file" — true, unactionable, and not what STORY-035
 * asked for. Sniffing here makes the answer identical on every platform, which
 * is a claim about the MESSAGE; the allow-list below refuses 'svg' on every
 * platform regardless (see WHAT MAKES THIS GO RED at the top). The `svg` branch
 * in storeWallpaper stays anyway, and it is not dead code: a gzipped .svgz
 * starts with 0x1f8b and this function cannot see into it, while a libvips with
 * librsvg will happily decompress and report it.
 *
 * The first non-space byte must be '<'. Requiring that rather than scanning for
 * '<svg' anywhere is what keeps a PNG whose compressed data happens to contain
 * those four bytes from being refused as a script container.
 */
export function looksLikeSvg(buffer) {
  // The BOM is written as an escape and never as a literal, for the reason
  // lib/text-safety.mjs and routes/admin.mjs both give about control characters:
  // a zero-width character typed into source is invisible to the next reader and
  // one editor pass deletes it without a trace.
  const head = buffer.subarray(0, 4096).toString('utf8').replace(new RegExp('^\\uFEFF'), '')
  if (!/^\s*</.test(head)) return false
  return /<svg[\s/>]/i.test(head)
}

/**
 * Store an uploaded wallpaper.
 *
 * @param {Buffer} buffer  the uploaded bytes, as they arrived
 * @param {{wallpaperDir: string}} options
 * @returns {Promise<{path: string, bytes: number, width: number, height: number, format: string}>}
 *          `path` is the BARE filename `<sha256>.<ext>` themes.wallpaper_path
 *          holds — never a path with a separator in it, so a traversal has no
 *          legal spelling (schema.sql CHECKs the same shape). The serving prefix
 *          belongs to nginx; see theme.mjs's wallpaperUrl().
 *
 * Every refusal is a WallpaperError carrying a code from WALLPAPER_REJECTIONS,
 * and every one of them happens BEFORE anything is written.
 */
export async function storeWallpaper(buffer, { wallpaperDir } = {}) {
  if (typeof wallpaperDir !== 'string' || wallpaperDir.trim() === '') {
    throw new WallpaperError('wallpaper: options.wallpaperDir must be a non-empty path', 'bad_argument')
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new WallpaperError('The upload was empty.', WALLPAPER_REJECTIONS.empty)
  }

  // FIRST, and before anything parses a header: this is the one check that costs
  // nothing on a hostile input.
  if (buffer.length > MAX_INPUT_BYTES) {
    throw new WallpaperError(
      `That image is ${buffer.length} bytes; the limit is ${MAX_INPUT_BYTES} (${MAX_INPUT_BYTES / MiB} MiB).`,
      WALLPAPER_REJECTIONS.too_large,
      { bytes: buffer.length, limit: MAX_INPUT_BYTES },
    )
  }

  if (looksLikeSvg(buffer)) throw svgRefusal()

  // The FORMAT COMES FROM THE BYTES. Not from the filename — which is why this
  // function is never told one — and not from the declared Content-Type, which is
  // a string the uploader typed.
  let metadata
  try {
    metadata = await sharp(buffer, { limitInputPixels: LIMIT_INPUT_PIXELS, animated: false }).metadata()
  } catch (error) {
    // Measured: this is where the pixel limit is raised, not at toBuffer(). A
    // bomb therefore never reaches the dimension check below, so its refusal has
    // to be spelled out here or it would surface as "unsupported image format",
    // which is both wrong and unactionable.
    if (/exceeds pixel limit/i.test(error?.message ?? '')) {
      throw new WallpaperError(
        `That file's header declares more than ${LIMIT_INPUT_PIXELS} pixels, which is refused before it is decoded. ` +
          `A wallpaper may be at most ${MAX_WIDTH}x${MAX_HEIGHT}.`,
        WALLPAPER_REJECTIONS.dimensions_too_large,
        { limitInputPixels: LIMIT_INPUT_PIXELS },
      )
    }
    throw new WallpaperError(
      'That file is not an image this server can read. Upload a PNG, JPEG or WebP.',
      WALLPAPER_REJECTIONS.not_an_image,
      { detail: error?.message ?? null },
    )
  }

  if (metadata.format === 'svg') throw svgRefusal()
  const ext = ACCEPTED_FORMATS[metadata.format]
  if (ext === undefined) {
    throw new WallpaperError(
      `That image is a ${metadata.format ?? 'unrecognised'} file. A wallpaper must be a PNG, a JPEG or a WebP.`,
      WALLPAPER_REJECTIONS.unsupported_format,
      { format: metadata.format ?? null },
    )
  }

  requireWithinBounds(metadata.width, metadata.height)

  // No resize. An image that is too big is REFUSED rather than scaled down,
  // because the owner picked this picture and a server that silently returns a
  // different one is a server they cannot reason about. The refusal names both
  // their size and the cap.
  const encoder = sharp(buffer, { limitInputPixels: LIMIT_INPUT_PIXELS, animated: false })
    // See the header: applies the EXIF orientation while we still have it.
    .rotate()

  const encoded =
    metadata.format === 'png'
      ? encoder.png({ compressionLevel: 9 })
      : metadata.format === 'jpeg'
        ? encoder.jpeg({ quality: 82 })
        : encoder.webp({ quality: 82 })

  // NO .withMetadata() / .keepExif() / .keepIccProfile(). sharp strips by
  // default, and that default is the whole EXIF half of STORY-035.
  const { data, info } = await encoded.toBuffer({ resolveWithObject: true })

  // Again, on the OUTPUT: .rotate() swaps width and height for a sideways photo,
  // so the header's numbers were the pre-rotation ones. This is the pair that
  // ends up on screen.
  requireWithinBounds(info.width, info.height)

  if (data.length > MAX_OUTPUT_BYTES) {
    throw new WallpaperError(
      `Re-encoded, that image is still ${data.length} bytes; the limit is ${MAX_OUTPUT_BYTES} ` +
        `(${MAX_OUTPUT_BYTES / MiB} MiB). Try a smaller picture, or a JPEG rather than a PNG.`,
      WALLPAPER_REJECTIONS.reencoded_too_large,
      { bytes: data.length, limit: MAX_OUTPUT_BYTES },
    )
  }

  // The hash of what we are about to write, never of what we were handed.
  const path = `${createHash('sha256').update(data).digest('hex')}.${ext}`
  writeFileAtomic(join(wallpaperDir, path), data)

  return { path, bytes: data.length, width: info.width, height: info.height, format: info.format }
}

// ---------------------------------------------------------------------------

/**
 * One refusal, raised from two places.
 *
 * The message names SVG and says why, because "unsupported format" would send
 * the owner off to convert their file and try again — and the answer is not
 * "convert it", it is "this format can execute".
 */
function svgRefusal() {
  return new WallpaperError(
    'SVG is refused: it is a document format that can carry script, not a picture format. ' +
      'Served from this site it would run as this site. Upload a PNG, JPEG or WebP.',
    WALLPAPER_REJECTIONS.svg_refused,
  )
}

function requireWithinBounds(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new WallpaperError(
      'That image reports no usable dimensions.',
      WALLPAPER_REJECTIONS.not_an_image,
      { width: width ?? null, height: height ?? null },
    )
  }
  if (width > MAX_WIDTH || height > MAX_HEIGHT) {
    throw new WallpaperError(
      `That image is ${width}x${height}; a wallpaper may be at most ${MAX_WIDTH}x${MAX_HEIGHT}.`,
      WALLPAPER_REJECTIONS.dimensions_too_large,
      { width, height, maxWidth: MAX_WIDTH, maxHeight: MAX_HEIGHT },
    )
  }
}

/**
 * The atomic write, and it is the pattern lib/catalog.mjs states at length rather
 * than a second invention: temp file in the TARGET'S OWN DIRECTORY (rename is
 * atomic only within one filesystem, so os.tmpdir() would throw EXDEV), fsync the
 * bytes (a durable rename over undurable content leaves the new name pointing at
 * zeroes), rename, fsync the directory.
 *
 * WHAT KEEPS A LEFTOVER FROM BEING SERVED, stated carefully because the version
 * of this paragraph that stood here was WRONG and the error was invisible:
 *
 *   1. Nothing is written until every refusal has passed, and the catch blocks
 *      below unlink the temp file on any failure. This is the only half that
 *      belongs to this module, and it covers every case except a hard crash —
 *      SIGKILL, OOM, the node dying — between openSync and renameSync.
 *   2. For that remaining case the name starts with a dot, and deploy/nginx.conf
 *      answers 404 for a path segment beginning with '.'. THAT RULE IS A REGEX
 *      LOCATION AND `^~ /wallpaper/` IS A PREFIX ONE, so for a long time it was
 *      never evaluated for this directory at all: a leftover was served 200,
 *      with a partial image as its body and `public, immutable` for a year.
 *      nginx.conf now repeats the rule INSIDE the /wallpaper/ block, where it is
 *      reached, and deploy/smoke-image.sh seeds a `.wallpaper-tmp-` file and
 *      asserts the 404 — so this sentence is now checked by something other than
 *      whoever last read it.
 *   3. The uuid in the name is not decoration either: it is what makes a
 *      leftover unguessable to anyone who did not watch the upload happen.
 *
 * Point 2 is a promise made by a file in another repository directory. If this
 * module is ever served by something that is not deploy/nginx.conf, the dot
 * means nothing again and points 1 and 3 are all there is.
 *
 * It is copied rather than imported because catalog.mjs does not export it, and
 * that file belongs to the catalogue. Both copies are covered by tests that fail
 * if the temp file moves out of the target directory.
 */
function writeFileAtomic(target, data) {
  const dir = dirname(target)
  mkdirSync(dir, { recursive: true })
  const temp = join(dir, `${TEMP_NAME_PREFIX}${randomUUID()}`)

  // 'wx' — refuse to open an existing file. The name carries a uuid, so a
  // collision means something else is writing here.
  const fd = openSync(temp, 'wx', 0o644)
  try {
    // LOOPED, where lib/catalog.mjs's copy of this pattern calls writeSync once.
    // write(2) is allowed to write fewer bytes than it was given, and the odds of
    // that are a function of size: catalog.json is tens of kilobytes and a
    // wallpaper is up to five megabytes. A short write here would produce a file
    // whose sha256 is not the name it is filed under, served `immutable`.
    let written = 0
    while (written < data.length) written += writeSync(fd, data, written, data.length - written)
    fsyncSync(fd)
  } catch (error) {
    closeSync(fd)
    unlinkSync(temp)
    throw error
  }
  closeSync(fd)

  try {
    renameSync(temp, target)
  } catch (error) {
    unlinkSync(temp)
    throw error
  }

  fsyncDirectory(dir)
}

// Best-effort, and stated as such, for the reason lib/catalog.mjs gives: the
// bytes and the rename have both landed by the time this runs, so a platform
// that will not let us open a directory loses crash-durability of the last
// upload, not the upload.
function fsyncDirectory(dir) {
  let fd
  try {
    fd = openSync(dir, 'r')
  } catch {
    return
  }
  try {
    fsyncSync(fd)
  } catch {
    // see above
  } finally {
    closeSync(fd)
  }
}
