<template>
    <div class="adm-panel">
        <div class="adm-panel-head">
            <div>
                <h2 class="adm-h">{{ $t('admin.clips.title') }}</h2>
                <p class="adm-sub">{{ $t('admin.clips.subtitle') }}</p>
            </div>
            <button type="button" class="adm-btn" :disabled="busy" @click="reload">
                {{ busy ? $t('admin.common.loading') : $t('admin.common.refresh') }}
            </button>
        </div>

        <p v-if="callError" class="adm-note adm-note-bad">{{ callError }}</p>
        <p v-if="notice" class="adm-note adm-note-ok" role="status">{{ notice }}</p>
        <p v-if="data" class="adm-sub adm-num">{{ $t('admin.clips.counts', data.counts) }}</p>

        <div v-if="data" class="adm-row adm-clip-filters">
            <label><span class="adm-label">{{ $t('admin.clips.filterState') }}</span>
                <select class="adm-select" v-model="stateFilter">
                    <option value="">{{ $t('admin.clips.anyState') }}</option>
                    <option v-for="s in STATES" :key="s" :value="s">{{ $t('admin.clips.state.' + s) }}</option>
                </select>
            </label>
            <label><span class="adm-label">{{ $t('admin.clips.filterCaptions') }}</span>
                <select class="adm-select" v-model="captionFilter">
                    <option value="">{{ $t('admin.clips.anyCaptionState') }}</option>
                    <option value="complete">{{ $t('admin.clips.complete') }}</option>
                    <option value="incomplete">{{ $t('admin.clips.incomplete') }}</option>
                    <option value="zero">{{ $t('admin.clips.zeroCaptions') }}</option>
                </select>
            </label>
            <label><span class="adm-label">{{ $t('admin.clips.filterSource') }}</span>
                <select class="adm-select" v-model="sourceFilter">
                    <option value="">{{ $t('admin.clips.anySource') }}</option>
                    <option value="video">{{ $t('info.clipType.video') }}</option>
                    <option value="stream">{{ $t('info.clipType.stream') }}</option>
                    <option value="missing">{{ $t('admin.clips.sourceMissing') }}</option>
                </select>
            </label>
            <label><span class="adm-label">{{ $t('admin.clips.filterSubmitter') }}</span>
                <select class="adm-select" v-model="submitterFilter">
                    <option value="">{{ $t('admin.clips.anySubmitter') }}</option>
                    <option value="present">{{ $t('admin.clips.submitterPresent') }}</option>
                    <option value="missing">{{ $t('admin.clips.submitterMissing') }}</option>
                </select>
            </label>
        </div>

        <div v-if="data && selectedIds.length" class="adm-bulk-bar">
            <span>{{ $t('admin.clips.selected', { n: selectedIds.length }) }}</span>
            <select class="adm-select" v-model="bulkGroupId">
                <option value="">{{ $t('admin.clips.movePick') }}</option>
                <option v-for="group in activeGroups" :key="group.id" :value="group.id">{{ group.displayName }}</option>
            </select>
            <button type="button" class="adm-btn adm-btn-primary" :disabled="!bulkGroupId || acting === 'bulk'" @click="moveSelected">
                {{ $t('admin.clips.move') }}
            </button>
            <button type="button" class="adm-btn-link" @click="clearSelection">{{ $t('admin.clips.clearSelection') }}</button>
        </div>

        <p v-if="data && filtered.length === 0" class="adm-empty">{{ $t('admin.clips.empty') }}</p>

        <div class="adm-scroll" v-if="filtered.length > 0">
            <table class="adm-table adm-clip-table">
                <thead>
                    <tr>
                        <th scope="col"><input type="checkbox" :checked="allVisibleSelected" :aria-label="$t('admin.clips.selectAll')" @change="toggleAll"></th>
                        <th scope="col">{{ $t('admin.clips.colLabel') }}</th>
                        <th scope="col">{{ $t('admin.clips.colGroup') }}</th>
                        <th scope="col">{{ $t('admin.clips.colState') }}</th>
                        <th scope="col">{{ $t('admin.clips.colCaptions') }}</th>
                        <th scope="col">{{ $t('admin.clips.colSource') }}</th>
                        <th scope="col">{{ $t('admin.clips.colSourceTime') }}</th>
                        <th scope="col">{{ $t('admin.clips.colSubmitter') }}</th>
                        <th scope="col">{{ $t('admin.clips.colClip') }}</th>
                        <th scope="col">{{ $t('admin.clips.colAction') }}</th>
                    </tr>
                </thead>
                <tbody>
                    <template v-for="clip in filtered">
                        <tr :key="clip.id" :class="{ 'is-selected': clip.id === playingId }">
                            <td><input type="checkbox" :checked="selectedIds.indexOf(clip.id) !== -1" :aria-label="clip.label" @change="toggleSelected(clip)"></td>
                            <td class="adm-wrap">{{ clip.label }}</td>
                            <td class="adm-wrap">{{ clip.group.name }} <span v-if="clip.group.state !== 'active'" class="adm-sub">({{ clip.group.state }})</span></td>
                            <td><span class="adm-badge" :class="'adm-badge-' + clip.state">{{ $t('admin.clips.state.' + clip.state) }}</span></td>
                            <td>
                                <span class="caption-dots" :class="{ 'caption-dots-empty': clip.captionCount === 0, 'caption-dots-partial': clip.captionCount > 0 && clip.captionCount < clip.captionTotal }" :aria-label="clip.captionCount + '/' + clip.captionTotal">
                                    <span v-for="locale in CAPTION_LOCALES" :key="locale" class="caption-dot" :class="{ 'is-filled': !!clip.captions[locale] }" :title="locale">{{ locale.slice(0, 2) }}</span>
                                </span>
                            </td>
                            <td class="adm-wrap">
                                <span v-if="clip.source" class="source-kind-dot" :class="'source-kind-' + clip.source.kind" aria-hidden="true"></span>
                                {{ sourceText(clip) }}
                            </td>
                            <td class="adm-num">{{ sourceTimeText(clip) }}</td>
                            <td class="adm-wrap">{{ clip.submitter ? clip.submitter.name : '' }}</td>
                            <td class="adm-num">{{ $t('admin.clips.clipSize', { seconds: seconds(clip.media.durationSeconds), kb: kilobytes(clip.media.bytes), ext: clip.media.ext }) }}</td>
                            <td>
                                <button type="button" class="adm-btn" @click="preview(clip)">{{ clip.id === playingId ? $t('admin.clips.playing') : $t('admin.clips.preview') }}</button>
                                <button type="button" class="adm-btn" @click="beginEdit(clip)">{{ $t('admin.clips.edit') }}</button>
                                <button type="button" class="adm-btn adm-btn-danger" v-if="clip.state === 'published'" :disabled="acting === clip.id" @click="retire(clip)">{{ $t('admin.clips.retire') }}</button>
                                <button type="button" class="adm-btn adm-btn-primary" v-if="clip.state === 'retired'" :disabled="acting === clip.id" @click="restore(clip)">{{ $t('admin.clips.restore') }}</button>
                            </td>
                        </tr>
                        <tr v-if="editingId === clip.id" :key="clip.id + '-edit'" class="adm-clip-edit-row">
                            <td colspan="10">
                                <fieldset class="adm-fieldset">
                                    <legend class="adm-legend">{{ $t('admin.clips.edit') }}</legend>
                                    <div class="adm-row">
                                        <label><span class="adm-label">{{ $t('admin.clips.colLabel') }}</span><input class="adm-input" v-model.trim="draft.label"></label>
                                        <label><span class="adm-label">{{ $t('admin.clips.colGroup') }}</span><select class="adm-select" v-model="draft.groupId"><option v-for="group in activeGroups" :key="group.id" :value="group.id">{{ group.displayName }}</option></select></label>
                                    </div>
                                    <div class="adm-row">
                                        <label><span class="adm-label">{{ $t('admin.clips.sourceKind') }}</span><select class="adm-select" v-model="draft.sourceKind"><option value="">—</option><option value="video">{{ $t('info.clipType.video') }}</option><option value="stream">{{ $t('info.clipType.stream') }}</option></select></label>
                                        <label><span class="adm-label">{{ $t('admin.clips.sourceTitle') }}</span><input class="adm-input" v-model.trim="draft.sourceTitle"></label>
                                        <label><span class="adm-label">{{ $t('admin.clips.sourceDate') }}</span><input class="adm-input" type="date" v-model="draft.sourceDate"></label>
                                        <label><span class="adm-label">{{ $t('admin.clips.sourceTime') }}</span><input class="adm-input" v-model.trim="draft.sourceTime" placeholder="mm:ss"></label>
                                        <label><span class="adm-label">{{ $t('admin.clips.sourceUrl') }}</span><input class="adm-input" type="url" v-model.trim="draft.sourceUrl"></label>
                                        <label class="adm-choice"><input type="checkbox" v-model="draft.creditHidden"> {{ $t('admin.clips.hideCredit') }}</label>
                                    </div>
                                    <div class="adm-langs">
                                        <I18nTextField v-for="locale in CAPTION_LOCALES" :key="locale"
                                                       :field-id="'adm-library-caption-' + locale"
                                                       :label="locale"
                                                       :value="draft.captions[locale]"
                                                       :max-length="200"
                                                       @input="$set(draft.captions, locale, $event)" />
                                    </div>
                                    <div class="adm-actions">
                                        <button type="button" class="adm-btn adm-btn-primary" :disabled="acting === clip.id" @click="saveEdit(clip)">{{ $t('admin.desk.saveChanges') }}</button>
                                        <button type="button" class="adm-btn" @click="cancelEdit">{{ $t('admin.admins.cancel') }}</button>
                                    </div>
                                </fieldset>
                            </td>
                        </tr>
                    </template>
                </tbody>
            </table>
        </div>

        <audio ref="player" v-show="playingId" controls preload="none" class="adm-clip-player" :src="playingSrc" @ended="playingId = null"></audio>
    </div>
