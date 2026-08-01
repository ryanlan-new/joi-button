#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Runs the built web image the way the k8s Deployment runs it, and asserts the
# runtime contract that nothing else can assert.
#
#   Usage:  deploy/smoke-image.sh <image-ref> [nginx.conf-override]
#
# WHY THIS EXISTS AS A GATE, NOT AS A CHECKLIST
#   This is an SPA served with `try_files ... /index.html`, so almost every URL
#   answers 200 with the app shell by construction. A check that only asks "did
#   it return 200" is therefore a gate that cannot go red. Every assertion below
#   is chosen because some realistic mistake makes it fail:
#     * the read-only root filesystem plus the two emptyDir mounts is the most
#       likely way this image never starts at all (nginx creates its temp paths
#       with a single non-recursive mkdir, so a path two levels below a mount
#       aborts startup — that defect was real and was caught here);
#     * `immutable` for a year is unrecoverable if granted to a file whose name
#       does not change with its bytes, so the immutable/bounded split is checked
#       in BOTH directions;
#     * index.html must revalidate or every existing visitor keeps a stale app
#       for a year.
#
# THE ONE FAITHFULNESS CAVEAT
#   `docker run --tmpfs` produces a root:root 0755 mount, whereas the k8s
#   emptyDir gets group ownership from `fsGroup: 101`. The tmpfs mounts below
#   therefore pass uid/gid explicitly. Without that, this script fails for a
#   reason the cluster does not have. It remains an emulation: the cluster is the
#   authority, and deploy/deploy-k3s.sh asserts the deployed pod separately.
set -uo pipefail

IMAGE="${1:?usage: deploy/smoke-image.sh <image-ref> [nginx.conf-override]}"
OVERRIDE="${2:-}"
PORT="${SMOKE_PORT:-18080}"
NAME="joi-smoke-$$"
PASS=0
FAIL=0

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

# An optional stand-in for the API's shared volume. When present the locations
# that serve it are asserted; when absent the site must still work, which is
# itself a requirement (a first deploy has no API yet).
#
#   SMOKE_SHARED_DIR=<path>   use this directory
#   SMOKE_SHARED=1            make one in a temp directory and remove it after
#
# THE FIXTURES ARE SEEDED HERE, NOT EXPECTED FROM THE CALLER. A caller who
# supplied a directory missing `media/deadbeef01234567.mp3` would see
# "published media is served" fail for the wrong reason, and — worse — a caller
# who forgot `media/tmp/staged0123456789.mp3` would see the staging assertion
# PASS against a file that does not exist. That is the exact shape of false
# green this script exists to prevent, so it writes what it is about to assert
# on. Files it already finds are left alone.
SHARED_DIR="${SMOKE_SHARED_DIR:-}"
if [ -z "$SHARED_DIR" ] && [ "${SMOKE_SHARED:-0}" = "1" ]; then
  SHARED_DIR="$(mktemp -d)"
  trap 'cleanup; rm -rf "$SHARED_DIR"' EXIT INT TERM
fi
if [ -n "$SHARED_DIR" ]; then
  mkdir -p "${SHARED_DIR}/media/tmp"
  [ -e "${SHARED_DIR}/catalog.json" ] || printf '{"version":1,"groups":[],"clips":[]}\n' > "${SHARED_DIR}/catalog.json"
  # Not real audio: nginx serves bytes and never parses them. What matters is
  # that the file exists, so a 404 means the location refused it rather than
  # that there was nothing there.
  [ -e "${SHARED_DIR}/media/deadbeef01234567.mp3" ] || printf 'published\n' > "${SHARED_DIR}/media/deadbeef01234567.mp3"
  [ -e "${SHARED_DIR}/media/tmp/staged0123456789.mp3" ] || printf 'staged\n' > "${SHARED_DIR}/media/tmp/staged0123456789.mp3"
fi

