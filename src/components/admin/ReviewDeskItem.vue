<template>
    <div>
        <p v-if="phase === 'loading'" class="adm-panel adm-empty">{{ $t("admin.common.loading") }}</p>

        <div v-else-if="phase === 'error'" class="adm-panel">
            <p class="adm-note adm-note-bad">{{ loadError }}</p>
            <button type="button" class="adm-btn" @click="load">{{ $t("admin.common.retry") }}</button>
        </div>

        <div v-else>
            <!-- ---------------- what was submitted ---------------- -->
            <div class="adm-panel">
                <div class="adm-panel-head">
                    <div>
                        <h2 class="adm-h">{{ $t("admin.desk.title") }}</h2>
                        <p class="adm-sub">
                            {{ $t("admin.desk.position", { position: detail.item.position, count: detail.batch.progress.item_count }) }}
                        </p>
                    </div>
                    <span class="adm-sub adm-num">{{ detail.batch.submittedAt }}</span>
                </div>

                <dl class="adm-register">
                    <dt>{{ $t("admin.desk.proposedName") }}</dt>
                    <dd>{{ detail.item.proposedLabel }}</dd>
                    <dt>{{ $t("admin.desk.proposedGroup") }}</dt>
                    <!-- An EXISTING group arrives as an id; one the submitter is
                         proposing has no id yet and travels in the note. Both are
                         shown, and they are visually distinct — a mono id is a
                         thing that exists, prose is a request. -->
                    <dd v-if="detail.item.proposedGroupId" class="adm-mono">{{ detail.item.proposedGroupId }}</dd>
                    <dd v-else-if="detail.item.submitterNote && detail.item.submitterNote.proposedGroup">
                        {{ $t("admin.queue.proposedGroup", { name: detail.item.submitterNote.proposedGroup }) }}
                    </dd>
                    <dd v-else class="adm-sub">{{ $t("admin.queue.noGroup") }}</dd>
                    <!-- The submitter's own caption, in the language they wrote
                         it in. It is what the reviewer is deciding about, and it
                         used to be invisible here — buried in the JSON blob this
                         <dd> printed whole. -->
                    <template v-if="detail.item.submitterNote && detail.item.submitterNote.caption">
                        <dt>{{ $t("admin.desk.submitterCaption") }}</dt>
                        <dd>
                            {{ detail.item.submitterNote.caption.text }}
                            <span class="adm-sub adm-mono">[{{ detail.item.submitterNote.caption.locale }}]</span>
                        </dd>
                    </template>
                    <template v-if="detail.item.submitterNote && detail.item.submitterNote.note">
                        <dt>{{ $t("admin.desk.submitterNote") }}</dt>
                        <dd>{{ detail.item.submitterNote.note }}</dd>
                    </template>
                </dl>
                <p class="adm-sub adm-num">
                    {{ $t("admin.desk.batchProgress", {
                        pending: detail.batch.progress.pending_count,
                        approved: detail.batch.progress.approved_count,
                        rejected: detail.batch.progress.rejected_count
                    }) }}
                </p>
            </div>

            <ClipAudition
                :item-id="itemId"
                :src="detail.item.media.audioUrl"
                :duration-seconds="detail.item.media.durationSeconds"
                :already-heard="heard"
                @heard="$emit('heard', $event)" />

            <!-- ---------------- the decision already taken ---------------- -->
            <div v-if="settled" class="adm-panel">
                <p class="adm-note" :class="detail.item.state === 'approved' ? 'adm-note-ok' : 'adm-note-warn'">
                    {{ $t("admin.desk.alreadyDecided", { state: detail.item.state, at: detail.item.resolvedAt }) }}
                </p>
                <p v-if="detail.item.reviewerNote">{{ detail.item.reviewerNote }}</p>
                <!-- A rejected item opened from the recycle bin: the form below
                     overturns the rejection into a draft clip. -->
                <p v-if="revising" class="adm-note adm-note-warn">{{ $t("admin.desk.reviseHint") }}</p>
                <div v-if="detail.clip">
                    <p class="adm-note" :class="detail.clip.state === 'published' ? 'adm-note-ok' : 'adm-note-warn'">
                        <strong v-if="detail.clip.state !== 'published'">{{ $t("admin.desk.notLiveYet") }}</strong>
                        <strong v-else>{{ $t("admin.desk.live", { at: detail.clip.publishedAt }) }}</strong>
                    </p>
                    <p v-if="detail.clip.missingLocales.length > 0" class="adm-note adm-note-warn">
                        {{ $t("admin.desk.publishBlocked", { locales: detail.clip.missingLocales.join(', ') }) }}
                    </p>
                    <button type="button" class="adm-btn-link" @click="$emit('open-publish')">
                        {{ $t("admin.desk.goPublish") }}
                    </button>
                </div>
            </div>

            <!-- ---------------- draft banner ---------------- -->
            <div v-if="restoredAt !== null" class="adm-note adm-note-warn">
                {{ $t("admin.desk.draftRestored", { at: restoredAt }) }}
                <button type="button" class="adm-btn-link" @click="discardDraft">
                    {{ $t("admin.desk.draftDiscard") }}
                </button>
            </div>
            <p v-if="storageBroken" class="adm-note adm-note-warn">{{ $t("admin.desk.draftStorageFailed") }}</p>

            <!-- ---------------- the editable clip ---------------- -->
            <form v-if="editable" class="adm-panel" @submit.prevent>
                <fieldset class="adm-fieldset">
                    <legend class="adm-legend">{{ $t("admin.desk.name") }}</legend>
                    <I18nTextField
                        field-id="adm-label"
                        :label="$t('admin.desk.nameLabel')"
                        :value="draft.label"
                        :max-length="labelMaxLength"
                        :verdict="verdicts.label"
                        :sibling-captions="siblingLabels"
                        :show-register="true"
                        @input="draft.label = $event" />
                    <p class="adm-hint">{{ $t("admin.desk.nameHint") }}</p>
                </fieldset>

                <fieldset class="adm-fieldset">
                    <legend class="adm-legend">{{ $t("admin.desk.captions") }}</legend>
                    <p class="adm-hint">{{ $t("admin.desk.captionsHint") }}</p>
                    <div class="adm-langs">
                        <I18nTextField
                            v-for="locale in detail.locales"
                            :key="locale.code"
                            :field-id="'adm-caption-' + locale.code"
                            :label="locale.label + ' (' + locale.code + ')'"
                            :value="draft.captions[locale.code]"
                            :max-length="captionMaxLength"
                            :verdict="verdicts.captions[locale.code]"
                            :group-caption="groupCaptionFor(locale.code)"
                            :sibling-captions="siblingCaptionsFor(locale.code)"
                            :show-register="true"
                            @input="setCaption(locale.code, $event)" />
                    </div>
                    <p v-if="missingLocales.length > 0" class="adm-note adm-note-warn">
                        {{ $t("admin.desk.missingLocales", { locales: missingLocales.join(', ') }) }}
                    </p>
                </fieldset>

                <!-- ---------------- the group ---------------- -->
                <fieldset class="adm-fieldset">
                    <legend class="adm-legend">{{ $t("admin.desk.group") }}</legend>

                    <label class="adm-choice" v-if="proposedGroup !== null">
                        <input type="radio" value="accept" v-model="draft.groupMode">
                        {{ $t("admin.desk.groupAccept", { name: proposedGroup.displayName }) }}
                    </label>
                    <p v-else-if="detail.item.proposedGroupId" class="adm-warn">
                        {{ $t("admin.desk.groupProposedUnusable", { id: detail.item.proposedGroupId }) }}
                    </p>

                    <label class="adm-choice">
                        <input type="radio" value="reassign" v-model="draft.groupMode">
                        {{ $t("admin.desk.groupReassign") }}
                    </label>
                    <select v-if="draft.groupMode === 'reassign'" class="adm-select" v-model="draft.groupId">
                        <option value="">{{ $t("admin.desk.groupPick") }}</option>
                        <!-- Retired groups are listed and disabled rather than
                             omitted: the route refuses them ("a clip published
                             there is a button nobody can find") and a group that
                             silently vanishes from the list is a question the
                             owner cannot answer. -->
                        <option v-for="group in detail.groups" :key="group.id"
                                :value="group.id" :disabled="group.state !== 'active'">
                            {{ group.displayName }}{{ group.state === 'active' ? '' : ' — ' + $t("admin.desk.groupRetired") }}
                        </option>
                    </select>

                    <label class="adm-choice" v-if="!settled || revising">
                        <input type="radio" value="new" v-model="draft.groupMode">
                        {{ $t("admin.desk.groupNew") }}
                    </label>
                    <div v-if="draft.groupMode === 'new'">
                        <I18nTextField
                            field-id="adm-newgroup-name"
                            :label="$t('admin.desk.groupNewName')"
                            :value="draft.newGroup.displayName"
                            :max-length="labelMaxLength"
                            :verdict="verdicts.newGroupName"
                            @input="draft.newGroup.displayName = $event" />
                        <p v-if="newGroupNameClash !== null" class="adm-warn">
                            {{ $t("admin.desk.groupNameClash", { id: newGroupNameClash }) }}
                        </p>

                        <label class="adm-label" for="adm-newgroup-id">{{ $t("admin.desk.groupNewId") }}</label>
                        <input id="adm-newgroup-id" type="text" class="adm-input adm-mono"
                               :class="{ 'is-bad': !newGroupIdOk }" v-model="draft.newGroup.id">
                        <p v-if="!newGroupIdOk" class="adm-bad">{{ $t("admin.desk.groupNewIdBad") }}</p>
                        <p class="adm-hint">{{ $t("admin.desk.groupNewIdHint") }}</p>

                        <p class="adm-label">{{ $t("admin.desk.groupNewCaptions") }}</p>
                        <div class="adm-langs">
                            <I18nTextField
                                v-for="locale in detail.locales"
                                :key="'ng-' + locale.code"
                                :field-id="'adm-newgroup-caption-' + locale.code"
                                :label="locale.label + ' (' + locale.code + ')'"
                                :value="draft.newGroup.captions[locale.code]"
                                :max-length="captionMaxLength"
                                :verdict="verdicts.newGroupCaptions[locale.code]"
                                @input="setNewGroupCaption(locale.code, $event)" />
                        </div>
                        <p v-if="newGroupMissingLocales.length > 0" class="adm-note adm-note-warn">
                            {{ $t("admin.desk.groupNewMissing", { locales: newGroupMissingLocales.join(', ') }) }}
                        </p>
                    </div>
                </fieldset>

                <!-- ---------------- the decision ---------------- -->
                <fieldset class="adm-fieldset" v-if="!settled || revising">
                    <legend class="adm-legend">{{ revising ? $t("admin.desk.reviseLegend") : $t("admin.desk.decision") }}</legend>

                    <label class="adm-label" for="adm-reason">{{ $t("admin.desk.reasonLabel") }}</label>
                    <textarea id="adm-reason" class="adm-textarea"
                              :class="{ 'is-bad': draft.reason !== '' && !reasonVerdict.ok }"
                              v-model="draft.reason"></textarea>
                    <p class="adm-hint adm-num">
                        {{ $t("admin.desk.charCount", { n: reasonVerdict.length, max: noteMaxLength }) }}
                    </p>
                    <p v-if="draft.reason !== '' && !reasonVerdict.ok" class="adm-bad">
                        {{ $t("admin.text." + reasonVerdict.reason, { max: noteMaxLength }) }}
                    </p>
                    <p class="adm-hint">{{ $t("admin.desk.reasonHint") }}</p>

                    <!-- THE GATE. A real disabled attribute and a stated reason,
                         not a warning the owner can click through. -->
                    <p v-if="!heard" class="adm-note adm-note-warn">{{ $t("admin.desk.approveNeedsListen") }}</p>
                    <p v-else-if="approveBlockers.length > 0" class="adm-note adm-note-bad">
                        {{ $t("admin.desk.approveBlocked", { reasons: approveBlockers.join('; ') }) }}
                    </p>

                    <div class="adm-actions">
                        <button type="button" class="adm-btn adm-btn-primary"
                                :disabled="!canApprove || busy" @click="approve">
                            {{ revising ? $t("admin.desk.revise") : $t("admin.desk.approve") }}
                        </button>
                        <!-- No reject when revising: the item is already rejected,
                             and a second reject decides nothing. -->
                        <button type="button" class="adm-btn adm-btn-danger" v-if="!revising"
                                :disabled="!canReject || busy" @click="reject">
                            {{ $t("admin.desk.reject") }}
                        </button>
                    </div>
                    <p class="adm-hint">{{ $t("admin.desk.approveIsNotLive") }}</p>
                </fieldset>

                <div v-else class="adm-actions">
                    <button type="button" class="adm-btn adm-btn-primary" :disabled="!canSave || busy" @click="save">
                        {{ $t("admin.desk.saveChanges") }}
                    </button>
                </div>

                <p v-if="submitError" class="adm-note adm-note-bad">{{ submitError }}</p>
            </form>

            <!-- ---------------- what just happened ---------------- -->
            <div v-if="result !== null" class="adm-panel">
                <p class="adm-note adm-note-ok">{{ resultText }}</p>
                <p v-if="result.outcome === 'approved'" class="adm-note adm-note-warn">
                    {{ $t("admin.desk.approvedStaysDraft") }}
                    <button type="button" class="adm-btn-link" @click="$emit('open-publish')">
                        {{ $t("admin.desk.goPublish") }}
                    </button>
                </p>
                <p v-if="result.batchResolved" class="adm-sub">{{ $t("admin.desk.batchResolved") }}</p>
                <button type="button" class="adm-btn" v-if="nextItemId" @click="$emit('open', nextItemId)">
                    {{ $t("admin.desk.reviewNext") }}
                </button>
            </div>
        </div>
    </div>
</template>

<!--
    ===========================================================================
    ONE ITEM
    ===========================================================================
    Play it, name it, write the three captions, settle its group, decide.

    THE MIRROR OF THE SERVER'S TEXT RULES lives at the bottom of this file, in
    one place, and every field on the screen is measured by that one copy. It
    exists so a refusal arrives while the owner is typing rather than as a 400
    after a minute of it. It is a MIRROR, not the authority: server/routes/
    admin.mjs decides, and where the two disagree the request fails with a
    message naming the field, which is a recoverable outcome. That is why the
    limits come from the response (captionLimits) rather than from constants
    here — the two numbers that CAN drift are read from the server on every load.

    WHAT THE BRIEF FOR THIS SCREEN GOT SLIGHTLY WRONG, AND WHY IT MATTERS.
    "A caption containing { } or @: or | is refused server-side" is true of @:
    only. lib/text-safety.mjs REJECTS the linked-message construct and ESCAPES
    the braces and the pipe, substituting fullwidth look-alikes, because
    vue-i18n 8 has no escape syntax and the alternative is the submitter's own
    words silently vanishing. So this screen refuses one and warns about the
    other, showing the exact text that will be stored. Reporting "{" as refused
    would have been a lie the owner discovers on the live site.

    THE ONE GATE. Approve is disabled until ClipAudition reports the clip heard
    through. Reject is not gated the same way, deliberately: approval puts a
    sound on the site and rejection does not, and making someone sit through
    five minutes of a wrong file before they can say "wrong file" would slow the
    queue without making anything safer.
-->

<script>
import Vue from 'vue'
import Component from 'vue-class-component'

import ClipAudition from './ClipAudition.vue'
import I18nTextField from './I18nTextField.vue'

// ---------------------------------------------------------------------------
// the mirror of server/lib/text-safety.mjs

/*
 * Character classes, written as escape sequences and never as literal bytes,
 * for the reason text-safety.mjs gives: a control character written literally
 * into source is invisible to the next reader and to grep, and one editor pass
 * deletes it without a trace.
 */
const HAS_BIDI_CONTROL = new RegExp('[\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]')
const HAS_INVISIBLE_CHARACTER = new RegExp('[\\u200B\\u2060\\uFEFF]')
const HAS_LINKED_MESSAGE = /@(?:\.[A-Za-z]+)?:/

/**
 * C0, DEL and C1 — the two ranges text-safety.mjs writes as one character
 * class.
 *
 * Written as a scan over code units rather than as a regex because
 * eslint:recommended's no-control-regex refuses that class outright, and the
 * only ways past it are a suppression comment on the one guard whose entire job
 * is to find control characters, or this. Numeric comparisons carry the same
 * property the escape sequences were chosen for — nothing invisible in the
 * source — and they carry it more strongly.
 *
 * @param {boolean} allowLineBreaks tab, newline and carriage return survive.
 *   A reviewer's note is allowed paragraphs (cleanNote); a caption is a
 *   single-line button label and gets none of them (validateCaption).
 */
function hasControlCharacter(text, allowLineBreaks) {
    for (let i = 0; i < text.length; i++) {
        const unit = text.charCodeAt(i)
        if (allowLineBreaks && (unit === 0x09 || unit === 0x0a || unit === 0x0d)) continue
        if (unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f)) return true
    }
    return false
}

