<template>
    <div class="adm-panel">
        <div class="adm-panel-head">
            <div>
                <h2 class="adm-h">{{ $t("admin.branding.title") }}</h2>
                <p class="adm-sub">{{ $t("admin.branding.subtitle") }}</p>
            </div>
            <button type="button" class="adm-btn" :disabled="busy" @click="reload">
                {{ busy ? $t("admin.common.loading") : $t("admin.common.refresh") }}
            </button>
        </div>

        <p v-if="callError" class="adm-note adm-note-bad">{{ callError }}</p>
        <p v-if="saved" class="adm-note adm-note-ok">{{ $t("admin.branding.saved") }}</p>

        <template v-if="form">
            <fieldset class="adm-fieldset">
                <legend class="adm-legend">{{ $t("admin.branding.navTitle") }}</legend>
                <p class="adm-hint">{{ $t("admin.branding.navTitleHint") }}</p>
                <div class="adm-langs">
                    <label v-for="l in LOCALES" :key="'nav-' + l">
                        <span class="adm-label">{{ langLabel(l) }}</span>
                        <input type="text" class="adm-input" maxlength="80"
                               v-model="form.navTitle[l]" :placeholder="$t('info.title')">
                    </label>
                </div>
            </fieldset>

            <fieldset class="adm-fieldset">
                <legend class="adm-legend">{{ $t("admin.branding.docTitle") }}</legend>
                <p class="adm-hint">{{ $t("admin.branding.docTitleHint") }}</p>
                <div class="adm-langs">
                    <label v-for="l in LOCALES" :key="'doc-' + l">
                        <span class="adm-label">{{ langLabel(l) }}</span>
                        <input type="text" class="adm-input" maxlength="80" v-model="form.docTitle[l]">
                    </label>
                </div>
            </fieldset>

            <fieldset class="adm-fieldset">
                <legend class="adm-legend">{{ $t("admin.branding.channel") }}</legend>
                <p class="adm-hint">{{ $t("admin.branding.channelHint") }}</p>
                <div class="adm-langs">
                    <label v-for="l in LOCALES" :key="'ch-' + l">
                        <span class="adm-label">{{ langLabel(l) }}</span>
                        <input type="text" class="adm-input" maxlength="80"
                               v-model="form.channel.label[l]" :placeholder="$t('info.yt_channel')">
                    </label>
                </div>
                <label>
                    <span class="adm-label">{{ $t("admin.branding.channelHref") }}</span>
                    <input type="url" class="adm-input adm-mono" v-model="form.channel.href"
                           placeholder="https://space.bilibili.com/…">
                </label>
            </fieldset>

            <fieldset class="adm-fieldset">
                <legend class="adm-legend">{{ $t("admin.branding.favicon") }}</legend>
                <p class="adm-hint">{{ $t("admin.branding.faviconHint") }}</p>
                <div class="adm-row">
                    <img v-if="form.faviconPath" :src="'/branding/' + form.faviconPath" alt="" width="32" height="32"
                         style="border:1px solid var(--adm-line);border-radius:4px;background:#fff">
                    <span v-else class="adm-sub">{{ $t("admin.branding.faviconNone") }}</span>
                    <input ref="favicon" type="file" accept="image/png,image/x-icon,.ico,.png" @change="onFaviconPicked">
                    <span v-if="uploading" class="adm-sub">{{ $t("admin.common.loading") }}</span>
                </div>
            </fieldset>

            <div class="adm-actions">
                <button type="button" class="adm-btn adm-btn-primary" :disabled="saving" @click="save">
                    {{ saving ? $t("admin.common.loading") : $t("admin.branding.save") }}
                </button>
            </div>
        </template>
    </div>
</template>

<!--
    Editing the site's own identity: the navbar title (and the little mark before
    it, which is the favicon), the browser-tab <title>, the channel link, and the
    favicon. The API writes one branding.json to the shared volume, the web pod
    serves it, and App.vue applies it on load — so a change is live on the next
    navigation without a rebuild, the same delivery the theme uses.

    Every text field is per-language and empty means "use the bundle's default",
    so clearing a box restores the shipped string rather than blanking the site.
    The channel href is http/https only, enforced by the server before it writes.
-->

<script>
import Vue from 'vue'
import Component from 'vue-class-component'

const LOCALES = ['zh-CN', 'en-US', 'ja-JP']
const LANG_LABEL = { 'zh-CN': '中文', 'en-US': 'English', 'ja-JP': '日本語' }

@Component({
    inject: ['adminApi'],
})
class BrandingPanel extends Vue {
    LOCALES = LOCALES
    form = null
    busy = false
    saving = false
    uploading = false
    callError = ''
    saved = false

    created() {
        this.reload()
    }

    langLabel(l) {
        return LANG_LABEL[l] || l
    }

    async reload() {
        this.busy = true
        this.callError = ''
        this.saved = false
        try {
            const response = await this.adminApi.get('/api/admin/branding')
            this.form = this.normalise(response.branding)
        } catch (error) {
            if (error.code !== 'gone') this.callError = error.message
        } finally {
            this.busy = false
        }
    }

    // Fill any missing locale/field so v-model always has a target, whatever the
    // server sent (an older or partial branding.json).
    normalise(branding) {
        const langs = (src) => {
            const out = {}
            for (const l of LOCALES) out[l] = (src && typeof src[l] === 'string') ? src[l] : ''
            return out
        }
        const b = branding || {}
        const channel = b.channel || {}
        return {
            navTitle: langs(b.navTitle),
            docTitle: langs(b.docTitle),
            channel: { label: langs(channel.label), href: typeof channel.href === 'string' ? channel.href : '' },
            faviconPath: typeof b.faviconPath === 'string' ? b.faviconPath : null,
        }
    }

    async save() {
        this.saving = true
        this.callError = ''
        this.saved = false
        try {
            const response = await this.adminApi.post('/api/admin/branding', this.form)
            this.form = this.normalise(response.branding)
            this.saved = true
        } catch (error) {
            if (error.code !== 'gone') this.callError = error.message
        } finally {
            this.saving = false
        }
    }

    onFaviconPicked(event) {
        const file = event.target.files && event.target.files[0]
        if (file) this.uploadFavicon(file)
    }

    async uploadFavicon(file) {
        this.uploading = true
        this.callError = ''
        this.saved = false
        try {
            // Multipart, so a direct fetch rather than the JSON client. The route
            // stores the favicon AND persists it onto branding.json in one call,
            // so a successful upload returns the new branding and it is live.
            const fd = new FormData()
            fd.append('file', file)
            const res = await fetch('/api/admin/branding/favicon', {
                method: 'POST',
                credentials: 'same-origin',
                body: fd,
            })
            let payload = null
            try { payload = await res.json() } catch (ignored) { payload = null }
            if (!res.ok) {
                throw new Error((payload && payload.message) || ('HTTP ' + res.status))
            }
            this.form = this.normalise(payload.branding)
            this.saved = true
        } catch (error) {
            this.callError = error.message
        } finally {
            this.uploading = false
            if (this.$refs.favicon) this.$refs.favicon.value = ''
        }
    }
}

export default BrandingPanel
</script>
