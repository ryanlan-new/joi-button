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
SHARED_DIR_OWNED=0
if [ -z "$SHARED_DIR" ] && [ "${SMOKE_SHARED:-0}" = "1" ]; then
  SHARED_DIR="$(mktemp -d)"
  SHARED_DIR_OWNED=1
  trap 'cleanup; rm -rf "$SHARED_DIR"' EXIT INT TERM
fi
WALLPAPER="0000000000000000000000000000000000000000000000000000000000000001.png"
# The branding favicon (STORY-068), spelled the way lib/branding.mjs names one:
# 64 hex plus an extension, the only form its FAVICON_NAME_PATTERN accepts. Same
# double duty as WALLPAPER above — seeded below when a shared directory is given
# so the cache rules can be asserted, and used as a CSP probe either way, because
# `^~ /branding/` declares `always` and answers a missing file with the headers.
BRANDING_FAVICON="0000000000000000000000000000000000000000000000000000000000000002.png"
if [ -n "$SHARED_DIR" ]; then
  mkdir -p "${SHARED_DIR}/media/tmp" "${SHARED_DIR}/wallpaper"
  [ -e "${SHARED_DIR}/catalog.json" ] || printf '{"version":1,"groups":[],"clips":[]}\n' > "${SHARED_DIR}/catalog.json"
  # Not real audio: nginx serves bytes and never parses them. What matters is
  # that the file exists, so a 404 means the location refused it rather than
  # that there was nothing there.
  [ -e "${SHARED_DIR}/media/deadbeef01234567.mp3" ] || printf 'published\n' > "${SHARED_DIR}/media/deadbeef01234567.mp3"
  [ -e "${SHARED_DIR}/media/tmp/staged0123456789.mp3" ] || printf 'staged\n' > "${SHARED_DIR}/media/tmp/staged0123456789.mp3"
  # The theme, in the two pieces the API writes: a stylesheet at a STABLE name,
  # and a wallpaper at a content-addressed one. The cache rules they get are
  # opposites, and the fixture names are what make that checkable — so the
  # wallpaper's name is a real 64-hex-plus-extension one, the only spelling
  # schema.sql's CHECK constraint permits.
  [ -e "${SHARED_DIR}/theme.css" ] || printf ':root{--cream:#102030}\n' > "${SHARED_DIR}/theme.css"
  # Not a real PNG, for the same reason the media fixture is not real audio.
  [ -e "${SHARED_DIR}/wallpaper/${WALLPAPER}" ] || printf 'wallpaper\n' > "${SHARED_DIR}/wallpaper/${WALLPAPER}"
  # A CRASH LEFTOVER, and it has to be a real file for the same reason
  # media/tmp/ does. server/lib/wallpaper.mjs and server/lib/catalog.mjs write
  # through a dot-prefixed temp file in the TARGET's own directory (rename is
  # atomic only within one filesystem, so it cannot live anywhere else) and rely
  # on nginx never serving a dot segment. It did serve them: `^~ /wallpaper/`
  # and `^~ /media/` are prefix locations, and a prefix match ends location
  # matching before the top-level `location ~ /\.` regex is ever tried — so a
  # half-written picture was answered 200 with `public, immutable`, i.e. pinned
  # in every cache that fetched it for a year. These two fixtures are the only
  # thing that can tell that state from this one.
  #
  # The names copy server/lib/wallpaper.mjs's TEMP_NAME_PREFIX and
  # server/lib/catalog.mjs's. Nothing derives them — importing either module
  # here would drag sharp and the whole API dependency tree into a script that
  # only needs curl — so what is asserted is the PROPERTY (a leading dot),
  # which is what nginx keys on, rather than the spelling.
  [ -e "${SHARED_DIR}/wallpaper/.wallpaper-tmp-probe" ] || printf 'half-written\n' > "${SHARED_DIR}/wallpaper/.wallpaper-tmp-probe"
  [ -e "${SHARED_DIR}/media/.media-tmp-probe" ] || printf 'half-written\n' > "${SHARED_DIR}/media/.media-tmp-probe"
  # The same leftover, for branding (STORY-068/077). server/lib/branding.mjs
  # writes branding.json and every favicon through a BRANDING_TEMP_PREFIX
  # ('.branding-') temp in the target's own directory and relies on exactly this
  # guard — `^~ /branding/` is a prefix location, so without its nested dotfile
  # rule a crash leftover would be answered 200 `public, immutable` and pinned in
  # every cache for a year, which is the bug this fixture exists to catch.
  mkdir -p "${SHARED_DIR}/branding"
  [ -e "${SHARED_DIR}/branding/.branding-tmp-probe" ] || printf 'half-written\n' > "${SHARED_DIR}/branding/.branding-tmp-probe"
  # The branding pair, in the two shapes the API writes and with the OPPOSITE
  # cache rules — branding.json at a stable name that must revalidate, the
  # favicon at a content-addressed one that may freeze. Getting those two the
  # wrong way round is the realistic mistake: a frozen branding.json would pin
  # every visitor to the titles and channel link that were live the first time
  # they loaded the site, for a year, with nothing the owner could do about it.
  [ -e "${SHARED_DIR}/branding.json" ] || printf '{"navTitle":{"zh-CN":"smoke-branding"}}\n' > "${SHARED_DIR}/branding.json"
  [ -e "${SHARED_DIR}/branding/${BRANDING_FAVICON}" ] || printf 'favicon\n' > "${SHARED_DIR}/branding/${BRANDING_FAVICON}"
  # READABLE BY THE CONTAINER, and this is not cosmetic. `mktemp -d` makes a 0700
  # directory owned by the invoking user; the image runs as uid 101, so on a
  # Linux bind mount — a GitHub runner, or any Linux host — nginx cannot even
  # traverse it and every shared-volume assertion below fails for a reason the
  # cluster does not have (there, fsGroup 101 owns the volume). macOS Docker
  # Desktop hides this behind its VM's permissive mapping, so it is precisely the
  # failure that passes locally and goes red in CI.
  #
  # Only the directory this script created. A caller who supplied
  # SMOKE_SHARED_DIR owns its permissions, and silently widening them would be a
  # surprise; if the container cannot read it, the named assertions say so.
  # An explicit `if`, not `[ … ] && chmod …`: as the last statement of a block
  # that form returns the test's status, which is a booby trap for the next
  # person who adds `set -e` to this file.
  if [ "$SHARED_DIR_OWNED" = "1" ]; then
    chmod -R a+rX "$SHARED_DIR"
  fi
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
# /.git/config falls through to `location /`, where no prefix location can
# shadow the dotfile regex — so on its own this proves the rule exists and NOT
# that it reaches anywhere that matters. The trees where something actually
# writes dot-prefixed files are asserted in the shared-volume section below,
# against real files put there for the purpose.
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

  echo "--- the owner's theme: a stable name and a content-addressed one"
  # The same immutable/bounded split as everywhere else in this file, and the
  # one place the two halves sit next to each other in one feature. theme.css is
  # REPLACED IN PLACE every time a theme is saved or cleared, so `immutable`
  # here would pin every visitor to the first theme they ever loaded, for a
  # year, with nothing the owner could do about it. The wallpaper's filename is
  # its own sha256, so the same label is a promise the name keeps by itself.
  check  "theme.css is served"                    "200"                        "$(code /theme.css)"
  check  "theme.css is the file on the volume"    ":root"                      "$(body /theme.css)"
  check  "theme.css revalidates every load"       "no-cache"                   "$(hdr /theme.css)"
  refute "theme.css is NOT immutable"             "immutable"                  "$(hdr /theme.css)"
  # The generic *.css rule one level down grants an hour. An exact-match
  # location is decided before any regex is tried, so it cannot reach here —
  # this refutation is what proves that ordering rather than assuming it.
  refute "theme.css is not frozen for an hour"    "max-age=3600"               "$(hdr /theme.css)"
  check  "theme.css carries an ETag"              "etag:"                      "$(hdr /theme.css)"
  check  "theme.css is text/css"                  "text/css"                   "$(hdr /theme.css)"
  check  "wallpaper is served"                    "200"                        "$(code "/wallpaper/${WALLPAPER}")"
  check  "wallpaper is immutable"                 "immutable"                  "$(hdr "/wallpaper/${WALLPAPER}")"
  check  "wallpaper has a year max-age"           "max-age=31536000"           "$(hdr "/wallpaper/${WALLPAPER}")"
  check  "a missing wallpaper is 404"             "404"                        "$(code /wallpaper/absent.png)"
  # Branding: the same stable-vs-content-addressed split the theme has, and the
  # reason App.vue can fetch /branding.json on every load and see an edit made a
  # minute ago without a rebuild.
  check  "branding.json is served"                "200"                        "$(code /branding.json)"
  check  "branding.json is the file on the volume" "smoke-branding"            "$(body /branding.json)"
  check  "branding.json revalidates every load"   "no-cache"                   "$(hdr /branding.json)"
  refute "branding.json is NOT immutable"         "immutable"                  "$(hdr /branding.json)"
  check  "the branding favicon is served"         "200"                        "$(code "/branding/${BRANDING_FAVICON}")"
  check  "the branding favicon is immutable"      "immutable"                  "$(hdr "/branding/${BRANDING_FAVICON}")"
  check  "a missing favicon is 404"               "404"                        "$(code /branding/absent.png)"

  # A REAL half-written upload, seeded above, that must not be readable. The
  # sibling assertion is the important one: a 200 here would ALSO be labelled
  # `public, immutable, max-age=31536000` by the block that serves it, which is
  # not a leak that stops when the file is cleaned up — every cache that fetched
  # it holds the partial image for a year. Both directions are checked because
  # they fail differently.
  check  "a wallpaper temp file is refused"       "404"                        "$(code /wallpaper/.wallpaper-tmp-probe)"
  refute "a refused temp file is not frozen"      "immutable"                  "$(hdr /wallpaper/.wallpaper-tmp-probe)"
  refute "a refused temp file leaks no bytes"     "half-written"               "$(body /wallpaper/.wallpaper-tmp-probe)"
  check  "a media temp file is refused"           "404"                        "$(code /media/.media-tmp-probe)"
  refute "a refused media temp file is not frozen" "immutable"                 "$(hdr /media/.media-tmp-probe)"
  # The branding half of the same guard. lib/branding.mjs's atomic writes are
  # only safe because this rule exists, and nothing else in the suite asks nginx
  # whether it does.
  check  "a branding temp file is refused"        "404"                        "$(code /branding/.branding-tmp-probe)"
  refute "a refused branding temp is not frozen"  "immutable"                  "$(hdr /branding/.branding-tmp-probe)"
  refute "a refused branding temp leaks no bytes" "half-written"               "$(body /branding/.branding-tmp-probe)"
  # /voices/ has the same `^~` shadowing and the same nested rule, but it is
  # served off the image's own read-only layer — there is no way to seed a
  # fixture there, and asserting 404 on a file that does not exist is a check
  # that cannot go red. It is stated here rather than faked.