// server/routes/admin.mjs: NOTE_MAX_LENGTH. Not returned by any route, so this
// one IS a copy and can drift. If it ever does, the server answers 400 naming
// the field — visible and recoverable, unlike a limit that silently disagrees.
const NOTE_MAX_LENGTH = 500

// server/routes/admin.mjs: ID_PATTERN, the vue-i18n key charset.
const GROUP_ID_PATTERN = /^[a-z0-9_-]{1,64}$/

const DRAFT_PREFIX = 'joi.admin.draft.v1.'
const SAVE_DEBOUNCE_MS = 400

/**
 * A stable string for "is this draft the same as the untouched one".
 *
 * Keys are sorted, so the answer depends on the values and not on the order two
 * different code paths happened to build the object in. Without this the
 * comparison is correct only as long as seedDraft's two object literals keep
 * matching key order — and when it silently stops being correct, the symptom is
 * a restore banner appearing over a draft identical to the submission, which is
 * exactly how a banner teaches the person reading it to stop reading it.
 */
function canonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
    return '{' + Object.keys(value).sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') + '}'
}

/**
 * The server measures length in CODE POINTS, so an emoji costs one and not two.
 * Written as a surrogate-pair walk rather than [...text].length or Array.from:
 * both of those compile, through babel, to a helper that falls back to indexed
 * iteration when Symbol.iterator is missing — which counts UTF-16 units and is
 * wrong silently. This browser list includes browsers old enough for that to
 * matter, and a length gate that is quietly wrong is worse than none.
 */
