# shellcheck shell=bash
# SPDX-License-Identifier: MIT
#
# Step 7 of the deploy bootstrap: prove the deploy actually works, end to end,
# and say plainly what passed and what did not. Read-only — it asserts, it does
# not change anything.
#
# Uses site_curl/json_field from first-admin.sh, run_on from target.sh, and the
# io helpers from collect-env.sh.

SELFCHECK_FAILED=0

_pass() { printf '  \033[32mPASS\033[0m %s\n' "$1" >&2; }
_fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1" >&2; SELFCHECK_FAILED=1; }
_warn() { printf '  \033[33mWARN\033[0m %s\n' "$1" >&2; }

self_check() {
  [[ -n "${APP_HOST:-}" && -n "${TARGET_ADDR:-}" ]] || die 'APP_HOST/TARGET_ADDR unset'
  local base="https://${APP_HOST}"
  section "Self-check — $APP_HOST"

  # --- workloads up ---
  case "$DEPLOY_TARGET" in
    k3s)
      if run_on "$KUBECTL -n joi-button get pods -l app.kubernetes.io/name=joi-button-api -o jsonpath='{.items[*].status.containerStatuses[*].ready}' 2>/dev/null | grep -q true" \
        && run_on "$KUBECTL -n joi-button get pods -l app.kubernetes.io/name=joi-button-web -o jsonpath='{.items[*].status.containerStatuses[*].ready}' 2>/dev/null | grep -q true"
      then _pass 'api and web pods are Ready'; else _fail 'a pod is not Ready'; fi
      ;;
    docker)
      local up; up="$( cd "$REPO_ROOT/deploy/docker" && docker compose ps --status running --format '{{.Service}}' 2>/dev/null | sort | tr '\n' ' ' )"
      [[ "$up" == *api* && "$up" == *web* && "$up" == *traefik* ]] \
        && _pass "containers running: $up" || _fail "not all containers are running (got: $up)"
      ;;
  esac

  # --- HTTPS reachability ---
  local code
  code="$(site_curl -o /dev/null -w '%{http_code}' --max-time 15 "$base/" 2>/dev/null || echo 000)"
  [[ "$code" == 200 ]] && _pass "GET / over https -> $code" || _fail "GET / over https -> $code"

  code="$(site_curl -o /dev/null -w '%{http_code}' --max-time 15 "$base/api/healthz" 2>/dev/null || echo 000)"
  [[ "$code" == 200 ]] && _pass "api /api/healthz -> $code" || _fail "api /api/healthz -> $code"

  # clips is an ARRAY, not a scalar, so count its entries by their sha256 rather
  # than reading a field. An empty array or a missing document is the seed-not-run
  # state, which is a warning (the site is up) not a failure.
  local cat clips
  cat="$(site_curl --max-time 15 "$base/catalog.json" 2>/dev/null || true)"
  clips="$(printf '%s' "$cat" | grep -o '"sha256"' | wc -l | tr -d ' ')"
  if [[ "${clips:-0}" -gt 0 ]]; then _pass "catalog.json served ($clips clips)"
  else _warn 'catalog.json empty or missing — run the seed if this is a first deploy'; fi

  # --- HTTP -> HTTPS redirect ---
  local redir
  redir="$(curl -sS -k -o /dev/null -w '%{http_code}' --resolve "${APP_HOST}:80:${TARGET_ADDR}" --max-time 10 "http://${APP_HOST}/" 2>/dev/null || echo 000)"
  [[ "$redir" == 3* ]] && _pass "http redirects to https ($redir)" || _warn "http did not redirect ($redir)"

  # --- certificate ---
  local subject
  subject="$(echo | openssl s_client -connect "${TARGET_ADDR}:443" -servername "$APP_HOST" 2>/dev/null | openssl x509 -noout -subject 2>/dev/null | sed 's/subject= *//')"
  if [[ -n "$subject" ]]; then
    _pass "TLS certificate present ($subject)"
    if echo | openssl s_client -connect "${TARGET_ADDR}:443" -servername "$APP_HOST" 2>/dev/null | openssl x509 -noout -checkend $((14*86400)) >/dev/null 2>&1; then :
    else _warn 'certificate expires within 14 days — renew it'; fi
  else _fail 'no TLS certificate served'; fi

  # --- login can reach WAITING (the identity mechanism is live) ---
  local jar; jar="$(mktemp)"
  site_curl -c "$jar" -X POST "$base/api/login/start" -d '{}' -H 'content-type: application/json' -o /dev/null 2>/dev/null || true
  local i st reached=0
  for i in 1 2 3 4 5 6 7 8; do
    st="$(json_field "$(site_curl -b "$jar" "$base/api/login/status" 2>/dev/null || true)" state)"
    [[ "$st" == waiting ]] && { reached=1; break; }
    sleep 3
  done
  rm -f "$jar"
  [[ "$reached" == 1 ]] && _pass 'login reaches WAITING (the room is being heard)' \
    || _warn "login did not reach WAITING (last state: ${st:-none}) — check Bilibili credentials/egress"

  # --- verdict ---
  if [[ "$SELFCHECK_FAILED" == 0 ]]; then
    section 'Self-check passed.'
  else
    section 'Self-check found problems (above). The site may still be partly up.'
    return 1
  fi
}
