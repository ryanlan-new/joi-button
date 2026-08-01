<template>
    <!-- Nothing is rendered until the queue has answered. A non-admin sees an
         empty div for as long as one request takes and is then sent home, which
         is what a typo in the address bar already does. Rendering a heading or a
         spinner first would announce the area to exactly the person it is hidden
         from. -->
    <div v-if="phase !== 'admitted'" class="adm-probe">
        <div v-if="phase === 'unreachable'" class="adm-root adm-probe-fail">
            <p class="adm-note adm-note-bad">{{ $t("admin.error.unreachable") }}</p>
            <p class="adm-mono">{{ probeError }}</p>
            <button type="button" class="adm-btn adm-btn-primary" @click="probe">{{ $t("admin.common.retry") }}</button>
        </div>
    </div>

    <div v-else class="adm-root">
        <header class="adm-bar">
            <div class="adm-bar-title">
                <strong>{{ $t("admin.nav.title") }}</strong>
                <span class="adm-bar-who">{{ $t("admin.nav.twoStage") }}</span>
            </div>
            <nav class="adm-tabs">
                <!-- aria-pressed rather than role="tab": a real tablist owes the
                     user arrow-key navigation, and claiming the role without it
                     is worse than not claiming it. These are toggles and say so,
                     the same way home.vue's mode buttons do. -->
                <button type="button" class="adm-tab" :class="{ 'is-on': tab === 'queue' }"
                        :aria-pressed="String(tab === 'queue')" @click="tab = 'queue'">
                    {{ $t("admin.nav.queue") }}
                    <span v-if="itemCount > 0" class="adm-pill">{{ itemCount }}</span>
                </button>
                <button type="button" class="adm-tab" :class="{ 'is-on': tab === 'publish' }"
                        :aria-pressed="String(tab === 'publish')" @click="tab = 'publish'">
                    {{ $t("admin.nav.publish") }}
                </button>
                <button type="button" class="adm-tab" :class="{ 'is-on': tab === 'clips' }"
                        :aria-pressed="String(tab === 'clips')" @click="tab = 'clips'">
                    {{ $t("admin.nav.clips") }}
                </button>
                <button type="button" class="adm-tab" :class="{ 'is-on': tab === 'audit' }"
                        :aria-pressed="String(tab === 'audit')" @click="tab = 'audit'">
                    {{ $t("admin.nav.audit") }}
                </button>
                <button type="button" class="adm-tab" :class="{ 'is-on': tab === 'theme' }"
                        :aria-pressed="String(tab === 'theme')" @click="tab = 'theme'">
                    {{ $t("admin.nav.theme") }}
                </button>
                <button type="button" class="adm-tab" :class="{ 'is-on': tab === 'branding' }"
                        :aria-pressed="String(tab === 'branding')" @click="tab = 'branding'">
                    {{ $t("admin.nav.branding") }}
                </button>
                <button type="button" class="adm-tab" :class="{ 'is-on': tab === 'admins' }"
                        :aria-pressed="String(tab === 'admins')" @click="tab = 'admins'">
                    {{ $t("admin.nav.admins") }}
                </button>
            </nav>
        </header>

        <div v-show="tab === 'queue'" class="adm-split" :class="{ 'is-focused': selectedItemId !== null }">
            <div class="adm-split-list">
                <ReviewQueue
                    :queue="queue"
                    :loading="queueLoading"
                    :error="queueError"
                    :selected-item-id="selectedItemId"
                    :heard-item-ids="heardItemIds"
                    @select="selectItem"
                    @reload="loadQueue" />
            </div>
            <div class="adm-split-desk">
                <button type="button" class="adm-btn adm-back" v-if="selectedItemId !== null" @click="selectItem(null)">
                    {{ $t("admin.desk.backToQueue") }}
                </button>
                <ReviewDeskItem
                    v-if="selectedItemId !== null"
                    :key="selectedItemId"
                    :item-id="selectedItemId"
                    :heard="heardItemIds.indexOf(selectedItemId) !== -1"
                    :siblings-by-group="siblingsByGroup"
                    :next-item-id="nextItemId"
                    @heard="markHeard"
                    @decided="onDecided"
                    @open="selectItem"
                    @open-publish="tab = 'publish'" />
                <p v-else class="adm-empty">{{ $t("admin.desk.pick") }}</p>
            </div>
        </div>

        <!-- Every non-queue tab lives inside one body wrapper that carries the
             SAME top gap the queue's .adm-split has, so the first panel of any
             tab sits the same distance below the bar. Without it the bare panels
             (.adm-panel has only a bottom margin) tucked straight under the bar. -->
        <!-- v-if, not v-show: these each cost a request when they appear, and
             mounting them behind a hidden tab would spend it before anyone asked. -->
        <!-- The catalogue is re-read after a publish because that is the one
             event that changes it, and the register the desk shows is drawn
             from it. Without this the sibling captions would quietly describe
             the site as it was when this tab was opened. -->
        <div v-if="tab !== 'queue'" class="adm-tabbody">
            <PublishPanel v-if="tab === 'publish'" @published="loadCatalogue" />
            <ClipsPanel v-if="tab === 'clips'" />
            <AuditTrail v-if="tab === 'audit'" />
            <ThemePanel v-if="tab === 'theme'" />
            <BrandingPanel v-if="tab === 'branding'" />
            <AdminsPanel v-if="tab === 'admins'" />
        </div>
    </div>
