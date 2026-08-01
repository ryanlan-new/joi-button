// SPDX-License-Identifier: MIT
//
// The admin surface: the review queue, the review desk, publishing, and the log.
//
// REGISTER THIS WITHOUT A PREFIX:
//
//     fastify.register(adminRoutes, { db, adminOpenIds, paths })
//
// The routes below carry their full paths ('/api/admin/queue'), so what the
// source says is what the URL is. Registering it under a `prefix` would produce
// '/api/admin/api/admin/queue' and every route would 404 — silently, because a
// 404 is also what this plugin answers a stranger with. So a prefix is refused
// at registration rather than discovered in production.
//
// ===========================================================================
// THE GATE
// ===========================================================================
// Admin is an allow-list of open_id values and the check is server-side on every
// route (ruling). It is one `onRequest` hook in this plugin's encapsulation
// context rather than a per-route preHandler, because a per-route check is a
// check somebody can forget to add to route number seven — this one covers every
// route in this file, including ones added after it.
//
// A non-admin gets the same answer whether or not the route exists, and it is
// produced by `reply.callNotFound()` rather than by a hand-rolled 404: fastify's
// own not-found handler is what a genuinely missing path gets, so invoking it is
// identical BY CONSTRUCTION instead of identical until somebody edits one of the
// two bodies.
//
// Stated rather than implied — what this does NOT hide: an unmatched path never
// reaches this hook (fastify answers it from the root context), so it costs no
// database lookup, while a real admin path costs one. A stranger with a stopwatch
// can therefore learn that SOME route exists at a path. What they cannot learn is
// anything about the queue, an item, the catalogue or the log, which is what the
// allow-list is for. Closing the timing gap would mean doing a fake session
// lookup on every 404 in the whole application, which is a cost paid by every
// visitor forever to hide a fact that deploy/runtime.env.example already
// publishes.
//
// The identity itself comes from the session cookie: sessions.token_sha256 is
// the sha256 of the cookie VALUE (the value is never stored, so a leaked backup
// does not hand over live sessions), and the submitter behind it carries the
// open_id. The default resolver does NOT verify a cookie signature — if the app
// signs its session cookies, it must pass its own `resolveIdentity`, and the
// contract is that whatever string it hashes is the string sessions.token_sha256
// holds.
//
// A `blocked` submitter is not locked out of the admin surface: `blocked` is an
// abuse flag on the SUBMISSION path, and the allow-list is the ruling on who is
// an admin. Two authorities over one question is how an owner locks themselves
// out of the tool they need to unblock themselves with.
//
// ===========================================================================
// AUDIT
// ===========================================================================
// Every mutation writes an entry through lib/audit.mjs, inside the same
// transaction as the change it records, so an entry can never claim an approval
// that rolled back. Refusals an admin caused (a caption that fails the gate, an
// item already decided) are recorded too, with succeeded: false — those are
// outside the transaction, because there is no transaction left to be in.
//
// Refusals by the GATE are deliberately NOT recorded. The caller is an
// unauthenticated stranger at that point, and an append-only table that anybody
// on the internet can add a row to is a disk-fill primitive, not a log.
//
// ===========================================================================
// WHAT MAKES THIS GO RED
// ===========================================================================
//   * Move the gate from a hook onto individual routes, or drop it from one
//     route — the "every registered route is behind the allow-list" case goes
//     red; it enumerates what the plugin registered and asserts the hook, so it
//     covers routes that do not exist yet.
//   * Answer the gate refusal with a hand-written 404 body — the "a non-admin
//     gets the answer a missing route gets" case goes red (it asserts
//     callNotFound was invoked, not that a status code was 404).
//   * Let an empty allow-list register — the boot-refusal case goes red. An
//     empty list is safe (nobody is an admin) and useless (nobody can review),
//     and it is what an unset ADMIN_OPEN_IDS produces.
//   * Store a caption without escapeForI18n, or accept one validateCaption
//     refuses — the linked-message case goes red.
//   * Rank the queue by anything but arrival — the FIFO case goes red.
//   * Let a reject through without a reason — the refusal case goes red, and the
//     database would refuse it anyway (batch_items CHECK), which is the point:
//     the route says why in words a submitter can read.
//   * Give the promotion's audit entry a catalogue consequence — the "two events,
//     two entries" case goes red: that entry would be claiming a file that had
//     not been written yet, which is the whole reason the write comes second.
//   * Make the dry run write — its case goes red.
//   * Change the audit cursor encoding — the interop case goes red, because a
//     cursor from lib/audit.mjs's own pager is fed to this one and back.
//   * Let a decision through on an item whose batch was never submitted, or into
//     a retired group, or over a blob that is not on the volume, or over a
//     missing translation — each has its own case, and each was verified by
//     making the change and watching that case fail.

import { createHash, randomUUID } from 'node:crypto'

import { toCanonicalTimestamp } from '../db/migrate.mjs'
import {
  AUDIT_ACTOR_KINDS,
  AUDIT_DEFAULT_PAGE_SIZE,
  AUDIT_MAX_PAGE_SIZE,
  getEntry,
  record,
} from '../lib/audit.mjs'
import { CatalogError, MEDIA_BASE_URL, checkMedia, writeCatalog } from '../lib/catalog.mjs'
import { CAPTION_MAX_LENGTH, escapeForI18n, validateCaption } from '../lib/text-safety.mjs'
// The parser belongs to the module that WRITES batch_items.submitter_note. One
// definition of what those bytes mean, owned by the writer.
import { readSubmitterNote } from './public.mjs'

/** Matches groups.id / clips.id in schema.sql, which are the vue-i18n keys. */
const ID_PATTERN = /^[a-z0-9_-]{1,64}$/

/** clips.label and groups.display_name both CHECK length <= 120. */
const LABEL_MAX_LENGTH = 120

/** batch_items.reviewer_note has no column limit; this one is a product limit. */
const NOTE_MAX_LENGTH = 500

const QUEUE_DEFAULT_LIMIT = 100
const QUEUE_MAX_LIMIT = 500

const DEFAULT_COOKIE_NAME = 'joi_session'

export class AdminError extends Error {
  constructor(message, { code, status = 400, details = null } = {}) {
    super(message)
    this.name = 'AdminError'
    this.code = code ?? 'invalid_request'
    this.status = status
    this.details = details
  }
}

// ---------------------------------------------------------------------------
// the plugin

/**
 * @param {import('fastify').FastifyInstance} fastify
 * @param {{
 *   db: import('better-sqlite3').Database,
 *   adminOpenIds: string[],
 *   paths: { catalogFile: string, mediaDir: string, sourceDir?: string },
 *   cookieName?: string,
 *   mediaBaseUrl?: string,
 *   resolveIdentity?: (request: object) => Promise<object|null>|object|null,
 *   now?: () => Date
 * }} options
 */
