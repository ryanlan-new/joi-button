(function(t){function e(e){for(var o,c,r=e[0],l=e[1],s=e[2],p=0,v=[];p<r.length;p++)c=r[p],Object.prototype.hasOwnProperty.call(n,c)&&n[c]&&v.push(n[c][0]),n[c]=0;for(o in l)Object.prototype.hasOwnProperty.call(l,o)&&(t[o]=l[o]);u&&u(e);while(v.length)v.shift()();return i.push.apply(i,s||[]),a()}function a(){for(var t,e=0;e<i.length;e++){for(var a=i[e],o=!0,r=1;r<a.length;r++){var l=a[r];0!==n[l]&&(o=!1)}o&&(i.splice(e--,1),t=c(c.s=a[0]))}return t}var o={},n={app:0},i=[];function c(e){if(o[e])return o[e].exports;var a=o[e]={i:e,l:!1,exports:{}};return t[e].call(a.exports,a,a.exports,c),a.l=!0,a.exports}c.m=t,c.c=o,c.d=function(t,e,a){c.o(t,e)||Object.defineProperty(t,e,{enumerable:!0,get:a})},c.r=function(t){"undefined"!==typeof Symbol&&Symbol.toStringTag&&Object.defineProperty(t,Symbol.toStringTag,{value:"Module"}),Object.defineProperty(t,"__esModule",{value:!0})},c.t=function(t,e){if(1&e&&(t=c(t)),8&e)return t;if(4&e&&"object"===typeof t&&t&&t.__esModule)return t;var a=Object.create(null);if(c.r(a),Object.defineProperty(a,"default",{enumerable:!0,value:t}),2&e&&"string"!=typeof t)for(var o in t)c.d(a,o,function(e){return t[e]}.bind(null,o));return a},c.n=function(t){var e=t&&t.__esModule?function(){return t["default"]}:function(){return t};return c.d(e,"a",e),e},c.o=function(t,e){return Object.prototype.hasOwnProperty.call(t,e)},c.p="/joi-button/";var r=window["webpackJsonp"]=window["webpackJsonp"]||[],l=r.push.bind(r);r.push=e,r=r.slice();for(var s=0;s<r.length;s++)e(r[s]);var u=l;i.push([0,"chunk-vendors"]),a()})({0:function(t,e,a){t.exports=a("56d7")},1564:function(t,e,a){"use strict";var o={info:{title:"Joiボタン",info:"お知らせ",null:"空",tlHelpers:"翻訳ヘルパー: こーでー, Uchan, Admiy02",toGithub:"Githubで翻訳に参加、音声を追加または提案をしてください。",notOfficial:"このサイトはファン作品であり、公式とは関係ありません。",overlapTips:"多重再生モードは手動で停止できません。再読み込みで停止して下さい。",loopTips:"選択したトラックをループします。他の2つの機能はループがオフになるまで無効になります。",yt_channel:"@轴伊Joi_Channel",lang:"言語: "},action:{toggleNavbar:"ナビゲーションバーを切り替える",close:"閉じる",copy:"コピー",control:"コントロール",stopvoice:"再生停止",randomplay:"ランダム",overlap:"多重再生",autoplay:"連続再生",loop:"ループ再生",playing:"再生中：",noplay:"再生なし",volume:"ボリューム: "},lang:{"zh-CN":"简体中文","en-US":"English","ja-JP":"日本語"}};e["a"]=o},2354:function(t,e,a){},"296e":function(t,e,a){"use strict";var o={info:{title:"Joi Button",info:"Information",null:"Empty",tlHelpers:"Translation Helpers: こーでー, Uchan, Admiy02",toGithub:"Please participate in translation, add audio (also accept mp3 files by mail to ryan.lan_home@outlook.com), or make suggestions on Github:",notOfficial:"This site is a fan work and is not associated with the official VirtuaReal or Nijisanji (AnyColor).",overlapTips:"Overlapping play can't be stopped and creates a lot of playback, better refresh when you've had enough of it",loopTips:"This will loop your selected track, since it'll play forever, the two other functionalities are useless and will be disabled until loop is turned off",yt_channel:"Joi's Channel",lang:"Language: "},action:{toggleNavbar:"Toggle navigation bar",close:"close",copy:"copy",control:"Player control",stopvoice:"Stop current voice",randomplay:"Play a random clip",overlap:"Allow sound to overlap",autoplay:"Autoplay",loop:"Loop",playing:"Now Playing：",noplay:"Nothing playing.",volume:"Volume: "},lang:{"zh-CN":"简体中文","en-US":"English","ja-JP":"日本語"}};e["a"]=o},"2f6e":function(t,e,a){"use strict";var o={info:{title:"轴伊按钮",info:"信息",null:"空",audioStaff:"音频剪辑: ",toGithub:"请在Github参与翻译、增补音频或提出建议，或直接发送音声mp3文件到邮箱ryan.lan_home@outlook.com",notOfficial:"本站为爱好者作品，和VirtuaReal/Nijisanji (Anycolor) 官方没有关联",overlapTips:"重叠播放无法暂停，而且会创建大量线程，玩够了最好刷新一下"},action:{toggleNavbar:"切换导航栏",close:"关闭",copy:"复制",control:"操作控制",stopvoice:"停止",randomplay:"帮我选一个",overlap:"允许声音重叠",autoplay:"播放不要停下来",playing:"正在播放：",noplay:"暂无播放"},lang:{"zh-CN":"简体中文","en-US":"English","ja-JP":"日本語"}};e["a"]=o},3728:function(t,e,a){"use strict";a("aef4")},"3dfd":function(t,e,a){"use strict";var o,n=function(){var t=this,e=t._self._c;return e("div",{attrs:{id:"app"}},[e("Modal"),e("nav",{staticClass:"navbar navbar-default navbar-fixed-top navbar-inner"},[e("div",{staticClass:"container-fluid"},[e("div",{staticClass:"navbar-header"},[e("button",{staticClass:"navbar-toggle collapsed",attrs:{type:"button","data-toggle":"collapse","data-target":"#bs-navbar-collapse","aria-expanded":"false"}},[e("span",{staticClass:"sr-only"},[t._v(t._s(t.$t("action.toggleNavbar")))]),e("span",{staticClass:"icon-bar"}),e("span",{staticClass:"icon-bar"}),e("span",{staticClass:"icon-bar"})]),e("router-link",{staticClass:"navbar-brand",attrs:{to:"/"}},[t._v(t._s(t.$t("info.title")))])],1),e("div",{staticClass:"collapse navbar-collapse",attrs:{id:"bs-navbar-collapse"}},[e("ul",{staticClass:"nav navbar-nav"},[e("li",[e("a",{attrs:{href:"https://space.bilibili.com/61639371",target:"_blank"}},[e("img",{staticStyle:{"vertical-align":"middle"},attrs:{src:"resources/bili_favicon.ico",height:"18"}}),t._v("  "+t._s(t.$t("info.yt_channel")))])])]),e("ul",{staticClass:"nav navbar-nav navbar-right"},[e("li",{staticClass:"dropdown"},[e("a",{staticClass:"dropdown-toggle",attrs:{href:"javascript:;","data-toggle":"dropdown",role:"button","aria-haspopup":"true","aria-expanded":"false"}},[t._v(t._s(t.$t("info.lang"))+" "),e("country-flag",{attrs:{country:t.changeFlag,size:"small"}}),t._v(" "+t._s(t.$t("lang."+t.currentLang))+" "),e("span",{staticClass:"caret"})],1),e("ul",{staticClass:"dropdown-menu"},[e("li",[e("a",{attrs:{href:"javascript:;"},on:{click:function(e){return t.chlang("zh-CN")}}},[e("country-flag",{attrs:{country:"cn",size:"small"}}),t._v(" "+t._s(t.$t("lang.zh-CN")))],1)]),e("li",[e("a",{attrs:{href:"javascript:;"},on:{click:function(e){return t.chlang("en-US")}}},[e("country-flag",{attrs:{country:"us",size:"small"}}),t._v(" "+t._s(t.$t("lang.en-US")))],1)]),e("li",[e("a",{attrs:{href:"javascript:;"},on:{click:function(e){return t.chlang("ja-JP")}}},[e("country-flag",{attrs:{country:"jp",size:"small"}}),t._v(" "+t._s(t.$t("lang.ja-JP")))],1)])])])])])])]),e("div",{staticClass:"container-fluid main-content"},[e("router-view")],1),e("footer",{staticClass:"footer"},[e("div",{staticClass:"container-fluid footer-content"},[e("div",{staticClass:"pull-right"},[e("div",{staticClass:"text-right"},[e("a",{attrs:{href:"https://github.com/ryanlan-new/joi-button",target:"_blank"}},[t._v(t._s(t.$t("info.toGithub"))+" "),e("img",{attrs:{src:"https://img.shields.io/github/stars/monoai/luna-button.svg?style=social"}})])]),e("div",{staticClass:"text-right"},[t._v(t._s(t.$t("info.notOfficial")))])]),e("div",[t._v(t._s(t.$t("info.tlHelpers")))])])])],1)},i=[],c=(a("2397"),a("d225")),r=a("b0b4"),l=a("308d"),s=a("6bb5"),u=a("4e2b"),p=a("2b0e"),v=a("65d9"),d=a.n(v),h=function(){var t=this,e=t._self._c;return e("div",{staticClass:"modal fade",attrs:{id:"myModal",tabindex:"-1",role:"dialog","aria-labelledby":"myModalLabel"}},[e("div",{staticClass:"modal-dialog",attrs:{role:"document"}},[e("div",{staticClass:"modal-content"},[e("div",{staticClass:"modal-header"},[t._m(0),e("h4",{staticClass:"modal-title",attrs:{id:"myModalLabel"}},[t._v(t._s(t.$t(t.title)))])]),e("div",{staticClass:"modal-body"},[t._v(" "+t._s(t.$t(t.msg))+" ")]),e("div",{staticClass:"modal-footer"},[e("button",{staticClass:"btn btn-default",attrs:{type:"button","data-dismiss":"modal"}},[t._v(t._s(t.$t("action.close")))])])])])])},f=[function(){var t=this,e=t._self._c;return e("button",{staticClass:"close",attrs:{type:"button","data-dismiss":"modal","aria-label":"Close"}},[e("span",{attrs:{"aria-hidden":"true"}},[t._v("×")])])}],y=a("bd86"),b=a("1157"),g=a.n(b);function m(t,e,a){return e=Object(s["a"])(e),Object(l["a"])(t,C()?Reflect.construct(e,a||[],Object(s["a"])(t).constructor):e.apply(t,a))}function C(){try{var t=!Boolean.prototype.valueOf.call(Reflect.construct(Boolean,[],(function(){})))}catch(t){}return(C=function(){return!!t})()}var k,_,j=d()(o=function(t){function e(){var t;Object(c["a"])(this,e);for(var a=arguments.length,o=new Array(a),n=0;n<a;n++)o[n]=arguments[n];return t=m(this,e,[].concat(o)),Object(y["a"])(t,"title","info.info"),Object(y["a"])(t,"msg","info.null"),t}return Object(u["a"])(e,t),Object(r["a"])(e,[{key:"created",value:function(){var t=this;this.$gConst.globalbus.$on("send-info",(function(e){t.msg=e,t.showModal()}))}},{key:"showModal",value:function(){g()("#myModal").modal()}}])}(p["default"]))||o,O=j,$=O,w=(a("9538"),a("0c7c")),N=Object(w["a"])($,h,f,!1,null,null,null),P=N.exports,S=a("eea2");function A(t,e,a){return e=Object(s["a"])(e),Object(l["a"])(t,x()?Reflect.construct(e,a||[],Object(s["a"])(t).constructor):e.apply(t,a))}function x(){try{var t=!Boolean.prototype.valueOf.call(Reflect.construct(Boolean,[],(function(){})))}catch(t){}return(x=function(){return!!t})()}var J=(k=d()({components:{Modal:P,CountryFlag:S["a"]}}),k(_=function(t){function e(){return Object(c["a"])(this,e),A(this,e,arguments)}return Object(u["a"])(e,t),Object(r["a"])(e,[{key:"currentLang",get:function(){return this.$i18n.locale}},{key:"changeFlag",get:function(){return"en-US"==this.currentLang?"us":"ja-JP"==this.currentLang?"jp":"zh-CN"==this.currentLang?"cn":"us"}},{key:"created",value:function(){console.log("Um?"),this.$i18n.locale=localStorage.getItem("lang")||this.$i18n.locale}},{key:"chlang",value:function(t){this.$i18n.locale=t,localStorage.setItem("lang",t)}},{key:"linkClick",value:function(){this.$gConst.globalbus.$emit("play",{src:"voices/GR_OniiChan.mp3"}),console.log("Thank you to the community for being supportive and helpful!"),console.log("Thank you to the community for being supportive and helpful!")}}])}(p["default"]))||_),z=J,U=z,T=(a("73c5"),Object(w["a"])(U,n,i,!1,null,null,null));e["a"]=T.exports},"41cb":function(t,e,a){"use strict";var o,n,i=a("2b0e"),c=a("8c4f"),r=(a("7f7f"),function(){var t=this,e=t._self._c;return e("div",{staticClass:"container-fluid"},[e("div",[e("div",{staticClass:"cate-header"},[t._v(t._s(t.$t("action.control")))]),e("div",{staticClass:"cate-body"},[e("button",{staticClass:"btn btn-info",on:{click:t.random}},[t._v(t._s(t.$t("action.randomplay")))]),e("button",{staticClass:"btn btn-info",on:{click:t.stopPlay}},[t._v(t._s(t.$t("action.stopvoice")))]),e("button",{staticClass:"btn btn-info",class:{disabled:t.autoCheck||t.loopCheck},attrs:{title:t.$t("info.overlapTips")},on:{click:t.overlap}},[e("input",{directives:[{name:"model",rawName:"v-model",value:t.overlapCheck,expression:"overlapCheck"}],staticClass:"checkbox",attrs:{type:"checkbox",onchange:"this.checked = this.parentNode.disabled"},domProps:{checked:Array.isArray(t.overlapCheck)?t._i(t.overlapCheck,null)>-1:t.overlapCheck},on:{change:function(e){var a=t.overlapCheck,o=e.target,n=!!o.checked;if(Array.isArray(a)){var i=null,c=t._i(a,i);o.checked?c<0&&(t.overlapCheck=a.concat([i])):c>-1&&(t.overlapCheck=a.slice(0,c).concat(a.slice(c+1)))}else t.overlapCheck=n}}}),e("span",[t._v(t._s(t.$t("action.overlap")))])]),e("button",{staticClass:"btn btn-info",class:{disabled:t.overlapCheck||t.loopCheck},on:{click:t.autoPlay}},[e("input",{directives:[{name:"model",rawName:"v-model",value:t.autoCheck,expression:"autoCheck"}],staticClass:"checkbox",attrs:{type:"checkbox",onchange:"this.checked = this.parentNode.disabled"},domProps:{checked:Array.isArray(t.autoCheck)?t._i(t.autoCheck,null)>-1:t.autoCheck},on:{change:function(e){var a=t.autoCheck,o=e.target,n=!!o.checked;if(Array.isArray(a)){var i=null,c=t._i(a,i);o.checked?c<0&&(t.autoCheck=a.concat([i])):c>-1&&(t.autoCheck=a.slice(0,c).concat(a.slice(c+1)))}else t.autoCheck=n}}}),e("span",[t._v(t._s(t.$t("action.autoplay")))])]),e("button",{staticClass:"btn btn-info",class:{disabled:t.autoCheck||t.overlapCheck},attrs:{title:t.$t("info.loopTips")},on:{click:t.loop}},[e("input",{directives:[{name:"model",rawName:"v-model",value:t.loopCheck,expression:"loopCheck"}],staticClass:"checkbox",attrs:{type:"checkbox",onchange:"this.checked = this.parentNode.disabled"},domProps:{checked:Array.isArray(t.loopCheck)?t._i(t.loopCheck,null)>-1:t.loopCheck},on:{change:function(e){var a=t.loopCheck,o=e.target,n=!!o.checked;if(Array.isArray(a)){var i=null,c=t._i(a,i);o.checked?c<0&&(t.loopCheck=a.concat([i])):c>-1&&(t.loopCheck=a.slice(0,c).concat(a.slice(c+1)))}else t.loopCheck=n}}}),e("span",[t._v(t._s(t.$t("action.loop")))])]),e("div",{staticClass:"visible-md visible-lg"},[e("button",{staticClass:"btn btn-info"},[e("span",[t._v(t._s(t.$t("action.volume")))]),e("input",{directives:[{name:"model",rawName:"v-model",value:t.currentVolume,expression:"currentVolume"}],ref:"volSlider",staticClass:"slidecontainer slider",attrs:{type:"range",min:"0",max:"100",id:"volSlider"},domProps:{value:t.currentVolume},on:{__r:function(e){t.currentVolume=e.target.value}}})]),e("p",[t._v(t._s(t.$t("action.volume"))),e("span",{attrs:{id:"volOut"}},[t._v(t._s(t.currentVolume))])])])]),e("div",{staticClass:"cate-body"},[e("span",[t._v(t._s(t.voice.name?t.$t("action.playing")+t.$t("voice."+t.voice.name):t.$t("action.noplay")))])]),e("audio",{ref:"player",attrs:{id:"player"},on:{ended:function(e){return t.voiceEnd(!1)}}})]),t._l(t.voices,(function(a){return e("div",{key:a.categoryName},[e("div",{staticClass:"cate-header"},[t._v(t._s(t.$t("voicecategory."+a.categoryName)))]),e("div",{staticClass:"cate-body"},t._l(a.voiceList,(function(a){return e("button",{key:a.name,staticClass:"btn btn-new",on:{click:function(e){return t.play(a)}}},[t._v(" "+t._s(t.$t("voice."+a.name))+" ")])})),0)])}))],2)}),l=[],s=(a("2397"),a("d225")),u=a("b0b4"),p=a("308d"),v=a("6bb5"),d=a("4e2b"),h=a("bd86"),f=a("65d9"),y=a.n(f),b=a("da57");function g(t,e,a){return e=Object(v["a"])(e),Object(p["a"])(t,m()?Reflect.construct(e,a||[],Object(v["a"])(t).constructor):e.apply(t,a))}function m(){try{var t=!Boolean.prototype.valueOf.call(Reflect.construct(Boolean,[],(function(){})))}catch(t){}return(m=function(){return!!t})()}var C=(o=y()({watch:{currentVolume:function(t){this.$refs.player.volume=t/100}}}),o(n=function(t){function e(){var t;Object(s["a"])(this,e);for(var a=arguments.length,o=new Array(a),n=0;n<a;n++)o[n]=arguments[n];return t=g(this,e,[].concat(o)),Object(h["a"])(t,"voices",b.voices),Object(h["a"])(t,"autoCheck",!1),Object(h["a"])(t,"overlapCheck",!1),Object(h["a"])(t,"loopCheck",!1),Object(h["a"])(t,"currVoice",void 0),Object(h["a"])(t,"voice",{}),Object(h["a"])(t,"currentVolume",80),t}return Object(d["a"])(e,t),Object(u["a"])(e,[{key:"currentAudioVolume",get:function(){return this.currentVolume/100}},{key:"mounted",value:function(){var t=this;this.handlePlay=function(e){var a=e.src;t.$refs.player.src=a,t.$refs.player.play()},this.$gConst.globalbus.$on("play",this.handlePlay)}},{key:"beforeDestroy",value:function(){this.$gConst.globalbus.$off("play",this.handlePlay)}},{key:"play",value:function(t){if(this.overlapCheck){var e=new Audio("voices/"+t.path);e.volume=this.currentAudioVolume,this.voice=t,e.play()}else this.stopPlay(),this.$refs.player.src="voices/"+t.path,this.voice=t,this.currVoice=t,this.$refs.player.play()}},{key:"stopPlay",value:function(){this.$refs.player.pause(),this.voiceEnd(!0)}},{key:"voiceEnd",value:function(t){!0!==t&&this.autoCheck?this.random():!0!==t&&this.loopCheck?this.$refs.player.play():this.voice={}}},{key:"random",value:function(){var t=this.voices[this._randomNum(0,this.voices.length-1)];"blessings"==t.categoryName?(console.log("BLESSING DENIED"),this.random()):this.play(t.voiceList[this._randomNum(0,t.voiceList.length-1)])}},{key:"autoPlay",value:function(){this.overlapCheck||this.loopCheck||(this.autoCheck=!this.autoCheck)}},{key:"overlap",value:function(){this.autoCheck||this.loopCheck||(this.overlapCheck=!this.overlapCheck)}},{key:"loop",value:function(){this.autoCheck||this.overlapCheck||(this.loopCheck=!this.loopCheck)}},{key:"_randomNum",value:function(t,e){switch(arguments.length){case 1:return parseInt(Math.random()*t+1,10);case 2:return parseInt(Math.random()*(e-t+1)+t,10);default:return 0}}}])}(i["default"]))||n),k=C,_=k,j=(a("3728"),a("0c7c")),O=Object(j["a"])(_,r,l,!1,null,"0999eb0a",null),$=O.exports;i["default"].use(c["a"]);e["a"]=new c["a"]({mode:"history",base:"/joi-button/",routes:[{path:"/",name:"home",component:$}]})},"56d7":function(t,e,a){"use strict";a.r(e),function(t){a("ac4d"),a("8a81"),a("5df3"),a("1c4c"),a("6b54"),a("7f7f"),a("cadf"),a("551c"),a("f751"),a("097d");var e=a("2b0e"),o=a("a925"),n=a("41cb"),i=a("3dfd"),c=a("296e"),r=a("2f6e"),l=a("1564"),s=a("1157"),u=a.n(s),p=(a("1b58"),a("898e")),v=a("da57");function d(t,e){var a="undefined"!=typeof Symbol&&t[Symbol.iterator]||t["@@iterator"];if(!a){if(Array.isArray(t)||(a=h(t))||e&&t&&"number"==typeof t.length){a&&(t=a);var o=0,n=function(){};return{s:n,n:function(){return o>=t.length?{done:!0}:{done:!1,value:t[o++]}},e:function(t){throw t},f:n}}throw new TypeError("Invalid attempt to iterate non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.")}var i,c=!0,r=!1;return{s:function(){a=a.call(t)},n:function(){var t=a.next();return c=t.done,t},e:function(t){r=!0,i=t},f:function(){try{c||null==a.return||a.return()}finally{if(r)throw i}}}}function h(t,e){if(t){if("string"==typeof t)return f(t,e);var a={}.toString.call(t).slice(8,-1);return"Object"===a&&t.constructor&&(a=t.constructor.name),"Map"===a||"Set"===a?Array.from(t):"Arguments"===a||/^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(a)?f(t,e):void 0}}function f(t,e){(null==e||e>t.length)&&(e=t.length);for(var a=0,o=Array(e);a<e;a++)o[a]=t[a];return o}t.jQuery=t.$=u.a;var y,b={voice:{},voicecategory:{}},g={voice:{},voicecategory:{}},m={voice:{},voicecategory:{}},C=d(v.voices);try{for(C.s();!(y=C.n()).done;){var k=y.value;void 0!==k.categoryDescription&&(void 0!==k.categoryDescription["zh-CN"]&&(b.voicecategory[k.categoryName]=k.categoryDescription["zh-CN"]),void 0!==k.categoryDescription["en-US"]&&(g.voicecategory[k.categoryName]=k.categoryDescription["en-US"]),void 0!==k.categoryDescription["ja-JP"]&&(m.voicecategory[k.categoryName]=k.categoryDescription["ja-JP"]));var _,j=d(k.voiceList);try{for(j.s();!(_=j.n()).done;){var O=_.value;void 0!==O.description&&(void 0!==O.description["zh-CN"]&&(b.voice[O.name]=O.description["zh-CN"]),void 0!==O.description["en-US"]&&(g.voice[O.name]=O.description["en-US"]),void 0!==O.description["ja-JP"]&&(m.voice[O.name]=O.description["ja-JP"]))}}catch(x){j.e(x)}finally{j.f()}}}catch(x){C.e(x)}finally{C.f()}var $=Object.assign(r["a"],b),w=Object.assign(c["a"],g),N=Object.assign(l["a"],m);e["default"].config.productionTip=!1,e["default"].use(o["a"]),e["default"].use(p["a"]);var P={"en-US":w,"zh-CN":$,"ja-JP":N},S="en-US";/ja/i.test(navigator.language)?S="ja-JP":/cn/i.test(navigator.language)&&(S="zh-CN");var A=new o["a"]({locale:S,messages:P});new e["default"]({router:n["a"],i18n:A,render:function(t){return t(i["a"])}}).$mount("#app")}.call(this,a("c8ba"))},"583e":function(t,e,a){},"73c5":function(t,e,a){"use strict";a("583e")},"898e":function(t,e,a){"use strict";var o=a("d225"),n=a("b0b4"),i=a("2b0e"),c=function(){function t(){Object(o["a"])(this,t)}return Object(n["a"])(t,[{key:"install",value:function(t){t.prototype.$gConst={globalbus:new i["default"]}}}])}();e["a"]=new c},9538:function(t,e,a){"use strict";a("2354")},aef4:function(t,e,a){},da57:function(t){t.exports=JSON.parse('{"voices":[{"categoryName":"Cute Hummings","categoryDescription":{"ja-JP":"かわいいうめき声","en-US":"Cute Hummings","zh-CN":"可爱小动静"},"voiceList":[{"name":"Ei?","path":"CuteHummings_Ei.mp3","description":{"ja-JP":"え？","en-US":"Ei?","zh-CN":"欸？"}}]}]}')}});
//# sourceMappingURL=app.9134956f.js.map