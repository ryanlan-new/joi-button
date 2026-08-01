<template>
    <div class="adm-panel adm-audition">
        <div class="adm-panel-head">
            <h3 class="adm-h">{{ $t("admin.audition.title") }}</h3>
            <span class="adm-num adm-sub">
                {{ $t("admin.audition.length", { seconds: durationSeconds.toFixed(1) }) }}
            </span>
        </div>

        <div class="adm-row">
            <button type="button" class="adm-btn adm-btn-primary" @click="playFromStart">
                {{ phase === 'idle' ? $t("admin.audition.play") : $t("admin.audition.restart") }}
            </button>
            <button type="button" class="adm-btn" v-if="phase === 'playing'" @click="pause">
                {{ $t("admin.audition.pause") }}
            </button>
            <button type="button" class="adm-btn" v-if="phase === 'paused'" @click="resume">
                {{ $t("admin.audition.resume") }}
            </button>
            <label class="adm-volume">
                <span class="adm-label">{{ $t("admin.audition.volume") }}</span>
                <input type="range" min="0" max="100" v-model="volume" @input="pushVolume">
            </label>
        </div>

        <!-- aria-hidden, and the reason matters: this bar is a wall-clock
             ESTIMATE, not a reading of the playhead. This component does not own
             the media element and the bus carries no timeupdate, so the only
             honest measurement available is "the player told us it ended". The
             bar is a comfort for sighted users; the text below it is the fact,
             and that is what assistive technology is given. -->
        <div class="adm-progress" aria-hidden="true">
            <div class="adm-progress-fill" :style="{ width: percent + '%' }"></div>
        </div>

        <p class="adm-status" :class="statusClass" role="status">{{ statusText }}</p>

        <p v-if="phase === 'stalled' && !alreadyHeard" class="adm-note adm-note-warn">
            {{ $t("admin.audition.stalledHint") }}
        </p>

        <!-- The played length and the recorded length are both shown, because
             "it stopped early" is a claim the reviewer should be able to check
             rather than take. The numbers are also what they would put in a bug
             report about the volume. -->
        <p v-if="phase === 'truncated' && !alreadyHeard" class="adm-note adm-note-warn">
            {{ $t("admin.audition.truncatedHint", { played: playedSeconds.toFixed(1), expected: durationSeconds.toFixed(1) }) }}
        </p>

        <p class="adm-hint">{{ $t("admin.audition.gate") }}</p>
        <p class="adm-mono adm-sub">{{ src }}</p>
    </div>
</template>

<!--
    ===========================================================================
    HEARING THE CLIP THROUGH
    ===========================================================================
    Approval is disabled until the clip has been played to its end. This file is
    where "to its end" is decided, so it is worth being exact about what is and
    is not being measured.

    HOW IT IS MEASURED. Playback goes through the app-level bus in App.vue —
    `player:play` out, `player:ended` back. The one thing this component can
    know for certain is that the media element reached the end of what it
    loaded. It cannot read currentTime, it cannot seek, and it does not want to:
    the bus has no seek verb, so the only route to `player:ended` is the
    playhead advancing through every second of the file. That is the property
    that makes this a gate rather than a checkbox.

    WHAT MAKES IT GO RED, IN TWO DIFFERENT WAYS. An audio URL that 404s or a
    codec the browser refuses produces NO `ended` at all: the wall-clock estimate
    below overruns, the phase goes `stalled`, and approve stays disabled with a
    stated reason.

    A TRUNCATED FILE DOES NOT BEHAVE THAT WAY, and an earlier version of this
    comment claimed it did. A file cut short on the volume fires `ended` EARLY,
    at whatever length decoded — measured on this repo's own media, the whole
    file ends at 18.49s and the same bytes cut to 35% end at 6.22s, with `ended`
    both times. The stall estimate cannot catch that: it only trips on an
    OVERRUN, and a clip that ends at 6s against a recorded 18.5s never overruns.
    So the gate would have opened after a third of the audio, which is precisely
    what it exists to prevent.

    That case is caught by comparing what was PLAYED against what the database
    recorded when the file was accepted — App.vue's `player:ended` carries the
    element's currentTime and duration for exactly this. Short by more than the
    tolerance below and the phase goes `truncated`, which does not open the gate
    and says both numbers on screen. This is not hypothetical: PublishPanel
    renders `plan.mediaProblems` because media on the shared volume can be short
    or missing.

    THE CEILING, stated: if the element reports neither a finite currentTime nor
    a finite duration — a live stream, or a browser that will not say — there is
    nothing to compare and the `ended` is credited. Refusing instead would make
    the desk unusable on a browser that under-reports, and this gate is a guard
    against approving by reflex, not an access control (see below).

    WHAT IT IS NOT. It is not an access control. server/routes/admin.mjs will
    accept an approval from a client that never played anything, and nothing
    here is sent to it. This gate stops the owner approving by reflex on the
    fortieth clip of an evening; it does not stop anyone determined to defeat
    their own tool, and it does not pretend to.

    ATTRIBUTION. `player:ended`'s payload describes the media element, not the
    clip, so an `ended` still has to be matched to a clip by knowing which one is
    loaded. Two things keep that honest: this component is keyed by item id and
    destroyed when the desk moves on, and beforeDestroy pauses the element — a
    paused element never fires `ended`, so an in-flight play can never be
    credited to the next item.
-->