export default async function adminRoutes(fastify, options = {}) {
  if (options.prefix !== undefined && options.prefix !== '' && options.prefix !== '/') {
    throw new Error(
      `admin routes: register this plugin WITHOUT a prefix (got ${JSON.stringify(options.prefix)}). ` +
        'Its routes carry their full paths, so a prefix would move every one of them and each would ' +
        'answer 404 — which is also what this plugin answers a non-admin with, so the mistake would ' +
        'look exactly like a working access check.',
    )
  }

  const db = requirePresent(options.db, 'options.db')
  const paths = requirePresent(options.paths, 'options.paths')
  const now = options.now ?? (() => new Date())
  const mediaBaseUrl = options.mediaBaseUrl ?? MEDIA_BASE_URL
  const gate = createAdminGate({
    db,
    adminOpenIds: options.adminOpenIds,
    cookieName: options.cookieName ?? DEFAULT_COOKIE_NAME,
    resolveIdentity: options.resolveIdentity,
    now,
  })

  // Said on every boot, not once at install: an empty list is correct on a first
  // deploy and a mistake on any later one, and this plugin cannot tell which it
  // is looking at. What it can do is make sure the state is never silent.
  if (Array.isArray(options.adminOpenIds) &&
      options.adminOpenIds.filter((value) => String(value).trim() !== '').length === 0) {
    fastify.log.warn(
      'admin routes: ADMIN_OPEN_IDS is empty, so every admin route answers 404 to everyone including you. ' +
        'This is expected on a FIRST deploy: sign in through the danmaku flow, read your open_id from ' +
        'GET /api/me, put it in ADMIN_OPEN_IDS and redeploy. On any later deploy it means the value was lost.',
    )
  }

  fastify.addHook('onRequest', async (request, reply) => {
    const identity = await gate(request)
    if (identity === null) {
      // fastify's own not-found handler: identical to a missing route because it
      // IS the missing-route path, not a copy of it.
      reply.callNotFound()
      return reply
    }
    request.adminIdentity = identity
  })

  // No fastify JSON schemas on these routes, deliberately. Every field is
  // validated below against the constraint that actually governs it (a column
  // CHECK, validateCaption, the locales table), and a schema would be a second
  // description of the same contract — one that can drift, and one that answers
  // with fastify's wording instead of a reason a reviewer can act on.

  fastify.get('/api/admin/queue', async (request, reply) =>
    answered(reply, () =>
      readQueue(db, {
        limit: intParam(request.query?.limit, 'limit', QUEUE_DEFAULT_LIMIT, 1, QUEUE_MAX_LIMIT),
        mediaBaseUrl,
      }),
    ),
  )

  fastify.get('/api/admin/item/:id', async (request, reply) =>
    answered(reply, () => {
      const desk = readItem(db, request.params.id, { mediaBaseUrl })
      if (desk === null) throw new AdminError(`no item ${request.params.id}`, { code: 'not_found', status: 404 })
      return desk
    }),
  )

  fastify.post('/api/admin/item/:id', async (request, reply) =>
    guarded(reply, request.adminIdentity, db, now, () =>
      reviewItem(db, request.params.id, request.body ?? {}, {
        actor: request.adminIdentity,
        now,
      }),
    ),
  )

  fastify.post('/api/admin/publish', async (request, reply) =>
    guarded(reply, request.adminIdentity, db, now, () =>
      publishCatalogue(db, paths, {
        actor: request.adminIdentity,
        now,
        dryRun: request.body?.dryRun === true,
        promote: request.body?.promote !== false,
        verifyMedia: request.body?.verifyMedia,
      }),
    ),
  )

  fastify.get('/api/admin/audit', async (request, reply) =>
    answered(reply, () => readAuditPage(db, request.query ?? {})),
  )
}

// A read that can refuse — a page size out of range, a malformed cursor, an item
// id that names nothing. Nothing is audited: a read changes nothing, and a log
// entry per GET would bury the entries that record a change.
function answered(reply, run) {
  try {
    return run()
  } catch (error) {
    return replyForError(reply, error)
  }
}

// Runs a mutation and turns its refusal into an answer plus a log entry. The
// audit write is outside whatever transaction the mutation used, because by the
// time we are here that transaction has rolled back.
async function guarded(reply, actor, db, now, run) {
  try {
    return await run()
  } catch (error) {
    if (isReportable(error)) {
      recordRefusal(db, actor, now, error)
    }
    return replyForError(reply, error)
  }
}

function replyForError(reply, error) {
  const status = httpStatusFor(error)
  if (status === null) throw error
  return reply.code(status).send(errorBody(error))
}

/**
 * The status an error answers with, or null when it is not ours to answer — in
 * which case it is rethrown and fastify's error handler turns it into a 500,
 * which is the correct outcome for a defect.
 */
