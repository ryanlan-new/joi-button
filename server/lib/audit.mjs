/**
 * Append-only admin audit log (STORY-016).
 *
 * The table, its CHECK constraints and its no-UPDATE/no-DELETE triggers are
 * owned by server/db/schema.sql. This module owns what goes in and what comes
 * out, and it never issues an UPDATE or a DELETE against the log — the only way
 * to fix a wrong entry is recordCorrection(), which appends.
 *
 * Columns this module codes against (schema.sql, audit_log):
 *
 *   seq           INTEGER PRIMARY KEY AUTOINCREMENT   append order; never exposed
 *   id            TEXT NOT NULL UNIQUE                randomUUID()
 *   at            TEXT NOT NULL                       ISO-8601 UTC, SECOND precision
 *   actor_kind    TEXT NOT NULL                       'owner' | 'submitter' | 'system'
 *   actor_id      TEXT                                the actor's open_id
 *   action        TEXT NOT NULL                       the verb
 *   subject_kind  TEXT NOT NULL
 *   subject_id    TEXT                                nullable
 *   detail        TEXT                                JSON, see DETAIL ENVELOPE
 *
 * assertAuditSchema() checks that list, so a rename over in schema.sql breaks
 * loudly here instead of at 3am.
 *
 * DETAIL ENVELOPE — defined here, because nothing else writes audit rows yet.
 * The table has no column for the actor's display name, the success flag, the
 * consequence handle or the correction link, and adding four columns to someone
 * else's file is not this module's call. They live in `detail`, which the table
 * already constrains to valid JSON:
 *
 *   {
 *     "actorDisplayName": string,
 *     "succeeded":        boolean,
 *     "consequence":      string | null,
 *     "diff":             { field: { before?: unknown, after?: unknown } },
 *     "correctsId":       string,   // corrections only
 *     "correctionReason": string    // corrections only
 *   }
 */

import { randomUUID } from 'node:crypto';

export const AUDIT_TABLE = 'audit_log';

export const AUDIT_REQUIRED_COLUMNS = Object.freeze([
  'seq',
  'id',
  'at',
  'actor_kind',
  'actor_id',
  'action',
  'subject_kind',
  'subject_id',
  'detail'
]);

export const AUDIT_ACTOR_KINDS = Object.freeze(['owner', 'submitter', 'system']);

export const AUDIT_DEFAULT_PAGE_SIZE = 50;
export const AUDIT_MAX_PAGE_SIZE = 200;

// Listed explicitly rather than SELECT *, so a column added to schema.sql
// cannot silently change the shape of what callers receive.
const SELECT_COLUMNS = AUDIT_REQUIRED_COLUMNS.join(', ');

// seq is omitted: it is AUTOINCREMENT and the table is the authority on order.
const INSERT_SQL = `
  INSERT INTO ${AUDIT_TABLE} (
    id, at, actor_kind, actor_id, action, subject_kind, subject_id, detail
  ) VALUES (
    @id, @at, @actor_kind, @actor_id, @action, @subject_kind, @subject_id, @detail
  )
`;

// Accepts fractional seconds on the way in and truncates them, but refuses a
// UTC offset rather than converting it: the shared contract says these are UTC
// strings, and quietly normalising +08:00 would hide the one case where the
// recorded instant is probably wrong.
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * @param {import('better-sqlite3').Database} db
 */
export function assertAuditSchema(db) {
  // Interpolated identifier is a module constant, never caller input.
  const columns = db.pragma(`table_info(${AUDIT_TABLE})`);
  if (columns.length === 0) {
    throw new Error(`audit: table "${AUDIT_TABLE}" does not exist`);
  }
  const present = new Set(columns.map((column) => column.name));
  const missing = AUDIT_REQUIRED_COLUMNS.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(`audit: table "${AUDIT_TABLE}" is missing column(s): ${missing.join(', ')}`);
  }
}

