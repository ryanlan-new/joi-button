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
# identity mechanism), SESSION_SECRET, the ruled ceilings, and the dev bypass
# (pinned off). ADMIN_OPEN_IDS is left empty here and filled by the first-admin step
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
# Close fd 3. The 2>/dev/null only hushes a "bad fd" error if fd 3 is already
# closed — but it MUST be scoped to a group. `exec 3<&- 2>/dev/null` (exec with no
# command) makes BOTH redirections permanent, which silently sends stderr to
# /dev/null for the rest of the run — so every prompt after the first close_tty
# (i.e. everything from Step 2 on) becomes invisible and the script looks frozen
# at an unseen read. The braces keep the 2>/dev/null off the exec.
close_tty() { { exec 3<&-; } 2>/dev/null || true; }

# --- small IO helpers -------------------------------------------------------

section() { printf '\n\033[1m%s\033[0m\n' "$1" >&2; }
note()    { printf '  %s\n' "$1" >&2; }

# Discard type-ahead already sitting on the input fd before showing a prompt, so a
# paste (or a run of Enters) meant for an EARLIER field cannot silently satisfy
# this one — which reads as "it skipped a prompt" or "it hung at a later prompt",
# the exact confusion this bootstrap hit. Only on a real terminal, and only on
# bash 4+: a fed file in a test is not a tty (-t 3 false) and must never be
# drained, because its bytes ARE the answers. Each byte is consumed only after
# `read -t 0` confirms one is waiting, so this cannot block.
drain_tty() {
  [[ -t 3 ]] || return 0
  [[ "${BASH_VERSINFO[0]:-0}" -ge 4 ]] || return 0
  local _junk
  while IFS= read -r -s -u 3 -t 0 2>/dev/null; do
    IFS= read -r -s -u 3 -n 1 _junk 2>/dev/null || break
  done
}

# A visible field with an optional default.
#
# The prompt is printed EXPLICITLY to stderr, not via `read -p`: read only shows
# a -p prompt when the fd it reads from is a terminal in the way it checks, and
# reading from fd 3 (not stdin) it often shows nothing — which looks exactly like
# a hang. Printing it ourselves shows it in every terminal.
#   ask VAR "Prompt" "default"
ask() {
  local var="$1" prompt="$2" default="$3"
  local current="${!var:-$default}"
  local shown="$prompt"
  [[ -n "$current" ]] && shown="$prompt [$current]"
  drain_tty
  printf '  %s: ' "$shown" >&2
  local answer
  read -r -u 3 answer || true
  printf -v "$var" '%s' "${answer:-$current}"
}

# A secret field. Never shows the bytes, but DOES echo a dot per character so a
# paste or a keystroke visibly registers — the "did that go in?" problem with a
# fully silent prompt. Backspace deletes the last dot. Enter ends. Empty input
# keeps whatever is already set.
#   ask_secret VAR "Prompt"
ask_secret() {
  local var="$1" prompt="$2"
  local has="" ; [[ -n "${!var:-}" ]] && has=" (currently set — Enter keeps it)"
  drain_tty
  printf '  %s%s: ' "$prompt" "$has" >&2
  local answer='' ch
  # -s so bash echoes nothing; we echo the dots. -n1 reads one char at a time so
  # a paste streams in as a run of dots. read returns non-zero at EOF/newline.
  while IFS= read -r -s -u 3 -n1 ch; do
    if [[ -z "$ch" ]]; then break; fi                     # Enter
    if [[ "$ch" == $'\x7f' || "$ch" == $'\b' ]]; then      # backspace / delete
      if [[ -n "$answer" ]]; then answer="${answer%?}"; printf '\b \b' >&2; fi
    else
      answer+="$ch"; printf '\xe2\x80\xa2' >&2             # a • per character
    fi
  done
  printf '\n' >&2
  # An `[[ -n "$answer" ]] && printf ...` here returns NON-ZERO when the answer is
  # empty (Enter pressed to keep an existing secret) — and since this function is
  # called as a bare statement under the caller's `set -e`, that non-zero status
  # kills the whole script at the prompt. Use an explicit `if` and return 0.
  if [[ -n "$answer" ]]; then printf -v "$var" '%s' "$answer"; fi
  return 0
}

# A yes/no, default yes.
confirm_yes() {
  local prompt="$1" answer
  drain_tty
  printf '  %s [Y/n]: ' "$prompt" >&2
  read -r -u 3 answer || true
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

  # Dev bypass pinned OFF: a production process refuses it anyway, and a
  # bootstrap offering to turn it on would be offering to break itself.
  DEV_BYPASS_DANMAKU=0

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
    printf 'ADMIN_OPEN_IDS=%s\n' "$ADMIN_OPEN_IDS"
    printf 'SESSION_SECRET=%s\n' "$SESSION_SECRET"
    printf 'DATA_DIR=%s\n' "$DATA_DIR"
    printf 'MAX_CLIPS_PER_BATCH=%s\n' "$MAX_CLIPS_PER_BATCH"
    printf 'MAX_FILE_BYTES=%s\n' "$MAX_FILE_BYTES"
    printf 'DEV_BYPASS_DANMAKU=%s\n' "$DEV_BYPASS_DANMAKU"
  } >>"$tmp"
  mv "$tmp" "$out"
  chmod 600 "$out"
}