</template>

<!--
    ===========================================================================
    THE REVIEW DESK
    ===========================================================================
    One person, on a laptop and sometimes a phone, turning submitted audio into
    catalogue entries. This component is the shell: it owns the API client, the
    queue, which item is open, and the record of which clips have actually been
    heard. The work happens in the children.

    WHAT THIS AREA DELIBERATELY DOES NOT DO
    ---------------------------------------
    It does not consume the site's palette tokens (--cream, --candy-red, …). The
    admin backend is meant to become one theme for the whole site later, and a
    screen whose job includes fixing a bad palette must not be rendered in that
    palette: the moment it is, one bad theme takes the tool for fixing it with
    it. Every colour below is a literal in this file's own :root-free block, and
    every pair was measured at the same thresholds src/App.vue holds itself to
    (4.5:1 for text, 3:1 for borders and rings). `npm run contrast` reads
    App.vue's tokens and cannot see these, so the numbers are recorded beside
    each declaration — that is a weaker guarantee than a gate and is written down
    as such.

    It does not own a media element either. Playback goes through the app-level
    player bus in App.vue; see ClipAudition.vue for what that costs and buys.
-->

<style lang="scss">
/* NOT scoped, and that is a decision. A scoped block compiles to [data-v-hash]
   and reaches only this component's own elements — the desk is six components,
   so scoping would mean six copies of one stylesheet. Instead every selector
   here is a descendant of .adm-root or carries the .adm- prefix, which appears
   nowhere else in src/. The containment is by naming rather than by the
   compiler, so it holds only as long as that prefix is respected.

   This block also loads with the admin chunk rather than with the site, because
   a component that is imported lazily brings its CSS with it. */

