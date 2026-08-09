// SPDX-License-Identifier: MIT
//
// The process entry. Its whole job is ORDER.
//
// Every step below depends on the one before it, and two of the dependencies are
// not obvious from the code — they are the reason this file is commented step by
// step rather than left to read as an obvious sequence:
//
//   1. THE GUARD NEEDS THE DATABASE. env-guard decides "is this production?"
//      from NODE_ENV *or* the database's own instance.mode, and treats an
//      unreadable mode as production. That mark is written by migrate(). So the
//      database has to be open and migrated BEFORE assertSafeConfig is called —
//      call it earlier and every development instance answers "production",
//      which does not fail open, but does make the development doubles
//      unconstructable for a reason nobody can see.
//
//   2. THE SOURCES NEED THE GUARD. createDanmakuSource() and createTurnstile()
//      refuse to build their development implementations from a config
//      assertSafeConfig() has not cleared, and the clearance is re-derived from
//      the live values at that moment. Constructing them first is not merely out
//      of order, it does not work.
//
// NOTHING BINDS A SOCKET UNTIL ALL OF THAT HAS RETURNED. listen() is the last
// statement in main(), so a refusal from any step above is a process that exits
// non-zero having never accepted a connection. That is the property the whole
// order exists to produce: a misconfigured deployment fails in front of the
// operator who deployed it, not in front of the first visitor.
//
// ---------------------------------------------------------------------------
// WHAT MAKES THIS GO RED
//
//   * Move assertSafeConfig above migrate() — the "a development instance can
//     build its development sources" case goes red (the guard reads an unstamped
//     database as production, so the clearance is never recorded).
//   * Move listen() above assertSafeConfig, or turn the top-level catch into a
//     warning — the "a refused config exits non-zero and binds nothing" case
//     goes red. Check the EXIT CODE and the absence of a listener, not the
//     stderr text: a message is easy to keep while the exit path rots.
//   * Create the data directory when it is an absolute path — the "a pod whose
//     PVC did not mount refuses to start" case goes red, and instead of refusing
//     it would write a database into the container's ephemeral layer and lose it
//     at the next restart, silently.
//   * Drop the shutdown handler's danmaku.stop() — the room session's heartbeat
//     and lease timers are unref'd, so the process would still exit; what goes
//     red is the socket being closed politely rather than dropped.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'

import Database from 'better-sqlite3'

import { createApp } from './app.mjs'
import adminRoutes, { adminStoragePaths } from './routes/admin.mjs'
import publicRoutes from './routes/public.mjs'
import { CONFIG_EXTRA_REQUIREMENTS, ENV_SOURCES, loadConfig } from './config.mjs'
import { applyConnectionPragmas, migrate } from './db/migrate.mjs'
import { synchronizeCatalog } from './lib/catalog.mjs'
import { assertSafeConfig } from './lib/env-guard.mjs'
import { createDanmakuSource } from './lib/danmaku-source.mjs'
import { createLoudnessNormalizer } from './lib/loudness.mjs'
import { createTurnstile } from './lib/turnstile.mjs'
import { DEV_ADMIN_OPEN_ID } from './lib/dev-admin.mjs'

/**
 * A refusal this file composes itself.
 *
 * `problems` is empty and PRESENT: the handler at the bottom prints the message
 * alone for anything carrying that array, which is how a message somebody wrote
 * for an operator avoids being buried under a stack trace.
 */
class BootRefusal extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'BootRefusal'
    this.problems = []
  }
}

