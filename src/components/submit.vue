<template>
    <div class="container-fluid submit-page">
        <div class="cate-header">{{ $t('submit.page.title') }}</div>

        <!-- ===== this host has no API behind it ============================ -->
        <div v-if="phase === 'unavailable'" class="panel-block" aria-live="polite">
            <p class="lead-line">{{ $t('submit.error.heading') }}</p>
            <p>{{ $t(pageError === 'network' ? 'submit.error.network' : 'submit.error.apiUnavailable') }}</p>
            <div class="cate-body">
                <button class="btn btn-info" type="button" @click="loadMe">{{ $t('submit.action.tryAgain') }}</button>
                <router-link class="btn btn-new" to="/">{{ $t('submit.action.home') }}</router-link>
            </div>
        </div>

        <template v-else>
            <!-- ===== signed in: the batch editor =========================== -->
            <div v-if="phase === 'editor'">
                <p class="identity-line">
                    <span>{{ $t('submit.state.verifiedAs', { name: me.displayName }) }}</span>
                    <button class="btn btn-link" type="button" @click="signOut">{{ $t('submit.action.signOut') }}</button>
                    <router-link class="btn btn-link" to="/my">{{ $t('submit.action.toMy') }}</router-link>
                </p>
                <p>{{ $t('submit.page.lead') }}</p>

                <!-- what came back from the last send -->
                <div v-if="result"
                     class="result-block"
                     :class="result.ok > 0 ? 'verdict-ok' : 'verdict-bad'"
                     aria-live="polite">
                    <p class="lead-line">{{ resultHeading }}</p>
                    <p v-if="result.ok > 0">{{ $t('submit.result.queuedNote') }}</p>
                    <p v-if="result.bad > 0">{{ $t('submit.result.keptNote') }}</p>
                    <router-link class="btn btn-link result-link" to="/my">{{ $t('submit.result.seeMy') }}</router-link>
                </div>

                <div v-if="submitError" class="notice-block" aria-live="polite">
                    <p>{{ envelopeText }}</p>
                    <!-- The owner's own sentence, when the refusal carries one — a
                         VALUE, rendered as text. A block nobody can read the reason for
                         is a block nobody can appeal. -->
                    <p v-if="submitErrorNote">{{ submitErrorNote }}</p>
                </div>

                <!-- picking files -->
                <div class="cate-header">{{ $t('submit.editor.heading') }}</div>
                <div class="panel-block">
                    <p>{{ $t('submit.editor.limits', { max: maxFiles, size: humanMaxBytes }) }}</p>
                    <div class="form-group">
                        <label for="clip-files">{{ $t('submit.editor.pickLabel') }}</label>
                        <!-- A plain, visible file input, never nested inside a button:
                             a form control inside a <button> is invalid HTML and
                             unreliable from the keyboard, which is the rule the player
                             controls already follow. -->
                        <input id="clip-files"
                               ref="files"
                               type="file"
                               multiple
                               accept="audio/*"
                               :disabled="sending || rows.length >= maxFiles"
                               @change="onFilesPicked">
                    </div>
                    <p class="muted">{{ $t('submit.editor.chosen', { n: rows.length, max: maxFiles }) }}</p>
                    <p v-if="rows.length === 0" class="muted">{{ $t('submit.editor.empty') }}</p>

                    <ul v-if="rejectedPicks.length" class="reject-list" aria-live="polite">
                        <li class="reject-heading">{{ $t('submit.editor.notAdded') }}</li>
                        <li v-for="bad in rejectedPicks" :key="bad.id">
                            <span class="file-name">{{ bad.name }}</span>
                            — {{ $t('submit.pick.' + bad.why, { max: maxFiles, size: humanMaxBytes }) }}
                        </li>
                    </ul>

                    <p v-if="draftCount > 0 && rows.length === 0" class="muted">
                        {{ $t('submit.editor.draftFound', { n: draftCount }) }}
                        <button class="btn btn-link" type="button" @click="dropDraft">{{ $t('submit.editor.draftDrop') }}</button>
                    </p>
                </div>

                <!-- one row per clip -->
                <template v-if="rows.length">
                    <div class="cate-header">{{ $t('submit.editor.rowsHeading') }}</div>

                    <div class="panel-block">
                        <div class="form-group">
                            <label for="caption-locale">{{ $t('submit.editor.captionLangLabel') }}</label>
                            <select id="caption-locale" v-model="captionLocale" class="form-control locale-select" :disabled="sending">
                                <option v-for="loc in localeOptions" :key="loc.code" :value="loc.code">{{ loc.label }}</option>
                            </select>
                            <span class="field-hint">{{ $t('submit.editor.captionLangHint') }}</span>
                        </div>
                        <p v-if="groupsState === 'unavailable'" class="muted">{{ $t('submit.field.groupsUnavailable') }}</p>
                    </div>

                    <div v-for="(row, index) in rows" :key="row.key" class="clip-row" :class="{ 'clip-row-bad': row.verdict }">
                        <p class="clip-file">
                            <span class="clip-index">{{ index + 1 }}.</span>
                            <span class="file-name">{{ row.file.name }}</span>
                            <span class="muted">{{ humanBytes(row.file.size) }}</span>
                            <button class="btn btn-link" type="button" :disabled="sending" @click="removeRow(row)">
                                {{ $t('submit.editor.remove') }}
                            </button>
                        </p>

                        <p v-if="row.verdict" class="verdict-line verdict-bad">{{ verdictText(row.verdict) }}</p>

                        <div class="row">
                            <div class="col-md-4 form-group">
                                <label :for="row.key + '-name'">
                                    {{ $t('submit.field.name') }}
                                    <span class="muted">{{ $t('submit.field.counter', { n: row.name.length, max: nameMax }) }}</span>
                                </label>
                                <input :id="row.key + '-name'"
                                       v-model.trim="row.name"
                                       class="form-control"
                                       type="text"
                                       :maxlength="nameMax"
                                       :disabled="sending">
                                <span class="field-hint">{{ $t('submit.field.nameHint') }}</span>
                                <span v-if="row.touched && !row.name" class="field-bad">{{ $t('submit.field.required') }}</span>
                            </div>

                            <div class="col-md-4 form-group">
                                <label :for="row.key + '-caption'">
                                    {{ $t('submit.field.caption') }}
                                    <span class="muted">{{ $t('submit.field.counter', { n: row.caption.length, max: captionMax }) }}</span>
                                </label>
                                <input :id="row.key + '-caption'"
                                       v-model.trim="row.caption"
                                       class="form-control"
                                       type="text"
                                       :maxlength="captionMax"
                                       :disabled="sending">
                                <span class="field-hint">{{ $t('submit.field.captionHint') }}</span>
                                <span v-if="row.touched && !row.caption" class="field-bad">{{ $t('submit.field.required') }}</span>
                            </div>

                            <div class="col-md-4 form-group">
                                <label :for="row.key + '-group'">{{ $t('submit.field.group') }}</label>
                                <select :id="row.key + '-group'" v-model="row.groupId" class="form-control" :disabled="sending">
                                    <option value="">{{ $t('submit.field.chooseGroup') }}</option>
                                    <option v-for="group in groupOptions" :key="group.id" :value="group.id">{{ group.label }}</option>
                                    <option :value="newGroupChoice">{{ $t('submit.field.groupNew') }}</option>
                                </select>
                                <template v-if="row.groupId === newGroupChoice">
                                    <label :for="row.key + '-newgroup'" class="stacked-label">{{ $t('submit.field.newGroup') }}</label>
                                    <input :id="row.key + '-newgroup'"
                                           v-model.trim="row.newGroup"
                                           class="form-control"
                                           type="text"
                                           :maxlength="newGroupMax"
                                           :disabled="sending">
                                    <span class="field-hint">{{ $t('submit.field.newGroupHint') }}</span>
                                </template>
                                <span v-if="row.touched && !groupChosen(row)" class="field-bad">{{ $t('submit.field.required') }}</span>
                            </div>
                        </div>

                        <div class="form-group">
                            <label :for="row.key + '-note'">
                                {{ $t('submit.field.note') }} <span class="muted">{{ $t('submit.field.optional') }}</span>
                            </label>
                            <input :id="row.key + '-note'"
                                   v-model.trim="row.note"
                                   class="form-control"
                                   type="text"
                                   :maxlength="noteMax"
                                   :disabled="sending">
                        </div>

                        <div v-if="sending || row.progress > 0" class="progress-line">
                            <span class="progress-track"
                                  role="progressbar"
                                  :aria-valuenow="row.progress"
                                  aria-valuemin="0"
                                  aria-valuemax="100"
                                  :aria-label="row.file.name">
                                <span class="progress-fill" :style="{ width: row.progress + '%' }"></span>
                            </span>
                            <!-- "sent" is as far as this bar can honestly go: the bytes
                                 have left the browser, and whether they were taken is a
                                 sentence only the response can write. -->
                            <span v-if="sending && row.progress === 100" class="muted">{{ $t('submit.progress.sent') }}</span>
                            <span v-else class="muted">{{ $t('submit.progress.row', { percent: row.progress }) }}</span>
                        </div>
                    </div>

                    <!-- the challenge, on screen only once the server asked for one -->
                    <div v-show="challengeShown" class="panel-block">
                        <p class="lead-line">{{ $t('submit.turnstile.heading') }}</p>
                        <p>{{ $t('submit.turnstile.why') }}</p>
                        <div ref="turnstile" class="turnstile-slot"></div>
                        <p v-if="challengeState === 'loading'" aria-live="polite">{{ $t('submit.turnstile.loading') }}</p>
                        <div v-else-if="challengeState === 'unavailable' || challengeState === 'error'" aria-live="polite">
                            <p>{{ $t('submit.turnstile.unavailable') }}</p>
                            <button class="btn btn-link" type="button" @click="retryChallenge">{{ $t('submit.turnstile.retryLoad') }}</button>
                        </div>
                        <p v-else-if="challengeNote" aria-live="polite">{{ $t('submit.turnstile.' + challengeNote) }}</p>
                    </div>

                    <div class="cate-body">
                        <button class="btn btn-info"
                                type="button"
                                :disabled="!canSend"
                                aria-describedby="send-hint"
                                @click="send">
                            {{ sending ? $t('submit.action.sending') : $t('submit.action.send') }}
                        </button>
                        <button v-if="sending" class="btn btn-info" type="button" @click="abortSend">
                            {{ $t('submit.action.abort') }}
                        </button>
                    </div>
                    <p id="send-hint" class="muted send-hint">
                        <span v-if="incompleteRows > 0">{{ $t('submit.editor.incomplete', { n: incompleteRows }) }}</span>
                        <span v-else>{{ $t('submit.progress.note') }}</span>
                    </p>

                    <p v-if="sending" class="muted" aria-live="polite">{{ $t('submit.progress.total', { percent: totalPercent }) }}</p>

                    <p class="muted">{{ $t('submit.editor.durability') }}</p>
                    <p class="muted">{{ $t('submit.editor.draftKept') }}</p>
                </template>
            </div>

            <!-- ===== not signed in ========================================= -->
            <div v-else>
                <div class="panel-block why-block">
                    <p class="lead-line">{{ $t('submit.why.heading') }}</p>
                    <p class="muted">{{ $t('submit.why.lead') }}</p>
                    <p>{{ $t('submit.why.noPassword') }}</p>
                    <p>{{ $t('submit.why.whatWeSee') }}</p>
                    <p>{{ $t('submit.why.whatWeLearn') }}</p>
                    <p>{{ $t('submit.why.safeHeading') }}</p>
                    <ul>
                        <li>{{ $t('submit.why.safeOneTime') }}</li>
                        <li>{{ $t('submit.why.safeShort') }}</li>
                        <li>{{ $t('submit.why.safeFirstCome') }}</li>
                        <li>{{ $t('submit.why.safeVoid') }}</li>
                    </ul>
                    <p>{{ $t('submit.why.neverDelete') }}</p>
                    <p class="muted">{{ $t('submit.why.stolen') }}</p>
                </div>

                <div class="panel-block" aria-live="polite">
                    <!-- still asking who this is -->
                    <p v-if="phase === 'checking'">{{ $t('submit.state.checking') }}</p>

                    <!-- nothing started yet -->
                    <template v-else-if="phase === 'anon'">
                        <p v-if="loginError" class="verdict-line verdict-bad">{{ loginErrorText }}</p>
                        <div class="cate-body">
                            <button class="btn btn-info" type="button" :disabled="loginBusy" @click="startLogin">
                                {{ $t('submit.action.getCode') }}
                            </button>
                        </div>
                    </template>

                    <!-- the socket is still opening, so there is no code yet -->
                    <template v-else-if="phase === 'preparing'">
                        <p class="lead-line">{{ $t('submit.state.preparing') }}</p>
                        <p>{{ $t('submit.state.preparingDetail') }}</p>
                        <div class="cate-body">
                            <button class="btn btn-info" type="button" @click="cancelLogin">{{ $t('submit.action.cancel') }}</button>
                        </div>
                    </template>

                    <!-- the code is live -->
                    <template v-else-if="phase === 'waiting'">
                        <p class="lead-line">{{ $t('submit.state.waiting') }}</p>
                        <p class="code-label">{{ $t('submit.code.label') }}</p>
                        <p class="the-code">{{ login.code }}</p>
                        <p class="countdown">
                            <span v-if="remaining > 0">{{ $t('submit.code.expiresIn', { time: clock }) }}</span>
                            <span v-else>{{ $t('submit.code.expiredNow') }}</span>
                        </p>
                        <p>{{ $t('submit.state.waitingDetail') }}</p>
                        <!-- `resend` is the server saying it stopped listening for a while.
                             The one sentence the API forbids here is "you have not sent
                             it": the visitor may well have, into a gap that was ours. -->
                        <p v-if="login.resend" class="verdict-line verdict-bad">{{ $t('submit.state.resend') }}</p>
                        <div class="cate-body">
                            <button class="btn btn-info" type="button" @click="copyCode">{{ $t('submit.action.copy') }}</button>
                            <!-- The room link copies FIRST, synchronously, and then lets the
                                 browser follow the href. Nothing is awaited in the handler:
                                 an await — navigator.clipboard.writeText, say — would leave
                                 the rest of the copy in a task that runs after the tab has
                                 navigated, and a window.open from that task is exactly what
                                 a popup blocker eats. copytext.js is execCommand-based and
                                 has finished by the time the handler returns. -->
                            <a v-if="roomUrl"
                               class="btn btn-new"
                               :href="roomUrl"
                               target="_blank"
                               rel="noopener noreferrer"
                               @click="copyCode">{{ $t('submit.code.room') }}</a>
                            <button class="btn btn-info" type="button" @click="cancelLogin">{{ $t('submit.action.cancel') }}</button>
                        </div>
                        <p class="muted">{{ $t('submit.code.copyHint') }}</p>
                        <p v-if="copyState" aria-live="polite">{{ $t('submit.code.' + copyState) }}</p>
                    </template>

                    <!-- our side is deaf: never "you have not sent it" -->
                    <template v-else-if="phase === 'unreachable'">
                        <p class="lead-line">{{ $t('submit.state.unreachable') }}</p>
                        <p>{{ $t('submit.state.unreachableDetail') }}</p>
                        <p v-if="login && login.code" class="the-code">{{ login.code }}</p>
                        <div class="cate-body">
                            <button class="btn btn-info" type="button" @click="retryRoom">{{ $t('submit.action.retry') }}</button>
                            <button class="btn btn-info" type="button" @click="cancelLogin">{{ $t('submit.action.cancel') }}</button>
                        </div>
                    </template>

                    <!-- the code ran out -->
                    <template v-else-if="phase === 'expired'">
                        <p class="lead-line">{{ $t('submit.state.expired') }}</p>
                        <p>{{ $t('submit.state.expiredDetail') }}</p>
                        <div class="cate-body">
                            <button class="btn btn-info" type="button" :disabled="loginBusy" @click="startLogin">
                                {{ $t('submit.action.getCodeAgain') }}
                            </button>
                        </div>
                    </template>
                </div>
            </div>
        </template>
    </div>