function codePointLength(text) {
    let count = 0
    for (let i = 0; i < text.length; i++) {
        const unit = text.charCodeAt(i)
        if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
            const next = text.charCodeAt(i + 1)
            if (next >= 0xdc00 && next <= 0xdfff) i++
        }
        count++
    }
    return count
}

/**
 * text-safety.mjs writes this as one regex with a lookbehind. A lookbehind in a
 * regex LITERAL is a parse error, not a runtime one, on Safari before 16.4 — it
 * would take this whole chunk down rather than this one field. Same predicate,
 * no lookbehind.
 */
function hasLoneSurrogate(text) {
    for (let i = 0; i < text.length; i++) {
        const unit = text.charCodeAt(i)
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
            if (!(next >= 0xdc00 && next <= 0xdfff)) return true
            i++
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            return true
        }
    }
    return false
}

/**
 * What the server will store for a caption that passes the gate.
 *
 * Only the substitutions are applied. escapeForI18n also strips controls, bidi
 * marks, invisibles and lone surrogates first — but validate() below refuses
 * every one of those, so on a text that reaches here that pass is a no-op. The
 * server states the same invariant from the other side: "escapeForI18n only
 * strips and substitutes 1:1, so it can never turn a caption that passed this
 * gate into one that would fail it."
 */