export function httpStatusFor(error) {
  if (error instanceof AdminError) return error.status
  if (error instanceof CatalogError) {
    // media_missing is the operator's problem to fix and is stated as a
    // conflict; the rest are defects in this code or in the database's shape.
    return error.code === 'media_missing' || error.code === 'media_corrupt' ? 409 : 500
  }
  // A refusal by the schema itself. Surfacing it as a conflict beats a 500: the
  // message names the trigger or the CHECK that fired, which is exactly what the
  // person who typed the request needs to read.
  if (typeof error?.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT')) return 409
  return null
}

function errorBody(error) {
  if (error instanceof AdminError) {
    return { error: error.code, message: error.message, details: error.details }
  }
  if (error instanceof CatalogError) {
    return { error: error.code, message: error.message, details: error.details }
  }
  return { error: 'refused', message: error.message, details: null }
}

function isReportable(error) {
  return error instanceof AdminError || error instanceof CatalogError || httpStatusFor(error) === 409
}

function recordRefusal(db, actor, now, error) {
  if (!actor) return
  try {
    record(db, {
      actorKind: 'owner',
      actorOpenId: actor.openId,
      actorDisplayName: actor.displayName,
      verb: 'admin.refused',
      subject: { kind: 'admin-request', id: null },
      before: null,
      after: { code: error.code ?? 'refused', message: error.message },
      consequence: null,
      succeeded: false,
      occurredAt: toCanonicalTimestamp(now()),
    })
  } catch {
    // A log that cannot record a refusal must not turn that refusal into a 500:
    // the caller's answer is the refusal, and losing its log entry is the lesser
    // failure. The entry that matters — the one for a mutation that SUCCEEDED —
    // is inside that mutation's transaction and cannot be lost this way.
  }
}

// ---------------------------------------------------------------------------
// the gate

/**
 * @returns {(request: object) => Promise<{openId: string, submitterId: string, displayName: string}|null>}
 */
export function createAdminGate({ db, adminOpenIds, cookieName = DEFAULT_COOKIE_NAME, resolveIdentity, now = () => new Date() } = {}) {
  if (!Array.isArray(adminOpenIds)) {
    throw new Error('admin routes: options.adminOpenIds must be an array of open_id values (ADMIN_OPEN_IDS)')
  }
  const allow = new Set(adminOpenIds.map((value) => String(value).trim()).filter((value) => value !== ''))

  // AN EMPTY ALLOW-LIST IS ACCEPTED, and this used to throw.
  //
  // The refusal's reasoning was right about the steady state — nobody is an
  // admin, nothing can be reviewed or published, and the surface answers 404 to
  // its own owner — and wrong about the one state every deployment starts in.
  // An open_id is issued by the Open Platform per PROJECT and there is no
  // console that shows it; deploy/runtime.env.example says so outright: "You
  // obtain your own by logging in once through the danmaku flow." So on a first
  // deploy the owner cannot know the value, the list is necessarily empty, and
  // throwing here meant the API would not start — which meant they could not log
  // in, which meant they could never learn the value. The documented procedure
  // could not be walked.
  //
  // It now starts, with every admin route answering 404 to everyone. That is
  // fail-CLOSED, it is exactly what the bootstrap needs, and the owner reads
  // their open_id off /api/me (publicSubmitter returns the session's own), puts
  // it in ADMIN_OPEN_IDS and redeploys.
  //
  // The cost, stated: a deploy that ACCIDENTALLY clears ADMIN_OPEN_IDS now loses
  // the desk quietly instead of failing at boot. That is the better of the two —
  // the old behaviour took the whole API down for the same mistake, which took
  // submissions and login with it, while the desk 404ing is immediately visible
  // to the one person who uses it. adminRoutes logs it at warn on every boot.

  const lookup = resolveIdentity ?? defaultIdentityResolver(db, cookieName, now)

  return async function gate(request) {
    let identity
    try {
      identity = await lookup(request)
    } catch {
      // A session lookup that throws is not an authorisation.
      return null
    }
    if (identity === null || identity === undefined) return null
    const openId = identity.openId
    if (typeof openId !== 'string' || !allow.has(openId)) return null
    return Object.freeze({
      openId,
      submitterId: identity.submitterId ?? null,
      displayName: identity.displayName ?? openId,
    })
  }
}

function defaultIdentityResolver(db, cookieName, now) {
  const select = db.prepare(`
    SELECT s.id AS session_id, sub.id AS submitter_id, sub.open_id, sub.display_name
    FROM sessions s
    JOIN submitters sub ON sub.id = s.submitter_id
    WHERE s.token_sha256 = ? AND s.revoked_at IS NULL AND s.expires_at > ?
  `)

  return (request) => {
    const token = readSessionCookie(request, cookieName)
    if (token === null) return null
    // The cookie value is never stored; its sha256 is the lookup key.
    const hash = createHash('sha256').update(token, 'utf8').digest('hex')
    const row = select.get(hash, toCanonicalTimestamp(now()))
    if (!row) return null
    return { openId: row.open_id, submitterId: row.submitter_id, displayName: row.display_name }
  }
}

function readSessionCookie(request, cookieName) {
  // @fastify/cookie decorates request.cookies when the app registers it; it is
  // not a dependency of this file, so the header is parsed directly otherwise.
  const decorated = request?.cookies?.[cookieName]
  if (typeof decorated === 'string' && decorated !== '') return decorated
  const parsed = parseCookieHeader(request?.headers?.cookie)
  return parsed[cookieName] ?? null
}

/** @returns {Record<string, string>} */
export function parseCookieHeader(header) {
  const out = Object.create(null)
  if (typeof header !== 'string' || header === '') return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 1) continue
    const name = part.slice(0, eq).trim()
    if (name === '') continue
    let value = part.slice(eq + 1).trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1)
    // First occurrence wins: a second cookie of the same name, injected from a
    // sibling path or a wider domain, must not overwrite the one the browser
    // sent for this one.
    if (name in out) continue
    try {
      out[name] = decodeURIComponent(value)
    } catch {
      out[name] = value
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// GET /api/admin/queue

/**
 * Everything waiting for a decision, oldest first.
 *
 * The ORDER BY is arrival order and nothing else. Ranking by the submitter's
 * approved_count, by duration, by file size — by anything that reads as quality
 * — would re-create the gate this desk exists to be: a queue where some
 * submissions are seen sooner because of who sent them. Ties break on batch id
 * and position, which is determinism, not preference.
 */
export function readQueue(db, { limit = QUEUE_DEFAULT_LIMIT, mediaBaseUrl = MEDIA_BASE_URL } = {}) {
  const rows = db
    .prepare(`
      SELECT i.id, i.batch_id, i.position, i.proposed_label, i.proposed_group_id, i.submitter_note,
             i.created_at,
             b.submitted_at, b.turnstile_required, b.turnstile_verdict,
             m.sha256, m.ext, m.content_type, m.bytes, m.duration_seconds, m.storage_path,
             s.id AS submitter_id, s.open_id, s.display_name, s.blocked,
             s.submitted_count, s.approved_count, s.rejected_count,
             e.submitted_count AS expected_submitted, e.approved_count AS expected_approved,
             e.rejected_count AS expected_rejected
      FROM batch_items i
      JOIN batches b ON b.id = i.batch_id
      JOIN media m ON m.sha256 = i.media_sha256
      JOIN submitters s ON s.id = b.submitter_id
      JOIN v_submitter_counts_expected e ON e.submitter_id = s.id
      WHERE i.state = 'pending' AND b.state = 'submitted'
      ORDER BY b.submitted_at, b.id, i.position
      LIMIT ?
    `)
    .all(limit + 1)

  const truncated = rows.length > limit
  const page = truncated ? rows.slice(0, limit) : rows

  const batches = []
  const byId = new Map()
  for (const row of page) {
    if (!byId.has(row.batch_id)) {
      const batch = {
        batchId: row.batch_id,
        submittedAt: row.submitted_at,
        turnstile: {
          required: row.turnstile_required === 1,
          verdict: row.turnstile_verdict,
        },
        submitter: submitterView(row),
        items: [],
      }
      byId.set(row.batch_id, batch)
      batches.push(batch)
    }
    byId.get(row.batch_id).items.push(itemView(row, mediaBaseUrl))
  }

  return {
    batches,
    batchCount: batches.length,
    itemCount: page.length,
    truncated,
    limit,
  }
}

function submitterView(row) {
  const stored = {
    submittedCount: row.submitted_count,
    approvedCount: row.approved_count,
    rejectedCount: row.rejected_count,
  }
  const expected = {
    submittedCount: row.expected_submitted,
    approvedCount: row.expected_approved,
    rejectedCount: row.expected_rejected,
  }
  return {
    submitterId: row.submitter_id,
    openId: row.open_id,
    displayName: row.display_name,
    blocked: row.blocked === 1,
    // The stored counters are what the anti-abuse rules read (lib/turnstile.mjs
    // takes them as numbers), so they are what the desk shows. The view beside
    // them is the truth; schema.sql repairs neither, on the grounds that a
    // silent repair hides the bug that caused the drift — so the drift is
    // reported instead of fixed here.
    counts: stored,
    countsExpected: expected,
    countsDrifted:
      stored.submittedCount !== expected.submittedCount ||
      stored.approvedCount !== expected.approvedCount ||
      stored.rejectedCount !== expected.rejectedCount,
  }
}

function itemView(row, mediaBaseUrl) {
  return {
    itemId: row.id,
    batchId: row.batch_id,
    position: row.position,
    createdAt: row.created_at,
    proposedLabel: row.proposed_label,
    proposedGroupId: row.proposed_group_id,
    // PARSED, not the raw column. batch_items.submitter_note holds a JSON
    // document — the caption the submitter wrote, their free-text note, and the
    // name of a group they are proposing — and shipping the string put the desk
    // in the position of parsing it in a template. It did not: both the queue
    // and the item pane rendered the literal
    // `{"caption":{"locale":"zh-CN","text":"…"},"note":"…","proposedGroup":"…"}`
    // at the reviewer, and the proposed group name never appeared in the column
    // headed "which group they want", which said "not specified" because
    // proposed_group_id is null for a group that does not exist yet.
    //
    // readSubmitterNote is routes/public.mjs's own parser — the module that
    // WRITES the column — so there is one definition of what these bytes mean
    // and it belongs to the writer. It is total: anything it cannot read becomes
    // three nulls rather than an exception, because a note that was written by
    // an older build must not be able to take the review desk down.
    submitterNote: readSubmitterNote(row.submitter_note),
    media: {
      sha256: row.sha256,
      audioUrl: `${mediaBaseUrl}${row.storage_path}`,
      path: row.storage_path,
      contentType: row.content_type,
      ext: row.ext,
      bytes: row.bytes,
      durationSeconds: row.duration_seconds,
      // NOT MEASURED, and null rather than absent so the desk can say so.
      // `media` has columns for bytes and duration and none for amplitude, and
      // adding one is a schema change (a STRICT table, a POST_BASELINE_STEP and
      // a SCHEMA_VERSION bump) which belongs to whoever owns db/. music-metadata
      // reads container metadata, not samples, so it cannot fill this in either:
      // a true peak needs the audio decoded. Reporting a computed-looking number
      // here would be worse than reporting nothing.
      peakDbfs: null,
    },
  }
}

// ---------------------------------------------------------------------------
// GET /api/admin/item/:id

export function readItem(db, itemId, { mediaBaseUrl = MEDIA_BASE_URL } = {}) {
  const row = db
    .prepare(`
      SELECT i.id, i.batch_id, i.position, i.proposed_label, i.proposed_group_id, i.submitter_note,
             i.state, i.created_at, i.resolved_at, i.reviewer_note, i.clip_id,
             b.state AS batch_state, b.submitted_at, b.turnstile_required, b.turnstile_verdict,
             m.sha256, m.ext, m.content_type, m.bytes, m.duration_seconds, m.storage_path,
             s.id AS submitter_id, s.open_id, s.display_name, s.blocked,
             s.submitted_count, s.approved_count, s.rejected_count,
             e.submitted_count AS expected_submitted, e.approved_count AS expected_approved,
             e.rejected_count AS expected_rejected
      FROM batch_items i
      JOIN batches b ON b.id = i.batch_id
      JOIN media m ON m.sha256 = i.media_sha256
      JOIN submitters s ON s.id = b.submitter_id
      JOIN v_submitter_counts_expected e ON e.submitter_id = s.id
      WHERE i.id = ?
    `)
    .get(itemId)
  if (!row) return null

  return {
    item: {
      ...itemView(row, mediaBaseUrl),
      state: row.state,
      resolvedAt: row.resolved_at,
      reviewerNote: row.reviewer_note,
      clipId: row.clip_id,
    },
    batch: {
      batchId: row.batch_id,
      state: row.batch_state,
      submittedAt: row.submitted_at,
      turnstile: { required: row.turnstile_required === 1, verdict: row.turnstile_verdict },
      progress: db
        .prepare('SELECT item_count, pending_count, approved_count, rejected_count, failed_count, is_resolvable FROM v_batch_progress WHERE batch_id = ?')
        .get(row.batch_id),
    },
    submitter: submitterView(row),
    clip: row.clip_id === null ? null : readClip(db, row.clip_id),
    // The choices the desk offers: accept the proposal, reassign to any active
    // group, or type a new one. Retired groups are listed too, marked, because a
    // reviewer looking at an old item needs to know why a group is not offered.
    groups: listGroups(db),
    locales: db.prepare('SELECT code, label, sort_order, is_ui_default FROM locales ORDER BY sort_order, code').all().map((l) => ({
      code: l.code,
      label: l.label,
      sortOrder: l.sort_order,
      isUiDefault: l.is_ui_default === 1,
    })),
    captionLimits: { captionMaxLength: CAPTION_MAX_LENGTH, labelMaxLength: LABEL_MAX_LENGTH },
  }
}

function readClip(db, clipId) {
  const clip = db
    .prepare('SELECT id, group_id, media_sha256, label, sort_order, state, created_at, published_at, retired_at FROM clips WHERE id = ?')
    .get(clipId)
  if (!clip) return null
  return {
    clipId: clip.id,
    groupId: clip.group_id,
    label: clip.label,
    sortOrder: clip.sort_order,
    state: clip.state,
    createdAt: clip.created_at,
    publishedAt: clip.published_at,
    retiredAt: clip.retired_at,
    captions: captionsOf(db, 'clip_captions', 'clip_id', clipId),
    missingLocales: db
      .prepare("SELECT locale FROM v_missing_captions WHERE subject_kind = 'clip' AND subject_id = ? ORDER BY locale")
      .all(clipId)
      .map((r) => r.locale),
  }
}

function listGroups(db) {
  return db
    .prepare('SELECT id, display_name, sort_order, state FROM groups ORDER BY state, sort_order, id')
    .all()
    .map((group) => ({
      id: group.id,
      displayName: group.display_name,
      sortOrder: group.sort_order,
      state: group.state,
      captions: captionsOf(db, 'group_captions', 'group_id', group.id),
    }))
}

function captionsOf(db, table, column, id) {
  // Interpolated identifiers are module constants, never caller input.
  const rows = db
    .prepare(`SELECT c.locale, c.text FROM ${table} c JOIN locales l ON l.code = c.locale WHERE c.${column} = ? ORDER BY l.sort_order, l.code`)
    .all(id)
  const out = {}
  for (const row of rows) out[row.locale] = row.text
  return out
}

// ---------------------------------------------------------------------------
// POST /api/admin/item/:id

/**
 * The review desk.
 *
 *   { decision: 'approve', label, captions, groupId | newGroup, reason? }
 *   { decision: 'reject', reason }
 *   { label?, captions?, groupId? }            an edit of an already-approved clip
 *
 * A decision is only available while the item is pending: approving something
 * already rejected would need a clip to appear under a resolved item, and
 * re-deciding would double-count the submitter's history. Editing the clip an
 * approval produced stays available forever, because that is where translations
 * get typed and typos get fixed.
 *
 * Everything the submitter proposed stays untouched. proposed_label is an INPUT
 * record — what they asked for — and overwriting it with what the reviewer chose
 * would erase the only evidence of the difference.
 */
export function reviewItem(db, itemId, input = {}, { actor, now = () => new Date() } = {}) {
  requireActor(actor)
  const at = toCanonicalTimestamp(now())
  const item = db
    .prepare('SELECT id, batch_id, media_sha256, state, clip_id, proposed_label, proposed_group_id FROM batch_items WHERE id = ?')
    .get(itemId)
  if (!item) throw new AdminError(`no item ${itemId}`, { code: 'not_found', status: 404 })

  const decision = input.decision ?? null
  if (decision !== null && decision !== 'approve' && decision !== 'reject') {
    throw new AdminError(`decision must be "approve" or "reject", got ${JSON.stringify(decision)}`, {
      code: 'invalid_request',
      details: { field: 'decision' },
    })
  }

  if (decision === null) return editApprovedClip(db, item, input, { actor, at })
  if (item.state !== 'pending') {
    throw new AdminError(
      `item ${itemId} is already ${item.state}; a decision is only available while it is pending`,
      { code: 'conflict', status: 409, details: { state: item.state } },
    )
  }

  // A decision needs something to decide. A DRAFT batch has not been submitted
  // yet and a CANCELLED one never will be — its items keep state 'pending' for
  // the life of the database, which is exactly the set this would otherwise let
  // a reviewer approve into the catalogue. The clips CHECK on
  // `(submitter_id IS NULL) = (submitted_at IS NULL)` would refuse the draft case
  // anyway, several statements later and naming a column nobody mentioned.
  const batch = db.prepare('SELECT id, submitter_id, state, submitted_at FROM batches WHERE id = ?').get(item.batch_id)
  if (batch.state !== 'submitted') {
    throw new AdminError(
      `batch ${batch.id} is ${batch.state}, not submitted; there is nothing to review until a submitter sends it`,
      { code: 'conflict', status: 409, details: { batchState: batch.state } },
    )
  }

  if (decision === 'reject') return rejectItem(db, item, batch, input, { actor, at })
  return approveItem(db, item, batch, input, { actor, at })
}

function approveItem(db, item, batch, input, { actor, at }) {
  const label = cleanText(input.label, 'label', LABEL_MAX_LENGTH)
  const captions = cleanCaptions(db, input.captions)
  if (Object.keys(captions).length === 0) {
    throw new AdminError('approving a clip needs at least one caption; a clip with none renders as its own key path', {
      code: 'invalid_request',
      details: { field: 'captions' },
    })
  }
  const note = input.reason === undefined || input.reason === null ? null : cleanNote(input.reason, 'reason')

  const hasGroupId = typeof input.groupId === 'string' && input.groupId !== ''
  const hasNewGroup = input.newGroup !== undefined && input.newGroup !== null
  if (hasGroupId === hasNewGroup) {
    throw new AdminError('name exactly one of groupId (accept or reassign) or newGroup (approve a proposed new one)', {
      code: 'invalid_request',
      details: { field: 'groupId' },
    })
  }
  const newGroup = hasNewGroup ? cleanNewGroup(db, input.newGroup) : null

  // clips.media_sha256 is UNIQUE: two clips over one blob are two buttons that
  // play the identical sound, which is what an approved duplicate looks like.
  // Checked here so the answer names the clip that already holds it.
  const duplicate = db.prepare('SELECT id, label FROM clips WHERE media_sha256 = ?').get(item.media_sha256)
  if (duplicate) {
    throw new AdminError(
      `this audio is already published as clip ${duplicate.id} (${duplicate.label}); approving it again would add a second button playing the identical sound`,
      { code: 'conflict', status: 409, details: { clipId: duplicate.id } },
    )
  }

  const apply = db.transaction(() => {
    const groupId = newGroup === null ? requireActiveGroup(db, input.groupId) : insertGroup(db, newGroup, at, actor)

    const clipId = randomUUID()
    const sortOrder =
      Number.isInteger(input.sortOrder)
        ? input.sortOrder
        : db.prepare('SELECT coalesce(max(sort_order), -1) + 1 AS next FROM clips WHERE group_id = ?').get(groupId).next

    // state 'draft': approval and publication are different events. Approving
    // item 1 of 5 must not put a button on the live site while the reviewer is
    // still looking at item 2 — POST /api/admin/publish is what makes it live.
    db.prepare(`
      INSERT INTO clips (id, group_id, media_sha256, label, sort_order, state, created_at, submitter_id, submitted_at)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)
    `).run(clipId, groupId, item.media_sha256, label, sortOrder, at, batch.submitter_id, batch.submitted_at)

    const insertCaption = db.prepare(
      'INSERT INTO clip_captions (clip_id, locale, text, updated_at) VALUES (?, ?, ?, ?)',
    )
    for (const [locale, text] of Object.entries(captions)) insertCaption.run(clipId, locale, text, at)

    db.prepare("UPDATE batch_items SET state = 'approved', resolved_at = ?, reviewer_note = ?, clip_id = ? WHERE id = ?")
      .run(at, note, clipId, item.id)
    db.prepare('UPDATE submitters SET approved_count = approved_count + 1 WHERE id = ?').run(batch.submitter_id)

    const batchResolved = resolveBatchIfDone(db, batch, at)

    record(db, {
      actorKind: 'owner',
      actorOpenId: actor.openId,
      actorDisplayName: actor.displayName,
      verb: 'admin.item.approve',
      subject: { kind: 'batch_item', id: item.id },
      before: { state: item.state, clipId: null },
      after: { state: 'approved', clipId, groupId, label, captions, reviewerNote: note },
      consequence: `clip:${clipId}`,
      succeeded: true,
      occurredAt: at,
    })

    return { clipId, groupId, batchResolved, createdGroup: newGroup === null ? null : groupId }
  })

  const result = apply.immediate()
  return {
    outcome: 'approved',
    itemId: item.id,
    ...result,
    clip: readClip(db, result.clipId),
  }
}

function rejectItem(db, item, batch, input, { actor, at }) {
  // batch_items CHECKs that a rejected item carries a reviewer_note: "a refusal
  // the submitter cannot read is a refusal nobody can appeal". Refusing here
  // first is what turns a raw CHECK failure into a sentence that says which
  // field is missing.
  const reason = cleanNote(input.reason, 'reason')

  const apply = db.transaction(() => {
    db.prepare("UPDATE batch_items SET state = 'rejected', resolved_at = ?, reviewer_note = ? WHERE id = ?")
      .run(at, reason, item.id)
    db.prepare('UPDATE submitters SET rejected_count = rejected_count + 1 WHERE id = ?').run(batch.submitter_id)
    const batchResolved = resolveBatchIfDone(db, batch, at)

    record(db, {
      actorKind: 'owner',
      actorOpenId: actor.openId,
      actorDisplayName: actor.displayName,
      verb: 'admin.item.reject',
      subject: { kind: 'batch_item', id: item.id },
      before: { state: item.state },
      after: { state: 'rejected', reviewerNote: reason },
      consequence: null,
      succeeded: true,
      occurredAt: at,
    })
    return { batchResolved }
  })

  return { outcome: 'rejected', itemId: item.id, ...apply.immediate() }
}

function editApprovedClip(db, item, input, { actor, at }) {
  if (item.clip_id === null) {
    throw new AdminError(
      `item ${item.id} has no clip to edit; pass a decision to approve or reject it first`,
      { code: 'conflict', status: 409, details: { state: item.state } },
    )
  }
  const before = readClip(db, item.clip_id)

  const label = input.label === undefined ? null : cleanText(input.label, 'label', LABEL_MAX_LENGTH)
  const captions = input.captions === undefined ? null : cleanCaptions(db, input.captions)
  const groupId = input.groupId === undefined ? null : requireActiveGroup(db, input.groupId)
  if (label === null && captions === null && groupId === null) {
    throw new AdminError('nothing to change: pass a label, captions, a groupId, or a decision', {
      code: 'invalid_request',
      details: { field: 'label' },
    })
  }

  const apply = db.transaction(() => {
    if (label !== null) db.prepare('UPDATE clips SET label = ? WHERE id = ?').run(label, item.clip_id)
    if (groupId !== null) db.prepare('UPDATE clips SET group_id = ? WHERE id = ?').run(groupId, item.clip_id)
    if (captions !== null) {
      const upsert = db.prepare(`
        INSERT INTO clip_captions (clip_id, locale, text, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (clip_id, locale) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
      `)
      for (const [locale, text] of Object.entries(captions)) upsert.run(item.clip_id, locale, text, at)
    }
    const after = readClip(db, item.clip_id)

    record(db, {
      actorKind: 'owner',
      actorOpenId: actor.openId,
      actorDisplayName: actor.displayName,
      verb: 'admin.clip.edit',
      subject: { kind: 'clip', id: item.clip_id },
      before: { label: before.label, groupId: before.groupId, captions: before.captions },
      after: { label: after.label, groupId: after.groupId, captions: after.captions },
      consequence: after.state === 'published' ? 'catalog:stale-until-publish' : null,
      succeeded: true,
      occurredAt: at,
    })
    return after
  })

  return { outcome: 'updated', itemId: item.id, clipId: item.clip_id, clip: apply.immediate() }
}

function resolveBatchIfDone(db, batch, at) {
  const progress = db.prepare('SELECT is_resolvable FROM v_batch_progress WHERE batch_id = ?').get(batch.id)
  if (!progress || progress.is_resolvable !== 1) return false
  if (batch.state !== 'submitted') return false
  db.prepare("UPDATE batches SET state = 'resolved', resolved_at = ? WHERE id = ?").run(at, batch.id)
  return true
}

function requireActiveGroup(db, groupId) {
  const group = db.prepare('SELECT id, state FROM groups WHERE id = ?').get(groupId)
  if (!group) {
    throw new AdminError(`no group ${groupId}`, { code: 'invalid_request', details: { field: 'groupId' } })
  }
  if (group.state !== 'active') {
    throw new AdminError(`group ${groupId} is retired; a clip published into it would be unreachable in the UI`, {
      code: 'conflict',
      status: 409,
      details: { field: 'groupId', state: group.state },
    })
  }
  return group.id
}

function cleanNewGroup(db, raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AdminError('newGroup must be an object', { code: 'invalid_request', details: { field: 'newGroup' } })
  }
  // The id is the vue-i18n key and is immutable once written, so it is never
  // submitter-chosen text: either the reviewer types a slug, or a uuid is minted.
  // A uuid is a bad key to read and a perfect key to keep, which is the trade the
  // ruling already made for clips.
  const id = raw.id === undefined || raw.id === null ? randomUUID() : String(raw.id)
  if (!ID_PATTERN.test(id)) {
    throw new AdminError(
      `newGroup.id ${JSON.stringify(id)} is not usable as a vue-i18n key: lowercase letters, digits, '-' and '_' only, at most 64 characters`,
      { code: 'invalid_request', details: { field: 'newGroup.id' } },
    )
  }
  if (db.prepare('SELECT 1 FROM groups WHERE id = ?').get(id)) {
    throw new AdminError(`group ${id} already exists`, { code: 'conflict', status: 409, details: { field: 'newGroup.id' } })
  }
  const displayName = cleanText(raw.displayName, 'newGroup.displayName', LABEL_MAX_LENGTH)
  const clash = db
    .prepare("SELECT id FROM groups WHERE state = 'active' AND display_name = ? COLLATE NOCASE")
    .get(displayName)
  if (clash) {
    throw new AdminError(
      `group ${clash.id} is already called ${JSON.stringify(displayName)}; two live groups with one visible name is how a clip gets filed under the wrong one`,
      { code: 'conflict', status: 409, details: { field: 'newGroup.displayName', groupId: clash.id } },
    )
  }
  return {
    id,
    displayName,
    sortOrder: Number.isInteger(raw.sortOrder) ? raw.sortOrder : null,
    captions: cleanCaptions(db, raw.captions ?? {}),
  }
}

