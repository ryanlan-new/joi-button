<template>
    <div class="container-fluid" >
        <div>
            <div class="cate-header">{{ $t("action.control")}}</div>
            <div class="cate-body">
                <button class="btn btn-info" @click="random">{{ $t("action.randomplay") }}</button>
                <button class="btn btn-info" @click="stopPlay">{{$t("action.stopvoice") }}</button>
                <button class="btn btn-info" type="button" :class="{ 'is-on': overlapCheck }" :disabled="autoCheck || loopCheck" :aria-pressed="String(overlapCheck)" @click="overlap" :title="$t('info.overlapTips')">
                    <span class="checkbox-mark" :class="{ 'is-checked': overlapCheck }" aria-hidden="true"></span>
                    <span>{{ $t("action.overlap") }}</span>
                </button>
                <button class="btn btn-info" type="button" :class="{ 'is-on': autoCheck }" :disabled="overlapCheck || loopCheck" :aria-pressed="String(autoCheck)" @click="autoPlay">
                    <span class="checkbox-mark" :class="{ 'is-checked': autoCheck }" aria-hidden="true"></span>
                    <span>{{ $t("action.autoplay") }}</span>
                </button>
                <button class="btn btn-info" type="button" :class="{ 'is-on': loopCheck }" :disabled="autoCheck || overlapCheck" :aria-pressed="String(loopCheck)" @click="loop" :title="$t('info.loopTips')">
                    <span class="checkbox-mark" :class="{ 'is-checked': loopCheck }" aria-hidden="true"></span>
                    <span>{{ $t("action.loop") }}</span>
                </button>
                <button class="btn btn-info" type="button" :class="{ 'is-on': detailsEnabled }" :aria-pressed="String(detailsEnabled)" @click="detailsEnabled = !detailsEnabled">
                    <span class="checkbox-mark" :class="{ 'is-checked': detailsEnabled }" aria-hidden="true"></span>
                    <span>{{ $t("action.details") }}</span>
                </button>
                <div class="visible-md visible-lg">
                  <label class="btn btn-info volume-control" for="volSlider">
                    <span>{{ $t("action.volume") }}</span>
                    <input ref="volSlider" class="slidecontainer slider" type="range" min="0" max="100" id="volSlider" v-model="currentVolume">
                  </label>
                  <p>{{ $t("action.volume") }}<span id="volOut">{{ currentVolume }}</span></p>
                </div>
            </div>
            <div class="cate-body">
                <div class="now-playing" aria-live="polite">
                    <span>{{ voice.id ? $t("action.playing") + $t("voice." + voice.id ) : $t("action.noplay") }}</span>
                    <template v-if="voice.id && voice.source">
                        <span v-if="voice.source.title" class="now-playing-field">{{ voice.source.title }}</span>
                        <span v-if="voice.source.date" class="now-playing-field">{{ voice.source.date }}</span>
                        <span v-if="voice.source.seconds !== undefined" class="now-playing-field">{{ formatSeconds(voice.source.seconds) }}</span>
                    </template>
                    <span v-if="voice.id && voice.submitter" class="now-playing-field">{{ voice.submitter.name }}</span>
                </div>
            </div>
        </div>
        <!-- Keyed and looked up on `id`, never on the caption. An id is the
             server's immutable primary key; the caption is submitter-authored
             text that changes, is different in three languages, and is not
             unique. Keying on it made Vue reuse the wrong button when two clips
             happened to be named the same thing. -->
        <div v-for="category in voices" v-bind:key="category.id">
            <div class="cate-header" :lang="captionLang(category)">{{ $t("voicecategory." + category.id) }}</div>
            <div class="cate-body">
                <div class="voice-row" v-for="clip in category.clips" v-bind:key="clip.id">
                    <button class="btn btn-new voice-play"
                            :class="{ 'is-playing': voice.id === clip.id }"
                            :style="pressStyle(clip)"
                            :lang="captionLang(clip)"
                            type="button"
                            @pointerdown="beginPress($event, clip)"
                            @pointermove="movePress($event, clip)"
                            @pointerup="endPress($event, clip)"
                            @pointercancel="cancelPress($event, clip)"
                            @contextmenu.prevent
                            @keydown.enter.space.prevent="play(clip)">
                        <span class="hold-sweep" :style="{ width: pressedId === clip.id ? holdProgress + '%' : '0%' }" aria-hidden="true"></span>
                        <span class="voice-label">{{ $t("voice." + clip.id )}}</span>
                    </button>
                    <!-- Sibling, never nested: a badge is its own interactive
                         control and cannot become a button inside a button. -->
                    <button class="clip-info-badge" :class="{ 'is-persistent': detailsEnabled }" type="button" :aria-label="$t('info.clipInfo')" @click.stop="openInfo(clip, $event)" @keydown.enter.space.prevent="openInfo(clip, $event)">ⓘ</button>
                </div>
            </div>
        </div>
        <ClipInfoCard v-if="infoClip" ref="clipInfo" :clip="infoClip" :caption="captionText(infoClip)" :caption-lang="captionLang(infoClip)" :anchor="infoAnchor" @close="closeInfo" />
    </div>