.adm-root {
    /* Local names, local values. Nothing here reads a site token, so a theme
       that sets --cream to black leaves this screen exactly as it is.
       Measured against the surfaces they actually sit on:
         ink #16202c        on surface 16.44  on page 14.27  on inset 15.19
         muted #495868      on surface  7.29  on page  6.33  on inset  6.74
         white              on accent   9.62  on danger 8.59  on bar 14.34
         accent-ink #0f3b6d on surface 11.25  on page  9.76
         danger-ink #8c1526 on surface  9.33  on danger-bg 8.19
         warn-ink #7a5200   on warn-bg  6.34
         ok-ink #1a6135     on ok-bg    6.59
         off-ink #55606d    on off-fill 5.15
         line #6f8091       on surface  4.06  on page 3.52  on inset 3.75
                            on off-fill 3.27  (>= 3, non-text)
         focus #0b2545      on surface 15.39  on page 13.35  on off-fill 12.38
       The focus ring against a FILLED button is 1.60 and is not a pair this
       screen ever renders: outline-offset holds the ring off the fill and onto
       the surface behind it, the same trick and the same reason as App.vue's
       .cate-body button:focus-visible. Do not tidy the offset away. */
    --adm-bg:        #eceff4;
    --adm-surface:   #ffffff;
    --adm-inset:     #f4f6f9;
    --adm-ink:       #16202c;
    --adm-mute:      #495868;
    --adm-line:      #6f8091;
    --adm-hair:      #d5dce4;   /* decorative only: separators, never a boundary */
    --adm-accent:    #12457f;
    --adm-accent-ink:#0f3b6d;
    --adm-danger:    #96162a;
    --adm-danger-ink:#8c1526;
    --adm-danger-bg: #fdecef;
    --adm-warn-ink:  #7a5200;
    --adm-warn-bg:   #fff4dd;
    --adm-ok-ink:    #1a6135;
    --adm-ok-bg:     #e6f4ea;
    --adm-focus:     #0b2545;
    --adm-off:       #e2e7ee;
    --adm-off-ink:   #55606d;
    --adm-bar:       #1f2b3a;

    background-color: var(--adm-bg);
    color: var(--adm-ink);
    /* Declared, not inherited: body carries a background image and a display
       face, and neither belongs behind a table of somebody's audio. */
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial,
                 "PingFang SC", "Hiragino Sans", "Noto Sans CJK SC", sans-serif;
    font-size: 14px;
    line-height: 1.5;
    padding: 12px;
    /* Cancels .container-fluid's 15px side gutter so the area is full-bleed.
       Horizontal only: a negative top margin would tuck the panel under the
       fixed navbar the moment that navbar wraps to two lines on a phone. */
    margin: 0 -15px;
    min-height: 100vh;
}
.adm-root *, .adm-root *::before, .adm-root *::after { box-sizing: border-box; }
.adm-probe { min-height: 60vh; }
.adm-probe-fail { padding: 24px; }