function insertGroup(db, group, at, actor) {
  const sortOrder =
    group.sortOrder ?? db.prepare('SELECT coalesce(max(sort_order), -1) + 1 AS next FROM groups').get().next
  db.prepare('INSERT INTO groups (id, display_name, sort_order, state, created_at) VALUES (?, ?, ?, \'active\', ?)')
    .run(group.id, group.displayName, sortOrder, at)
  const insertCaption = db.prepare(
    'INSERT INTO group_captions (group_id, locale, text, updated_at) VALUES (?, ?, ?, ?)',
  )
  for (const [locale, text] of Object.entries(group.captions)) insertCaption.run(group.id, locale, text, at)

  record(db, {
    actorKind: 'owner',
    actorOpenId: actor.openId,
    actorDisplayName: actor.displayName,
    verb: 'admin.group.create',
    subject: { kind: 'group', id: group.id },
    before: null,
    after: { displayName: group.displayName, sortOrder, captions: group.captions },
    consequence: null,
    succeeded: true,
    occurredAt: at,
  })
  return group.id
}

// ---------------------------------------------------------------------------
// text

/**
 * One gate for every string that reaches vue-i18n as a message value: validate
 * the raw text, store escapeForI18n(raw). Both, and in that order — validate
 * refuses a linked message (a read of text the author does not own), escape
 * neutralises the braces and pipes that would garble their own sentence.
 */