function storedForm(trimmed) {
    return trimmed.split('{').join('｛').split('}').join('｝').split('|').join('｜')
}

/**
 * The verdict on one message-value field.
 *
 * Order matches validateCaption() so the reason code the owner sees is the one
 * the server would have sent.
 *
 * @returns {{ok: boolean, reason: string|null, length: number, escaped: boolean, stored: string}}
 */
function judgeText(raw, maxLength) {
    const text = typeof raw === 'string' ? raw : ''
    const trimmed = text.trim()
    const length = codePointLength(trimmed)
    const verdict = { ok: false, reason: null, length, escaped: false, stored: '' }

    if (trimmed === '') { verdict.reason = 'empty'; return verdict }
    if (length > maxLength) { verdict.reason = 'too_long'; return verdict }
    if (hasLoneSurrogate(trimmed)) { verdict.reason = 'lone_surrogate'; return verdict }
    if (hasControlCharacter(trimmed, false)) { verdict.reason = 'control_character'; return verdict }
    if (HAS_BIDI_CONTROL.test(trimmed)) { verdict.reason = 'bidi_control'; return verdict }
    if (HAS_INVISIBLE_CHARACTER.test(trimmed)) { verdict.reason = 'invisible_character'; return verdict }
    if (HAS_LINKED_MESSAGE.test(trimmed)) { verdict.reason = 'linked_message'; return verdict }

    verdict.ok = true
    verdict.stored = storedForm(trimmed)
    verdict.escaped = verdict.stored !== trimmed
    return verdict
}

