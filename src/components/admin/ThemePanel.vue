<template>
    <div>
        <p v-if="phase === 'loading'" class="adm-panel adm-empty">{{ $t("admin.common.loading") }}</p>

        <div v-else-if="phase === 'error'" class="adm-panel">
            <p class="adm-note adm-note-bad">{{ loadError }}</p>
            <button type="button" class="adm-btn" @click="load">{{ $t("admin.common.retry") }}</button>
        </div>

        <div v-else>
            <!-- ---------------- what is live right now ---------------- -->
            <div class="adm-panel">
                <div class="adm-panel-head">
                    <div>
                        <h2 class="adm-h">{{ $t("admin.theme.title") }}</h2>
                        <p class="adm-sub">{{ $t("admin.theme.delivery") }}</p>
                    </div>
                    <button type="button" class="adm-btn" :disabled="busy" @click="load">
                        {{ busy ? $t("admin.common.loading") : $t("admin.theme.reload") }}
                    </button>
                </div>

                <p class="adm-note" :class="theme === null ? 'adm-note-warn' : 'adm-note-ok'">
                    <!-- The theme's name is owner-authored text that came back from
                         the API, so it travels as an interpolation VALUE and is
                         never part of a key. Same rule as I18nTextField. -->
                    <span v-if="theme === null">{{ $t("admin.theme.activeNone") }}</span>
                    <span v-else>{{ $t("admin.theme.activeSince", { name: theme.name, at: theme.activatedAt }) }}</span>
                </p>

                <p v-if="callError" class="adm-note adm-note-bad">{{ callError }}</p>
                <!-- Warn and not bad, and the server's own words rather than ours.
                     `stylesheet_unwritten` is the one failure where the row WAS
                     stored: the theme is active and only theme.css is behind, and
                     the route's message says exactly that and names the recovery.
                     Rendering it as an error next to a hint that says "nothing was
                     stored" would send the reviewer to retype a palette they
                     already have. -->
                <p v-if="stylesheetBehind" class="adm-note adm-note-warn">{{ stylesheetBehind }}</p>
                <p v-if="outcome === 'saved'" class="adm-note adm-note-ok">{{ $t("admin.theme.saved") }}</p>
                <p v-if="outcome === 'reverted'" class="adm-note adm-note-ok">{{ $t("admin.theme.reverted") }}</p>

                <!-- The refusal, in full. Problems that name a token in the roster
                     are rendered beside that token's field instead; what is left
                     here is everything that has nowhere else to go — an unknown
                     token name, a whole-payload rejection, and the contrast rows
                     whose foreground is the literal `white` rather than a token
                     (see the note in `looseProblems`). -->
                <div v-if="problems.length > 0">
                    <p class="adm-note adm-note-bad">{{ $t("admin.theme.refused") }}</p>
                    <ul v-if="looseProblems.length > 0">
                        <li v-for="(problem, index) in looseProblems" :key="index" class="adm-bad">
                            {{ problemText(problem) }}
                            <span v-if="problem.code === 'contrast'" class="adm-mono">{{ problem.detail }}</span>
                        </li>
                    </ul>
                </div>
            </div>

            <!-- ---------------- the palette ---------------- -->
            <form class="adm-panel" @submit.prevent>
                <fieldset class="adm-fieldset">
                    <legend class="adm-legend">{{ $t("admin.theme.nameLegend") }}</legend>
                    <label class="adm-label" for="adm-theme-name">{{ $t("admin.theme.nameLabel") }}</label>
                    <input
                        id="adm-theme-name"
                        type="text"
                        class="adm-input"
                        :class="{ 'is-bad': nameProblems.length > 0 }"
                        :aria-invalid="nameProblems.length > 0 ? 'true' : 'false'"
                        aria-describedby="adm-theme-name-msg"
                        v-model="draftName">
                    <div id="adm-theme-name-msg">
                        <p class="adm-hint">{{ $t("admin.theme.nameHint") }}</p>
                        <p v-for="(problem, index) in nameProblems" :key="index" class="adm-bad">
                            {{ problemText(problem) }}
                        </p>
                    </div>
                </fieldset>

                <fieldset class="adm-fieldset">
                    <legend class="adm-legend">{{ $t("admin.theme.colours") }}</legend>
                    <p class="adm-hint">{{ $t("admin.theme.coloursHint") }}</p>

                    <!-- v-for over the ROSTER the server sent, never over a list
                         written here. A hardcoded list is a second copy of the
                         closed roster in server/lib/theme.mjs, and the day the two
                         disagree the form either omits a token the server demands
                         (every save refused, with no field to fix it in) or offers
                         one it refuses (unknown_token, from a control this screen
                         drew itself). -->
                    <div class="adm-theme-grid">
                        <div v-for="token in roster" :key="token.name" class="adm-theme-row">
                            <label class="adm-label" :for="fieldId(token.name)">{{ token.label }}</label>
                            <div class="adm-row">
                                <!-- Two controls, one value. The text box is the
                                     authority because it is the only one of the two
                                     that can hold `#rrggbbaa`: an <input type="color">
                                     has no alpha channel at all, and --content-bg is
                                     the one token allowed to be translucent. The
                                     swatch is a convenience on top of it. -->
                                <label class="adm-theme-vh" :for="swatchId(token.name)">
                                    {{ $t("admin.theme.tokenPicker", { label: token.label }) }}
                                </label>
                                <input
                                    :id="swatchId(token.name)"
                                    type="color"
                                    class="adm-theme-swatch"
                                    :value="swatchOf(token.name)"
                                    @input="setFromSwatch(token.name, $event.target.value)">
                                <input
                                    :id="fieldId(token.name)"
                                    type="text"
                                    class="adm-input adm-mono adm-theme-hex"
                                    :class="{ 'is-bad': problemsByToken[token.name] }"
                                    :aria-invalid="problemsByToken[token.name] ? 'true' : 'false'"
                                    :aria-describedby="fieldId(token.name) + '-msg'"
                                    :value="draftTokens[token.name]"
                                    @input="setToken(token.name, $event.target.value)">
                            </div>
                            <div :id="fieldId(token.name) + '-msg'">
                                <p class="adm-hint adm-mono">{{ token.name }}</p>
                                <!-- A local warning, deliberately styled as a warning
                                     and not as a refusal: this screen's copy of the
                                     hex pattern decides nothing. It exists so the
                                     swatch and the preview do not silently draw
                                     something the typed value is not. Save is never
                                     disabled by it — the server owns the verdict, and
                                     it checks sixteen things this cannot. -->
                                <p v-if="!looksLikeColour(draftTokens[token.name])" class="adm-warn">
                                    {{ $t("admin.theme.notColour") }}
                                </p>
                                <p v-for="(problem, index) in (problemsByToken[token.name] || [])"
                                   :key="index" class="adm-bad">
                                    {{ problemText(problem) }}
                                    <span v-if="problem.code === 'contrast'" class="adm-mono">{{ problem.detail }}</span>
                                </p>
                            </div>
                        </div>
                    </div>
                </fieldset>

                <!-- ---------------- the wallpaper ---------------- -->
                <fieldset class="adm-fieldset">
                    <legend class="adm-legend">{{ $t("admin.theme.wallpaper") }}</legend>
                    <p class="adm-hint">{{ $t("admin.theme.wallpaperHint") }}</p>

                    <label class="adm-label" for="adm-theme-wallpaper">{{ $t("admin.theme.wallpaperChoose") }}</label>
                    <input
                        id="adm-theme-wallpaper"
                        ref="wallpaperInput"
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        :disabled="uploading"
                        @change="uploadWallpaper">

                    <p v-if="uploading" class="adm-hint">{{ $t("admin.theme.wallpaperUploading") }}</p>
                    <p v-if="uploadError" class="adm-bad">{{ uploadError }}</p>

                    <dl v-if="draftWallpaper" class="adm-register">
                        <dt>{{ $t("admin.theme.wallpaperCurrent") }}</dt>
                        <dd class="adm-mono">{{ draftWallpaper }}</dd>
                        <!-- Only ever shown for a file THIS session uploaded: the
                             dimensions come back with the upload response, and a
                             wallpaper that was already on the theme when the page
                             opened has none. Inventing them by loading the image and
                             reading naturalWidth would report what the browser
                             decoded, not what the server stored. -->
                        <template v-if="uploaded !== null">
                            <dt>{{ $t("admin.theme.wallpaperShape") }}</dt>
                            <dd class="adm-num">{{ $t("admin.theme.wallpaperMeta", {
                                width: uploaded.width,
                                height: uploaded.height,
                                kb: kilobytes(uploaded.bytes),
                                format: uploaded.format
                            }) }}</dd>
                        </template>
                    </dl>
                    <p v-else class="adm-sub">{{ $t("admin.theme.wallpaperNone") }}</p>

                    <div class="adm-actions" v-if="draftWallpaper">
                        <button type="button" class="adm-btn" @click="removeWallpaper">
                            {{ $t("admin.theme.wallpaperRemove") }}
                        </button>
                    </div>
                    <p v-if="wallpaperChanged" class="adm-warn">{{ $t("admin.theme.wallpaperPending") }}</p>
                </fieldset>

                <!-- ---------------- the preview ---------------- -->
                <fieldset class="adm-fieldset">
                    <legend class="adm-legend">{{ $t("admin.theme.preview") }}</legend>
                    <p class="adm-hint">{{ $t("admin.theme.previewHint") }}</p>
                    <p v-if="unusableTokens.length > 0" class="adm-warn">
                        {{ $t("admin.theme.previewSubstituted", { tokens: unusableTokens.join(', ') }) }}
                    </p>

                    <!-- aria-hidden, and it holds no focusable element on purpose.
                         It is a picture of a palette; the facts on this screen are
                         the ratios the server reports and the messages beside the
                         fields, and a screen reader walking a fake navbar would be
                         reading decoration as if it were the site. (aria-hidden with
                         something tabbable inside is worse than either: reachable by
                         keyboard, invisible to the reader.) -->
                    <div class="adm-theme-preview" aria-hidden="true" :style="previewStyle">
                        <!-- The site's OWN brand and its first navbar link, read
                             from the groups that own them rather than copied into
                             admin.theme.*: a duplicate of the site's name in the
                             admin dictionary is a string nobody would think to
                             change on the day the site is renamed. -->
                        <div class="adm-theme-preview-nav">
                            <span class="adm-theme-preview-brand">{{ $t("info.title") }}</span>
                            <span class="adm-theme-preview-navlink">{{ $t("nav.submit") }}</span>
                        </div>
                        <div class="adm-theme-preview-page">
                            <div class="adm-theme-preview-content">
                                <div class="adm-theme-preview-header">{{ $t("admin.theme.previewHeader") }}</div>
                                <div class="adm-theme-preview-row">
                                    <span class="adm-theme-preview-cell">
                                        <span class="adm-theme-preview-btn">{{ $t("admin.theme.previewClip") }}</span>
                                        <span class="adm-theme-preview-state">{{ $t("admin.theme.previewResting") }}</span>
                                    </span>
                                    <span class="adm-theme-preview-cell">
                                        <span class="adm-theme-preview-btn is-hover">{{ $t("admin.theme.previewClip") }}</span>
                                        <span class="adm-theme-preview-state">{{ $t("admin.theme.previewHover") }}</span>
                                    </span>
                                </div>
                                <p class="adm-theme-preview-body">{{ $t("admin.theme.previewBody") }}</p>
                            </div>
                        </div>
                        <div class="adm-theme-preview-footer">
                            <span class="adm-theme-preview-footlink">{{ $t("admin.theme.previewFooter") }}</span>
                        </div>
                    </div>
                </fieldset>

                <div class="adm-actions">
                    <button type="button" class="adm-btn adm-btn-primary" :disabled="busy" @click="save">
                        {{ $t("admin.theme.save") }}
                    </button>
                    <button type="button" class="adm-btn adm-btn-danger"
                            :disabled="busy || theme === null" @click="revert">
                        {{ $t("admin.theme.revert") }}
                    </button>
                </div>
                <p class="adm-hint">{{ $t("admin.theme.saveHint") }}</p>
                <p class="adm-hint">{{ $t("admin.theme.revertHint") }}</p>
            </form>
        </div>
    </div>
