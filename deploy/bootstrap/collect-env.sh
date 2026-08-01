# shellcheck shell=bash
# SPDX-License-Identifier: MIT
#
# Step 1 of the deploy bootstrap: walk the operator through EVERY variable the
# submission API reads, and write deploy/runtime.env (git-ignored, mode 600).
#
# This file is sourced by bootstrap.sh; it defines collect_env and helpers and
# runs nothing on its own.
#
# ===========================================================================
# TWO RULES THIS STEP OBEYS
# ===========================================================================
#   1. A secret is never echoed. Secret prompts use `read -s` (no terminal
#      echo), the value goes straight into the file, and the file is chmod 600
#      before a byte of content is written into it. The script prints "set" /
#      "kept", never the value — the rule the whole deploy has followed.
#   2. Re-running is safe. If deploy/runtime.env already exists its current
#      values become the defaults, so a second run confirms rather than retypes,
#      and pressing Enter keeps what is there — including secrets, which are
#      carried over WITHOUT ever being displayed.
#
# The variable set is the authority in deploy/runtime.env.example: BILI_* (the
# identity mechanism), SESSION_SECRET, the ruled ceilings, and the dev bypasses
# (pinned off). Turnstile is written as OFF with empty keys and is NOT prompted
# for — it is deferred, and off-with-no-keys is a supported posture the API
# boots on. ADMIN_OPEN_IDS is left empty here and filled by the first-admin step
# after the site is up, because the owner cannot know their own open_id until
# they have logged in once.

: "${BOOTSTRAP_TTY:=/dev/tty}"

# The interactive input is opened ONCE, on its own fd, and every prompt reads
# from that fd. Re-opening $BOOTSTRAP_TTY per prompt (read <"$file") would reset
# a regular file to offset 0 and read the same line every time — harmless on a
# real terminal, wrong for a fed file, and the kind of thing a test must be able
# to drive. Opened by open_tty on fd 3 (a fixed number, so this stays bash-3.2 compatible
# for a stock macOS /bin/bash), read via read -u 3.
open_tty() { exec 3<"$BOOTSTRAP_TTY"; }
close_tty() { exec 3<&- 2>/dev/null || true; }

# --- small IO helpers -------------------------------------------------------

section() { printf '\n\033[1m%s\033[0m\n' "$1" >&2; }
note()    { printf '  %s\n' "$1" >&2; }

# A visible field with an optional default. Prints nothing secret.
#   ask VAR "Prompt" "default"
ask() {
  local var="$1" prompt="$2" default="$3"
  local current="${!var:-$default}"
  local shown="$prompt"
  [[ -n "$current" ]] && shown="$prompt [$current]"
  local answer
  read -r -u 3 -p "  $shown: " answer || true
  printf -v "$var" '%s' "${answer:-$current}"
}

# A secret field. Never echoes; keeps the existing value on empty input. The
# existing value is signalled ONLY as the word "set", never as its bytes.
#   ask_secret VAR "Prompt"
ask_secret() {
  local var="$1" prompt="$2"
  local has="" ; [[ -n "${!var:-}" ]] && has=" (currently set — Enter keeps it)"
  local answer
  read -r -s -u 3 -p "  $prompt$has: " answer || true
  printf '\n' >&2
  [[ -n "$answer" ]] && printf -v "$var" '%s' "$answer"
}

# A yes/no, default yes.
confirm_yes() {
  local prompt="$1" answer
  read -r -u 3 -p "  $prompt [Y/n]: " answer || true
  [[ ! "$answer" =~ ^[Nn] ]]
}

# --- load current values, if any, as defaults -------------------------------

# Read an existing runtime.env into this shell's variables WITHOUT printing any
# value. Assigns one line at a time (never `source`/`set -a`), so a malformed or
# hostile line is data, not a command.
load_existing_env() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  local line key val
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    key="${line%%=*}"
    val="${line#*=}"
    key="${key//[[:space:]]/}"
    [[ "$key" =~ ^[A-Z_]+$ ]] || continue
    printf -v "$key" '%s' "$val"
  done <"$file"
}

# --- the walk ---------------------------------------------------------------