/** The verdict on a reviewer's note — different rules, so a different function. */
function judgeNote(raw) {
    const text = typeof raw === 'string' ? raw : ''
    const trimmed = text.trim()
    const length = codePointLength(trimmed)
    const verdict = { ok: false, reason: null, length }

    if (trimmed === '') { verdict.reason = 'empty'; return verdict }
    if (length > NOTE_MAX_LENGTH) { verdict.reason = 'too_long'; return verdict }
    if (hasLoneSurrogate(trimmed)) { verdict.reason = 'lone_surrogate'; return verdict }
    if (hasControlCharacter(trimmed, true)) { verdict.reason = 'control_character'; return verdict }

    verdict.ok = true
    return verdict
}

// ---------------------------------------------------------------------------

@Component({
    components: { ClipAudition, I18nTextField },
    inject: ['adminApi'],
    props: {
        itemId: { type: String, required: true },
        heard: { type: Boolean, default: false },
        siblingsByGroup: { type: Object, default: null },
        nextItemId: { type: String, default: null },
    },
    watch: {
        draft: { handler: 'scheduleSave', deep: true },
    },
})
class ReviewDeskItem extends Vue {
    phase = 'loading'
    loadError = ''
    submitError = ''
    busy = false
    detail = null
    result = null

    restoredAt = null
    storageBroken = false

    draft = {
        label: '',
        captions: {},
        groupMode: 'reassign',
        groupId: '',
        newGroup: { id: '', displayName: '', captions: {} },
        reason: '',
    }

    // -- derived limits, read from the server rather than copied -------------
    get captionMaxLength() {
        return this.detail.captionLimits.captionMaxLength
    }
    get labelMaxLength() {
        return this.detail.captionLimits.labelMaxLength
    }
    get noteMaxLength() {
        return NOTE_MAX_LENGTH
    }

    get settled() {
        return this.detail !== null && this.detail.item.state !== 'pending'
    }

    /** A rejected item re-opened to overturn the rejection (STORY-076). The desk
     *  shows the approve form again — minus the reject button, since a second
     *  reject decides nothing — and the server routes the approve to a revise. */
    get revising() {
        return this.detail !== null && this.detail.item.state === 'rejected'
    }

