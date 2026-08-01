#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# joi-button one-shot deploy bootstrap.
#
# Walks an operator from nothing to a running, TLS-served site on a k3s node:
#
#   1. collect every credential and setting -> deploy/runtime.env   [done]
#   2. domain: what DNS record to add, and confirm it resolves      [next]
#   3. TLS: Let's Encrypt (auto) OR your own certificate files      [next]
#   4. build the images, apply the workloads                        [next]
#   5. first admin: log in once, capture the open_id, wire it in    [next]
#   6. self-check: pods Ready, cert issued, https 200, login ready  [next]
#
# Every step is re-runnable: a second run confirms and repairs rather than
# duplicating. Secrets are collected without echo and never printed.
#
#   Usage:  deploy/bootstrap.sh [step]
#     (no arg)  run the whole sequence
#     env       just (re)collect deploy/runtime.env
#
# SITE VALUES live outside this repo, in deploy/deploy.env (git-ignored), the
# same file deploy/deploy-k3s.sh reads: REMOTE (ssh alias of the node) and
# APP_HOST (the hostname the site is served on).

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export REPO_ROOT

# Site config, if present (REMOTE / APP_HOST / LB_ADDRESS). Not required for the
# `env` step, which is why this is a soft load.
DEPLOY_ENV="${DEPLOY_ENV:-$REPO_ROOT/deploy/deploy.env}"
# shellcheck disable=SC1090
[[ -f "$DEPLOY_ENV" ]] && source "$DEPLOY_ENV"

# shellcheck source=deploy/bootstrap/collect-env.sh
source "$REPO_ROOT/deploy/bootstrap/collect-env.sh"
# shellcheck source=deploy/bootstrap/domain.sh
source "$REPO_ROOT/deploy/bootstrap/domain.sh"
# shellcheck source=deploy/bootstrap/target.sh
source "$REPO_ROOT/deploy/bootstrap/target.sh"

hr()   { printf '\n\033[1m=== %s ===\033[0m\n' "$1" >&2; }
say()  { printf '  %s\n' "$1" >&2; }
die()  { printf '\033[31mbootstrap: %s\033[0m\n' "$1" >&2; exit 1; }

step_env() {
  hr 'Step 1 — credentials and settings'
  collect_env
}

step_domain() {
  hr 'Step 2 — domain'
  collect_domain
}

step_target() {
  hr 'Step 3 — deployment target'
  choose_target
}

# The remaining steps are built next; run them individually as they land. Until
# then the whole-sequence run stops here rather than pretend to have done more.
step_todo() {
  hr 'Steps 4–6 — coming next'
  say "Target is ${DEPLOY_TARGET:-unset}. Next: TLS, apply, first-admin, self-check."
}

main() {
  case "${1:-all}" in
    env)    step_env ;;
    domain) step_domain ;;
    target) step_target ;;
    all)    step_env; step_domain; step_target; step_todo ;;
    *)      die "unknown step '${1}' (use: env | domain | target | all)" ;;
  esac
}

main "$@"