else
  echo "--- no shared volume mounted: the site must still work without the API"
  check  "the site serves without a catalogue"    "200"                        "$(code /)"
  check  "catalog.json is an honest 404"          "404"                        "$(code /catalog.json)"
  # public/index.html links this stylesheet unconditionally, so this is the
  # state of EVERY deploy until an owner saves a theme — not an edge case. The
  # link must 404 rather than resolve to the SPA fallback: a 200 carrying an
  # index.html body labelled text/html would be a stylesheet the browser drops
  # anyway, but it would also mean `location = /theme.css` had stopped matching,
  # and a real theme would then be unreachable at exactly the moment it existed.
  check  "theme.css is an honest 404"             "404"                        "$(code /theme.css)"
  refute "the 404 is not the app shell"           '<div id="app">'             "$(body /theme.css)"
  # The link has to still BE there for the 404 above to be the fallback rather
  # than a coincidence. It is emitted from <body>, because html-webpack-plugin
  # appends the bundle's stylesheets to the end of <head> and a theme read
  # before app.css is a theme that loses the cascade silently — see the comment
  # in public/index.html. This assertion is what notices if that moves back.
  check  "index.html still links the theme"       "/theme.css"                 "$(body /)"
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
check  "script-src has no unsafe-inline"      "script-src 'self'"            "$(hdr /)"
check  "object-src is none"                   "object-src 'none'"               "$(hdr /)"
check  "base-uri is pinned"                   "base-uri 'self'"                 "$(hdr /)"
check  "the google font import is allowed"    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com" "$(hdr /)"
refute "script-src is not wide open"          "script-src 'self' 'unsafe-inline'" "$(hdr /)"
refute "nothing is allowed from anywhere"     "default-src *"                   "$(hdr /)"