<style lang="scss">
.adm-root .adm-audition .adm-volume { display: flex; flex-direction: column; }
.adm-root .adm-audition .adm-volume input { width: 120px; }
.adm-root .adm-progress {
    height: 10px;
    border: 1px solid var(--adm-line);
    border-radius: 5px;
    background-color: var(--adm-inset);
    overflow: hidden;
    margin: 10px 0 6px;
}
.adm-root .adm-progress-fill {
    height: 100%;
    background-color: var(--adm-accent);
    transition: width 0.2s linear;
}
.adm-root .adm-status { font-weight: 700; margin: 0 0 6px; }
.adm-root .adm-status.is-heard { color: var(--adm-ok-ink); }
.adm-root .adm-status.is-stalled { color: var(--adm-warn-ink); }
</style>

<script>
import Vue from 'vue'
import Component from 'vue-class-component'

// The decision this component gates on, extracted so it can be tested:
// test/audition-gate.test.mjs drives it in both directions.
import { judgeEnded } from './audition-gate.mjs'

/**
 * How long past the file's own length to wait before saying so.
 *
 * The estimate is wall-clock and playback is not: buffering on a phone stretches
 * a two-second clip over ten. So the grace is generous and the message it
 * produces is a suspicion rather than a verdict, and the component keeps
 * listening — an `ended` that arrives after the warning still opens the gate.
 */
const STALL_FACTOR = 1.25
const STALL_FLOOR_MS = 4000
const TICK_MS = 200


@Component({
    // Only for siteUrl(): the audio URL the route hands out is relative, and
    // one place in this area knows what it is relative to.
    inject: ['adminApi'],
    props: {
        itemId: { type: String, required: true },
        src: { type: String, required: true },
        durationSeconds: { type: Number, required: true },
        alreadyHeard: { type: Boolean, default: false },
    },
})
class ClipAudition extends Vue {
    phase = 'idle'      // idle | playing | paused | heard | stalled | truncated
    elapsedMs = 0
    volume = 80
    // What the media element reported having played, when it ended. Only read
    // while phase === 'truncated'; 0 otherwise.
    playedSeconds = 0

    get percent() {
        const total = this.durationSeconds * 1000
        if (total <= 0) return 0
        return Math.min(100, (this.elapsedMs / total) * 100)
    }

    get statusClass() {
        if (this.alreadyHeard || this.phase === 'heard') return 'is-heard'
        if (this.phase === 'stalled' || this.phase === 'truncated') return 'is-stalled'
        return ''
    }

    get statusText() {
        if (this.alreadyHeard || this.phase === 'heard') return this.$t('admin.audition.statusHeard')
        if (this.phase === 'stalled') return this.$t('admin.audition.statusStalled')
        if (this.phase === 'truncated') return this.$t('admin.audition.statusTruncated')
        if (this.phase === 'playing') {
            return this.$t('admin.audition.statusPlaying', { seconds: (this.elapsedMs / 1000).toFixed(1) })
        }
        if (this.phase === 'paused') {
            return this.$t('admin.audition.statusPaused', { seconds: (this.elapsedMs / 1000).toFixed(1) })
        }
        return this.$t('admin.audition.statusIdle')
    }

    mounted() {
        this.onEnded = (played) => {
            // Only credit an `ended` to a clip we are actually playing. An idle
            // component has nothing in flight and must not adopt somebody
            // else's event.
            if (this.phase !== 'playing' && this.phase !== 'stalled') return
            this.stopTicker()

            const verdict = judgeEnded(played, this.durationSeconds)
            if (!verdict.heard) {
                // Short by more than rounding. The file on the volume is not the
                // file the database recorded, so the gate stays shut and says
                // both numbers rather than leaving a disabled button unexplained.
                this.playedSeconds = verdict.playedSeconds
                this.phase = 'truncated'
                return
            }

            this.phase = 'heard'
            this.$emit('heard', this.itemId)
        }
        this.$gConst.globalbus.$on('player:ended', this.onEnded)
    }

    beforeDestroy() {
        this.$gConst.globalbus.$off('player:ended', this.onEnded)
        this.stopTicker()
        // Leaving the desk must not leave audio running under the next page,
        // and a paused element cannot fire `ended` into the next item's gate.
        if (this.phase === 'playing' || this.phase === 'stalled') {
            this.$gConst.globalbus.$emit('player:stop')
        }
    }

    playFromStart() {
        // Assigning `src` restarts the element even when the URL is unchanged,
        // so this is a genuine restart and the estimate starts from zero with it.
        this.$gConst.globalbus.$emit('player:play', {
            src: this.absoluteSrc(),
            volume: this.volume / 100,
        })
        this.elapsedMs = 0
        this.phase = 'playing'
        this.startTicker()
    }

    pause() {
        this.$gConst.globalbus.$emit('player:stop')
        this.stopTicker()
        this.phase = 'paused'
    }

    resume() {
        // `player:replay` calls play() without touching currentTime, so the
        // playhead continues and so does the estimate. Pausing in the middle and
        // resuming still passes through every second of the file, which is what
        // the gate is about.
        this.$gConst.globalbus.$emit('player:replay')
        this.phase = 'playing'
        this.startTicker()
    }

    pushVolume() {
        this.$gConst.globalbus.$emit('player:volume', this.volume / 100)
    }

    absoluteSrc() {
        return this.adminApi.siteUrl(this.src)
    }

    startTicker() {
        this.stopTicker()
        this.tickedAt = Date.now()
        this.ticker = window.setInterval(() => {
            const now = Date.now()
            this.elapsedMs += now - this.tickedAt
            this.tickedAt = now
            const limit = Math.max(this.durationSeconds * 1000 * STALL_FACTOR, this.durationSeconds * 1000 + STALL_FLOOR_MS)
            if (this.phase === 'playing' && this.elapsedMs > limit) {
                this.phase = 'stalled'
            }
        }, TICK_MS)
    }

    stopTicker() {
        if (this.ticker) {
            window.clearInterval(this.ticker)
            this.ticker = null
        }
    }
}

export default ClipAudition
</script>