</template>

<!--
    ===========================================================================
    THE THEME FORM
    ===========================================================================
    Sixteen colours and a picture, posted as one palette, refused as one palette.

    THE FORM IS DRAWN FROM THE SERVER'S ROSTER, NOT FROM A LIST HERE
    ----------------------------------------------------------------
    GET /api/admin/theme answers with `roster` (server/lib/theme.mjs's
    THEME_TOKENS) and `defaults` (the :root block compiled into the site's own
    bundle). Every row below comes from the first and every empty field is filled
    from the second, so this screen cannot offer a token the server refuses or
    omit one it demands. The labels are the roster's — English, because that is
    what THEME_TOKENS carries; the rest of this panel is translated.

    THE PREVIEW DOES NOT TOUCH :root
    -------------------------------
    Every token is set as a custom property on the preview element itself, so it
    is inherited by that subtree and by nothing else. Setting them on :root would
    restyle the site AND this desk — and the desk is the tool for repairing a bad
    palette, so a preview that could make the desk unreadable would take the
    repair tool down with the thing being repaired. (AdminDesk.vue's style block
    states the same rule for its own colours and is the reason it uses none of
    these tokens.)

    The preview markup is a REPLICA of the declarations in src/App.vue, not the
    site's own elements. Two reasons it has to be:
      * hover cannot be forced. The roster gates the resting fill and the hover
        fill as separate pairs, so both have to be on screen at once, and only
        one of them can be a real :hover.
      * the real surfaces are <button>s. A focusable element inside an
        aria-hidden container is reachable by keyboard and invisible to a screen
        reader, so the preview uses spans that look like buttons.
    Being a replica means it can drift from App.vue. That is why it is labelled as
    a picture and why the ratios come from the server: the eighteen pairs in
    server/lib/contrast.mjs are the fact, this is an impression of four of them.

    WHY THERE ARE TWO RAW fetch() CALLS IN HERE
    ------------------------------------------
    AdminDesk's `adminApi` exposes get() and post(), and post() JSON-encodes its
    body. The wallpaper is multipart and the revert is a DELETE, so neither fits.
    They are written out here rather than by widening that client, because this
    change owns this file and the tab wiring in AdminDesk.vue and nothing else.
    The cost is real and is stated rather than hidden: these two calls do NOT get
    the client's "is the session gone?" probe, so an expired session shows up as
    an error message on this panel instead of sending the reviewer home. Folding
    del() and upload() into createAdminApi is the fix.
