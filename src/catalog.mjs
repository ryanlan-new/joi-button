// SPDX-License-Identifier: MIT
//
// The catalogue: the one module that knows which clips exist, in what order, and
// what each one is called in each language.
//
// It used to be two. src/main.js imported voices.json to fold the text into the
// vue-i18n bundles; src/components/home.vue imported the SAME file again to
// render the grid. Two importers of a build-time constant is harmless. Two
// importers of a document that arrives over the network is a page whose buttons
// and whose labels can disagree — the grid from one snapshot, the messages from
// another. So there is one importer now, and the pair (messages, array) is only
// ever changed together, by installCatalog().
//
// ===========================================================================
// THE DOCUMENT
// ===========================================================================
// server/lib/catalog.mjs builds it from SQLite; deploy/nginx.conf serves it from
// the shared volume at `location = /catalog.json`. Shape:
//
//   { schemaVersion, minCompatibleVersion, mediaBaseUrl,
//     locales: [{ code, label, sortOrder, isUiDefault }],
//     groups:  [{ id, sortOrder, displayName, captions: { <locale>: text } }],
//     clips:   [{ id, groupId, sortOrder, label, path, sha256, bytes,
//                 durationSeconds, captions: { <locale>: text },
//                 source?, submitter? }] }
//
// Three properties of it are load-bearing here and are asserted by that file's
// own tests, not assumed by this one:
//   * ARRAY ORDER IS PAGE ORDER. There is no sort field a consumer applies.
//   * A locale the owner has not written is an ABSENT KEY, never "".
//   * `mediaBaseUrl` is RELATIVE ('voices/'), so the audio URL is resolved
//     against the page and no scheme or host is baked into the document.
//
// ===========================================================================
// KEYS ARE IDS, NOT DISPLAY TEXT
// ===========================================================================
// The old code keyed the i18n messages on the submitter-chosen `name` and
// `categoryName` — i.e. on the Chinese/English text itself. Two clips that a
// submitter happened to name the same thing collapsed into one message, and
// renaming a clip silently orphaned its translations in the other two
// languages. `id` is the server's immutable primary key (schema.sql refuses to
// UPDATE it: "groups.id is the i18n key and is immutable"), so `voice.<id>` and
// `voicecategory.<id>` name a subject rather than describing it.
//
// The charset is `[a-z0-9_-]` in schema.sql for a reason this module depends on:
// vue-i18n 8 resolves a key as a PATH, so a '.' or a '[' in an id would become a
// nested lookup that misses and the button would render its own key path. This
// module re-checks anyway (isUsableId) because the document arrives over the
// wire and "the server promised" is not a check.
//
// ===========================================================================
// THE BUNDLED SNAPSHOT IS A FLOOR, NOT A CACHE
// ===========================================================================
// src/voices.json is compiled into the JS chunk. It is the catalogue this site
// served for its whole life as a static deployment, and it stays compiled in as
// the floor under a failed fetch — and as what a `VUE_APP_API=off` build shows.
// It is normalised by the SAME function as the fetched document, into the same
// shape, so the fallback path is not a second, untested shape that only runs
// when something is already wrong.
//
// Its ids are synthesised (slugified names) and will never equal the server's.
// That is fine and it is why they may not be mixed: exactly one document is
// installed per page load, and its ids are only meaningful within it.

import Vue from 'vue'

import snapshot from './voices.json'
import { API_ENABLED, CATALOG_URL } from './api.mjs'

/**
 * The two top-level message groups this module owns outright.
 *
 * installCatalog() REPLACES both on every install (see setLocaleMessage below),
 * so anything else written under these names is destroyed. Exported so that
 * src/main.js can refuse a locale module that tries to claim one, instead of
 * that module's strings vanishing at boot for no visible reason.
 */
export const CATALOG_MESSAGE_GROUPS = ['voice', 'voicecategory']