async function main() {
  // --- 1. configuration --------------------------------------------------
  // The only environment read in this process. `env` comes back beside the
  // config because assertSafeConfig has to watch the same bag the config was
  // built from: half of the bypass roster is keyed on the DEV_BYPASS_* names an
  // operator types, and if the guard read the ambient process.env while the
  // config had come from deploy/runtime.env, a bypass set in that file would be
  // invisible to that half.
  const { config, env, envFile } = loadConfig()

  // --- 2. the database ---------------------------------------------------
  // Opened before the guard runs, because the guard reads instance.mode out of
  // it (see the header). Nothing else happens on this connection first: the
  // pragmas below are per-connection and must be applied to this exact handle.
  const db = openDatabase(config)

  // --- 3. connection pragmas ---------------------------------------------
  // journal_mode = WAL, foreign_keys = ON, busy_timeout. foreign_keys is
  // per-connection and defaults OFF, so a connection that skips this gets a
  // database in which every REFERENCES clause is a comment. migrate() applies
  // them again and reads them back; doing it here as well is what makes the
  // rule true of the handle the whole process will use, not only of the
  // migration.
  applyConnectionPragmas(db)

  // --- 4. schema -----------------------------------------------------------
  // Idempotent, refuses to run backwards, and stamps instance.mode — the fact
  // step 5 is about to read. The mode is derived from NODE_ENV and only from the
  // exact string 'development'; see config.mjs for why every other value stamps
  // production, and schema.sql for the trigger that makes the mark a one-way
  // ratchet.
  const migration = migrate(db, { mode: config.database.instanceMode })

  // --- 5. the production guard --------------------------------------------
  // Refuses to return when this process is production and a development bypass
  // is set, validates the whole required-key set in one pass, and deep-freezes
  // what it clears. `db` is passed rather than `instanceMode` so the database
  // file itself participates in the decision: the process and the file then
  // derive their answer from one fact instead of two that can disagree.
  const report = assertSafeConfig(config, {
    nodeEnv: config.nodeEnv,
    db,
    env,
    extraRequirements: CONFIG_EXTRA_REQUIREMENTS,
  })

  const devAdminBypass = report.nodeEnv === 'development'
  const adminOpenIds = devAdminBypass
    ? [...new Set([...config.admin.openIds, DEV_ADMIN_OPEN_ID])]
    : config.admin.openIds

  // --- 5b. derived public catalogue --------------------------------------
  // SQLite remains the authority. This startup pass only reconciles the
  // materialised catalog.json with rows that are already published; it never
  // promotes drafts. That matters after a deploy which changes the document's
  // projection (for example, adding submitter names) while the shared volume
  // still contains the previous document.
  const catalogSync = synchronizeCatalog(db, adminStoragePaths(config.storage))

  // --- 6. the sources ------------------------------------------------------
  // After the guard, and only after it: in development mode both of these check
  // that this exact config was cleared, and that it still holds the values it
  // was cleared for.
  const danmaku = createDanmakuSource(config.danmaku)
  const turnstile = createTurnstile(config.turnstile)

  // --- 6b. the loudness normalizer -----------------------------------------
  // Probed HERE, not at first upload. The probe failing at boot names ffmpeg
  // and how to install it; the same absence discovered at first submission
  // would surface as every clip rejected with audio_processing_failed, which
  // reads as "submitters keep sending broken files" until somebody tails the
  // log. Same philosophy as env-guard: a process that cannot do its job
  // refuses to start, in words.
  const normalizer = createLoudnessNormalizer()
  await normalizer.probe()

  // --- 7. the app ----------------------------------------------------------
  const app = createApp({
    config,
    db,
    danmaku,
    turnstile,
    logger: { level: config.server.logLevel },
    report,
    devAdminBypass,
    // The routes, actually registered. createApp defaults this to [], which is
    // the correct default for a seam but was a trap for the one caller that has
    // to fill it: the process bound a socket, served its health checks and 404'd
    // the entire API, and every test passed because the harness registered the
    // routes itself. A seam only proves the composition WORKS; this line is what
    // makes the process PERFORM it.
    routes: [
      {
        plugin: publicRoutes,
        options: {
          db,
          config,
          adminOpenIds,
          devAdminBypass,
          danmakuSource: danmaku,
          turnstile,
          normalizer,
        },
      },
      {
        plugin: adminRoutes,
        options: {
          db,
          adminOpenIds,
          // ALL FOUR, from the plugin's own mapping. This line used to name
          // catalogFile and mediaDir only, which meant THEME_CSS_FILE and
          // WALLPAPER_DIR — both read by config.mjs and both REQUIRED absolute
          // in production by env-guard — reached the process and then went
          // nowhere: routes/admin.mjs fell back to deriving them from the
          // catalogue's directory. Setting either variable changed nothing, and
          // the theme was written where the web pod does not serve it.
          paths: adminStoragePaths(config.storage),
          // The SAME room source the public routes use — one socket per process
          // (it is reference-counted), so admin invitations and logins share it
          // rather than opening a second. This is what lets an invite listen.
          danmakuSource: danmaku,
          roomId: config.danmaku.roomId,
          codeTtlMinutes: config.danmaku.codeTtlMinutes,
        },
      },
    ],
  })

  installShutdown(app, { db, danmaku })

  // --- 8. the socket -------------------------------------------------------
  await app.listen({ host: config.server.host, port: config.server.port })

  app.log.info(
    {
      nodeEnv: report.nodeEnv,
      production: report.production,
      schemaVersion: migration.to,
      schemaApplied: migration.applied,
      danmaku: danmaku.mode,
      turnstile: turnstile.mode,
      envFile: envFile.present ? envFile.path : null,
      admins: adminOpenIds.length,
      // Paths, not values: this line goes to the cluster log.
      database: config.database.file,
      mediaDir: config.storage.mediaDir,
      catalogFile: config.storage.catalogFile,
      // The two the web pod also has to be looking at. On the line because the
      // failure they cause is invisible from the API side: a theme saved to a
      // path nginx does not serve answers 200 and changes nothing on screen, so
      // the first question is always "where did it go", and this is the answer.
      themeCssFile: config.storage.themeCssFile,
      wallpaperDir: config.storage.wallpaperDir,
      catalogSync: {
        changed: catalogSync.catalogChanged ?? false,
        skipped: catalogSync.skipped,
        reason: catalogSync.reason ?? null,
        clips: catalogSync.clips ?? null,
        sha256: catalogSync.catalogSha256 ?? null,
      },
    },
    'joi-button API listening',
  )

  if (report.banner !== null) {
    // A bypass that is running has to be visible to a human looking at the logs,
    // not only to a reader of the config. The same object goes out as a header
    // on every response and in the health document; this is the third place,
    // because the first two are only seen by somebody who already suspects.
    app.log.warn({ flags: report.banner.flags.map((flag) => flag.path) }, report.banner.headline)
  }

  if (config.admin.openIds.length === 0) {
    app.log.warn(
      'ADMIN_OPEN_IDS is empty, so no account can reach the admin routes. This is the expected ' +
        'state for a fresh deployment: obtain your own open_id by verifying once through the ' +
        'danmaku flow, then set it.',
    )
  }
}