    /** A decided item is still editable when it produced a clip; that is where
     *  translations get typed and typos get fixed, forever. A rejected item is
     *  editable while it is being revised. */
    get editable() {
        return !this.settled || this.detail.clip !== null || this.revising
    }

    get proposedGroup() {
        const id = this.detail.item.proposedGroupId
        if (!id) return null
        const group = this.detail.groups.filter((g) => g.id === id)[0]
        // A retired proposal is not an option: the route refuses it.
        return group && group.state === 'active' ? group : null
    }

    get chosenGroupId() {
        if (this.draft.groupMode === 'accept') return this.proposedGroup === null ? '' : this.proposedGroup.id
        if (this.draft.groupMode === 'reassign') return this.draft.groupId
        return ''
    }

    get chosenGroup() {
        const id = this.chosenGroupId
        if (!id) return null
        return this.detail.groups.filter((g) => g.id === id)[0] || null
    }

    // -- verdicts -------------------------------------------------------------
    get verdicts() {
        const captions = {}
        const newGroupCaptions = {}
        for (const locale of this.detail.locales) {
            const typed = this.draft.captions[locale.code] || ''
            // An untouched field is not a mistake — a locale the owner has not
            // written yet is an ABSENT key, which the route treats as "skip".
            // Only a field with something in it gets judged.
            captions[locale.code] = typed.trim() === '' ? null : judgeText(typed, this.captionMaxLength)
            const typedGroup = this.draft.newGroup.captions[locale.code] || ''
            newGroupCaptions[locale.code] = typedGroup.trim() === '' ? null : judgeText(typedGroup, this.captionMaxLength)
        }
        return {
            label: judgeText(this.draft.label, this.labelMaxLength),
            captions,
            newGroupCaptions,
            newGroupName: this.draft.newGroup.displayName.trim() === ''
                ? null
                : judgeText(this.draft.newGroup.displayName, this.labelMaxLength),
        }
    }

    get reasonVerdict() {
        return judgeNote(this.draft.reason)
    }

    /** Locale codes with nothing typed. Not an error — a promise deferred. */
    get missingLocales() {
        return this.detail.locales
            .filter((locale) => (this.draft.captions[locale.code] || '').trim() === '')
            .map((locale) => locale.code)
    }

    get newGroupMissingLocales() {
        return this.detail.locales
            .filter((locale) => (this.draft.newGroup.captions[locale.code] || '').trim() === '')
            .map((locale) => locale.code)
    }

    get filledCaptions() {
        const out = {}
        for (const locale of this.detail.locales) {
            const typed = (this.draft.captions[locale.code] || '').trim()
            // '' is never sent: validateCaption refuses it, and the route's own
            // comment explains that an absent key renders as a visible key path
            // while an empty one renders as an invisible hole.
            if (typed !== '') out[locale.code] = typed
        }
        return out
    }

    get filledNewGroupCaptions() {
        const out = {}
        for (const locale of this.detail.locales) {
            const typed = (this.draft.newGroup.captions[locale.code] || '').trim()
            if (typed !== '') out[locale.code] = typed
        }
        return out
    }

    get newGroupIdOk() {
        const id = this.draft.newGroup.id.trim()
        return id === '' || GROUP_ID_PATTERN.test(id)
    }

    /**
     * A display name another ACTIVE group already holds. Reported as a warning,
     * never as a block: the route compares COLLATE NOCASE, which folds ASCII
     * only, while toLowerCase() here folds the whole of Unicode. A stricter
     * client predicate would refuse names the server would have taken, so this
     * one only speaks up.
     */
    get newGroupNameClash() {
        const wanted = this.draft.newGroup.displayName.trim().toLowerCase()
        if (wanted === '') return null
        const clash = this.detail.groups.filter(
            (group) => group.state === 'active' && group.displayName.toLowerCase() === wanted,
        )[0]
        return clash ? clash.id : null
    }

    get approveBlockers() {
        const blockers = []
        if (!this.verdicts.label.ok) blockers.push(this.$t('admin.desk.blockName'))
        for (const locale of this.detail.locales) {
            const verdict = this.verdicts.captions[locale.code]
            if (verdict !== null && !verdict.ok) blockers.push(locale.code)
        }
        // The route refuses an approval with no captions at all: "a clip with
        // none renders as its own key path".
        if (Object.keys(this.filledCaptions).length === 0) blockers.push(this.$t('admin.desk.blockNoCaption'))
        if (this.draft.groupMode === 'new') {
            if (this.verdicts.newGroupName === null || !this.verdicts.newGroupName.ok) {
                blockers.push(this.$t('admin.desk.blockGroupName'))
            }
            if (!this.newGroupIdOk) blockers.push(this.$t('admin.desk.blockGroupId'))
            for (const locale of this.detail.locales) {
                const verdict = this.verdicts.newGroupCaptions[locale.code]
                if (verdict !== null && !verdict.ok) blockers.push('group ' + locale.code)
            }
        } else if (this.chosenGroupId === '') {
            blockers.push(this.$t('admin.desk.blockGroup'))
        }
        if (this.draft.reason.trim() !== '' && !this.reasonVerdict.ok) {
            blockers.push(this.$t('admin.desk.blockReason'))
        }
        return blockers
    }

