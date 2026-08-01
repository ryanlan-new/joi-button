#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// The DEFAULT palette's contrast gate.
//
// It reads the tokens out of src/App.vue's :root block — the same bytes the
// browser reads — and asserts every foreground/background pairing the site
// actually renders. It is deliberately NOT a snapshot of "what the numbers were
// when someone last looked": change a token and the arithmetic changes with it,
// so the gate goes red on the edit rather than on a later review.
//
//   node deploy/contrast-check.mjs          # or: npm run contrast
//
// THE ROSTER AND THE ARITHMETIC ARE NOT HERE. They are in
// server/lib/contrast.mjs, because the owner can now replace these tokens at RUN
// time through the theme editor, and a build-time gate cannot see a value that
// arrives afterwards. Two checkers with two rosters would be worse than one
// checker in the wrong place — the build would gate one set of pairings and the
// API another, and the day they drifted the site would ship a palette the build
// considered fine. This file supplies the DEFAULT tokens; the API supplies an
// owner's; the rules are the same object.
//
// WHY AN ABSOLUTE THRESHOLD AND NOT A "NO REGRESSION" BASELINE. Before the
// palette repair, four of these pairs failed — including the resting label of
// every voice button at 2.75:1 — so a 4.5:1 gate could not have been green in a
// world it was certain to be evaluated in, and a gate like that teaches people
// to ignore red. The defaults were fixed first; only then does an absolute
// threshold become satisfiable, and only then is it worth enforcing.
//
// THE TWO DELIBERATE EXCLUSIONS (slider track, section-header outline) moved to
// server/lib/contrast.mjs with the roster, and the reasoning went with them.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { REQUIRED_TOKENS, evaluatePalette } from '../server/lib/contrast.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(REPO, 'src/App.vue'), 'utf8')

const rootBlock = css.match(/:root\s*\{([\s\S]*?)\}/)
if (!rootBlock) fail('could not find the :root token block in src/App.vue')

const tokens = {}
for (const [, name, value] of rootBlock[1].matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
  tokens[name] = value
}

const { rows, failures, missing } = evaluatePalette(tokens)

if (missing.length > 0) {
  fail(
    `named by the contrast roster and not declared in :root: ${missing.join(', ')}\n` +
      `  (the roster needs: ${REQUIRED_TOKENS.join(', ')})`,
  )
}

const width = Math.max(...rows.map((row) => row.what.length))
for (const row of rows) {
  process.stdout.write(
    `  ${row.ok ? 'PASS' : 'FAIL'}  ${row.what.padEnd(width)}  ${row.ratio.toFixed(2).padStart(6)}:1  ` +
      `(need ${row.threshold}:1)  ${row.fgValue} on ${row.bgValue}\n`,
  )
}
process.stdout.write(`\nCONTRAST_RESULT pairs=${rows.length} fail=${failures}\n`)
if (failures) {
  process.stdout.write(
    'A failing pair means the palette cannot be shipped as-is, not that the gate needs relaxing.\n',
  )
  process.exit(1)
}

function fail(msg) {
  process.stderr.write(`contrast-check: ${msg}\n`)
  process.exit(2)
}
