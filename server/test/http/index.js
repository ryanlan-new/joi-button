// The entry point `node --test test/http/` resolves to.
//
// On the node versions this package supports ("node": ">=22.0.0") a positional
// that names a directory is handed to the MODULE LOADER rather than walked, so
// directory resolution looks for index.js — this file. test/index.js says the
// same thing at more length, and this is the same trick for this directory.
//
// The guard below keeps that from costing a doubled run. `node --test` with NO
// positional — which is what `npm test` runs — discovers every file under test/
// (the runner's `**/test/**/*.{cjs,mjs,js}` pattern reaches into subdirectories),
// including this one; in that case argv[1] IS this file and the imports would
// register a second copy of every case here alongside the files the runner is
// already about to execute. When the directory was resolved instead, argv[1] is
// the directory path.
//
// So: `npm test` needs nothing from this file, and `npm run test:http` needs all
// of it.

import { fileURLToPath } from 'node:url'

const reachedByFileDiscovery = process.argv[1] === fileURLToPath(import.meta.url)

if (!reachedByFileDiscovery) {
  await Promise.all([
    import('./journey.test.mjs'),
    import('./login-room.test.mjs'),
    import('./submit.test.mjs'),
    import('./admin-gate-audit.test.mjs'),
    import('./catalog.test.mjs'),
  ])
}