function cleanText(value, field, maxLength) {
  const verdict = validateCaption(value, { maxLength })
  if (!verdict.ok) {
    throw new AdminError(`${field} was refused: ${verdict.reason}`, {
      code: 'invalid_text',
      details: { field, reason: verdict.reason, maxLength },
    })
  }
  return escapeForI18n(value)
}

function cleanCaptions(db, raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AdminError('captions must be an object keyed by locale code', {
      code: 'invalid_request',
      details: { field: 'captions' },
    })
  }
  const known = new Set(db.prepare('SELECT code FROM locales').all().map((row) => row.code))
  const out = {}
  for (const [locale, text] of Object.entries(raw)) {
    if (!known.has(locale)) {
      // The FK on clip_captions.locale would catch this, but as a raw constraint
      // failure that names neither the value nor which of three locales it is.
      throw new AdminError(`${JSON.stringify(locale)} is not a locale this site publishes`, {
        code: 'invalid_request',
        details: { field: `captions.${locale}`, known: [...known].sort() },
      })
    }
    // A locale the owner has not written yet is an ABSENT key, never ''. With no
    // fallbackLocale in src/main.js, '' renders an empty button — a hole nobody
    // can see — while a missing key renders the key path, which is the hole that
    // gets reported and fixed.
    if (text === null || text === undefined) continue
    out[locale] = cleanText(text, `captions.${locale}`, CAPTION_MAX_LENGTH)
  }
  return out
}

