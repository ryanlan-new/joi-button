import Vue from 'vue'
import VueI18n from 'vue-i18n'

// Imported before jquery, bootstrap and the router on purpose: this module's
// body starts the request for /catalog.json, so that request overlaps with the
// evaluation of everything below it instead of queuing behind it. See the FIRST
// PAINT note in src/catalog.mjs.
import { catalogReady, installCatalog, CATALOG_MESSAGE_GROUPS } from './catalog.mjs'

import router from './router'

import App from './App.vue'

import en_US from './locales/en-US'
import zh_CN from './locales/zh-CN'
import ja_JP from './locales/ja-JP'

import $ from 'jquery'
global.jQuery = global.$ = $;

import 'bootstrap'
import GlobalConst from './globalconst'

/**
 * The locales this site ships.
 *
 * Everything else is derived from these keys — which locales get messages
 * installed, which locale codes a page's locale module may declare, which files
 * under src/locales are the base files. Adding a fourth language is one entry
 * here and one file, not a hunt through this file for the places that say three.
 */
const BASE_LOCALES = {
  'en-US': en_US,
  'zh-CN': zh_CN,
  'ja-JP': ja_JP
}

/**
 * Every page's own strings, FOUND rather than listed.
 *
 * The contract between the pages: nobody edits src/locales/{zh-CN,en-US,ja-JP}.js.
 * Each feature writes a module that exports the three languages together under
 * one top-level group it owns —
 *
 *     export default { 'zh-CN': { mypage: {…} }, 'en-US': { mypage: {…} }, … }
 *
 * — and drops it anywhere under src/locales/. `true` is the recursive flag, so a
 * subdirectory works too.
 *
 * This replaced a hand-written list, which is not a style preference: at the
 * moment it was replaced, that list read `for (const mod of [nav])` while
 * src/locales/submit.js was already in the repository — several hundred strings
 * imported by nothing, every one of them rendering as its own key path. A list
 * that has to be edited by whoever adds a file is a list that silently skips one.
 *
 * require.context is resolved by webpack at build time, so this is a compiled-in
 * set of imports, not a runtime directory scan.
 */
const LOCALE_MODULES = require.context('./locales', true, /\.js$/)

Vue.config.productionTip = false

Vue.use(VueI18n)
Vue.use(GlobalConst);

let locale = 'en-US';
if(/ja/i.test(navigator.language)){
  locale = 'ja-JP';
}
else if(/cn/i.test(navigator.language)) {
  locale = 'zh-CN';
}

const i18n = new VueI18n({
  locale,

  // DECIDED, not inherited. Constructed without this option, vue-i18n 8 applies
  // its own built-in default of 'en-US' (`options.fallbackLocale === false ?
  // false : options.fallbackLocale || 'en-US'`), which is what this app has been
  // silently running on. Three candidates:
  //
  //   false     every miss renders its own key path. Loudest for us, and the
  //             worst answer for a visitor: the site would break for a fan
  //             because a translator was behind.
  //   'zh-CN'   the owner writes Chinese first, so it is the most complete —
  //             but handing Chinese to a Japanese reader is a worse answer than
  //             handing them English.
  //   'en-US'   kept. It is the behaviour this site already has, so this change
  //             moves no string on the page, and English is the one of the
  //             three most likely to be readable by someone who wanted either
  //             of the others.
  //
  // What makes keeping it safe is new. The hazard with any fallback is a
  // missing zh-CN key silently rendering English — and CATALOGUE keys can no
  // longer be missing: installCatalog() writes a message for every id in every
  // installed locale, and where a caption has not been written it falls back to
  // the owner's own label rather than to another language (buildMessages in
  // src/catalog.mjs). Measured: with a ja-JP caption absent, the button renders
  // the label, not the Chinese caption and not the key path. So this chain now
  // only ever covers UI strings, where src/locales/*.js are three independent
  // files rather than translations of one another (only zh-CN has
  // info.audioStaff), and a gap is a gap in this repository that whoever opens
  // the file can see.
  fallbackLocale: 'en-US',

  // Both are already false by default; pinned because the decision above depends
  // on a fallback being AUDIBLE while developing. vue-i18n silences these in
  // production builds itself, so this costs a visitor nothing.
  silentTranslationWarn: false,
  silentFallbackWarn: false

  // No `messages` here. installCatalog() is the only writer of the message tree,
  // and it uses setLocaleMessage for the boot install exactly as it would for a
  // later one — so the path that has to work is the path that runs every time,
  // instead of boot taking a shortcut nothing else exercises.
})

const baseMessages = buildBaseMessages()