</template>

<style lang="scss" scoped>
/* Page-local only. The shared component idioms (.cate-header, .cate-body,
   .btn-new and their states) moved into App.vue's GLOBAL block: a scoped style
   compiles to `[data-v-hash]`, so nothing outside this component could ever have
   reused them — which would have left every new page rendering as stock
   Bootstrap. What stays here is genuinely specific to the player controls. */
/* Was an <input type="checkbox"> nested inside the <button>. Interactive content
   inside a button is invalid HTML and makes keyboard operation unreliable — and
   this one carried an inline onchange that forced its checked state from the
   button's `disabled` DOM property, which was never set, because only a CLASS
   was being toggled. The button itself is the control now and says so with
   aria-pressed; this is just the tick, and it cannot be focused. */
.checkbox-mark {
    display: inline-block;
    vertical-align: middle;
    margin: 0 5px 3px 0;
    width: 13px;
    height: 13px;
    border: 1px solid currentColor;
    border-radius: 2px;
    position: relative;
}
.checkbox-mark.is-checked::after {
    content: "";
    position: absolute;
    left: 3px; top: 0;
    width: 4px; height: 8px;
    border: solid currentColor;
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
}
/* The slider is no longer wrapped in a <button> either. A <label> is a valid
   container for a form control and associates the text with it. */
.volume-control {
    cursor: default;
}
.voice-row {
    position: relative;
    display: inline-flex;
    align-items: center;
    max-width: 100%;
}
.voice-play {
    position: relative;
    overflow: hidden;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
}
.voice-label,
.hold-sweep {
    position: relative;
    z-index: 1;
}
.hold-sweep {
    position: absolute;
    z-index: 0;
    inset: 0 auto 0 0;
    width: 0;
    background: var(--lilac);
    opacity: .55;
    pointer-events: none;
}
.clip-info-badge {
    position: absolute;
    top: 50%;
    /* The row is the pill-sized containing block. This keeps the badge
       visually inside the trailing edge while absolute positioning keeps the
       hidden state out of the row's flex sizing. */
    right: 8px;
    left: auto;
    z-index: 2;
    width: 1.75rem;
    height: 1.75rem;
    margin: 0;
    padding: 0;
    border: 2px solid var(--candy-red);
    border-radius: 50%;
    background: var(--surface);
    color: var(--plum-700);
    font-weight: 700;
    line-height: 1.35rem;
    touch-action: manipulation;
    opacity: 0;
    transform: translateY(-50%) scale(.7);
    transition: opacity .16s ease, transform .16s ease;
    pointer-events: none;
}
@media (hover: hover) {
    .voice-row:hover .clip-info-badge,
    .voice-play:focus-visible + .clip-info-badge {
        opacity: 1;
        transform: translateY(-50%) scale(1);
        pointer-events: auto;
    }
}
.clip-info-badge:focus-visible,
.clip-info-badge.is-persistent {
    opacity: 1;
    transform: translateY(-50%) scale(1);
    pointer-events: auto;
}
.clip-info-badge:focus-visible {
    outline: 3px solid var(--cocoa-900);
    outline-offset: 2px;
}
.now-playing {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: center;
    gap: .5rem;
}
.now-playing-field {
    color: var(--cocoa-700);
    font-size: .9rem;
}
/*Slider CSS modified from w3schools*/
.slider {
    -webkit-appearance: none;  /* Override default CSS styles */
    appearance: none;
    display: inline-block;
    width: auto; /* Full-width */
    height: 5px; /* Specified height */
    background: var(--track);
    outline: none; /* Remove outline */
    /* opacity:.7 removed: it composited the thumb down to 3.15:1 against the
       track while the stylesheet claimed the thumb's own colour. */
    -webkit-transition: .2s;
    transition: opacity .2s;
}

