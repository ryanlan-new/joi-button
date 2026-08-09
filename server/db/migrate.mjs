// Schema application for the submission API's SQLite database.
//
// This module never opens a database.  It is handed a better-sqlite3 Database
// instance and a plain config object, both by the caller, so that the process
// keeps exactly one connection-owner and tests can hand over a throwaway file.
//
// Nothing runs at import time — schema.sql is read inside migrate(), not beside
// it, so importing this module has no cost and touches no disk.

import { readFileSync } from 'node:fs';

/** Version this code writes.  Bump on every schema change. */
export const SCHEMA_VERSION = 7;

/**
 * Oldest catalogue parser that can still read a document produced at
 * SCHEMA_VERSION.  Bump ONLY for a change that breaks older readers: a tab left
 * open across a deploy is running a JS chunk cached `immutable` for a year, and
 * it decides whether to reload by comparing itself against this number.
 */
export const MIN_COMPATIBLE_SCHEMA_VERSION = 1;

/**
 * schema.sql uses STRICT tables (3.37) and calls json_valid(), which is only
 * built in unconditionally from 3.38.  Checked at runtime because the SQLite
 * that matters is the one compiled into whichever better-sqlite3 is installed,
 * not the one on the developer's PATH.
 */
export const REQUIRED_SQLITE_VERSION = '3.38.0';

/**
 * Changes that came after the baseline.  schema.sql is written with
 * CREATE ... IF NOT EXISTS throughout, which makes re-applying it a no-op — but
 * that also means it cannot alter a table that already exists.  So a v2 that,
 * say, adds a column does two things: it edits schema.sql (for fresh databases)
 * AND appends { version: 2, sql: 'ALTER TABLE ... ADD COLUMN ...' } here (for
 * existing ones).  Steps run in order, once each, inside the same transaction
 * as the baseline.
 *
 * They do NOT run on a database that had no schema at all: schema.sql already
 * describes the current shape, so a fresh database is born at SCHEMA_VERSION
 * and an ALTER TABLE on top of it would fail on a column that is already there.
 */
