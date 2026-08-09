<template>
    <div class="clip-info-layer" @keydown.esc="close">
        <button class="clip-info-scrim" type="button" :aria-label="$t('action.close')" @click="close"></button>
        <aside ref="panel" class="clip-info-card" :class="{ 'is-dragging': dragging, 'is-closing': closing }" :style="panelStyle" role="dialog" aria-modal="true" :aria-label="$t('info.clipInfo')" :aria-describedby="'clip-info-title-' + clip.id" tabindex="-1">
            <span class="clip-info-arrow" aria-hidden="true"></span>
            <div class="clip-info-scroll">
                <div class="clip-info-head" @pointerdown="startDrag" @pointermove="drag" @pointerup="releaseDrag" @pointercancel="cancelDrag">
                    <span class="clip-info-grip" aria-hidden="true"></span>
                    <h2 :id="'clip-info-title-' + clip.id" :lang="captionLang || undefined">{{ caption || $t('info.clipInfo') }}</h2>
                    <button class="clip-info-close" type="button" @click="close">×</button>
                </div>
                <dl>
                    <template v-for="row in infoRows">
                        <dt :key="'label-' + row.key">{{ row.label }}</dt>
                        <dd :key="'value-' + row.key">
                            <a v-if="row.href" :href="row.href" target="_blank" rel="noopener noreferrer">{{ row.linkText }}</a>
                            <span v-else>{{ row.value }}</span>
                        </dd>
                    </template>
                </dl>
            </div>
        </aside>
    </div>
</template>

<script>
import Vue from 'vue'
import Component from 'vue-class-component'
import { buildInfoRows, desktopPanelStyle, formatSeconds } from './clip-info-behavior.mjs'
import { sampleVelocity, shouldDismissOffset } from './interaction.mjs'

@Component({
    props: {
        clip: { type: Object, required: true },
        caption: { type: String, default: '' },
        captionLang: { type: String, default: null },
        anchor: { type: Object, default: null },
    },
})
class ClipInfoCard extends Vue {
    offsetY = 0
    dragging = false
    closing = false
    mounted() {
        this._previousFocus = document.activeElement
        this._samples = []
        this._pointerId = null
        this._animationCancel = null
        this._dismissTimer = null
        this.$refs.panel.focus()
        this.$nextTick(() => {
            if (!this.isMobile) return
            const height = this.$refs.panel.offsetHeight || 320
            this.offsetY = height
            const reduced = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
            if (reduced) this.offsetY = 0
            else this.animateOffset(0, false)
        })
    }
    focus() {
        if (this.$refs.panel) this.$refs.panel.focus()
    }
    beforeDestroy() {
        if (this._animationCancel) this._animationCancel()
        if (this._dismissTimer) clearTimeout(this._dismissTimer)
        if (this._previousFocus && this._previousFocus.focus) this._previousFocus.focus()
    }
    get isMobile() {
        return typeof window !== 'undefined' && window.innerWidth <= 640
    }
    get panelStyle() {
        if (this.isMobile) return { transform: 'translateY(' + this.offsetY + 'px)' }
        if (!this.anchor) return {}
        return desktopPanelStyle(this.anchor, { width: window.innerWidth, height: window.innerHeight })
    }
    get infoRows() {
        return buildInfoRows(this.clip, {
            typeLabel: this.$t('info.clipType.label'),
            types: {
                video: this.$t('info.clipType.video'),
                stream: this.$t('info.clipType.stream'),
            },
            source: this.$t('info.clipSource'),
            original: this.$t('info.clipOriginal'),
            date: this.$t('info.clipDate'),
            timePoint: this.$t('info.clipDuration'),
            submitter: this.$t('info.clipSubmitter'),
            jump: this.$t('info.clipJump'),
        })
    }
    startDrag(event) {
        const target = event.target
        if (!this.isMobile || (target && target.closest && target.closest('button'))) return
        if (event.button !== undefined && event.button !== 0) return
        if (this._animationCancel) this._animationCancel()
        if (this._dismissTimer) clearTimeout(this._dismissTimer)
        this.closing = false
        this.dragging = true
        this._pointerId = event.pointerId
        this._startY = event.clientY
        this._startOffset = this.offsetY
        this._samples = [{ y: event.clientY, time: event.timeStamp || Date.now() }]
        if (event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId)
    }
    drag(event) {
        if (!this.dragging || this._pointerId !== event.pointerId) return
        const delta = event.clientY - this._startY
        this.offsetY = Math.max(0, this._startOffset + (delta < 0 ? delta * .35 : delta))
        const time = event.timeStamp || Date.now()
        this._samples.push({ y: event.clientY, time })
        if (this._samples.length > 16) this._samples.shift()
    }
    releaseDrag(event) {
        if (!this.dragging || this._pointerId !== event.pointerId) return
        this.dragging = false
        const velocity = sampleVelocity(this._samples)
        const dismiss = shouldDismissOffset(this.offsetY, velocity, this.$refs.panel.offsetHeight || 320)
        this.animateOffset(dismiss ? (this.$refs.panel.offsetHeight || 320) : 0, dismiss)
        this._pointerId = null
    }
    cancelDrag() {
        if (!this.dragging) return
        this.dragging = false
        this.animateOffset(0, false)
        this._pointerId = null
    }
    animateOffset(target, dismiss) {
        if (this._animationCancel) this._animationCancel()
        if (this._dismissTimer) clearTimeout(this._dismissTimer)
        const reduced = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        if (reduced) {
            this.closing = dismiss
            this.offsetY = target
            this._animationCancel = null
            this._dismissTimer = null
            if (dismiss) this.$emit('close')
            return
        }
        this.closing = dismiss
        const from = this.offsetY
        const started = Date.now()
        const duration = 260
        let done = false
        const requestFrame = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
            ? (callback) => window.requestAnimationFrame(callback)
            : (callback) => setTimeout(callback, 16)
        const cancelFrame = typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function'
            ? (id) => window.cancelAnimationFrame(id)
            : (id) => clearTimeout(id)
        const finish = () => {
            if (done) return
            done = true
            if (this._dismissTimer) clearTimeout(this._dismissTimer)
            this._dismissTimer = null
            this.offsetY = target
            this._animationCancel = null
            if (dismiss) this.$emit('close')
        }
        const tick = () => {
            if (done) return
            const progress = Math.min(1, (Date.now() - started) / duration)
            const eased = 1 - Math.pow(1 - progress, 3)
            this.offsetY = from + (target - from) * eased
            if (progress >= 1) finish()
            else this._frame = requestFrame(tick)
        }
        this._animationCancel = () => { done = true; if (this._frame) cancelFrame(this._frame) }
        this._dismissTimer = setTimeout(finish, duration + 80)
        tick()
    }
    formatSeconds(value) {
        return formatSeconds(value)
    }
    close() {
        if (this.isMobile) this.animateOffset(this.$refs.panel.offsetHeight || 320, true)
        else this.$emit('close')
    }
}