/**
 * The document shape THIS build knows how to read.
 *
 * The document carries `minCompatibleVersion` precisely because a tab left open
 * across a deploy is running a JS chunk that nginx served `immutable` for a
 * year: it has to be able to ask "can I still read this?" rather than guess.
 * Bump this when this module starts REQUIRING a field the older server did not
 * emit; bump the server's MIN_COMPATIBLE_SCHEMA_VERSION when it emits a
 * document an older reader would misread. They are different questions.
 */
const READER_SCHEMA_VERSION = 1

// Matches what home.vue built by hand ('voices/' + path) and what
// server/lib/catalog.mjs exports as MEDIA_BASE_URL. Used when a document omits
// the field entirely, which only a hand-written one does.
const DEFAULT_MEDIA_BASE_URL = 'voices/'

/**
 * Root-absolute, and deliberately NOT `BASE_URL + 'catalog.json'`.
 *
 * deploy/nginx.conf pins the catalogue with an exact-match `location =
 * /catalog.json` aliased to the shared volume; there is no copy of it under the
 * app's publicPath. The web pod serves it itself — that is why the site keeps
 * working while the API pod is down, and why there is no cross-origin fetch and
 * no CORS to configure.
 */
/**
 * Is this build deployed next to a published catalogue?
 *
 * ONE predicate, imported rather than re-derived. This module and src/App.vue
 * used to read the same environment variable with two different rules, and the
 * empty string — which this file's own comment told operators to use — meant
 * "fetch the catalogue" here and "there is no API" there. The result was a site
 * that painted current data and offered no way to sign in or submit, with
 * nothing to say why. src/api.mjs now owns the question for both.
 *
 * The catalogue is NOT an API route, and CATALOG_URL is deliberately not built
 * from an API base: deploy/nginx.conf pins it with an exact-match
 * `location = /catalog.json` aliased to the shared volume, so the WEB pod serves
 * it. That is why the site keeps painting while the API pod restarts. The flag
 * is shared because "there is a backend" and "there is a published catalogue"
 * are the same deployment fact, not because this file is talking to the API.
 */

/**
 * How long first paint may wait for the catalogue before giving up on it for
 * the life of the page. See the FIRST PAINT note on startCatalogRequest().
 */
const FIRST_PAINT_BUDGET_MS = 1500

const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

/**
 * The reactive catalogue every page reads.
 *
 * Vue.observable and not a plain export: `groups` is REPLACED by installCatalog,
 * and a component that captured the old array would keep rendering it. Consumers
 * must read `catalog.groups` through a computed, never copy it into data.
 *
 * It starts empty rather than pre-loaded with the snapshot: src/main.js installs
 * a document before it mounts, so "empty" is never rendered, and pre-loading
 * would make it possible to render the floor by forgetting to install.
 */
export const catalog = Vue.observable({
  /** 'network' | 'snapshot' — which document these groups came from. */
  source: null,
  mediaBaseUrl: DEFAULT_MEDIA_BASE_URL,
  groups: [],
})

/**
 * The floor. Normalised eagerly so that a bug in the slugifier is a loud failure
 * on the first page load in dev, not a surprise on the day the network fails.
 */
export const BUNDLED_CATALOG = normaliseDocument(snapshotDocument(), 'snapshot')
if (BUNDLED_CATALOG === null) {
  throw new Error('catalog: src/voices.json does not normalise into a catalogue document')
}

/**
 * Resolves to a document that is ready to install. Never rejects, never resolves
 * to null: when there is nothing configured, when the request fails, when it is
 * too slow, or when what comes back is not a catalogue, it resolves to the
 * bundled floor.
 *
 * Started in the module body on purpose — that is the earliest instant this app
 * has, and src/main.js imports this module before jquery, bootstrap and the
 * router so the request overlaps with evaluating them rather than queueing
 * behind it.
 */
export const catalogReady = startCatalogRequest()

/**
 * Install a document: its messages first, then its groups.
 *
 * @param {import('vue-i18n').default} i18n
 * @param {Object} base   the static messages (locale files + the other pages'
 *                        locale modules), keyed by locale. The locales installed
 *                        are exactly the keys of this object.
 * @param {Object} document a document from catalogReady.
 */
