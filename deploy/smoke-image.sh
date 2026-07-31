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
# now that nothing in the served output reintroduces it. The nginx rewrite block
# stays until STORY-046 retires it; it simply has nothing left to catch.
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

echo "--- security headers"
check  "nosniff on /"                         "x-content-type-options: nosniff" "$(hdr /)"
check  "frame-options on /"                   "x-frame-options: sameorigin"     "$(hdr /)"
check  "referrer-policy on /"                 "referrer-policy"                 "$(hdr /)"
check  "nosniff survives a 404"               "x-content-type-options: nosniff" "$(hdr /js/absent.12345678.js)"
refute "no nginx version leak"                "nginx/1."                        "$(hdr /)"

echo
echo "SMOKE_RESULT pass=${PASS} fail=${FAIL}"
[ "$FAIL" -eq 0 ]