/**
 * A reviewer's note. NOT escapeForI18n'd, and that is a decision rather than an
 * omission: this text is a VALUE in an API response, not a message key or a
 * message value — nothing renders it through $t. If a page ever does, it needs
 * the same treatment the captions get, and this comment is where to start.
 *
 * What it does refuse: a lone surrogate (which becomes U+FFFD the moment the
 * response is encoded as UTF-8, corrupting the note rather than shortening it)
 * and the control characters that have no business in a sentence. Newline and
 * tab survive, because a rejection reason is allowed to have paragraphs.
 */
function cleanNote(value, field, maxLength = NOTE_MAX_LENGTH) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AdminError(`${field} is required and must be a non-empty string`, {
      code: 'invalid_request',
      details: { field },
    })
  }
  const text = value.trim()
  if ([...text].length > maxLength) {
    throw new AdminError(`${field} is longer than ${maxLength} characters`, {
      code: 'invalid_request',
      details: { field, maxLength },
    })
  }
  if (HAS_LONE_SURROGATE.test(text)) {
    throw new AdminError(`${field} contains an unpaired surrogate`, { code: 'invalid_text', details: { field } })
  }
  if (HAS_FORBIDDEN_CONTROL.test(text)) {
    throw new AdminError(`${field} contains a control character`, { code: 'invalid_text', details: { field } })
  }
  return text
}

