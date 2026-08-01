<template>
    <div class="adm-panel">
        <div class="adm-panel-head">
            <div>
                <h2 class="adm-h">{{ $t("admin.reclaim.title") }}</h2>
                <p class="adm-sub">{{ $t("admin.reclaim.subtitle") }}</p>
            </div>
            <button type="button" class="adm-btn" :disabled="busy" @click="reload">
                {{ busy ? $t("admin.common.loading") : $t("admin.common.refresh") }}
            </button>
        </div>

        <p v-if="callError" class="adm-note adm-note-bad">{{ callError }}</p>
        <p v-if="result" class="adm-note adm-note-ok">{{ resultText }}</p>
        <p v-if="result && result.failures && result.failures.length" class="adm-note adm-note-warn">
            {{ $t("admin.reclaim.resultFailures", { n: result.failures.length }) }}
        </p>

        <template v-if="preview">
            <p class="adm-note" :class="preview.count === 0 ? 'adm-note-ok' : 'adm-note-warn'">
                {{ preview.count === 0
                    ? $t("admin.reclaim.empty")
                    : $t("admin.reclaim.summary", { count: preview.count, size: humanBytes(preview.totalBytes) }) }}
            </p>
            <p class="adm-hint">{{ $t("admin.reclaim.retentionNote", { days: preview.retentionDays }) }}</p>

            <div v-if="preview.count > 0" class="adm-scroll">
                <table class="adm-table">
                    <thead>
                        <tr>
                            <th scope="col">{{ $t("admin.reclaim.colSha") }}</th>
                            <th scope="col">{{ $t("admin.reclaim.colSize") }}</th>
                            <th scope="col">{{ $t("admin.reclaim.colLastActivity") }}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="item in preview.items" :key="item.sha256">
                            <td class="adm-mono">{{ item.sha256.slice(0, 12) }}…</td>
                            <td class="adm-num">{{ humanBytes(item.bytes) }}</td>
                            <td class="adm-num">{{ item.lastActivity }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <div v-if="preview.count > 0" class="adm-actions">
                <button type="button" class="adm-btn adm-btn-danger" :disabled="collecting || busy" @click="collect">
                    {{ collecting ? $t("admin.common.loading") : $t("admin.reclaim.collect") }}
                </button>
            </div>
        </template>
    </div>
</template>

<!--
    Reclaiming the audio of rejected and abandoned submissions (STORY-077).

    The list is a DRY RUN: it names exactly the blobs the button would remove, so
    the decision is made against what will happen, not a summary of it. Removal is
    manual and irreversible — the file may be the only copy of something a
    submitter can no longer re-send — so the button confirms, and the panel says
    plainly that a published or retired clip's audio is never in this list.
-->

<script>
import Vue from 'vue'
import Component from 'vue-class-component'

@Component({
    inject: ['adminApi'],
})
class ReclaimPanel extends Vue {
    preview = null
    busy = false
    collecting = false
    callError = ''
    result = null

    created() {
        this.reload()
    }

    get resultText() {
        if (!this.result) return ''
        return this.$t('admin.reclaim.resultDone', {
            count: this.result.count,
            size: this.humanBytes(this.result.freedBytes),
        })
    }

    humanBytes(bytes) {
        const n = typeof bytes === 'number' ? bytes : 0
        if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB'
        if (n >= 1024) return Math.round(n / 1024) + ' KB'
        return n + ' B'
    }

    async reload() {
        this.busy = true
        this.callError = ''
        try {
            this.preview = await this.adminApi.get('/api/admin/reclaimable')
        } catch (error) {
            if (error.code !== 'gone') this.callError = error.message
        } finally {
            this.busy = false
        }
    }

    async collect() {
        if (!this.preview || this.preview.count === 0) return
        const confirmText = this.$t('admin.reclaim.confirm', {
            count: this.preview.count,
            size: this.humanBytes(this.preview.totalBytes),
        })
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(confirmText)) {
            return
        }
        this.collecting = true
        this.callError = ''
        this.result = null
        try {
            this.result = await this.adminApi.post('/api/admin/reclaim')
            // Re-read: the collected blobs are gone from the list now, and a fresh
            // preview is the honest state to act on next.
            await this.reload()
        } catch (error) {
            if (error.code !== 'gone') this.callError = error.message
        } finally {
            this.collecting = false
        }
    }
}

export default ReclaimPanel
</script>
