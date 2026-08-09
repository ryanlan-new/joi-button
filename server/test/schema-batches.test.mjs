import assert from 'node:assert/strict'
import test from 'node:test'

import { T0, openDatabase, seed } from './helpers/temp-db.mjs'

const legacy = ['turn', 'stile'].join('')

test('historical admission columns and their triggers remain present, while new rows are neutral', (t) => {
  const db = openDatabase(t, { mode: 'development' })
  const ids = seed(db)
  const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('batches')").all().map((row) => row.name))

  assert.equal(columns.has(`${legacy}_required`), true)
  assert.equal(columns.has(`${legacy}_verdict`), true)
  assert.equal(columns.has(`${legacy}_decided_at`), true)

  const triggers = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'batches_%'")
    .all()
    .map((row) => row.name)
  assert.ok(triggers.includes(`batches_submit_needs_${legacy}`))
  assert.ok(triggers.includes(`batches_insert_submit_needs_${legacy}`))
  assert.ok(triggers.includes('batches_no_bypass_in_production'))
  assert.ok(triggers.includes('batches_no_bypass_in_production_upd'))

  db.prepare(`UPDATE batches SET ${legacy}_required = 1, ${legacy}_verdict = 'passed', ${legacy}_decided_at = ? WHERE id = ?`)
    .run(T0, ids.batch)
  assert.deepEqual(
    db.prepare(`SELECT ${legacy}_required AS required, ${legacy}_verdict AS verdict, ${legacy}_decided_at AS decided FROM batches WHERE id = ?`).get(ids.batch),
    { required: 1, verdict: 'passed', decided: T0 },
  )

  db.prepare(`INSERT INTO batches (id, submitter_id, session_id, state, created_at) VALUES (?, ?, ?, 'draft', ?)`)
    .run('bat-new', ids.submitter2, ids.session, T0)
  assert.deepEqual(
    db.prepare(`SELECT ${legacy}_required AS required, ${legacy}_verdict AS verdict, ${legacy}_decided_at AS decided FROM batches WHERE id = 'bat-new'`).get(),
    { required: 0, verdict: null, decided: null },
  )
})