</template>

<style lang="scss" scoped>
/* Page-local only. Every colour here is a token from App.vue's :root and every
   pairing is one App.vue already measured — named in the comment beside it. This
   file introduces no new colour, so `npm run contrast` still describes the whole
   palette after this page exists.

   One thing worth knowing before adding a control: the five measured button
   states are declared as `.cate-body button:hover` and friends, i.e. on the
   ELEMENT `button`. An <a class="btn btn-info"> inside .cate-body therefore gets
   none of them — it gets Bootstrap's stock .btn-info, which is white on #5bc0de
   at 2.2:1. Links that look like buttons carry .btn-new instead, which is a
   class selector and applies to anything. */
.panel-block {
    background-color: var(--surface);
    border: 1px solid var(--candy-red);   /* 4.62:1 on white, 3.53:1 on the page fill */
    border-radius: 10px;
    padding: 12px;
    margin-bottom: 12px;
}
.why-block p {
    max-width: 62em;        /* a measure nobody has to track across a monitor */
}
.lead-line {
    font-weight: bold;
}
/* Smaller, never paler: --cocoa-700 is 12.49:1 on white and 9.55:1 on the page
   fill, so "secondary" here is a size decision and not a contrast one. */
.muted {
    color: var(--cocoa-700);
    font-size: 13px;
}
.identity-line {
    margin-bottom: 8px;
}
/* Bootstrap paints .btn-link #337ab7, which is 4.56:1 on white but 3.48:1 on the
   cream page fill — and this page puts link-buttons on both. --plum-700 is
   8.99:1 on white and 6.87:1 on cream, so one value covers every surface here. */