export default ClipInfoCard
</script>

<style lang="scss" scoped>
.clip-info-layer {
    position: fixed;
    z-index: 1100;
    inset: 0;
}
.clip-info-scrim {
    position: absolute;
    inset: 0;
    width: 100%;
    border: 0;
    background: var(--plum-900);
    opacity: .18;
}
.clip-info-card {
    position: absolute;
    top: 6rem;
    right: 1.5rem;
    width: min(28rem, calc(100vw - 3rem));
    max-height: calc(100vh - 8rem);
    overflow: visible;
    padding: 0;
    background: rgba(255, 255, 255, .82);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    backdrop-filter: blur(24px) saturate(180%);
    color: var(--plum-700);
    border: 3px solid var(--candy-red);
    border-radius: 1rem;
    box-shadow: 0 .75rem 2rem var(--plum-900);
    animation: clip-info-in .24s cubic-bezier(.2, .8, .2, 1) both;
}
.clip-info-arrow {
    position: absolute;
    top: -9px;
    left: var(--clip-info-arrow-left, 2rem);
    width: 16px;
    height: 16px;
    background: rgba(255, 255, 255, .82);
    border-top: 2px solid var(--candy-red);
    border-left: 2px solid var(--candy-red);
    transform: translateX(-50%) rotate(45deg);
}
.clip-info-scroll {
    max-height: calc(100vh - 8rem);
    overflow: auto;
    padding: 1rem 1.25rem;
}
.clip-info-card.is-dragging { transition: none; }
.clip-info-grip { display: none; }
.clip-info-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
}
.clip-info-head h2 {
    margin: 0;
    font-size: 1.2rem;
}
.clip-info-close {
    border: 0;
    background: transparent;
    color: var(--plum-700);
    font-size: 1.5rem;
    line-height: 1;
}
.clip-info-card dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: .45rem .8rem;
    margin: 1rem 0 0;
}
.clip-info-card dt {
    font-weight: 700;
    color: var(--plum-700);
    font-size: .72rem;
    letter-spacing: .08em;
    text-transform: uppercase;
}
.clip-info-card dd {
    margin: 0;
    overflow-wrap: anywhere;
}
.clip-info-card a {
    display: inline-flex;
    align-items: center;
    min-height: 2rem;
    padding: .2rem .7rem;
    border: 2px solid var(--candy-red);
    border-radius: 999px;
    color: var(--plum-700);
    text-decoration: underline;
}
@media (max-width: 640px) {
    .clip-info-card {
        top: auto;
        right: 0;
        bottom: 0;
        width: 100%;
        max-height: 70vh;
        overflow: visible;
        border-radius: 1rem 1rem 0 0;
        border-bottom: 0;
        animation: none;
        touch-action: none;
    }
    .clip-info-head { cursor: grab; flex-wrap: wrap; }
    .clip-info-head h2,
    .clip-info-close { flex: 0 1 auto; }
    .clip-info-grip { flex: 0 0 100%; }
    .clip-info-grip { display: block; width: 2.5rem; height: .25rem; margin: -.25rem auto .5rem; border-radius: .25rem; background: var(--plum-700); }
    .clip-info-scroll { max-height: 70vh; }
    .clip-info-arrow { display: none; }
}
@media (prefers-reduced-motion: reduce) {
    .clip-info-card { scroll-behavior: auto; animation: clip-info-fade .12s ease-out both; transition: none; }
}
@media (prefers-reduced-transparency: reduce) {
    .clip-info-scrim { background: var(--surface-alt); opacity: 1; }
    .clip-info-card {
        background: var(--surface);
        -webkit-backdrop-filter: none;
        backdrop-filter: none;
        filter: none;
    }
}
@keyframes clip-info-in {
    from { opacity: 0; transform: scale(.94); filter: blur(12px); }
    to { opacity: 1; transform: scale(1); filter: blur(0); }
}
@media (prefers-reduced-motion: reduce) {
    .clip-info-card { animation: clip-info-fade .12s ease-out both; filter: none; }
}
@keyframes clip-info-fade {
    from { opacity: 0; }
    to { opacity: 1; }
}
</style>