</template>

<script>
import Vue from 'vue'
import Component from 'vue-class-component'
import I18nTextField from './I18nTextField.vue'

const STATES = ['draft', 'published', 'retired']
const CAPTION_LOCALES = ['en-US', 'zh-CN', 'ja-JP']

function secondsToTime(seconds) {
    if (!Number.isInteger(seconds) || seconds < 0) return ''
    const minutes = Math.floor(seconds / 60)
    const rest = seconds % 60
    return minutes + ':' + (rest < 10 ? '0' : '') + rest
}

function parseTime(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null
    const text = String(value).trim()
    if (/^\d+$/.test(text)) return Number(text)
    const parts = text.split(':').map(Number)
    if (parts.some((part) => !Number.isInteger(part) || part < 0) || (parts.length !== 2 && parts.length !== 3)) return null
    if (parts.length === 2 && parts[1] < 60) return parts[0] * 60 + parts[1]
    if (parts.length === 3 && parts[1] < 60 && parts[2] < 60) return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return null
}

@Component({ inject: ['adminApi'], components: { I18nTextField } })
class ClipsPanel extends Vue {
    STATES = STATES
    CAPTION_LOCALES = CAPTION_LOCALES
    data = null
    busy = false
    callError = ''
    notice = ''
    stateFilter = ''
    captionFilter = ''
    sourceFilter = ''
    submitterFilter = ''
    selectedIds = []
    bulkGroupId = ''
    editingId = null
    draft = null
    acting = null
    playingId = null
    playingSrc = ''

