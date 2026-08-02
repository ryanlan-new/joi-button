<template>
    <div id="app">
        <Modal></Modal>
        <nav class="navbar navbar-default navbar-fixed-top navbar-inner">
            <div class="container-fluid">
                <div class="navbar-header">
                    <button type="button" class="navbar-toggle collapsed" data-toggle="collapse" data-target="#bs-navbar-collapse" aria-expanded="false">
                        <span class="sr-only">{{ $t("action.toggleNavbar") }}</span>
                        <span class="icon-bar"></span>
                        <span class="icon-bar"></span>
                        <span class="icon-bar"></span>
                    </button>
                    <!-- No `&nbsp;` and no inline vertical-align: the navbar items
                         are flex rows (see the style block), so the gap owns the
                         spacing and align-items owns the midline. -->
                    <router-link class="navbar-brand" to="/"><img :src="brandIconUrl" height="18" alt=""/>{{ navTitle }}</router-link>
                </div>

                <div class="collapse navbar-collapse" id="bs-navbar-collapse">
                    <ul class="nav navbar-nav">
                        <li><a :href="channelHref" target="_blank" rel="noopener"><img src="resources/bili_favicon.ico" height="18" alt=""/>{{ channelLabel }}</a></li>
                    </ul>
                    <!-- Order within this group, left to right: submit, account,
                         language.

                         .navbar-right floats the whole <ul> to the right edge and
                         the items inside it flow left to right, so the LAST item
                         is the one pinned to the corner and the group grows
                         LEFTWARDS. The language dropdown keeps that corner: it is
                         the only control a non-Chinese visitor has to find, it has
                         been there since the site existed, and a display name of
                         unpredictable width must not be allowed to move it.
                         Submit leads because it is the entry the page is
                         advertising; the account control sits next to it because
                         it is the state that decides what submit will do.

                         Below 768px the same DOM order becomes top to bottom
                         inside the hamburger, which pushes the language menu from
                         row 2 of 2 to row 4 of 4. That is the cost of this
                         ordering and it is paid knowingly, because measured at
                         375x812 nothing moves out of reach: the open collapse is
                         185px with both submenus shut, 270px with the account
                         menu open and 285px with the language menu open, against
                         the 340px max-height Bootstrap puts on a fixed-top
                         collapse. Only the (unreachable) case of both submenus
                         open at once hits the cap, and Bootstrap closes one when
                         the other opens.
                         The one place it does clip: Bootstrap drops that cap to
                         200px at `max-device-width:480px and orientation:
                         landscape`, so a small phone held sideways scrolls the
                         open language menu. overflow-y is already auto there, so
                         it scrolls rather than truncating. -->
                    <ul class="nav navbar-nav navbar-right">
                        <!-- A v-if on a BUILD-TIME CONSTANT (src/api.mjs), not on
                             a probe's answer. A build made with VUE_APP_API=off
                             never renders a control that would need a server and
                             never asks a server whether it exists. Every other
                             build renders them: the flag defaults to on, because
                             the one deployment this site has always has an API and
                             a forgotten variable must not silently remove the way
                             in. -->
                        <template v-if="apiConfigured">
                            <li><router-link to="/submit">{{ $t("nav.submit") }}</router-link></li>
                            <!-- Nothing is rendered while `unknown` is in flight.
                                 Showing "log in" first and swapping it for a name
                                 a moment later tells a signed-in visitor they are
                                 signed out, which is the one thing this control
                                 exists to get right. -->
                            <li v-if="authState === 'anonymous'">
                                <!-- Today this is /submit as well, because the
                                     verification wizard is the head of that page
                                     and there is no standalone /login. They are
                                     still two controls: one advertises the
                                     feature, the other is for a returning
                                     submitter who only wants their session back
                                     and should not be told to "submit" anything.
                                     The day /login exists, only this one moves. -->
                                <router-link to="/submit">{{ $t("nav.login") }}</router-link>
                            </li>
                            <li v-else-if="authState === 'signed-in'" class="dropdown">
                                <a href="javascript:;" class="dropdown-toggle" data-toggle="dropdown" role="button" aria-haspopup="true" aria-expanded="false">
                                    <span class="sr-only">{{ $t("nav.account") }}</span>
                                    <!-- A VALUE, never a key: the display name is
                                         whatever the submitter is called in the
                                         live room. -->
                                    <span class="account-name" :title="submitter.displayName">{{ submitter.displayName }}</span>
                                    <span class="caret"></span>
                                </a>
                                <ul class="dropdown-menu">
                                    <li><router-link to="/my">{{ $t("nav.myClips") }}</router-link></li>
                                    <!-- Only for a session /api/me reported as an
                                         admin. The requirement was that the desk
                                         APPEARS when the signed-in open_id is one
                                         of the configured ones, and without that
                                         field the site had no way to know — the
                                         owner had to remember the URL.

                                         It is not an access control and does not
                                         pretend to be: the desk is behind
                                         routes/admin.mjs, which answers a stranger
                                         404 whether or not this <li> rendered. All
                                         hiding it buys is that nobody else is shown
                                         a door that is not theirs. -->
                                    <li v-if="submitter.admin"><router-link to="/admin">{{ $t("nav.reviewDesk") }}</router-link></li>
                                    <li role="separator" class="divider"></li>
                                    <li><button type="button" class="dropdown-action" :disabled="loggingOut" @click="logout">{{ $t("nav.logout") }}</button></li>
                                </ul>
                            </li>
                        </template>
                        <li class="dropdown">
                            <a href="javascript:;" class="dropdown-toggle" data-toggle="dropdown" role="button" aria-haspopup="true" aria-expanded="false">{{$t("info.lang")}} <country-flag :country=changeFlag size='small'/> {{$t("lang." + currentLang)}} <span class="caret"></span></a>
                            <ul class="dropdown-menu">
                                <li><a href="javascript:;" @click="chlang('zh-CN')"><country-flag country="cn" size='small'/> {{$t("lang.zh-CN")}}</a></li>
                                <li><a href="javascript:;" @click="chlang('en-US')"><country-flag country="us" size='small'/> {{$t("lang.en-US")}}</a></li>
                                <li><a href="javascript:;" @click="chlang('ja-JP')"><country-flag country="jp" size='small'/> {{$t("lang.ja-JP")}}</a></li>
                            </ul>
                        </li>
                    </ul>
                </div>

            </div>
        </nav>
        <div class="container-fluid main-content">
            <router-view></router-view>
        </div>
        <!-- The player lives here, OUTSIDE <router-view>, on purpose. It used to
             be inside home.vue, where a second route would destroy it: the audio
             element goes with the component, so navigating away cut playback mid
             clip and reset volume/loop/overlap. There is no <keep-alive> in this
             app and adding one would only have hidden the coupling. An app-level
             player is also what lets a future page (the review desk) preview a
             clip without owning a second one. -->
        <audio ref="player" id="player" @ended="onPlayerEnded"></audio>
        <footer class="footer">
            <div class="container-fluid footer-content">
                <div class="pull-right">
                    <!-- This line replaced "participate in translation, add audio
                         (also accept mp3 files by mail to <a personal address>),
                         or make suggestions on Github". Three separate rulings
                         retired it: submissions go through the database rather
                         than a pull request, the community translation channel
                         is dropped (translation stays manual and in-house), and
                         a personal email address does not belong on a public
                         page. What is left is the one thing the sentence was
                         really for — telling a visitor with a clip where to
                         put it — and it points at the page that now exists.

                         Guarded by the same build-time constant as the navbar
                         group: a VUE_APP_API=off build has no submit page, and
                         inviting someone to a route that redirects home is
                         worse than saying nothing. -->
                    <div class="text-right" v-if="apiConfigured"><router-link to="/submit">{{$t("info.footerSubmit")}}</router-link></div>
                    <!-- The badge counts stars on ryanlan-new/joi-button. It used
                         to count monoai/luna-button — the upstream this was
                         forked from — so the number shown was somebody else's. -->
                    <div class="text-right"><a href="https://github.com/ryanlan-new/joi-button" target="_blank">{{$t("info.toGithub")}} <img src="https://img.shields.io/github/stars/ryanlan-new/joi-button.svg?style=social"/></a></div>
                    <div class="text-right">{{$t("info.notOfficial")}}</div>
                </div>
                <!--<div><p>Me testing out something</p></div>-->
            </div>
        </footer>
    </div>
