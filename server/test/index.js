// The entry point `node --test test/` resolves to.
//
// Measured on this machine, one command against one directory of test files:
//
//   node v20.20.0   `node --test test/`  scans the directory        -> runs
//   node v22.21.1   `node --test test/`  loads it as a MODULE       -> MODULE_NOT_FOUND
//   node v24.16.0   `node --test test/`  loads it as a MODULE       -> MODULE_NOT_FOUND
//
// On the versions this package supports ("node": ">=22.0.0"), a positional that
// names a directory is handed to the module loader rather than walked. Directory
// resolution then looks for index.js — this file — so importing the suite from
// here is what makes the documented command run the tests instead of failing to
// load a directory.
//
// The guard below keeps that from costing a doubled run. `node --test` with no
// positional discovers every file under test/, including this one; in that case
// argv[1] IS this file and the imports would register a second copy of all the
// tests alongside the files the runner is already about to execute. When the
// directory was resolved instead, argv[1] is the directory path, and this file
// is the only thing the runner will load.

import { fileURLToPath } from 'node:url'

const reachedByFileDiscovery = process.argv[1] === fileURLToPath(import.meta.url)

if (!reachedByFileDiscovery) {
  await Promise.all([
    import('./admin.test.mjs'),
    import('./catalog.test.mjs'),
    import('./danmaku-source.test.mjs'),
    import('./env-guard.test.mjs'),
    import('./schema-audit-log.test.mjs'),
    import('./schema-batches.test.mjs'),
    import('./schema-catalogue.test.mjs'),
    import('./schema-dev-bypass.test.mjs'),
    import('./schema-i18n-text.test.mjs'),
    import('./schema-verify-codes.test.mjs'),
    import('./timestamps.test.mjs'),
    import('./turnstile.test.mjs'),
    import('./voices-captions.test.mjs'),
  ])
}