export function installCatalog(i18n, base, document) {
  const locales = Object.keys(base)
  const messages = buildMessages(base, document, locales)

  // ---- ORDER TRAP: MESSAGES BEFORE THE ARRAY, ALWAYS --------------------
  // `catalog.groups` is reactive, so assigning it schedules a re-render. If the
  // array were swapped first, that render would run with the OLD messages and
  // the NEW ids — and vue-i18n 8 renders a missing key as the key path itself,
  // so for one tick every button on the page would literally read
  // "voice.abc123". Not a flicker of stale text: a flicker of machine-readable
  // debris, on the controls that play audio out loud.
  //
  // The two writes live in one function, in this order, for exactly that
  // reason. Do not split them across callers, and do not move the assignment
  // above the loop.
  for (const locale of locales) {
    // setLocaleMessage REPLACES the locale's whole message object, and that is
    // the point. mergeLocaleMessage would leave the keys of retired clips
    // behind: the button disappears (it is not in `groups`) but `voice.<id>`
    // still resolves, so an unpublish that failed to take effect looks
    // identical to one that worked. Replacing means a key exists if and only if
    // the current document names it.
    //
    // It also means `base` has to be re-applied here: the UI strings are not
    // part of the catalogue, and a bare setLocaleMessage(locale, {voice…})
    // would wipe info/action/lang and blank the navbar.
    i18n.setLocaleMessage(locale, messages[locale])
  }

  catalog.mediaBaseUrl = document.mediaBaseUrl
  catalog.source = document.source
  catalog.groups = document.groups
}

// ---------------------------------------------------------------------------
// the request
// ---------------------------------------------------------------------------

/**
 * FIRST PAINT — what this trades, and why.
 *
 * Today the buttons are in the JS chunk and appear with no request. There are
 * three ways to keep a live catalogue from spoiling that, and only one of them
 * survives what this page is:
 *
 *   1. Paint the snapshot, swap when the fetch lands. Rejected. The snapshot is
 *      known-stale by construction — it is a floor, not a cache — so the swap
 *      is not cosmetic: buttons move under a pointer that is already travelling
 *      towards one. The only interaction on this page is clicking a button that
 *      plays audio out loud, so a mis-click is a wrong clip at volume in a room
 *      that did not ask for it. That is worse than a wait.
 *   2. Spinner until the catalogue arrives. Rejected outright: it makes a fast
 *      path slower for everyone and turns a network failure into a dead page.
 *   3. Wait, but only up to a budget, and then commit for the life of the page.
 *      Chosen.
 *
 * So: the request starts at the earliest instant JS runs, first paint waits for
 * it up to FIRST_PAINT_BUDGET_MS, and whichever document wins that race is the
 * one this page uses until it is reloaded. Nothing is ever swapped under the
 * pointer, because nothing is ever swapped.
 *
 * The budget is measured from module evaluation, not from the request, so it
 * covers our own startup cost too — the visitor's wait is what is being capped,
 * not the server's share of it.
 *
 * 1500 ms: catalog.json is a same-origin file of a few kilobytes on a
 * connection that has already carried the JS chunk, so no DNS, no TLS and no new
 * connection — one round trip plus a small body, and nginx answers repeat visits
 * with a 304. If that has not landed in 1500 ms the network is in trouble and
 * the floor is the better answer.
 *
 * To falsify the claim that this does not regress first paint: build without
 * VUE_APP_API=off and there is no request at all — catalogReady
 * is an already-resolved promise, and its .then runs as a microtask, before the
 * browser paints. To see the budget expire, throttle to slow 3G and watch for
 * the console note; the page renders the floor and stays on it.
 *
 * Deliberately NOT aborted when the budget expires: the response is still worth
 * finishing, because it lands in the HTTP cache and makes the NEXT load instant.
 */