</template>

<style lang="scss">
@import "../node_modules/bootstrap/dist/css/bootstrap.css";
@import url('https://fonts.googleapis.com/css2?family=Mina&family=Open+Sans:wght@600&family=PT+Sans&family=Source+Sans+Pro&family=M+PLUS+Rounded+1c:wght@700&display=swap');

/* Palette. The five hues the site has always had are unchanged; what changed is
   which ROLE each one plays. The pastels used to be text colours on white, where
   they measured 2.75:1 (every voice button at rest), 1.66:1 (hover) and 1.59:1
   (focus) — perceived as "purple-ish" rather than read. They are now FILLS, with
   two new dark values, same hues, carrying the text.

   Every ratio below is measured against the surface the colour actually sits on.
   Nothing on this site qualifies for WCAG's large-text 3:1 allowance: Bootstrap's
   .btn is 14px normal, .navbar-brand 18px normal, .cate-header 20px normal. So
   text is held to 4.5:1 and non-text UI (borders, focus rings) to 3:1.

   --candy-red is pinned at #dd2e44 and must not be darkened "for margin": at
   #cf2338 the focus ring's contrast against the button border drops 3.08 -> 2.68
   and fails. It is the value that makes the whole system close. */
:root{
    --cream:      #fedcae;  /* page fill                                   */
    --amber:      #ffa703;  /* navbar fill                                 */
    --amber-deep: #f7ac67;  /* footer fill                                 */
    --candy-red:  #dd2e44;  /* borders, section headers, pressed/playing   */
    --pink:       #fdb3d8;  /* hover FILL      (was hover ink)             */
    --blue:       #91d7f1;  /* focus FILL      (was focus ink)             */
    --lilac:      #bf8ac2;  /* mode-engaged FILL (was the resting ink)     */
    --plum-700:   #6f2f74;  /* ink on white 8.99:1 — same hue as --lilac   */
    --plum-900:   #3f1c45;  /* ink on --lilac 5.21:1                       */
    --cocoa-700:  #4a2e00;  /* ink on --amber 6.41:1 / on --amber-deep 6.57*/
    --cocoa-900:  #3d2600;  /* focus ring                                  */
    --candy-red-line: #ff546d;  /* the header's lighter outline            */
    --surface:    #ffffff;  /* card / button fill                          */
    --surface-alt:#f5f5f5;  /* menu hover fill                             */
    --track:      #d3d3d3;  /* slider track (decorative, see the gate)     */
    /* --content-bg is intentionally UNSET: the default is transparent so the
       page background shows through, and the theme editor sets it opaque. */
}
body{
    padding-top: 70px;
    /* Resolved by webpack, so the emitted URL follows publicPath instead of
       hardcoding the GitHub Pages subpath. The file moved out of public/ for
       exactly this reason: files copied verbatim from public/ cannot be
       rewritten, and a root-relative url() in a .vue style block is left
       untouched by css-loader. */
    background-image: url('~@/assets/body_bg.svg');
    font-family: 'Aptos', sans-serif;
    background-color: var(--cream);
}
.navbar-brand {
    font-family: 'Aptos', sans-serif;
}
/* ONE MIDLINE ACROSS THE WHOLE BAR.
   Three separate things were pulling the row apart, and each needed its own fix.

   1. Bootstrap 3 ships `.navbar-brand > img { display: block }` so a logo can
      fill the brand box on its own. The mark here sits BESIDE the wordmark, and
      a block image put them on two stacked lines — the icon above, the site name
      below, which is what this looked like in production.
   2. `vertical-align: middle` (what the two icons used to carry inline) aligns to
      the TEXT's middle, and the brand is 18px while the links are 14px, so the
      two icons landed on midlines 2.4px apart. align-items does what that was
      reaching for: it centres on the row, not on a font.
   3. The items were 50px tall inside a 55px bar, so the whole row sat 2.5px high
      of centre. Giving each item the bar's own height makes "centred in the item"
      and "centred in the bar" the same line.

   The spacing below is MARGINS rather than flex `gap`, and that is a browser
   decision, not a taste one: this project's browserslist still resolves to IE
   10/11, Opera Mini and KaiOS 2.5. Autoprefixer gives those the -ms- flexbox
   they need (the built CSS carries `-ms-flexbox`), but nothing can polyfill
   `gap` — so with gap those browsers would lay the row out correctly and then
   render it with NO spacing at all: the icon welded to the wordmark and
   `语言:🇨🇳简体中文`. Margins work wherever flex does.

   They are needed at all because a flex container drops whitespace-only
   children, and the ordinary spaces that used to separate the language toggle's
   label, flag and value are exactly that. The two icons carried `&nbsp;` for the
   same job; those are gone from the markup, so spacing is declared here instead
   of being punctuation in a template.

   `display: inline-block` on the brand image is the IE10-without-flex fallback:
   if the flex declaration is ever ignored, the image still sits beside the
   wordmark instead of stacking above it, which is Bootstrap's default. */
