<template>
    <div>
        <div class="adm-panel">
            <div class="adm-panel-head">
                <div>
                    <h2 class="adm-h">{{ $t("admin.queue.title") }}</h2>
                    <p class="adm-sub">{{ $t("admin.queue.order") }}</p>
                </div>
                <button type="button" class="adm-btn" :disabled="loading" @click="$emit('reload')">
                    {{ loading ? $t("admin.common.loading") : $t("admin.common.refresh") }}
                </button>
            </div>

            <p v-if="error" class="adm-note adm-note-bad">{{ error }}</p>

            <p v-if="queue" class="adm-sub adm-num">
                {{ $t("admin.queue.counts", { batches: queue.batchCount, items: queue.itemCount }) }}
            </p>
            <p v-if="queue && queue.truncated" class="adm-note adm-note-warn">
                {{ $t("admin.queue.truncated", { limit: queue.limit }) }}
            </p>
        </div>

        <p v-if="queue && queue.batchCount === 0" class="adm-panel adm-empty">
            {{ $t("admin.queue.empty") }}
        </p>

        <!-- One panel per BATCH, and each batch is a table. Ten items are ten
             rows the owner can read at a glance and compare against each other;
             ten dialogs are ten context switches for one submission. -->
        <div v-for="batch in batches" :key="batch.batchId" class="adm-panel">
            <div class="adm-panel-head">
                <div>
                    <!-- Submitter-authored: a display name is a VALUE the room
                         reported, never an i18n key. Interpolated, never $t. -->
                    <h3 class="adm-h">{{ batch.submitter.displayName }}</h3>
                    <p class="adm-sub adm-num">
                        {{ $t("admin.queue.history", {
                            approved: batch.submitter.counts.approvedCount,
                            rejected: batch.submitter.counts.rejectedCount,
                            submitted: batch.submitter.counts.submittedCount
                        }) }}
                    </p>
                    <p class="adm-sub adm-mono">{{ batch.submitter.openId }}</p>
                </div>
                <div class="adm-sub">
                    <div>{{ $t("admin.queue.submittedAt") }} <span class="adm-num">{{ batch.submittedAt }}</span></div>
                    <div>{{ turnstileText(batch) }}</div>
                </div>
            </div>

            <p v-if="batch.submitter.blocked" class="adm-note adm-note-warn">
                {{ $t("admin.queue.blocked") }}
            </p>
            <!-- The route reports the drift rather than repairing it, because a
                 silent repair hides whatever caused it. Repeating that here
                 costs one line and keeps the owner from reading a stale counter
                 as a fact about this person. -->
            <p v-if="batch.submitter.countsDrifted" class="adm-note adm-note-warn adm-num">
                {{ $t("admin.queue.drift", {
                    approved: batch.submitter.countsExpected.approvedCount,
                    rejected: batch.submitter.countsExpected.rejectedCount,
                    submitted: batch.submitter.countsExpected.submittedCount
                }) }}
            </p>

            <div class="adm-scroll">
                <table class="adm-table">
                    <thead>
                        <tr>
                            <th scope="col">{{ $t("admin.queue.colPosition") }}</th>
                            <th scope="col">{{ $t("admin.queue.colName") }}</th>
                            <th scope="col">{{ $t("admin.queue.colGroup") }}</th>
                            <th scope="col">{{ $t("admin.queue.colClip") }}</th>
                            <th scope="col">{{ $t("admin.queue.colNote") }}</th>
                            <th scope="col">{{ $t("admin.queue.colAction") }}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="item in batch.items" :key="item.itemId"
                            :class="{ 'is-selected': item.itemId === selectedItemId }">
                            <td class="adm-num">{{ item.position }}</td>
                            <td class="adm-wrap">{{ item.proposedLabel }}</td>
                            <!-- TWO WAYS a submitter can name a group, and this
                                 column has to show both. proposedGroupId is set
                                 when they picked one that EXISTS; a group they
                                 are proposing has no id yet, so it travels in the
                                 note as `proposedGroup` and this cell used to say
                                 "not specified" while the name sat two columns
                                 over, inside a JSON blob. -->
                            <td class="adm-wrap">
                                <span v-if="item.proposedGroupId" class="adm-mono">{{ item.proposedGroupId }}</span>
                                <span v-else-if="item.submitterNote && item.submitterNote.proposedGroup">
                                    {{ $t("admin.queue.proposedGroup", { name: item.submitterNote.proposedGroup }) }}
                                </span>
                                <span v-else class="adm-sub">{{ $t("admin.queue.noGroup") }}</span>
                            </td>
                            <td class="adm-num">
                                {{ $t("admin.queue.clipSize", {
                                    seconds: seconds(item.media.durationSeconds),
                                    kb: kilobytes(item.media.bytes),
                                    ext: item.media.ext
                                }) }}
                            </td>
                            <!-- `.note`, not the whole object. submitterNote is a
                                 PARSED { caption, note, proposedGroup }; rendering
                                 the object itself printed
                                 `{"caption":{"locale":"zh-CN",…}}` at the reviewer,
                                 which is what this cell did before the API stopped
                                 shipping the raw column. The caption is shown in
                                 the review pane, where it can be edited; the
                                 proposed group is in its own column above. What is
                                 left for this cell is the free text they wrote TO
                                 the reviewer. -->
                            <td class="adm-wrap">
                                <span v-if="item.submitterNote && item.submitterNote.note">{{ item.submitterNote.note }}</span>
                                <span v-else class="adm-sub">{{ $t("admin.queue.noNote") }}</span>
                            </td>
                            <td>
                                <button type="button" class="adm-btn" @click="$emit('select', item.itemId)">
                                    {{ item.itemId === selectedItemId ? $t("admin.queue.open") : $t("admin.queue.review") }}
                                </button>
                                <span v-if="heardItemIds.indexOf(item.itemId) !== -1" class="adm-sub">
                                    {{ $t("admin.queue.heard") }}
                                </span>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>
