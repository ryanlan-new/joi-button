<template>
    <div>
        <div class="adm-panel">
            <div class="adm-panel-head">
                <div>
                    <h2 class="adm-h">{{ $t("admin.recycle.title") }}</h2>
                    <p class="adm-sub">{{ $t("admin.recycle.subtitle") }}</p>
                </div>
                <button type="button" class="adm-btn" :disabled="loading" @click="$emit('reload')">
                    {{ loading ? $t("admin.common.loading") : $t("admin.common.refresh") }}
                </button>
            </div>

            <p v-if="error" class="adm-note adm-note-bad">{{ error }}</p>
            <p v-if="recycle" class="adm-sub adm-num">
                {{ $t("admin.recycle.counts", { count: recycle.count, days: recycle.retentionDays }) }}
            </p>
        </div>

        <p v-if="recycle && recycle.count === 0" class="adm-panel adm-empty">
            {{ $t("admin.recycle.empty") }}
        </p>

        <!-- One flat table, not the queue's per-batch panels: these items come from
             many long-resolved batches and are acted on one at a time. The whole
             row opens the desk (the action column can scroll out of a narrow pane),
             and the button stays for the keyboard, stopping the click so the row
             does not fire a second identical select. -->
        <div v-if="recycle && recycle.count > 0" class="adm-panel">
            <div class="adm-scroll">
                <table class="adm-table">
                    <thead>
                        <tr>
                            <th scope="col">{{ $t("admin.recycle.colName") }}</th>
                            <th scope="col">{{ $t("admin.recycle.colClip") }}</th>
                            <th scope="col">{{ $t("admin.recycle.colRejectedAt") }}</th>
                            <th scope="col">{{ $t("admin.recycle.colReason") }}</th>
                            <th scope="col">{{ $t("admin.recycle.colRetention") }}</th>
                            <th scope="col">{{ $t("admin.recycle.colAction") }}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="item in recycle.items" :key="item.itemId"
                            class="adm-row-click"
                            :class="{ 'is-selected': item.itemId === selectedItemId }"
                            @click="$emit('select', item.itemId)">
                            <td class="adm-wrap">{{ item.proposedLabel }}</td>
                            <td class="adm-num">
                                {{ $t("admin.queue.clipSize", {
                                    seconds: seconds(item.media.durationSeconds),
                                    kb: kilobytes(item.media.bytes),
                                    ext: item.media.ext
                                }) }}
                            </td>
                            <td class="adm-num">{{ item.rejectedAt }}</td>
                            <td class="adm-wrap">
                                <span v-if="item.reviewerNote">{{ item.reviewerNote }}</span>
                                <span v-else class="adm-sub">{{ $t("admin.recycle.noReason") }}</span>
                            </td>
                            <td class="adm-num" :class="{ 'adm-warn': item.retentionDaysLeft === 0 }">
                                {{ retentionText(item) }}
                            </td>
                            <td>
                                <button type="button" class="adm-btn" @click.stop="$emit('select', item.itemId)">
                                    {{ item.itemId === selectedItemId ? $t("admin.recycle.open") : $t("admin.recycle.revise") }}
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
    The recycle bin: rejected submissions, newest rejection first.

    Rejecting an item does not delete its audio — the file stays on the volume
    until the media GC (STORY-077) reclaims it, and until then the rejection can
    be overturned here. That is why the retention column matters: it is the window
    in which a mis-judged reject can be revised, and the last warning that the one
    copy of a file the submitter may no longer have is about to go.

    Like the queue, there is no play button in this table. Playback and the
    heard-through gate live at the desk, where one component owns the app-level
    player; a second control here would be a second thing emitting onto that bus.
-->

<script>
import Vue from 'vue'
import Component from 'vue-class-component'

@Component({
    props: {
        recycle: { type: Object, default: null },
        loading: { type: Boolean, default: false },
        error: { type: String, default: '' },
        selectedItemId: { type: String, default: null },
        heardItemIds: { type: Array, default: () => [] },
    },
})
class RecycleQueue extends Vue {
    seconds(value) {
        return value.toFixed(1)
    }

    kilobytes(bytes) {
        return Math.round(bytes / 1024)
    }

    retentionText(item) {
        if (item.retentionDaysLeft === null) return this.$t('admin.recycle.retentionUnknown')
        if (item.retentionDaysLeft === 0) return this.$t('admin.recycle.retentionDue')
        return this.$t('admin.recycle.retentionLeft', { days: item.retentionDaysLeft })
    }
}

export default RecycleQueue
</script>