.navbar-brand,
.navbar-default .navbar-nav > li > a{
    display: flex;
    align-items: center;
}
.navbar-brand > img{
    display: inline-block;
}
.navbar-brand > img,
.navbar-default .navbar-nav > li > a > img{
    margin-right: .4em;
}
.navbar-default .navbar-nav > li > a > .flag{
    margin: 0 .3em;
}
.navbar-default .navbar-nav > li > a > .caret{
    margin-left: .4em;
}
/* Only where the bar is a ROW. Below 768px Bootstrap stacks these inside the
   hamburger, where a fixed 55px per item would just make the menu taller. */
@media (min-width: 768px){
    .navbar-brand,
    .navbar-default .navbar-nav > li > a{
        height: 55px;                   /* = .navbar's min-height below */
        padding-top: 0;
        padding-bottom: 0;
    }
}
/* `> li > a`, never a descendant selector: the language dropdown's items are
   `.dropdown-menu > li > a` INSIDE `ul.nav.navbar-nav`, so `.nav.navbar-nav li a`
   also painted them white — on a white panel, i.e. 1.00:1 and unreadable at
   desktop widths. The `.navbar-default` prefix is load-bearing too: without it
   this rule is (0,1,2) and loses to Bootstrap's own
   `.navbar-default .navbar-nav > li > a { color:#777 }` at (0,2,2). */
