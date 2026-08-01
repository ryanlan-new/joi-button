# shellcheck shell=bash
# SPDX-License-Identifier: MIT
#
# Step 6 of the deploy bootstrap: make the operator the first admin.
#
# On a fresh deploy ADMIN_OPEN_IDS is empty and every admin route answers 404 to
# everyone — correct, and a dead end until somebody's open_id is in the list. But
# an open_id is issued by the Open Platform per project and shown nowhere; the
# only way to learn yours is to log in once. So this step DOES that login, over
# the real site, reads the open_id back, writes it into runtime.env, and reloads
# the API so the desk opens. After this, more admins are added online from the
# desk — this is the only one that has to be bootstrapped.
#
# Uses the io helpers + fd 3 from collect-env.sh and run_on from target.sh.

# curl against the deployed site: force the hostname to the deploy address, and
# accept the certificate (the operator's own site, possibly self-signed).
site_curl() {
  curl -sS -k --resolve "${APP_HOST}:443:${TARGET_ADDR}" "$@"
}

bootstrap_first_admin() {
  [[ -n "${APP_HOST:-}" && -n "${TARGET_ADDR:-}" ]] || die 'APP_HOST/TARGET_ADDR unset — run the domain step'
  local base="https://${APP_HOST}"
  local jar; jar="$(mktemp)"
  trap 'rm -f "$jar"' RETURN
  open_tty
  trap 'close_tty; rm -f "$jar"' RETURN

  section 'First admin — log in once to capture your open_id'

  # If ADMIN_OPEN_IDS is already set, this was done. Offer to redo (a new admin
  # machine, a rebuilt project) but default to leaving it.
  load_existing_env "${RUNTIME_ENV_FILE:-$REPO_ROOT/deploy/runtime.env}"
  if [[ -n "${ADMIN_OPEN_IDS:-}" ]]; then
    note "ADMIN_OPEN_IDS is already set. The desk is already reachable."
    confirm_yes 'Skip the first-admin login?' && { close_tty; trap - RETURN; return 0; }
  fi

  note 'Asking the site for a login phrase...'
  site_curl -c "$jar" -X POST "$base/api/login/start" -H 'content-type: application/json' -d '{}' -o /dev/null \
    || die 'could not reach the site to start a login'

  # Poll to the WAITING state, where the phrase appears.
  local i state phrase room=''
  for i in $(seq 1 20); do
    local body; body="$(site_curl -b "$jar" "$base/api/login/status" 2>/dev/null || true)"
    state="$(json_field "$body" state)"
    if [[ "$state" == waiting ]]; then
      phrase="$(json_field "$body" code)"
      room="$(json_field "$body" roomId)"
      break
    fi
    [[ "$state" == room-unreachable ]] && note 'The room is not reachable yet (the API is still connecting)...'
    sleep 3
  done
  [[ -n "${phrase:-}" ]] || die 'the site never reached the waiting state; check the API logs and the Bilibili credentials'

  section 'Post THIS as an ordinary danmaku in your live room'
  printf '\n      \033[1m%s\033[0m\n\n' "$phrase" >&2
  [[ -n "$room" ]] && note "Your room: https://live.bilibili.com/$room"
  note 'The script is waiting for it to appear. Once you have posted it, it will'
  note 'read your open_id automatically.'

  # Poll to verified, then read the open_id off /api/me.
  local open_id=''
  for i in $(seq 1 60); do
    local me; me="$(site_curl -b "$jar" "$base/api/me" 2>/dev/null || true)"
    open_id="$(json_field "$me" openId)"
    [[ -n "$open_id" && "$open_id" != null ]] && break
    sleep 3
  done
  [[ -n "$open_id" && "$open_id" != null ]] || die 'timed out waiting for the danmaku; re-run this step and try again'

  note "Your open_id: $open_id"
  set_admin_open_ids "$open_id"
  reload_api
  close_tty; trap - RETURN
  section 'You are the first admin. The review desk is now open to you.'
}

# Rewrite ADMIN_OPEN_IDS in runtime.env, preserving everything else and the 600
# mode. Never prints any other value in the file.
set_admin_open_ids() {
  local out="${RUNTIME_ENV_FILE:-$REPO_ROOT/deploy/runtime.env}"
  local tmp="$out.tmp.$$"
  ( umask 077; : >"$tmp" )
  grep -vE '^ADMIN_OPEN_IDS=' "$out" >>"$tmp" 2>/dev/null || true
  printf 'ADMIN_OPEN_IDS=%s\n' "$1" >>"$tmp"
  mv "$tmp" "$out"
  chmod 600 "$out"
  note "Wrote ADMIN_OPEN_IDS into $out."
}

# Reload the API so it reads the new admin list. The gate reads DB admins per
# request, but the SEED list (ADMIN_OPEN_IDS) is read at boot, so this restart is
# what turns the just-captured open_id into an admin.
reload_api() {
  case "$DEPLOY_TARGET" in
    k3s)
      note 'Recreating the runtime Secret and restarting the API...'
      APP_HOST="$APP_HOST" REMOTE="$REMOTE" bash "$REPO_ROOT/deploy/deploy-k3s.sh" apply >&2 \
        || die 'failed to re-apply after setting ADMIN_OPEN_IDS'
      ;;
    docker)
      local dir="$REPO_ROOT/deploy/docker"
      cp "${RUNTIME_ENV_FILE:-$REPO_ROOT/deploy/runtime.env}" "$dir/runtime.env"
      chmod 600 "$dir/runtime.env"
      local override; [[ "$TLS_MODE" == letsencrypt ]] && override="$dir/compose.le.yml" || override="$dir/compose.cert.yml"
      ( cd "$dir" && docker compose -f docker-compose.yml -f "$override" up -d ) >&2 \
        || die 'failed to recreate the api container'
      ;;
  esac
}

# A dependency-free scalar reader for the small, flat JSON these routes return.
# Not a general JSON parser — it pulls "field":"value" or "field":number, which
# is all these bodies have at the top level.
json_field() {
  local body="$1" field="$2"
  printf '%s' "$body" \
    | sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p;s/.*\"$field\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p" \
    | head -1
}