export const POST_BASELINE_STEPS = [
    {
        version: 2,
        // The theme wallpaper (JOI-BUTTON-STORY-034/035).  The CHECK is repeated
        // from the baseline verbatim; SQLite enforces an ADD COLUMN check on new
        // writes only, which is fine — the column is born NULL everywhere.
        // MIN_COMPATIBLE stays 1: catalogue readers are untouched by a themes
        // column, and src/catalog.mjs only refuses when minCompatibleVersion
        // exceeds what it knows.
        sql: `ALTER TABLE themes ADD COLUMN wallpaper_path TEXT
              CHECK (wallpaper_path IS NULL OR (
                     (wallpaper_path GLOB '*.png' OR wallpaper_path GLOB '*.jpg' OR wallpaper_path GLOB '*.webp')
                 AND substr(wallpaper_path, 1, 64) NOT GLOB '*[^0-9a-f]*'
                 AND substr(wallpaper_path, 65, 1) = '.'
                 AND length(wallpaper_path) <= 69));`,
    },
    {
        version: 3,
        // The natural-language challenge (lib/challenge-phrase.mjs). `code` stays
        // the internal A-Z0-9 handle its CHECK still requires; this holds the
        // phrase the visitor actually posts and the matcher compares against.
        // Nullable because ADD COLUMN cannot backfill NOT NULL, and older rows
        // (and the dev-bypass path, which never posts a danmaku) have none; the
        // route sets it on every real code. The UNIQUE INDEX gives the same
        // "one live phrase resolves to exactly one code" guarantee `code UNIQUE`
        // gives the handle — SQLite lets the many historical NULLs coexist under
        // a UNIQUE index. MIN_COMPATIBLE stays 1: a catalogue reader never looks
        // at verify_codes.
        sql: `ALTER TABLE verify_codes ADD COLUMN challenge_text TEXT
                CHECK (challenge_text IS NULL OR (length(challenge_text) BETWEEN 4 AND 40));
              CREATE UNIQUE INDEX IF NOT EXISTS verify_codes_challenge ON verify_codes (challenge_text);`,
    },
    {
        version: 4,
        // Online admin identity (JOI-BUTTON-STORY-053). Two brand-new tables, so
        // this is pure CREATE — no ALTER, no dependency on re-running schema.sql
        // first, and CREATE TABLE/INDEX IF NOT EXISTS is idempotent on the fresh
        // path where schema.sql already made them. The definitions are copied
        // verbatim from schema.sql so an upgraded database and a fresh one carry
        // byte-identical tables; migrate-v2.test.mjs's strip-and-replay guards
        // that they cannot drift.
        sql: `
          CREATE TABLE IF NOT EXISTS admins (
              open_id       TEXT NOT NULL PRIMARY KEY,
              display_name  TEXT NOT NULL,
              invited_by    TEXT NOT NULL,
              invited_at    TEXT NOT NULL,
              revoked_at    TEXT,
              CHECK (open_id <> ''),
              CHECK (display_name <> ''),
              CHECK (invited_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
              CHECK (revoked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z')
          ) STRICT;
          CREATE INDEX IF NOT EXISTS admins_active ON admins (revoked_at);
          CREATE TABLE IF NOT EXISTS admin_invites (
              id                     TEXT NOT NULL PRIMARY KEY,
              challenge_text         TEXT NOT NULL UNIQUE,
              room_id                INTEGER NOT NULL,
              created_by             TEXT NOT NULL,
              state                  TEXT NOT NULL DEFAULT 'pending'
                                          CHECK (state IN ('pending', 'claimed', 'confirmed', 'expired', 'cancelled')),
              issued_at              TEXT NOT NULL,
              expires_at             TEXT NOT NULL,
              closed_at              TEXT,
              observed_open_id       TEXT,
              observed_display_name  TEXT,
              claimed_at             TEXT,
              confirmed_at           TEXT,
              CHECK (id <> '' AND id NOT GLOB '*[^a-z0-9_-]*'),
              CHECK (length(challenge_text) BETWEEN 4 AND 40),
              CHECK (room_id > 0),
              CHECK (created_by <> ''),
              CHECK (issued_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
              CHECK (expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
              CHECK (expires_at > issued_at),
              CHECK ((state IN ('pending', 'claimed')) = (closed_at IS NULL)),
              CHECK (state NOT IN ('claimed', 'confirmed') OR observed_open_id IS NOT NULL),
              CHECK ((state = 'confirmed') = (confirmed_at IS NOT NULL))
          ) STRICT;
          CREATE INDEX IF NOT EXISTS admin_invites_pending ON admin_invites (state, expires_at);`,
    },
    {
        version: 5,
        // Media reclamation (JOI-BUTTON-STORY-077).  collected_at marks a blob
        // whose bytes the sweep has removed from the PVC while keeping its row —
        // batch_items and clips reference media ON DELETE RESTRICT, so the row
        // cannot go.  NULL = present.  The CHECK is repeated from the baseline
        // verbatim; SQLite enforces an ADD COLUMN check on new writes only, which
        // is fine — the column is born NULL everywhere.  MIN_COMPATIBLE stays 1:
        // a catalogue reader never looks at media.collected_at.
        sql: `ALTER TABLE media ADD COLUMN collected_at TEXT
                CHECK (collected_at IS NULL OR collected_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z');`,
    },
    {
        version: 6,
        // Clip provenance plus the legacy credit_hidden column. All provenance
        // is nullable because it is descriptive metadata, never a publish gate;
        // the legacy column remains for already-migrated databases but is no
        // longer used to suppress a non-empty submitter name from the catalogue.
        // The fresh schema carries the same definitions; these ALTERs are for
        // databases that were already stamped before INIT-002.
        sql: `
          ALTER TABLE clips ADD COLUMN source_kind TEXT
            CHECK (source_kind IS NULL OR source_kind IN ('video', 'stream'));
          ALTER TABLE clips ADD COLUMN source_title TEXT
            CHECK (source_title IS NULL OR (
              length(source_title) <= 200
              AND instr(source_title, char(10)) = 0
              AND instr(source_title, char(13)) = 0));
          ALTER TABLE clips ADD COLUMN source_date TEXT
            CHECK (source_date IS NULL OR source_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
          ALTER TABLE clips ADD COLUMN source_seconds INTEGER
            CHECK (source_seconds IS NULL OR source_seconds >= 0);
          ALTER TABLE clips ADD COLUMN source_url TEXT
            CHECK (source_url IS NULL OR (
              length(source_url) <= 2048
              AND (source_url GLOB 'http://*' OR source_url GLOB 'https://*')
              AND length(source_url) > 7));
          ALTER TABLE clips ADD COLUMN credit_hidden INTEGER NOT NULL DEFAULT 0
            CHECK (credit_hidden IN (0, 1));
        `,
    },
    {
        version: 7,
        // API credentials share the sessions table so batches.session_id and
        // verify_codes.session_id remain one continuous audit chain. Existing
        // rows are browser sessions by default; the API-only fields are nullable
        // and do not change their meaning.
        sql: `
          ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'cookie'
            CHECK (kind IN ('cookie', 'api'));
          ALTER TABLE sessions ADD COLUMN client_label TEXT
            CHECK (client_label IS NULL OR kind = 'api');
          ALTER TABLE sessions ADD COLUMN last_used_at TEXT
            CHECK (last_used_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z');
          ALTER TABLE sessions ADD COLUMN token_issued_at TEXT
            CHECK (token_issued_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z');
        `,
    },
];

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * The one timestamp format this schema accepts: second-precision UTC, no
 * fractional part, e.g. '2026-07-31T12:00:00Z'.  Every timestamp column CHECKs
 * it, so that string ordering is chronological ordering — which is what the
 * `expires_at > :now` comparisons rely on.
 *
 * Note that Date#toISOString() emits milliseconds and would fail those CHECKs;
 * truncating here rather than in each caller is the point of this function.
 * Epoch numbers are refused outright: an accidental Date.now() would otherwise
 * be stored as a plausible-looking string in one place and a number nowhere
 * else in the schema.
 */