RUN_ARGS=(
  --name "$NAME" -d
  --user 101:101
  --read-only
  --tmpfs "/tmp:uid=101,gid=101"
  --tmpfs "/var/cache/nginx:uid=101,gid=101"
  --cap-drop ALL
  --security-opt no-new-privileges
  -p "127.0.0.1:${PORT}:8080"
)
[ -n "${SMOKE_PLATFORM:-}" ] && RUN_ARGS+=(--platform "$SMOKE_PLATFORM")
[ -n "$SHARED_DIR" ] && RUN_ARGS+=(-v "${SHARED_DIR}:/srv/shared:ro")
[ -n "$OVERRIDE" ] && RUN_ARGS+=(-v "${OVERRIDE}:/etc/nginx/nginx.conf:ro")

if ! docker run "${RUN_ARGS[@]}" "$IMAGE" >/dev/null 2>"/tmp/${NAME}.err"; then
  echo "DOCKER_RUN_FAILED"
  cat "/tmp/${NAME}.err"
  exit 90
fi

# Bounded wait. A crash must be reported, never waited on until a CI timeout.
up=0
for _ in $(seq 1 40); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/healthz" 2>/dev/null; then up=1; break; fi
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = "true" ] || break
  /bin/sleep 0.25
done

if [ "$up" != "1" ]; then
  echo "CONTAINER_NOT_SERVING"
  echo "--- state: $(docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}}' "$NAME" 2>/dev/null)"
  echo "--- logs ---"
  docker logs "$NAME" 2>&1 | tail -15
  exit 91
fi

hdr() { curl -sS -D - -o /dev/null "http://127.0.0.1:${PORT}$1"; }
body() { curl -sS "http://127.0.0.1:${PORT}$1"; }
code() { curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}$1"; }

check() {
  if printf '%s' "$3" | grep -qiF -- "$2"; then
    printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1))
  else
    printf '  FAIL  %s\n        expected to contain: %s\n        got: %s\n' \
      "$1" "$2" "$(printf '%s' "$3" | tr '\n' '|' | cut -c1-300)"; FAIL=$((FAIL + 1))
  fi
}
refute() {
  if printf '%s' "$3" | grep -qiF -- "$2"; then
    printf '  FAIL  %s\n        must NOT contain: %s\n        got: %s\n' \
      "$1" "$2" "$(printf '%s' "$3" | tr '\n' '|' | cut -c1-300)"; FAIL=$((FAIL + 1))
  else
    printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1))
  fi
}

JS="$(docker exec "$NAME" sh -c 'ls /usr/share/nginx/html/js 2>/dev/null | grep -E "^app\..*[.]js$" | head -1')"
MP3_RAW="$(docker exec "$NAME" sh -c 'ls /usr/share/nginx/html/voices 2>/dev/null | head -1')"
[ -n "$JS" ] || { echo "NO_HASHED_APP_BUNDLE_IN_IMAGE"; exit 92; }
[ -n "$MP3_RAW" ] || { echo "NO_VOICE_FILE_IN_IMAGE"; exit 92; }
# Voice filenames carry spaces and '?' by project convention ("Cute Hummings_Ei?.mp3").
# Unencoded, curl rejects the URL and every voice assertion below fails — and the
# "not gzipped" refutation would pass for the wrong reason, because an empty
# response contains no Content-Encoding either.
MP3="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$MP3_RAW")"
printf -- '--- fixtures: bundle=%s voice=%s\n' "$JS" "$MP3_RAW"

echo "--- probe and identity"
check  "/healthz returns the probe body"      "ok"                              "$(body /healthz)"
check  "/healthz is text/plain"               "text/plain"                      "$(hdr /healthz)"
check  "process runs as uid 101"              "uid=101"                         "$(docker exec "$NAME" id 2>&1)"
refute "root filesystem is read-only"         "WRITABLE"                        "$(docker exec "$NAME" sh -c 'touch /etc/probe 2>/dev/null && echo WRITABLE || echo readonly' 2>&1)"

echo "--- entry document must revalidate"
check  "/ is 200"                             "200"                             "$(code /)"
check  "/ is no-cache"                        "no-cache"                        "$(hdr /)"
refute "/ is not immutable"                   "immutable"                       "$(hdr /)"
check  "/ declares utf-8"                     "utf-8"                           "$(hdr /)"
check  "/index.html is no-cache"              "no-cache"                        "$(hdr /index.html)"