/**
 * Open the SQLite file, and refuse rather than repair when its directory is not
 * there.
 *
 * The directory is created ONLY when the path is relative, and that distinction
 * is the whole point. An absolute path is the mounted PVC; if it is missing, the
 * mount did not happen, and creating it would put the database that is the sole
 * authority for the catalogue onto the container's ephemeral layer, where it
 * works perfectly until the pod restarts and everything is gone. A relative path
 * cannot be that mount — env-guard refuses a relative storage path in production
 * — so creating it can only ever be a convenience on somebody's laptop.
 */
function openDatabase(config) {
  const file = config.database.file
  const directory = dirname(file)

  if (!existsSync(directory)) {
    if (isAbsolute(file)) {
      throw new BootRefusal(
        `joi-button API refused to start.\n\n  - the database directory ${directory} does not exist.\n` +
          '      This path is absolute, so it is the mounted volume. It is NOT created here: a\n' +
          '      database created on the container filesystem would work until the next restart\n' +
          '      and then be gone, with nothing in the logs to say so. Check the volume mount.',
      )
    }
    mkdirSync(directory, { recursive: true })
  }

  try {
    return new Database(file)
  } catch (error) {
    throw new BootRefusal(
      `joi-button API refused to start.\n\n  - the database at ${file} could not be opened (${error?.code ?? 'unknown error'}).\n` +
        '      DB_FILE, or DATA_DIR when DB_FILE is unset, decides this path.',
      { cause: error },
    )
  }
}

/**
 * One shutdown path for both signals, and it is idempotent: a second SIGTERM
 * while the first is still draining must not start a second teardown.
 *
 * Order mirrors the boot: stop accepting requests, then release the room
 * session, then close the database last, so nothing is mid-write when the file
 * is closed. `force: true` on the danmaku source is the documented way to say
 * "this is process shutdown" — without it the source refuses to stop while a
 * visitor still holds a lease, which is correct behaviour at every other moment.
 */
function installShutdown(app, { db, danmaku }) {
  let closing = false

  const shutdown = async (signal) => {
    if (closing) return
    closing = true
    app.log.info({ signal }, 'shutting down')
    try {
      await app.close()
      await danmaku.stop({ force: true })
    } catch (error) {
      app.log.error({ err: error }, 'error during shutdown')
    } finally {
      if (db.open) db.close()
    }
  }

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      shutdown(signal).then(
        () => process.exit(0),
        () => process.exit(1),
      )
    })
  }
}

// A refusal reaches the operator as the message its author wrote, not as a stack
// trace: env-guard and config.mjs both compose a message that lists every
// problem at once and withholds every secret value, and a stack trace on top of
// that buries it.
//
// The test is `problems` being an ARRAY, not a non-empty one. UnsafeConfigError
// carries its bypasses in `flags` and leaves `problems` empty whenever the
// configuration was otherwise fine — which is the normal shape of the most
// important refusal there is, and a length test printed a stack trace for
// exactly that case.
main().catch((error) => {
  process.exitCode = 1

  if (Array.isArray(error?.problems)) {
    process.stderr.write(`${error.message}\n`)
    const hints = describeEnvSources(error)
    if (hints.length > 0) {
      // env-guard names config paths, because config paths are all it knows.
      // config.mjs is the only layer that knows which environment variable feeds
      // which path, so the translation happens here, where both are in scope.
      process.stderr.write(`These come from the environment or deploy/runtime.env:\n${hints.join('\n')}\n\n`)
    }
    return
  }

  process.stderr.write(`${error?.stack ?? error}\n`)
})

// Both lists: a missing key is reported as a problem, and an active bypass is
// reported as a flag. Both name a config path and neither names the variable
// that set it.
function describeEnvSources(error) {
  const seen = new Set()
  const lines = []
  for (const entry of [...(error.problems ?? []), ...(error.flags ?? [])]) {
    const names = ENV_SOURCES[entry.path]
    if (names === undefined || seen.has(entry.path)) continue
    seen.add(entry.path)
    lines.push(`  - ${entry.path} <- ${names.join(' or ')}`)
  }
  return lines
}
