// SPDX-License-Identifier: MIT
//
// Online admin invitations (JOI-BUTTON-STORY-055).
//
// An existing admin opens an invitation; a candidate proves an open_id by
// posting the invitation's phrase as a danmaku in the room — exactly the login
// mechanism, one layer over; and then the inviting admin CONFIRMS, which is the
// step that actually makes the candidate an admin. The two steps are the owner's
// ruling: a danmaku records WHO claimed the phrase, but a human who can already
// see the desk decides whether that is the person they meant. A stolen or stray
// phrase binds nobody on its own.
//
// This mirrors the room orchestration in routes/public.mjs (acquire a lease to
// keep the socket listening, match phrases, release when done) rather than
// sharing its state machine, because that one is wound tightly around a login
// session and an invite has none. What the two genuinely share — the danmaku
// source, the phrase generator, the matcher — they import.

import { randomUUID } from 'node:crypto'

import { record as recordAudit } from './audit.mjs'
import { danmakuCarriesPhrase, generateChallengePhrase } from './challenge-phrase.mjs'

const DEFAULTS = Object.freeze({ codeTtlMinutes: 10, maxPendingInvites: 20 })
const MINUTE_MS = 60_000

const isUniqueViolation = (error) =>
  typeof error?.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT_')

/**
 * @param {object}  deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {object}  deps.danmakuSource        the shared room source (acquire/release/on)
 * @param {number}  deps.roomId
 * @param {() => Date} [deps.now]
 * @param {number}  [deps.codeTtlMinutes]
 * @param {number}  [deps.maxPendingInvites]
 */