export function toCanonicalTimestamp(value = new Date()) {
    if (typeof value === 'number') {
        throw new TypeError('toCanonicalTimestamp: times are ISO-8601 UTC strings, not epoch numbers');
    }
    if (typeof value === 'string') {
        if (!TIMESTAMP_PATTERN.test(value)) {
            throw new TypeError(`toCanonicalTimestamp: not canonical UTC seconds: ${value}`);
        }
        return value;
    }
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        throw new TypeError('toCanonicalTimestamp: expected a Date or a canonical timestamp string');
    }
    return `${value.toISOString().slice(0, 19)}Z`;
}

/**
 * Pragmas that are NOT in schema.sql, because they cannot be.
 *
 *   journal_mode = WAL  is persisted in the database file header, so it only
 *     has to succeed once — but it cannot be set inside a transaction, and
 *     migrate() applies the schema inside one.  WAL needs an -shm file, so
 *     exactly one process may hold this database open; the web pod mounts the
 *     PVC read-only and reads catalog.json and the media blobs, never this file.
 *
 *   foreign_keys = ON   is per-connection and defaults OFF.  A connection that
 *     skips this gets a database where every REFERENCES clause is a comment,
 *     which is why it must be called for EVERY connection and not just at
 *     migration time.
 *
 *   busy_timeout        is per-connection.  Without it a concurrent reader
 *     fails immediately with SQLITE_BUSY instead of waiting for the writer.
 *
 *   synchronous = NORMAL is the WAL-appropriate setting: durable across a
 *     process crash, and at risk only of losing the last transaction on a host
 *     power loss.  Overridable through config for a deployment that would
 *     rather pay for FULL.
 */