.navbar-default .navbar-nav > li > a, .navbar-default .navbar-brand{
    /* Owner ruling: keep the orange, change the lettering. There is no amber
       that carries both white and dark text — the crossover near #c07e04 gives
       white 3.37 and cocoa 3.70, both failing — so white-with-a-black-outline
       was not rescuable. WCAG gives a 1px outline no credit anyway, and on CJK
       glyphs the four shadows clog the counters. */
    color: var(--cocoa-700);            /* 6.41:1 on --amber */
    text-shadow: none;
}
.navbar-default .navbar-brand:hover,
.navbar-default .navbar-nav > li > a:hover{
    color: var(--cocoa-700);
    background-color: var(--cream);     /* 9.55:1 */
    border-bottom: 2px solid var(--plum-700);
}
.navbar-default .navbar-brand:focus,
.navbar-default .navbar-nav > li > a:focus{
    color: var(--cocoa-700);
    background-color: var(--cream);
    outline: 3px solid var(--cocoa-900);
    outline-offset: 2px;
}
/* Bootstrap's own .dropdown-menu rules are (0,2,2) and would silently take over
   these states; declared here so the language menu is designed, not inherited. */
.dropdown-menu > li > a{
    color: var(--cocoa-700);            /* 12.49:1 on white */
}
.dropdown-menu > li > a:hover,
.dropdown-menu > li > a:focus{
    color: var(--cocoa-700);
    background-color: var(--surface-alt);   /* 11.45:1 */
}
/* The account menu's one ACTION.
   Logging out is not a destination, so it is a <button> rather than the
   <a href="javascript:;"> the language items use: an anchor with no href is not
   operable with Space, and it announces itself to a screen reader as a link to
   somewhere. Bootstrap dresses `.dropdown-menu > li > a` and nothing else, so
   the button is given the same metrics here instead of being made to look like a
   menu item by accident. Colours are the ones already measured two rules up. */
.dropdown-menu > li > .dropdown-action{
    display: block;
    width: 100%;
    clear: both;
    padding: 3px 20px;
    font: inherit;
    font-weight: normal;
    line-height: 1.42857143;
    text-align: left;
    white-space: nowrap;
    background: none;
    border: 0;
    color: var(--cocoa-700);                /* 12.49:1 on white */
}
.dropdown-menu > li > .dropdown-action:hover,
.dropdown-menu > li > .dropdown-action:focus{
    color: var(--cocoa-700);
    background-color: var(--surface-alt);   /* 11.45:1 */
}
.dropdown-menu > li > .dropdown-action:focus-visible{
    /* Inset, unlike every other focus ring on the site. This item is 100% of the
       menu's width, so a ring at outline-offset:2px is drawn outside the panel
       and clipped by it — the one place where the site's usual +2 would remove
       the ring instead of separating it. 14.23:1 against the item's own fill,
       13.05:1 against the hover fill — both computed with deploy/contrast-check's
       own formula. Neither pair is IN that gate, because the gate reads a fixed
       list; if the ring token ever moves, these two numbers move silently. */
    outline: 3px solid var(--cocoa-900);
    outline-offset: -3px;
}
/* A real attribute, so the control is genuinely inert while the request is in
   flight rather than looking inert and still firing. */
