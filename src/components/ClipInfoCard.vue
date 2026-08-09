<template>
    <div class="clip-info-layer" @keydown.esc="close">
        <button class="clip-info-scrim" type="button" :aria-label="$t('action.close')" @click="close"></button>
        <aside ref="panel" class="clip-info-card" :class="{ 'is-dragging': dragging, 'is-closing': closing }" :style="panelStyle" role="dialog" aria-modal="true" :aria-label="$t('info.clipInfo')" :aria-describedby="'clip-info-title-' + clip.id" tabindex="-1">
            <div class="clip-info-head" @pointerdown="startDrag" @pointermove="drag" @pointerup="releaseDrag" @pointercancel="cancelDrag">
                <span class="clip-info-grip" aria-hidden="true"></span>
                <h2 :id="'clip-info-title-' + clip.id" :lang="captionLang || undefined">{{ caption || $t('info.clipInfo') }}</h2>
                <span class="clip-info-kicker">{{ $t('info.clipInfo') }}</span>
                <button class="clip-info-close" type="button" @click="close">×</button>
            </div>
            <dl>
                <template v-if="clip.source && clip.source.kind">
                    <dt>{{ $t('info.clipType.label') }}</dt>
                    <dd>{{ $t('info.clipType.' + clip.source.kind) }}</dd>
                </template>
                <template v-if="clip.source && clip.source.title">
                    <dt>{{ $t('info.clipSource') }}</dt>
                    <dd>{{ clip.source.title }}</dd>
                </template>
                <template v-if="clip.source && clip.source.date">
                    <dt>{{ $t('info.clipDate') }}</dt>
                    <dd>{{ clip.source.date }}</dd>
                </template>
                <template v-if="clip.source && clip.source.seconds !== undefined">
                    <dt>{{ $t('info.clipDuration') }}</dt>
                    <dd>{{ formatSeconds(clip.source.seconds) }}</dd>
                </template>
                <template v-if="sourceHref">
                    <dt>{{ $t('info.clipSource') }}</dt>
                    <dd><a :href="sourceHref" target="_blank" rel="noopener noreferrer">{{ sourceHasMoment ? $t('info.clipJump') : clip.source.url }}</a></dd>
                </template>
                <template v-if="clip.submitter && clip.submitter.name">
                    <dt>{{ $t('info.clipSubmitter') }}</dt>
                    <dd>{{ clip.submitter.name }}</dd>
                </template>
            </dl>
        </aside>
    </div>
</template>

<script>
import Vue from 'vue'
import Component from 'vue-class-component'

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
        const left = Math.max(16, Math.min(this.anchor.left, window.innerWidth - 464))
        const top = Math.max(88, Math.min(this.anchor.bottom + 10, window.innerHeight - 240))
        return { left: left + 'px', top: top + 'px', right: 'auto', transformOrigin: 'top left' }
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
        const latest = this._samples[this._samples.length - 1]
        let earlier = null
        for (let index = this._samples.length - 2; index >= 0; index -= 1) {
            if (latest.time - this._samples[index].time >= 12) { earlier = this._samples[index]; break }
        }
        let velocity = 0
        if (earlier !== null) {
            const elapsed = latest.time - earlier.time
            velocity = elapsed > 120 ? 0 : (latest.y - earlier.y) / elapsed * 1000
        }
        velocity = Math.max(-1800, Math.min(1800, velocity))
        const decay = .998
        const projected = this.offsetY + (velocity / 1000) * 240 / (1 - decay)
        const threshold = (this.$refs.panel.offsetHeight || 320) * .6
        const dismiss = projected > threshold || velocity > 800
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
    get sourceHref() {
        const source = this.clip.source
        if (!source || typeof source.url !== 'string' || source.url === '') return ''
        if (!Number.isInteger(source.seconds) || source.seconds < 0) return source.url
        const hashAt = source.url.indexOf('#')
        const base = hashAt === -1 ? source.url : source.url.slice(0, hashAt)
        const hash = hashAt === -1 ? '' : source.url.slice(hashAt)
        const separator = base.indexOf('?') === -1 ? '?' : '&'
        return base + separator + 't=' + encodeURIComponent(source.seconds) + hash
    }
    get sourceHasMoment() {
        return Boolean(this.clip.source && Number.isInteger(this.clip.source.seconds) && this.clip.source.seconds >= 0)
    }
    formatSeconds(value) {
        if (!Number.isInteger(value) || value < 0) return ''
        const hours = Math.floor(value / 3600)
        const minutes = Math.floor((value % 3600) / 60)
        const seconds = value % 60
        const tail = (seconds < 10 ? '0' : '') + seconds
        return hours > 0 ? hours + ':' + (minutes < 10 ? '0' : '') + minutes + ':' + tail : minutes + ':' + tail
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
    overflow: auto;
    padding: 1rem 1.25rem;
    background: var(--surface);
    color: var(--plum-700);
    border: 3px solid var(--candy-red);
    border-radius: 1rem;
    box-shadow: 0 .75rem 2rem var(--plum-900);
    animation: clip-info-in .18s ease-out both;
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
.clip-info-kicker {
    margin-left: auto;
    color: var(--plum-700);
    font-size: .8rem;
    font-weight: 700;
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
}
.clip-info-card dd {
    margin: 0;
    overflow-wrap: anywhere;
}
.clip-info-card a {
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
        border-radius: 1rem 1rem 0 0;
        border-bottom: 0;
        animation: none;
        touch-action: none;
    }
    .clip-info-head { cursor: grab; flex-wrap: wrap; }
    .clip-info-head h2,
    .clip-info-kicker,
    .clip-info-close { flex: 0 1 auto; }
    .clip-info-grip { flex: 0 0 100%; }
    .clip-info-grip { display: block; width: 2.5rem; height: .25rem; margin: -.25rem auto .5rem; border-radius: .25rem; background: var(--plum-700); }
}
@media (prefers-reduced-motion: reduce) {
    .clip-info-card { scroll-behavior: auto; animation: clip-info-fade .12s ease-out both; transition: none; }
}
@media (prefers-reduced-transparency: reduce) {
    .clip-info-scrim { background: var(--surface-alt); opacity: 1; }
    .clip-info-card { filter: none; }
}
@keyframes clip-info-in {
    from { opacity: 0; transform: scale(.96); filter: blur(8px); }
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