export function applyConnectionPragmas(db, config = {}) {
    const busyTimeoutMs = config.busyTimeoutMs ?? 5000;
    const synchronous = config.synchronous ?? 'NORMAL';

    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs <= 0) {
        throw new TypeError(`applyConnectionPragmas: busyTimeoutMs must be a positive integer, got ${busyTimeoutMs}`);
    }
    if (!/^(OFF|NORMAL|FULL|EXTRA)$/i.test(synchronous)) {
        throw new TypeError(`applyConnectionPragmas: unknown synchronous mode ${synchronous}`);
    }
    if (db.inTransaction) {
        throw new Error('applyConnectionPragmas: must run outside a transaction, or journal_mode and foreign_keys silently do nothing');
    }

    const journalMode = db.pragma('journal_mode = WAL', { simple: true });
    db.pragma('foreign_keys = ON');
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    db.pragma(`synchronous = ${synchronous}`);

    return {
        journalMode,
        foreignKeys: db.pragma('foreign_keys', { simple: true }) === 1,
        busyTimeoutMs: db.pragma('busy_timeout', { simple: true }),
    };
}

/**
 * Reads the pragmas back rather than trusting that setting them worked.  A
 * PRAGMA issued inside a transaction, or against a database another process
 * already opened in a different journal mode, is a silent no-op — the only way
 * to know is to ask.
 *
 * An in-memory database reports journal_mode 'memory' and can never be 'wal';
 * that is accepted so tests can run, and it is the one exemption.
 */
export function assertConnectionPragmas(db) {
    const journalMode = String(db.pragma('journal_mode', { simple: true })).toLowerCase();
    const inMemory = db.memory === true || journalMode === 'memory';

    if (!inMemory && journalMode !== 'wal') {
        throw new Error(`database is in journal_mode '${journalMode}', expected 'wal' (see applyConnectionPragmas)`);
    }
    if (db.pragma('foreign_keys', { simple: true }) !== 1) {
        throw new Error('foreign_keys is OFF on this connection: every REFERENCES clause in the schema is inert');
    }
    if (db.pragma('busy_timeout', { simple: true }) <= 0) {
        throw new Error('busy_timeout is 0: a concurrent writer will make readers fail instead of wait');
    }
}

/** Current version in the database, or 0 if the schema has never been applied. */
export function readSchemaVersion(db) {
    const stamp = readSchemaStamp(db);
    return stamp === null ? 0 : stamp.version;
}

/**
 * The version pair the catalogue document carries.  Null when the schema has
 * never been applied.
 */
export function readSchemaStamp(db) {
    const present = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'",
    ).get();
    if (!present) return null;

    const row = db.prepare(
        'SELECT version, min_compatible_version, applied_at FROM schema_version WHERE id = 1',
    ).get();
    if (!row) return null;

    return {
        version: row.version,
        minCompatibleVersion: row.min_compatible_version,
        appliedAt: row.applied_at,
    };
}

/** Deployment mode recorded in the database, or null before the first migrate. */
export function readInstanceMode(db) {
    const present = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'instance'",
    ).get();
    if (!present) return null;
    const row = db.prepare('SELECT mode FROM instance WHERE id = 1').get();
    return row ? row.mode : null;
}

/**
 * Applies schema.sql and any post-baseline steps, records the version, and
 * records the deployment mode.
 *
 * Idempotent: running it twice on the same database changes nothing and reports
 * applied: false.
 *
 * Refuses to run backwards: a database stamped newer than SCHEMA_VERSION is
 * left untouched.  Rolling back a deploy must not let the previous release's
 * schema.sql loose on a database the newer release already changed — the older
 * file cannot know what to undo, and its CREATE ... IF NOT EXISTS statements
 * would quietly reinstate objects the newer version had dropped.
 *
 * config:
 *   mode           'production' | 'development'.  Defaults to 'production',
 *                  because the failure of guessing wrong is one-directional:
 *                  a development database wrongly marked production only
 *                  refuses bypasses, while the reverse enables them on a live
 *                  site.  Written into `instance`, which the bypass triggers
 *                  in schema.sql consult.
 *   now            canonical timestamp string or Date, for a deterministic test.
 *   schemaPath     override for schema.sql.
 *   busyTimeoutMs, synchronous — see applyConnectionPragmas.
 */
