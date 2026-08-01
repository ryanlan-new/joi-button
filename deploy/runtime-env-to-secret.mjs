#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Reads deploy/runtime.env and writes it back out in the ONE form
// `kubectl create secret generic --from-env-file` reads correctly.
//
// WHY THIS EXISTS AT ALL — it is not a formatter.
// deploy/runtime.env.example is written for a human, and the ★ lines in it look
// like this:
//
//     BILI_ACCESS_KEY_SECRET=hunter2            # ★
//
// server/config.mjs's parser treats everything from that ' #' onwards as a
// comment, so the API reads the secret as `hunter2`. kubectl's env-file parser
// does not: it only skips lines that BEGIN with '#', so it would put
// `hunter2            # ★` into the Secret. The pod would then sign gateway
// requests with a key that has a comment glued to it and Bilibili would answer
// with a signature error that names nothing.
//
// That is a silent, load-bearing disagreement between two parsers over the same
// file. Rather than write a third one here, this imports the API's own
// parseEnvFile — so there is exactly one definition of what a line in that file
// means, and it belongs to the process that has to live with the answer.
//
//   Usage:  node deploy/runtime-env-to-secret.mjs [path]     (default deploy/runtime.env)
//
// stdout is KEY=VALUE lines, one per key, no comments and no blanks — ready to
// pipe into `kubectl create secret generic --from-env-file=/dev/stdin`.
// stderr carries the human summary: how many keys, and which ones are EMPTY.
// Empty is reported rather than refused: an empty value is a legitimate state
// for TURNSTILE_SITE_KEY on a deployment that has not registered a widget yet,
// and the authority on what this deployment requires is server/lib/env-guard.mjs,
// which refuses at boot with a message naming the variable. Duplicating that
// policy here would give it two homes and let them drift.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parseEnvFile } from '../server/config.mjs'

const path = process.argv[2] ?? fileURLToPath(new URL('./runtime.env', import.meta.url))

let text
try {
  text = readFileSync(path, 'utf8')
} catch (error) {
  process.stderr.write(
    `runtime-env-to-secret: cannot read ${path} (${error?.code ?? 'unknown error'}).\n` +
      'Copy deploy/runtime.env.example to deploy/runtime.env and fill it in; it is git-ignored.\n',
  )
  process.exit(2)
}

const { values, problems } = parseEnvFile(text)

if (problems.length > 0) {
  // A line the API's parser cannot read is a line the API would refuse to start
  // on. Refusing here means the operator finds out before the Secret is written,
  // rather than from a CrashLoopBackOff.
  process.stderr.write(`runtime-env-to-secret: ${path} has ${problems.length} unreadable line(s):\n`)
  for (const problem of problems) process.stderr.write(`  - ${problem.name} ${problem.problem}\n`)
  process.exit(2)
}

const names = Object.keys(values).sort()
if (names.length === 0) {
  process.stderr.write(`runtime-env-to-secret: ${path} sets no variables at all.\n`)
  process.exit(2)
}

// Sorted, so two runs over the same file produce byte-identical output and
// `kubectl apply` can report "unchanged" truthfully.
const empty = []
for (const name of names) {
  const value = values[name]
  if (value === '') empty.push(name)
  // NO quoting, NO escaping. kubectl's env-file reader takes the rest of the
  // line verbatim as the value, so a quote added here would end up INSIDE the
  // secret. A value containing a newline cannot be expressed in this format at
  // all — parseEnvFile cannot produce one, since it splits on newlines first.
  process.stdout.write(`${name}=${value}\n`)
}

process.stderr.write(
  `runtime-env-to-secret: ${names.length} keys from ${path}` +
    (empty.length === 0
      ? '.\n'
      : `; ${empty.length} EMPTY: ${empty.join(', ')}\n` +
        '  An empty required value is refused at boot by server/lib/env-guard.mjs, which names it.\n'),
)