function startCatalogRequest() {
  if (!API_ENABLED) {
    return Promise.resolve(BUNDLED_CATALOG)
  }

  const request = fetchCatalog()

  return new Promise(function (resolve) {
    let settled = false
    const finish = function (document) {
      if (settled) return
      settled = true
      resolve(document === null ? BUNDLED_CATALOG : document)
    }

    const timer = setTimeout(function () {
      devWarn(
        'the catalogue did not arrive within ' +
          FIRST_PAINT_BUDGET_MS +
          'ms; rendering the bundled snapshot and not swapping it later',
      )
      finish(null)
    }, FIRST_PAINT_BUDGET_MS)

    request.then(function (document) {
      clearTimeout(timer)
      finish(document)
    })
  })
}

/** Resolves to a normalised document, or to null for every kind of failure. */
function fetchCatalog() {
  // The browserslist for this project still includes IE 11, which has no fetch
  // and gets no polyfill from core-js. Feature-detected rather than assumed, so
  // that browser gets the floor instead of a TypeError during boot.
  if (typeof fetch !== 'function') {
    return Promise.resolve(null)
  }

  // No `cache` option: nginx already serves this file with `Cache-Control:
  // no-cache`, so the browser revalidates against its ETag on its own. Forcing
  // it here would only make that promise depend on two places agreeing.
  return fetch(CATALOG_URL, { headers: { Accept: 'application/json' } })
    .then(function (response) {
      if (!response.ok) {
        throw new Error('/catalog.json answered ' + response.status)
      }
      // Throws on the SPA-fallback case (a dev server, or a host that answers a
      // missing file with index.html and a 200), which is caught below.
      return response.json()
    })
    .then(function (raw) {
      return normaliseDocument(raw, 'network')
    })
    .catch(function (error) {
      devWarn('could not read /catalog.json; keeping the bundled snapshot', error)
      return null
    })
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

/**
 * Turn an untrusted document into the nested shape the page renders, or return
 * null.
 *
 * All-or-nothing on purpose: dropping the clips that fail and keeping the rest
 * would publish a silently incomplete site, and "some buttons are missing" is
 * the one failure nobody notices. A refusal keeps the previous, complete floor
 * and says why.
 */
function normaliseDocument(raw, source) {
  const refuse = function (why) {
    devWarn('refusing the ' + source + ' catalogue: ' + why)
    return null
  }

  if (!isPlainObject(raw)) return refuse('it is not a JSON object')

  if (
    typeof raw.minCompatibleVersion === 'number' &&
    raw.minCompatibleVersion > READER_SCHEMA_VERSION
  ) {
    // This build is the old tab. Reading a document that says it needs a newer
    // reader is how a stale chunk renders a subtly wrong page instead of an
    // obviously old one.
    return refuse(
      'it requires a reader at schema version ' +
        raw.minCompatibleVersion +
        '; this build reads ' +
        READER_SCHEMA_VERSION,
    )
  }

  const mediaBaseUrl =
    raw.mediaBaseUrl === undefined ? DEFAULT_MEDIA_BASE_URL : raw.mediaBaseUrl
  if (typeof mediaBaseUrl !== 'string') return refuse('mediaBaseUrl is not a string')
  // The document is supposed to carry a RELATIVE prefix. An absolute one would
  // move every clip to another origin without anything on the page saying so.
  if (ABSOLUTE_URL.test(mediaBaseUrl)) {
    return refuse('mediaBaseUrl ' + JSON.stringify(mediaBaseUrl) + ' is absolute')
  }

  if (!Array.isArray(raw.groups)) return refuse('groups is not an array')
  if (!Array.isArray(raw.clips)) return refuse('clips is not an array')

  // Object.create(null): ids may legally contain '_' , so '__proto__' is a
  // spellable id and would otherwise hit Object.prototype's setter instead of
  // creating an entry. isUsableId refuses it as a MESSAGE key for the same
  // reason; this map is belt and braces.
  const byId = Object.create(null)
  const clipIds = Object.create(null)
  const groups = []

  for (const group of raw.groups) {
    if (!isPlainObject(group)) return refuse('a group is not an object')
    if (!isUsableId(group.id)) return refuse('a group has an unusable id: ' + JSON.stringify(group.id))
    if (byId[group.id] !== undefined) return refuse('two groups share the id ' + group.id)

    const view = {
      id: group.id,
      displayName: asText(group.displayName),
      captions: isPlainObject(group.captions) ? group.captions : {},
      // Groups are rendered even when empty. v_catalog_groups selects active
      // groups without joining clips, so a group whose clips are all still
      // unpublished IS part of the published document; hiding it here would be
      // this module quietly editing what the owner published.
      clips: [],
    }
    byId[group.id] = view
    groups.push(view)
  }

  for (const clip of raw.clips) {
    if (!isPlainObject(clip)) return refuse('a clip is not an object')
    if (!isUsableId(clip.id)) return refuse('a clip has an unusable id: ' + JSON.stringify(clip.id))
    if (clipIds[clip.id] !== undefined) return refuse('two clips share the id ' + clip.id)
    if (typeof clip.path !== 'string' || clip.path === '') {
      return refuse('clip ' + clip.id + ' has no media path')
    }
    const owner = byId[clip.groupId]
    if (owner === undefined) {
      return refuse('clip ' + clip.id + ' names group ' + JSON.stringify(clip.groupId) + ', which the document does not contain')
    }

    clipIds[clip.id] = true
    const view = {
      id: clip.id,
      label: asText(clip.label),
      captions: isPlainObject(clip.captions) ? clip.captions : {},
      path: clip.path,
      // Composed here, once. The page plays `clip.src` and never concatenates a
      // URL of its own, so where the audio lives stays a property of the
      // catalogue rather than a string literal in a template.
      src: mediaBaseUrl + clip.path,
    }
    const source = normaliseSource(clip.source)
    if (source !== null) view.source = source
    const submitter = normaliseSubmitter(clip.submitter)
    if (submitter !== null) view.submitter = submitter
    owner.clips.push(view)
  }

  return { source, mediaBaseUrl, groups }
}

/**
 * Usable as a vue-i18n key path AND as a plain-object key.
 *
 * schema.sql already constrains ids to [a-z0-9_-], which excludes '.' and
 * brackets; this repeats the part that matters because the document arrives over
 * the network. '__proto__' passes that charset but is not a key an object
 * literal can hold.
 */
function isUsableId(value) {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value !== '__proto__' &&
    value.indexOf('.') === -1 &&
    value.indexOf('[') === -1 &&
    value.indexOf(']') === -1
  )
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

/**
 * base + this document's captions, per locale.
 *
 * The catalogue half is TOTAL: every id gets a message in every installed
 * locale. That is what keeps the fallbackLocale chosen in src/main.js away from
 * catalogue keys entirely — a Japanese caption the owner has not written yet
 * cannot silently come out English, because the ja-JP message for that id
 * exists. What it holds instead is the owner's own `label` / `displayName`,
 * which is what schema.sql says those columns are for ("the last-resort text for
 * a locale with no caption row").
 *
 * The hole is then invisible to a visitor, which is the point — and audible to
 * the owner, which is what the dev-only tally below is for.
 */
function buildMessages(base, document, locales) {
  const messages = {}
  const gaps = {}

  for (const locale of locales) {
    const voice = {}
    const voicecategory = {}
    let missing = 0

    for (const group of document.groups) {
      const exactGroupCaption = pickCaption(group.captions, locale)
      const groupCaption = captionFor(group.captions, locale)
      if (exactGroupCaption === null) missing++
      voicecategory[group.id] = groupCaption === null ? lastResort(group.displayName, group.id) : groupCaption.text

      for (const clip of group.clips) {
        const exactClipCaption = pickCaption(clip.captions, locale)
        const clipCaption = captionFor(clip.captions, locale)
        if (exactClipCaption === null) missing++
        voice[clip.id] = clipCaption === null ? lastResort(clip.label, clip.id) : clipCaption.text
      }
    }

    if (missing > 0) gaps[locale] = missing
    messages[locale] = Object.assign({}, base[locale], {
      voice: voice,
      voicecategory: voicecategory,
    })
  }

  if (Object.keys(gaps).length > 0) {
    devWarn('captions the owner has not written yet, by locale (showing the label instead)', gaps)
  }

  return messages
}

/** The caption for this locale, or null when there is not one. */
function pickCaption(captions, locale) {
  const text = captions[locale]
  // '' is treated as absent. The server never emits it (an absent locale is an
  // absent key), and a hand-written document that does would otherwise render a
  // button with no text on it — a hole nobody can see.
  if (typeof text !== 'string' || text === '') return null
  return text
}

/** Resolve exact locale first, then the ruled zh-CN -> ja-JP -> en-US chain. */
export function captionFor(captions, locale) {
  const exact = pickCaption(captions, locale)
  if (exact !== null) return { text: exact, locale }
  for (const fallback of ['zh-CN', 'ja-JP', 'en-US']) {
    if (fallback === locale) continue
    const text = pickCaption(captions, fallback)
    if (text !== null) return { text, locale: fallback }
  }
  return null
}

function normaliseSource(raw) {
  if (!isPlainObject(raw)) return null
  const source = {}
  if (raw.kind === 'video' || raw.kind === 'stream') source.kind = raw.kind
  if (typeof raw.title === 'string' && raw.title !== '') source.title = raw.title
  if (typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)) source.date = raw.date
  if (Number.isInteger(raw.seconds) && raw.seconds >= 0) source.seconds = raw.seconds
  if (typeof raw.url === 'string' && /^https?:\/\/\S+$/i.test(raw.url)) source.url = raw.url
  return Object.keys(source).length === 0 ? null : source
}