-->

<style lang="scss">
/* Not scoped, same as the rest of the desk, and contained by the `.adm-` prefix
   rule AdminDesk.vue states — everything here is `.adm-theme-*`, which appears
   nowhere else in src/. It ships in the admin chunk because this component is
   only imported from AdminDesk.vue. */

.adm-theme-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 10px;
}
.adm-theme-row {
    border: 1px solid var(--adm-hair);
    border-radius: 5px;
    padding: 8px;
}
.adm-theme-row .adm-row { flex-wrap: nowrap; }
.adm-theme-hex { flex: 1 1 auto; min-width: 0; }
.adm-theme-swatch {
    flex: 0 0 auto;
    width: 42px;
    height: 32px;
    padding: 2px;
    border: 1px solid var(--adm-line);
    border-radius: 5px;
    background-color: var(--adm-surface);
    cursor: pointer;
}

/* Off-screen rather than display:none. The swatch needs a real <label> — its
   accessible name is otherwise the empty string — but two visible labels per row
   for one value is noise, so the picker's label is read and not seen.
   display:none or visibility:hidden would remove it from the accessibility tree
   as well, which is the opposite of the point. */
.adm-theme-vh {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
}

/* ---- the preview ------------------------------------------------------
   Values below mirror src/App.vue: .navbar-inner, .cate-header, .cate-body
   button and its :hover, .footer / .footer-content, and .main-content's
   --content-bg backing. Every colour is a var() read of a token this element
   sets inline, so nothing here resolves against the live site's :root. */