/* ---- chrome ---------------------------------------------------------- */
.adm-bar {
    background-color: var(--adm-bar);
    color: #ffffff;
    border-radius: 6px;
    padding: 10px 14px;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    justify-content: space-between;
}
.adm-bar-title { display: flex; flex-direction: column; }
.adm-bar-who { color: #d7dde6; font-size: 12px; }   /* 11.20:1 on --adm-bar */
.adm-tabs { display: flex; flex-wrap: wrap; gap: 6px; }
.adm-tab {
    background-color: var(--adm-surface);
    color: var(--adm-accent-ink);
    border: 2px solid var(--adm-line);
    border-radius: 6px;
    padding: 5px 12px;
    font: inherit;
    cursor: pointer;
}
.adm-tab.is-on { background-color: var(--adm-accent); color: #ffffff; border-color: var(--adm-accent); }
.adm-pill {
    display: inline-block;
    margin-left: 6px;
    padding: 0 7px;
    border-radius: 9px;
    background-color: var(--adm-danger);
    color: #ffffff;
    font-size: 12px;
}
.adm-tab.is-on .adm-pill { background-color: #ffffff; color: var(--adm-danger-ink); }

/* ---- layout ---------------------------------------------------------- */
/* The top gap below the bar, shared by the queue's split and every other tab's
   body, so no tab's first panel sits tighter to the bar than another's. */
.adm-split { display: flex; gap: 12px; align-items: flex-start; margin-top: 12px; }
.adm-tabbody { margin-top: 12px; }
.adm-split-list { flex: 1 1 46%; min-width: 0; }
.adm-split-desk { flex: 1 1 54%; min-width: 0; }
.adm-back { display: none; margin-bottom: 8px; }
@media (max-width: 900px) {
    .adm-split { flex-direction: column; }
    .adm-split-list, .adm-split-desk { flex: 1 1 auto; width: 100%; }
    /* On a phone the desk is the whole screen: leaving a fifty-row queue above
       it means scrolling past the queue to reach every field. */
    .adm-split.is-focused .adm-split-list { display: none; }
    .adm-split.is-focused .adm-back { display: inline-block; }
}

/* ---- panels ---------------------------------------------------------- */
.adm-panel {
    background-color: var(--adm-surface);
    border: 1px solid var(--adm-line);
    border-radius: 6px;
    padding: 12px;
    margin-bottom: 12px;
}
.adm-panel-head {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 8px;
}
.adm-h { font-size: 15px; font-weight: 700; margin: 0; }
.adm-sub { color: var(--adm-mute); font-size: 12px; margin: 0; }
.adm-empty { color: var(--adm-mute); padding: 24px 12px; text-align: center; }
.adm-mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    word-break: break-all;
}
.adm-fieldset { border: 0; margin: 0 0 14px; padding: 0; }
.adm-legend { font-size: 13px; font-weight: 700; padding: 0; margin: 0 0 6px; border: 0; width: auto; }

/* ---- notes ----------------------------------------------------------- */
.adm-note {
    border-radius: 5px;
    padding: 8px 10px;
    margin: 0 0 10px;
    border-left: 4px solid var(--adm-line);
    background-color: var(--adm-inset);
}
.adm-note-bad  { background-color: var(--adm-danger-bg); border-left-color: var(--adm-danger); color: var(--adm-danger-ink); }
.adm-note-warn { background-color: var(--adm-warn-bg);   border-left-color: var(--adm-warn-ink); color: var(--adm-warn-ink); }
.adm-note-ok   { background-color: var(--adm-ok-bg);     border-left-color: var(--adm-ok-ink);   color: var(--adm-ok-ink); }

/* ---- controls -------------------------------------------------------- */
.adm-btn {
    background-color: var(--adm-surface);
    color: var(--adm-accent-ink);
    border: 2px solid var(--adm-line);
    border-radius: 6px;
    padding: 6px 14px;
    font: inherit;
    cursor: pointer;
}
.adm-btn-primary { background-color: var(--adm-accent); border-color: var(--adm-accent); color: #ffffff; }
.adm-btn-danger  { background-color: var(--adm-danger); border-color: var(--adm-danger); color: #ffffff; }
.adm-btn-link {
    background: none;
    border: 0;
    padding: 0;
    color: var(--adm-accent-ink);
    text-decoration: underline;
    font: inherit;
    cursor: pointer;
}
/* A real disabled attribute, never a class — the same correction App.vue made
   for the site's toggles. Bootstrap's stock .disabled is opacity .65, which
   composites the label down to an unreadable grey; the one control on this
   screen that is genuinely, meaningfully disabled has to stay legible, because
   its whole job is to be read and understood rather than clicked. */
.adm-btn[disabled] {
    background-color: var(--adm-off);
    border-color: var(--adm-line);
    color: var(--adm-off-ink);      /* 5.15:1 on the disabled fill */
    cursor: not-allowed;
}
.adm-root button:focus-visible,
.adm-root a:focus-visible,
.adm-root input:focus-visible,
.adm-root select:focus-visible,
.adm-root textarea:focus-visible {
    outline: 3px solid var(--adm-focus);
    /* Load-bearing. At offset 0 the ring lands on a filled button and measures
       1.60:1 against it; held two pixels out it lands on the surface, which is
       15.39:1. Same reasoning as App.vue's focus ring. */
    outline-offset: 2px;
}
.adm-input, .adm-textarea, .adm-select {
    width: 100%;
    background-color: var(--adm-surface);
    color: var(--adm-ink);
    border: 1px solid var(--adm-line);
    border-radius: 5px;
    padding: 6px 8px;
    font: inherit;
}
.adm-textarea { min-height: 68px; resize: vertical; }
.adm-input.is-bad, .adm-textarea.is-bad { border: 2px solid var(--adm-danger); }
.adm-label { display: block; font-size: 12px; font-weight: 700; margin-bottom: 3px; }
.adm-hint { color: var(--adm-mute); font-size: 12px; margin: 3px 0 0; }
.adm-bad  { color: var(--adm-danger-ink); font-size: 12px; margin: 3px 0 0; }
.adm-warn { color: var(--adm-warn-ink); font-size: 12px; margin: 3px 0 0; }
.adm-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.adm-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.adm-choice { display: block; margin: 4px 0; font-weight: 400; }
.adm-choice input { margin-right: 6px; }

/* ---- tables ---------------------------------------------------------- */
/* The wrapper scrolls, never the page: a batch table on a phone is wider than
   the screen and a horizontally scrolling document loses the navbar. */
.adm-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
/* Force a VISIBLE bar. macOS hides overlay scrollbars until a scroll is already
   in progress, which left the last column (the review control) both off-screen
   AND with nothing to say the row scrolls. Styling the bar makes WebKit draw the
   classic, always-on one; scrollbar-color does the same for Firefox. */
.adm-scroll { scrollbar-color: var(--adm-line) var(--adm-inset); }
.adm-scroll::-webkit-scrollbar { height: 9px; }
.adm-scroll::-webkit-scrollbar-track { background: var(--adm-inset); border-radius: 5px; }
.adm-scroll::-webkit-scrollbar-thumb { background: var(--adm-line); border-radius: 5px; }
/* The whole row is a control (see ReviewQueue.vue). Pointer + hover say so; a
   selected row keeps its own fill and does not take the hover tint. */
.adm-table tbody tr.adm-row-click { cursor: pointer; }
.adm-table tbody tr.adm-row-click:not(.is-selected):hover { background-color: var(--adm-inset); }
.adm-table { width: 100%; border-collapse: collapse; background-color: var(--adm-surface); }
.adm-table th, .adm-table td {
    border-bottom: 1px solid var(--adm-hair);
    padding: 6px 8px;
    text-align: left;
    vertical-align: top;
    white-space: nowrap;
}
.adm-table th { font-size: 12px; color: var(--adm-mute); font-weight: 700; }
.adm-table td.adm-wrap { white-space: normal; min-width: 160px; }
.adm-table tbody tr:nth-child(even) { background-color: var(--adm-inset); }
.adm-table tbody tr.is-selected { background-color: var(--adm-ok-bg); }
.adm-num { font-variant-numeric: tabular-nums; }

/* ---- the three-language grid ----------------------------------------- */
/* auto-fit, so the three languages sit side by side wherever there is room and
   stack on a phone without a breakpoint having to guess the field width. */
.adm-langs { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
.adm-register {
    background-color: var(--adm-inset);
    border: 1px dashed var(--adm-line);
    border-radius: 5px;
    padding: 5px 7px;
    margin-bottom: 5px;
    font-size: 12px;
}
.adm-register dt { color: var(--adm-mute); font-weight: 400; font-size: 11px; }
.adm-register dd { margin: 0 0 3px; }
</style>

<script>
import Vue from 'vue'
import Component from 'vue-class-component'

import ReviewQueue from './ReviewQueue.vue'
import ReviewDeskItem from './ReviewDeskItem.vue'
import PublishPanel from './PublishPanel.vue'
import ClipsPanel from './ClipsPanel.vue'
import AuditTrail from './AuditTrail.vue'
import ThemePanel from './ThemePanel.vue'
import BrandingPanel from './BrandingPanel.vue'
import AdminsPanel from './AdminsPanel.vue'

/**
 * One client for the whole admin area, so exactly one place knows how this API
 * answers somebody it does not recognise.
 *
 * Every call sends credentials explicitly. The gate in server/routes/admin.mjs
 * reads a session cookie, so a request without one is a request from a
 * stranger — and `same-origin` is the default only until somebody adds a
 * `mode` or moves the API to another host, at which point a silent 404 would
 * look exactly like "you are not an admin".
 */
function createAdminApi({ onGone }) {
    const QUEUE = '/api/admin/queue'

    async function raw(method, path, body) {
        const init = { method, credentials: 'same-origin', headers: {} }
        if (body !== undefined) {
            init.headers['Content-Type'] = 'application/json'
            init.body = JSON.stringify(body)
        }
        const response = await fetch(path, init)
        let payload = null
        try {
            payload = await response.json()
        } catch (ignored) {
            payload = null
        }
        return { response, payload }
    }

    /**
     * Turns a refusal into an Error carrying the route's own reason code and
     * details. The wording in `message` is the server's, in English, and it is
     * shown as-is: it names the column or the clip that refused, which is what
     * the person who typed the request needs, and a translated paraphrase of it
     * would be a second description of a contract that can drift.
     */
    function refusal(response, payload) {
        const error = new Error(
            (payload && payload.message) || `HTTP ${response.status}`,
        )
        error.status = response.status
        error.code = (payload && payload.error) || null
        error.details = (payload && payload.details) || null
        return error
    }

    async function call(method, path, body) {
        let attempt
        try {
            attempt = await raw(method, path, body)
        } catch (networkError) {
            // Not a refusal — nothing answered. Tagged so callers can tell "the
            // server said no" from "the server said nothing", because only one
            // of those means the session is gone.
            const error = new Error(networkError.message)
            error.status = 0
            error.code = 'network'
            error.details = null
            throw error
        }
        const { response, payload } = attempt
        if (response.ok) return payload

        if (response.status === 404 || response.status === 401 || response.status === 403) {
            // A 404 here is ambiguous by design: the gate answers a non-admin
            // with fastify's own not-found handler, and the routes answer a
            // missing item with their own 404. Rather than parse the two bodies
            // apart — a distinction that lives in whichever handler the app
            // happens to install — ask the authority: if the queue still
            // answers, the session is fine and this 404 was about the thing.
            const stillAdmin = path === QUEUE ? false : await probeQueue()
            if (!stillAdmin) {
                onGone()
                const error = refusal(response, payload)
                error.code = 'gone'
                throw error
            }
        }
        throw refusal(response, payload)
    }

    async function probeQueue() {
        try {
            const { response } = await raw('GET', QUEUE)
            return response.ok
        } catch (ignored) {
            // A network failure is not evidence that the session ended, and
            // treating it as such would throw the owner out of the tool every
            // time a train goes into a tunnel.
            return true
        }
    }

    return {
        get: (path) => call('GET', path),
        post: (path, body) => call('POST', path, body === undefined ? {} : body),
        /**
         * media.audioUrl and the catalogue are RELATIVE ('voices/ab/cd/….mp3'),
         * the convention home.vue already follows. A relative URL resolves
         * against the current PAGE, so it survives '/admin' and silently breaks
         * on '/admin/anything' — and the route's depth is not this component's
         * to choose. Resolving against the router base (webpack's publicPath:
         * '/' in the container, '/joi-button/' on Pages) makes the answer
         * independent of it. An absolute input is returned unchanged, which is
         * what happens if mediaBaseUrl is ever configured to a CDN.
         */
        siteUrl(relative) {
            const base = new URL(process.env.BASE_URL || '/', window.location.origin)
            return new URL(relative, base).href
        },
    }
}

@Component({
    components: { ReviewQueue, ReviewDeskItem, PublishPanel, ClipsPanel, AuditTrail, ThemePanel, BrandingPanel, AdminsPanel },
    provide() {
        // Built here rather than as a class property: it holds functions, not
        // state, and `data` would make Vue walk it for reactivity it can never
        // use. provide() runs after methods are installed, so this.leave exists.
        this.api = createAdminApi({ onGone: () => this.leave() })
        return { adminApi: this.api }
    },
})
class AdminDesk extends Vue {
    // 'probing' -> 'admitted' | 'unreachable'. There is no 'denied': being
    // denied is indistinguishable from the route not existing, so it leaves.
    phase = 'probing'
    probeError = ''
    tab = 'queue'

    queue = null
    queueLoading = false
    queueError = ''

    selectedItemId = null

    /**
     * The clips that have been played all the way through in THIS session.
     *
     * Deliberately not persisted. Approval is gated on having heard the clip,
     * and a flag restored from localStorage would be a gate satisfied by a
     * previous afternoon — or by anyone who opened devtools. Drafts survive a
     * closed lid because they are text nobody wants to retype; this does not,
     * because it is a claim about a person having listened.
     */
    heardItemIds = []

    /**
     * groupId -> [{ label, captions }] from the published catalogue, or null
     * when it could not be read. null and {} are different answers: "nothing
     * published in this group yet" and "I could not look" would otherwise both
     * render as an empty register, and only one of them is safe to write
     * against.
     */
    siblingsByGroup = null

    get itemCount() {
        return this.queue === null ? 0 : this.queue.itemCount
    }

    /** The first queued item that is not the one already open. */
    get nextItemId() {
        if (this.queue === null) return null
        for (const batch of this.queue.batches) {
            for (const item of batch.items) {
                if (item.itemId !== this.selectedItemId) return item.itemId
            }
        }
        return null
    }

    created() {
        this.probe()
    }

    async probe() {
        this.phase = 'probing'
        this.probeError = ''
        try {
            this.queue = await this.api.get('/api/admin/queue')
            this.phase = 'admitted'
            this.loadCatalogue()
        } catch (error) {
            // `gone` means the client already asked the router to leave.
            if (error.code === 'gone') return
            this.phase = 'unreachable'
            this.probeError = error.message
        }
    }

    leave() {
        this.phase = 'probing'
        // Exactly what router.js's `{ path: '*', redirect: '/' }` does with an
        // address nobody recognises. replace, not push: a back button that
        // returns to a page you were just refused is a loop.
        if (this.$route.path !== '/') this.$router.replace('/')
    }

    async loadQueue() {
        this.queueLoading = true
        this.queueError = ''
        try {
            this.queue = await this.api.get('/api/admin/queue')
        } catch (error) {
            if (error.code !== 'gone') this.queueError = error.message
        } finally {
            this.queueLoading = false
        }
    }

    /**
     * The published catalogue, read for one purpose: showing the captions the
     * clips already in a group carry, so a new one can be written in the same
     * register. It is a static file the site serves, not an admin route, and it
     * holds only what has been PUBLISHED — a clip approved ten minutes ago is
     * not in it. Failing to read it is not an error worth interrupting anyone
     * for; it makes the register unavailable and says so.
     */
    async loadCatalogue() {
        try {
            // Root-absolute, and deliberately NOT siteUrl('catalog.json'):
            // src/catalog.mjs owns this URL and states why — nginx serves
            // `location = /catalog.json` aliased to the shared volume, and there
            // is no copy of it under the app's publicPath. Read directly rather
            // than through that module because it is allowed to fall back to a
            // snapshot bundled into the chunk, and a register drawn from a
            // snapshot would show captions the site is no longer serving.
            const response = await fetch('/catalog.json', {
                credentials: 'same-origin',
                headers: { Accept: 'application/json' },
            })
            if (!response.ok) return
            const document = await response.json()
            if (!document || !Array.isArray(document.clips)) return
            const byGroup = {}
            for (const clip of document.clips) {
                if (!byGroup[clip.groupId]) byGroup[clip.groupId] = []
                byGroup[clip.groupId].push({ label: clip.label, captions: clip.captions || {} })
            }
            this.siblingsByGroup = byGroup
        } catch (ignored) {
            // Stays null: "could not look", not "nothing there".
        }
    }

    selectItem(itemId) {
        this.selectedItemId = itemId
        // On a narrow screen the list is hidden and the desk takes its place
        // (.adm-split.is-focused). A reviewer who had scrolled down the queue
        // would otherwise land on the desk below the fold — or on blank space
        // the vanished list left behind. Bring the area's top back into view
        // once the DOM has swapped. Instant, not smooth: the site keeps motion
        // off for whoever asks, and a scroll is not worth a special case here.
        if (itemId !== null
            && typeof window !== 'undefined'
            && typeof window.matchMedia === 'function'
            && window.matchMedia('(max-width: 900px)').matches) {
            this.$nextTick(() => {
                if (this.$el && typeof this.$el.scrollIntoView === 'function') {
                    this.$el.scrollIntoView()
                }
            })
        }
    }

    markHeard(itemId) {
        if (this.heardItemIds.indexOf(itemId) === -1) this.heardItemIds.push(itemId)
    }

    onDecided() {
        // The catalogue is not re-read here on purpose: a decision writes a
        // DRAFT clip, and catalog.json holds published ones. Publishing is what
        // moves it, and PublishPanel says so above.
        this.loadQueue()
    }
}

export default AdminDesk
</script>