catalogReady.then(function (document) {
  // installCatalog installs the messages BEFORE it swaps the array — the order
  // trap is stated at that call site — and this mounts after both, so the very
  // first render already has ids and messages that agree.
  //
  // When no catalogue is configured (GitHub Pages, `npm run serve`), catalogReady
  // is an already-resolved promise and this callback runs as a microtask, which
  // the browser flushes before it paints. That is why those builds still show
  // their buttons with no request and no extra frame.
  installCatalog(i18n, baseMessages, document)

  new Vue({
    router,
    i18n,
    render: h => h(App)
  }).$mount('#app')
})

/**
 * The static half of the message tree: the three locale files, plus every page's
 * locale module, merged one top-level group at a time.
 */
function buildBaseMessages() {
  const locales = Object.keys(BASE_LOCALES)
  // The base files are found by the same scan as everything else and recognised
  // by the name they are required to have, rather than by a second hand-written
  // list that could drift out of step with BASE_LOCALES.
  const baseFiles = locales.map(function (code) { return './' + code + '.js' })

  const merged = {}
  for (const locale of locales) {
    merged[locale] = Object.assign({}, BASE_LOCALES[locale])
  }

  // Sorted, so that which module wins a collision is deterministic and the same
  // on every machine, rather than dependent on webpack's directory order.
  const keys = LOCALE_MODULES.keys().slice().sort()
  const claimedBy = {}

  for (const key of keys) {
    if (baseFiles.indexOf(key) !== -1) continue

    const bundle = defaultExport(LOCALE_MODULES(key))
    const declared = localeBundleKeys(bundle, locales)
    if (declared === null) {
      devWarn(
        key + ' is under src/locales but does not export { "zh-CN": {…}, "en-US": {…}, "ja-JP": {…} }; ' +
        'none of its strings are installed'
      )
      continue
    }
    if (declared.unknown.length > 0) {
      devWarn(key + ' declares locales this site does not ship, which are ignored', declared.unknown)
    }
    if (declared.known.length !== locales.length) {
      // The contract is all three together. A module carrying two of them does
      // not fail — it leaves one language quietly falling back to English,
      // which is worth saying out loud, because nobody who reads only ja-JP is
      // going to file that report.
      devWarn(key + ' does not carry all ' + locales.length + ' languages; it declares', declared.known)
    }

    for (const locale of declared.known) {
      const groups = bundle[locale]
      for (const group of Object.keys(groups)) {
        if (CATALOG_MESSAGE_GROUPS.indexOf(group) !== -1) {
          // installCatalog replaces these two wholesale on every install, so
          // anything written here would disappear at boot with no symptom
          // except a missing string.
          devWarn(key + ' claims "' + group + '", which src/catalog.mjs owns and overwrites; ignored')
          continue
        }
        if (claimedBy[group] !== undefined && claimedBy[group] !== key) {
          // Two pages owning one top-level group is a merge that silently
          // deletes half of somebody's strings. First claim wins, so an
          // accidental clash cannot take out a page that already worked.
          devWarn(
            'both ' + claimedBy[group] + ' and ' + key + ' claim the top-level group "' + group +
            '"; keeping ' + claimedBy[group]
          )
          continue
        }
        claimedBy[group] = key
        merged[locale][group] = groups[group]
      }
    }
  }

  return merged
}

/**
 * Which of this site's locales a module declares, or null when it is not a
 * locale bundle at all.
 *
 * Recognised by SHAPE: at least one top-level key is a locale code this site
 * ships, and every one of those maps to an object. That is what lets the three
 * base files (whose top-level keys are info/action/lang) sit in the same
 * directory and be skipped, while a module with a typo'd locale code is
 * reported rather than silently dropped.
 */
function localeBundleKeys(value, locales) {
  if (!isPlainObject(value)) return null

  const keys = Object.keys(value)
  const known = []
  const unknown = []
  for (const key of keys) {
    if (locales.indexOf(key) !== -1) known.push(key)
    else unknown.push(key)
  }
  if (known.length === 0) return null

  for (const key of known) {
    if (!isPlainObject(value[key])) return null
  }
  return { known: known, unknown: unknown }
}

function defaultExport(module) {
  return module && module.default !== undefined ? module.default : module
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Dev only. The eslint-disable is required rather than tidy: .eslintrc.js makes
// no-console an error for production builds, and lint runs before the NODE_ENV
// test can eliminate the line.
function devWarn(message, detail) {
  if (process.env.NODE_ENV === 'production') return
  // eslint-disable-next-line no-console
  console.warn('[i18n] ' + message, detail === undefined ? '' : detail)
}