/*
 * Both patterns are built from ESCAPE SEQUENCES and never from literal bytes,
 * for the reason text-safety.mjs gives at length: a control character written
 * literally into source is invisible to the next reader, invisible to grep — a
 * file containing one is treated as binary and matches are silently dropped —
 * and one stray editor pass deletes it without a trace. This file already had
 * that defect once, and it is how a guard quietly stops guarding.
 *
 * Tab (0009), newline (000A) and carriage return (000D) are the three the note
 * is allowed to contain; every other C0/C1 control is refused.
 */
const HAS_FORBIDDEN_CONTROL = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]')
const HAS_LONE_SURROGATE = new RegExp(
  '[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]',
)

// ---------------------------------------------------------------------------
// POST /api/admin/publish

/**
 * Make the approved clips live and materialise the catalogue.
 *
 * Two events, two transactions, in this order and not the other:
 *
 *   1. promote the draft clips (committed), then
 *   2. write catalog.json and the media (a filesystem rename).
 *
 * Whichever half fails, one of the two is ahead of the other. DB-ahead means the
 * site serves the previous catalogue until the next publish, and the next publish
 * fixes it — writeCatalog is deterministic and skips a file whose bytes are
 * already right, so re-running is always safe. File-ahead would mean the site
 * serving clips the database does not consider published, which nothing later
 * corrects. So the recoverable direction is chosen deliberately.
 *
 * Everything that can refuse is checked BEFORE the promotion: a hole in a
 * caption, a retired group, a missing blob. A publish that half-happens is worse
 * than one that does not start.
 */
export function publishCatalogue(db, paths, { actor, now = () => new Date(), dryRun = false, promote = true, verifyMedia } = {}) {
  requireActor(actor)
  const at = toCanonicalTimestamp(now())

  const candidates = promote
    ? db.prepare("SELECT id, group_id, media_sha256, label FROM clips WHERE state = 'draft' ORDER BY group_id, sort_order, id").all()
    : []

  const retiredGroups = candidates
    .map((clip) => clip.group_id)
    .filter((groupId, index, all) => all.indexOf(groupId) === index)
    .map((groupId) => db.prepare('SELECT id, state FROM groups WHERE id = ?').get(groupId))
    .filter((group) => group && group.state !== 'active')

  // A group nothing published points at yet: publishing a clip into it puts a
  // NEW heading on the page, so a missing caption there is a hole this publish
  // would create. A group that is already on the page can have a hole that is
  // already visible, and refusing to publish would not close it — only report it.
  const alreadyLive = new Set(
    db.prepare("SELECT DISTINCT group_id FROM clips WHERE state = 'published'").all().map((row) => row.group_id),
  )
  const candidateIds = new Set(candidates.map((clip) => clip.id))
  const arrivingGroups = new Set(candidates.map((clip) => clip.group_id).filter((id) => !alreadyLive.has(id)))

  const holes = db.prepare('SELECT subject_kind, subject_id, locale FROM v_missing_captions ORDER BY subject_kind, subject_id, locale').all()
  const blocking = holes.filter(
    (hole) =>
      (hole.subject_kind === 'clip' && candidateIds.has(hole.subject_id)) ||
      (hole.subject_kind === 'group' && arrivingGroups.has(hole.subject_id)),
  )
  const warnings = holes.filter((hole) => !blocking.includes(hole))

  const mediaProblems = candidates.length === 0
    ? []
    : checkMedia(db, { mediaDir: paths.mediaDir, verify: verifyMedia ?? 'stat' }, candidates.map((clip) => clip.media_sha256))

  const plan = {
    promoting: candidates.map((clip) => clip.id),
    blockingHoles: blocking,
    existingHoles: warnings,
    mediaProblems,
    retiredGroups: retiredGroups.map((group) => group.id),
  }

  if (retiredGroups.length > 0) {
    throw new AdminError(
      `${retiredGroups.length} clip(s) are waiting in a retired group; a published clip there is a button nobody can find`,
      { code: 'conflict', status: 409, details: plan },
    )
  }
  if (blocking.length > 0) {
    throw new AdminError(
      `${blocking.length} translation(s) are missing on what this publish would put on the page; with no fallback locale each renders as its own key path`,
      { code: 'conflict', status: 409, details: plan },
    )
  }
  if (mediaProblems.length > 0) {
    throw new AdminError(
      `${mediaProblems.length} audio file(s) named by a clip are missing from the media directory or do not match the database`,
      { code: 'conflict', status: 409, details: plan },
    )
  }

  if (dryRun) {
    // Not a mutation, so not audited. What it reports is the catalogue AS IT
    // STANDS plus the plan above — it deliberately does not simulate the
    // promotion, because a document built from rows that were never promoted
    // would be a preview of a state no database was ever in.
    const preview = writeCatalog(db, paths, { dryRun: true, now: now(), verifyMedia })
    return { dryRun: true, plan, catalog: withoutDocument(preview), warnings }
  }

  if (candidates.length > 0) {
    const promoteAll = db.transaction(() => {
      const update = db.prepare("UPDATE clips SET state = 'published', published_at = ? WHERE id = ? AND state = 'draft'")
      for (const clip of candidates) update.run(at, clip.id)
      record(db, {
        actorKind: 'owner',
        actorOpenId: actor.openId,
        actorDisplayName: actor.displayName,
        verb: 'admin.clip.publish',
        subject: { kind: 'clip', id: candidates.length === 1 ? candidates[0].id : null },
        // clipIds appears on ONE side only, and that is deliberate: diffFields
        // omits a field whose value did not change, so listing the same array
        // twice would record which state changed and never which clips it was.
        before: { state: 'draft' },
        after: { state: 'published', clipIds: plan.promoting },
        // The catalogue write has not happened yet, and this entry must not
        // claim it did. The 'admin.catalog.write' entry below carries the digest.
        consequence: null,
        succeeded: true,
        occurredAt: at,
      })
    })
    promoteAll.immediate()
  }

  let written
  try {
    written = writeCatalog(db, paths, { now: now(), verifyMedia })
  } catch (error) {
    record(db, {
      actorKind: 'owner',
      actorOpenId: actor.openId,
      actorDisplayName: actor.displayName,
      verb: 'admin.catalog.write',
      subject: { kind: 'catalog', id: null },
      before: null,
      after: { error: error.code ?? 'write_failed', message: error.message, promoted: plan.promoting },
      consequence: null,
      succeeded: false,
      occurredAt: toCanonicalTimestamp(now()),
    })
    throw error
  }

  record(db, {
    actorKind: 'owner',
    actorOpenId: actor.openId,
    actorDisplayName: actor.displayName,
    verb: 'admin.catalog.write',
    subject: { kind: 'catalog', id: written.catalogSha256 },
    before: null,
    after: {
      groups: written.groups,
      clips: written.clips,
      bytes: written.catalogBytes,
      changed: written.catalogChanged,
      promoted: plan.promoting,
    },
    consequence: `catalog:${written.catalogSha256}`,
    succeeded: true,
    occurredAt: written.writtenAt,
  })

  return { dryRun: false, plan, catalog: withoutDocument(written), warnings }
}