/* Mouse-over effects */
.slider:hover {
    opacity: 1; /* Fully shown on mouse-over */
}

/* The slider handle (use -webkit- (Chrome, Opera, Safari, Edge) and -moz- (Firefox) to override default look) */
.slider::-webkit-slider-thumb {
    -webkit-appearance: none; /* Override default look */
    appearance: none;
    width: 15px; /* Set a specific slider handle width */
    height: 15px; /* Slider handle height */
    background: var(--plum-700);
    cursor: pointer; /* Cursor on hover */
}

.slider::-moz-range-thumb {
    width: 15px; /* Set a specific slider handle width */
    height: 15px; /* Slider handle height */
    background: var(--plum-700);
    cursor: pointer; /* Cursor on hover */
}
@media (prefers-reduced-motion: reduce) {
    .clip-info-badge { transition: none; }
}
@media (prefers-reduced-transparency: reduce) {
    .hold-sweep,
    .clip-info-badge { opacity: 1; }
}
</style>

<script>
import Vue from 'vue'
import Component from 'vue-class-component'
// Not '../voices.json'. This page used to import that file directly, while
// src/main.js imported it a second time to build the i18n messages — two owners
// of one catalogue, which is survivable for a build-time constant and is not
// survivable once the catalogue arrives over the network. src/catalog.mjs is the
// single owner now; this page reads what it installed.
import { captionFor, catalog } from '../catalog.mjs'
import ClipInfoCard from './ClipInfoCard.vue'
import {
    HOLD_THRESHOLD_MS,
    MOVE_CANCEL_DISTANCE_PX,
    movedBeyondThreshold,
    scheduleHold,
    shouldPlayAfterPress,
    springValue,
} from './interaction.mjs'

@Component({
    components: { ClipInfoCard },
    watch: {
        currentVolume: function (value) {
            this.$gConst.globalbus.$emit('player:volume', value / 100);
        }
    }
})
class HomePage extends Vue {
    autoCheck = false;
    overlapCheck = false;
    loopCheck = false;
    currVoice;
    voice = {};
    currentVolume = 80;
    pressedId = null;
    infoClip = null;
    infoAnchor = null;
    detailsEnabled = false;
    holdProgress = 0;
    pressScales = {};

