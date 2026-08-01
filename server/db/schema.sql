-- joi-button submission API — baseline schema (schema_version 1).
--
-- This database is the SOLE AUTHORITY for the published catalogue.  Nothing is
-- reconstructed from GitHub, from the PVC, or from src/voices.json; those are
-- outputs or historical inputs.  If a fact is not in here, it is not published.
--
-- ============================================================================
-- PRAGMAS — where each one is set, and why not here
-- ============================================================================
-- This file sets NO pragmas, deliberately:
--
--   journal_mode = WAL   Persisted in the database file header, so it survives
--                        every reopen and only has to be set once.  It cannot
--                        be set from inside a transaction, and migrate.mjs runs
--                        this file inside one — so it is set by
--                        applyConnectionPragmas() in migrate.mjs before the
--                        transaction opens.  WAL needs a shared-memory (-shm)
--                        file, so exactly ONE pod may open this database.  That
--                        holds today: the web pod mounts the PVC read-only and
--                        reads catalog.json and the media blobs, never this file.
--
--   foreign_keys = ON    PER-CONNECTION and NOT persisted; SQLite defaults it
--                        OFF for backwards compatibility.  A connection that
--                        forgets it gets a database where every REFERENCES
--                        clause below is decoration.  So it is set by
--                        applyConnectionPragmas() on EVERY connection, and
--                        migrate() refuses to run when it reads back off.
--
--   busy_timeout         PER-CONNECTION, value comes from the config object.
--                        Set in applyConnectionPragmas().  Without it a writer
--                        holding the lock makes a concurrent reader fail
--                        instantly with SQLITE_BUSY instead of waiting.
--
-- Every table is STRICT: without it SQLite would happily store the string
-- 'notanumber' in an INTEGER column.  Requires SQLite >= 3.37; migrate.mjs
-- checks the runtime version before it gets here.
--
-- ============================================================================
-- TIMESTAMPS
-- ============================================================================
-- One canonical form, checked on every timestamp column:
--
--     YYYY-MM-DDTHH:MM:SSZ        e.g. 2026-07-31T12:00:00Z
--
-- Second precision, UTC, no offset, no fractional part.  The point is that
-- lexicographic string order equals chronological order, which is what every
-- `expires_at > :now` comparison in this schema relies on; allowing an optional
-- '.000' would break that, because '.' sorts before 'Z' so
-- '…T12:00:00.000Z' < '…T12:00:00Z' for the same instant.
--
-- Note that Date#toISOString() emits milliseconds and therefore FAILS these
-- checks by design.  Use toCanonicalTimestamp() from migrate.mjs.
--
-- ============================================================================
-- TEXT THAT REACHES vue-i18n
-- ============================================================================
-- Captions and labels are compiled into VueI18n messages, which give three
-- characters syntactic meaning: `{foo}` is named interpolation, `@:key` (and
-- `@.modifier:key`) is a linked message, and `|` separates plural forms.  A
-- submitter writing "100% | done" would not produce that text on the page; it
-- would produce a plural rule with two branches.
--
-- The gate on the way in is server/lib/text-safety.mjs, which rejects linked
-- messages outright and neutralises braces and pipes by substituting fullwidth
-- look-alikes (U+FF5B/FF5D/FF5C, and U+FF20 for the '@' of a linked message it
-- is escaping rather than refusing).  None of those substitutes is the ASCII
-- character these constraints test for, which is what lets a backstop and a
-- sanitiser share one rule.  The constraints below are that backstop, for a
-- write path that skips the gate.
--
-- They are deliberately calibrated to accept everything escapeForI18n can emit,
-- because a backstop that refuses the sanctioned pipeline's own output is not a
-- backstop, it is an outage.  Most of the shape below follows from that:
--
--   * vue-i18n's trigger is one regex — linkKeyMatcher, src/index.js:27 of the
--     installed 8.21.1:
--         /(?:@(?:\.[a-z]+)?:(?:[\w\-_|.]+|\([\w\-_|.]+\)))/
--     The modifier is ADJACENT to both the dot and the colon.  So the test is
--     '@:' by instr, plus '@.' + N letters + ':' as a GLOB, one N at a time:
--     SQLite has no regex and GLOB has no bounded repetition, so the ladder is
--     written out, N = 1..12.
--   * The single pattern '*@.[a-zA-Z]*:*' reads like the same rule and is not.
--     Its '*' spans the whole rest of the string, so ANY '@.' plus ANY later
--     ':' matches: it refused 'Joi@.jp 11:00 開始', which passes
--     validateCaption and which escapeForI18n returns byte-identical.  That is
--     the outage described above; it is why adjacency is spelled out the long
--     way rather than approximated.
--   * N = 12 is a stated ceiling, not a proof.  It covers every modifier
--     vue-i18n defines (upper, lower, capitalize — 10 characters at most) with
--     headroom, and an UNREGISTERED modifier still links (index.js only applies
--     a modifier it knows; the substitution happens either way), so
--     '@.<13 letters>:key' would pass here.  The unbounded check is
--     validateCaption's regex.  A backstop that says where it stops is worth
--     more than one that implies it does not.
--   * A bare '@.' is NOT blocked — "Joi@.com" is valid prose, it passes
--     validateCaption, and it is stored verbatim.
--   * The length cap here (200) is deliberately looser than
--     CAPTION_MAX_LENGTH (80).  That limit is a product decision about
--     submissions; this one only has to stop a caption large enough to bloat
--     catalog.json, and admin-authored translations do not necessarily pass
--     through validateCaption.
--
-- No text column is exempt.  submitters.display_name — a Bilibili nickname we
-- observe, not text anyone authored for us — used to be, on the reasoning that
-- refusing it would break identity verification for a user whose nickname
-- contains '|'.  The hole in that: the name is rendered into a credit line
-- through vue-i18n, so a nickname of '@:info.notOfficial' reads a different
-- message into the page.  Both halves are the remedy, and they are not
-- alternatives — the danmaku source escapes the observed name with
-- escapeForI18n, which SUBSTITUTES rather than rejects so the nickname still
-- verifies, and the column refuses the raw form for the day that stops
-- happening.
--
-- ============================================================================
-- IDS
-- ============================================================================
-- Ids are opaque strings from crypto.randomUUID().  The charset check on
-- groups.id and clips.id is not cosmetic: those ids ARE the vue-i18n keys, and
-- vue-i18n resolves a key as a PATH — '.' and '[]' are separators.  An id
-- containing a dot would silently resolve to a nested lookup that misses, and
-- the page would render the raw key path.  A UUID contains only [0-9a-f-] and
-- passes.


-- ---------------------------------------------------------------------------
-- locales — the controlled vocabulary of language codes.
--
-- A table rather than a CHECK list because a fourth language must be one INSERT,
-- not a migration.  It exists mainly so a typo ('en-us', 'zh_CN') is a foreign
-- key failure instead of a caption row that no page will ever read.
--
-- is_ui_default marks what main.js falls back to when navigator.language
-- matches nothing.  It is NOT a translation fallback: VueI18n is constructed
-- with no fallbackLocale, so a clip with no caption in the visitor's locale
-- renders the raw key path.  That is why captions are rows and never empty
-- strings — see clip_captions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS locales (
    code        TEXT    NOT NULL PRIMARY KEY,
    label       TEXT    NOT NULL,            -- endonym, shown in the language menu
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_ui_default INTEGER NOT NULL DEFAULT 0 CHECK (is_ui_default IN (0, 1)),

    CHECK (code GLOB '[a-z][a-z]-[A-Z][A-Z]')
) STRICT;