    created() { this.reload() }

    get activeGroups() { return this.data ? this.data.groups.filter((group) => group.state === 'active') : [] }
    get filtered() {
        if (!this.data) return []
        return this.data.clips.filter((clip) => {
            if (this.stateFilter && clip.state !== this.stateFilter) return false
            if (this.captionFilter === 'complete' && clip.captionCount < clip.captionTotal) return false
            if (this.captionFilter === 'incomplete' && clip.captionCount >= clip.captionTotal) return false
            if (this.captionFilter === 'zero' && clip.captionCount !== 0) return false
            if ((this.sourceFilter === 'video' || this.sourceFilter === 'stream') && (!clip.source || clip.source.kind !== this.sourceFilter)) return false
            if (this.sourceFilter === 'missing' && clip.source) return false
            if (this.submitterFilter === 'present' && !clip.submitter) return false
            if (this.submitterFilter === 'missing' && clip.submitter) return false
            return true
        })
    }
    get allVisibleSelected() { return this.filtered.length > 0 && this.filtered.every((clip) => this.selectedIds.indexOf(clip.id) !== -1) }

    async reload() {
        this.busy = true; this.callError = ''
        try { this.data = await this.adminApi.get('/api/admin/clips') } catch (error) { if (error.code !== 'gone') this.callError = error.message }
        finally { this.busy = false }
    }
    toggleSelected(clip) {
        const index = this.selectedIds.indexOf(clip.id)
        if (index === -1) this.selectedIds.push(clip.id)
        else this.selectedIds.splice(index, 1)
    }
    toggleAll() {
        if (this.allVisibleSelected) this.selectedIds = this.selectedIds.filter((id) => !this.filtered.some((clip) => clip.id === id))
        else this.selectedIds = Array.from(new Set(this.selectedIds.concat(this.filtered.map((clip) => clip.id))))
    }
    clearSelection() { this.selectedIds = []; this.bulkGroupId = '' }
    async moveSelected() {
        const count = this.selectedIds.length
        const target = this.activeGroups.find((group) => group.id === this.bulkGroupId)
        this.acting = 'bulk'; this.callError = ''
        try {
            await this.adminApi.post('/api/admin/clips/move', { clipIds: this.selectedIds, groupId: this.bulkGroupId })
            this.clearSelection(); await this.reload()
            this.notice = this.$t('admin.clips.moved', { n: count, group: target ? target.displayName : this.bulkGroupId })
        }
        catch (error) { if (error.code !== 'gone') this.callError = error.message }
        finally { this.acting = null }
    }
    beginEdit(clip) {
        this.editingId = clip.id
        this.draft = {
            label: clip.label,
            groupId: clip.group.id,
            sourceKind: clip.source ? clip.source.kind || '' : '',
            sourceTitle: clip.source ? clip.source.title || '' : '',
            sourceDate: clip.source ? clip.source.date || '' : '',
            sourceTime: clip.source ? secondsToTime(clip.source.seconds) : '',
            sourceUrl: clip.source ? clip.source.url || '' : '',
            creditHidden: clip.creditHidden === true,
            captions: Object.assign({}, clip.captions || {}, { 'en-US': (clip.captions && clip.captions['en-US']) || '', 'zh-CN': (clip.captions && clip.captions['zh-CN']) || '', 'ja-JP': (clip.captions && clip.captions['ja-JP']) || '' }),
        }
    }
    cancelEdit() { this.editingId = null; this.draft = null }
    async saveEdit(clip) {
        const seconds = parseTime(this.draft.sourceTime)
        if (this.draft.sourceTime && seconds === null) { this.callError = this.$t('admin.clips.sourceTimeBad'); return }
        this.acting = clip.id; this.callError = ''
        try {
            await this.adminApi.patch('/api/admin/clips/' + encodeURIComponent(clip.id), {
                label: this.draft.label,
                groupId: this.draft.groupId,
                captions: Object.fromEntries(CAPTION_LOCALES.map((locale) => [locale, this.draft.captions[locale] || null])),
                sourceKind: this.draft.sourceKind || null,
                sourceTitle: this.draft.sourceTitle || null,
                sourceDate: this.draft.sourceDate || null,
                sourceSeconds: seconds,
                sourceUrl: this.draft.sourceUrl || null,
                creditHidden: this.draft.creditHidden,
            })
            this.cancelEdit(); await this.reload()
            this.notice = this.$t('admin.clips.saved')
        } catch (error) { if (error.code !== 'gone') this.callError = error.message }
        finally { this.acting = null }
    }
    async retire(clip) {
        if (!window.confirm(this.$t('admin.clips.confirmRetire', { label: clip.label }))) return
        await this.act('/api/admin/clips/' + encodeURIComponent(clip.id) + '/retire', clip.id)
    }
    async restore(clip) { await this.act('/api/admin/clips/' + encodeURIComponent(clip.id) + '/restore', clip.id) }
    async act(path, clipId) {
        this.acting = clipId; this.callError = ''
        try { await this.adminApi.post(path, {}); await this.reload() }
        catch (error) { if (error.code !== 'gone') this.callError = error.message }
        finally { this.acting = null }
    }
    sourceText(clip) {
        if (!clip.source) return this.$t('admin.clips.noSource')
        return [clip.source.title, clip.source.date, clip.source.url].filter(Boolean).join(' · ') || clip.source.kind || this.$t('admin.clips.sourcePresent')
    }
    sourceTimeText(clip) {
        return clip.source && clip.source.seconds !== undefined ? secondsToTime(clip.source.seconds) : ''
    }
    preview(clip) {
        const src = this.adminApi.siteUrl(clip.media.audioUrl)
        if (this.playingId === clip.id) { this.playingId = null; this.$nextTick(() => { if (this.$refs.player) this.$refs.player.pause() }); return }
        this.playingSrc = src; this.playingId = clip.id
        this.$nextTick(() => { const el = this.$refs.player; if (!el) return; el.load(); const promise = el.play(); if (promise && promise.catch) promise.catch(() => {}) })
    }
    seconds(value) { return typeof value === 'number' ? value.toFixed(1) : '?' }
    kilobytes(bytes) { return typeof bytes === 'number' ? Math.round(bytes / 1024) : '?' }
}

