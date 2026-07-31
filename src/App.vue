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
                    <router-link class="navbar-brand" to="/">{{ $t("info.title") }}</router-link>
                </div>

                <div class="collapse navbar-collapse" id="bs-navbar-collapse">
                    <ul class="nav navbar-nav">
                        <li><a href="https://space.bilibili.com/61639371" target="_blank"><img src="resources/bili_favicon.ico" height="18" style="vertical-align:middle"/>&nbsp;&nbsp;{{$t("info.yt_channel")}}</a></li>
                    </ul>
                    <ul class="nav navbar-nav navbar-right">
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
        <footer class="footer">
            <div class="container-fluid footer-content">
                <div class="pull-right">
                    <div class="text-right"><a href="https://github.com/ryanlan-new/joi-button" target="_blank">{{$t("info.toGithub")}} <img src="https://img.shields.io/github/stars/monoai/luna-button.svg?style=social"/></a></div>
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
.cate-body button.disabled{
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
import Modal from './components/modal.vue'
import CountryFlag from 'vue-country-flag'
//import fetchpost from './util/fetchpost'

@Component({
    components:{
        Modal,
        CountryFlag
    }
})
class App extends Vue {
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
    }
    chlang(v){
        this.$i18n.locale = v;
        localStorage.setItem("lang", v);
    }
}

export default App;
</script>