# THE REACH. nginx's add_header is inherited only by a level that declares NO
# add_header of its own, so every location that sets any header silently drops
# the server-level ones — which is why deploy/nginx.conf keeps the policy in a
# `map` and re-emits it in every such location. One missed repetition is
# invisible in review and invisible in a single curl; it is only visible by
# asking every kind of response.
#
# THIS LOOP USED TO SAY IT ASKED EVERY KIND OF RESPONSE AND ASK EIGHT. The three
# it never reached were /catalog.json, /media/ and /voices/, and deleting the
# policy from all three left this script green at pass=99 fail=0 with the header
# genuinely gone — a gate that could not go red for the thing it was written to
# check, which is the failure mode this file opens by naming. The list below is
# the full one, and the assertion under it is what keeps it full.
#
# /theme.css, /wallpaper/, /catalog.json and /media/ are listed WITHOUT a
# shared-volume guard on purpose. Their locations declare `always`, so the
# headers are emitted whether the file is there or not, and asking for them when
# it is not there is the stronger question: it proves the repetition exists in
# the location rather than being inherited by an unmatched request falling
# through to `location /`.
#
# `location /` NEEDS ITS OWN PROBE AND `/` IS NOT IT. try_files' last parameter
# is an internal redirect, so `/` and every deep link re-run location matching
# and are answered by `location = /index.html` — measured: with the policy
# deleted from `location /` alone, `/` and `/submit` still carry it. The only
# URL this image serves DIRECTLY out of that block is /50x.html, an unhashed
# .html file from the nginx base layer that no other location matches (`html` is
# deliberately absent from the generic static rule's extension list).
#
# That makes it a fixture this repo does not own, so it is pinned in both
# directions first. If a base-image bump ever removes it, /50x.html becomes just
# another deep link: 200, carrying the app shell and `= /index.html`'s headers —
# and the CSP probe below would go on passing while covering nothing. The
# refutation is what turns that into a red line instead of a silent hole.
# Discovered, not assumed — the same treatment the app bundle and the voice file
# get above. This file comes from the nginx base layer and NOT from this
# repository, so its absence is a different event from a broken app: a base-image
# bump that drops it, or a build that clears the html root, would otherwise show
# up as the cryptic FAIL "/50x.html is not the app shell" and send the reader
# looking for a bug in the SPA fallback. Naming it here costs one exec and turns
# that into a sentence.
PROBE_HTML="$(docker exec "$NAME" sh -c 'ls /usr/share/nginx/html/50x.html 2>/dev/null')"
if [ -z "$PROBE_HTML" ]; then
  echo "NO_DIRECT_PROBE_FOR_LOCATION_SLASH"
  echo "  /usr/share/nginx/html/50x.html is not in this image."
  echo "  It is a base-image artifact (nginxinc/nginx-unprivileged), not something this"
  echo "  repository ships, and it is the ONLY url \`location /\` answers directly —"
  echo "  every other path is an internal redirect into \`= /index.html\`. Without it the"
  echo "  CSP reach loop below would still pass while covering that block with nothing."
  echo "  Either the base image changed, or this build cleared the html root."
  exit 93
