# joi-button — Vue 2.7 static SPA, built once and served by unprivileged nginx.
#
# Build (what the first verification path does):
#   docker buildx build --platform linux/amd64 \
#     -t ghcr.io/ryanlan-new/joi-button/web:replace-me .
#
# --platform=$BUILDPLATFORM on the builder stage keeps the JS toolchain native
# to the build host (no QEMU for npm/webpack, which is where all the time goes)
# while the runtime stage is produced for the target arch.  dist/ is
# architecture-independent static text, so this is the standard split.
# The runtime stage contains no RUN instruction at all, so a cross-build never
# has to emulate a single target-arch process.

# ---------------------------------------------------------------------------
# stage 1 — build the static bundle
# ---------------------------------------------------------------------------
# node:20-alpine, not bookworm-slim.  Checked against package-lock.json
# (lockfileVersion 3) rather than assumed:
#   * no node-sass anywhere; `sass` resolves to 1.77.8, which is dart-sass
#     compiled to JS — no libsass, no node-gyp, no python needed.
#     sass-loader 10.5.2 lists node-sass only as an OPTIONAL peer.
#   * the only packages with install scripts are core-js, ejs,
#     @apollo/protobufjs, yorkie (git-hook installer, skips when .git is
#     absent — and .dockerignore removes .git) and fsevents.  Every fsevents
#     entry is {"optional":true,"os":["darwin"]}, so npm skips it on linux and
#     its node-gyp build never runs.  musl is therefore not a risk here.
#   * every dependency resolves to registry.npmjs.org (0 git/tarball URLs), so
#     the image needs no git.
# Node 20 is pinned to match .github/workflows/deploy.yml (setup-node@v4,
# node-version: 20) — the version this lockfile is proven to build under.
FROM --platform=$BUILDPLATFORM node:20-alpine AS builder

WORKDIR /app

# Manifest + lockfile first: this layer is reused on every source-only change.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# vue.config.js reads process.env.PUBLIC_PATH and falls back to the GitHub
# Pages default (/joi-button/) in production.  The container build serves from
# the domain root, so it passes '/'.
ARG PUBLIC_PATH=/
ENV PUBLIC_PATH=${PUBLIC_PATH}

# NOTE: NODE_ENV is intentionally NOT set.  vue-cli-service sets it to
# production itself, whereas exporting it before `npm ci` risks dropping the
# devDependencies that provide vue-cli-service.
#
# The grep is a real gate, not decoration: if vue.config.js ever stops honouring
# PUBLIC_PATH, the emitted index.html references /joi-button/js/* and the image
# would silently serve asset URLs that 404 at the domain root.  It fails the
# build instead.
RUN npm run build \
 && test -s dist/index.html \
 && test -d dist/voices \
 && if [ "${PUBLIC_PATH}" = "/" ] && grep -q '/joi-button/js/' dist/index.html; then \
        echo "FATAL: build used publicPath=/joi-button/; PUBLIC_PATH=${PUBLIC_PATH} was ignored by vue.config.js" >&2; \
        exit 1; \
    fi

# ---------------------------------------------------------------------------
# stage 2 — runtime
# ---------------------------------------------------------------------------
# nginx stable 1.28, alpine, unprivileged variant.  That image already runs as
# uid/gid 101, EXPOSEs 8080 and keeps its pid outside /var/run; deploy/nginx.conf
# re-states all of it explicitly so nothing depends on those defaults.
FROM nginxinc/nginx-unprivileged:1.28-alpine

LABEL org.opencontainers.image.title="joi-button web" \
      org.opencontainers.image.source="https://github.com/ryanlan-new/joi-button" \
      org.opencontainers.image.description="Static Vue 2 SPA served by unprivileged nginx on 8080"

# Full main config (see the header of deploy/nginx.conf for why it is
# nginx.conf and not conf.d/default.conf).
COPY deploy/nginx.conf /etc/nginx/nginx.conf

# Static payload.  Files land root-owned and mode 644/755 (verified: every file
# under public/ and src/ is 644, every directory 755), which uid 101 can read on
# a read-only filesystem.  This also overwrites the base image's placeholder
# index.html.
COPY --from=builder /app/dist/ /usr/share/nginx/html/

EXPOSE 8080
USER 101

# Same as the base image; restated so `docker inspect` shows it here.
# No HEALTHCHECK: the k8s probes hit GET /healthz.
CMD ["nginx", "-g", "daemon off;"]