export default ClipsPanel
</script>

<style lang="scss">
.adm-badge { display: inline-block; padding: 1px 8px; border-radius: 9px; font-size: 12px; font-weight: 700; }
.adm-badge-published { background-color: #e6f4ea; color: #1a6135; }
.adm-badge-retired { background-color: #fdecef; color: #9a1c3a; }
.adm-badge-draft { background-color: #fff4dd; color: #7a5200; }
.adm-clip-player { width: 100%; margin-top: 10px; }
.adm-clip-filters { align-items: end; flex-wrap: wrap; }
.adm-clip-filters label, .adm-clip-edit-row label { display: inline-flex; flex-direction: column; gap: .25rem; min-width: 10rem; }
.adm-bulk-bar { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; padding: .75rem; margin-bottom: .75rem; background: var(--adm-inset); border: 1px solid var(--adm-line); }
.adm-clip-table { min-width: 1050px; }
.adm-clip-edit-row > td { background: var(--adm-inset); }
.adm-clip-edit-row .adm-row { flex-wrap: wrap; gap: .75rem; }
.adm-clip-edit-row .adm-langs { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: .75rem; }
.caption-dots { display: inline-flex; gap: .2rem; }
.caption-dot { display: inline-flex; align-items: center; justify-content: center; min-width: 1.55rem; height: 1.35rem; border: 1px solid var(--adm-line); border-radius: .25rem; font-size: .65rem; color: var(--adm-line); }
.caption-dot.is-filled { background: var(--adm-accent); border-color: var(--adm-accent); color: #fff; }
.caption-dots-empty { outline: 2px solid var(--adm-danger); outline-offset: 2px; }
.caption-dots-partial { border-bottom: 2px dashed var(--adm-accent); padding-bottom: 2px; }
.source-kind-dot { display: inline-block; width: .65rem; height: .65rem; margin-right: .3rem; border: 2px solid currentColor; border-radius: 50%; vertical-align: .05em; }
.source-kind-stream { border-radius: .15rem; }
.adm-clip-edit-row > td { animation: adm-clip-edit-in .18s cubic-bezier(.2, 1.25, .45, 1) both; }
@keyframes adm-clip-edit-in {
    from { opacity: 0; transform: translateY(-.35rem) scaleY(.96); transform-origin: top; }
    to { opacity: 1; transform: translateY(0) scaleY(1); }
}
</style>
