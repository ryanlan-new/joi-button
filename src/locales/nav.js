// The navbar's own words, in the three languages together.
//
// This file exists instead of an edit to locales/{zh-CN,en-US,ja-JP}.js because
// several people are adding pages to this site at the same time and those three
// files are the one place all of them would have collided. One module per
// feature, one top-level group per module — this one owns `nav` and nothing
// else — so two features can never touch the same lines.
//
// src/main.js merges every module of this shape into the vue-i18n messages.
//
// EVERYTHING HERE IS OURS TO WRITE. Nothing the API returns belongs in this
// file: a display name, a caption, a group name and a refusal sentence are all
// submitter- or server-authored VALUES, and putting one through $t() would make
// somebody else's text a key path in our dictionary.
//
// Register, because it is easy to lose in translation:
//   zh-CN is the site's own voice — warm and a bit playful, the way the buttons
//         already talk ("帮我选一个"). "投个音声" rather than "提交投稿".
//   ja-JP has to read like a Japanese fan wrote it, not like a translation of
//         the Chinese. Hence "ボイスを送る" and "送ったボイス", which is what
//         someone writes about their own clips, rather than the stiffer
//         "投稿する" / "私の投稿一覧".
//   en-US is plain. It is the fallback locale, so it is the one a missing key
//         degrades to.
//
// No '{', '}', '|' or '@:' in any value: vue-i18n reads those as an
// interpolation slot, a plural separator and a linked message respectively.
// (server/routes/public.mjs refuses the same four in its own sentences, for the
// same reason and at import time.)
export default {
    'zh-CN': {
        nav: {
            submit: "投个音声",
            login: "登录",
            // Read out before the display name by a screen reader, so the menu
            // announces what it is rather than just a stranger's nickname.
            account: "账号",
            myClips: "我投的",
            logout: "退出",
        },
    },
    'en-US': {
        nav: {
            submit: "Submit a clip",
            login: "Log in",
            account: "Account",
            myClips: "My clips",
            logout: "Log out",
        },
    },
    'ja-JP': {
        nav: {
            submit: "ボイスを送る",
            login: "ログイン",
            account: "アカウント",
            myClips: "送ったボイス",
            logout: "ログアウト",
        },
    },
}
