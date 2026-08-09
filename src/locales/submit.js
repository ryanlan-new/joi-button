// SPDX-License-Identifier: MIT
//
// Every string the two submitter pages render, in the three languages together.
//
// ONE top-level group (`submit`), because src/main.js merges several of these
// modules and a group per module is what keeps two authors from overwriting each
// other's keys. src/locales/{zh-CN,en-US,ja-JP}.js are not touched.
//
// TWO RULES THIS FILE OBEYS, both enforced by things outside it:
//
//   * No '{', '}', '|' or '@:' except where a slot is meant. vue-i18n 8 reads
//     '{x}' as an interpolation, '|' as a plural separator and '@:key' as a read
//     of another message, and it has NO escape syntax. server/routes/public.mjs
//     refuses its own sentences for the same reason at import time.
//   * `submit.reason.*` mirrors PUBLIC_REASONS in server/routes/public.mjs. The
//     CODE is the contract; the API's English sentence is the fallback for a code
//     added after this file was written, and the pages render that value rather
//     than a key path. A code missing here degrades to the server's sentence, not
//     to 'submit.reason.whatever'.
//
// The Japanese is written as a Japanese viewer would write it, not as a gloss of
// the Chinese: where the three differ in what they emphasise, that is deliberate.

export default {
  'zh-CN': {
    submit: {
      page: {
        title: '投稿',
        lead: '有轴伊的好素材？发给我，审核过了就会出现在按钮墙上。',
        myLead: '这里只有你自己投的，别人看不到。',
      },

      // The most important block on the site: what is being asked for, and why.
      why: {
        heading: '为什么要你在直播间发一条弹幕？',
        lead: '先把事情说清楚，再问你要东西。',
        noPassword:
          '不用密码，不用扫码，也不用给这个站任何授权。你要做的只有一件事：在本站的直播间里，把一句话当成普通弹幕发出去。',
        whatWeSee:
          '我们能看到的就只有那一条弹幕：谁发的、发了什么。关注列表、私信、充电记录、手机号，这个站碰都碰不到，也不想碰。',
        whatWeLearn:
          '认出你之后，我们记下的是 B 站单独发给这个站的一串编号（只在这里作数，换个站就对不上），外加你当时的昵称。那不是你的账号。',
        safeHeading: '所以这句话就算被整个直播间看见也不要紧：',
        safeOneTime: '一次性，用掉就没了；',
        safeShort: '寿命很短，页面上的倒计时就是它剩下的全部时间；',
        safeFirstCome: '谁先发出来算谁的；',
        safeVoid: '我们看见它的那一刻，它当场作废。',
        neverDelete:
          '弹幕发出去就撤不回来，所以这句话本来就是照着「被人看见也无所谓」设计的。你不需要去删它。',
        stolen:
          '真被人抢着发了会怎样：这个浏览器会变成对方的身份，你会在下面看到别人的昵称。那就退出登录，重新要一句新的。',
      },

      state: {
        checking: '正在看看你是不是已经登录过了…',
        preparing: '正在接直播间…',
        preparingDetail:
          '码还没生成 —— 我们得先真的连上直播间听着，不然你发出去的弹幕会掉进一个没人听的房间，而系统还会理直气壮地说你没发。等一下下。',
        waiting: '把下面这句话发到直播间',
        waitingDetail: '普通弹幕就行，不用加任何前缀。发出去之后这一页会自己变。',
        unreachable: '我们这边现在听不见直播间',
        unreachableDetail:
          '这是我们的问题，不是你的 —— 你发没发我们都不知道。等一会儿再试，或者现在就重试一次。',
        expired: '这句话已经过期了',
        expiredDetail: '重新要一句就好，旧的那句已经作废，不用管它。',
        resend: '中间有一小段时间我们没听见，你要是刚才已经发过，麻烦再发一次这句话。',
        verifiedAs: '现在登录的是：{name}',
      },

      code: {
        label: '你要发的这句话',
        expiresIn: '剩余 {time}',
        expiredNow: '倒计时走完了，正在跟服务器确认…',
        room: '本站的直播间',
        copyHint: '点“复制”会把码放进剪贴板；点直播间链接也会先复制再跳转。',
        copied: '已复制到剪贴板。',
        copyFailed: '浏览器不让我们自动复制，手动选中上面那串就好。',
      },

      editor: {
        heading: '选文件',
        rowsHeading: '一条一条填',
        limits: '一次最多 {max} 个文件，每个不超过 {size}。',
        chosen: '已选 {n} / {max} 个。',
        pickLabel: '选音频文件（可以一次选多个）',
        empty: '还没选文件。选好之后每个文件会在下面出现一行。',
        captionLangLabel: '你写字幕用的语言',
        captionLangHint: '这一批都按这个语言存。本站管理员之后会补另外两种。',
        remove: '去掉这一条',
        notAdded: '这些文件没有加进来：',
        durability:
          '手机上这一页要是中途被关掉：上传条走完之前断掉的，站上什么都不会留下 —— 一批要么整批处理，要么当没发生过。上传条走完之后才断的，可能已经收到了，去「我投过的」看一眼再决定要不要重发。',
        draftKept:
          '你填的名字、字幕和分组存在这台设备上（文件本身浏览器不让存）。重新选中同一批文件，这些字会自己填回来。',
        draftFound: '上次还留着 {n} 条没发完的填写内容，重新选中同名文件就会填回去。',
        draftDrop: '丢掉这些草稿',
        incomplete: '还有 {n} 条没填完 —— 名字、字幕、分组三样都要有。',
      },

      field: {
        name: '名字',
        nameHint: '按钮上显示的短名字。',
        caption: '字幕',
        captionHint: '这一条说的是什么，一句话。',
        group: '归到哪一组',
        groupNew: '提一个新分组',
        newGroup: '新分组的名字',
        newGroupHint: '这是个建议 —— 建不建、叫什么，最后由本站管理员定。',
        note: '给审核的留言',
        source: '来源信息',
        sourceKind: '来源类型',
        sourceNone: '不填写',
        sourceVideo: '视频',
        sourceStream: '直播',
        sourceTitle: '来源标题',
        sourceDate: '来源日期',
        sourceTime: '来源时间',
        sourceUrl: '来源链接',
        optional: '可不填',
        counter: '{n} / {max}',
        required: '要填',
        chooseGroup: '请选一个分组，或者提一个新的',
        groupsUnavailable: '现有分组的名单没读到，所以现在只能提新分组。本站管理员审核的时候会归位。',
      },

      action: {
        getCode: '给我一句话',
        getCodeAgain: '再要一句',
        cancel: '算了，不登录了',
        retry: '重试',
        copy: '复制',
        signOut: '退出登录',
        send: '发出去',
        sending: '正在上传…',
        abort: '中止上传',
        reload: '刷新这一页',
        home: '回按钮墙',
        toMy: '看我投过的',
        toSubmit: '去投稿',
        loadMore: '再看更早的',
        refresh: '刷新一下',
        tryAgain: '再试一次',
      },

      progress: {
        row: '{percent}%',
        sent: '已送出，等服务器回话',
        total: '一共 {percent}%',
        note: '进度条量的是「送出去了多少」，不是「收下了多少」—— 收没收下要等服务器回话。',
      },

      result: {
        headingSome: '收下了 {ok} 条，退回 {bad} 条',
        headingAll: '{ok} 条全收下了',
        headingNone: '一条都没收下 —— 什么都没保存',
        queuedNote: '收下的已经排进审核队列，本站管理员看过才会上墙。',
        keptNote: '退回的还在下面，改好可以再发一次。',
        seeMy: '去「我投过的」看它们的状态',
      },

      turnstile: {
        heading: '先过一下人机验证',
        why: '这个站偶尔会要一次验证，尤其是第一次投稿的时候。',
        loading: '正在加载验证组件…',
        unavailable:
          '验证组件没加载出来（它是 Cloudflare 的，有的网络到不了）。你可以直接点发出去试试：如果服务器坚持要验证，会明明白白告诉你，你写的东西一个字都不会丢。',
        retryLoad: '再试着加载一次',
        solveFirst: '请先完成上面的验证，然后再点一次发出去。',
        expired: '验证过期了，再点一次上面的方框。',
        failedAgain: '这次验证没通过，重新做一次再发。',
      },

      my: {
        heading: '我投过的',
        empty: '你还没投过东西。',
        loading: '读取中…',
        submittedAt: '投于 {time}',
        resolvedAt: '处理于 {time}',
        items: '{n} 条',
        reviewerNote: '本站管理员的说明：',
        group: '分组：{name}',
        proposedGroup: '提议的新分组：{name}',
        noGroup: '没写分组',
        caption: '字幕：',
        facts: '{size} · {seconds} 秒',
        itemState: {
          pending: '等审核',
          approved: '已通过',
          rejected: '被退回',
          failed: '处理失败',
        },
        batchState: {
          draft: '草稿',
          submitted: '等审核',
          resolved: '已处理完',
          cancelled: '已取消',
        },
        needSignIn: '要先登录，才看得到你自己投过的东西。',
      },

      error: {
        heading: '出了点问题',
        network: '连不上服务器。可能是网断了，也可能是这个站的后端正好在重启 —— 你写的东西还在。',
        apiUnavailable:
          '这个站点上没有投稿后端（比如你现在看的是 GitHub Pages 上的那份镜像）。投稿要到带后端的那个地址上做。',
        unexpected: '服务器给了一个我们没见过的回答。',
      },

      chunk: {
        title: '这一页没加载出来',
        body: '要么是站点在你开着这个标签页的时候更新了（旧的文件已经不在服务器上），要么是网络断了。刷新一下就好，你没有弄坏任何东西。',
      },

      reason: {
        // The identity / session family
        identity_required: '要先登录：先要一句话，再把它当弹幕发到直播间。',
        no_verification_in_progress: '现在没有正在进行的验证，先要一句话。',
        unknown_poll_token: '这个查询凭据不属于当前这个浏览器会话，重新要一句话。',
        room_not_configured: '这个部署还没配直播间，所以发不出码来。',
        verification_capacity: '同时等待验证的人太多了，过几分钟再试。',
        submitter_blocked: '这个账号不能投稿。',

        // The submission envelope
        multipart_required: '这个请求要用 multipart 表单发 —— 音频是文件，不是 JSON。',
        metadata_required: '这次提交少了 metadata 字段，文件对不上任何一条描述。',
        metadata_malformed:
          'metadata 字段的形状不对。每一条都要有唯一的 key、名字、一句字幕和一个分组选择。',
        too_many_items: '一次提交装不下这么多条。',
        too_many_files: '一次提交装不下这么多文件。',
        too_many_fields: '这次提交带的表单字段比预期的多。',
        malformed_multipart: '上传还没传完就断了，请再试一次。',
        no_items: '这次提交里一条都没有。',
        no_valid_items: '这次提交里没有一条能收下，什么都没保存。',
        challenge_required: '这次提交需要过一次人机验证，做完再发一次。',
        challenge_failed: '人机验证没通过，请重新做一次。',

        // Per item
        metadata_missing: '这个文件在 metadata 里没有对应的条目。',
        missing_file: '这一条有描述，但没有文件。',
        empty_file: '这个文件是空的。',
        file_too_large: '这个文件超过了单条的大小上限。',
        unreadable_audio: '这个文件读不出音频 —— 它的内容不是本站接受的格式。',
        unsupported_audio_format: '这不是本站接受的音频格式。',
        unreadable_duration: '这段音频的长度测不出来，所以不能发布。',
        duplicate_in_batch: '同一个文件在这次提交里出现了两次。',
        already_published: '一模一样的音频站上已经有了。',
        invalid_name: '这个名字不能用。',
        invalid_caption: '这句字幕不能用。',
        invalid_note: '这段留言不能用。',
        invalid_group_name: '这个分组名不能用。',
        unknown_locale: '这不是本站发布的语言。',
        unknown_group: '这个分组不存在，或者已经不用了。',
        group_choice_required: '每一条都要选一个现有分组，或者提一个新的。',
        group_choice_ambiguous: '选现有分组和提新分组，只能二选一。',
        note_too_long: '这一条上的文字太长，存不下。',

        // Details the two text gates hand back
        detail: {
          empty: '（不能是空的）',
          too_long: '（太长了）',
          not_a_string: '（不是一段文字）',
          control_character: '（里面有换行或者控制字符）',
          bidi_control: '（里面有改变文字方向的隐藏字符）',
          invisible_character: '（里面有看不见的字符）',
          lone_surrogate: '（里面有半个字符，存不下来）',
          linked_message: '（不能带 @ 加冒号那种写法）',
          missing: '（没填）',
        },
      },

      pick: {
        tooMany: '这一批已经装满 {max} 个了。',
        tooBig: '比 {size} 的上限大。',
        duplicate: '这个文件已经在下面了。',
        empty: '这个文件是空的。',
      },
    },
  },

  'en-US': {
    submit: {
      page: {
        title: 'Send a clip',
        lead: 'Got a good bit of Joi? Send it over. If it passes review it goes up on the wall.',
        myLead: 'Only yours. Nobody else can see this list.',
      },

      why: {
        heading: 'Why are we asking you to post a danmaku?',
        lead: 'Here is the whole story before we ask you for anything.',
        noPassword:
          'No password, no QR scan, no authorisation of any kind. One thing only: post a short phrase as an ordinary danmaku in the live room.',
        whatWeSee:
          'All we see is that one danmaku: who sent it and what it said. Your follows, your messages, your payments, your phone number — this site cannot reach any of it and does not want to.',
        whatWeLearn:
          'Once you are recognised we keep an id Bilibili issues for this application alone (it means nothing anywhere else), plus the nickname you were using. That is not your account.',
        safeHeading: 'Which is why the phrase is harmless even if the whole room reads it:',
        safeOneTime: 'it works once, and then it is spent;',
        safeShort: 'it is short-lived — the countdown on this page is its whole life;',
        safeFirstCome: 'first one to post it wins it;',
        safeVoid: 'the instant we see it, it is void.',
        neverDelete:
          'A danmaku cannot be taken back once it is sent, so this code was designed from the start to be safe to say out loud. There is nothing for you to delete.',
        stolen:
          'If somebody does beat you to it: this browser becomes their identity and you will see their nickname below. Sign out and ask for a fresh code.',
      },

      state: {
        checking: 'Checking whether you are already signed in…',
        preparing: 'Opening the room…',
        preparingDetail:
          'There is no code yet, on purpose. We have to be genuinely listening first, or your danmaku lands in a room nobody is hearing and the system cheerfully tells you that you never sent it. One moment.',
        waiting: 'Post this phrase in the live room',
        waitingDetail: 'An ordinary danmaku, no prefix needed. This page changes by itself once it lands.',
        unreachable: 'Our side cannot hear the room right now',
        unreachableDetail:
          'This is ours, not yours — we cannot tell whether you sent anything. Give it a moment, or retry now.',
        expired: 'That code has expired',
        expiredDetail: 'Ask for another one. The old one is void and can be ignored.',
        resend:
          'There was a gap when we were not listening. If you already posted it, please post the same code once more.',
        verifiedAs: 'Signed in as {name}',
      },

      code: {
        label: 'Your phrase',
        expiresIn: '{time} left',
        expiredNow: 'The countdown ran out; checking with the server…',
        room: "this site's live room",
        copyHint: 'Copy puts it on your clipboard. The room link copies it first, then opens the room.',
        copied: 'Copied to the clipboard.',
        copyFailed: 'The browser would not let us copy it for you. Select it by hand instead.',
      },

      editor: {
        heading: 'Choose files',
        rowsHeading: 'One row per clip',
        limits: 'Up to {max} files in one go, {size} each at most.',
        chosen: '{n} of {max} chosen.',
        pickLabel: 'Choose audio files (several at once is fine)',
        empty: 'No files yet. Each one you choose gets a row here.',
        captionLangLabel: 'The language you are writing captions in',
        captionLangHint: 'The whole batch is stored under this one. The site admin adds the other two later.',
        remove: 'Drop this one',
        notAdded: 'These files were not added:',
        durability:
          'If this tab dies on you mid-upload: nothing is kept unless the progress bar finished — a batch is handled whole or not at all. If it died after the bar finished, it may well have landed, so check What I sent before sending it again.',
        draftKept:
          'What you type — names, captions, groups — stays on this device. The files themselves cannot be kept by a browser. Choose the same files again and the words come back.',
        draftFound: 'There are {n} rows of text left over from last time. Choose the same files and they fill themselves in.',
        draftDrop: 'Throw the draft away',
        incomplete: '{n} rows are still short of something — each needs a name, a caption and a group.',
      },

      field: {
        name: 'Name',
        nameHint: 'The short name that goes on the button.',
        caption: 'Caption',
        captionHint: 'What is said in the clip, in one line.',
        group: 'Which group',
        groupNew: 'Propose a new group',
        newGroup: 'Name for the new group',
        newGroupHint: 'It is a proposal. Whether it exists, and what it ends up called, is the site admin to decide.',
        note: 'Note for the reviewer',
        source: 'Source information',
        sourceKind: 'Source type',
        sourceNone: 'Not specified',
        sourceVideo: 'Video',
        sourceStream: 'Stream',
        sourceTitle: 'Source title',
        sourceDate: 'Source date',
        sourceTime: 'Source time',
        sourceUrl: 'Source URL',
        optional: 'optional',
        counter: '{n} / {max}',
        required: 'needed',
        chooseGroup: 'Pick a group, or propose one',
        groupsUnavailable:
          'The list of existing groups did not load, so a new one is the only thing on offer right now. The site admin files it properly at review time.',
      },

      action: {
        getCode: 'Give me a code',
        getCodeAgain: 'Give me another',
        cancel: 'Never mind, forget it',
        retry: 'Retry',
        copy: 'Copy',
        signOut: 'Sign out',
        send: 'Send them',
        sending: 'Uploading…',
        abort: 'Stop the upload',
        reload: 'Reload this page',
        home: 'Back to the buttons',
        toMy: 'What I sent',
        toSubmit: 'Send a clip',
        loadMore: 'Older ones',
        refresh: 'Refresh',
        tryAgain: 'Try again',
      },

      progress: {
        row: '{percent}%',
        sent: 'sent, waiting on the server',
        total: '{percent}% overall',
        note: 'The bar measures what has left your browser, not what has been accepted. Acceptance comes back at the end.',
      },

      result: {
        headingSome: '{ok} taken, {bad} handed back',
        headingAll: 'All {ok} taken',
        headingNone: 'None taken — nothing was saved',
        queuedNote: 'The ones taken are queued. They reach the wall once the site admin has listened to them.',
        keptNote: 'The ones handed back are still below. Fix them and send again.',
        seeMy: 'See how they are doing',
      },

      turnstile: {
        heading: 'A quick human check first',
        why: 'This site asks for one occasionally, and nearly always on a first submission.',
        loading: 'Loading the check…',
        unavailable:
          "The check did not load. It is Cloudflare's, and some networks cannot reach it. Press send anyway: if the server insists on a check it will say so plainly, and not one word you typed is lost.",
        retryLoad: 'Try loading it again',
        solveFirst: 'Finish the check above, then press send once more.',
        expired: 'The check expired. Tick the box again.',
        failedAgain: 'That check was not accepted. Do it once more and send again.',
      },

      my: {
        heading: 'What I sent',
        empty: 'You have not sent anything yet.',
        loading: 'Loading…',
        submittedAt: 'sent {time}',
        resolvedAt: 'settled {time}',
        items: '{n} clips',
        reviewerNote: 'The site admin says:',
        group: 'Group: {name}',
        proposedGroup: 'Proposed group: {name}',
        noGroup: 'No group recorded',
        caption: 'Caption:',
        facts: '{size} · {seconds}s',
        itemState: {
          pending: 'waiting for review',
          approved: 'accepted',
          rejected: 'handed back',
          failed: 'could not be processed',
        },
        batchState: {
          draft: 'draft',
          submitted: 'waiting for review',
          resolved: 'settled',
          cancelled: 'cancelled',
        },
        needSignIn: 'Sign in first and this list becomes yours.',
      },

      error: {
        heading: 'Something went wrong',
        network:
          'We could not reach the server. Your network may have dropped, or the backend may be restarting. Nothing you typed is lost.',
        apiUnavailable:
          'This host has no submission backend — the GitHub Pages mirror, for instance, is the site without one. Sending clips has to happen on the address that runs the API.',
        unexpected: 'The server answered with something we do not recognise.',
      },

      chunk: {
        title: 'This page did not load',
        body: 'Either the site was updated while this tab sat open — the old file is no longer on the server — or the network dropped. A reload fixes it. You have not broken anything.',
      },

      reason: {
        identity_required: 'Sign in first. Ask for a code, then send it as a danmaku in the live room.',
        no_verification_in_progress: 'There is no verification in progress. Ask for a code first.',
        unknown_poll_token: 'That poll token does not belong to this browser session. Ask for a code again.',
        room_not_configured: 'This deployment has no live room configured, so no code can be issued yet.',
        verification_capacity: 'Too many verifications are waiting right now. Please try again in a few minutes.',
        submitter_blocked: 'This account cannot submit clips.',

        multipart_required: 'Send this as a multipart form: the clips are files, not JSON.',
        metadata_required: 'The submission is missing its metadata field, so no file can be matched to a clip.',
        metadata_malformed:
          'The metadata field is not the expected shape. Each item needs a unique key, a name, one caption and a group choice.',
        too_many_items: 'That is more clips than one submission may carry.',
        too_many_files: 'That is more files than one submission may carry.',
        too_many_fields: 'That submission carries more form fields than expected.',
        malformed_multipart: 'The upload ended before it was complete. Please try again.',
        no_items: 'That submission carried no clips at all.',
        no_valid_items: 'None of the clips in that submission could be accepted; nothing was saved.',
        challenge_required:
          'A verification challenge is needed for this submission. Solve it and send the submission again.',
        challenge_failed: 'The verification challenge was not accepted. Please solve it again.',

        metadata_missing: 'This file has no matching entry in the metadata.',
        missing_file: 'This item has metadata but no file.',
        empty_file: 'This file is empty.',
        file_too_large: 'This file is larger than the size limit for one clip.',
        unreadable_audio: 'This file could not be read as audio; its contents are not a format this site accepts.',
        unsupported_audio_format: 'This is not one of the audio formats this site accepts.',
        unreadable_duration: 'The length of this audio could not be determined, so it cannot be published.',
        duplicate_in_batch: 'The same file appears twice in this submission.',
        already_published: 'This exact audio is already on the site.',
        invalid_name: 'This name cannot be used.',
        invalid_caption: 'This caption cannot be used.',
        invalid_note: 'This note cannot be used.',
        invalid_group_name: 'This group name cannot be used.',
        unknown_locale: 'That is not a language this site publishes.',
        unknown_group: 'That group does not exist, or is no longer in use.',
        group_choice_required: 'Choose an existing group, or propose a new one, for every clip.',
        group_choice_ambiguous: 'Choose an existing group or propose a new one, not both.',
        note_too_long: 'The text on this item is too long to store.',

        detail: {
          empty: '(it cannot be blank)',
          too_long: '(too long)',
          not_a_string: '(that is not text)',
          control_character: '(it contains a line break or a control character)',
          bidi_control: '(it contains hidden characters that reorder text)',
          invisible_character: '(it contains invisible characters)',
          lone_surrogate: '(it contains half a character, which cannot be stored)',
          linked_message: '(an at sign followed by a colon cannot be used)',
          missing: '(nothing was filled in)',
        },
      },

      pick: {
        tooMany: 'This batch is already full at {max}.',
        tooBig: 'Larger than the {size} limit.',
        duplicate: 'That file is already in the list below.',
        empty: 'That file is empty.',
      },
    },
  },

  'ja-JP': {
    submit: {
      page: {
        title: '音声を送る',
        lead: 'いい素材があったら送ってください。審査を通ればボタンの壁に並びます。',
        myLead: 'ここに出るのは自分が送った分だけ。他の人からは見えません。',
      },

      why: {
        heading: 'どうして配信部屋に弾幕を流してもらうの？',
        lead: '何かをお願いする前に、まず全部説明します。',
        noPassword:
          'パスワードも、QRコードの読み取りも、認可も要りません。やることはひとつだけ。配信部屋にひとことのフレーズをふつうの弾幕として流すこと。',
        whatWeSee:
          'こちらから見えるのは、その弾幕ひとつだけです。誰が、何を書いたか。フォローも、DMも、投げ銭も、電話番号も、このサイトからは触れませんし、触るつもりもありません。',
        whatWeLearn:
          '照合できたら、このサイト専用に発行されるIDと、そのときのニックネームを控えます。他のサイトでは意味を持たない番号で、アカウントそのものではありません。',
        safeHeading: 'だからコードは、部屋じゅうに見られても平気です。',
        safeOneTime: '使えるのは一回きり。使われたら終わり。',
        safeShort: '寿命は短くて、このページのカウントダウンがその全部です。',
        safeFirstCome: '先に流した人のものになります。',
        safeVoid: 'こちらが見つけた瞬間に無効になります。',
        neverDelete:
          '弾幕は流したら取り消せません。だからこのコードは最初から「見られても困らないもの」として作ってあります。消す必要はありません。',
        stolen:
          '万一、先を越されたら。このブラウザは相手の身分になり、下に知らない名前が出ます。ログアウトして、新しいコードをもらい直してください。',
      },

      state: {
        checking: 'すでにログイン済みかどうか確認しています…',
        preparing: '配信部屋につないでいます…',
        preparingDetail:
          'コードはまだ出しません。こちらが本当に聞いている状態になってからでないと、流した弾幕が誰も聞いていない部屋に落ちて、そのうえシステムが「送っていませんね」と言い出します。少しだけお待ちを。',
        waiting: 'このフレーズを配信部屋に流してください',
        waitingDetail: 'ふつうの弾幕でOK。届けばこのページがひとりでに変わります。',
        unreachable: 'いま配信部屋の音がこちらに届いていません',
        unreachableDetail:
          'こちら側の問題で、あなたのせいではありません。送ったかどうかもこちらには分かりません。少し待つか、いま再試行してください。',
        expired: 'このコードは期限切れです',
        expiredDetail: '新しいコードをもらってください。古いほうはもう無効なので、そのままで大丈夫です。',
        resend:
          '途中、聞けていなかった時間があります。すでに流していたら、同じコードをもう一度だけ流してください。',
        verifiedAs: 'ログイン中：{name}',
      },

      code: {
        label: 'あなたのフレーズ',
        expiresIn: '残り {time}',
        expiredNow: 'カウントダウンが終わりました。サーバーに確認しています…',
        room: '当サイトの配信部屋',
        copyHint: '「コピー」でクリップボードへ。配信部屋のリンクも、開く前にまずコピーします。',
        copied: 'コピーしました。',
        copyFailed: 'ブラウザが自動コピーを許可しませんでした。上の文字を手で選んでください。',
      },

      editor: {
        heading: 'ファイルを選ぶ',
        rowsHeading: '一本ずつ書く',
        limits: '一度に {max} 個まで、1個 {size} まで。',
        chosen: '{n} / {max} 個を選択中。',
        pickLabel: '音声ファイルを選ぶ（まとめて選べます）',
        empty: 'まだ選ばれていません。選ぶと一本ごとに行が出ます。',
        captionLangLabel: '字幕を書く言語',
        captionLangHint: 'この回はこの言語で保存します。残りの二言語は管理人があとから書きます。',
        remove: 'この行を外す',
        notAdded: '次のファイルは追加できませんでした：',
        durability:
          'スマホでこのタブが途中で閉じたときは。進捗バーが終わる前に切れたなら、サイト側には何も残りません（まとめて処理されるか、何も起きなかったことになるかのどちらかです）。バーが終わったあとに切れたなら、届いている可能性があります。「送ったもの」を見てから送り直してください。',
        draftKept:
          '入力した名前・字幕・グループはこの端末に残ります。ファイル自体はブラウザに残せません。同じファイルを選び直せば文字は戻ります。',
        draftFound: '前回の入力が {n} 行ぶん残っています。同じファイルを選べば自動で戻ります。',
        draftDrop: '下書きを捨てる',
        incomplete: 'あと {n} 行、足りないところがあります。名前・字幕・グループの三つが必要です。',
      },

      field: {
        name: '名前',
        nameHint: 'ボタンに出る短い名前。',
        caption: '字幕',
        captionHint: '何と言っているか、一行で。',
        group: 'どのグループへ',
        groupNew: '新しいグループを提案する',
        newGroup: '新しいグループの名前',
        newGroupHint: 'あくまで提案です。作るかどうかも、名前も、決めるのは管理人です。',
        note: '審査への伝言',
        source: '出典情報',
        sourceKind: '出典の種類',
        sourceNone: '入力しない',
        sourceVideo: '動画',
        sourceStream: '配信',
        sourceTitle: '出典のタイトル',
        sourceDate: '出典の日付',
        sourceTime: '出典の時間',
        sourceUrl: '出典リンク',
        optional: '任意',
        counter: '{n} / {max}',
        required: '必須',
        chooseGroup: 'グループを選ぶか、新しく提案してください',
        groupsUnavailable:
          '既存グループの一覧が読み込めなかったので、いまは新規提案だけです。審査のときに正しい場所へ入ります。',
      },

      action: {
        getCode: 'コードをもらう',
        getCodeAgain: 'もう一度もらう',
        cancel: 'やっぱりやめる',
        retry: '再試行',
        copy: 'コピー',
        signOut: 'ログアウト',
        send: '送る',
        sending: 'アップロード中…',
        abort: 'アップロードを中止',
        reload: 'このページを再読み込み',
        home: 'ボタンの壁へ戻る',
        toMy: '送ったものを見る',
        toSubmit: '音声を送る',
        loadMore: 'もっと前のもの',
        refresh: '更新する',
        tryAgain: 'もう一度',
      },

      progress: {
        row: '{percent}%',
        sent: '送信済み、サーバーの返事待ち',
        total: '全体 {percent}%',
        note: 'バーが示すのは「ブラウザから出ていった量」で、「受理された量」ではありません。受理の可否は最後に返ってきます。',
      },

      result: {
        headingSome: '{ok} 本を受け取り、{bad} 本を返しました',
        headingAll: '{ok} 本ぜんぶ受け取りました',
        headingNone: '一本も受け取れませんでした。何も保存されていません',
        queuedNote: '受け取った分は審査待ちです。管理人が聴いてから壁に並びます。',
        keptNote: '返した分は下に残っています。直してもう一度送れます。',
        seeMy: '状態を見にいく',
      },

      turnstile: {
        heading: '先に人間かどうかの確認を',
        why: 'ときどき、とくに初回の投稿では確認をお願いしています。',
        loading: '確認ウィジェットを読み込み中…',
        unavailable:
          '確認ウィジェットが読み込めませんでした。Cloudflare のもので、届かない回線があります。そのまま送信を押して大丈夫です。サーバーが確認を求めるなら、はっきりそう返ってきますし、書いた内容はひとつも失われません。',
        retryLoad: 'もう一度読み込む',
        solveFirst: '上の確認を終えてから、もう一度送信を押してください。',
        expired: '確認の有効期限が切れました。もう一度チェックしてください。',
        failedAgain: '確認が通りませんでした。やり直してから送ってください。',
      },

      my: {
        heading: '送ったもの',
        empty: 'まだ何も送っていません。',
        loading: '読み込み中…',
        submittedAt: '{time} に送信',
        resolvedAt: '{time} に処理',
        items: '{n} 本',
        reviewerNote: '管理人からの一言：',
        group: 'グループ：{name}',
        proposedGroup: '提案したグループ：{name}',
        noGroup: 'グループの記録なし',
        caption: '字幕：',
        facts: '{size} · {seconds} 秒',
        itemState: {
          pending: '審査待ち',
          approved: '採用',
          rejected: '差し戻し',
          failed: '処理できず',
        },
        batchState: {
          draft: '下書き',
          submitted: '審査待ち',
          resolved: '処理済み',
          cancelled: '取り消し',
        },
        needSignIn: 'ログインすると、ここが自分の一覧になります。',
      },

      error: {
        heading: '問題が起きました',
        network:
          'サーバーに届きませんでした。回線が切れたか、バックエンドが再起動中かもしれません。入力した内容は残っています。',
        apiUnavailable:
          'このホストには投稿用のバックエンドがありません（GitHub Pages のミラーなどがそれです）。送信はAPIが動いているアドレスで行ってください。',
        unexpected: 'サーバーから、こちらの知らない形の返事が来ました。',
      },

      chunk: {
        title: 'このページを読み込めませんでした',
        body: 'タブを開いたままサイトが更新されたか（古いファイルはもうサーバーにありません）、通信が切れたかのどちらかです。再読み込みで直ります。壊してしまったわけではありません。',
      },

      reason: {
        identity_required: 'まずログインを。コードをもらって、配信部屋に弾幕として流してください。',
        no_verification_in_progress: '進行中の認証がありません。先にコードをもらってください。',
        unknown_poll_token: 'この照会トークンはこのブラウザのものではありません。コードを取り直してください。',
        room_not_configured: 'この環境には配信部屋が設定されていないため、コードを発行できません。',
        verification_capacity: '待機中の認証が多すぎます。数分おいて試してください。',
        submitter_blocked: 'このアカウントは投稿できません。',

        multipart_required: 'multipart フォームで送ってください。音声はファイルであって JSON ではありません。',
        metadata_required: 'metadata フィールドがないため、ファイルをどの一本にも結び付けられません。',
        metadata_malformed:
          'metadata の形が違います。各項目に一意のキー、名前、字幕ひとつ、グループの選択が必要です。',
        too_many_items: '一度の送信に入る本数を超えています。',
        too_many_files: '一度の送信に入るファイル数を超えています。',
        too_many_fields: 'フォーム項目が想定より多く含まれています。',
        malformed_multipart: 'アップロードが完了する前に切れました。もう一度お試しください。',
        no_items: 'この送信には一本も入っていませんでした。',
        no_valid_items: '受け取れる一本がありませんでした。何も保存していません。',
        challenge_required: 'この送信には確認が必要です。確認を終えてからもう一度送ってください。',
        challenge_failed: '確認が受理されませんでした。もう一度お願いします。',

        metadata_missing: 'このファイルに対応する metadata の項目がありません。',
        missing_file: 'この項目には説明はありますが、ファイルがありません。',
        empty_file: 'このファイルは空です。',
        file_too_large: 'このファイルは一本あたりの上限を超えています。',
        unreadable_audio: 'このファイルは音声として読めませんでした。当サイトが受け付ける形式ではありません。',
        unsupported_audio_format: '当サイトが受け付ける音声形式ではありません。',
        unreadable_duration: '長さを測れなかったため、公開できません。',
        duplicate_in_batch: '同じファイルがこの送信に二回入っています。',
        already_published: 'まったく同じ音声がすでにサイトにあります。',
        invalid_name: 'この名前は使えません。',
        invalid_caption: 'この字幕は使えません。',
        invalid_note: 'この伝言は使えません。',
        invalid_group_name: 'このグループ名は使えません。',
        unknown_locale: '当サイトが公開している言語ではありません。',
        unknown_group: 'そのグループは存在しないか、もう使われていません。',
        group_choice_required: '一本ごとに、既存のグループを選ぶか新しく提案してください。',
        group_choice_ambiguous: '既存のグループか新規提案か、どちらか一方にしてください。',
        note_too_long: 'この項目の文字が長すぎて保存できません。',

        detail: {
          empty: '（空にはできません）',
          too_long: '（長すぎます）',
          not_a_string: '（文字ではありません）',
          control_character: '（改行や制御文字が入っています）',
          bidi_control: '（文字の並びを変える隠し文字が入っています）',
          invisible_character: '（見えない文字が入っています）',
          lone_surrogate: '（保存できない半端な文字が入っています）',
          linked_message: '（アットマークとコロンの並びは使えません）',
          missing: '（未入力です）',
        },
      },

      pick: {
        tooMany: 'この回はすでに {max} 個で満杯です。',
        tooBig: '上限 {size} より大きいです。',
        duplicate: 'そのファイルはもう下にあります。',
        empty: 'そのファイルは空です。',
      },
    },
  },
}
