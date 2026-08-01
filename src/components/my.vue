<template>
    <div class="container-fluid my-page">
        <div class="cate-header">{{ $t('submit.my.heading') }}</div>

        <!-- no API behind this host -->
        <div v-if="phase === 'unavailable'" class="panel-block" aria-live="polite">
            <p class="lead-line">{{ $t('submit.error.heading') }}</p>
            <p>{{ $t(pageError === 'network' ? 'submit.error.network' : 'submit.error.apiUnavailable') }}</p>
            <div class="cate-body">
                <button class="btn btn-info" type="button" @click="reload">{{ $t('submit.action.tryAgain') }}</button>
                <router-link class="btn btn-new" to="/">{{ $t('submit.action.home') }}</router-link>
            </div>
        </div>

        <!-- signed out: this list is only ever somebody's own -->
        <div v-else-if="phase === 'anon'" class="panel-block">
            <p>{{ $t('submit.my.needSignIn') }}</p>
            <div class="cate-body">
                <router-link class="btn btn-new" to="/submit">{{ $t('submit.action.toSubmit') }}</router-link>
            </div>
        </div>

        <template v-else>
            <p>{{ $t('submit.page.myLead') }}</p>

            <p v-if="phase === 'loading'" aria-live="polite">{{ $t('submit.my.loading') }}</p>

            <div v-if="phase === 'ready' && batches.length === 0" class="panel-block">
                <p>{{ $t('submit.my.empty') }}</p>
                <div class="cate-body">
                    <router-link class="btn btn-new" to="/submit">{{ $t('submit.action.toSubmit') }}</router-link>
                </div>
            </div>

            <div v-for="batch in batches" :key="batch.id" class="batch-block">
                <p class="batch-head">
                    <span class="badge-line" :class="batchClass(batch.state)">{{ batchStateText(batch.state) }}</span>
                    <span class="batch-when">{{ $t('submit.my.submittedAt', { time: formatTime(batch.submittedAt || batch.createdAt) }) }}</span>
                    <span class="muted">{{ $t('submit.my.items', { n: batch.items.length }) }}</span>
                    <span v-if="batch.resolvedAt" class="muted">{{ $t('submit.my.resolvedAt', { time: formatTime(batch.resolvedAt) }) }}</span>
                </p>

                <div v-for="item in batch.items" :key="item.id" class="clip-item">
                    <p class="clip-head">
                        <span class="clip-index">{{ item.position }}.</span>
                        <!-- Submitter-authored: a VALUE, never a message key. -->
                        <span class="clip-name">{{ item.name }}</span>
                        <span class="badge-line" :class="itemClass(item.state)">{{ itemStateText(item.state) }}</span>
                    </p>
                    <p v-if="item.caption" class="clip-caption">
                        <span class="muted">{{ $t('submit.my.caption') }}</span>
                        <span>{{ item.caption.text }}</span>
                        <span class="muted">[{{ item.caption.locale }}]</span>
                    </p>
                    <p class="muted">
                        <span v-if="item.groupName">{{ $t('submit.my.group', { name: item.groupName }) }}</span>
                        <span v-else-if="item.proposedGroup">{{ $t('submit.my.proposedGroup', { name: item.proposedGroup }) }}</span>
                        <span v-else>{{ $t('submit.my.noGroup') }}</span>
                        <span>{{ $t('submit.my.facts', { size: humanBytes(item.media.bytes), seconds: seconds(item.media.durationSeconds) }) }}</span>
                    </p>
                    <!-- The reviewer's own sentence. batch_items refuses a rejection
                         without one — "a refusal the submitter cannot read is a refusal
                         nobody can appeal" — so this is the whole point of the page. -->
                    <p v-if="item.reviewerNote" class="review-note">
                        <span class="lead-line">{{ $t('submit.my.reviewerNote') }}</span>
                        <span>{{ item.reviewerNote }}</span>
                    </p>
                </div>
            </div>

            <div v-if="listError" class="panel-block" aria-live="polite">
                <p>{{ listErrorText }}</p>
            </div>

            <div class="cate-body">
                <button v-if="nextCursor" class="btn btn-info" type="button" :disabled="loadingMore" @click="loadMore">
                    {{ $t('submit.action.loadMore') }}
                </button>
                <button class="btn btn-info" type="button" :disabled="loadingMore" @click="reload">
                    {{ $t('submit.action.refresh') }}
                </button>
                <router-link class="btn btn-new" to="/submit">{{ $t('submit.action.toSubmit') }}</router-link>
            </div>
        </template>
    </div>