.dropdown-menu > li > .dropdown-action[disabled]{
    opacity: .8;
    cursor: default;
}
/* A display name is submitter-authored and can be any length. Clipping it keeps
   a 40-character nickname from pushing the language menu off the right edge and
   the brand off the left; the full string stays in the DOM, so a screen reader
   still reads it and the title attribute still shows it. 12em is about twelve
   CJK characters at the navbar's 14px. */
.account-name{
    display: inline-block;
    max-width: 12em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: middle;
}
.navbar {
    min-height: 55px;
}
.navbar-inner{
    background-size: contain;
    background-color: var(--amber);
    background-repeat: repeat-x;
}
.main-content{
    min-height: 100vh;
}
.footer {
    width: 100%;
    height: auto;
    background-color: var(--amber-deep);
    border-top: 3px solid var(--amber-deep);
}
.footer-content {
    padding-top: 10px;
    color: var(--cocoa-700);            /* 6.57:1 on --amber-deep, was #666 at 3.02 */
}
/* Bootstrap paints links #337ab7, which is 2.40:1 on the footer fill — the most
   prominent thing down there and previously unreadable. */
.footer-content a{
    color: var(--cocoa-700);
    text-decoration: underline;
}
.footer-content a:hover{ color: var(--plum-700); }   /* 4.73:1 */
.footer-content a:focus{
    outline: 3px solid var(--cocoa-900);
    outline-offset: 2px;
}

/* ---- shared component idioms -------------------------------------------
   Lifted out of home.vue's SCOPED block so every page can use them. They are
   the site's whole vocabulary: a red section header, a centred row, and a
   pill button with five measured states. */
.cate-header{
    background-color: var(--candy-red);
    color: white;
    /* The old #FF0000 glow measured 1.15:1 against its own fill — a blur in a
       colour indistinguishable from the background, softening the glyph edge.
       White on --candy-red is 4.62:1, the thinnest pass on the site, and that
       figure assumes a crisp edge. */
    border: 2px solid var(--candy-red-line);
    border-radius: 10px;
    text-align: center;
    font-size: 20px;
    margin-bottom: 12px;
}
.cate-body{
    margin-bottom: 12px;
    text-align: center;
}
.cate-body button.btn-info,
.btn-new{
    background-color: var(--surface);
    background-repeat: repeat-x;
    background-size: contain;
    color: var(--plum-700);             /* 8.99:1 on white, was #bf8ac2 at 2.75 */
    border: 3px solid var(--candy-red);
    border-radius: 20px;
    transition-duration: 0.4s;
    margin: 5px;
}
.btn-new {
    max-width: 100%;
    word-wrap: break-word !important;
    word-break: break-all !important;
    white-space: normal !important;
}
/* The pastels moved from ink to FILL. Each state now owns a colour, and each
   pairing is measured: nothing here is decorative-only.
     hover   pink  fill + plum ink   5.40:1
     focus   blue  fill + plum ink   5.65:1  + a real 3px ring
     on      lilac fill + plum-900   5.21:1
     active/playing  red fill + white 4.62:1                                   */
.cate-body button:hover{
    background-color: var(--pink);
    color: var(--plum-700);
    text-shadow: none;
}
/* A mouse click used to leave the button stuck in the focus colour until you
   clicked elsewhere. :focus-visible keeps the ring for keyboards only. */
.cate-body button:focus:not(:focus-visible){
    background-color: white;
    color: var(--plum-700);
    outline: none;
}
.cate-body button:focus-visible{
    background-color: var(--blue);
    color: var(--plum-700);
    text-shadow: none;
    /* outline-offset is load-bearing: at 0 the ring sits on the 3px red border
       and its contrast against it drops below 3:1. Do not "tidy" it away. */
    outline: 3px solid var(--cocoa-900);
    outline-offset: 2px;
}
.cate-body button.is-on{
    background-color: var(--lilac);
    color: var(--plum-900);
}
.cate-body button:active,
.cate-body button.is-playing{
    background-color: var(--candy-red);
    color: white;
}
/* Bootstrap's stock .disabled is opacity .65, which composites to 3.82:1. These
   three are not actually inactive — they stay focusable and clickable and the
   handler early-returns — so the WCAG exemption for inactive components does not
   apply to them. */
/* A real `disabled` attribute now, not a class: the handlers used to early-return
   while the button stayed focusable and clickable, so WCAG's exemption for
   inactive components did not apply and the control lied about its own state. */