export function migrate(db, config = {}) {
    const mode = config.mode ?? 'production';
    if (mode !== 'production' && mode !== 'development') {
        throw new TypeError(`migrate: unknown mode ${JSON.stringify(mode)}`);
    }
    if (db.inTransaction) {
        throw new Error('migrate: must be called outside a transaction');
    }

    assertSqliteVersion(db);
    applyConnectionPragmas(db, config);
    assertConnectionPragmas(db);

    const appliedAt = toCanonicalTimestamp(config.now ?? new Date());
    const from = readSchemaVersion(db);

    if (from > SCHEMA_VERSION) {
        throw new Error(
            `migrate: database is at schema_version ${from}, this build only knows ${SCHEMA_VERSION}; refusing to run backwards`,
        );
    }

    const schemaPath = config.schemaPath ?? new URL('./schema.sql', import.meta.url);
    const schemaSql = readFileSync(schemaPath, 'utf8');
    const steps = from === 0
        ? []
        : POST_BASELINE_STEPS
            .filter((step) => step.version > from && step.version <= SCHEMA_VERSION)
            .sort((a, b) => a.version - b.version);

    // One transaction: a half-applied schema with a stamped version would be
    // worse than no schema at all, because the next run would believe it.
    db.transaction(() => {
        db.exec(schemaSql);
        for (const step of steps) db.exec(step.sql);

        db.prepare(`
            INSERT INTO schema_version (id, version, min_compatible_version, applied_at)
            VALUES (1, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET
                version = excluded.version,
                min_compatible_version = excluded.min_compatible_version,
                applied_at = excluded.applied_at
        `).run(SCHEMA_VERSION, MIN_COMPATIBLE_SCHEMA_VERSION, appliedAt);

        recordInstanceMode(db, mode, appliedAt);
    })();

    // Cheap here (this database is small by construction) and it catches the
    // one class of damage a migration can do while foreign_keys was off on some
    // other connection: rows pointing at parents that are gone.
    const violations = db.pragma('foreign_key_check');
    if (violations.length > 0) {
        throw new Error(`migrate: foreign key violations after migration: ${JSON.stringify(violations)}`);
    }

    return {
        from,
        to: SCHEMA_VERSION,
        minCompatibleVersion: MIN_COMPATIBLE_SCHEMA_VERSION,
        applied: from !== SCHEMA_VERSION,
        mode: readInstanceMode(db),
        appliedAt,
    };
}

function recordInstanceMode(db, mode, appliedAt) {
    const current = db.prepare('SELECT mode FROM instance WHERE id = 1').get();

    if (!current) {
        db.prepare('INSERT INTO instance (id, mode, created_at) VALUES (1, ?, ?)').run(mode, appliedAt);
        return;
    }
    if (current.mode === mode) return;

    try {
        db.prepare('UPDATE instance SET mode = ? WHERE id = 1').run(mode);
    } catch (cause) {
        // instance_mode_ratchet fired.  Say what was actually attempted, because
        // the trigger only knows the values, not that a config file asked for it.
        throw new Error(
            `migrate: this database is marked '${current.mode}' and cannot be re-marked '${mode}'; ` +
            'the development bypasses are not available on a production database',
            { cause },
        );
    }
}

function assertSqliteVersion(db) {
    const actual = db.prepare('SELECT sqlite_version() AS v').get().v;
    if (compareVersions(actual, REQUIRED_SQLITE_VERSION) < 0) {
        throw new Error(
            `migrate: SQLite ${actual} is too old; schema.sql needs >= ${REQUIRED_SQLITE_VERSION} for STRICT tables and json_valid()`,
        );
    }
}

function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}