</template>

<style lang="scss" scoped>
/* Same rule as the submit page: no colour is chosen here, only tokens from
   App.vue's :root in pairings App.vue already measured. And the same trap —
   the five measured button states are declared on the ELEMENT `button`, so a
   link that looks like a button carries .btn-new (a class selector) rather than
   .btn-info, which on an <a> would fall through to Bootstrap's white-on-#5bc0de
   at 2.2:1. */
.panel-block {
    background-color: var(--surface);
    border: 1px solid var(--candy-red);      /* 4.62:1 on white */
    border-radius: 10px;
    padding: 12px;
    margin-bottom: 12px;
}
.batch-block {
    background-color: var(--surface);
    border: 1px solid var(--candy-red);
    border-radius: 10px;
    padding: 10px 12px;
    margin-bottom: 12px;
}
.batch-head {
    margin-bottom: 8px;
}
.batch-when {
    font-weight: bold;
    margin: 0 8px;
}
.clip-item {
    border-top: 1px solid var(--track);
    padding-top: 8px;
    margin-top: 8px;
}
.clip-head {
    margin-bottom: 2px;
}
.clip-index {
    font-weight: bold;
    margin-right: 4px;
}
.clip-name {
    font-weight: bold;
    margin-right: 8px;
    word-break: break-all;
}
.clip-caption span + span {
    margin-left: 6px;
}
.muted {
    color: var(--cocoa-700);        /* 12.49:1 on white */
    font-size: 13px;
}
.muted span + span {
    margin-left: 8px;
}
.lead-line {
    font-weight: bold;
}
.badge-line {
    display: inline-block;
    border-radius: 6px;
    padding: 2px 8px;
    font-size: 13px;
}
/* The pairings App.vue measured: white on red 4.62:1, plum-900 on lilac 5.21:1,
   plum-700 on white 8.99:1. */
.state-bad {
    background-color: var(--candy-red);
    color: white;
}
.state-ok {
    background-color: var(--lilac);
    color: var(--plum-900);
}
.state-wait {
    background-color: var(--surface);
    color: var(--plum-700);
    border: 2px solid var(--candy-red);
}
.review-note {
    background-color: var(--surface-alt);
    border-left: 4px solid var(--candy-red);
    padding: 6px 10px;
    margin-top: 4px;
}
.review-note span + span {
    margin-left: 6px;
}
</style>

<script>
import Vue from 'vue'
import Component from 'vue-class-component'

// The page size the API clamps to anyway (clampLimit: 1..50, default 20). Named
// here so the "load more" button is a decision this page made rather than a
// default it inherited silently.
const PAGE_SIZE = 20

/**
 * One JSON call, with the two failures this deployment can actually produce.
 *
 * A near-copy of the one in submit.vue on purpose: the two pages are separate
 * webpack chunks and a shared helper would have to live in a third file, which
 * is outside what this change owns. If a util/api.js ever appears, both should
 * move to it.
 *
 * `api_unavailable` is the case worth keeping: nginx answers an unknown path
 * with index.html, so a host without the API answers /api/my/submissions with
 * HTML rather than with a refusal.
 */
async function callJson(url) {
    let response
    try {
        response = await fetch(url, { credentials: 'same-origin' })
    } catch (error) {
        return { ok: false, code: 'network', body: null }
    }
    const type = response.headers.get('content-type') || ''
    if (!/\bapplication\/json\b/i.test(type)) {
        return { ok: false, code: 'api_unavailable', body: null }
    }
    let body = null
    try {
        body = await response.json()
    } catch (error) {
        return { ok: false, code: 'api_unavailable', body: null }
    }
    if (response.ok) return { ok: true, code: null, body }
    return { ok: false, code: body && body.error && body.error.code ? body.error.code : 'unexpected', body }
}