.cate-body button[disabled]{
    opacity: .8;
}

/* ---- content backing ----------------------------------------------------
   Text must never depend on a background image for its contrast. Today the
   backing is transparent, so the confetti shows through exactly as before and
   this block is a no-op; when a custom wallpaper can be set, the theme sets
   --content-bg to an opaque colour and every ratio above stays a property of
   the tokens rather than of somebody's photograph. */
.main-content{
    background-color: var(--content-bg, transparent);
}

.text-right{
    text-align: right;
}
</style>

<script>
import Vue from 'vue'
import Component from 'vue-class-component'
// Imported rather than left to vue.config.js's ProvidePlugin. The plugin does
// supply a free `$`, but a free variable is invisible at the top of the file and
// stops working the moment this component is read by anything that is not that
// webpack config. Same module, same instance — main.js does `global.$ = $` from
// this same package before it imports bootstrap, so the .collapse plugin is on
// the object this name resolves to.
import $ from 'jquery'
import { API_ENABLED, apiUrl } from './api.mjs'
import Modal from './components/modal.vue'
import CountryFlag from 'vue-country-flag'
//import fetchpost from './util/fetchpost'

/**
 * Where the API lives, and whether this build may reach it: src/api.mjs owns
 * both, for the whole app.
 *
 * It used to be answered here AND in src/catalog.mjs, from the same environment
 * variable, with two different readings of the empty string — so a deployment
 * that followed catalog.mjs's written instruction got a live catalogue and no
 * way to sign in. One predicate now, in one file, with the argument for a
 * build-time constant (rather than a /health probe on every visit) written out
 * there.
 */

@Component({
    components:{
        Modal,
        CountryFlag
    }
})
class App extends Vue {
    // 'unknown' until /api/me answers. It is a third state and not a default of
    // 'anonymous', because "we have not asked yet" and "you are not signed in"
    // are different facts and the bar must not render the second while it only
    // knows the first. (The server draws the same distinction one level down:
    // routes/public.mjs keeps `room-unreachable` separate from `waiting` so that
    // our side being deaf is never shown as the visitor not having spoken.)
    authState = 'unknown';
    submitter = null;
    loggingOut = false;
    // Editable site branding (STORY-068), or null until /branding.json answers —
    // and it stays null when that file is absent (a deploy with nothing edited),
    // which is why every reader below falls back to a bundled default.
    branding = null;

