<template>
    <div class="adm-panel">
        <div class="adm-panel-head">
            <div>
                <h2 class="adm-h">{{ $t("admin.clips.title") }}</h2>
                <p class="adm-sub">{{ $t("admin.clips.subtitle") }}</p>
            </div>
            <button type="button" class="adm-btn" :disabled="busy" @click="reload">
                {{ busy ? $t("admin.common.loading") : $t("admin.common.refresh") }}
            </button>
        </div>

        <p v-if="callError" class="adm-note adm-note-bad">{{ callError }}</p>

        <p v-if="data" class="adm-sub adm-num">
            {{ $t("admin.clips.counts", data.counts) }}
        </p>

        <div class="adm-row" v-if="data">
            <label>
                <span class="adm-label">{{ $t("admin.clips.filterState") }}</span>
                <select class="adm-select" v-model="stateFilter">
                    <option value="">{{ $t("admin.clips.anyState") }}</option>
                    <option v-for="s in STATES" :key="s" :value="s">{{ $t("admin.clips.state." + s) }}</option>
                </select>
            </label>
        </div>

        <p v-if="data && filtered.length === 0" class="adm-empty">{{ $t("admin.clips.empty") }}</p>

        <div class="adm-scroll" v-if="filtered.length > 0">
            <table class="adm-table">
                <thead>
                    <tr>
                        <th scope="col">{{ $t("admin.clips.colLabel") }}</th>
                        <th scope="col">{{ $t("admin.clips.colGroup") }}</th>
                        <th scope="col">{{ $t("admin.clips.colState") }}</th>
                        <th scope="col">{{ $t("admin.clips.colClip") }}</th>
                        <th scope="col">{{ $t("admin.clips.colWhen") }}</th>
                        <th scope="col">{{ $t("admin.clips.colAction") }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="clip in filtered" :key="clip.id" :class="{ 'is-selected': clip.id === playingId }">
                        <td class="adm-wrap">{{ clip.label }}</td>
                        <td class="adm-wrap">
                            {{ clip.group.name }}
                            <span v-if="clip.group.state !== 'active'" class="adm-sub">({{ clip.group.state }})</span>
                        </td>
                        <td>
                            <span class="adm-badge" :class="'adm-badge-' + clip.state">
                                {{ $t("admin.clips.state." + clip.state) }}
                            </span>
                        </td>
                        <td class="adm-num">
                            {{ $t("admin.clips.clipSize", {
                                seconds: seconds(clip.media.durationSeconds),
                                kb: kilobytes(clip.media.bytes),
                                ext: clip.media.ext
                            }) }}
                        </td>
                        <td class="adm-sub adm-num">
                            <div v-if="clip.publishedAt">{{ $t("admin.clips.publishedAt") }} {{ clip.publishedAt }}</div>
                            <div v-if="clip.retiredAt">{{ $t("admin.clips.retiredAt") }} {{ clip.retiredAt }}</div>
                        </td>
                        <td>
                            <button type="button" class="adm-btn" @click="preview(clip)">
                                {{ clip.id === playingId ? $t("admin.clips.playing") : $t("admin.clips.preview") }}
                            </button>
                            <button type="button" class="adm-btn adm-btn-danger" v-if="clip.state === 'published'"
                                    :disabled="acting === clip.id" @click="retire(clip)">
                                {{ $t("admin.clips.retire") }}
                            </button>
                            <button type="button" class="adm-btn adm-btn-primary" v-if="clip.state === 'retired'"
                                    :disabled="acting === clip.id" @click="restore(clip)">
                                {{ $t("admin.clips.restore") }}
                            </button>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>

        <!-- One reused player for the whole library. This is a MANAGEMENT view,
             not the review desk: there is no "heard" gate to honour here, so a
             plain media element is the honest tool. preload=none so opening the
             tab does not fetch every clip. -->
        <audio ref="player" v-show="playingId" controls preload="none" class="adm-clip-player"
               :src="playingSrc" @ended="playingId = null"></audio>
    </div>
</template>

<!--
    The catalogue library: every clip the site has, in any state, so an admin can
    take one down (retire) or put it back (restore) without going through the
    submission queue. It is the one place a PUBLISHED clip can be previewed again
    after it left the review desk.

    There is no delete control, and that is not an omission: the server offers no
    hard delete (clips.media_sha256 and batch_items.clip_id are both ON DELETE
    RESTRICT, and the schema is explicit that a clip which must truly go needs a
    decision about what its approving item then says). Retire is the removal, and
    it is reversible.
-->

<script>
import Vue from 'vue'
import Component from 'vue-class-component'

const STATES = ['draft', 'published', 'retired']

@Component({
    inject: ['adminApi'],
})
class ClipsPanel extends Vue {
    STATES = STATES
    data = null
    busy = false
    callError = ''
    stateFilter = ''
    acting = null          // id of the clip whose retire/restore is in flight
    playingId = null
    playingSrc = ''

    created() {
        this.reload()
    }

    get filtered() {
        if (this.data === null) return []
        if (this.stateFilter === '') return this.data.clips
        return this.data.clips.filter((clip) => clip.state === this.stateFilter)
    }

    async reload() {
        this.busy = true
        this.callError = ''
        try {
            this.data = await this.adminApi.get('/api/admin/clips')
        } catch (error) {
            if (error.code !== 'gone') this.callError = error.message
        } finally {
            this.busy = false
        }
    }

    async retire(clip) {
        // eslint-disable-next-line no-alert
        if (!window.confirm(this.$t('admin.clips.confirmRetire', { label: clip.label }))) return
        await this.act('/api/admin/clips/' + encodeURIComponent(clip.id) + '/retire', clip.id)
    }

    async restore(clip) {
        await this.act('/api/admin/clips/' + encodeURIComponent(clip.id) + '/restore', clip.id)
    }

    async act(path, clipId) {
        this.acting = clipId
        this.callError = ''
        try {
            await this.adminApi.post(path, {})
            await this.reload()
        } catch (error) {
            if (error.code !== 'gone') this.callError = error.message
        } finally {
            this.acting = null
        }
    }

    preview(clip) {
        const src = this.adminApi.siteUrl(clip.media.audioUrl)
        // Same clip clicked again: toggle it off.
        if (this.playingId === clip.id) {
            this.playingId = null
            this.$nextTick(() => { if (this.$refs.player) this.$refs.player.pause() })
            return
        }
        this.playingSrc = src
        this.playingId = clip.id
        this.$nextTick(() => {
            const el = this.$refs.player
            if (!el) return
            // Assigning src does not always restart a element that was mid-play on
            // a different clip; load() makes the new source take from the start.
            el.load()
            const p = el.play()
            if (p && typeof p.catch === 'function') p.catch(() => { /* autoplay refusal is fine; controls are shown */ })
        })
    }

    seconds(value) {
        return typeof value === 'number' ? value.toFixed(1) : '?'
    }

    kilobytes(bytes) {
        return typeof bytes === 'number' ? Math.round(bytes / 1024) : '?'
    }
}

export default ClipsPanel
</script>

<style lang="scss">
/* NOT scoped, on purpose — the whole admin area shares one un-scoped block (see
   AdminDesk.vue); a scoped rule here could not reach the .adm-* elements this
   renders. Colours are literals measured at the same thresholds AdminDesk holds
   itself to, since `npm run contrast` reads App.vue's tokens, not these. */
.adm-badge {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 9px;
    font-size: 12px;
    font-weight: 700;
}
.adm-badge-published { background-color: #e6f4ea; color: #1a6135; }   /* 6.04:1 */
.adm-badge-retired   { background-color: #fdecef; color: #9a1c3a; }   /* 6.58:1 */
.adm-badge-draft     { background-color: #fff4dd; color: #7a5200; }   /* 5.34:1 */
.adm-clip-player { width: 100%; margin-top: 10px; }
</style>
