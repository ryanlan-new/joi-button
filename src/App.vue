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
                <div>{{$t("info.tlHelpers")}}</div>
                <!--<div><p>Me testing out something</p></div>-->
            </div>
        </footer>
    </div>
</template>

<style lang="scss">
@import "../node_modules/bootstrap/dist/css/bootstrap.css";
@import url('https://fonts.googleapis.com/css2?family=Mina&family=Open+Sans:wght@600&family=PT+Sans&family=Source+Sans+Pro&family=M+PLUS+Rounded+1c:wght@700&display=swap');
body{
    padding-top: 70px;
    background-image: url('/resources/body_bg.svg');
    font-family: 'Aptos', sans-serif;
    background-color: #fedcae;
}
.navbar-brand {
    font-family: 'Aptos', sans-serif;
}
.nav.navbar-nav li a, .navbar-default .navbar-brand{
    color: white;
    text-shadow: -1px 1px 0 #000,
                  1px 1px 0 #000,
                  1px -1px 0 #000,
                  -1px -1px 0 #000;
}
.navbar-default .navbar-brand:hover{
    color: #fedcae;
}
.navbar-default .navbar-brand:focus{
    color: #f7ac67;
}
.nav.navbar-nav li a:hover{
    color: #c07e04;
}
.nav.navbar-nav li a:active,
.nav.navbar-nav li a:focus,
.nav.navbar-nav.navbar-right li a:focus{
    color: #ffa654;
}
.nav a:hover{
    border-bottom: 2px solid #998ede;
}
.navbar {
    min-height: 55px;
}
.navbar-inner{
    background-size: contain;
    background-color: #ffa703;
    background-repeat: repeat-x;
}
.main-content{
    min-height: 100vh;
}
.footer {
    width: 100%;
    height: auto;
    background-color: #f7ac67;
    border-top: 3px solid #f7ac67;
}
.footer-content {
    padding-top: 10px;
    color: #666;
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
            return 'ph';
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
    linkClick(){
        // NOTE: Consider using Vuex instead of an event bus.
        this.$gConst.globalbus.$emit('play', {
            src: "voices/GR_OniiChan.mp3",
        })

        //eslint-disable-next-line
        console.log("Thank you to the community for being supportive and helpful!");
        //eslint-disable-next-line
        console.log("Thank you to the community for being supportive and helpful!");
    }
}

export default App;
</script>