    get apiConfigured(){
        return API_ENABLED;
    }
    // The navbar title, its icon, and the channel link. Each prefers the edited
    // value for the current language and falls back to the string compiled into
    // the bundle, so a site with no branding.json renders exactly as it shipped.
    get navTitle(){
        const v = this.branding && this.branding.navTitle && this.branding.navTitle[this.currentLang];
        return (typeof v === 'string' && v !== '') ? v : this.$t('info.title');
    }
    get channelLabel(){
        const c = this.branding && this.branding.channel;
        const v = c && c.label && c.label[this.currentLang];
        return (typeof v === 'string' && v !== '') ? v : this.$t('info.yt_channel');
    }
    get channelHref(){
        const c = this.branding && this.branding.channel;
        return (c && typeof c.href === 'string' && c.href !== '') ? c.href : 'https://space.bilibili.com/61639371';
    }
    get brandIconUrl(){
        // The little mark before the title is the site's OWN favicon: the custom
        // one an admin uploaded, otherwise the one index.html declares. It used
        // to fall back to bili_favicon.ico — the bilibili logo — which is the
        // mark of the platform the streamer is on, not of this site, and it sat
        // next to the site's name claiming to be it.
        if (this.branding && this.branding.faviconPath) return '/branding/' + this.branding.faviconPath;
        return 'resources/favicon/favicon.png';
    }
    get currentLang(){
        return this.$i18n.locale;
    }
    get changeFlag(){
        if(this.currentLang == 'en-US') {
            return 'us';
        } else if (this.currentLang == 'ja-JP'){
            return 'jp';
        } else if (this.currentLang == 'zh-CN'){
            return 'cn';
        } else {
            return 'cn';
        }
    }
    created(){
        //eslint-disable-next-line
        console.log("Um?");
        this.$i18n.locale = localStorage.getItem("lang") || this.$i18n.locale;
        // Set on the instance rather than declared as a class field: Vue treats
        // a leading underscore as reserved and will not proxy such a key from
        // _data onto the component, so a field named this way is silently
        // undefined. The player's handlers below are assigned for the same
        // reason — none of this wants to be reactive.
        this._identityTicket = 0;
        // The <title> the bundle shipped (index.html's trilingual default),
        // captured before any branding is applied. applyBranding restores it when
        // the current language has no custom docTitle, so switching to a language
        // with an empty docTitle cannot strand the previous language's title.
        this._defaultDocTitle = (typeof document !== 'undefined') ? document.title : '';
        if (API_ENABLED) this.refreshIdentity();
        this.loadBranding();
    }
    chlang(v){
        this.$i18n.locale = v;
        localStorage.setItem("lang", v);
        // navTitle/channelLabel are computed and re-render on their own; the
        // document <title> is not reactive, so re-apply it for the new language.
        this.applyBranding();
    }
    async loadBranding(){
        // Served by nginx at a fixed root path (location = /branding.json). A 404
        // is the normal "nothing edited yet" answer and simply leaves the bundle
        // defaults in place; a parse or network failure does the same.
        try {
            const res = await fetch('/branding.json', { credentials: 'same-origin' });
            if (!res.ok) return;
            this.branding = await res.json();
            this.applyBranding();
        } catch (ignored) {
            // keep the compiled-in defaults
        }
    }
    applyBranding(){
        if (typeof document === 'undefined') return;
        const b = this.branding;
        if (!b) return;
        const dt = b.docTitle && b.docTitle[this.currentLang];
        // Empty for this language means "use the bundle default", so put the
        // captured default back rather than leaving whatever a previous language
        // set — otherwise zh→en with only zh filled keeps the zh title in the tab.
        if (typeof dt === 'string' && dt !== '') document.title = dt;
        else if (this._defaultDocTitle) document.title = this._defaultDocTitle;
        if (b.faviconPath) {
            const href = '/branding/' + b.faviconPath;
            const links = document.querySelectorAll(
                'link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"]',
            );
            links.forEach((el) => el.setAttribute('href', href));
        }
    }
    mounted(){
        // A tiny protocol rather than a shared ref: pages decide WHAT to play and
        // when a clip ending should chain into the next one; this component owns
        // only the media element.
        const bus = this.$gConst.globalbus;
        this._onPlay = ({ src, volume }) => {
            const p = this.$refs.player;
            if (typeof volume === 'number') p.volume = volume;
            p.src = src;
            p.play();
        };
        this._onStop = () => { this.$refs.player.pause(); };
        this._onReplay = () => { this.$refs.player.play(); };
        this._onVolume = (v) => { this.$refs.player.volume = v; };
        bus.$on('player:play', this._onPlay);
        bus.$on('player:stop', this._onStop);
        bus.$on('player:replay', this._onReplay);
        bus.$on('player:volume', this._onVolume);
        // Kept for compatibility with the original 'play' event name.
        bus.$on('play', this._onPlay);

        // The other half of the identity protocol, and the only thing another
        // page has to know: after anything that changes the session — a
        // verification that completed, a logout somewhere else — emit
        // 'auth:changed'. The bar then RE-READS /api/me. It is deliberately not
        // an event that carries the new identity: a page cannot hand this
        // component a name the server would not confirm.
        this._onAuthChanged = () => { if (API_ENABLED) this.refreshIdentity(); };
        bus.$on('auth:changed', this._onAuthChanged);

        // Two things that are not bugs today and both become bugs the moment a
        // second route exists.
        this._removeAfterEach = this.$router.afterEach((to, from) => {
            // Below 768px every one of these controls is inside the collapse,
            // and nothing in Bootstrap closes it when the page underneath
            // changes: you tap "submit", the route swaps, and the menu is still
            // hanging open over a page you cannot see. hide() returns early
            // when the element does not carry `in`, so at desktop widths — and
            // on the very first navigation, before the plugin has ever been
            // instantiated — this costs nothing and cannot toggle it open.
            $('#bs-navbar-collapse').collapse('hide');
            // Nothing here scrolls. Landing mid-page after a navigation is real,
            // but the fix is scrollBehavior in router.js, which is the only place
            // that receives `savedPosition` and can therefore tell a link click
            // from a Back button; doing it here would clobber the browser's own
            // restore on every Back. Recorded for whoever writes it: a scroll to
            // a specific element must target `el.offsetTop - 80`, because body
            // carries padding-top:70px against a 55px fixed bar, so a naive
            // scroll to offsetTop puts the target under the navbar.
            if (API_ENABLED && to.path !== from.path) this.refreshIdentity();
        });
    }
    beforeDestroy(){
        const bus = this.$gConst.globalbus;
        bus.$off('player:play', this._onPlay);
        bus.$off('player:stop', this._onStop);
        bus.$off('player:replay', this._onReplay);
        bus.$off('player:volume', this._onVolume);
        bus.$off('play', this._onPlay);
        bus.$off('auth:changed', this._onAuthChanged);
        // afterEach returns its own remover in vue-router 3. This component is
        // the app shell and is never destroyed in practice, but a hook that
        // outlives its closure is exactly the leak the player just moved here to
        // stop having.
        if (this._removeAfterEach) this._removeAfterEach();
    }
    onPlayerEnded(){
        // The payload exists for the review desk's listen-before-approve gate.
        //
        // A truncated file on the shared volume does NOT fail to fire `ended` —
        // it fires it EARLY, at whatever length the browser managed to decode.
        // Measured against this repo's own media: the whole file ends at 18.49s,
        // and the same bytes cut to 35% end at 6.22s, with `ended` in both
        // cases. So an `ended` on its own says "playback stopped", not "the clip
        // was heard", and a gate that reads it as the latter opens after a third
        // of the audio — which is the one thing that gate exists to prevent.
        //
        // What the listener needs is what the element actually played, so it can
        // compare that against the length recorded in the database when the file
        // was accepted. Both numbers travel; ClipAudition decides.
        const p = this.$refs.player;
        this.$gConst.globalbus.$emit('player:ended', p === undefined || p === null
            ? null
            : { currentTime: p.currentTime, duration: p.duration });
    }

