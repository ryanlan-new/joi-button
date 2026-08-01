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
# shellcheck source=deploy/bootstrap/tls.sh
source "$REPO_ROOT/deploy/bootstrap/tls.sh"
# shellcheck source=deploy/bootstrap/apply.sh
source "$REPO_ROOT/deploy/bootstrap/apply.sh"
# shellcheck source=deploy/bootstrap/first-admin.sh
source "$REPO_ROOT/deploy/bootstrap/first-admin.sh"
# shellcheck source=deploy/bootstrap/selfcheck.sh
source "$REPO_ROOT/deploy/bootstrap/selfcheck.sh"

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

step_tls() {
  hr 'Step 4 — TLS'
  choose_tls
}

step_apply() {
  hr 'Step 5 — build and deploy'
  apply_target
}

step_first_admin() {
  hr 'Step 6 — first admin'
  bootstrap_first_admin
}

step_selfcheck() {
  hr 'Step 7 — self-check'
  self_check
}

# The `all` run threads the collected values (DEPLOY_TARGET, TLS_MODE, APP_HOST,
# secrets) through in one shell; running a single step by name re-reads
# deploy/deploy.env for the site values, but the credential/target steps that
# only live in shell state must precede the ones that use them.
main() {
  case "${1:-all}" in
    env)         step_env ;;
    domain)      step_domain ;;
    target)      step_target ;;
    tls)         step_tls ;;
    apply)       step_apply ;;
    first-admin) step_first_admin ;;
    selfcheck)   step_selfcheck ;;
    all)         step_env; step_domain; step_target; step_tls; step_apply; step_first_admin; step_selfcheck ;;
    *)           die "unknown step '${1}' (use: env|domain|target|tls|apply|first-admin|selfcheck|all)" ;;
  esac
}

main "$@"