function humanBytes(bytes) {
    if (!Number.isFinite(bytes)) return ''
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB'
    return bytes + ' B'
}

@Component
class MyPage extends Vue {
    // 'loading' | 'unavailable' | 'anon' | 'ready'
    phase = 'loading'
    pageError = null
    listError = null
    loadingMore = false

    batches = []
    nextCursor = null

    mounted() {
        this.reload()
    }

    reload() {
        this.batches = []
        this.nextCursor = null
        this.listError = null
        this.phase = 'loading'
        this.fetchPage(null)
    }

    loadMore() {
        this.fetchPage(this.nextCursor)
    }

    async fetchPage(cursor) {
        this.loadingMore = true
        this.listError = null
        let url = '/api/my/submissions?limit=' + PAGE_SIZE
        // Keyset, not an offset: the server pages this way so that a batch
        // submitted while somebody is reading does not shift every unread page.
        if (cursor) url += '&cursor=' + encodeURIComponent(cursor)
        const answer = await callJson(url)
        this.loadingMore = false

        if (!answer.ok) {
            if (answer.code === 'identity_required') {
                this.phase = 'anon'
                // This page just learned the session is gone — expired, or ended
                // in another tab. The navbar has no way to find that out on its
                // own (it re-reads only on a path change), so it would keep
                // showing the name of a session that no longer exists.
                this.$gConst.globalbus.$emit('auth:changed')
                return
            }
            if (answer.code === 'api_unavailable' || answer.code === 'network') {
                // On a first load there is nothing on screen to keep, so the page
                // becomes the error. On a later page the list stays and the error
                // is a line under it.
                if (this.batches.length === 0) {
                    this.pageError = answer.code
                    this.phase = 'unavailable'
                    return
                }
            }
            this.listError = answer.code
            this.phase = 'ready'
            return
        }

        const page = Array.isArray(answer.body.submissions) ? answer.body.submissions : []
        this.batches = this.batches.concat(page)
        this.nextCursor = answer.body.nextCursor || null
        this.phase = 'ready'
    }

    // ---------------------------------------------------------------- wording

    get listErrorText() {
        const key = 'submit.reason.' + this.listError
        if (this.$te(key)) return this.$t(key)
        if (this.listError === 'network') return this.$t('submit.error.network')
        if (this.listError === 'api_unavailable') return this.$t('submit.error.apiUnavailable')
        return this.$t('submit.error.unexpected')
    }

    itemStateText(state) {
        const key = 'submit.my.itemState.' + state
        // A state this build has never heard of is shown as itself rather than as
        // a key path: batch_items.state is CHECKed to four values, and a fifth
        // would mean the server moved on without this page.
        return this.$te(key) ? this.$t(key) : state
    }

    batchStateText(state) {
        const key = 'submit.my.batchState.' + state
        return this.$te(key) ? this.$t(key) : state
    }

    itemClass(state) {
        if (state === 'approved') return 'state-ok'
        if (state === 'rejected' || state === 'failed') return 'state-bad'
        return 'state-wait'
    }

    batchClass(state) {
        if (state === 'resolved') return 'state-ok'
        if (state === 'cancelled') return 'state-bad'
        return 'state-wait'
    }

    /**
     * A canonical timestamp, in the reader's own terms.
     *
     * An unparseable value is shown verbatim instead of as "Invalid Date": it
     * came from the server and it is still the only fact anybody has about when
     * this happened.
     */
    formatTime(value) {
        if (typeof value !== 'string' || value === '') return ''
        const when = new Date(value)
        if (Number.isNaN(when.getTime())) return value
        return when.toLocaleString(this.$i18n.locale)
    }

    seconds(value) {
        return Number.isFinite(value) ? value.toFixed(1) : '?'
    }

    humanBytes(bytes) {
        return humanBytes(bytes)
    }
}

export default MyPage
</script>