fi
check  "/50x.html is served directly"         "200"                             "$(code /50x.html)"
refute "/50x.html is not the app shell"       '<div id="app">'                  "$(body /50x.html)"

# Each probe is annotated with the location it lands in, because that — not the
# URL — is what is being covered:
CSP_PROBES=(
  /                                 # location = /index.html, via try_files' internal redirect
  /50x.html                         # location /            — see above; the only direct hit
  /index.html                       # location = /index.html
  /404.html                         # location = /404.html
  /site.webmanifest                 # location = /site.webmanifest
  "$CSS_HREF"                       # location ~* ^/(js|css|img|fonts)/…hashed…
  /js/absent.12345678.js            # …the same one, on a 404
  /catalog.json                     # location = /catalog.json
  /theme.css                        # location = /theme.css
  /media/deadbeef01234567.mp3       # location ^~ /media/
  "/wallpaper/${WALLPAPER}"         # location ^~ /wallpaper/
  /branding.json                    # location = /branding.json
  "/branding/${BRANDING_FAVICON}"   # location ^~ /branding/
  "/voices/${MP3}"                  # location ^~ /voices/
  /resources/favicon/favicon.png    # location ~* \.(css|js|png|…)$  — the generic rule
  /healthz                          # declares NO add_header: proves the SERVER-level one
)
for probe in "${CSP_PROBES[@]}"; do
  check  "CSP on ${probe}"                    "content-security-policy"         "$(hdr "$probe")"
  check  "nosniff on ${probe}"                "x-content-type-options: nosniff"  "$(hdr "$probe")"
  check  "frame-options on ${probe}"          "x-frame-options: sameorigin"      "$(hdr "$probe")"
  check  "referrer-policy on ${probe}"        "referrer-policy"                  "$(hdr "$probe")"