    get canApprove() {
        return this.heard && this.approveBlockers.length === 0
    }

    get canReject() {
        return this.reasonVerdict.ok
    }

    get canSave() {
        if (!this.verdicts.label.ok) return false
        for (const locale of this.detail.locales) {
            const verdict = this.verdicts.captions[locale.code]
            if (verdict !== null && !verdict.ok) return false
        }
        return true
    }

    get siblingLabels() {
        if (this.siblingsByGroup === null) return null
        const id = this.chosenGroupId
        if (!id) return []
        return (this.siblingsByGroup[id] || []).slice(0, 4).map((clip) => clip.label)
    }

    get resultText() {
        if (this.result.outcome === 'approved') return this.$t('admin.desk.resultApproved')
        if (this.result.outcome === 'rejected') return this.$t('admin.desk.resultRejected')
        return this.$t('admin.desk.resultSaved')
    }

    // -- lifecycle ------------------------------------------------------------
    created() {
        this.load()
    }

    beforeDestroy() {
        this.cancelSave()
    }

    async load() {
        this.phase = 'loading'
        this.loadError = ''
        try {
            this.detail = await this.adminApi.get('/api/admin/item/' + encodeURIComponent(this.itemId))
            this.seedDraft()
            this.phase = 'ready'
        } catch (error) {
            if (error.code === 'gone') return
            this.loadError = error.message
            this.phase = 'error'
        }
    }

    /**
     * The draft starts from what the server holds, then a stored draft is laid
     * over it. The banner appears only when the two actually differ: announcing
     * a restore that changed nothing trains the owner to dismiss the banner
     * without reading it, and then it is not a banner any more.
     */
    seedDraft() {
        const clip = this.detail.clip
        const captions = {}
        const newGroupCaptions = {}
        for (const locale of this.detail.locales) {
            captions[locale.code] = clip === null ? '' : (clip.captions[locale.code] || '')
            newGroupCaptions[locale.code] = ''
        }

        const proposed = this.proposedGroupIdOrNull()
        const pristine = {
            // The submitter's proposal is where the name starts; proposed_label
            // itself is never overwritten server-side, so this is a copy the
            // owner edits, not the record of what was asked for.
            label: clip === null ? this.detail.item.proposedLabel : clip.label,
            captions,
            groupMode: clip !== null ? 'reassign' : (proposed === null ? 'reassign' : 'accept'),
            groupId: clip !== null ? clip.groupId : (proposed === null ? '' : proposed),
            newGroup: { id: '', displayName: '', captions: newGroupCaptions },
            reason: '',
        }
        this.pristine = canonical(pristine)
        this.pristineJson = JSON.stringify(pristine)
        this.draft = pristine

        const stored = this.readStoredDraft()
        if (stored === null) return
        // A stored draft is merged field by field rather than assigned whole, so
        // a draft written before a field existed cannot leave that field
        // undefined and blank the input.
        const merged = {
            label: typeof stored.label === 'string' ? stored.label : pristine.label,
            captions: Object.assign({}, pristine.captions, stored.captions || {}),
            groupMode: stored.groupMode || pristine.groupMode,
            groupId: typeof stored.groupId === 'string' ? stored.groupId : pristine.groupId,
            newGroup: {
                id: (stored.newGroup && stored.newGroup.id) || '',
                displayName: (stored.newGroup && stored.newGroup.displayName) || '',
                captions: Object.assign({}, newGroupCaptions, (stored.newGroup && stored.newGroup.captions) || {}),
            },
            reason: typeof stored.reason === 'string' ? stored.reason : '',
        }
        if (canonical(merged) === this.pristine) {
            this.forgetDraft()
            return
        }
        this.draft = merged
        this.restoredAt = stored.savedAt || ''
    }

    proposedGroupIdOrNull() {
        const id = this.detail.item.proposedGroupId
        if (!id) return null
        const group = this.detail.groups.filter((g) => g.id === id)[0]
        return group && group.state === 'active' ? id : null
    }

    setCaption(locale, value) {
        this.$set(this.draft.captions, locale, value)
    }

    setNewGroupCaption(locale, value) {
        this.$set(this.draft.newGroup.captions, locale, value)
    }