/**
 * Field-level diff with unchanged fields omitted.
 *
 * Per field: `before` absent means the field did not exist yet, `after` absent
 * means it was removed. Keys are sorted so the serialised diff is byte-stable
 * for a given change — an audit row that serialises differently on every write
 * cannot be used as evidence of anything.
 *
 * @param {object|null} before
 * @param {object|null} after
 * @returns {Record<string, {before?: unknown, after?: unknown}>}
 */
export function diffFields(before, after) {
  const from = requireObjectOrNull(before, 'before');
  const to = requireObjectOrNull(after, 'after');

  const names = new Set([...Object.keys(from ?? {}), ...Object.keys(to ?? {})]);
  const diff = {};
  for (const name of [...names].sort()) {
    const hadBefore = from !== null && Object.hasOwn(from, name);
    const hasAfter = to !== null && Object.hasOwn(to, name);
    if (hadBefore && hasAfter && isDeepEqual(from[name], to[name])) {
      continue;
    }
    const change = {};
    if (hadBefore) change.before = from[name];
    if (hasAfter) change.after = to[name];
    diff[name] = change;
  }
  return diff;
}

/**
 * Append one entry.
 *
 * Takes `before`/`after` and computes the diff here rather than accepting a
 * prepared one, so "unchanged fields are omitted" is enforced in exactly one
 * place and cannot be bypassed by a caller assembling its own.
 *
 * No try/catch anywhere on this path: if a guard trigger or a CHECK aborts the
 * write, that SqliteError is the answer and it must reach the caller intact.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   actorOpenId: string|null, actorDisplayName: string, actorKind?: string,
 *   verb: string, subject: {kind: string, id: string|null},
 *   before?: object|null, after?: object|null,
 *   consequence: string|null, succeeded: boolean, occurredAt?: string|Date
 * }} entry
 */
export function record(db, entry) {
  const source = requireObject(entry, 'entry');
  if ('diff' in source) {
    throw new TypeError('audit.record: pass before/after, not diff — the diff is computed here');
  }
  if ('correctsId' in source || 'correctionReason' in source) {
    throw new TypeError('audit.record: use recordCorrection() to append a correction');
  }
  return insertEntry(db, buildRow(source, null));
}

/**
 * Append a correction that supersedes an earlier entry.
 *
 * A correction is a new entry pointing at the old one; the original stays on
 * the log untouched and readers see both. The verb, subject and before/after
 * are what *should* have been recorded — this is a restatement, not a patch.
 *
 * `subject` defaults to the original's, since almost every correction concerns
 * the same thing; pass it explicitly when the original named the wrong subject.
 * The actor never defaults: whoever is correcting now is not necessarily who
 * acted then.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} correction record() fields plus correctsId and correctionReason
 */
