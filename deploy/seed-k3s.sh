#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Seed the baseline catalogue into a k3s deployment, once.
#
# The api image carries server/ only, and import-snapshot.mjs derives its inputs
# from its own location (../../ -> /), so a one-off pod runs it with src/ and
# public/ streamed in on emptyDirs — the image's root stays read-only and the two
# paths it insists on are the only writable additions. Then a publish writes
# catalog.json so the site paints the twelve clips from the database rather than
# from the compiled-in fallback.
#
# Idempotent by construction: import-snapshot never updates or deletes, and the
# publish is a no-op when catalog.json already matches. Safe to re-run.
#
#   REMOTE   ssh alias of the node (required)
#
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
: "${REMOTE:?set REMOTE to the node ssh alias}"
KUBECTL="${KUBECTL:-sudo k3s kubectl}"
NS=joi-button

say() { printf '  %s\n' "$1" >&2; }
k()   { ssh -n "$REMOTE" "$KUBECTL -n $NS $1"; }

# The exact image the api Deployment runs, so the seed pod is byte-identical to
# production (same schema, same import-snapshot).
IMAGE="$(k "get deploy joi-button-api -o jsonpath={.spec.template.spec.containers[0].image}")"
[[ -n "$IMAGE" ]] || { echo "seed: could not read the api image; is the api deployed?" >&2; exit 1; }
say "Seed pod image: $IMAGE"

# A pod that sleeps so the payload can be streamed in before the import runs.
say 'Creating the one-off seed pod...'
ssh "$REMOTE" "$KUBECTL apply -f -" >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: joi-seed
  namespace: $NS
  labels: { app.kubernetes.io/name: joi-button-seed }
spec:
  restartPolicy: Never
  securityContext: { runAsNonRoot: true, runAsUser: 101, runAsGroup: 101 }
  containers:
    - name: seed
      image: $IMAGE
      imagePullPolicy: IfNotPresent
      command: ["sleep", "1800"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: { drop: ["ALL"] }
      env:
        - { name: NODE_ENV, value: production }
        - { name: DATA_DIR, value: /srv/shared }
        - { name: TRUST_PROXY, value: "1" }
        - { name: CODE_TTL_MINUTES, value: "10" }
        - { name: LOG_LEVEL, value: info }
      envFrom:
        - secretRef: { name: joi-button-runtime }
      volumeMounts:
        - { name: shared, mountPath: /srv/shared }
        - { name: seed-src, mountPath: /src }
        - { name: seed-public, mountPath: /public }
        - { name: tmp, mountPath: /tmp }
  volumes:
    - name: shared
      persistentVolumeClaim: { claimName: joi-button-data }
    - { name: seed-src, emptyDir: {} }
    - { name: seed-public, emptyDir: {} }
    - { name: tmp, emptyDir: {} }
YAML

cleanup() { k "delete pod joi-seed --wait=false >/dev/null 2>&1" || true; }
trap cleanup EXIT

k "wait --for=condition=Ready pod/joi-seed --timeout=120s" >&2

say 'Streaming the baseline clips in...'
tar -C "$REPO_ROOT" -cf - src/voices.json public/voices \
  | ssh "$REMOTE" "$KUBECTL -n $NS exec -i joi-seed -- tar -xf - -C /"

say 'Importing the snapshot...'
k "exec joi-seed -- sh -c 'cd /app && DATA_DIR=/srv/shared node scripts/import-snapshot.mjs'" >&2

say 'Publishing catalog.json...'
# The publish route needs an admin session; at seed time there is none, so this
# calls the same exported function the route calls, with an install-seed actor
# the audit log can tell apart from a person.
PUBLISH_JS=$(cat <<'JS'
import { createRequire } from 'node:module'
const require = createRequire('/app/')
const Database = require('better-sqlite3')
import { loadConfig } from '/app/config.mjs'
import { applyConnectionPragmas, migrate } from '/app/db/migrate.mjs'
import { adminStoragePaths, publishCatalogue } from '/app/routes/admin.mjs'
const { config } = loadConfig()
const db = new Database(config.database.file)
applyConnectionPragmas(db)
migrate(db, { mode: config.database.instanceMode })
const r = publishCatalogue(db, adminStoragePaths(config.storage), {
  actor: { openId: 'operator:install-seed', submitterId: 'operator:install-seed', displayName: 'install seed (operator)' },
  now: () => new Date(),
})
console.log(JSON.stringify({ groups: r.catalog.groups, clips: r.catalog.clips }))
db.close()
JS
)
printf '%s' "$PUBLISH_JS" | ssh "$REMOTE" "$KUBECTL -n $NS exec -i joi-seed -- sh -c 'cat > /tmp/publish.mjs && node /tmp/publish.mjs'" >&2

say 'Seed complete.'
