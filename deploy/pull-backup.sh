#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Pull the cluster's backups to this machine, and verify them HERE.
#
#   Usage:  deploy/pull-backup.sh [destination]
#           (default destination: ./.backups/joi-button, git-ignored)
#
# ===========================================================================
# WHY A PULL AND NOT A PUSH
# ===========================================================================
# The credentials only point one way: this machine can ssh to the node, and the
# node has no way to reach this machine. Making it push would mean giving the
# node a credential for the backup destination — and then a node that is
# compromised takes the backups with it, which is the one thing an off-site copy
# exists to prevent. Same reasoning the platform reached for the AOS pairing,
# where an original push design was overturned for exactly this asymmetry.
#
# ===========================================================================
# WHY IT VERIFIES AFTER THE COPY, ON THE COPY
# ===========================================================================
# The CronJob writes a manifest with a sha256 of the database and the size of
# every blob. Verifying on the NODE proves the node's copy is intact and says
# nothing about the bytes that arrived here — and "the transfer exited 0" is not
# the same claim. So the verification runs against the local copy, using the
# manifests that came with it.
#
# It re-derives the digest rather than trusting a checksum file, and the
# database is opened and integrity-checked, so a snapshot that arrived complete
# but corrupt is caught.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ENV_FILE="${ENV_FILE:-${SCRIPT_DIR}/deploy.env}"
if [[ -f "${ENV_FILE}" ]]; then
  _pre_remote="${REMOTE:-}"
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
  [[ -n "${_pre_remote}" ]] && REMOTE="${_pre_remote}"
fi

REMOTE="${REMOTE:-}"
DEST="${1:-${REPO_ROOT}/.backups/joi-button}"
NAMESPACE="${NAMESPACE:-joi-button}"
KUBECTL="${KUBECTL:-sudo k3s kubectl}"

log()  { printf '[pull-backup] %s\n' "$*"; }
fail() { printf '[pull-backup] ERROR: %s\n' "$*" >&2; exit 1; }

[[ -n "${REMOTE}" ]] || fail "REMOTE is not set. Copy deploy/deploy.env.example to deploy/deploy.env and fill it in, or export REMOTE."
command -v rsync >/dev/null 2>&1 || fail "rsync is required locally."
command -v node  >/dev/null 2>&1 || fail "node is required locally (the verifier is server/scripts/backup.mjs)."

# The backup volume belongs to a claim no running pod mounts between CronJob
# runs, so there is nothing to `kubectl cp` out of. local-path puts it on the
# node's own disk, and that path is what rsync reads.
log "Locating the backup volume on ${REMOTE} ..."
# shellcheck disable=SC2029
VOLUME_PATH="$(ssh -n "${REMOTE}" "${KUBECTL} -n '${NAMESPACE}' get pv -o jsonpath='{range .items[?(@.spec.claimRef.name==\"joi-button-backups\")]}{.spec.hostPath.path}{end}'" 2>/dev/null || true)"
[[ -n "${VOLUME_PATH}" ]] ||
  fail "no PersistentVolume is bound to claim joi-button-backups on ${REMOTE}. Has the CronJob ever run? Check: ${KUBECTL} -n ${NAMESPACE} get cronjob,job,pvc"

log "Node path: ${VOLUME_PATH}"
mkdir -p "${DEST}"

# --archive without --owner/--group: the node's uid 101 means nothing here, and
# trying to preserve it needs root locally for no benefit. --delete is
# deliberately ABSENT: the node prunes on its own schedule, and a local copy that
# mirrors that pruning would lose the oldest snapshot at the same moment the node
# does — which defeats having a second copy at all. Prune this side by hand,
# knowingly.
log "Pulling to ${DEST} ..."
rsync -rlptDvz --human-readable --partial \
  --rsync-path="sudo rsync" \
  "${REMOTE}:${VOLUME_PATH}/" "${DEST}/"

log "Verifying the LOCAL copy (not the node's) ..."
# The verifier reads BACKUP_DIR and nothing else; DATA_DIR is required by
# config.mjs's reader and is not touched on this path.
BACKUP_DIR="${DEST}" DATA_DIR="${DEST}" NODE_ENV=development \
  node "${REPO_ROOT}/server/scripts/backup.mjs" --verify

log "Done. These bytes are now on a second machine and were checked on this one."