.adm-theme-preview {
    border: 1px solid var(--adm-line);
    border-radius: 6px;
    overflow: hidden;
    background-color: var(--cream);
    /* NOT `fixed`, which is what the generated stylesheet gives body: inside a
       200px box, a viewport-attached image samples a different part of the
       picture than the page ever will, which is a preview that lies quietly. */
    background-size: cover;
    background-position: center;
    background-repeat: no-repeat;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", Arial, sans-serif;
}
.adm-theme-preview-nav {
    background-color: var(--amber);
    color: var(--cocoa-700);
    padding: 8px 12px;
    display: flex;
    gap: 14px;
    align-items: baseline;
}
.adm-theme-preview-brand { font-size: 18px; }
.adm-theme-preview-navlink { font-size: 14px; }
.adm-theme-preview-page { padding: 12px; }
.adm-theme-preview-content {
    /* The one token that may be translucent, and the reason STORY-035 exists:
       with a wallpaper behind the page this has to be opaque, or the body text's
       contrast is decided by whatever the picture happens to hold here. With no
       wallpaper, transparent is correct and is what the site does today. */
    background-color: var(--content-bg);
    padding: 12px;
    border-radius: 6px;
}
.adm-theme-preview-header {
    background-color: var(--candy-red);
    color: #ffffff;
    border: 2px solid var(--candy-red-line);
    border-radius: 10px;
    text-align: center;
    font-size: 20px;
    margin-bottom: 12px;
}
.adm-theme-preview-row { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
.adm-theme-preview-cell { display: flex; flex-direction: column; align-items: center; }
.adm-theme-preview-btn {
    display: inline-block;
    background-color: var(--surface);
    color: var(--plum-700);
    border: 3px solid var(--candy-red);
    border-radius: 20px;
    padding: 6px 14px;
    margin: 5px;
    font-size: 14px;
}
.adm-theme-preview-btn.is-hover { background-color: var(--pink); color: var(--plum-700); }
.adm-theme-preview-state { color: var(--plum-700); font-size: 11px; }
.adm-theme-preview-body { color: var(--plum-700); font-size: 13px; margin: 10px 0 0; }
.adm-theme-preview-footer {
    background-color: var(--amber-deep);
    border-top: 3px solid var(--amber-deep);
    color: var(--cocoa-700);
    padding: 10px 12px;
    font-size: 14px;
}
.adm-theme-preview-footlink { text-decoration: underline; }
</style>

<script>
import Vue from 'vue'
import Component from 'vue-class-component'

/**
 * A COPY of the pattern in server/lib/contrast.mjs, and only ever used to keep
 * this screen's own drawing honest — the swatch, and which values the preview is
 * willing to paint with. It decides nothing: the server refuses palettes, and it
 * refuses them for reasons (eighteen contrast pairs, translucency, the wallpaper
 * rule) that no regular expression here could reproduce. If this copy ever drifts
 * from the server's, the symptom is a warning under a field that the server then
 * accepts — annoying, and not a way to store something bad.
 */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/**
 * The wallpaper filename shape, re-checked here for the same reason
 * renderThemeCss re-checks it on the server: this value goes into a `url("…")`
 * in an inline style, and a `)` or a `"` in it would end the url() and start
 * whatever came after. It arrives from our own API, so this is defence in depth
 * rather than distrust — but "it came from us" is exactly the assumption that
 * stops being true one refactor later.
 */
const WALLPAPER_FILE = /^[0-9a-f]{64}\.(?:png|jpg|webp)$/

/**
 * The refusal codes this screen has a sentence for, so that a code it does not
 * renders as the code itself rather than as a translation key path. A server that
 * grows a new reason should show the reviewer something they can act on —
 * "refused: some_new_code" is actionable, "admin.theme.problem.some_new_code" is
 * a bug report about the wrong thing.
 *
 * TWO sources, which is the thing the earlier version of this list got wrong by
 * mirroring only the first. A refusal from POST /api/admin/theme carries problems
 * from server/lib/theme.mjs's THEME_REJECTIONS (the palette) AND from
 * server/lib/theme-store.mjs's THEME_STORE_REJECTIONS (the wallpaper) in one
 * array — validateTheme runs first, then saveTheme checks the file is on the
 * volume. Missing the second pair was not hypothetical: `wallpaper_missing` is
 * what an owner gets from a restored backup, because the backup carries the
 * themes row and not the wallpaper blobs, and "Refused: wallpaper_missing" is the
 * worst possible sentence to meet at that moment.
 *
 * `stylesheet_unwritten`, the third THEME_STORE_REJECTIONS code, is deliberately
 * NOT here: it is thrown as the error's own `code`, never pushed into `problems`,
 * and it means the row was committed and the file was not — a server-side fault
 * with no field to highlight and nothing the owner can retype.
 */
const KNOWN_CODES = [
    'not_an_object',
    'unknown_token',
    'missing_token',
    'not_a_colour',
    'translucent',
    'contrast',
    'content_backing_translucent',
    'name_too_long',
    'name_empty',
    'wallpaper_malformed',
    'wallpaper_missing',
]

/** The two codes that are about the theme's NAME rather than about a colour. */
const NAME_CODES = ['name_empty', 'name_too_long']

/**
 * What a token field holds when the server sent no default for it.
 *
 * This screen keeps NO palette of its own. Every pre-filled colour comes from
 * `defaults` in GET /api/admin/theme, because the moment this file carries a
 * second copy of a token's default it is a copy that stops matching the site the
 * first time somebody edits the real one — and the form's whole promise is that
 * it opens showing what is on screen. So there is exactly one value below, and it
 * is a value for the ABSENCE of an answer, not an opinion about any token.
 *
 * WHAT THIS BRANCH IS FOR NOW, and the history matters because this comment was
 * wrong twice in one afternoon. It used to say, correctly and with a
 * measurement: `defaults` is `{}` in the DEPLOYED image, because the route
 * parsed src/App.vue at run time and Dockerfile.api copies `server/` only. That
 * was a real blocking defect — the editor opened with sixteen empty fields and
 * the first save was a guaranteed 400 — and it has since been fixed at the
 * source: routes/admin.mjs carries a frozen DEFAULT_PALETTE, and two tests hold
 * it to src/App.vue's :root block, one of them by running the route inside a
 * copy of `server/` with no src/ beside it.
 *
 * RE-MEASURED against that same server-only tree: `roster: 16, defaults: 16`.
 * So this branch is now genuinely unreachable through the deployed route, and it
 * stays only as the answer to a `defaults` that is missing a key for any reason
 * nobody has thought of — a partial response, a future token added to the roster
 * before the palette. It must never become an opinion about a colour.
 *
 * `#00000000` rather than an invented opaque colour: it is fully transparent, so
 * a form filled from it paints nothing, and validateTheme refuses it for the 15
 * tokens that must be opaque. A wrong-looking form that the server then refuses
 * is recoverable; a plausible-looking form that saves a palette nobody chose is
 * not. (--content-bg is the one token validateTheme exempts while there is no
 * wallpaper — see server/lib/theme.mjs, which owns that rule. This file does not
 * restate it.)
 */
const NO_DEFAULT = '#00000000'

function looksLikeColour(value) {
    return typeof value === 'string' && HEX.test(value.trim())
}

/** `#abc` and `#aabbccdd` alike, reduced to the `#rrggbb` an <input type="color"> accepts. */
function sixDigits(value) {
    const hex = value.trim().replace('#', '')
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex
    return '#' + full.slice(0, 6).toLowerCase()
}

/**
 * A refusal, in whichever shape it arrived.
 *
 * The agreed contract for this route is NESTED — `{ error: { code, message,
 * problems } }` — while every other route in server/routes/admin.mjs answers flat
 * (`{ error, message, details }`), which is the shape AdminDesk's `refusal()`
 * unpacks. So a nested body reaches this component with the whole error object
 * sitting in `error.code` and `error.message` reading "HTTP 400". Both are read
 * here rather than one, because a form that renders nothing when the server
 * changes shape is a form that says "saved" about a palette that was refused.
 */
function refusalOf(error) {
    const nested = error.code !== null && typeof error.code === 'object' ? error.code : null
    if (nested !== null) {
        return {
            code: nested.code || null,
            message: nested.message || error.message,
            problems: Array.isArray(nested.problems) ? nested.problems : [],
        }
    }
    return {
        code: typeof error.code === 'string' ? error.code : null,
        message: error.message,
        problems: Array.isArray(error.details) ? error.details : [],
    }
}

@Component({
    inject: ['adminApi'],
})
class ThemePanel extends Vue {
    // 'loading' -> 'ready' | 'error'
    phase = 'loading'
    loadError = ''

    /** THEME_TOKENS, straight from the server. The form is drawn from this. */
    roster = []
    /** Token -> the value compiled into the site's bundle. */
    defaults = {}
    /** The stored theme, or null when the site is on its built-in palette. */
    theme = null

    draftName = ''
    draftTokens = {}
    draftWallpaper = null

    /** The upload response for a file chosen in THIS session, or null. */
    uploaded = null

    busy = false
    uploading = false
    callError = ''
    uploadError = ''
    /**
     * The server's sentence for `stylesheet_unwritten` — the one answer that is
     * neither a success nor a refusal: the row is committed and active, and only
     * the file on the volume is behind.
     */
    stylesheetBehind = ''
    /** '' | 'saved' | 'reverted' — cleared the moment anything else is tried. */
    outcome = ''
    /** The server's problems from the last refusal. Cleared on every attempt. */
    problems = []

    get tokenNames() {
        return this.roster.map((token) => token.name)
    }

    /**
     * token -> its problems, for the ones this form has a field for.
     *
     * Absent rather than empty for a clean token, so the template can use the
     * entry itself as the "this field was refused" flag without a second lookup.
     */
    get problemsByToken() {
        const names = this.tokenNames
        const byToken = {}
        for (const problem of this.problems) {
            if (!problem.token || names.indexOf(problem.token) === -1) continue
            if (!byToken[problem.token]) byToken[problem.token] = []
            byToken[problem.token].push(problem)
        }
        return byToken
    }

    get nameProblems() {
        return this.problems.filter((problem) => NAME_CODES.indexOf(problem.code) !== -1)
    }

    /**
     * Everything with no field of its own.
     *
     * Three things land here, and the third is worth naming because it is not an
     * error case: a CONTRAST problem carries `token: row.fg`, and some pairs in
     * server/lib/contrast.mjs have the LITERAL `white` as their foreground —
     * 'category header' and 'voice button, pressed / playing'. Those problems name
     * no roster token at all, so there is no field to put them beside. Their
     * `detail` sentence names the background token, which is what the reviewer
     * needs, and it is rendered in full.
     */
    get looseProblems() {
        const names = this.tokenNames
        return this.problems.filter((problem) => {
            if (NAME_CODES.indexOf(problem.code) !== -1) return false
            return !problem.token || names.indexOf(problem.token) === -1
        })
    }

    /** Roster tokens whose typed value is not a colour, so the preview cannot use it. */
    get unusableTokens() {
        return this.tokenNames.filter((name) => !looksLikeColour(this.draftTokens[name]))
    }

    get wallpaperChanged() {
        const stored = this.theme === null ? null : this.theme.wallpaperPath
        return (this.draftWallpaper || null) !== (stored || null)
    }

    /**
     * The custom properties, set on the preview element and inherited by nothing
     * else on the page.
     *
     * EVERY roster token is written, including the ones whose typed value is not a
     * colour — those fall back to the built-in default. Leaving one unset instead
     * would let it inherit from :root, which is the LIVE theme, so a half-typed
     * value would quietly show the palette already on the site as if it were the
     * one being edited. `unusableTokens` says out loud which ones were substituted.
     */
    get previewStyle() {
        const style = {}
        for (const name of this.tokenNames) {
            const typed = this.draftTokens[name]
            if (looksLikeColour(typed)) style[name] = typed.trim().toLowerCase()
            else if (looksLikeColour(this.defaults[name])) style[name] = this.defaults[name].trim().toLowerCase()
            else style[name] = 'transparent'
        }
        if (WALLPAPER_FILE.test(String(this.draftWallpaper || ''))) {
            style.backgroundImage = 'url("/wallpaper/' + this.draftWallpaper + '")'
        }
        return style
    }

    created() {
        this.load()
    }

    async load() {
        this.busy = true
        this.callError = ''
        this.stylesheetBehind = ''
        this.outcome = ''
        this.problems = []
        try {
            const response = await this.adminApi.get('/api/admin/theme')
            const roster = Array.isArray(response.roster) ? response.roster : []
            if (roster.length === 0) {
                // Not an empty form: with no roster there is nothing to fill in and
                // no way to build a palette the server would accept, so this is a
                // failed load and says so rather than rendering a blank panel.
                this.phase = 'error'
                this.loadError = this.$t('admin.theme.noRoster')
                return
            }
            this.roster = roster
            this.defaults = response.defaults || {}
            this.adopt(response.theme || null)
            this.phase = 'ready'
        } catch (error) {
            if (error.code === 'gone') return
            this.phase = 'error'
            this.loadError = error.message
        } finally {
            this.busy = false
        }
    }

    /**
     * Fill the form from a stored theme, or from the built-in palette when there
     * is none.
     *
     * The whole object is REPLACED rather than mutated key by key: Vue 2 cannot
     * observe a property added to an object after it was made reactive, so a token
     * the roster grows would render once and then never update. Assigning the
     * finished object makes every roster key reactive at the same moment, which is
     * also why setToken() below can use a plain assignment.
     */
    adopt(theme) {
        this.theme = theme
        const tokens = {}
        for (const token of this.roster) {
            const stored = theme && theme.tokens ? theme.tokens[token.name] : undefined
            if (typeof stored === 'string') tokens[token.name] = stored
            else if (typeof this.defaults[token.name] === 'string') tokens[token.name] = this.defaults[token.name]
            else tokens[token.name] = NO_DEFAULT
        }
        this.draftTokens = tokens
        this.draftName = theme ? theme.name : ''
        this.draftWallpaper = theme ? (theme.wallpaperPath || null) : null
        // Kept only when the theme being adopted carries the very file that was
        // uploaded in this session. Clearing it unconditionally made the
        // dimensions disappear at the moment of a successful save — upload, read
        // "1600 × 900", press save, and the figures vanish, which reads as
        // something having been lost. They are still true, so they stay.
        if (this.uploaded === null || this.draftWallpaper !== this.uploaded.path) this.uploaded = null
    }

    fieldId(name) {
        return 'adm-theme-' + name.replace(/^--/, '').replace(/[^a-z0-9]+/gi, '-')
    }

    swatchId(name) {
        return this.fieldId(name) + '-swatch'
    }

    looksLikeColour(value) {
        return looksLikeColour(value)
    }

    swatchOf(name) {
        const value = this.draftTokens[name]
        // A colour input given anything it cannot parse silently displays black,
        // so an unparseable field gets an explicit black and a warning under it
        // rather than a swatch that looks like a deliberate choice.
        return looksLikeColour(value) ? sixDigits(value) : '#000000'
    }

    setToken(name, value) {
        this.draftTokens[name] = value
    }

    /**
     * The picker moved. It cannot express alpha, so an alpha channel already in
     * the field is CARRIED OVER rather than dropped — otherwise choosing a colour
     * for --content-bg would silently turn a translucent backing opaque, which is
     * the one difference on this form that changes whether a wallpaper is legal.
     */
    setFromSwatch(name, picked) {
        const current = String(this.draftTokens[name] || '')
        const alpha = looksLikeColour(current) && current.trim().length === 9 ? current.trim().slice(7) : ''
        this.draftTokens[name] = picked + alpha
    }

    kilobytes(bytes) {
        return Math.round(Number(bytes) / 1024)
    }

    /**
     * Multipart, and therefore NOT through adminApi.post, which JSON-encodes.
     *
     * No Content-Type header: fetch sets it from the FormData, including the
     * multipart boundary, and a hand-written 'multipart/form-data' would omit that
     * boundary and produce a body no parser can read.
     */
    async uploadWallpaper(event) {
        const input = event.target
        const file = input.files && input.files[0]
        if (!file) return

        this.uploading = true
        this.uploadError = ''
        this.outcome = ''
        try {
            const body = new FormData()
            body.append('file', file)
            const response = await fetch('/api/admin/theme/wallpaper', {
                method: 'POST',
                credentials: 'same-origin',
                body,
            })
            let payload = null
            try {
                payload = await response.json()
            } catch (ignored) {
                payload = null
            }
            if (!response.ok) {
                const nested = payload && payload.error && typeof payload.error === 'object' ? payload.error : null
                this.uploadError = (nested && nested.message)
                    || (payload && payload.message)
                    || ('HTTP ' + response.status)
                return
            }
            this.draftWallpaper = payload.path
            this.uploaded = {
                // Carried so adopt() can tell whether the theme it is adopting is
                // the file these figures describe.
                path: payload.path,
                bytes: payload.bytes,
                width: payload.width,
                height: payload.height,
                format: payload.format,
            }
        } catch (networkError) {
            this.uploadError = networkError.message
        } finally {
            this.uploading = false
            // Cleared so that choosing the SAME file again still fires `change`.
            // A file input whose value is unchanged does not, and the second
            // attempt after a failed upload is usually the same file.
            input.value = ''
        }
    }

    /**
     * Drops it from the FORM. The file stays on the volume and the site keeps the
     * wallpaper it has until this is saved — which is what `wallpaperPending`
     * says, because a control labelled "remove" that had already removed nothing
     * is worse than one that has not run yet.
     */
    removeWallpaper() {
        this.draftWallpaper = null
        this.uploaded = null
        this.outcome = ''
    }

    async save() {
        this.busy = true
        this.callError = ''
        this.stylesheetBehind = ''
        this.outcome = ''
        this.problems = []
        try {
            // The WHOLE palette, every time. The route stores a theme, not a diff,
            // and the contrast check is a property of the sixteen values together —
            // there is no such thing as validating one of them.
            const response = await this.adminApi.post('/api/admin/theme', {
                name: this.draftName,
                tokens: this.draftTokens,
                wallpaperPath: this.draftWallpaper,
            })
            this.adopt(response.theme || null)
            this.outcome = 'saved'
        } catch (error) {
            if (error.code === 'gone') return
            const refusal = refusalOf(error)
            if (refusal.code === 'stylesheet_unwritten') {
                // Stored and active. The `theme` this panel is holding is now the
                // OLD one, which would leave the header claiming the previous
                // palette and the revert button disabled on a theme that is in
                // fact live — so the active theme is re-read. The draft is left
                // exactly as typed, because the recovery is to press save again.
                this.stylesheetBehind = refusal.message
                await this.refreshActive()
            } else if (refusal.problems.length > 0) {
                this.problems = refusal.problems
                // The problems ARE the report; repeating the server's summary
                // sentence above them would say the same thing twice.
            } else {
                this.callError = refusal.message
            }
        } finally {
            this.busy = false
        }
    }

    /**
     * Re-read WHICH theme is active, and nothing else.
     *
     * Deliberately not load(): that refills the form from the server, and every
     * caller of this is a path where the reviewer still has unsaved edits on
     * screen that they are about to submit again.
     */
    async refreshActive() {
        try {
            const response = await this.adminApi.get('/api/admin/theme')
            this.theme = response.theme || null
        } catch (ignored) {
            // Leaves `theme` as it was. A failed second request is not evidence
            // about the first one, and guessing here would replace a stale answer
            // with an invented one.
        }
    }

    /**
     * DELETE, so not through adminApi either — see the note at the top of this
     * file. The row is not deleted; it is deactivated, and themes carries its
     * activated_at history.
     */
    async revert() {
        this.busy = true
        this.callError = ''
        this.stylesheetBehind = ''
        this.outcome = ''
        this.problems = []
        try {
            const response = await fetch('/api/admin/theme', {
                method: 'DELETE',
                credentials: 'same-origin',
            })
            let payload = null
            try {
                payload = await response.json()
            } catch (ignored) {
                payload = null
            }
            if (!response.ok) {
                const nested = payload && payload.error && typeof payload.error === 'object' ? payload.error : null
                this.callError = (nested && nested.message)
                    || (payload && payload.message)
                    || ('HTTP ' + response.status)
                return
            }
            // Only `theme` moves. The typed palette is left alone deliberately: the
            // reviewer who reverts to compare is one click from putting it back,
            // and blanking the form would make that a retype.
            this.theme = null
            this.outcome = 'reverted'
        } catch (networkError) {
            this.callError = networkError.message
        } finally {
            this.busy = false
        }
    }

    /**
     * A problem's sentence. The reason CODE is ours to translate; the `detail` on
     * a contrast row is the server's own measurement and is rendered beside this
     * as a VALUE, never as a key — it is a sentence about numbers, and handing it
     * to $t would look up a message named after it and print the path.
     */
    problemText(problem) {
        const code = KNOWN_CODES.indexOf(problem.code) === -1 ? 'unknown' : problem.code
        return this.$t('admin.theme.problem.' + code, {
            token: problem.token || '',
            max: problem.detail || '',
            code: problem.code,
        })
    }
}

export default ThemePanel
</script>