    /**
     * Ask the server who this browser is. GET /api/me answers
     * { submitter: null } or { submitter: { displayName, … } } — see
     * server/routes/public.mjs — and never 401s, so an anonymous visitor is a
     * 200 with a null, not an error.
     */
    refreshIdentity(){
        // Two navigations in quick succession are two GETs, and the slower one
        // must not land on top of the newer answer. Falsifiable: without the
        // ticket, log out and immediately navigate, and the in-flight reply from
        // before the logout restores the name.
        const ticket = ++this._identityTicket;
        const stale = () => ticket !== this._identityTicket;
        fetch(apiUrl('/api/me'), {
            // The session cookie is HttpOnly, host-only and SameSite=Lax
            // (server/app.mjs), so it can only travel to this same origin — which
            // is where apiUrl() points, by construction. Asking for credentials
            // explicitly is what would turn a future cross-origin deployment into
            // a visible failure instead of a permanently anonymous site.
            credentials: 'include',
            headers: { 'Accept': 'application/json' },
        })
            .then((response) => (response.ok ? response.json() : null))
            .then((body) => {
                if (stale()) return;
                const submitter = body === null ? null : (body.submitter || null);
                this.submitter = submitter;
                this.authState = submitter === null ? 'anonymous' : 'signed-in';
            })
            .catch(() => {
                if (stale()) return;
                // The API is unreachable, which is not the same as being signed
                // out — so this falls back to rendering a way IN rather than a
                // claim about the visitor. "Log in" is a control; "you are not
                // signed in" would be a statement we cannot support.
                this.submitter = null;
                this.authState = 'anonymous';
            });
    }

    logout(){
        if (this.loggingOut) return;
        this.loggingOut = true;
        fetch(apiUrl('/api/logout'), { method: 'POST', credentials: 'include' })
            .then((response) => {
                this.loggingOut = false;
                if (!response.ok) {
                    // The server did not confirm, so the cookie may well still be
                    // live. Showing "log in" now would be the dangerous direction
                    // — someone on a shared machine walking away from a session
                    // that is still open is the entire reason this control
                    // exists. Re-read instead of asserting.
                    this.refreshIdentity();
                    return;
                }
                this.submitter = null;
                this.authState = 'anonymous';
                // For every other page holding session-derived state — and for
                // this one: the listener in mounted() turns this into a second
                // /api/me, which is how the logout gets confirmed rather than
                // assumed.
                this.$gConst.globalbus.$emit('auth:changed');
                // /my and /submit both require identity. Staying put would leave
                // the visitor on a page whose next request is a 401. The guard is
                // not decoration: vue-router 3 rejects a push to the route you
                // are already on, and an unhandled rejection is what that looks
                // like from the home page.
                if (this.$route.path !== '/') this.$router.push('/');
            })
            .catch(() => {
                this.loggingOut = false;
                this.refreshIdentity();
            });
    }
}

export default App;
</script>