// The document itself is on the shared directory; echoing it into every publish
// response would make the answer as large as the file.
function withoutDocument(result) {
  const { document, ...rest } = result
  return rest
}

// ---------------------------------------------------------------------------
// GET /api/admin/audit

/**
 * The log, newest first.
 *
 * Filters: actorOpenId, actorKind, subjectKind, subjectId, verb, since, until.
 * `since`/`until` compare as STRINGS, which is chronological because every
 * timestamp column is CHECKed to one canonical second-precision UTC form — that
 * is the whole reason the form exists.
 *
 * Rows are selected here and then hydrated one at a time through
 * lib/audit.mjs's getEntry(). That is one indexed lookup per row, bounded by the
 * page cap, and it buys the thing worth buying: the audit envelope is decoded by
 * the module that owns it, so there is no second mapper here to drift out of
 * step with it.
 *
 * The cursor is byte-compatible with the one lib/audit.mjs issues, and a test
 * feeds each pager's cursor to the other to keep it that way.
 */
export function readAuditPage(db, query = {}) {
  const limit = intParam(query.limit, 'limit', AUDIT_DEFAULT_PAGE_SIZE, 1, AUDIT_MAX_PAGE_SIZE)
  const clauses = []
  const params = {}

  if (isPresent(query.actorOpenId)) {
    clauses.push('actor_id = @actorOpenId')
    params.actorOpenId = String(query.actorOpenId)
  }
  if (isPresent(query.actorKind)) {
    const actorKind = String(query.actorKind)
    if (!AUDIT_ACTOR_KINDS.includes(actorKind)) {
      throw new AdminError(`actorKind must be one of ${AUDIT_ACTOR_KINDS.join(', ')}`, {
        code: 'invalid_request',
        details: { field: 'actorKind' },
      })
    }
    clauses.push('actor_kind = @actorKind')
    params.actorKind = actorKind
  }
  if (isPresent(query.subjectKind)) {
    clauses.push('subject_kind = @subjectKind')
    params.subjectKind = String(query.subjectKind)
  }
  if (isPresent(query.subjectId)) {
    clauses.push('subject_id = @subjectId')
    params.subjectId = String(query.subjectId)
  }
  if (isPresent(query.verb)) {
    clauses.push('action = @verb')
    params.verb = String(query.verb)
  }
  if (isPresent(query.since)) {
    clauses.push('at >= @since')
    params.since = canonicalBound(query.since, 'since')
  }
  if (isPresent(query.until)) {
    clauses.push('at <= @until')
    params.until = canonicalBound(query.until, 'until')
  }
  if (isPresent(query.cursor)) {
    clauses.push('seq < @cursorSeq')
    params.cursorSeq = decodeAuditCursor(query.cursor)
  }

  const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
  const rows = db
    .prepare(`SELECT seq, id FROM audit_log ${where} ORDER BY seq DESC LIMIT @limit`)
    .all({ ...params, limit: limit + 1 })

  const page = rows.slice(0, limit)
  const nextCursor = rows.length > limit ? encodeAuditCursor(page[page.length - 1].seq) : null
  return { entries: page.map((row) => getEntry(db, row.id)), nextCursor, limit }
}

// Same encoding lib/audit.mjs uses: base64url of {"s":<seq>}. seq is an
// autoincrementing integer, which the project's id convention keeps off the
// wire, so it travels encoded rather than as a row number a caller could count
// with.
function encodeAuditCursor(seq) {
  return Buffer.from(JSON.stringify({ s: seq }), 'utf8').toString('base64url')
}

function decodeAuditCursor(cursor) {
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'))
  } catch {
    throw new AdminError('malformed cursor', { code: 'invalid_request', details: { field: 'cursor' } })
  }
  if (parsed === null || typeof parsed !== 'object' || !Number.isInteger(parsed.s)) {
    throw new AdminError('malformed cursor', { code: 'invalid_request', details: { field: 'cursor' } })
  }
  return parsed.s
}

function canonicalBound(value, field) {
  try {
    return toCanonicalTimestamp(typeof value === 'string' ? value : new Date(value))
  } catch {
    throw new AdminError(
      `${field} must be a canonical UTC timestamp such as 2026-08-01T00:00:00Z (second precision, no fractional part)`,
      { code: 'invalid_request', details: { field } },
    )
  }
}

// ---------------------------------------------------------------------------

function intParam(value, field, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AdminError(`${field} must be an integer in ${min}..${max}`, {
      code: 'invalid_request',
      details: { field, min, max },
    })
  }
  return parsed
}

function isPresent(value) {
  return value !== undefined && value !== null && value !== ''
}

function requireActor(actor) {
  if (!actor || typeof actor.openId !== 'string' || actor.openId === '') {
    throw new AdminError('an admin action needs the acting admin; the audit entry cannot be attributed without one', {
      code: 'invalid_request',
      status: 500,
      details: { field: 'actor' },
    })
  }
}

function requirePresent(value, name) {
  if (value === undefined || value === null) {
    throw new Error(`admin routes: ${name} is required`)
  }
  return value
}