echo "--- SPA fallback"
check  "deep link is 200"                     "200"                             "$(code /submit)"
check  "deep link serves the app shell"       '<div id="app">'                  "$(body /submit)"
check  "deep link is no-cache"                "no-cache"                        "$(hdr /submit)"
check  "real directory /voices falls back"    "200"                             "$(code /voices)"
check  "real directory /resources falls back" "200"                             "$(code /resources)"

echo "--- immutable only where the name changes with the bytes"
check  "hashed bundle is immutable"           "immutable"                       "$(hdr "/js/${JS}")"
check  "hashed bundle has a year max-age"     "max-age=31536000"                "$(hdr "/js/${JS}")"
check  "hashed bundle is gzipped"             "content-encoding: gzip"          "$(curl -sS -D - -o /dev/null -H 'Accept-Encoding: gzip' "http://127.0.0.1:${PORT}/js/${JS}")"
refute "unhashed favicon is NOT immutable"    "immutable"                       "$(hdr /resources/favicon/favicon.png)"
check  "unhashed favicon is bounded"          "max-age=3600"                    "$(hdr /resources/favicon/favicon.png)"
refute "webmanifest is NOT immutable"         "immutable"                       "$(hdr /site.webmanifest)"
check  "webmanifest MIME is pinned"           "application/manifest+json"       "$(hdr /site.webmanifest)"

echo "--- voice files"
check  "voice file is 200"                    "200"                             "$(code "/voices/${MP3}")"
check  "voice file is audio/mpeg"             "audio/mpeg"                      "$(hdr "/voices/${MP3}")"
check  "voice file is immutable"              "immutable"                       "$(hdr "/voices/${MP3}")"
check  "voice file supports byte ranges"      "accept-ranges: bytes"            "$(hdr "/voices/${MP3}")"
refute "voice file is NOT gzipped"            "content-encoding"                "$(curl -sS -D - -o /dev/null -H 'Accept-Encoding: gzip' "http://127.0.0.1:${PORT}/voices/${MP3}")"

echo "--- failures stay honest"
check  "missing voice file is 404"            "404"                             "$(code /voices/definitely-absent.mp3)"
check  "missing hashed asset is 404"          "404"                             "$(code /js/absent.12345678.js)"
refute "a 404 carries no immutable label"     "immutable"                       "$(hdr /js/absent.12345678.js)"
check  "dotfile path is 404"                  "404"                             "$(code /.git/config)"

echo "--- no build output hardcodes the GitHub Pages prefix (INC-002)"
# This assertion replaced "the legacy /joi-button/ rewrite still resolves". That
# rewrite was a MITIGATION for two files that hardcoded the prefix; INC-002 fixed
# the cause — the background moved into webpack's asset pipeline and the web
# manifest's icon became relative to the manifest URL — so the correct guard is
# now that nothing in the served output reintroduces it. STORY-046 then retired
# GitHub Pages outright: vue.config.js's production default is '/' and the nginx
# rewrite block is gone, so these two refutations are no longer belt-and-braces
# behind a mitigation — they are the check.
CSS_HREF="$(body / | sed -n 's/.*href="\([^"]*app\.[^"]*\.css\)".*/\1/p' | head -1)"
[ -n "$CSS_HREF" ] || { echo "NO_APP_STYLESHEET_IN_INDEX"; exit 92; }
refute "index.html has no /joi-button/ asset path" "/joi-button/"              "$(body / | tr '"' '\n' | grep -E '^/joi-button/')"
refute "stylesheet has no /joi-button/ asset path" "/joi-button/"              "$(body "$CSS_HREF")"
# Extract first, assert the extraction succeeded, THEN request it. Passing an
# empty path to code() would request "/" and return 200 — a check that cannot go
# red for the thing it claims to check.
# webpack emits this as `url(../img/body_bg.<hash>.svg)` — relative to the
# stylesheet's own location, which is why it survives any publicPath. Normalise
# the leading ../ (and any quoting) to an absolute request path.
BG_URL="$(body "$CSS_HREF" \
  | grep -o 'url([^)]*body_bg[^)]*)' | head -1 \
  | sed -e 's|^url(||' -e 's|)$||' -e "s|^[\"']||" -e "s|[\"']$||" \
        -e 's|^\.\./|/|' -e 's|^\([^/]\)|/\1|')"