done

# AND THE COUNT, which is what stops the list above from silently going stale.
# The loop proves every emission site it knows about; this proves it knows about
# all of them. A new location that declares any add_header must repeat the
# policy, and adding one without adding a probe would otherwise be invisible
# again — the loop would still be green and still be blind.
#
# Read out of the RUNNING container, so it is the config actually in force
# including any override passed as argv[2], not the repo's copy of it.
#
# 14 = one server-level emission + thirteen locations. Sixteen probes cover
# fourteen sites: two land in the same hashed-asset location (one on a 200, one
# on a 404), and `/` doubles up on `= /index.html` for the reason above. Twelve
# of the fourteen were proved by deleting their repetition and watching a named
# probe go red, one at a time; the two branding sites (STORY-068) were added with
# their locations and proved the same way when this count was raised — which is
# what this assertion caught in the first place, by going red on a config that
# had grown two emissions the loop above did not yet reach.
# The `emissions=` prefix is not decoration: check() is a substring match, so a
# bare "14" would also be satisfied by an actual of "114".
CSP_EMISSIONS_EXPECTED=14
CSP_EMISSIONS="$(docker exec "$NAME" grep -cF 'Content-Security-Policy  $csp' /etc/nginx/nginx.conf 2>/dev/null | tr -d '[:space:]')"
check "the reach loop covers every CSP emission in the config" \
      "emissions=${CSP_EMISSIONS_EXPECTED}" "emissions=${CSP_EMISSIONS:-unreadable}"

echo
echo "SMOKE_RESULT pass=${PASS} fail=${FAIL}"
[ "$FAIL" -eq 0 ]
