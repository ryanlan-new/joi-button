<template>
    <div class="adm-panel">
        <div class="adm-panel-head">
            <div>
                <h2 class="adm-h">{{ $t("admin.audit.title") }}</h2>
                <p class="adm-sub">{{ $t("admin.audit.appendOnly") }}</p>
            </div>
            <button type="button" class="adm-btn" :disabled="busy" @click="reload">
                {{ busy ? $t("admin.common.loading") : $t("admin.common.refresh") }}
            </button>
        </div>

        <div class="adm-row">
            <label>
                <span class="adm-label">{{ $t("admin.audit.filterVerb") }}</span>
                <select class="adm-select" v-model="verb" @change="reload">
                    <option value="">{{ $t("admin.audit.anyVerb") }}</option>
                    <option v-for="known in VERBS" :key="known" :value="known">{{ known }}</option>
                </select>
            </label>
            <label>
                <span class="adm-label">{{ $t("admin.audit.filterSubject") }}</span>
                <input type="text" class="adm-input adm-mono" v-model="subjectId" @change="reload">
            </label>
        </div>

        <p v-if="callError" class="adm-note adm-note-bad">{{ callError }}</p>
        <p v-if="!busy && entries.length === 0" class="adm-empty">{{ $t("admin.audit.empty") }}</p>

        <div class="adm-scroll" v-if="entries.length > 0">
            <table class="adm-table">
                <thead>
                    <tr>
                        <th scope="col">{{ $t("admin.audit.colAt") }}</th>
                        <th scope="col">{{ $t("admin.audit.colActor") }}</th>
                        <th scope="col">{{ $t("admin.audit.colVerb") }}</th>
                        <th scope="col">{{ $t("admin.audit.colSubject") }}</th>
                        <th scope="col">{{ $t("admin.audit.colChange") }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="entry in entries" :key="entry.id">
                        <td class="adm-num">{{ entry.occurredAt }}</td>
                        <td class="adm-wrap">
                            {{ entry.actorDisplayName }}
                            <div class="adm-sub adm-mono">{{ entry.actorKind }}</div>
                        </td>
                        <td>
                            <span class="adm-mono">{{ entry.verb }}</span>
                            <!-- succeeded:false is a refusal the route recorded
                                 on purpose. It is not noise and it is not an
                                 error in this table; it is the entry that says
                                 somebody tried something the server would not do. -->
                            <div v-if="!entry.succeeded" class="adm-bad">{{ $t("admin.audit.refused") }}</div>
                        </td>
                        <td class="adm-wrap adm-mono">
                            {{ entry.subject.kind }}<br>{{ entry.subject.id || '-' }}
                        </td>
                        <td class="adm-wrap">
                            <div v-for="field in fieldsOf(entry)" :key="field.name">
                                <span class="adm-mono">{{ field.name }}</span>:
                                <span class="adm-sub">{{ field.before }}</span> &rarr; {{ field.after }}
                            </div>
                            <div v-if="entry.consequence" class="adm-sub adm-mono">{{ entry.consequence }}</div>
                            <div v-if="entry.correctsId" class="adm-warn">
                                {{ $t("admin.audit.corrects", { id: entry.correctsId }) }}
                                {{ entry.correctionReason }}
                            </div>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>

        <div class="adm-actions" v-if="nextCursor">
            <button type="button" class="adm-btn" :disabled="busy" @click="loadMore">
                {{ $t("admin.audit.older") }}
            </button>
        </div>
    </div>
</template>

<!--
    The log, newest first, and only ever appended to.

    A correction is a NEW entry pointing at the one it corrects (correctsId),
    never an edit — so nothing in this view is editable and there is no control
    here that suggests otherwise. That is the whole reason the table is worth
    reading: an entry says what was true at the moment it was written, including
    the entries that record a refusal.

    Paging is by keyset cursor rather than by offset, because entries are
    appended while somebody is reading and an offset would shift every unread
    page by one each time that happened. The cursor comes from the response and
    goes back untouched; its encoding is the route's business, not this file's.
-->

<script>
import Vue from 'vue'
import Component from 'vue-class-component'

/**
 * The verbs server/routes/admin.mjs writes today. Offered as a filter for
 * convenience only — it is a COPY of a list the server owns, so a verb added
 * there and not here is simply missing from this dropdown, never missing from
 * the table. The filter defaults to "any", which is the answer that cannot go
 * stale.
 */
const VERBS = [
    'admin.item.approve',
    'admin.item.reject',
    'admin.clip.edit',
    'admin.group.create',
    'admin.clip.publish',
    'admin.catalog.write',
    'admin.refused',
]

const PAGE_SIZE = 50

@Component({
    inject: ['adminApi'],
})
class AuditTrail extends Vue {
    VERBS = VERBS
    entries = []
    nextCursor = null
    busy = false
    callError = ''
    verb = ''
    subjectId = ''

    created() {
        this.reload()
    }

    reload() {
        this.entries = []
        this.nextCursor = null
        this.fetchPage(null)
    }

    loadMore() {
        this.fetchPage(this.nextCursor)
    }

    async fetchPage(cursor) {
        this.busy = true
        this.callError = ''
        const query = ['limit=' + PAGE_SIZE]
        if (this.verb !== '') query.push('verb=' + encodeURIComponent(this.verb))
        if (this.subjectId.trim() !== '') query.push('subjectId=' + encodeURIComponent(this.subjectId.trim()))
        if (cursor) query.push('cursor=' + encodeURIComponent(cursor))
        try {
            const response = await this.adminApi.get('/api/admin/audit?' + query.join('&'))
            // Appended, not replaced: "load older" continues the page the reader
            // is already on.
            this.entries = this.entries.concat(response.entries)
            this.nextCursor = response.nextCursor
        } catch (error) {
            if (error.code !== 'gone') this.callError = error.message
        } finally {
            this.busy = false
        }
    }

    /**
     * The diff is { field: { before?, after? } }, and a side is ABSENT rather
     * than null when the field did not exist on it — lib/audit.mjs omits a field
     * whose value did not change at all. Rendering an absent side as "null"
     * would invent a value the entry does not claim, so it renders as a dash.
     */
    fieldsOf(entry) {
        const out = []
        for (const name of Object.keys(entry.diff || {}).sort()) {
            const change = entry.diff[name]
            out.push({
                name,
                before: Object.prototype.hasOwnProperty.call(change, 'before') ? this.show(change.before) : '-',
                after: Object.prototype.hasOwnProperty.call(change, 'after') ? this.show(change.after) : '-',
            })
        }
        return out
    }

    show(value) {
        if (value === null) return 'null'
        if (typeof value === 'object') return JSON.stringify(value)
        return String(value)
    }
}

export default AuditTrail
</script>