.btn-link {
    color: var(--plum-700);
    text-decoration: underline;
}
.btn-link:hover,
.btn-link:focus {
    color: var(--plum-900);
}
.clip-row {
    background-color: var(--surface);
    border: 1px solid var(--candy-red);
    border-radius: 10px;
    padding: 10px 12px;
    margin-bottom: 10px;
}
.clip-row-bad {
    border-width: 3px;
}
.clip-file {
    margin-bottom: 6px;
}
.clip-index {
    font-weight: bold;
    margin-right: 4px;
}
.file-name {
    word-break: break-all;
}
.stacked-label {
    display: block;
    margin-top: 6px;
}
.field-hint {
    display: block;
    color: var(--cocoa-700);
    font-size: 12px;
}
.field-bad {
    display: block;
    color: var(--plum-700);         /* 8.99:1 on white */
    font-weight: bold;
    font-size: 12px;
}
.verdict-line {
    border-radius: 6px;
    padding: 4px 8px;
}
/* The three pairings App.vue measured for the buttons, reused verbatim rather
   than re-picked: red fill + white 4.62:1, lilac fill + plum-900 5.21:1. */
.verdict-bad {
    background-color: var(--candy-red);
    color: white;
}
.verdict-ok {
    background-color: var(--lilac);
    color: var(--plum-900);
}
.result-block {
    border-radius: 10px;
    padding: 12px;
    margin-bottom: 12px;
}
.result-link,
.result-link:hover,
.result-link:focus {
    color: inherit;                 /* whichever of the two pairs above is in force */
    text-decoration: underline;
}
.the-code {
    font-family: 'Courier New', monospace;
    font-size: 34px;
    letter-spacing: 6px;
    font-weight: bold;
    color: var(--plum-700);         /* 8.99:1 on white */
    /* So a tap-and-hold on a phone selects the whole code rather than one glyph. */
    user-select: all;
    -webkit-user-select: all;
    word-break: break-all;
}
.code-label {
    margin-bottom: 0;
}
.countdown {
    font-weight: bold;
}
.progress-line {
    margin-top: 6px;
}
.progress-track {
    display: inline-block;
    vertical-align: middle;
    width: 60%;
    max-width: 320px;
    height: 8px;
    background-color: var(--track);
    border-radius: 4px;
    overflow: hidden;
    margin-right: 8px;
}
.progress-fill {
    display: block;
    height: 100%;
    background-color: var(--candy-red);
    /* The percentage is written out beside the bar, so no information is carried
       by the fill colour alone. */
    transition: width .2s linear;
}
.reject-list {
    list-style: none;
    padding-left: 0;
}
.reject-heading {
    font-weight: bold;
}
.locale-select {
    max-width: 20em;
}
.send-hint {
    margin-top: 4px;
}
.turnstile-slot {
    margin: 8px 0;
}
.notice-block {
    background-color: var(--surface);
    border: 3px solid var(--candy-red);
    border-radius: 10px;
    padding: 12px;
    margin-bottom: 12px;
}
</style>