export function createAdminInvites({
  db,
  danmakuSource,
  roomId,
  now = () => new Date(),
  codeTtlMinutes = DEFAULTS.codeTtlMinutes,
  maxPendingInvites = DEFAULTS.maxPendingInvites,
}) {
  const stamp = () => toStamp(now())
  const leaseByInvite = new Map() // invite id -> leaseId

  const q = {
    countPending: db.prepare(
      "SELECT count(*) AS n FROM admin_invites WHERE state = 'pending' AND expires_at > @now",
    ),
    insert: db.prepare(`
      INSERT INTO admin_invites (id, challenge_text, room_id, created_by, issued_at, expires_at)
      VALUES (@id, @challenge_text, @room_id, @created_by, @issued_at, @expires_at)
    `),
    byId: db.prepare('SELECT * FROM admin_invites WHERE id = ?'),
    pending: db.prepare(
      "SELECT id, challenge_text FROM admin_invites WHERE state = 'pending' AND expires_at > @now",
    ),
    expired: db.prepare("SELECT id FROM admin_invites WHERE state = 'pending' AND expires_at <= @now"),
    expireOne: db.prepare(
      "UPDATE admin_invites SET state = 'expired', closed_at = @now WHERE id = @id AND state = 'pending'",
    ),
    claim: db.prepare(`
      UPDATE admin_invites
         SET state = 'claimed', observed_open_id = @open_id,
             observed_display_name = @display_name, claimed_at = @now
       WHERE id = @id AND state = 'pending'
    `),
    cancel: db.prepare(
      "UPDATE admin_invites SET state = 'cancelled', closed_at = @now WHERE id = @id AND state IN ('pending','claimed')",
    ),
    confirm: db.prepare(
      "UPDATE admin_invites SET state = 'confirmed', confirmed_at = @now, closed_at = @now WHERE id = @id AND state = 'claimed'",
    ),
    upsertAdmin: db.prepare(`
      INSERT INTO admins (open_id, display_name, invited_by, invited_at)
      VALUES (@open_id, @display_name, @invited_by, @invited_at)
      ON CONFLICT (open_id) DO UPDATE SET
        display_name = excluded.display_name,
        invited_by   = excluded.invited_by,
        invited_at   = excluded.invited_at,
        revoked_at   = NULL
    `),
  }

  function releaseLease(inviteId) {
    const leaseId = leaseByInvite.get(inviteId)
    if (leaseId === undefined) return
    leaseByInvite.delete(inviteId)
    danmakuSource.release(leaseId)
  }

  function sweep() {
    const at = stamp()
    for (const row of q.expired.all({ now: at })) {
      q.expireOne.run({ id: row.id, now: at })
      releaseLease(row.id)
    }
  }

  // The room listener for invite phrases. Separate handler from the login one;
  // each danmaku runs both, and each checks only its own pending set. First
  // match wins and the phrase moves to 'claimed' — the lease is released here,
  // because the candidate has now been observed and the rest of the flow (the
  // admin's confirm) is HTTP-only and needs no listener.
  const unsubscribe = danmakuSource.on('danmaku', (event) => {
    try {
      const at = stamp()
      for (const row of q.pending.all({ now: at })) {
        if (danmakuCarriesPhrase(event.text, row.challenge_text)) {
          const changed = q.claim.run({
            id: row.id,
            open_id: event.openId,
            display_name: event.displayName === '' ? null : event.displayName,
            now: at,
          }).changes
          if (changed === 1) releaseLease(row.id)
          return
        }
      }
    } catch {
      // Never surface the open_id or the text (audit.mjs's own rule); a failed
      // match must not take the room listener down for the login flow either.
    }
  })

  /**
   * Open an invitation. Returns immediately with the phrase; the room lease is
   * acquired in the BACKGROUND, exactly as /api/login/start does — awaiting it
   * inline would block the response until the socket finished opening (several
   * seconds against the real platform), and would deadlock a test whose clock
   * only advances between requests. The admin polls status(), whose `listening`
   * flag reports when the room is actually ready for the candidate to post.
   */
  function create({ createdBy }) {
    sweep()
    if (q.countPending.get({ now: stamp() }).n >= maxPendingInvites) {
      return { ok: false, code: 'invite_capacity' }
    }

    const id = randomUUID()
    const issuedAt = stamp()
    const expiresAt = toStamp(new Date(Date.parse(issuedAt) + codeTtlMinutes * MINUTE_MS))

    for (let tries = 0; ; tries += 1) {
      try {
        q.insert.run({
          id,
          challenge_text: generateChallengePhrase(),
          room_id: roomId,
          created_by: createdBy,
          issued_at: issuedAt,
          expires_at: expiresAt,
        })
        break
      } catch (error) {
        if (tries >= 5 || !isUniqueViolation(error)) throw error
      }
    }

    // Fire-and-forget: store the lease when the socket is up, or drop it if the
    // invite was cancelled/claimed while it was opening.
    danmakuSource.acquire().then(
      (lease) => {
        const row = q.byId.get(id)
        if (row === undefined || row.state !== 'pending') danmakuSource.release(lease.leaseId)
        else leaseByInvite.set(id, lease.leaseId)
      },
      () => {
        // The socket could not open; the invite expires on its own and the
        // admin sees `listening: false` and can retry.
      },
    )

    return { ok: true, invite: describe(q.byId.get(id)) }
  }

  function status(id) {
    const row = q.byId.get(id)
    return row === undefined ? null : describe(row)
  }

  function cancel(id) {
    const changed = q.cancel.run({ id, now: stamp() }).changes
    releaseLease(id)
    return changed === 1
  }

  /**
   * Turn a claimed candidate into an admin. Transactional: the invite flips to
   * 'confirmed' and the admin row is written together, or neither is.
   */
  const confirmTx = db.transaction((id, by) => {
    const row = q.byId.get(id)
    if (row === undefined) return { ok: false, code: 'invite_not_found' }
    if (row.state === 'confirmed') return { ok: false, code: 'invite_already_confirmed' }
    if (row.state !== 'claimed') return { ok: false, code: 'invite_not_claimed' }

    const at = stamp()
    q.confirm.run({ id, now: at })
    q.upsertAdmin.run({
      open_id: row.observed_open_id,
      display_name: row.observed_display_name ?? row.observed_open_id,
      invited_by: by.openId,
      invited_at: at,
    })
    recordAudit(db, {
      actorKind: 'owner',
      actorOpenId: by.openId,
      actorDisplayName: by.displayName,
      verb: 'admin.invite.confirm',
      subject: { kind: 'admin', id: row.observed_open_id },
      before: null,
      after: { openId: row.observed_open_id, invitedBy: by.openId },
      consequence: null,
      succeeded: true,
      occurredAt: at,
    })
    return { ok: true, openId: row.observed_open_id }
  })

  function confirm({ id, by }) {
    const result = confirmTx(id, by)
    if (result.ok) releaseLease(id)
    return result
  }

  /** What a status/create response says. Never leaks the phrase to a non-owner:
   * only the inviting admin ever reads it, so it is included; the candidate's
   * open_id is shown to that admin because deciding whether to confirm requires
   * seeing exactly who claimed it. */
  function describe(row) {
    const snapshot = danmakuSource.status({ since: row.issued_at })
    const at = stamp()
    return {
      id: row.id,
      state: row.state,
      roomId: row.room_id,
      challengeText: row.challenge_text,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      expiresInSeconds: Math.max(0, Math.round((Date.parse(row.expires_at) - Date.parse(at)) / 1000)),
      listening: snapshot.visitor?.verdict?.startsWith?.('listening') ?? snapshot.listening ?? null,
      candidate:
        row.observed_open_id === null
          ? null
          : { openId: row.observed_open_id, displayName: row.observed_display_name },
      confirmedAt: row.confirmed_at,
    }
  }

  function close() {
    unsubscribe()
    for (const leaseId of leaseByInvite.values()) danmakuSource.release(leaseId)
    leaseByInvite.clear()
  }

  return Object.freeze({ create, status, cancel, confirm, sweep, close })
}

function toStamp(date) {
  return `${date.toISOString().slice(0, 19)}Z`
}