    // A computed and not a data property. `catalog.groups` is REPLACED when a
    // document is installed, so a copy taken once at construction would keep
    // rendering the array it was handed. vue-class-component turns a getter into
    // a computed, so this tracks the replacement.
    get voices() {
        return catalog.groups;
    }
    get currentAudioVolume() {
        return  this.currentVolume / 100
    }
    mounted() {
        this._press = { clip: null, pointerId: null, startX: 0, startY: 0, moved: false, held: false, timer: null, anchor: null };
        this._springs = Object.create(null);
        // The media element now lives in App.vue and outlives this route; what
        // this page still owns is what a clip ENDING should mean — chain to a
        // random clip, repeat, or clear the now-playing label.
        this.handleEnded = () => this.voiceEnd(false);
        this.$gConst.globalbus.$on('player:ended', this.handleEnded);
    }
    beforeDestroy() {
        this.cancelPress();
        Object.keys(this._springs || {}).forEach((id) => this._springs[id]());
        this.$gConst.globalbus.$off('player:ended', this.handleEnded);
    }
    captionLang(item) {
        const resolved = captionFor(item.captions || {}, this.$i18n.locale);
        return resolved ? resolved.locale : undefined;
    }
    captionText(item) {
        const resolved = captionFor(item.captions || {}, this.$i18n.locale);
        return resolved ? resolved.text : item.label;
    }
    formatSeconds(value) {
        if (!Number.isInteger(value) || value < 0) return '';
        const hours = Math.floor(value / 3600);
        const minutes = Math.floor((value % 3600) / 60);
        const seconds = value % 60;
        const tail = (seconds < 10 ? '0' : '') + seconds;
        return hours > 0 ? hours + ':' + (minutes < 10 ? '0' : '') + minutes + ':' + tail : minutes + ':' + tail;
    }
    pressStyle(item) {
        const scale = this.pressScales && this.pressScales[item.id];
        return { transform: 'scale(' + (scale === undefined ? 1 : scale) + ')' };
    }
    setPressScale(id, value) {
        this.$set(this.pressScales, id, value);
    }
    springPress(id, target, options) {
        if (this._springs[id]) this._springs[id]();
        const from = this.pressScales && this.pressScales[id] !== undefined ? this.pressScales[id] : 1;
        const reduced = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduced) {
            this.setPressScale(id, target);
            return;
        }
        this._springs[id] = springValue(from, target, {
            duration: options && options.duration,
            bounce: options && options.bounce,
            onUpdate: (value) => this.setPressScale(id, value),
            onComplete: () => { delete this._springs[id]; },
        });
    }
    beginPress(event, item) {
        if (event.button !== undefined && event.button !== 0) return;
        this.cancelPress();
        this._press = { clip: item, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false, held: false, timer: null, anchor: event.currentTarget && event.currentTarget.getBoundingClientRect ? event.currentTarget.getBoundingClientRect() : null };
        this.pressedId = item.id;
        this.holdProgress = 0;
        this.startHoldProgress(item);
        this.springPress(item.id, .94, { duration: .34, bounce: 0 });
        if (event.currentTarget && event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId);
        // The hold threshold is a timer, not an rAF: background tabs and a
        // renderer that stops painting must still cancel the click/submit path.
        this._press.timer = scheduleHold({
            threshold: HOLD_THRESHOLD_MS,
            isActive: () => !this._press.moved && this._press.clip === item,
            onHold: () => {
                this._press.held = true;
                this.stopHoldProgress();
                this.holdProgress = 100;
                this.openInfo(item, this._press.anchor);
            }
        });
    }
    movePress(event, item) {
        if (!this._press || this._press.clip !== item || this._press.pointerId !== event.pointerId) return;
        const moved = movedBeyondThreshold(
            this._press.startX,
            this._press.startY,
            event.clientX,
            event.clientY,
            MOVE_CANCEL_DISTANCE_PX,
        );
        if (!moved || this._press.moved) return;
        this._press.moved = true;
        if (this._press.timer !== null) this._press.timer();
        this._press.timer = null;
        this.stopHoldProgress();
        this.holdProgress = 0;
        this.springPress(item.id, 1, { duration: .34, bounce: .2 });
        this.pressedId = null;
    }
    endPress(event, item) {
        if (!this._press || this._press.clip !== item || this._press.pointerId !== event.pointerId) return;
        const cancelled = !shouldPlayAfterPress(this._press);
        if (this._press.timer !== null) this._press.timer();
        this._press.timer = null;
        this.stopHoldProgress();
        this.holdProgress = 0;
        this.springPress(item.id, 1, { duration: .34, bounce: cancelled ? .2 : 0 });
        this.pressedId = null;
        if (!cancelled) this.play(item);
        this._press.clip = null;
    }
    cancelPress() {
        if (!this._press) return;
        if (this._press.timer !== null) this._press.timer();
        this.stopHoldProgress();
        this.holdProgress = 0;
        if (this._press.clip) this.springPress(this._press.clip.id, 1, { duration: .34, bounce: .2 });
        this._press = { clip: null, pointerId: null, startX: 0, startY: 0, moved: false, held: false, timer: null, anchor: null };
        this.pressedId = null;
    }
    startHoldProgress(item) {
        const started = Date.now();
        const tick = () => {
            if (!this._press || this._press.clip !== item || this._press.moved || this._press.held) return;
            this.holdProgress = Math.min(100, ((Date.now() - started) / 420) * 100);
            this._holdFrame = typeof window !== 'undefined' && window.requestAnimationFrame
                ? window.requestAnimationFrame(tick)
                : setTimeout(tick, 16);
        };
        this._holdFrame = typeof window !== 'undefined' && window.requestAnimationFrame
            ? window.requestAnimationFrame(tick)
            : setTimeout(tick, 16);
    }
    stopHoldProgress() {
        if (this._holdFrame === null || this._holdFrame === undefined) return;
        if (typeof window !== 'undefined' && window.cancelAnimationFrame) window.cancelAnimationFrame(this._holdFrame);
        else clearTimeout(this._holdFrame);
        this._holdFrame = null;
    }
    openInfo(item, eventOrAnchor = null) {
        this.infoClip = item;
        this.infoAnchor = eventOrAnchor && eventOrAnchor.currentTarget && eventOrAnchor.currentTarget.getBoundingClientRect
            ? eventOrAnchor.currentTarget.getBoundingClientRect()
            : eventOrAnchor;
        this.$nextTick(() => {
            if (this.$refs.clipInfo && this.$refs.clipInfo.focus) this.$refs.clipInfo.focus();
        });
    }
    closeInfo() {
        this.infoClip = null;
        this.infoAnchor = null;
    }
    play(item){
        // `item.src` rather than "voices/" + item.path: where the audio lives is
        // the catalogue's business (its mediaBaseUrl), and the published
        // document is free to move it. This page no longer builds a URL.
        if (this.overlapCheck) {
            // The one media element this page still owns, and the only one the
            // App.vue player protocol cannot express: overlap deliberately
            // starts a clip WITHOUT stopping the last one, and the protocol has
            // a single element behind it. Left exactly as it was — changing it
            // means adding a verb to the bus in App.vue, which is not this
            // change.
            let audio = new Audio(item.src);
            audio.volume = this.currentAudioVolume;
            this.voice = item;
            audio.play()
        } else {
            this.stopPlay();
            this.voice = item;
            this.currVoice = item;
            this.$gConst.globalbus.$emit('player:play', {
                src: item.src,
                volume: this.currentAudioVolume,
            });
        }
    }
    stopPlay(){
        this.$gConst.globalbus.$emit('player:stop');
        this.voiceEnd(true);
    }
    voiceEnd(flag) {
        if(flag !== true && this.autoCheck) {
            this.random();
        } else if(flag !== true && this.loopCheck) {
            this.$gConst.globalbus.$emit('player:replay');
        } else {
            this.voice = {};
        }
    }
    random() {
        // Still two stages — pick a heading, then a clip under it — because that
        // is what this button has always done, and it is what keeps a category
        // of one as likely to be heard as a category of ten.
        //
        // What is new is that a group can be EMPTY: v_catalog_groups publishes
        // every active group without joining clips, so a group whose clips are
        // all still unpublished is part of the document and gets a heading. The
        // old two-stage pick would have landed on it and played `undefined`.
        let playable = this.voices.filter(category => category.clips.length > 0);
        if (playable.length === 0) {
            return;
        }
        let category = playable[this._randomNum(0, playable.length - 1)];
        this.play(category.clips[this._randomNum(0, category.clips.length - 1)]);
    }
    autoPlay(){
        if (this.overlapCheck || this.loopCheck) {
            return;
        }
        this.autoCheck = !this.autoCheck;
    }
    overlap() {
        if (this.autoCheck || this.loopCheck) {
            return;
        }
        this.overlapCheck = !this.overlapCheck;
    }
    loop(){
        if (this.autoCheck || this.overlapCheck) {
            return;
        }
        this.loopCheck = !this.loopCheck;
    }
    _randomNum(minNum, maxNum) {
        switch(arguments.length) {
            case 1:
                return parseInt(Math.random() * minNum + 1, 10);
            case 2:
                return parseInt(Math.random() * (maxNum - minNum + 1) + minNum, 10);
            default:
                return 0;
        }
    }
}
export default HomePage;
</script>