<script>
import Vue from 'vue'
import Component from 'vue-class-component'

import { catalog } from '../catalog.mjs'
import copyTextToClipboard from '../util/copytext'

// The two limits the server rules on, mirrored so that a file which cannot
// possibly be accepted is refused while the picker is still open instead of
// after a five-megabyte upload. They are MIRRORS, not the authority:
// server/routes/public.mjs takes them from config (limits.maxClipsPerBatch,
// limits.maxFileBytes) and re-checks every item, so a deployment that lowers
// them shows up here as a per-item verdict rather than as a lie.
const MAX_FILES = 10
const MAX_FILE_BYTES = 5 * 1024 * 1024

// Lengths from db/schema.sql and lib/text-safety.mjs: proposed_label <= 120,
// groups.display_name <= 120, CAPTION_MAX_LENGTH = 80, and the note cap
// routes/public.mjs applies before it measures the stored envelope.
const NAME_MAX = 120
const CAPTION_MAX = 80
const NOTE_MAX = 200
const NEW_GROUP_MAX = 120

// The sentinel for "propose a new group". It cannot collide with a real group
// id: schema.sql CHECKs group ids against a charset with no colon in it.
const NEW_GROUP_CHOICE = 'new:'

const DRAFT_KEY = 'joi.submit.draft.v1'

const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
// Long enough for a slow phone, short enough that nobody stares at a spinner
// wondering whether the site is broken. A network that blackholes the request
// rather than refusing it never fires onerror, so without this timeout the
// promise would simply never settle and the send button would wait for ever.
const TURNSTILE_TIMEOUT_MS = 12000
const TURNSTILE_LANGUAGE = { 'zh-CN': 'zh-cn', 'en-US': 'en', 'ja-JP': 'ja' }

// The languages a caption may be written in: db/schema.sql seeds the `locales`
// table with exactly these three, and POST /api/submit answers unknown_locale
// for anything else. A fourth language is a schema change and a locale file, and
// it would arrive here as a refusal this page already renders rather than as a
// silent failure.
const UI_LOCALES = ['zh-CN', 'en-US', 'ja-JP']

/**
 * One JSON call, with the two failures this deployment can actually produce.
 *
 * `api_unavailable` is not defensive noise: deploy/nginx.conf answers an unknown
 * path with index.html (try_files $uri /index.html) and GitHub Pages answers
 * with 404.html, so a host that carries the site without the API answers
 * /api/me with HTML — and, in the nginx case, with a 200. Parsing that as JSON
 * throws inside a promise nobody awaited; reading the content type turns it into
 * a sentence a visitor can act on.
 */
async function callJson(url, options) {
    let response
    try {
        response = await fetch(url, Object.assign({ credentials: 'same-origin' }, options || {}))
    } catch (error) {
        return { ok: false, status: 0, code: 'network', body: null }
    }
    const type = response.headers.get('content-type') || ''
    if (!/\bapplication\/json\b/i.test(type)) {
        return { ok: false, status: response.status, code: 'api_unavailable', body: null }
    }
    let body = null
    try {
        body = await response.json()
    } catch (error) {
        return { ok: false, status: response.status, code: 'api_unavailable', body: null }
    }
    if (response.ok) return { ok: true, status: response.status, code: null, body }
    const code = body && body.error && body.error.code ? body.error.code : 'unexpected'
    return { ok: false, status: response.status, code, body }
}

function humanBytes(bytes) {
    if (!Number.isFinite(bytes)) return ''
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB'
    return bytes + ' B'
}

/**
 * What identifies a file across a tab that died.
 *
 * A browser cannot hand a File back after a reload — there is no API and no
 * permission for it — so the draft is keyed on the three things a re-picked file
 * still carries. Two genuinely different files collide here only by sharing a
 * name, a byte count and a modification millisecond.
 */
function fingerprint(file) {
    return [file.name, file.size, file.lastModified].join('|')
}

function clampPercent(value) {
    if (!Number.isFinite(value)) return 0
    return Math.max(0, Math.min(100, Math.round(value)))
}

@Component({
    watch: {
        rows: {
            deep: true,
            handler() {
                this.saveDraftSoon()
            },
        },
        captionLocale() {
            this.saveDraftSoon()
        },
    },
})
class SubmitPage extends Vue {
    // 'checking' | 'unavailable' | 'anon' | 'preparing' | 'waiting'
    // | 'unreachable' | 'expired' | 'editor'
    phase = 'checking'
    pageError = null

    me = null
    login = null
    loginBusy = false
    loginError = null
    remaining = 0
    copyState = ''

    rows = []
    rowSeq = 0
    rejectedPicks = []
    rejectSeq = 0
    captionLocale = ''
    draftCount = 0

    sending = false
    uploaded = 0
    uploadTotal = 0
    result = null
    submitError = null
    submitErrorNote = ''

    challengeShown = false
    challengeState = 'unknown'
    challengeNote = ''
    siteKey = null

    // Constants the template reads; getters would recompute them for nothing.
    maxFiles = MAX_FILES
    nameMax = NAME_MAX
    captionMax = CAPTION_MAX
    noteMax = NOTE_MAX
    newGroupMax = NEW_GROUP_MAX
    newGroupChoice = NEW_GROUP_CHOICE

    // ---------------------------------------------------------------- lifecycle

    /**
     * The fields that must NOT be reactive — timers, the in-flight upload, the
     * widget handle, the challenge token — are created here rather than as class
     * properties, and that is not a style choice: vue-class-component turns class
     * properties into data keys, and Vue does not proxy a data key whose name
     * starts with an underscore. `this._widgetId` declared up there would read as
     * undefined instead of null, and `undefined !== null` is exactly the test
     * that decides whether to reset a widget that does not exist yet.
     */
    created() {
        this._pollTimer = null
        this._tickTimer = null
        this._draftTimer = null
        this._xhr = null
        this._turnstile = null
        this._turnstileScript = null
        this._widgetId = null
        this._token = null
        this._pendingSend = false
        this._deadline = 0
        this._onVisible = null

        this._draft = this.readDraft()
        this.draftCount = this._draft ? Object.keys(this._draft.rows).length : 0
        const remembered = this._draft ? this._draft.locale : ''
        this.captionLocale = UI_LOCALES.indexOf(remembered) >= 0 ? remembered : this.$i18n.locale
    }

