<template>
    <div>
        <div class="adm-panel">
            <div class="adm-panel-head">
                <div>
                    <h2 class="adm-h">{{ $t("admin.publish.title") }}</h2>
                    <p class="adm-sub">{{ $t("admin.publish.twoStage") }}</p>
                </div>
                <button type="button" class="adm-btn" :disabled="busy" @click="check">
                    {{ busy ? $t("admin.common.loading") : $t("admin.publish.recheck") }}
                </button>
            </div>

            <p v-if="callError" class="adm-note adm-note-bad">{{ callError }}</p>

            <!-- The count that matters, first and in words: how many approvals
                 are sitting in the database with nothing on the site to show for
                 them. -->
            <p v-if="plan !== null" class="adm-note" :class="waiting > 0 ? 'adm-note-warn' : 'adm-note-ok'">
                <strong class="adm-num">{{ waiting > 0
                    ? $t("admin.publish.waiting", { count: waiting })
                    : $t("admin.publish.nothingWaiting") }}</strong>
            </p>

            <div v-if="blockers.length > 0">
                <p class="adm-note adm-note-bad">{{ $t("admin.publish.refused") }}</p>
                <ul>
                    <li v-for="(blocker, index) in blockers" :key="index">{{ blocker }}</li>
                </ul>
            </div>

            <div v-if="plan !== null && plan.existingHoles && plan.existingHoles.length > 0" class="adm-note adm-note-warn">
                <p>{{ $t("admin.publish.existingHoles") }}</p>
                <ul>
                    <li v-for="(hole, index) in plan.existingHoles" :key="index" class="adm-mono">
                        {{ hole.subject_kind }} {{ hole.subject_id }} — {{ hole.locale }}
                    </li>
                </ul>
            </div>

            <!-- Labelled as the catalogue AS IT STANDS, never as a preview of
                 what publishing would produce. The route is explicit that a dry
                 run deliberately does not simulate the promotion, "because a
                 document built from rows that were never promoted would be a
                 preview of a state no database was ever in". Calling these
                 numbers a forecast would undo that care in the UI. -->
            <dl v-if="catalog !== null" class="adm-register">
                <dt>{{ $t("admin.publish.asItStands") }}</dt>
                <dd class="adm-num">{{ $t("admin.publish.catalogCounts", { groups: catalog.groups, clips: catalog.clips }) }}</dd>
                <dt>{{ $t("admin.publish.digest") }}</dt>
                <dd class="adm-mono">{{ catalog.catalogSha256 }}</dd>
                <dt>{{ $t("admin.publish.writtenAt") }}</dt>
                <dd class="adm-num">{{ catalog.writtenAt }}</dd>
            </dl>

            <label class="adm-choice">
                <input type="checkbox" v-model="verifyBySha">
                {{ $t("admin.publish.verifySha") }}
            </label>
            <p class="adm-hint">{{ $t("admin.publish.verifyShaHint") }}</p>

            <div class="adm-actions">
                <button type="button" class="adm-btn adm-btn-primary"
                        :disabled="busy || blockers.length > 0" @click="publish">
                    {{ $t("admin.publish.go", { count: waiting }) }}
                </button>
            </div>
            <p class="adm-hint">{{ $t("admin.publish.goHint") }}</p>

            <p v-if="published !== null" class="adm-note adm-note-ok">
                {{ published.catalog.catalogChanged
                    ? $t("admin.publish.done", { count: published.plan.promoting.length })
                    : $t("admin.publish.doneUnchanged", { count: published.plan.promoting.length }) }}
            </p>
        </div>
    </div>
</template>

<!--
    ===========================================================================
    APPROVED IS NOT LIVE
    ===========================================================================
    Approving an item writes a clip in state 'draft'. Publishing promotes every
    draft and writes catalog.json. Two events, two transactions, deliberately in
    that order — server/lib/catalog.mjs explains that a database ahead of the
    file is recoverable on the next publish and a file ahead of the database is
    not.

    This panel exists because that gap is invisible from the desk: an owner who
    approves ten clips and reloads the site sees nothing, and the natural
    conclusion is that something is broken. So the number of clips waiting is
    the first thing on the screen, and the catalogue figures beside it are
    labelled as what is on the site NOW rather than as a preview.

    THE DRY RUN'S REFUSAL IS THE REPORT. POST /api/admin/publish with dryRun
    answers 409 when a translation is missing, a group is retired, or a blob is
    absent — and carries the whole plan in `details`. So a rejected dry run is
    not a failed request to retry; it is the list of what has to be fixed, and
    it is rendered as such.
-->

<script>
import Vue from 'vue'
import Component from 'vue-class-component'

@Component({
    inject: ['adminApi'],
})
class PublishPanel extends Vue {
    busy = false
    callError = ''
    plan = null
    catalog = null
    // `plan.existingHoles` and the response's `warnings` are the same list, and
    // only the plan survives a 409 — so the plan is the one this reads, in both
    // outcomes, rather than two fields that agree until they do not.
    blockers = []
    published = null
    verifyBySha = false

    get waiting() {
        return this.plan === null ? 0 : this.plan.promoting.length
    }

    created() {
        this.check()
    }

    /** A dry run: reports, never writes. The route says so and a test holds it. */
    async check() {
        this.busy = true
        this.callError = ''
        this.blockers = []
        try {
            const response = await this.adminApi.post('/api/admin/publish', {
                dryRun: true,
                verifyMedia: this.verifyBySha ? 'sha256' : 'stat',
            })
            this.plan = response.plan
            this.catalog = response.catalog
        } catch (error) {
            if (error.code === 'gone') return
            // A 409 carries the plan that caused it. Anything else is a genuine
            // failure and keeps whatever the last good look reported, rather
            // than blanking the screen and losing the numbers with it.
            if (error.status === 409 && error.details) {
                this.plan = error.details
                this.blockers = this.describe(error.details)
            } else {
                this.callError = error.message
            }
        } finally {
            this.busy = false
        }
    }

    async publish() {
        this.busy = true
        this.callError = ''
        this.published = null
        try {
            const response = await this.adminApi.post('/api/admin/publish', {
                verifyMedia: this.verifyBySha ? 'sha256' : 'stat',
            })
            this.published = response
            this.$emit('published')
        } catch (error) {
            if (error.code === 'gone') return
            if (error.status === 409 && error.details) {
                this.plan = error.details
                this.blockers = this.describe(error.details)
            } else {
                this.callError = error.message
            }
        } finally {
            this.busy = false
            // Always look again. A publish that half-happened leaves the
            // database ahead of the file, and the only way to find out which
            // side won is to ask.
            await this.check()
        }
    }

    /** The plan's three refusal lists, turned into sentences. */
    describe(plan) {
        const lines = []
        for (const groupId of plan.retiredGroups || []) {
            lines.push(this.$t('admin.publish.blockRetired', { id: groupId }))
        }
        for (const hole of plan.blockingHoles || []) {
            lines.push(this.$t('admin.publish.blockHole', {
                kind: hole.subject_kind,
                id: hole.subject_id,
                locale: hole.locale,
            }))
        }
        for (const problem of plan.mediaProblems || []) {
            lines.push(this.$t('admin.publish.blockMedia', {
                path: problem.path,
                problem: problem.problem,
            }))
        }
        return lines
    }
}

export default PublishPanel
</script>
