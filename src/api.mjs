// SPDX-License-Identifier: MIT
//
// Where the API is, asked and answered in ONE place.
//
// ===========================================================================
// WHY THIS FILE EXISTS
// ===========================================================================
// It replaces two predicates that disagreed. src/App.vue read
// VUE_APP_API_BASE and treated the empty string as "not configured";
// src/catalog.mjs read the same variable and treated the empty string as
// "configured" — and its own comment told operators to set it to the empty
// string. Following that instruction produced a build that fetched the
// published catalogue while compiling out every control that could reach the
// API, with nothing on screen or in the console to say why.
//
// Worse, neither branch was ever taken: no build path set the variable at all.
// The Dockerfile, deploy/deploy-k3s.sh and .github/workflows/image.yml all pass
// PUBLIC_PATH and nothing else, so every producible image shipped a site whose
// submit entry and login control never rendered — while the ingress routed
// /api to the API Service and nginx served /catalog.json off the shared volume.
// The backend was live and only the site did not know.
//
// ===========================================================================
// TWO DECISIONS, BOTH DELIBERATE
// ===========================================================================
// 1. THERE IS NO BASE. The variable used to do two unrelated jobs — a feature
//    flag and a URL prefix — and only the flag was implemented consistently: 19
//    of the 21 call sites in this app were already root-relative ('/api/me'),
//    so any prefix other than '' or '/' would have split the app across two
//    backends, with the navbar and the submit page disagreeing about who is
//    signed in and no error anywhere.
//
//    The prefix job is deleted rather than completed, because the deployment
//    does not need it: deploy/k8s/ingress.yaml puts `path: /api` on the site's
//    OWN host, so the API is same-origin by construction. apiUrl() is kept as
//    the single call site shape — every fetch in the app goes through it — so
//    that if a cross-origin deployment ever appears there is one function to
//    change instead of twenty-one strings to find.
//
// 2. IT DEFAULTS TO ON. The old flag defaulted to off, which meant a build that
//    forgot to set it was silently crippled — and every build forgot. That
//    default made sense when GitHub Pages was a second deployment with no API;
//    Pages is retired (STORY-046, see vue.config.js), so there is one
//    deployment and it always has an API. The failure mode is now inverted: a
//    build that says nothing is fully functional, and turning the API off is
//    something you have to ASK for, in writing, with VUE_APP_API=off.
//
// The remaining static-only case is real but narrow — someone serving `dist/`
// off a plain file host to look at the buttons. `VUE_APP_API=off` builds exactly
// that: no submit entry, no account control, no catalogue fetch, no request to
// /api at all.

/**
 * Is this build allowed to talk to the API?
 *
 * @vue/cli-service substitutes the whole `process.env` expression with an object
 * literal assembled from the VUE_APP_-prefixed variables present when webpack
 * ran (lib/util/resolveClientEnv.js) — not a lookup, and no `process` shim. So
 * this is a constant for the life of the bundle and every `if (API_ENABLED)`
 * below is decided before a component renders.
 *
 * What that does NOT buy, stated because a previous version of this comment
 * claimed it and the build disproved it: with the flag off, the strings '/api/me'
 * and friends are STILL IN THE BUNDLE. Webpack cannot constant-fold a member
 * access on an object literal, so the branches survive minification; they are
 * simply never entered. The guarantee is "no request", not "no bytes", and the
 * input that falsifies it is a network log rather than a grep.
 *
 * The comparison is against the exact string 'off'. A typo ('OFF', 'false', '0')
 * therefore leaves the API on — the direction where a mistake costs a 404 in the
 * navbar rather than a site that quietly cannot be used.
 */
export const API_ENABLED = process.env.VUE_APP_API !== 'off'

/**
 * The URL for an API path.
 *
 * Same origin, always: `apiUrl('/api/me')` is '/api/me'. It exists so that the
 * app has one shape for an API call rather than twenty-one string literals, and
 * so a future cross-origin deployment is one edit here.
 *
 * @param {string} path a root-relative path beginning with '/'
 */
export function apiUrl(path) {
  return path
}

/**
 * Where the published catalogue lives.
 *
 * NOT under apiUrl(), and the distinction is load-bearing. catalog.json is
 * served by the WEB pod off the shared volume (deploy/nginx.conf pins it with an
 * exact-match `location = /catalog.json`), not by the API. That is why the site
 * keeps painting current data while the API pod is restarting, and why a
 * Recreate rollout of the API does not take the read path down with it.
 *
 * It shares API_ENABLED because the flag means "this build is deployed beside a
 * backend", which is the same condition under which a published catalogue
 * exists — not because the catalogue is an API route.
 */
export const CATALOG_URL = '/catalog.json'