export function recordCorrection(db, correction) {
  const source = requireObject(correction, 'correction');
  if ('diff' in source) {
    throw new TypeError('audit.recordCorrection: pass before/after, not diff');
  }
  const correctsId = requireString(source.correctsId, 'correctsId');
  const correctionReason = requireString(source.correctionReason, 'correctionReason');

  // A correction pointing at nothing is worse than no correction: it reads as
  // authoritative and cannot be reconciled against the log.
  const original = getEntry(db, correctsId);
  if (original === null) {
    throw new Error(`audit.recordCorrection: no entry with id ${correctsId} to correct`);
  }

  const subject = source.subject ?? original.subject;
  return insertEntry(db, buildRow({ ...source, subject }, { correctsId, correctionReason }));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @returns {object|null}
 */
export function getEntry(db, id) {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM ${AUDIT_TABLE} WHERE id = ?`)
    .get(requireString(id, 'id'));
  return row === undefined ? null : fromRow(row);
}

/**
 * Newest-first page of entries about one subject.
 *
 * Matches the audit_log_subject index, (subject_kind, subject_id, seq).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{subjectKind: string, subjectId: string|null, limit?: number, cursor?: string|null}} options
 * @returns {{entries: object[], nextCursor: string|null}}
 */
export function listBySubject(db, options = {}) {
  const subjectKind = requireString(options.subjectKind, 'subjectKind');
  const subjectId = options.subjectId ?? null;
  if (subjectId !== null && typeof subjectId !== 'string') {
    throw new TypeError('audit: subjectId must be a string or null');
  }
  // "IS" rather than "=", so a null subject_id is a value that can be selected
  // for instead of a hole that matches nothing.
  return queryPage(db, {
    clauses: ['subject_kind = @subjectKind', 'subject_id IS @subjectId'],
    bind: { subjectKind, subjectId },
    options
  });
}

/**
 * Newest-first page of entries by one actor.
 *
 * Filters on the open_id, never on the display name: the name is a snapshot of
 * what it was at write time, and two people can share one.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{actorOpenId: string, actorKind?: string, limit?: number, cursor?: string|null}} options
 * @returns {{entries: object[], nextCursor: string|null}}
 */
export function listByActor(db, options = {}) {
  const actorOpenId = requireString(options.actorOpenId, 'actorOpenId');
  const clauses = ['actor_id = @actorOpenId'];
  const bind = { actorOpenId };
  // The audit_log_actor index leads with actor_kind. An open_id is unique to
  // one kind in practice, so this is optional; passing it lets the query use
  // the index rather than scanning.
  if (options.actorKind !== undefined) {
    clauses.unshift('actor_kind = @actorKind');
    bind.actorKind = requireActorKind(options.actorKind);
  }
  return queryPage(db, { clauses, bind, options });
}

/**
 * Corrections appended against one entry. Without this a correction is
 * unfindable from the thing it corrects, which would make appending one
 * pointless.
 *
 * The link lives in the detail JSON, so this scans rather than seeking; a given
 * entry is corrected zero or one times in practice.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} entryId
 * @param {{limit?: number, cursor?: string|null}} [options]
 */
export function listCorrectionsOf(db, entryId, options = {}) {
  const correctsId = requireString(entryId, 'entryId');
  return queryPage(db, {
    clauses: ["json_extract(detail, '$.correctsId') = @correctsId"],
    bind: { correctsId },
    options
  });
}

/**
 * Prove the log is actually append-only, rather than assuming the triggers are
 * there. Throws naming the missing guard; returns silently when both hold.
 *
 * Everything happens inside a savepoint that is always rolled back, so the
 * probe cannot leave a row behind.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function verifyAppendOnly(db) {
  assertAuditSchema(db);

  const savepoint = 'audit_append_only_probe';
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    // The probe inserts its own row first, so that "no error" can only mean
    // "the trigger did not fire". An UPDATE matching zero rows also raises
    // nothing, so without this the check would report a missing guard against
    // any log that happens to be empty — which is the state it is in at install
    // time, exactly when this is worth running.
    const probe = record(db, {
      actorKind: 'system',
      actorOpenId: null,
      actorDisplayName: 'audit probe',
      verb: 'audit.probe',
      subject: { kind: 'audit-probe', id: randomUUID() },
      before: null,
      after: null,
      consequence: null,
      succeeded: true
    });

    expectBlocked(
      () => db.prepare(`UPDATE ${AUDIT_TABLE} SET action = 'tampered' WHERE id = ?`).run(probe.id),
      'UPDATE'
    );
    expectBlocked(
      () => db.prepare(`DELETE FROM ${AUDIT_TABLE} WHERE id = ?`).run(probe.id),
      'DELETE'
    );
  } finally {
    db.exec(`ROLLBACK TO ${savepoint}`);
    db.exec(`RELEASE ${savepoint}`);
  }
}

function expectBlocked(attempt, statement) {
  try {
    attempt();
  } catch (error) {
    // Only a constraint failure counts as "blocked". Accepting any error would
    // let a structural refusal stand in for a guard — an audit_log replaced by
    // a view rejects UPDATE too, while its backing table stays wide open.
    if (typeof error?.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT')) {
      return;
    }
    throw error;
  }
  throw new Error(
    `audit: ${AUDIT_TABLE} accepted a ${statement}; the append-only trigger is missing or disabled`
  );
}

function insertEntry(db, row) {
  db.prepare(INSERT_SQL).run(row);
  return fromRow(row);
}

function buildRow(source, correction) {
  const subject = requireObject(source.subject, 'subject');
  const actorKind = requireActorKind(source.actorKind ?? 'owner');

  // consequence and succeeded must be stated, never defaulted: a missing
  // consequence handle and a wrongly-assumed success are the two ways this log
  // records a confident falsehood. before/after do default to null, because
  // "this action changed no fields" is a real and unambiguous case.
  if (!('consequence' in source)) {
    throw new TypeError('audit: consequence is required (pass null when there is none)');
  }
  if (typeof source.succeeded !== 'boolean') {
    throw new TypeError('audit: succeeded must be a boolean');
  }

  const before = requireObjectOrNull(source.before ?? null, 'before');
  const after = requireObjectOrNull(source.after ?? null, 'after');
  const consequence =
    source.consequence === null ? null : requireString(source.consequence, 'consequence');

  // Only a system action is allowed to have no actor. The table's own CHECK
  // enforces this for submitters; an owner action without an open_id is
  // likewise an entry that cannot be attributed to anyone.
  const actorOpenId =
    actorKind === 'system' && (source.actorOpenId ?? null) === null
      ? null
      : requireString(source.actorOpenId, 'actorOpenId');

  const subjectId = subject.id ?? null;
  if (subjectId !== null && (typeof subjectId !== 'string' || subjectId.length === 0)) {
    throw new TypeError('audit: subject.id must be a non-empty string or null');
  }

  // Key order is fixed and diffFields sorts its own, so the same change always
  // serialises to the same bytes.
  const detail = {
    actorDisplayName: requireString(source.actorDisplayName, 'actorDisplayName'),
    succeeded: source.succeeded,
    consequence,
    diff: diffFields(before, after)
  };
  if (correction !== null) {
    detail.correctsId = correction.correctsId;
    detail.correctionReason = correction.correctionReason;
  }

  return {
    id: randomUUID(),
    at: normalizeTimestamp(source.occurredAt),
    actor_kind: actorKind,
    actor_id: actorOpenId,
    action: requireString(source.verb, 'verb'),
    subject_kind: requireString(subject.kind, 'subject.kind'),
    subject_id: subjectId,
    detail: JSON.stringify(detail)
  };
}

function fromRow(row) {
  // The table guarantees detail is valid JSON, not that it is this envelope. A
  // row written by something that does not share this contract should be loud,
  // not silently reported as a successful action with no changes.
  let detail;
  try {
    detail = JSON.parse(row.detail);
  } catch {
    throw new Error(`audit: entry ${row.id} has an unreadable detail payload`);
  }
  if (detail === null || typeof detail !== 'object' || typeof detail.succeeded !== 'boolean') {
    throw new Error(`audit: entry ${row.id} does not carry an audit detail envelope`);
  }

  return {
    id: row.id,
    occurredAt: row.at,
    actorKind: row.actor_kind,
    actorOpenId: row.actor_id,
    actorDisplayName: detail.actorDisplayName,
    verb: row.action,
    subject: { kind: row.subject_kind, id: row.subject_id },
    diff: detail.diff ?? {},
    consequence: detail.consequence ?? null,
    succeeded: detail.succeeded,
    correctsId: detail.correctsId ?? null,
    correctionReason: detail.correctionReason ?? null
  };
}

function queryPage(db, { clauses, bind, options }) {
  const limit = resolveLimit(options.limit);
  const where = [...clauses];
  const params = { ...bind };

  if (options.cursor !== undefined && options.cursor !== null) {
    // Keyset, not OFFSET: entries are appended while someone is paging, and an
    // offset would shift every unread page by one each time that happens.
    where.push('seq < @cursorSeq');
    params.cursorSeq = decodeCursor(options.cursor);
  }

  // Ordered by seq, not by `at`. schema.sql constrains `at` to whole seconds,
  // so timestamps tie routinely and any tiebreak on the random uuid would show
  // same-second entries in an order unrelated to what happened. seq is
  // AUTOINCREMENT, so it is the append order and a value is never reused.
  const sql = `
    SELECT ${SELECT_COLUMNS} FROM ${AUDIT_TABLE}
    WHERE ${where.join(' AND ')}
    ORDER BY seq DESC
    LIMIT @limit
  `;

  // One row past the page answers "is there more" without a second COUNT query
  // that could disagree with this one.
  const rows = db.prepare(sql).all({ ...params, limit: limit + 1 });
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1]) : null;

  return { entries: page.map(fromRow), nextCursor };
}

function resolveLimit(limit) {
  if (limit === undefined) return AUDIT_DEFAULT_PAGE_SIZE;
  // Not clamped: a caller asking for 10000 has a wrong expectation, and quietly
  // handing back 200 would look like the log only holds 200 entries.
  if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_MAX_PAGE_SIZE) {
    throw new RangeError(`audit: limit must be an integer in 1..${AUDIT_MAX_PAGE_SIZE}`);
  }
  return limit;
}

// Opaque on purpose. seq is an autoincrementing integer, which the project's id
// convention keeps off the wire, and schema.sql says the same — so it travels
// encoded rather than as a bare row number a caller could count with.
function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ s: row.seq }), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new TypeError('audit: cursor must be a non-empty string');
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new TypeError('audit: malformed cursor');
  }
  // A cursor that decodes to the wrong shape would silently drop the keyset
  // predicate and restart the caller at page one.
  if (parsed === null || typeof parsed !== 'object' || !Number.isInteger(parsed.s)) {
    throw new TypeError('audit: malformed cursor');
  }
  return parsed.s;
}

function normalizeTimestamp(value) {
  const iso = toIsoString(value);
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`audit: occurredAt is not a real instant: ${iso}`);
  }
  const normalized = parsed.toISOString();
  // V8 rolls an out-of-range day over instead of rejecting it: '2026-02-30Z'
  // parses cleanly as March 2nd. Storing a date two days from the one the
  // caller wrote is the one thing this column must never do, so the calendar
  // fields have to survive the round trip. ISO_UTC already fixed their offsets,
  // so comparing the leading 'YYYY-MM-DDTHH:mm:ss' is exact.
  if (normalized.slice(0, 19) !== iso.slice(0, 19)) {
    throw new TypeError(`audit: occurredAt is not a real instant: ${iso}`);
  }
  // Truncated to whole seconds, because schema.sql CHECKs `at` against a GLOB
  // with no fractional part — a millisecond here is rejected by the table.
  // Ordering does not depend on this string; see queryPage.
  return `${normalized.slice(0, 19)}Z`;
}

function toIsoString(value) {
  if (value === undefined || value === null) {
    return new Date().toISOString();
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError('audit: occurredAt is an invalid Date');
    }
    return value.toISOString();
  }
  if (typeof value !== 'string' || !ISO_UTC.test(value)) {
    throw new TypeError('audit: occurredAt must be an ISO-8601 UTC string ending in Z');
  }
  return value;
}

function requireActorKind(value) {
  if (!AUDIT_ACTOR_KINDS.includes(value)) {
    throw new TypeError(`audit: actorKind must be one of ${AUDIT_ACTOR_KINDS.join(', ')}`);
  }
  return value;
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`audit: ${field} must be a non-empty string`);
  }
  return value;
}

function requireObject(value, field) {
  if (!isPlainObject(value)) {
    throw new TypeError(`audit: ${field} must be an object`);
  }
  return value;
}

function requireObjectOrNull(value, field) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) {
    throw new TypeError(`audit: ${field} must be an object or null`);
  }
  return value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isDeepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => isDeepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && isDeepEqual(a[key], b[key]))
    );
  }
  // Anything else (Date, class instance) compares unequal unless identical, so
  // it shows up as a change rather than being silently treated as unchanged.
  // Field values are ISO strings and JSON scalars by contract; a Date here is a
  // caller bug worth seeing in the diff.
  return false;
}
