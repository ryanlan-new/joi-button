// SPDX-License-Identifier: MIT
//
// Media reclamation (JOI-BUTTON-STORY-077).
//
// Rejecting a submission does not delete its audio: the file stays on the PVC,
// and v_unreferenced_media NAMES the blobs nothing points at, but until this
// module nothing acted on it. Here is the janitor — deliberately MANUAL for now
// (an admin previews what is collectable and presses a button), because the file
// it removes may be the only copy left of something a submitter can no longer
// re-send, so a human decides before bytes go.
//
// WHAT IS COLLECTABLE. Three conditions, and the invariant test drives every one
// of them in both directions:
//   1. unreferenced — in v_unreferenced_media, i.e. no clip and no pending/approved
//      item in a live batch points at it. A blob a published (or retired) clip
//      still names is NEVER here; a retired clip keeps its bytes.
//   2. not already collected — media.collected_at IS NULL.
//   3. aged out — its most recent activity (the latest resolved_at among the items
//      that reference it, else the latest such item's created_at, else the blob's
//      own uploaded_at) is more than RETENTION days ago. This is the window in
//      which a mis-judged rejection can be revised, or the last copy noticed.
//
// ORDERING. collectMedia marks the row (collected_at) and audits it in one
// transaction, and only THEN removes the file. Never the other way round: a file
// deleted before the record is committed would leave the database believing a
// gone file is present — the failure that makes a revise or a publish blow up
// confusingly. A record with the file still there is merely a leak, and it heals
// itself the moment those bytes are submitted again (routes/public.mjs clears
// collected_at) or is swept by hand.

import { unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { toCanonicalTimestamp } from '../db/migrate.mjs'
import { record } from './audit.mjs'

const DAY_MS = 24 * 60 * 60 * 1000

// How long a rejected item's audio is kept before it may be reclaimed. The
// recycle bin (STORY-076) shows the days remaining against the SAME number, so
// the window the bin promises and the window the sweep enforces cannot drift.
export const RECYCLE_RETENTION_DAYS = 30

export class MediaGcError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'MediaGcError'
    this.code = code
  }
}

/**
 * The blobs collectable right now: unreferenced, not yet collected, and aged out.
 *
 * `now` and `retentionDays` are injected so the same list a preview shows is the
 * list a collect acts on, and so a test can put the clock anywhere.
 *
 * @returns {Array<{sha256: string, storagePath: string, bytes: number, lastActivity: string}>}
 *          newest activity last, so the oldest (safest to remove) sort first.
 */
export function listCollectable(db, { now = () => new Date(), retentionDays = RECYCLE_RETENTION_DAYS } = {}) {
  const rows = db
    .prepare(`
      SELECT u.sha256, u.storage_path, u.bytes,
             coalesce(
               (SELECT max(i.resolved_at) FROM batch_items i WHERE i.media_sha256 = u.sha256),
               (SELECT max(i.created_at)  FROM batch_items i WHERE i.media_sha256 = u.sha256),
               m.uploaded_at
             ) AS last_activity
      FROM v_unreferenced_media u
      JOIN media m ON m.sha256 = u.sha256
      WHERE m.collected_at IS NULL
      ORDER BY last_activity, u.sha256
    `)
    .all()

  const cutoffMs = now().getTime() - retentionDays * DAY_MS
  const out = []
  for (const row of rows) {
    const activityMs = Date.parse(row.last_activity)
    // Unparseable activity is not aged out by default: better to leave a blob than
    // to remove one whose age we cannot establish.
    if (!Number.isFinite(activityMs) || activityMs > cutoffMs) continue
    out.push({ sha256: row.sha256, storagePath: row.storage_path, bytes: row.bytes, lastActivity: row.last_activity })
  }
  return out
}

/** Count and total size of what listCollectable would return, for a preview. */
export function reclaimablePreview(db, options = {}) {
  const items = listCollectable(db, options)
  return {
    items,
    count: items.length,
    totalBytes: items.reduce((sum, item) => sum + item.bytes, 0),
    retentionDays: options.retentionDays ?? RECYCLE_RETENTION_DAYS,
  }
}

/**
 * Reclaim the collectable blobs: mark + audit each in its own transaction, then
 * remove its file. Per-blob so a crash mid-sweep leaves the ones already done
 * fully done and the rest untouched.
 *
 * @param {object} actor { openId, displayName } — the admin who asked. Manual for
 *   now, so it is audited to them (actor_kind 'owner'); a future timer would pass
 *   a system identity.
 * @returns {{collected: Array<{sha256, bytes}>, count: number, freedBytes: number,
 *            failures: Array<{sha256, error}>}}
 */
export function collectMedia(db, mediaDir, { actor, now = () => new Date(), retentionDays = RECYCLE_RETENTION_DAYS } = {}) {
  if (!actor || typeof actor.displayName !== 'string' || actor.displayName === '') {
    throw new MediaGcError('collectMedia needs an actor with a displayName', 'bad_actor')
  }
  if (typeof mediaDir !== 'string' || mediaDir === '') {
    throw new MediaGcError('collectMedia needs a mediaDir', 'bad_argument')
  }

  const at = toCanonicalTimestamp(now())
  const candidates = listCollectable(db, { now, retentionDays })

  const markOne = db.transaction((candidate) => {
    // Re-check under the transaction: between listing and here a revise or a
    // re-submit could have re-referenced the blob or cleared its mark. If so,
    // skip it — do not mark or remove something now in use.
    const stillUnreferenced = db.prepare('SELECT 1 FROM v_unreferenced_media WHERE sha256 = ?').get(candidate.sha256)
    const row = db.prepare('SELECT collected_at FROM media WHERE sha256 = ?').get(candidate.sha256)
    if (!stillUnreferenced || !row || row.collected_at !== null) return false

    db.prepare('UPDATE media SET collected_at = @at WHERE sha256 = @sha256').run({ at, sha256: candidate.sha256 })
    record(db, {
      actorKind: 'owner',
      actorOpenId: actor.openId ?? null,
      actorDisplayName: actor.displayName,
      verb: 'admin.media.collect',
      subject: { kind: 'media', id: candidate.sha256 },
      before: { collectedAt: null },
      after: { collectedAt: at, bytes: candidate.bytes, lastActivity: candidate.lastActivity },
      consequence: `media:${candidate.sha256}`,
      succeeded: true,
      occurredAt: at,
    })
    return true
  })

  const collected = []
  const failures = []
  let freedBytes = 0
  for (const candidate of candidates) {
    if (!markOne.immediate(candidate)) continue
    // Committed: the row says collected regardless of what happens to the file,
    // which is the source-of-truth ordering. Now remove the file.
    try {
      unlinkSync(join(mediaDir, candidate.storagePath))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // The row says collected but the bytes are still on disk: a leak, not a
        // corruption, and NOT freed space. Reported so a caller can log it; a
        // re-submit or a hand sweep reclaims it later. Do not count it as freed —
        // the "freed X" the panel shows must be bytes that actually left the disk.
        failures.push({ sha256: candidate.sha256, error: error?.message ?? String(error) })
        continue
      }
      // ENOENT: already absent, so the reclaim is complete and it counts.
    }
    collected.push({ sha256: candidate.sha256, bytes: candidate.bytes })
    freedBytes += candidate.bytes
  }

  return { collected, count: collected.length, freedBytes, failures }
}
