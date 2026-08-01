<template>
    <div>
        <label class="adm-label" :for="fieldId">{{ label }}</label>

        <!-- The register to match, above the box rather than beside it: the
             owner reads it, then types under it. Everything in here is
             submitter- or owner-authored TEXT that came back from the API, so it
             is interpolated as a value and never handed to $t. -->
        <dl v-if="showRegister" class="adm-register">
            <template v-if="groupCaption">
                <dt>{{ $t("admin.desk.registerGroup") }}</dt>
                <dd>{{ groupCaption }}</dd>
            </template>
            <template v-if="siblingCaptions === null">
                <dt>{{ $t("admin.desk.registerUnavailable") }}</dt>
            </template>
            <template v-else-if="siblingCaptions.length > 0">
                <dt>{{ $t("admin.desk.registerSiblings") }}</dt>
                <dd v-for="(caption, index) in siblingCaptions" :key="index">{{ caption }}</dd>
            </template>
            <template v-else>
                <dt>{{ $t("admin.desk.registerNone") }}</dt>
            </template>
        </dl>

        <input
            :id="fieldId"
            type="text"
            class="adm-input"
            :class="{ 'is-bad': verdict && !verdict.ok }"
            :value="value"
            :aria-invalid="verdict && !verdict.ok ? 'true' : 'false'"
            :aria-describedby="fieldId + '-msg'"
            :placeholder="placeholder"
            @input="$emit('input', $event.target.value)">

        <div :id="fieldId + '-msg'">
            <p class="adm-hint adm-num">
                {{ $t("admin.desk.charCount", { n: verdict ? verdict.length : 0, max: maxLength }) }}
            </p>
            <p v-if="verdict && !verdict.ok" class="adm-bad">{{ reasonText }}</p>
            <p v-else-if="verdict && verdict.escaped" class="adm-warn">
                {{ $t("admin.text.escaped", { stored: verdict.stored }) }}
            </p>
        </div>
    </div>
</template>

<!--
    One text field that will end up as a vue-i18n MESSAGE VALUE — a clip's name,
    a caption, a new group's display name.

    It renders; it does not judge. The verdict is computed by the owner of the
    draft (ReviewDeskItem) so that the mirror of the server's rules exists in one
    place and every field is measured by the same copy of it. Passing the verdict
    down rather than raising an event up also means "is this form submittable"
    is a pure function of the draft, not an accumulation of things children
    happened to emit.
-->

<script>
import Vue from 'vue'
import Component from 'vue-class-component'

@Component({
    props: {
        value: { type: String, default: '' },
        label: { type: String, required: true },
        fieldId: { type: String, required: true },
        maxLength: { type: Number, required: true },
        placeholder: { type: String, default: '' },
        /** { ok, reason, length, escaped, stored } — see ReviewDeskItem. */
        verdict: { type: Object, default: null },
        /** The group's own caption in this locale, or ''. */
        groupCaption: { type: String, default: '' },
        /**
         * Captions the clips already in this group carry, in this locale.
         * null means the published catalogue could not be read — which is a
         * different thing from an empty group, and is rendered differently.
         */
        siblingCaptions: { type: Array, default: null },
        showRegister: { type: Boolean, default: false },
    },
})
class I18nTextField extends Vue {
    get reasonText() {
        // The reason codes are server-side constants (CAPTION_REJECTIONS); the
        // wording is ours and is translated, because this is the one message on
        // the screen the owner is meant to act on immediately.
        const key = 'admin.text.' + this.verdict.reason
        return this.$t(key, { max: this.maxLength })
    }
}

export default I18nTextField
</script>