-- At most one default: a unique index over the rows where is_ui_default = 1
-- refuses a second one, and says nothing about there being a first.  Zero
-- defaults is a state this index permits — the seed below is what makes en-US
-- the default, and a DELETE or an UPDATE to 0 would leave main.js with no
-- fallback and no complaint from here.
CREATE UNIQUE INDEX IF NOT EXISTS locales_one_ui_default
    ON locales (is_ui_default) WHERE is_ui_default = 1;

INSERT OR IGNORE INTO locales (code, label, sort_order, is_ui_default) VALUES
    ('en-US', 'English',  1, 1),
    ('zh-CN', '简体中文', 2, 0),
    ('ja-JP', '日本語',   3, 0);


-- ---------------------------------------------------------------------------
-- groups — what src/voices.json calls a category.
--
-- id is immutable and is the i18n key.  display_name is what the reviewer sees
-- and may rename freely; the ruling that keys must not be submitter-chosen text
-- is exactly this separation.  Renaming a group must not orphan its captions,
-- and here it cannot, because the captions hang off id.
--
-- Retiring is not deleting: /voices/ is served with `immutable` for a year, so
-- a browser that cached a clip keeps playing it regardless of what this table
-- says.  A retired group therefore has to stay resolvable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS groups (
    id            TEXT    NOT NULL PRIMARY KEY,
    display_name  TEXT    NOT NULL,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    state         TEXT    NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'retired')),
    created_at    TEXT    NOT NULL,
    retired_at    TEXT,

    CHECK (id <> '' AND length(id) <= 64 AND id NOT GLOB '*[^a-z0-9_-]*'),
    CHECK (display_name <> '' AND length(display_name) <= 120),
    -- display_name can surface as a fallback label in the admin UI and in
    -- catalog.json; see the vue-i18n note in the header for why the linked
    -- message ladder is written adjacency-first and where it stops.
    CHECK (instr(display_name, '{') = 0 AND instr(display_name, '}') = 0
       AND instr(display_name, '|') = 0
       AND instr(display_name, '@:') = 0
       AND display_name NOT GLOB '*@.[a-zA-Z]:*'
       AND display_name NOT GLOB '*@.[a-zA-Z][a-zA-Z]:*'
       AND display_name NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND display_name NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND display_name NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND display_name NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND display_name NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND display_name NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND display_name NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND display_name NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND display_name NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND display_name NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'),
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (retired_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    -- One fact, one column: a boolean flag plus a separate timestamp can
    -- disagree, and then nobody knows which is true.
    CHECK ((state = 'retired') = (retired_at IS NOT NULL))
) STRICT;

-- Two live groups with the same visible name are indistinguishable in the
-- admin UI, which is how a reviewer files a clip under the wrong one.  Retired
-- groups are excluded so a name can be reused after retirement.
CREATE UNIQUE INDEX IF NOT EXISTS groups_active_display_name
    ON groups (display_name COLLATE NOCASE) WHERE state = 'active';

CREATE INDEX IF NOT EXISTS groups_order ON groups (sort_order, id);

-- The id is a published i18n key and is baked into catalog.json and into every
-- cached JS chunk.  Changing it does not rename a key, it invents a new one and
-- abandons the old — so it is refused outright.
CREATE TRIGGER IF NOT EXISTS groups_id_is_immutable
BEFORE UPDATE OF id ON groups
WHEN NEW.id <> OLD.id
BEGIN
    SELECT RAISE(ABORT, 'groups.id is the i18n key and is immutable');
END;


-- ---------------------------------------------------------------------------
-- group_captions — the per-locale text actually rendered for a group.
--
-- Split from clip_captions rather than sharing one polymorphic table: a single
-- captions table with a subject_kind column cannot carry a foreign key, so a
-- deleted group would leave caption rows behind for the catalogue builder to
-- publish under an id that no longer resolves.
--
-- A MISSING locale is a MISSING ROW.  Never insert '' to mean "not translated
-- yet": src/locales/*.js are three independent files, not translations of one
-- another (en-US has no info.audioStaff at all), and the catalogue builder has
-- to be able to tell "the owner has not written this yet" from "the owner wrote
-- nothing on purpose".  See v_missing_captions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS group_captions (
    group_id    TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
    locale      TEXT NOT NULL REFERENCES locales (code) ON DELETE RESTRICT,
    text        TEXT NOT NULL,
    updated_at  TEXT NOT NULL,

    PRIMARY KEY (group_id, locale),
    CHECK (trim(text) <> '' AND length(text) <= 200),
    CHECK (instr(text, '{') = 0 AND instr(text, '}') = 0 AND instr(text, '|') = 0
       AND instr(text, '@:') = 0
       AND text NOT GLOB '*@.[a-zA-Z]:*'
       AND text NOT GLOB '*@.[a-zA-Z][a-zA-Z]:*'
       AND text NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND text NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND text NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND text NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND text NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND text NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND text NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND text NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND text NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND text NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'),
    -- A caption is a single line; a newline survives JSON and breaks the button.
    CHECK (instr(text, char(10)) = 0 AND instr(text, char(13)) = 0),
    CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z')
) STRICT;


-- ---------------------------------------------------------------------------
-- media — one row per distinct audio blob, keyed by its own sha256.
--
-- Not merged into clips, for two reasons.  First, an uploaded file exists
-- before it is a clip: it sits in a pending batch_item that may be rejected,
-- and bytes/duration belong to the blob either way.  Second, without a single
-- row per blob nothing can answer "is this file on the PVC still referenced?",
-- so the janitor either deletes a file a live clip still plays or never deletes
-- anything.  See v_unreferenced_media.
--
-- storage_path is GENERATED, not stored: a content-addressed layout whose path
-- can drift from its hash has stopped being content-addressed.  It is relative
-- on purpose — the URL prefix is the web pod's business, not this database's.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media (
    sha256            TEXT NOT NULL PRIMARY KEY,
    ext               TEXT NOT NULL,
    content_type      TEXT NOT NULL,
    bytes             INTEGER NOT NULL,
    duration_seconds  REAL NOT NULL,
    uploaded_at       TEXT NOT NULL,
    -- Set when the media reclamation sweep removes this blob's bytes from the
    -- PVC.  The row stays (batch_items and clips reference it ON DELETE RESTRICT,
    -- so it cannot go); NULL means the file is present.  Cleared if the same
    -- bytes are submitted again, which puts the file back.  See v_unreferenced_media.
    collected_at      TEXT,

    storage_path      TEXT GENERATED ALWAYS AS
        (substr(sha256, 1, 2) || '/' || substr(sha256, 3, 2) || '/' || sha256 || '.' || ext) VIRTUAL,

    CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    -- The extension is derived from the sniffed type, never from the uploaded
    -- filename, so the pair must agree.  This CHECK is the whole allow-list:
    -- a format with no row here can never reach the PVC, and widening it is a
    -- schema change, which is the point.
    CHECK ((content_type = 'audio/mpeg' AND ext = 'mp3')
        OR (content_type = 'audio/mp4'  AND ext = 'm4a')
        OR (content_type = 'audio/ogg'  AND ext = 'ogg')
        OR (content_type = 'audio/wav'  AND ext = 'wav')),
    -- 5 MB per file (ruling).  The HTTP layer enforces it first; this is the
    -- backstop for the day a route forgets to.
    CHECK (bytes > 0 AND bytes <= 5242880),
    CHECK (duration_seconds > 0.0),
    CHECK (collected_at IS NULL OR collected_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (uploaded_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z')
) STRICT;


-- ---------------------------------------------------------------------------
-- submitters — one row per identity learned from the live room.
--
-- open_id is Bilibili's identifier for a viewer WITHIN one app; it is not
-- globally stable, so it is a unique attribute here and not the primary key.
-- Our own id is what clips and batches reference, and it survives a re-issued
-- open_id.
--
-- display_name is a snapshot taken when the danmaku was seen, not a live value
-- — the site cannot re-read it later, and a credit line must not silently
-- change because someone renamed themselves.
--
-- That credit line is rendered through vue-i18n, which makes this observed
-- string a message value like any other, so it carries the same constraints as
-- the captions do.  It is stored escaped (escapeForI18n substitutes fullwidth
-- look-alikes and never rejects, so a nickname containing '|' still verifies
-- its owner); the CHECK below is what holds if a write path ever skips that.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS submitters (
    id                    TEXT NOT NULL PRIMARY KEY,
    open_id               TEXT NOT NULL UNIQUE,
    display_name          TEXT NOT NULL,
    display_name_seen_at  TEXT NOT NULL,
    first_seen_at         TEXT NOT NULL,
    last_seen_at          TEXT NOT NULL,

    -- Denormalised for rate limiting and for the admin list, which would
    -- otherwise aggregate the whole batch history per row.  They can drift;
    -- v_submitter_counts_expected exists so the drift is detectable instead of
    -- believed.
    submitted_count       INTEGER NOT NULL DEFAULT 0 CHECK (submitted_count >= 0),
    approved_count        INTEGER NOT NULL DEFAULT 0 CHECK (approved_count >= 0),
    rejected_count        INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),

    blocked               INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
    blocked_at            TEXT,
    blocked_reason        TEXT,

    CHECK (id <> '' AND id NOT GLOB '*[^a-z0-9_-]*'),
    CHECK (open_id <> '' AND length(open_id) <= 128),
    CHECK (display_name <> '' AND length(display_name) <= 120),
    -- The same guards the caption columns carry.  escapeForI18n is
    -- length-preserving, so this cannot reject a name the 120 above accepted.
    CHECK (instr(display_name, '{') = 0 AND instr(display_name, '}') = 0
       AND instr(display_name, '|') = 0
       AND instr(display_name, '@:') = 0
       AND display_name NOT GLOB '*@.[a-zA-Z]:*'
       AND display_name NOT GLOB '*@.[a-zA-Z][a-zA-Z]:*'
       AND display_name NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND display_name NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND display_name NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND display_name NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND display_name NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND display_name NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND display_name NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND display_name NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND display_name NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND display_name NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'),
    CHECK (display_name_seen_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (first_seen_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (last_seen_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (blocked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (last_seen_at >= first_seen_at),
    CHECK ((blocked = 1) = (blocked_at IS NOT NULL))
) STRICT;


-- ---------------------------------------------------------------------------
-- sessions — the browser session, which may or may not yet know who it is.
--
-- The cookie value is never stored, only its sha256: a leaked database backup
-- should not hand over live sessions.  Lookup is by hash, hence the UNIQUE.
--
-- submitter_id is nullable because a session is created BEFORE identity exists
-- — the visitor needs a session to be issued a verification code in the first
-- place.  The paired CHECK stops the half-bound state where a session points at
-- a submitter but nothing records when that happened.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT NOT NULL PRIMARY KEY,
    token_sha256  TEXT NOT NULL UNIQUE,
    submitter_id  TEXT REFERENCES submitters (id) ON DELETE CASCADE,
    bound_at      TEXT,
    created_at    TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    revoked_at    TEXT,

    CHECK (id <> '' AND id NOT GLOB '*[^a-z0-9_-]*'),
    CHECK (length(token_sha256) = 64 AND token_sha256 NOT GLOB '*[^0-9a-f]*'),
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (last_seen_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (bound_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (revoked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (expires_at > created_at),
    CHECK ((submitter_id IS NULL) = (bound_at IS NULL))
) STRICT;

CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS sessions_submitter ON sessions (submitter_id);


-- ---------------------------------------------------------------------------
-- verify_codes — one-time danmaku codes, and the demand signal for the room
-- WebSocket.
--
-- The room listener is reference-counted (ruling).  The reference count is NOT
-- a column here or anywhere else: it is the number of rows still in 'pending'
-- whose expires_at is in the future.  A stored counter survives a crash as a
-- lie — the process that decremented it is gone and the listener stays open
-- forever, or worse, closes while someone is still waiting.  Derived from rows,
-- it is correct again the moment the process restarts.  See v_room_demand.
--
-- expires_at is ABSOLUTE, written once at issue time (issued_at + 10 min).  A
-- relative "10 minutes from last activity" would let a visitor hold the
-- listener open indefinitely.
--
-- code is globally unique across all history, not merely among live codes: a
-- danmaku arriving late must resolve to exactly one code forever, and a code
-- that can never be reissued can never be replayed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verify_codes (
    id                     TEXT NOT NULL PRIMARY KEY,
    code                   TEXT NOT NULL UNIQUE,
    session_id             TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    -- Recorded per code rather than read from config at review time: if the
    -- owner ever changes rooms, the history must still say which room a given
    -- identity was proved in.
    room_id                INTEGER NOT NULL,
    state                  TEXT NOT NULL DEFAULT 'pending'
                                CHECK (state IN ('pending', 'verified', 'expired', 'cancelled')),
    issued_at              TEXT NOT NULL,
    expires_at             TEXT NOT NULL,
    -- The moment this code stopped demanding a listener, for any reason.
    closed_at              TEXT,
    consumed_at            TEXT,
    -- RESTRICT, not SET NULL: a verified code is the record of an identity
    -- proof, and nulling its subject would turn it into a proof of nothing.
    -- (SET NULL would also fail the 'verified implies submitter_id' CHECK below,
    -- which would refuse the delete anyway but blame the wrong constraint.)
    submitter_id           TEXT REFERENCES submitters (id) ON DELETE RESTRICT,
    observed_open_id       TEXT,
    observed_display_name  TEXT,
    verified_via           TEXT CHECK (verified_via IN ('danmaku', 'dev-bypass')),

    -- The natural-language phrase the visitor posts (lib/challenge-phrase.mjs).
    -- `code` above stays the internal A-Z0-9 handle; this is what the danmaku
    -- carries and what the room matcher compares against. Nullable: the
    -- dev-bypass path proves identity without a danmaku and sets none. UNIQUE is
    -- inline here so a FRESH database gets it from this CREATE TABLE; an UPGRADE
    -- gets the same guarantee from the v3 migration step's named index, because
    -- ALTER ADD COLUMN cannot carry UNIQUE. It is deliberately NOT a standalone
    -- CREATE UNIQUE INDEX below: migrate() re-execs this whole file BEFORE its
    -- steps run, so an index naming this column would fire before the ALTER adds
    -- it on an upgrade and fail with "no such column". SQLite lets the many
    -- historical NULLs coexist under a UNIQUE column.
    challenge_text         TEXT UNIQUE CHECK (challenge_text IS NULL OR (length(challenge_text) BETWEEN 4 AND 40)),

    CHECK (id <> '' AND id NOT GLOB '*[^a-z0-9_-]*'),
    -- Uppercase and digits only: the visitor retypes this into a chat box, and
    -- if matching had to case-fold then 'a1b2c3' and 'A1B2C3' would be two rows
    -- that both match one danmaku.  Whitespace is excluded for the same reason.
    CHECK (length(code) BETWEEN 4 AND 32 AND code NOT GLOB '*[^A-Z0-9]*'),
    CHECK (room_id > 0),
    CHECK (issued_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (closed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (consumed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (expires_at > issued_at),
    -- Pending means "still demanding a listener"; anything else has closed.
    CHECK ((state = 'pending') = (closed_at IS NULL)),
    -- Single use: only a verification consumes a code, and a verified code must
    -- carry the whole identity it proved.
    CHECK ((consumed_at IS NOT NULL) = (state = 'verified')),
    CHECK (state <> 'verified' OR (submitter_id IS NOT NULL
                               AND observed_open_id IS NOT NULL
                               AND verified_via IS NOT NULL))
) STRICT;

CREATE INDEX IF NOT EXISTS verify_codes_pending ON verify_codes (state, expires_at);
CREATE INDEX IF NOT EXISTS verify_codes_session ON verify_codes (session_id);

-- ===========================================================================
-- Admin identity (schema v4)
-- ===========================================================================
-- Who may reach the review desk is the UNION of two sources:
--
--   * the env seed, ADMIN_OPEN_IDS, which the deploy bootstrap fills. It is the
--     floor: it can never be removed from the running set, so a room full of
--     admins revoking each other can never lock the owner out. It lives in the
--     process env, NOT in this table.
--   * this table, which holds admins added ONLINE, by an existing admin
--     confirming a candidate who proved an open_id in the live room. Adding one
--     takes effect on the next request — the gate reads the table, it is not
--     cached at boot — which is the whole point of not editing env for every
--     new admin.
--
-- So this table never holds a seed. Removal (revoked_at) only ever affects a
-- row here, and the gate refuses to revoke the last remaining admin (env + here)
-- so the desk can never become unreachable.
CREATE TABLE IF NOT EXISTS admins (
    open_id       TEXT NOT NULL PRIMARY KEY,
    display_name  TEXT NOT NULL,
    -- The admin open_id who confirmed this one. NULL is not allowed: an online
    -- admin was always added BY somebody, and the audit trail needs to say who.
    invited_by    TEXT NOT NULL,
    invited_at    TEXT NOT NULL,
    -- Soft delete: a revoked admin stays as the record that they once were one,
    -- so `invited_by` on somebody they added still points at a real row.
    revoked_at    TEXT,

    CHECK (open_id <> ''),
    CHECK (display_name <> ''),
    CHECK (invited_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (revoked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z')
) STRICT;

CREATE INDEX IF NOT EXISTS admins_active ON admins (revoked_at);

-- An online invitation, verified the same way a login is: a phrase posted as a
-- danmaku in the room. It is NOT a verify_codes row, because that table's
-- session_id is NOT NULL (it binds a login session) and an invite has no
-- candidate session — the candidate proves an open_id, they do not sign in here.
--
-- Two-step by the owner's ruling: a danmaku moves the invite to 'claimed' and
-- records WHO claimed it, but only the inviting admin's explicit 'confirm' turns
-- the candidate into an admin. So a stray or stolen phrase binds nobody until a
-- human who can already see the desk says yes.
CREATE TABLE IF NOT EXISTS admin_invites (
    id                     TEXT NOT NULL PRIMARY KEY,
    challenge_text         TEXT NOT NULL UNIQUE,
    room_id                INTEGER NOT NULL,
    -- The admin who started the invite. Their open_id, kept even after they are
    -- themselves revoked, for the same reason verify_codes keeps its subject.
    created_by             TEXT NOT NULL,
    state                  TEXT NOT NULL DEFAULT 'pending'
                                CHECK (state IN ('pending', 'claimed', 'confirmed', 'expired', 'cancelled')),
    issued_at              TEXT NOT NULL,
    expires_at             TEXT NOT NULL,
    closed_at              TEXT,
    -- The candidate the danmaku revealed. Set when the phrase is claimed, kept
    -- through confirmation so the audit says who was made an admin from where.
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
    -- 'pending' and 'claimed' are both OPEN states — the invite is still live,
    -- waiting for a danmaku or for the admin's confirm — so closed_at is NULL for
    -- both. Only the three terminal states (confirmed/expired/cancelled) close it.
    CHECK ((state IN ('pending', 'claimed')) = (closed_at IS NULL)),
    -- claimed/confirmed imply the candidate was observed.
    CHECK (state NOT IN ('claimed', 'confirmed') OR observed_open_id IS NOT NULL),
    CHECK ((state = 'confirmed') = (confirmed_at IS NOT NULL))
) STRICT;

CREATE INDEX IF NOT EXISTS admin_invites_pending ON admin_invites (state, expires_at);

-- Single use, enforced rather than assumed: once a code leaves 'pending' it can
-- never re-enter it or become anything else, so a replayed danmaku cannot
-- re-verify a code that already spent itself.
CREATE TRIGGER IF NOT EXISTS verify_codes_terminal_state
BEFORE UPDATE OF state ON verify_codes
WHEN OLD.state <> 'pending' AND NEW.state <> OLD.state
BEGIN
    SELECT RAISE(ABORT, 'verify_codes: state is terminal once it leaves pending');
END;

-- The other half of that rule, and the half the state trigger does not cover:
-- what the code PROVED is as terminal as the fact that it was spent.  Guarding
-- `state` alone leaves the proof itself writable — a verified row could keep
-- its state and be re-pointed at a different submitter, or have its
-- observed_open_id rewritten to someone who never sent a danmaku, and the
-- history would still read as a clean verification.
--
-- IS NOT rather than <>: these columns are NULL on every code that was never
-- verified, and '<>' against NULL is NULL, so a plain comparison would let the
-- identity of an expired or cancelled code be filled in after the fact.
CREATE TRIGGER IF NOT EXISTS verify_codes_terminal_identity
BEFORE UPDATE OF submitter_id, observed_open_id, observed_display_name, verified_via, consumed_at
ON verify_codes
WHEN OLD.state <> 'pending'
 AND (NEW.submitter_id          IS NOT OLD.submitter_id
   OR NEW.observed_open_id      IS NOT OLD.observed_open_id
   OR NEW.observed_display_name IS NOT OLD.observed_display_name
   OR NEW.verified_via          IS NOT OLD.verified_via
   OR NEW.consumed_at           IS NOT OLD.consumed_at)
BEGIN
    SELECT RAISE(ABORT, 'verify_codes: the identity a spent code proved is not rewritable');
END;

CREATE TRIGGER IF NOT EXISTS verify_codes_code_is_immutable
BEFORE UPDATE OF code ON verify_codes
WHEN NEW.code <> OLD.code
BEGIN
    SELECT RAISE(ABORT, 'verify_codes.code is immutable');
END;


-- ---------------------------------------------------------------------------
-- batches — one submission attempt, up to 10 clips (ruling).
--
-- submitter_id is NOT NULL from creation: submission requires identity, so a
-- batch that does not know whose it is has no legitimate state to be in.
--
-- Turnstile is decided at submit time, not at page load, so the verdict lives
-- on the batch and not on the session.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS batches (
    id                    TEXT NOT NULL PRIMARY KEY,
    submitter_id          TEXT NOT NULL REFERENCES submitters (id) ON DELETE RESTRICT,
    session_id            TEXT REFERENCES sessions (id) ON DELETE SET NULL,
    state                 TEXT NOT NULL DEFAULT 'draft'
                              CHECK (state IN ('draft', 'submitted', 'resolved', 'cancelled')),
    created_at            TEXT NOT NULL,
    submitted_at          TEXT,
    resolved_at           TEXT,

    turnstile_required    INTEGER NOT NULL DEFAULT 0 CHECK (turnstile_required IN (0, 1)),
    turnstile_verdict     TEXT CHECK (turnstile_verdict IN ('passed', 'failed', 'bypassed')),
    turnstile_decided_at  TEXT,

    CHECK (id <> '' AND id NOT GLOB '*[^a-z0-9_-]*'),
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (submitted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (resolved_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (turnstile_decided_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (state <> 'draft' OR submitted_at IS NULL),
    CHECK (state NOT IN ('submitted', 'resolved') OR submitted_at IS NOT NULL),
    CHECK ((state = 'resolved') = (resolved_at IS NOT NULL)),
    CHECK ((turnstile_verdict IS NULL) = (turnstile_decided_at IS NULL)),
    -- No challenge asked for, no verdict to record.
    CHECK (turnstile_required = 1 OR turnstile_verdict IS NULL)
) STRICT;

CREATE INDEX IF NOT EXISTS batches_submitter ON batches (submitter_id, created_at);
CREATE INDEX IF NOT EXISTS batches_state ON batches (state, created_at);


-- ---------------------------------------------------------------------------
-- batch_items — the per-clip half of the two-level state machine.
--
-- Item state is what makes partial approval real: approving items 1, 2, 4 and 5
-- while item 3 fails is four independent row updates, and nothing about item 3
-- can roll back the others.  The batch has NO aggregate status column for the
-- same reason — a stored roll-up would be a second opinion about facts these
-- rows already hold, free to disagree.  See v_batch_progress.
--
-- position is CHECKed 1..10 and unique per batch, which is also how the
-- 10-clips-per-batch cap (ruling) is enforced: there is no eleventh slot.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS batch_items (
    id                TEXT NOT NULL PRIMARY KEY,
    batch_id          TEXT NOT NULL REFERENCES batches (id) ON DELETE CASCADE,
    position          INTEGER NOT NULL,
    media_sha256      TEXT NOT NULL REFERENCES media (sha256) ON DELETE RESTRICT,

    -- What the submitter proposed.  None of it is an i18n key: the key is
    -- minted when the item is approved and becomes a clip.
    proposed_label    TEXT NOT NULL,
    proposed_group_id TEXT REFERENCES groups (id) ON DELETE SET NULL,
    submitter_note    TEXT,

    state             TEXT NOT NULL DEFAULT 'pending'
                          CHECK (state IN ('pending', 'approved', 'rejected', 'failed')),
    created_at        TEXT NOT NULL,
    resolved_at       TEXT,
    reviewer_note     TEXT,
    -- Set on approval; this is the only link between an item and the clip it
    -- became.  Deliberately one-directional — clips do not point back, so there
    -- is no pair of columns that can disagree about the same relationship.
    --
    -- RESTRICT, and it is a correction rather than a decision: this said
    -- SET NULL, which could never once have fired.  Nulling clip_id on an
    -- approved item violates the paired CHECK below, so the delete aborted
    -- anyway — with 'CHECK constraint failed', which names the wrong thing and
    -- sends the reader to the wrong line.  RESTRICT is what was actually
    -- happening, and it says why: the record that this item became that clip
    -- outlives neither of them alone.  Clips are retired, not deleted (see
    -- clips.state), so nothing legitimate is blocked by this; a clip that truly
    -- must go requires deciding what its item now says, in a statement written
    -- for that purpose.
    clip_id           TEXT REFERENCES clips (id) ON DELETE RESTRICT,

    UNIQUE (batch_id, position),
    -- The same file twice in one batch is a mistake, not two clips.
    UNIQUE (batch_id, media_sha256),

    CHECK (id <> '' AND id NOT GLOB '*[^a-z0-9_-]*'),
    CHECK (position BETWEEN 1 AND 10),
    CHECK (proposed_label <> '' AND length(proposed_label) <= 120),
    CHECK (instr(proposed_label, '{') = 0 AND instr(proposed_label, '}') = 0
       AND instr(proposed_label, '|') = 0
       AND instr(proposed_label, '@:') = 0
       AND proposed_label NOT GLOB '*@.[a-zA-Z]:*'
       AND proposed_label NOT GLOB '*@.[a-zA-Z][a-zA-Z]:*'
       AND proposed_label NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND proposed_label NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND proposed_label NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND proposed_label NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND proposed_label NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND proposed_label NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND proposed_label NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND proposed_label NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND proposed_label NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND proposed_label NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'),
    CHECK (submitter_note IS NULL OR length(submitter_note) <= 500),
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (resolved_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK ((state = 'pending') = (resolved_at IS NULL)),
    CHECK ((state = 'approved') = (clip_id IS NOT NULL)),
    -- A refusal the submitter cannot read is a refusal nobody can appeal.
    CHECK (state NOT IN ('rejected', 'failed') OR reviewer_note IS NOT NULL)
) STRICT;

CREATE INDEX IF NOT EXISTS batch_items_state ON batch_items (state, created_at);
CREATE INDEX IF NOT EXISTS batch_items_media ON batch_items (media_sha256);

-- Items belong to a batch that is still being assembled.  Once submitted, the
-- set under review is frozen; otherwise a visitor could append an eleventh clip
-- after the cap was checked, or slip one in mid-review.
CREATE TRIGGER IF NOT EXISTS batch_items_only_into_draft
BEFORE INSERT ON batch_items
WHEN (SELECT state FROM batches WHERE id = NEW.batch_id) <> 'draft'
BEGIN
    SELECT RAISE(ABORT, 'batch_items: items may only be added to a draft batch');
END;

-- A batch is resolved when its items are, not when someone says so.
--
-- "Its items are" includes having some.  v_batch_progress has always reported
-- an empty batch as is_resolvable = 0 while this trigger let one through, and
-- two answers to the same question is one too many: a batch nobody ever put a
-- clip in was not reviewed, it was abandoned, and 'cancelled' is the state that
-- says so.  The view is the one that was right, so the trigger moved.
CREATE TRIGGER IF NOT EXISTS batches_resolve_needs_all_items_resolved
BEFORE UPDATE OF state ON batches
WHEN NEW.state = 'resolved'
 AND (NOT EXISTS (SELECT 1 FROM batch_items WHERE batch_id = NEW.id)
   OR EXISTS (SELECT 1 FROM batch_items WHERE batch_id = NEW.id AND state = 'pending'))
BEGIN
    SELECT RAISE(ABORT, 'batches: a batch resolves when its items do — this one has none, or has pending ones');
END;

-- Submitting past a challenge that was demanded and not passed would make the
-- on-demand Turnstile decision advisory.
--
-- 'resolved' is named alongside 'submitted' because a draft whose items are all
-- decided can be moved straight to resolved in one statement, which reaches the
-- reviewed state without ever passing through the value this trigger reads.
-- The verdict columns hold their values across that update, so a batch that
-- really did pass its challenge is unaffected.
CREATE TRIGGER IF NOT EXISTS batches_submit_needs_turnstile
BEFORE UPDATE OF state ON batches
WHEN NEW.state IN ('submitted', 'resolved') AND NEW.turnstile_required = 1
 AND (NEW.turnstile_verdict IS NULL OR NEW.turnstile_verdict = 'failed')
BEGIN
    SELECT RAISE(ABORT, 'batches: turnstile was required and has not passed');
END;

-- The INSERT halves of the two rules above.  Neither was covered: a BEFORE
-- UPDATE trigger says nothing about a row that ARRIVES in the state it guards,
-- and one INSERT naming state = submitted with turnstile_required = 1 and no
-- verdict was accepted by this database.  A rule that only holds for rows which
-- took the scenic route is not a rule about the table.
CREATE TRIGGER IF NOT EXISTS batches_insert_submit_needs_turnstile
BEFORE INSERT ON batches
WHEN NEW.state IN ('submitted', 'resolved') AND NEW.turnstile_required = 1
 AND (NEW.turnstile_verdict IS NULL OR NEW.turnstile_verdict = 'failed')
BEGIN
    SELECT RAISE(ABORT, 'batches: turnstile was required and has not passed');
END;

-- On INSERT this always refuses, and that is the honest reading rather than a
-- gap: items reference a batch that exists, and may only be added to a draft
-- one (batch_items_only_into_draft), so a batch cannot be born resolved with
-- anything resolved in it.  A restore or an import walks the same path a
-- submission does — insert the draft, add the items, decide them, then resolve.
CREATE TRIGGER IF NOT EXISTS batches_insert_resolve_needs_all_items_resolved
BEFORE INSERT ON batches
WHEN NEW.state = 'resolved'
 AND (NOT EXISTS (SELECT 1 FROM batch_items WHERE batch_id = NEW.id)
   OR EXISTS (SELECT 1 FROM batch_items WHERE batch_id = NEW.id AND state = 'pending'))
BEGIN
    SELECT RAISE(ABORT, 'batches: a batch resolves when its items do — this one has none, or has pending ones');
END;


-- ---------------------------------------------------------------------------
-- clips — a published (or retired, or not-yet-published) voice button.
--
-- id is immutable and is the i18n key, exactly as for groups.
--
-- 'draft' exists because approval and publication are different events:
-- approving item 1 of 5 must not put a button on the live site while the
-- reviewer is still looking at item 2.  The catalogue is built from
-- 'published' rows only.
--
-- submitter_id is nullable: the twelve clips that predate this system were cut
-- by the owner and were never submitted by anyone.  Recording a fake submitter
-- for them would be a lie in the credit line.  It is denormalised off the batch
-- on purpose — the credit is a property of the clip and must outlive any batch
-- history that is later pruned.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clips (
    id            TEXT NOT NULL PRIMARY KEY,
    group_id      TEXT NOT NULL REFERENCES groups (id) ON DELETE RESTRICT,
    -- One clip per distinct blob: two clips sharing a sha256 are two buttons
    -- that play the identical sound, which is what a duplicate submission looks
    -- like after it has been approved twice.
    media_sha256  TEXT NOT NULL UNIQUE REFERENCES media (sha256) ON DELETE RESTRICT,
    -- Admin-facing, renameable, never a key.  Also the last-resort label in
    -- catalog.json for a clip whose caption in the requested locale is missing.
    label         TEXT NOT NULL,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    state         TEXT NOT NULL DEFAULT 'draft'
                      CHECK (state IN ('draft', 'published', 'retired')),
    created_at    TEXT NOT NULL,
    published_at  TEXT,
    retired_at    TEXT,
    submitter_id  TEXT REFERENCES submitters (id) ON DELETE RESTRICT,
    submitted_at  TEXT,

    CHECK (id <> '' AND length(id) <= 64 AND id NOT GLOB '*[^a-z0-9_-]*'),
    CHECK (label <> '' AND length(label) <= 120),
    CHECK (instr(label, '{') = 0 AND instr(label, '}') = 0 AND instr(label, '|') = 0
       AND instr(label, '@:') = 0
       AND label NOT GLOB '*@.[a-zA-Z]:*'
       AND label NOT GLOB '*@.[a-zA-Z][a-zA-Z]:*'
       AND label NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND label NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND label NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND label NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND label NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND label NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND label NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND label NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND label NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND label NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'),
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (published_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (retired_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (submitted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    -- A retired clip was published once; published_at is kept, not cleared,
    -- because the file it points at is cached `immutable` for a year and is
    -- still being played out there.
    CHECK (state = 'draft' OR published_at IS NOT NULL),
    CHECK ((state = 'retired') = (retired_at IS NOT NULL)),
    CHECK ((submitter_id IS NULL) = (submitted_at IS NULL))
) STRICT;

CREATE INDEX IF NOT EXISTS clips_group_order ON clips (group_id, sort_order, id);
CREATE INDEX IF NOT EXISTS clips_state ON clips (state);
CREATE INDEX IF NOT EXISTS clips_submitter ON clips (submitter_id);

CREATE TRIGGER IF NOT EXISTS clips_id_is_immutable
BEFORE UPDATE OF id ON clips
WHEN NEW.id <> OLD.id
BEGIN
    SELECT RAISE(ABORT, 'clips.id is the i18n key and is immutable');
END;

-- A published clip in a retired group is unreachable in the UI but still in
-- catalog.json — a button that exists and cannot be found.  Retire the clips
-- first.
CREATE TRIGGER IF NOT EXISTS clips_publish_needs_active_group
BEFORE UPDATE OF state, group_id ON clips
WHEN NEW.state = 'published'
 AND (SELECT state FROM groups WHERE id = NEW.group_id) <> 'active'
BEGIN
    SELECT RAISE(ABORT, 'clips: cannot publish into a retired group');
END;

CREATE TRIGGER IF NOT EXISTS clips_insert_publish_needs_active_group
BEFORE INSERT ON clips
WHEN NEW.state = 'published'
 AND (SELECT state FROM groups WHERE id = NEW.group_id) <> 'active'
BEGIN
    SELECT RAISE(ABORT, 'clips: cannot publish into a retired group');
END;

-- The same rule from the other end.  Without this, retiring a group would leave
-- its published clips in catalog.json under a group heading the catalogue no
-- longer lists — buttons that exist and cannot be found.  Defined here rather
-- than beside groups because it needs the clips table to exist.
CREATE TRIGGER IF NOT EXISTS groups_retire_needs_no_published_clips
BEFORE UPDATE OF state ON groups
WHEN NEW.state = 'retired'
 AND EXISTS (SELECT 1 FROM clips WHERE group_id = NEW.id AND state = 'published')
BEGIN
    SELECT RAISE(ABORT, 'groups: retire the published clips in this group first');
END;


-- ---------------------------------------------------------------------------
-- clip_captions — the per-locale text rendered on the button.
--
-- Same reasoning as group_captions: a missing locale is a missing row, never an
-- empty string.  With no fallbackLocale configured in src/main.js, a clip with
-- no en-US row renders the literal string 'voice.<id>' to an English visitor,
-- so the admin UI has to be able to see the hole before a visitor does.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clip_captions (
    clip_id     TEXT NOT NULL REFERENCES clips (id) ON DELETE CASCADE,
    locale      TEXT NOT NULL REFERENCES locales (code) ON DELETE RESTRICT,
    text        TEXT NOT NULL,
    updated_at  TEXT NOT NULL,

    PRIMARY KEY (clip_id, locale),
    CHECK (trim(text) <> '' AND length(text) <= 200),
    CHECK (instr(text, '{') = 0 AND instr(text, '}') = 0 AND instr(text, '|') = 0
       AND instr(text, '@:') = 0
       AND text NOT GLOB '*@.[a-zA-Z]:*'
       AND text NOT GLOB '*@.[a-zA-Z][a-zA-Z]:*'
       AND text NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND text NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND text NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND text NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND text NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND text NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND text NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND text NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND text NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'
       AND text NOT GLOB '*@.[a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z][a-zA-Z]:*'),
    CHECK (instr(text, char(10)) = 0 AND instr(text, char(13)) = 0),
    CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z')
) STRICT;

CREATE INDEX IF NOT EXISTS clip_captions_locale ON clip_captions (locale);


-- ---------------------------------------------------------------------------
-- themes — the active look plus its history.
--
-- Rollback is one statement:
--     UPDATE themes SET is_active = 1, activated_at = ? WHERE id = ?;
-- The BEFORE trigger clears the previous active row first, so the partial
-- unique index below never sees two.  The index is not redundant with the
-- trigger: it is what still holds if the trigger is ever dropped.
--
-- Rows are history and are not rewritten, so the theme being rolled back to is
-- exactly the bytes that were live before.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS themes (
    id            TEXT NOT NULL PRIMARY KEY,
    name          TEXT NOT NULL,
    -- The palette tokens, as the JSON the site consumes.  json_valid() here
    -- means an unparseable theme cannot be stored, let alone activated.
    tokens        TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    is_active     INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
    -- Last time this theme became active; kept after deactivation so the
    -- history reads as a sequence.
    activated_at  TEXT,

    -- v2: the wallpaper, as a content-addressed FILENAME (<sha256>.<ext>) under
    -- the volume's wallpaper/ directory.  A filename and not a path: the serving
    -- prefix belongs to nginx and the storage directory to config.mjs, so a row
    -- cannot point outside the directory by construction — there is no '/' to
    -- traverse with.  The extension list is the allow-list (SVG is refused
    -- because it is a script container, not an image).
    wallpaper_path TEXT,

    CHECK (id <> '' AND id NOT GLOB '*[^a-z0-9_-]*'),
    CHECK (name <> '' AND length(name) <= 120),
    CHECK (json_valid(tokens)),
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (activated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (is_active = 0 OR activated_at IS NOT NULL),
    CHECK (wallpaper_path IS NULL OR (
           (wallpaper_path GLOB '*.png' OR wallpaper_path GLOB '*.jpg' OR wallpaper_path GLOB '*.webp')
       AND substr(wallpaper_path, 1, 64) NOT GLOB '*[^0-9a-f]*'
       AND substr(wallpaper_path, 65, 1) = '.'
       AND length(wallpaper_path) <= 69))
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS themes_one_active
    ON themes (is_active) WHERE is_active = 1;

-- BEFORE, not AFTER: the unique index is checked as the row is written, so a
-- trigger that tidied up afterwards would fire too late to prevent the very
-- conflict it exists to resolve.
CREATE TRIGGER IF NOT EXISTS themes_single_active_on_update
BEFORE UPDATE OF is_active ON themes
WHEN NEW.is_active = 1 AND OLD.is_active = 0
BEGIN
    UPDATE themes SET is_active = 0 WHERE is_active = 1 AND id <> NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS themes_single_active_on_insert
BEFORE INSERT ON themes
WHEN NEW.is_active = 1
BEGIN
    UPDATE themes SET is_active = 0 WHERE is_active = 1;
END;


-- ---------------------------------------------------------------------------
-- audit_log — append-only, enforced by the database.
--
-- UPDATE and DELETE raise.  The reason it is not an application convention:
-- the module that writes audit rows is also the module most likely to want to
-- "fix" one, and a convention cannot be checked from a sqlite3 shell.
--
-- Honest limit: a trigger cannot stop DROP TABLE, and nothing here is signed,
-- so this resists mistakes and casual tampering, not an attacker with write
-- access to the file.  Tamper-evidence would need a hash chain over seq.
--
-- No foreign keys, deliberately.  An FK to submitters would let ON DELETE
-- CASCADE erase exactly the trail that records why the submitter was deleted,
-- and an FK with RESTRICT would make audited rows undeletable.  Subject ids are
-- recorded as text and may outlive their subject.
--
-- seq is an autoincrementing integer, which the id convention otherwise
-- forbids.  It is allowed here because it is never exposed outside the server
-- and because append-order is the one thing this table must get right:
-- timestamps are second-precision and tie, and clocks move.  AUTOINCREMENT (not
-- plain rowid) so a value is never reused.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    id            TEXT NOT NULL UNIQUE,
    at            TEXT NOT NULL,
    actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('owner', 'submitter', 'system')),
    actor_id      TEXT,
    action        TEXT NOT NULL,
    subject_kind  TEXT NOT NULL,
    subject_id    TEXT,
    detail        TEXT,

    CHECK (id <> '' AND id NOT GLOB '*[^a-z0-9_-]*'),
    CHECK (at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
    CHECK (action <> '' AND length(action) <= 64),
    CHECK (subject_kind <> '' AND length(subject_kind) <= 64),
    -- "A submitter did something" with no submitter named is not an audit entry.
    CHECK (actor_kind <> 'submitter' OR actor_id IS NOT NULL),
    CHECK (detail IS NULL OR json_valid(detail))
) STRICT;

CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at);
CREATE INDEX IF NOT EXISTS audit_log_subject ON audit_log (subject_kind, subject_id, seq);
CREATE INDEX IF NOT EXISTS audit_log_actor ON audit_log (actor_kind, actor_id, seq);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE is refused');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only: DELETE is refused');
END;


-- ---------------------------------------------------------------------------
-- instance — one row, describing THIS deployment.
--
-- It exists so that the development bypasses cannot be RECORDED in production,
-- decided by the database file rather than by the process asking it.  The
-- ruling says the danmaku check and Turnstile may pass through locally and that
-- this must be impossible to enable in production; an environment variable read
-- by the API cannot deliver that, because the same code with a different env is
-- the entire failure mode.
--
-- What the triggers below do, stated exactly, because the gap matters: they
-- refuse to record a SELF-DECLARED bypass.  They do not detect one.  A caller
-- that skipped the danmaku check entirely and wrote verified_via = 'danmaku'
-- passes through here untouched — nothing in this file knows what happened in
-- the room.  What is bought is that the honest bypass path cannot run in
-- production by accident, which is the failure that actually happens; catching
-- a liar is not on offer at this layer.
--
-- The row is SEEDED by this file, with no mode yet, so that the safe answer is
-- the default state rather than a repair somebody has to remember.  Three
-- states, one reading:
--
--   no row at all     a database built by hand, or one somebody emptied
--   row, mode NULL    seeded here; migrate() has not stamped this deployment
--   row, mode set     what migrate() recorded
--
-- coalesce() in each trigger reads the first two as 'production'.  Before that,
-- the bare subquery returned NULL, NULL = 'production' is NULL, and every one
-- of these triggers quietly did not fire: the bypasses were open on precisely
-- the databases nobody had migrated.
--
-- Each trigger then asks '<> development' rather than '= production', for the
-- reason env-guard.mjs gives for the same test in the config layer: the enum
-- pins the vocabulary, and the negative phrasing means a mode added later is
-- refused by default instead of permitted by default.  Each covers the other's
-- blind spot.
--
-- mode is a one-way ratchet: development may become production, never the
-- reverse — and not via NULL either, which is why the ratchet uses the
-- null-safe IS NOT.  With a plain '<>', 'production' -> NULL would not fire
-- (NULL <> 'production' is NULL) and NULL -> 'development' is permitted, so the
-- switch would be two statements away.  A production database that could be
-- talked back into development would be a production database with a bypass
-- switch.
--
-- Honest limit, in the same voice as audit_log: this resists misconfiguration
-- and casual tampering, not someone with write access to the file, who can
-- DELETE the row or DROP the trigger.  Deleting it is at least the safe
-- direction — no row now reads as production.
--
-- Kept separate from schema_version because schema_version is PUBLISHED — it
-- goes into catalog.json — and the deployment mode must not be.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS instance (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    -- Nullable so this file can seed the row it cannot yet fill in.  NULL is
    -- not "unknown, so assume friendly": every reader of this column resolves
    -- it to 'production'.
    mode        TEXT CHECK (mode IN ('production', 'development')),
    -- Nullable for the same reason, and left NULL rather than backfilled with a
    -- plausible constant: schema.sql has no clock, toCanonicalTimestamp() in
    -- migrate.mjs is the only correct producer of these strings, and an epoch
    -- written here would be a fabrication that reads like a fact.
    created_at  TEXT,

    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z')
) STRICT;

-- Seeded unstamped.  OR IGNORE so re-applying this file to a live database is
-- the no-op the rest of it is, and so that the row a deployment already claimed
-- is never reset by a migration.
INSERT OR IGNORE INTO instance (id, mode, created_at) VALUES (1, NULL, NULL);

CREATE TRIGGER IF NOT EXISTS instance_mode_ratchet
BEFORE UPDATE OF mode ON instance
WHEN OLD.mode = 'production' AND NEW.mode IS NOT 'production'
BEGIN
    SELECT RAISE(ABORT, 'instance.mode cannot be moved out of production');
END;

CREATE TRIGGER IF NOT EXISTS verify_codes_no_bypass_in_production
BEFORE INSERT ON verify_codes
WHEN NEW.verified_via = 'dev-bypass'
 AND coalesce((SELECT mode FROM instance WHERE id = 1), 'production') <> 'development'
BEGIN
    SELECT RAISE(ABORT, 'dev-bypass identity is refused in production');
END;

CREATE TRIGGER IF NOT EXISTS verify_codes_no_bypass_in_production_upd
BEFORE UPDATE OF verified_via ON verify_codes
WHEN NEW.verified_via = 'dev-bypass'
 AND coalesce((SELECT mode FROM instance WHERE id = 1), 'production') <> 'development'
BEGIN
    SELECT RAISE(ABORT, 'dev-bypass identity is refused in production');
END;

CREATE TRIGGER IF NOT EXISTS batches_no_bypass_in_production
BEFORE INSERT ON batches
WHEN NEW.turnstile_verdict = 'bypassed'
 AND coalesce((SELECT mode FROM instance WHERE id = 1), 'production') <> 'development'
BEGIN
    SELECT RAISE(ABORT, 'bypassed turnstile is refused in production');
END;

CREATE TRIGGER IF NOT EXISTS batches_no_bypass_in_production_upd
BEFORE UPDATE OF turnstile_verdict ON batches
WHEN NEW.turnstile_verdict = 'bypassed'
 AND coalesce((SELECT mode FROM instance WHERE id = 1), 'production') <> 'development'
BEGIN
    SELECT RAISE(ABORT, 'bypassed turnstile is refused in production');
END;


-- ---------------------------------------------------------------------------
-- schema_version — one row, and the number catalog.json carries.
--
-- The failure it prevents: js/app.<hash>.js is cached `immutable` for a year
-- (deploy/nginx.conf), so a tab left open across a deploy runs an old parser
-- against a freshly written catalog.json.  Two numbers, because "can this
-- parser still read this document" and "is this document newer than the parser"
-- are different questions:
--
--   version                 bumped by every schema change.
--   min_compatible_version  bumped only when a change breaks older readers.
--
-- A reader compares its own parser version against min_compatible_version and
-- reloads only when it genuinely cannot cope, instead of reloading on every
-- additive change or, worse, silently mis-parsing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_version (
    id                      INTEGER PRIMARY KEY CHECK (id = 1),
    version                 INTEGER NOT NULL CHECK (version > 0),
    min_compatible_version  INTEGER NOT NULL CHECK (min_compatible_version > 0),
    applied_at              TEXT NOT NULL,

    CHECK (min_compatible_version <= version),
    CHECK (applied_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z')
) STRICT;

-- migrate.mjs refuses to run backwards, but it is not the only thing that can
-- open this file.  This makes the rule a property of the database.
CREATE TRIGGER IF NOT EXISTS schema_version_no_downgrade
BEFORE UPDATE OF version ON schema_version
WHEN NEW.version < OLD.version
BEGIN
    SELECT RAISE(ABORT, 'schema_version cannot go backwards');
END;


-- ===========================================================================
-- VIEWS
--
-- Each of these exists because some invariant would otherwise be re-implemented
-- (differently) in each caller.
-- ===========================================================================

-- Open demand for the room WebSocket.  The listener runs if and only if
--     SELECT count(*) FROM v_room_demand WHERE expires_at > :now
-- is greater than zero.  `now` is a parameter, not datetime('now'): the server
-- already has a clock, and a second one inside SQLite would eventually disagree
-- with the timestamps this schema stores.
CREATE VIEW IF NOT EXISTS v_room_demand AS
SELECT id AS verify_code_id, code, room_id, session_id, issued_at, expires_at
FROM verify_codes
WHERE state = 'pending';

-- The batch roll-up that batches deliberately does not store.
CREATE VIEW IF NOT EXISTS v_batch_progress AS
SELECT b.id AS batch_id,
       b.submitter_id,
       b.state AS batch_state,
       count(i.id) AS item_count,
       -- coalesce because sum() over an empty batch is NULL, and a caller that
       -- rendered "NULL pending" would be reporting the same thing as zero.
       coalesce(sum(i.state = 'pending'), 0)  AS pending_count,
       coalesce(sum(i.state = 'approved'), 0) AS approved_count,
       coalesce(sum(i.state = 'rejected'), 0) AS rejected_count,
       coalesce(sum(i.state = 'failed'), 0)   AS failed_count,
       (count(i.id) > 0 AND coalesce(sum(i.state = 'pending'), 0) = 0) AS is_resolvable
FROM batches b
LEFT JOIN batch_items i ON i.batch_id = b.id
GROUP BY b.id;

-- The truth behind submitters' cached counters.  Any row where these disagree
-- with the stored values is drift; nothing repairs it automatically, because a
-- silent repair would also hide the bug that caused it.
CREATE VIEW IF NOT EXISTS v_submitter_counts_expected AS
SELECT s.id AS submitter_id,
       (SELECT count(*) FROM batches b
         WHERE b.submitter_id = s.id AND b.state <> 'draft')          AS submitted_count,
       (SELECT count(*) FROM batch_items i
          JOIN batches b ON b.id = i.batch_id
         WHERE b.submitter_id = s.id AND i.state = 'approved')        AS approved_count,
       (SELECT count(*) FROM batch_items i
          JOIN batches b ON b.id = i.batch_id
         WHERE b.submitter_id = s.id AND i.state IN ('rejected', 'failed')) AS rejected_count
FROM submitters s;

-- Every (subject, locale) pair with no caption row.  This is the hole that
-- renders as a raw key path on the live site, listed before a visitor finds it.
CREATE VIEW IF NOT EXISTS v_missing_captions AS
SELECT 'clip' AS subject_kind, c.id AS subject_id, l.code AS locale
FROM clips c
CROSS JOIN locales l
WHERE c.state <> 'retired'
  AND NOT EXISTS (SELECT 1 FROM clip_captions cc WHERE cc.clip_id = c.id AND cc.locale = l.code)
UNION ALL
SELECT 'group', g.id, l.code
FROM groups g
CROSS JOIN locales l
WHERE g.state = 'active'
  AND NOT EXISTS (SELECT 1 FROM group_captions gc WHERE gc.group_id = g.id AND gc.locale = l.code);

-- Blobs on the PVC that nothing points at any more.  Retired clips still count
-- as references: their files are cached `immutable` for a year and are still
-- being played.
--
-- A CANCELLED batch is not a reference, and reading it as one was a leak with
-- no end: cancelling is what happens INSTEAD of reviewing, so those items keep
-- state 'pending' for the life of the database, this view never listed their
-- blobs, and the janitor never collected a byte of an abandoned upload.
-- 'approved' items in a cancelled batch need no special case — approval means a
-- clip exists, and the clips test above already holds the blob.
CREATE VIEW IF NOT EXISTS v_unreferenced_media AS
SELECT m.sha256, m.storage_path, m.bytes, m.uploaded_at
FROM media m
WHERE NOT EXISTS (SELECT 1 FROM clips c WHERE c.media_sha256 = m.sha256)
  AND NOT EXISTS (SELECT 1 FROM batch_items i
                    JOIN batches b ON b.id = i.batch_id
                   WHERE i.media_sha256 = m.sha256
                     AND i.state IN ('pending', 'approved')
                     AND b.state <> 'cancelled');

-- The published catalogue, in the exact order it must be written.  The ORDER BY
-- lives here so that every publisher produces byte-identical output from
-- identical data: sort_order alone is not unique, and an unstable tiebreak would
-- reshuffle catalog.json on every rebuild and churn the cache for nothing.
CREATE VIEW IF NOT EXISTS v_catalog_groups AS
SELECT id, display_name, sort_order
FROM groups
WHERE state = 'active'
ORDER BY sort_order, id;

CREATE VIEW IF NOT EXISTS v_catalog_clips AS
SELECT c.id, c.group_id, c.label, c.sort_order,
       m.sha256, m.storage_path, m.bytes, m.duration_seconds
FROM clips c
JOIN media m ON m.sha256 = c.media_sha256
WHERE c.state = 'published'
ORDER BY c.group_id, c.sort_order, c.id;