collect_env() {
  local out="${RUNTIME_ENV_FILE:-$REPO_ROOT/deploy/runtime.env}"
  load_existing_env "$out"
  open_tty
  trap close_tty RETURN

  section 'Bilibili Live Open Platform — the identity mechanism'
  note 'A visitor proves who they are by posting a one-time phrase as a danmaku'
  note 'in your live room; the backend listens on the Open Platform and reads'
  note 'their open_id from it. These five values are what let it listen.'
  echo >&2

  note 'BILI_APP_ID — your project id, from the Open Platform console project page.'
  ask BILI_APP_ID 'Project (app) id' "${BILI_APP_ID:-}"

  note 'BILI_ROOM_ID — the live room to monitor (the number in live.bilibili.com/<id>).'
  ask BILI_ROOM_ID 'Room id to monitor' "${BILI_ROOM_ID:-}"

  note 'BILI_ACCESS_KEY_ID / _SECRET — your developer key pair, from the console'
  note 'ACCOUNT page (not the project page). Used to sign gateway requests.'
  ask_secret BILI_ACCESS_KEY_ID 'Access key id'
  ask_secret BILI_ACCESS_KEY_SECRET 'Access key secret'

  note 'BILI_ROOM_OWNER_AUTH_CODE — your streamer identity code (身份码), from'
  note 'play-live.bilibili.com. NOTE: refreshing it there invalidates the old one,'
  note 'so if you refresh you must re-run this and redeploy.'
  ask_secret BILI_ROOM_OWNER_AUTH_CODE 'Room owner auth code (身份码)'

  section 'Session signing'
  note 'SESSION_SECRET signs the login cookie. It is generated for you and never'
  note 'shown.'
  if [[ -z "${SESSION_SECRET:-}" ]]; then
    SESSION_SECRET="$(generate_secret)"
    note 'A fresh SESSION_SECRET was generated.'
  elif ! confirm_yes 'Keep the existing SESSION_SECRET?'; then
    SESSION_SECRET="$(generate_secret)"
    note 'A fresh SESSION_SECRET was generated (this logs everyone out).'
  fi

  section 'Tunables (press Enter to accept the defaults)'
  ask DANMAKU_LINGER_SECONDS 'Room linger seconds after the last visitor' "${DANMAKU_LINGER_SECONDS:-45}"
  ask MAX_CLIPS_PER_BATCH 'Max clips per submission' "${MAX_CLIPS_PER_BATCH:-10}"
  ask MAX_FILE_BYTES 'Max bytes per clip' "${MAX_FILE_BYTES:-5242880}"

  # DATA_DIR in the Secret is overridden by the API Deployment's own env on the
  # cluster (it mounts the PVC at /srv/shared); kept for a local run.
  DATA_DIR="${DATA_DIR:-./.data}"

  # Turnstile: deferred. Written OFF with empty keys and never prompted — the API
  # boots on this posture, and the env-guard makes the keys optional while the
  # switch is off. When it is time, set TURNSTILE_SWITCH and fill the keys.
  TURNSTILE_SWITCH=off
  TURNSTILE_SITE_KEY=''
  TURNSTILE_SECRET_KEY=''

  # Dev bypasses pinned OFF: a production process refuses them anyway, and a
  # bootstrap offering to turn them on would be offering to break itself.
  DEV_BYPASS_DANMAKU=0
  DEV_BYPASS_TURNSTILE=0

  # ADMIN_OPEN_IDS: whatever it was (empty on a first run). The first-admin step
  # fills it after login; a re-run must not wipe an already-bootstrapped one.
  ADMIN_OPEN_IDS="${ADMIN_OPEN_IDS:-}"

  write_runtime_env "$out"
  close_tty
  trap - RETURN
  section "Wrote $out"
  note 'Secrets are in it (mode 600, git-ignored) and were never printed here.'
}

# A URL-safe 256-bit secret. Prefers node (always present for this project),
# falls back to openssl.
generate_secret() {
  if command -v node >/dev/null 2>&1; then
    node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  else
    openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
  fi
}

# Writes the file with 600 perms established BEFORE any content is written.
write_runtime_env() {
  local out="$1"
  local tmp="$out.tmp.$$"
  ( umask 077; : >"$tmp" )
  {
    printf '# Generated by deploy/bootstrap.sh — do not commit. Regenerate by re-running it.\n'
    printf 'BILI_APP_ID=%s\n' "$BILI_APP_ID"
    printf 'BILI_ROOM_ID=%s\n' "$BILI_ROOM_ID"
    printf 'BILI_ACCESS_KEY_ID=%s\n' "$BILI_ACCESS_KEY_ID"
    printf 'BILI_ACCESS_KEY_SECRET=%s\n' "$BILI_ACCESS_KEY_SECRET"
    printf 'BILI_ROOM_OWNER_AUTH_CODE=%s\n' "$BILI_ROOM_OWNER_AUTH_CODE"
    printf 'DANMAKU_LINGER_SECONDS=%s\n' "$DANMAKU_LINGER_SECONDS"
    printf 'TURNSTILE_SITE_KEY=%s\n' "$TURNSTILE_SITE_KEY"
    printf 'TURNSTILE_SECRET_KEY=%s\n' "$TURNSTILE_SECRET_KEY"
    printf 'TURNSTILE_SWITCH=%s\n' "$TURNSTILE_SWITCH"
    printf 'ADMIN_OPEN_IDS=%s\n' "$ADMIN_OPEN_IDS"
    printf 'SESSION_SECRET=%s\n' "$SESSION_SECRET"
    printf 'DATA_DIR=%s\n' "$DATA_DIR"
    printf 'MAX_CLIPS_PER_BATCH=%s\n' "$MAX_CLIPS_PER_BATCH"
    printf 'MAX_FILE_BYTES=%s\n' "$MAX_FILE_BYTES"
    printf 'DEV_BYPASS_DANMAKU=%s\n' "$DEV_BYPASS_DANMAKU"
    printf 'DEV_BYPASS_TURNSTILE=%s\n' "$DEV_BYPASS_TURNSTILE"
  } >>"$tmp"
  mv "$tmp" "$out"
  chmod 600 "$out"
}
