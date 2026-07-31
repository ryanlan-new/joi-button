<template>
    <div class="container-fluid" >
        <div>
            <div class="cate-header">{{ $t("action.control")}}</div>
            <div class="cate-body">
                <button class="btn btn-info" @click="random">{{ $t("action.randomplay") }}</button>
                <button class="btn btn-info" @click="stopPlay">{{$t("action.stopvoice") }}</button>
                <button class="btn btn-info" :class="{ 'disabled': autoCheck || loopCheck, 'is-on': overlapCheck }" :aria-pressed="String(overlapCheck)" @click="overlap" :title="$t('info.overlapTips')">
                    <input class="checkbox" type="checkbox" onchange="this.checked = this.parentNode.disabled" v-model="overlapCheck">
                    <span>{{ $t("action.overlap") }}</span>
                </button>
                <button class="btn btn-info" :class="{ 'disabled': overlapCheck || loopCheck, 'is-on': autoCheck }" :aria-pressed="String(autoCheck)" @click="autoPlay">
                    <input class="checkbox" type="checkbox" onchange="this.checked = this.parentNode.disabled" v-model="autoCheck">
                    <span>{{ $t("action.autoplay") }}</span>
                </button>
                <button class="btn btn-info" :class="{ 'disabled': autoCheck || overlapCheck, 'is-on': loopCheck }" :aria-pressed="String(loopCheck)" @click="loop" :title="$t('info.loopTips')">
                    <input class="checkbox" type="checkbox" onchange="this.checked = this.parentNode.disabled" v-model="loopCheck">
                    <span>{{ $t("action.loop") }}</span>
                </button>
                <div class="visible-md visible-lg">
                  <button class="btn btn-info">
                    <span>{{ $t("action.volume") }}</span>
                    <input ref="volSlider" class="slidecontainer slider" type="range" min="0" max="100" id="volSlider" v-model="currentVolume">
                  </button>
                  <p>{{ $t("action.volume") }}<span id="volOut">{{ currentVolume }}</span></p>
                </div>
            </div>
            <div class="cate-body">
                <span>{{ voice.name ? $t("action.playing") + $t("voice." + voice.name ) : $t("action.noplay") }}</span>
            </div>
        </div>
        <div v-for="category in voices" v-bind:key="category.categoryName">
            <div class="cate-header">{{ $t("voicecategory." + category.categoryName) }}</div>
            <div class="cate-body">
                <button class="btn btn-new" :class="{ 'is-playing': voice.name === voiceItem.name }" v-for="voiceItem in category.voiceList" v-bind:key="voiceItem.name" @click="play(voiceItem)">
                    {{ $t("voice." + voiceItem.name )}}
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
.checkbox {
    display: inline-block;
    vertical-align: middle;
    margin: 0 5px 3px 0;
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
import VoiceList from '../voices.json'

@Component({
    watch: {
        currentVolume: function (value) {
            this.$gConst.globalbus.$emit('player:volume', value / 100);
        }
    }
})
class HomePage extends Vue {
    voices = VoiceList.voices;
    autoCheck = false;
    overlapCheck = false;
    loopCheck = false;
    currVoice;
    voice = {};
    currentVolume = 80;

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
        if (this.overlapCheck) {
            let audio = new Audio("voices/" + item.path);
            audio.volume = this.currentAudioVolume;
            this.voice = item;
            audio.play()
        } else {
            this.stopPlay();
            this.voice = item;
            this.currVoice = item;
            this.$gConst.globalbus.$emit('player:play', {
                src: "voices/" + item.path,
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
        let tempList = this.voices[this._randomNum(0, this.voices.length - 1)];
        this.play(tempList.voiceList[this._randomNum(0, tempList.voiceList.length - 1)]);
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