    mounted() {
        this.loadMe()
        // A visitor who goes to the live room and comes back has spent that time
        // in a background tab, where browsers throttle timers to about once a
        // minute. Polling the moment the tab is looked at again is the difference
        // between "it noticed straight away" and "it sat there for fifty seconds".
        this._onVisible = () => {
            if (document.visibilityState !== 'visible') return
            if (this.phase === 'preparing' || this.phase === 'waiting' || this.phase === 'unreachable') {
                this.pollStatus()
            }
        }
        document.addEventListener('visibilitychange', this._onVisible)
    }

    beforeDestroy() {
        this.stopPolling()
        this.stopTicking()
        if (this._draftTimer !== null) clearTimeout(this._draftTimer)
        this.saveDraft()
        if (this._onVisible) document.removeEventListener('visibilitychange', this._onVisible)
        // An upload in flight is abandoned rather than left to run: it cannot
        // deliver its answer to a component that no longer exists, and a
        // truncated submission is discarded whole by the server.
        if (this._xhr) this._xhr.abort()
        this.removeWidget()
    }

    // ---------------------------------------------------------------- computed

    get roomUrl() {
        const id = this.login && this.login.roomId
        return Number.isInteger(id) && id > 0 ? 'https://live.bilibili.com/' + id : null
    }

    get clock() {
        const total = Math.max(0, this.remaining)
        const minutes = Math.floor(total / 60)
        const seconds = total % 60
        return minutes + ':' + (seconds < 10 ? '0' : '') + seconds
    }

    get humanMaxBytes() {
        return humanBytes(MAX_FILE_BYTES)
    }

    get localeOptions() {
        return UI_LOCALES.map((code) => ({
            code,
            label: this.$te('lang.' + code) ? this.$t('lang.' + code) : code,
        }))
    }

    /**
     * Whether the group choice can be offered at all.
     *
     * src/catalog.mjs installs one of two documents and says which: 'network' is
     * the published catalog.json, whose group ids ARE rows in the database and
     * are therefore the only ids POST /api/submit will accept. 'snapshot' is the
     * floor compiled out of src/voices.json, whose ids are slugs this repository
     * invented — offering those would send every submitter into unknown_group.
     * So the existing-group list is shown for one of the two documents only, and
     * proposing a new group is a complete path through this form regardless.
     */
    get groupsState() {
        if (catalog.source === null) return 'loading'
        return catalog.source === 'network' ? 'ready' : 'unavailable'
    }

    get groupOptions() {
        if (this.groupsState !== 'ready') return []
        const locale = this.$i18n.locale
        // Read through a computed and never copied into data: installCatalog
        // REPLACES catalog.groups, and a captured array would keep rendering the
        // document that was current when this component was created.
        return catalog.groups.map((group) => ({
            id: group.id,
            // Owner-authored text, rendered as a VALUE. Passing it through $t
            // would look it up as a message key and print a key path when it
            // missed — which is every group with a caption in this locale.
            label: (group.captions && group.captions[locale]) || group.displayName || group.id,
        }))
    }

    get incompleteRows() {
        return this.rows.filter((row) => !this.rowReady(row)).length
    }

    get canSend() {
        return !this.sending && this.rows.length > 0 && this.incompleteRows === 0
    }

    get totalPercent() {
        if (this.uploadTotal <= 0) return 0
        return clampPercent((this.uploaded / this.uploadTotal) * 100)
    }

    get resultHeading() {
        if (!this.result) return ''
        if (this.result.ok === 0) return this.$t('submit.result.headingNone')
        if (this.result.bad === 0) return this.$t('submit.result.headingAll', { ok: this.result.ok })
        return this.$t('submit.result.headingSome', { ok: this.result.ok, bad: this.result.bad })
    }

    get loginErrorText() {
        return this.codeText(this.loginError, null)
    }

    get envelopeText() {
        return this.codeText(this.submitError, null)
    }

    // ---------------------------------------------------------------- identity

    async loadMe() {
        this.pageError = null
        this.phase = 'checking'
        const answer = await callJson('/api/me')
        if (!answer.ok) {
            this.pageError = answer.code
            this.phase = 'unavailable'
            return
        }
        if (answer.body.submitter) {
            this.me = answer.body.submitter
            this.phase = 'editor'
            return
        }
        this.phase = 'anon'
    }

    async startLogin() {
        this.loginBusy = true
        this.loginError = null
        const answer = await callJson('/api/login/start', { method: 'POST' })
        this.loginBusy = false
        if (!answer.ok) {
            this.loginError = answer.code
            if (answer.code === 'api_unavailable') {
                this.pageError = answer.code
                this.phase = 'unavailable'
            }
            return
        }
        this.applyLogin(answer.body)
    }

    async pollStatus() {
        this.stopPolling()
        const token = this.login && this.login.pollToken
        const url = '/api/login/status' + (token ? '?token=' + encodeURIComponent(token) : '')
        const answer = await callJson(url)
        if (answer.ok) {
            this.applyLogin(answer.body)
            return
        }
        if (answer.code === 'no_verification_in_progress' || answer.code === 'unknown_poll_token') {
            // There is nothing left to wait for. Back to the start, rather than a
            // spinner that will never resolve.
            this.login = null
            this.stopTicking()
            this.phase = 'anon'
            return
        }
        if (answer.code === 'network') {
            // A dropped connection is not an expired code: keep the code on
            // screen, keep the countdown running, and keep asking.
            this.schedulePoll(5000)
            return
        }
        this.pageError = answer.code
        this.phase = 'unavailable'
    }

    /**
     * One status body, applied to the page.
     *
     * The states are the server's and are not re-derived here.
     * `room-unreachable` in particular is the server saying OUR side cannot hear
     * the room, and it is rendered as exactly that; so is `resend`, which means
     * we stopped listening for a while and a danmaku sent in that window is gone.
     * Neither may ever become "you have not sent it yet".
     */
    applyLogin(body) {
        if (body.state === 'verified') {
            this.login = null
            this.stopPolling()
            this.stopTicking()
            this.loadMe()
            // The navbar is a sibling, not a parent, and App.vue's protocol is
            // that the page which changed the session announces it — the bar
            // then re-reads /api/me for itself. Without this the visitor is
            // signed in on this page and still offered "log in" one row above
            // it, until some later navigation happens to trip App.vue's
            // afterEach hook (which is itself guarded on the path CHANGING, so
            // staying here never trips it).
            this.$gConst.globalbus.$emit('auth:changed')
            return
        }

        this.login = body
        this.loginError = null

        if (typeof body.expiresInSeconds === 'number') {
            // A DURATION, deliberately, and not Date.parse(body.expiresAt): a
            // phone with a wrong clock would then be shown a wrong countdown, and
            // the one number on this page that must not be wrong is how much time
            // the code has left.
            this._deadline = Date.now() + body.expiresInSeconds * 1000
            this.remaining = body.expiresInSeconds
            this.startTicking()
        }

        if (body.state === 'waiting') {
            this.phase = 'waiting'
            this.schedulePoll(3000)
        } else if (body.state === 'preparing') {
            this.phase = 'preparing'
            this.schedulePoll(body.pollAfterMs || 700)
        } else if (body.state === 'room-unreachable') {
            this.phase = 'unreachable'
            this.schedulePoll(5000)
        } else if (body.state === 'expired') {
            this.phase = 'expired'
            this.stopTicking()
        }
    }

