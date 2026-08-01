<template>
    <div class="adm-panel">
        <div class="adm-panel-head">
            <div>
                <h2 class="adm-h">{{ $t("admin.admins.title") }}</h2>
                <p class="adm-sub">{{ $t("admin.admins.subtitle") }}</p>
            </div>
            <button type="button" class="adm-btn" :disabled="listBusy" @click="loadAdmins">
                {{ $t("admin.admins.refresh") }}
            </button>
        </div>

        <p v-if="listError" class="adm-note adm-note-bad">{{ listError }}</p>

        <!-- The roster ------------------------------------------------------ -->
        <ul v-if="admins.length > 0" class="adm-register adm-list">
            <li v-for="a in admins" :key="a.openId" class="adm-list-row">
                <div class="adm-list-main">
                    <span class="adm-mono">{{ a.openId }}</span>
                    <span v-if="a.you" class="adm-badge">{{ $t("admin.admins.you") }}</span>
                    <span class="adm-badge" :class="a.source === 'seed' ? 'adm-badge-seed' : 'adm-badge-invite'">
                        {{ a.source === 'seed' ? $t("admin.admins.seed") : $t("admin.admins.invited") }}
                    </span>
                </div>
                <div class="adm-list-side">
                    <span v-if="a.source === 'seed'" class="adm-hint">{{ $t("admin.admins.seedNote") }}</span>
                    <button
                        v-else
                        type="button"
                        class="adm-btn adm-btn-danger"
                        :disabled="revoking === a.openId"
                        @click="revoke(a)">
                        {{ revoking === a.openId ? $t("admin.admins.removing") : $t("admin.admins.remove") }}
                    </button>
                </div>
            </li>
        </ul>

        <!-- The invitation -------------------------------------------------- -->
        <div class="adm-fieldset inv-box">
            <div class="adm-legend">{{ $t("admin.admins.inviteTitle") }}</div>
            <p class="adm-sub">{{ $t("admin.admins.inviteLead") }}</p>

            <button
                v-if="!invite"
                type="button"
                class="adm-btn adm-btn-primary"
                :disabled="inviteBusy"
                @click="startInvite">
                {{ inviteBusy ? $t("admin.admins.opening") : $t("admin.admins.startInvite") }}
            </button>
            <p v-if="inviteError" class="adm-note adm-note-bad">{{ inviteError }}</p>

            <div v-if="invite" class="inv-live">
                <!-- pending / claimed both show the phrase; the state line differs -->
                <template v-if="invite.state === 'pending' || invite.state === 'claimed'">
                    <p class="adm-label">{{ $t("admin.admins.postThis") }}</p>
                    <p class="inv-phrase" @click="copyPhrase">{{ invite.challengeText }}</p>
                    <p class="adm-hint">
                        <a :href="roomUrl" target="_blank" rel="noopener">{{ $t("admin.admins.openRoom") }}</a>
                        <span v-if="copied" class="adm-note-ok"> · {{ $t("admin.admins.copied") }}</span>
                    </p>
                    <p class="adm-sub">
                        <span v-if="invite.listening === false" class="adm-warn">
                            {{ $t("admin.admins.connecting") }}
                        </span>
                        <span v-else>{{ $t("admin.admins.expiresIn", { s: countdown }) }}</span>
                    </p>
                </template>

                <!-- claimed: the candidate and the confirm gate -->
                <div v-if="invite.state === 'claimed'" class="inv-claim adm-note adm-note-warn">
                    <p>{{ $t("admin.admins.claimedBy") }}</p>
                    <p class="adm-mono adm-num">{{ invite.candidate.openId }}</p>
                    <p v-if="invite.candidate.displayName" class="adm-hint">{{ invite.candidate.displayName }}</p>
                    <p class="adm-sub">{{ $t("admin.admins.confirmWarn") }}</p>
                </div>

                <p v-if="invite.state === 'confirmed'" class="adm-note adm-note-ok">
                    {{ $t("admin.admins.confirmedNow", { id: lastConfirmed }) }}
                </p>
                <p v-if="invite.state === 'expired'" class="adm-note adm-note-bad">
                    {{ $t("admin.admins.expired") }}
                </p>

                <div class="adm-actions">
                    <button
                        v-if="invite.state === 'claimed'"
                        type="button"
                        class="adm-btn adm-btn-primary"
                        :disabled="confirmBusy"
                        @click="confirmInvite">
                        {{ confirmBusy ? $t("admin.admins.confirming") : $t("admin.admins.confirm") }}
                    </button>
                    <button type="button" class="adm-btn" @click="dismissInvite">
                        {{ invite.state === 'confirmed' || invite.state === 'expired'
                            ? $t("admin.admins.done") : $t("admin.admins.cancel") }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<!--
    ===========================================================================
    ADMINS
    ===========================================================================
    The roster, and the online way to add to it. An existing admin opens an
    invitation; the candidate posts the phrase in the room exactly as a login;
    and THIS admin confirms — the confirm is the step that grants, so a phrase
    seen by the wrong person binds nobody. Seed admins (from ADMIN_OPEN_IDS) are
    shown but never removable here; that is the floor the server enforces too.

    Colours are literals, like every other admin panel — see the note in
    AdminDesk.vue for why the tool that can fix a bad theme must not be rendered
    in one. The classes come from AdminDesk.vue's global block; the few here are
    the phrase display and the roster rows.
-->
<script>
export default {
    name: 'AdminsPanel',
    inject: ['adminApi'],
    data() {
        return {
            admins: [],
            listBusy: false,
            listError: '',
            revoking: null,

            invite: null,
            inviteBusy: false,
            inviteError: '',
            confirmBusy: false,
            copied: false,
            lastConfirmed: '',
            countdown: 0,

            pollTimer: null,
            tickTimer: null,
        }
    },
    computed: {
        roomUrl() {
            const id = this.invite && this.invite.roomId
            return Number.isInteger(id) && id > 0 ? 'https://live.bilibili.com/' + id : null
        },
    },
    mounted() {
        this.loadAdmins()
    },
    beforeDestroy() {
        this.stopTimers()
    },
    methods: {
        async loadAdmins() {
            this.listBusy = true
            this.listError = ''
            try {
                const data = await this.adminApi.get('/api/admin/admins')
                this.admins = data.admins || []
            } catch (error) {
                if (error.code !== 'gone') this.listError = error.message
            } finally {
                this.listBusy = false
            }
        },

        async revoke(admin) {
            // eslint-disable-next-line no-alert
            if (!window.confirm(this.$t('admin.admins.removeConfirm', { id: admin.openId }))) return
            this.revoking = admin.openId
            try {
                await this.adminApi.post('/api/admin/admins/' + encodeURIComponent(admin.openId) + '/revoke')
                await this.loadAdmins()
            } catch (error) {
                if (error.code !== 'gone') this.listError = error.message
            } finally {
                this.revoking = null
            }
        },

        async startInvite() {
            this.inviteBusy = true
            this.inviteError = ''
            this.copied = false
            try {
                this.invite = await this.adminApi.post('/api/admin/invites')
                this.countdown = this.invite.expiresInSeconds
                this.startTimers()
            } catch (error) {
                if (error.code !== 'gone') this.inviteError = error.message
            } finally {
                this.inviteBusy = false
            }
        },

        async pollInvite() {
            if (!this.invite) return
            try {
                const next = await this.adminApi.get('/api/admin/invites/' + this.invite.id)
                // A confirmed/expired invite the WE drove stays as we set it; only
                // adopt a server state that is not already terminal here.
                if (this.invite.state === 'confirmed') return
                this.invite = next
                this.countdown = next.expiresInSeconds
                if (next.state === 'expired') this.stopTimers()
            } catch (error) {
                if (error.code === 'gone') this.dismissInvite()
                // A transient read error is not worth tearing the invite down.
            }
        },

        async confirmInvite() {
            if (!this.invite || this.invite.state !== 'claimed') return
            this.confirmBusy = true
            try {
                const result = await this.adminApi.post('/api/admin/invites/' + this.invite.id + '/confirm')
                this.lastConfirmed = result.openId
                this.invite = { ...this.invite, state: 'confirmed' }
                this.stopTimers()
                await this.loadAdmins()
            } catch (error) {
                if (error.code !== 'gone') this.inviteError = error.message
            } finally {
                this.confirmBusy = false
            }
        },

        async dismissInvite() {
            const open = this.invite && (this.invite.state === 'pending' || this.invite.state === 'claimed')
            const id = this.invite && this.invite.id
            this.stopTimers()
            this.invite = null
            this.copied = false
            if (open && id) {
                try {
                    await this.adminApi.post('/api/admin/invites/' + id + '/cancel')
                } catch (ignored) {
                    // The invite expires on its own if the cancel does not land.
                }
            }
        },

        copyPhrase() {
            const text = this.invite && this.invite.challengeText
            if (!text || !navigator.clipboard) return
            navigator.clipboard.writeText(text).then(
                () => { this.copied = true },
                () => {},
            )
        },

        startTimers() {
            this.stopTimers()
            this.pollTimer = window.setInterval(() => this.pollInvite(), 2500)
            this.tickTimer = window.setInterval(() => {
                if (this.countdown > 0) this.countdown -= 1
            }, 1000)
        },
        stopTimers() {
            if (this.pollTimer) { window.clearInterval(this.pollTimer); this.pollTimer = null }
            if (this.tickTimer) { window.clearInterval(this.tickTimer); this.tickTimer = null }
        },
    },
}
</script>

<style lang="scss" scoped>
.adm-list {
    list-style: none;
    margin: 0 0 20px;
    padding: 0;
}
.adm-list-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border-bottom: 1px solid #d9d2c4;   /* 1.28:1 on #fbf7ee — a hairline, not text */
    flex-wrap: wrap;
}
.adm-list-main {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}
.adm-badge {
    font-size: 12px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 999px;
    background: #ece5d6;
    color: #4a4132;                     /* 7.9:1 on #ece5d6 */
}
.adm-badge-seed { background: #d8e6d2; color: #24421c; }     /* 8.1:1 */
.adm-badge-invite { background: #dbe4f0; color: #24334a; }   /* 8.4:1 */
.adm-btn-danger {
    color: #7a1420;                     /* 6.6:1 on the panel */
    border-color: #b8434f;              /* 3.1:1 border */
}
.inv-box { margin-top: 8px; }
.inv-phrase {
    font-size: 22px;
    line-height: 1.4;
    font-weight: 700;
    color: #4a2a6b;                     /* 8.5:1 on the panel */
    margin: 6px 0;
    cursor: pointer;
    user-select: all;
    -webkit-user-select: all;
    overflow-wrap: break-word;
}
.inv-claim { margin: 12px 0; }
</style>