function normaliseSubmitter(raw) {
  return isPlainObject(raw) && typeof raw.name === 'string' && raw.name !== '' ? { name: raw.name } : null
}

function lastResort(label, id) {
  // The id is the end of the line. It is ugly on a button, but it names the row
  // to fix, and it is only reachable for a subject with no caption in any
  // locale AND no label — which schema.sql's NOT NULL on label makes
  // unreachable for a real document.
  return typeof label === 'string' && label !== '' ? label : id
}

// ---------------------------------------------------------------------------
// the bundled snapshot
// ---------------------------------------------------------------------------

/**
 * src/voices.json, in the shape the server emits.
 *
 * The ids have to be invented: that file keys everything on submitter-chosen
 * display text ("Arctic Eggs_ah no"), which is exactly what this change stops
 * using as a key. They are slugified to the server's own [a-z0-9_-] charset —
 * not because anything downstream requires it of the snapshot, but so that the
 * floor exercises the same validation as a real document instead of a laxer
 * private path.
 */
function snapshotDocument() {
  const groups = []
  const clips = []
  const groupIds = Object.create(null)
  const clipIds = Object.create(null)

  for (const category of snapshot.voices) {
    const groupId = uniqueId(slugify(category.categoryName, 'group'), groupIds)
    groups.push({
      id: groupId,
      displayName: category.categoryName,
      captions: category.categoryDescription || {},
    })

    for (const item of category.voiceList) {
      clips.push({
        id: uniqueId(slugify(item.name, 'clip'), clipIds),
        groupId: groupId,
        label: item.name,
        path: item.path,
        captions: item.description || {},
      })
    }
  }

  return { mediaBaseUrl: DEFAULT_MEDIA_BASE_URL, groups: groups, clips: clips }
}

function slugify(text, fallback) {
  const slug = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    // 64 is schema.sql's limit; the room left over is for the collision suffix.
    .slice(0, 58)
  return slug === '' ? fallback : slug
}

function uniqueId(base, seen) {
  let id = base
  let n = 2
  while (seen[id] !== undefined) {
    id = base + '-' + n
    n++
  }
  seen[id] = true
  return id
}

// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asText(value) {
  return typeof value === 'string' ? value : ''
}

// Dev only, and the eslint-disable is required rather than tidy: .eslintrc.js
// turns no-console into an error for production builds, and lint runs before
// the NODE_ENV check gets a chance to eliminate this line.
function devWarn(message, detail) {
  if (process.env.NODE_ENV === 'production') return
  // eslint-disable-next-line no-console
  console.warn('[catalog] ' + message, detail === undefined ? '' : detail)
}