    /**
     * Retry after "we cannot hear the room", which is two different situations.
     *
     * WITH a code, the room went down after the code was issued: the code is
     * still live and still the one to send, so retrying means asking again and
     * nothing else. Starting over here would throw away a perfectly good code
     * and the minutes left on it.
     *
     * WITHOUT one, acquire() failed and the attempt is in memory with its
     * failure recorded. Measured against the running server: BOTH
     * /api/login/status and a second POST /api/login/start answer from that same
     * attempt — start() is idempotent and hands back the attempt it already has
     * — so polling, or pressing the button twice, can only ever return
     * room-unreachable again. Only /api/login/cancel drops it. So the retry that
     * can actually recover is: give the attempt back, then ask for a new one.
     */
    retryRoom() {
        if (this.login && this.login.code) {
            this.pollStatus()
            return
        }
        this.restartLogin()
    }

    async restartLogin() {
        this.stopPolling()
        this.stopTicking()
        await callJson('/api/login/cancel', { method: 'POST' })
        this.login = null
        this.startLogin()
    }

    async cancelLogin() {
        this.stopPolling()
        this.stopTicking()
        this.login = null
        this.phase = 'anon'
        // Tells the server to give the room socket back rather than holding it
        // for the rest of the lease on behalf of nobody.
        await callJson('/api/login/cancel', { method: 'POST' })
    }

    async signOut() {
        await callJson('/api/logout', { method: 'POST' })
        this.me = null
        this.result = null
        this.phase = 'anon'
        // Announced for the same reason, and it matters more in this direction:
        // a bar still showing the old display name and a working "My clips"
        // link after a sign-out is the failure this control exists to prevent —
        // somebody on a shared machine walking away from what looks like a live
        // session.
        this.$gConst.globalbus.$emit('auth:changed')
        // The rows and the draft stay. Signing out is how somebody recovers from
        // a code that was taken by a stranger, and losing ten filled-in rows to
        // that would punish them twice for somebody else's trick.
    }