    groupCaptionFor(localeCode) {
        const group = this.chosenGroup
        return group === null ? '' : (group.captions[localeCode] || '')
    }

    /**
     * What the clips already in this group say, in one locale — the register the
     * next caption has to match. The "煎G蛋-" style prefix is a per-group
     * convention that lives nowhere but in these strings, so it has to be on
     * screen while the caption is typed.
     *
     * null means the published catalogue could not be read, which the field
     * renders differently from an empty group: "I could not look" and "there is
     * nothing to match" are different instructions.
     */
    siblingCaptionsFor(localeCode) {
        if (this.siblingsByGroup === null) return null
        const id = this.chosenGroupId
        if (!id) return []
        return (this.siblingsByGroup[id] || [])
            .map((clip) => clip.captions[localeCode])
            .filter((caption) => typeof caption === 'string' && caption !== '')
            .slice(0, 4)
    }

    // -- drafts ---------------------------------------------------------------
    get storageKey() {
        return DRAFT_PREFIX + this.itemId
    }

    readStoredDraft() {
        try {
            const raw = window.localStorage.getItem(this.storageKey)
            if (!raw) return null
            const parsed = JSON.parse(raw)
            return parsed && typeof parsed === 'object' ? parsed : null
        } catch (ignored) {
            // Unreadable is the same as absent, and losing a draft must never
            // stop the item from being reviewed.
            return null
        }
    }

    scheduleSave() {
        this.cancelSave()
        this.saveTimer = window.setTimeout(() => this.writeDraft(), SAVE_DEBOUNCE_MS)
    }

    cancelSave() {
        if (this.saveTimer) {
            window.clearTimeout(this.saveTimer)
            this.saveTimer = null
        }
    }

    writeDraft() {
        if (this.phase !== 'ready') return
        const payload = JSON.parse(JSON.stringify(this.draft))
        if (canonical(payload) === this.pristine) {
            this.forgetDraft()
            return
        }
        payload.savedAt = new Date().toISOString()
        try {
            window.localStorage.setItem(this.storageKey, JSON.stringify(payload))
            this.storageBroken = false
        } catch (ignored) {
            // Private browsing and a full quota both throw here. An autosave
            // that has silently stopped saving is worse than none at all, so
            // the banner says so rather than the owner finding out by losing an
            // evening's typing.
            this.storageBroken = true
        }
    }

    forgetDraft() {
        try {
            window.localStorage.removeItem(this.storageKey)
        } catch (ignored) {
            // Nothing to do and nothing at risk: the worst case is a stale key.
        }
    }

    discardDraft() {
        this.cancelSave()
        this.forgetDraft()
        this.restoredAt = null
        this.draft = JSON.parse(this.pristineJson)
    }

    // -- decisions ------------------------------------------------------------
    async approve() {
        const body = { decision: 'approve', label: this.draft.label.trim(), captions: this.filledCaptions }
        if (this.draft.groupMode === 'new') {
            const newGroup = { displayName: this.draft.newGroup.displayName.trim(), captions: this.filledNewGroupCaptions }
            // Omitted rather than sent empty: the route mints a uuid when the id
            // is absent, and '' is not a legal key.
            if (this.draft.newGroup.id.trim() !== '') newGroup.id = this.draft.newGroup.id.trim()
            body.newGroup = newGroup
        } else {
            body.groupId = this.chosenGroupId
        }
        if (this.draft.reason.trim() !== '') body.reason = this.draft.reason.trim()
        await this.send(body)
    }

    async reject() {
        await this.send({ decision: 'reject', reason: this.draft.reason.trim() })
    }

    async save() {
        // No decision: an edit of the clip an approval already produced.
        const body = { label: this.draft.label.trim(), captions: this.filledCaptions }
        // groupId travels only when it actually moves. Sending the clip's
        // current group back would put it through requireActiveGroup, which
        // refuses a retired one — so editing a caption on a clip in a group that
        // has since retired would fail for a reason that has nothing to do with
        // the caption.
        if (this.chosenGroupId !== '' && this.chosenGroupId !== this.detail.clip.groupId) {
            body.groupId = this.chosenGroupId
        }
        await this.send(body)
    }

    async send(body) {
        this.busy = true
        this.submitError = ''
        try {
            const response = await this.adminApi.post('/api/admin/item/' + encodeURIComponent(this.itemId), body)
            this.result = response
            this.cancelSave()
            this.forgetDraft()
            this.restoredAt = null
            this.$emit('decided', this.itemId)
            // Re-read rather than patch: the response says what changed, the
            // route says what the item now IS, and only one of those two is
            // worth rendering a decision from.
            await this.load()
        } catch (error) {
            if (error.code !== 'gone') this.submitError = error.message
        } finally {
            this.busy = false
        }
    }
}

export default ReviewDeskItem
</script>
