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
                <div class="visible-md visible-lg">
                  <label class="btn btn-info volume-control" for="volSlider">
                    <span>{{ $t("action.volume") }}</span>
                    <input ref="volSlider" class="slidecontainer slider" type="range" min="0" max="100" id="volSlider" v-model="currentVolume">
                  </label>
                  <p>{{ $t("action.volume") }}<span id="volOut">{{ currentVolume }}</span></p>
                </div>
            </div>
            <div class="cate-body">
                <span>{{ voice.id ? $t("action.playing") + $t("voice." + voice.id ) : $t("action.noplay") }}</span>
            </div>
        </div>
        <!-- Keyed and looked up on `id`, never on the caption. An id is the
             server's immutable primary key; the caption is submitter-authored
             text that changes, is different in three languages, and is not
             unique. Keying on it made Vue reuse the wrong button when two clips
             happened to be named the same thing. -->
        <div v-for="category in voices" v-bind:key="category.id">
            <div class="cate-header">{{ $t("voicecategory." + category.id) }}</div>
            <div class="cate-body">
                <button class="btn btn-new" :class="{ 'is-playing': voice.id === clip.id }" v-for="clip in category.clips" v-bind:key="clip.id" @click="play(clip)">
                    {{ $t("voice." + clip.id )}}
                </button>
            </div>
        </div>
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
</style>

<script>
import Vue from 'vue'
import Component from 'vue-class-component'
// Not '../voices.json'. This page used to import that file directly, while
// src/main.js imported it a second time to build the i18n messages — two owners
// of one catalogue, which is survivable for a build-time constant and is not
// survivable once the catalogue arrives over the network. src/catalog.mjs is the
// single owner now; this page reads what it installed.
import { catalog } from '../catalog.mjs'

@Component({
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
        // The media element now lives in App.vue and outlives this route; what
        // this page still owns is what a clip ENDING should mean — chain to a
        // random clip, repeat, or clear the now-playing label.
        this.handleEnded = () => this.voiceEnd(false);
        this.$gConst.globalbus.$on('player:ended', this.handleEnded);
    }
    beforeDestroy() {
        this.$gConst.globalbus.$off('player:ended', this.handleEnded);
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