    copyCode() {
        if (!this.login || !this.login.code) return
        const code = this.login.code
        // Synchronous FIRST, always: this same handler runs on the live-room
        // link, where the tab is about to navigate. execCommand finishes inside
        // the handler; navigator.clipboard.writeText hands back a promise a
        // navigation can cut short.
        //
        // And the return value is the truth. execCommand answers false when the
        // browser refuses — measured: it does exactly that when the document is
        // not focused — and telling somebody their code is on the clipboard when
        // it is not costs them the whole ten minutes. So the failure is stated,
        // the async API is tried as a second chance, and only ITS OWN success is
        // allowed to change what the page claims.
        if (copyTextToClipboard(code)) {
            this.copyState = 'copied'
            return
        }
        this.copyState = 'copyFailed'
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(code).then(
                () => { this.copyState = 'copied' },
                () => { /* still refused; the page already says so */ },
            )
        }
    }

    schedulePoll(delay) {
        this.stopPolling()
        this._pollTimer = setTimeout(() => {
            this._pollTimer = null
            this.pollStatus()
        }, delay)
    }

    stopPolling() {
        if (this._pollTimer !== null) {
            clearTimeout(this._pollTimer)
            this._pollTimer = null
        }
    }

    startTicking() {
        if (this._tickTimer !== null) return
        this._tickTimer = setInterval(() => {
            const left = Math.max(0, Math.round((this._deadline - Date.now()) / 1000))
            this.remaining = left
            if (left === 0) {
                // The local clock says it is over; the server decides whether it
                // actually is, and this is what asks it.
                this.stopTicking()
                this.pollStatus()
            }
        }, 1000)
    }

    stopTicking() {
        if (this._tickTimer !== null) {
            clearInterval(this._tickTimer)
            this._tickTimer = null
        }
    }

    // ---------------------------------------------------------------- the rows

    onFilesPicked(event) {
        const chosen = Array.from(event.target.files || [])
        this.rejectedPicks = []
        for (const file of chosen) {
            const why = this.whyNotAccepted(file)
            if (why !== null) {
                this.rejectSeq += 1
                this.rejectedPicks.push({ id: this.rejectSeq, name: file.name, why })
                continue
            }
            this.rows.push(this.buildRow(file))
        }
        // So the same file can be chosen again after being dropped: an <input
        // type=file> fires no change event when the new selection is identical.
        event.target.value = ''
    }

    /**
     * The two ruled limits, enforced while the picker is still open.
     *
     * ORDER: everything about the FILE is decided before anything about the
     * BATCH. The batch cap used to be tested first, and once ten rows were in
     * the editor every further pick was reported as "the batch is full" whatever
     * was wrong with it — so dropping one over-sized file into a full batch told
     * the submitter to remove something rather than to shrink that file, and the
     * real reason never appeared at all. A file that could never be accepted
     * says why regardless of how full the batch is.
     */
    whyNotAccepted(file) {
        if (file.size === 0) return 'empty'
        if (file.size > MAX_FILE_BYTES) return 'tooBig'
        const print = fingerprint(file)
        if (this.rows.some((row) => row.fingerprint === print)) return 'duplicate'
        if (this.rows.length >= MAX_FILES) return 'tooMany'
        return null
    }

    buildRow(file) {
        this.rowSeq += 1
        const print = fingerprint(file)
        const saved = (this._draft && this._draft.rows[print]) || null
        return {
            // parseMetadata() requires /^[A-Za-z0-9_-]{1,32}$/ and refuses the
            // whole document on a duplicate key, so this is generated rather than
            // taken from a filename.
            key: 'c' + this.rowSeq,
            fingerprint: print,
            file,
            name: saved ? saved.name : file.name.replace(/\.[^.]+$/, '').slice(0, NAME_MAX),
            caption: saved ? saved.caption : '',
            groupId: saved ? saved.groupId : '',
            newGroup: saved ? saved.newGroup : '',
            note: saved ? saved.note : '',
            // A restored row has been edited once already, so its gaps are shown
            // straight away rather than waiting for a first press of send.
            touched: saved !== null,
            progress: 0,
            verdict: null,
        }
    }

    removeRow(row) {
        this.rows = this.rows.filter((other) => other.key !== row.key)
    }

    groupChosen(row) {
        if (row.groupId === NEW_GROUP_CHOICE) return row.newGroup.length > 0
        return row.groupId.length > 0
    }

    rowReady(row) {
        return row.name.length > 0 && row.caption.length > 0 && this.groupChosen(row)
    }

    humanBytes(bytes) {
        return humanBytes(bytes)
    }

    // ---------------------------------------------------------------- the draft

    readDraft() {
        let raw = null
        try {
            raw = window.localStorage.getItem(DRAFT_KEY)
        } catch (error) {
            return null         // Safari in private mode throws on the getter itself
        }
        if (!raw) return null
        let parsed = null
        try {
            parsed = JSON.parse(raw)
        } catch (error) {
            return null
        }
        if (!parsed || !Array.isArray(parsed.rows)) return null
        const rows = {}
        for (const entry of parsed.rows) {
            if (!entry || typeof entry.f !== 'string') continue
            rows[entry.f] = {
                name: typeof entry.n === 'string' ? entry.n : '',
                caption: typeof entry.c === 'string' ? entry.c : '',
                groupId: typeof entry.g === 'string' ? entry.g : '',
                newGroup: typeof entry.w === 'string' ? entry.w : '',
                note: typeof entry.t === 'string' ? entry.t : '',
            }
        }
        return { locale: typeof parsed.l === 'string' ? parsed.l : '', rows }
    }

    saveDraftSoon() {
        if (this._draftTimer !== null) clearTimeout(this._draftTimer)
        this._draftTimer = setTimeout(() => {
            this._draftTimer = null
            this.saveDraft()
        }, 400)
    }

    /**
     * What survives the tab dying: the words, on this device, and nothing else.
     *
     * The files cannot be kept — no browser will hand a File back after a reload
     * — so this is text keyed by fingerprint, and re-picking the same files
     * refills it. None of it is ever sent anywhere.
     */
    saveDraft() {
        const payload = {
            l: this.captionLocale,
            rows: this.rows.map((row) => ({
                f: row.fingerprint,
                n: row.name,
                c: row.caption,
                g: row.groupId,
                w: row.newGroup,
                t: row.note,
            })),
        }
        try {
            window.localStorage.setItem(DRAFT_KEY, JSON.stringify(payload))
        } catch (error) {
            // Full, or disabled. The draft is a courtesy; losing it must not stop
            // anybody from sending what is already on the screen.
        }
    }

    dropDraft() {
        this._draft = null
        this.draftCount = 0
        try {
            window.localStorage.removeItem(DRAFT_KEY)
        } catch (error) {
            // It was never readable in the first place; there is nothing to undo.
        }
    }

    // ---------------------------------------------------------------- challenge

    loadTurnstile() {
        if (window.turnstile) return Promise.resolve(window.turnstile)
        if (this._turnstileScript) return this._turnstileScript
        this._turnstileScript = new Promise((resolve, reject) => {
            const script = document.createElement('script')
            script.src = TURNSTILE_SRC
            script.async = true
            script.defer = true
            const timer = setTimeout(() => reject(new Error('turnstile-timeout')), TURNSTILE_TIMEOUT_MS)
            script.onload = () => {
                clearTimeout(timer)
                if (window.turnstile) resolve(window.turnstile)
                else reject(new Error('turnstile-absent'))
            }
            script.onerror = () => {
                clearTimeout(timer)
                reject(new Error('turnstile-blocked'))
            }
            document.head.appendChild(script)
        })
        return this._turnstileScript
    }

    /**
     * Put a challenge on the screen, or say that we could not.
     *
     * The audience is Bilibili viewers and challenges.cloudflare.com is not
     * dependably reachable from every network they sit on, so failing here is a
     * NORMAL path and it never disables the send button. The server re-decides at
     * submit time anyway and its refusal carries the site key, so the honest move
     * is to let them try and to render whatever comes back.
     */
    async ensureChallenge(siteKey) {
        if (!siteKey) {
            this.challengeShown = true
            this.challengeState = 'unavailable'
            return false
        }
        this.siteKey = siteKey
        this.challengeShown = true
        this.challengeNote = ''
        this.challengeState = 'loading'
        let api = null
        try {
            api = await this.loadTurnstile()
        } catch (error) {
            this.challengeState = 'unavailable'
            return false
        }
        this._turnstile = api
        await this.$nextTick()
        const slot = this.$refs.turnstile
        if (!slot) {
            this.challengeState = 'unavailable'
            return false
        }
        if (this._widgetId !== null) {
            api.reset(this._widgetId)
            this.challengeState = 'ready'
            return true
        }
        try {
            this._widgetId = api.render(slot, {
                sitekey: siteKey,
                language: TURNSTILE_LANGUAGE[this.$i18n.locale] || 'auto',
                callback: (token) => this.onChallengeToken(token),
                'error-callback': () => {
                    this._token = null
                    this._pendingSend = false
                    this.challengeState = 'error'
                },
                'expired-callback': () => {
                    this._token = null
                    this.challengeNote = 'expired'
                },
            })
            this.challengeState = 'ready'
            return true
        } catch (error) {
            this.challengeState = 'unavailable'
            return false
        }
    }

    onChallengeToken(token) {
        this._token = token
        this.challengeNote = ''
        this.challengeState = 'ready'
        // They already pressed send; the challenge was the only thing in the way.
        if (this._pendingSend) {
            this._pendingSend = false
            this.sendNow()
        }
    }

    retryChallenge() {
        this._turnstileScript = null
        if (this.siteKey) this.ensureChallenge(this.siteKey)
    }

    /** A Turnstile token is single-use, so it is spent the moment a send uses it. */
    resetChallenge() {
        this._token = null
        if (this._turnstile && this._widgetId !== null) this._turnstile.reset(this._widgetId)
    }

    removeWidget() {
        if (this._turnstile && this._widgetId !== null && typeof this._turnstile.remove === 'function') {
            try {
                this._turnstile.remove(this._widgetId)
            } catch (error) {
                // The slot may already be gone with the rows it lived among.
            }
        }
        this._widgetId = null
        this._token = null
    }

    // ---------------------------------------------------------------- sending

    async send() {
        for (const row of this.rows) row.touched = true
        if (!this.canSend) return
        this.submitError = null
        this.submitErrorNote = ''
        this.result = null

        // Asked BEFORE the widget is touched, so a challenge is rendered only for
        // a submitter the server actually wants one from.
        const pre = await callJson('/api/submit/preflight')
        if (!pre.ok) {
            if (pre.code === 'identity_required') {
                this.me = null
                this.phase = 'anon'
                return
            }
            this.submitError = pre.code
            return
        }

        if (pre.body.challengeRequired && !this._token) {
            this._pendingSend = true
            const rendered = await this.ensureChallenge(pre.body.siteKey)
            if (rendered) {
                this.challengeNote = 'solveFirst'
                return          // onChallengeToken picks it up from here
            }
            // It did not load. Send anyway and let the server have the last word:
            // being unable to reach Cloudflare must not mean being unable to
            // submit, for ever, with no way to find out why.
            this._pendingSend = false
        }

        this.sendNow()
    }

    sendNow() {
        const form = new FormData()
        form.append('metadata', JSON.stringify({
            items: this.rows.map((row) => ({
                key: row.key,
                name: row.name,
                caption: { locale: this.captionLocale, text: row.caption },
                groupId: row.groupId === NEW_GROUP_CHOICE ? null : row.groupId,
                newGroup: row.groupId === NEW_GROUP_CHOICE ? row.newGroup : null,
                note: row.note ? row.note : null,
            })),
        }))
        if (this._token) form.append('turnstileToken', this._token)
        const nonFileParts = this._token ? 2 : 1
        for (const row of this.rows) {
            form.append('file:' + row.key, row.file, row.file.name)
            row.progress = 0
            row.verdict = null
        }

        const sizes = this.rows.map((row) => row.file.size)
        const totalFileBytes = sizes.reduce((sum, size) => sum + size, 0)

        this.sending = true
        this.uploaded = 0
        this.uploadTotal = 0

        // XMLHttpRequest rather than fetch: fetch has no upload progress event at
        // all, and on a ten-file batch over a phone connection a progress bar is
        // the difference between "it is working" and "it is frozen".
        const xhr = new XMLHttpRequest()
        this._xhr = xhr
        xhr.open('POST', '/api/submit')

        xhr.upload.onprogress = (event) => {
            if (!event.lengthComputable) return
            this.uploaded = event.loaded
            this.uploadTotal = event.total
            // Per file, out of one counter: the body is the parts in the order
            // they were appended, so a byte offset identifies a file. The part
            // headers and the metadata field are the difference between the total
            // and the file bytes, spread evenly across the parts — a few hundred
            // bytes of slop against megabytes, which is why a row can read 100% a
            // moment before its last byte actually leaves. What it never reads is
            // "accepted": that word belongs to the response.
            const overhead = Math.max(0, event.total - totalFileBytes)
            const share = overhead / (this.rows.length + nonFileParts)
            let cursor = share * nonFileParts
            for (let index = 0; index < this.rows.length; index += 1) {
                const size = sizes[index] || 1
                this.rows[index].progress = clampPercent(((event.loaded - cursor) / size) * 100)
                cursor += size + share
            }
        }
        xhr.upload.onload = () => {
            for (const row of this.rows) row.progress = 100
        }
        xhr.onload = () => {
            this._xhr = null
            this.sending = false
            this.finishSend(xhr.status, xhr.getResponseHeader('content-type'), xhr.responseText)
        }
        xhr.onerror = () => {
            this._xhr = null
            this.sending = false
            this.submitError = 'network'
            for (const row of this.rows) row.progress = 0
        }
        xhr.onabort = () => {
            this._xhr = null
            this.sending = false
            for (const row of this.rows) row.progress = 0
        }
        xhr.send(form)
    }

    abortSend() {
        if (this._xhr) this._xhr.abort()
    }

    finishSend(status, contentType, text) {
        let body = null
        if (/\bapplication\/json\b/i.test(contentType || '')) {
            try {
                body = JSON.parse(text)
            } catch (error) {
                body = null
            }
        }
        if (body === null) {
            this.submitError = 'api_unavailable'
            return
        }

        // Per item, always: a 200 and the 422 that says nothing could be taken
        // both carry the same `items` array, and it is the only thing that says
        // which clip failed and why.
        if (Array.isArray(body.items)) this.applyVerdicts(body.items)

        if (status === 200) {
            this.resetChallenge()
            return
        }

        const code = body.error && body.error.code ? body.error.code : 'unexpected'
        if (code === 'identity_required') {
            // The session went away mid-editing. Everything typed stays exactly
            // where it is; only the identity has to be won back.
            this.me = null
            this.phase = 'anon'
            return
        }
        if (code === 'challenge_required' || code === 'challenge_failed') {
            this.resetChallenge()
            this.challengeNote = code === 'challenge_failed' ? 'failedAgain' : 'solveFirst'
            // If the widget cannot be put on the screen, "solve the check above"
            // names something that is not there. Say what the server actually
            // said instead, so the dead end at least has a sentence on it.
            this.ensureChallenge(body.error.siteKey || this.siteKey).then((rendered) => {
                if (!rendered) this.submitError = code
            })
            return
        }
        // A block carries the owner's own sentence for it; anything else carries
        // no extra detail a visitor could act on.
        if (code === 'submitter_blocked' && typeof body.error.reason === 'string') {
            this.submitErrorNote = body.error.reason
        }
        // 'no_valid_items' has already been rendered item by item; repeating it
        // as a banner would say the same thing twice in different words.
        if (code !== 'no_valid_items') this.submitError = code
    }

    /**
     * The response, item by item.
     *
     * Accepted rows leave the editor; refused ones stay, carrying their reason,
     * so that item 3 failing costs the submitter item 3 and nothing else. A row
     * the response says nothing about is kept and left silent — inventing a
     * verdict for it would be this page making one up.
     */
    applyVerdicts(items) {
        const byKey = new Map()
        for (const item of items) byKey.set(item.key, item)

        const kept = []
        let accepted = 0
        for (const row of this.rows) {
            const verdict = byKey.get(row.key)
            if (verdict && verdict.state === 'pending') {
                accepted += 1
                continue
            }
            row.verdict = verdict || null
            row.progress = 0
            kept.push(row)
        }
        // Before the DOM catches up with the empty list, so the widget is removed
        // while its slot still exists.
        if (kept.length === 0) this.removeWidget()
        this.rows = kept
        this.result = { ok: accepted, bad: kept.length }
        this.saveDraft()
    }

    // ---------------------------------------------------------------- wording

    /**
     * A refusal, in the visitor's language.
     *
     * The CODE is the contract — routes/public.mjs says so outright — so this
     * page keys its own text off it. `message` is the server's own sentence and
     * is rendered as a VALUE, for a code added after this file was written: it is
     * never passed to $t, which would look it up as a key and print a key path.
     */
    codeText(code, message) {
        if (!code) return ''
        const key = 'submit.reason.' + code
        if (this.$te(key)) return this.$t(key)
        if (message) return message
        if (code === 'network') return this.$t('submit.error.network')
        if (code === 'api_unavailable') return this.$t('submit.error.apiUnavailable')
        return this.$t('submit.error.unexpected')
    }

    verdictText(verdict) {
        const base = this.codeText(verdict.code, verdict.message)
        const detailKey = 'submit.reason.detail.' + verdict.detail
        if (verdict.detail && this.$te(detailKey)) return base + ' ' + this.$t(detailKey)
        return base
    }
}

export default SubmitPage
</script>