</template>

<!--
    The queue, in the order things arrived and in no other.

    server/routes/admin.mjs orders by (submitted_at, batch id, position) and
    explains why at length: ranking by the submitter's approved_count, by
    duration, by file size — by anything that reads as quality — re-creates the
    gate this desk exists to be. This component adds no sort control and no
    default ordering of its own for the same reason. The history counts are
    shown because they are context for a decision; they are not a rank, and
    there is nothing here to sort by them.

    There is no play button in this table. Playback happens at the desk, where
    one component owns the conversation with the app-level player and can say
    honestly whether a clip was heard to its end. A second play control here
    would be a second thing emitting onto the same bus, and the "heard through"
    gate would have to guess which clip an `ended` belonged to.
-->

<script>
import Vue from 'vue'
import Component from 'vue-class-component'

@Component({
    props: {
        queue: { type: Object, default: null },
        loading: { type: Boolean, default: false },
        error: { type: String, default: '' },
        selectedItemId: { type: String, default: null },
        heardItemIds: { type: Array, default: () => [] },
    },
})
class ReviewQueue extends Vue {
    get batches() {
        return this.queue === null ? [] : this.queue.batches
    }

    seconds(value) {
        // media.duration_seconds is a REAL and CHECKed > 0, so there is no
        // "unknown" branch to write here.
        return value.toFixed(1)
    }

    kilobytes(bytes) {
        return Math.round(bytes / 1024)
    }

    turnstileText(batch) {
        if (!batch.turnstile.required) return this.$t('admin.queue.turnstileNotRequired')
        return this.$t('admin.queue.turnstileRequired', {
            verdict: batch.turnstile.verdict === null ? '-' : batch.turnstile.verdict,
        })
    }
}

export default ReviewQueue
</script>