check  "background image URL was found in the CSS" "img/body_bg."               "${BG_URL:-<none>}"
if [ -n "$BG_URL" ]; then
  check "background image is a hashed asset"       "200"                        "$(code "/${BG_URL#/}")"
else
  printf '  FAIL  %s\n' "background image is a hashed asset (no URL to request)"; FAIL=$((FAIL+1))
fi

if [ -n "$SHARED_DIR" ]; then
  echo "--- the API's shared volume, served read-only by this pod"
  check  "catalog.json is served"                 "200"                        "$(code /catalog.json)"
  check  "catalog.json revalidates every load"    "no-cache"                   "$(hdr /catalog.json)"
  refute "catalog.json is not frozen for an hour" "max-age=3600"               "$(hdr /catalog.json)"
  check  "catalog.json carries an ETag"           "etag:"                      "$(hdr /catalog.json)"
  check  "published media is served"              "200"                        "$(code /media/deadbeef01234567.mp3)"
  check  "published media is immutable"           "immutable"                  "$(hdr /media/deadbeef01234567.mp3)"
  check  "a missing media file is 404"            "404"                        "$(code /media/absent0123456789.mp3)"
  # A REAL file, put there by the caller, that must not be served. Uploads stage
  # in /srv/shared/incoming/ now, so this path is empty in normal operation —
  # which is exactly why the fixture has to exist for the assertion to mean
  # anything. Without the `location ^~ /media/tmp/` block this returns 200 and
  # the label `immutable`, i.e. an unreviewed clip published for a year.
  check  "staged upload under /media/tmp/ is refused" "404"                     "$(code /media/tmp/staged0123456789.mp3)"
  refute "a refused staged upload is not frozen"      "immutable"               "$(hdr /media/tmp/staged0123456789.mp3)"
  refute "the shared volume is not writable here" "WRITABLE"                   "$(docker exec "$NAME" sh -c 'touch /srv/shared/probe 2>/dev/null && echo WRITABLE || echo readonly' 2>&1)"
else
  echo "--- no shared volume mounted: the site must still work without the API"
  check  "the site serves without a catalogue"    "200"                        "$(code /)"
  check  "catalog.json is an honest 404"          "404"                        "$(code /catalog.json)"
fi

echo "--- security headers"
check  "nosniff on /"                         "x-content-type-options: nosniff" "$(hdr /)"
check  "frame-options on /"                   "x-frame-options: sameorigin"     "$(hdr /)"
check  "referrer-policy on /"                 "referrer-policy"                 "$(hdr /)"
check  "nosniff survives a 404"               "x-content-type-options: nosniff" "$(hdr /js/absent.12345678.js)"
refute "no nginx version leak"                "nginx/1."                        "$(hdr /)"

echo "--- content-security-policy, on EVERY response that can carry markup or code"
# The shape first, then the reach. Both matter and they fail differently: a
# policy with the wrong sources is a policy that breaks the site, and a policy
# that is only on some responses is one an attacker routes around.
check  "script-src has no unsafe-inline"      "script-src 'self' https://challenges.cloudflare.com" "$(hdr /)"
check  "object-src is none"                   "object-src 'none'"               "$(hdr /)"
check  "base-uri is pinned"                   "base-uri 'self'"                 "$(hdr /)"
check  "turnstile may render"                 "frame-src https://challenges.cloudflare.com" "$(hdr /)"
check  "the google font import is allowed"    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com" "$(hdr /)"
refute "script-src is not wide open"          "script-src 'self' 'unsafe-inline'" "$(hdr /)"
refute "nothing is allowed from anywhere"     "default-src *"                   "$(hdr /)"

# THE REACH. nginx's add_header is inherited only by a level that declares NO
# add_header of its own, so every location that sets any header silently drops
# the server-level ones — which is why deploy/nginx.conf keeps the policy in a
# `map` and re-emits it in nine places. One missed repetition is invisible in
# review and invisible in a single curl; it is only visible by asking every kind
# of response. This loop is that question.
for probe in / /index.html /site.webmanifest "$CSS_HREF" /js/absent.12345678.js /404.html; do
  check  "CSP on ${probe}"                    "content-security-policy"         "$(hdr "$probe")"
done

echo
echo "SMOKE_RESULT pass=${PASS} fail=${FAIL}"
[ "$FAIL" -eq 0 ]
