// SPDX-License-Identifier: MIT
//
// The verification challenge as a short natural-language phrase, not a random
// letter string.
//
// ===========================================================================
// WHY A PHRASE INSTEAD OF SIX RANDOM LETTERS
// ===========================================================================
// The visitor proves their identity by posting the challenge as a danmaku in
// the owner's live room. Bilibili's live-comment risk control flags accounts
// that post short opaque strings (XK7RPM reads like spam / a serial number),
// and a flagged account can be silenced — the danmaku never reaches the room,
// verification "mysteriously" fails, and the visitor is worse off for having
// tried to sign in. A sentence that reads like something a person would type
// is far less likely to trip that. The risk-control rules are not published, so
// "more human -> less likely to trip" is a reasoned mitigation, not a promise.
//
// ===========================================================================
// SHAPE: `<场景>的第<n>颗橘子<动作>`  e.g. 「深海的第7颗橘子在数星星」
// ===========================================================================
// Every phrase contains 橘子 (the owner's ask, and a recognizable marker that
// this is a joi-button code rather than stray chat). 橘子 is a FIXED marker, not
// the secret — the entropy is in the two word slots and the number, which is
// why an attacker knowing the shape gains nothing.
//
// ===========================================================================
// WHY THESE WORDS, AND ONLY THESE
// ===========================================================================
// The banks are hand-curated to be concrete, everyday, apolitical nouns and
// verb phrases — the opposite of anything a keyword filter watches for. A large
// scraped word list would be the wrong tool twice over: it would sooner or later
// include a term that is itself filtered (so the danmaku silently vanishes — the
// exact failure this feature exists to avoid), and it would include homophones
// and loaded words a human curator can see and a frequency list cannot. Adding
// words is safe and welcome; the constraint is that each one is boring.
//
// ===========================================================================
// ENTROPY, MEASURED FROM THE BANKS BELOW (see CHALLENGE_ENTROPY_BITS)
// ===========================================================================
// The threat is online guessing: an attacker posts danmaku in the owner's public
// room hoping to match a victim's LIVE pending phrase before it expires (10 min),
// which would bind the attacker's open_id into the victim's login. Bilibili rate-
// limits danmaku (a normal account manages roughly one every couple of seconds,
// a fresh account far fewer), so a single code's whole 10-minute life admits a
// few hundred guesses at most, against a space of ~200k phrases. That is the
// budget this size is chosen against — not offline brute force, which never
// applies because a phrase is only ever guessable by posting it live and in view.
// challenge-phrase.test.mjs asserts the entropy floor so a future edit to the
// banks cannot quietly shrink it.

import { randomInt } from 'node:crypto'

// 场景 / 时间 / 地点 — the setting. All concrete, none loaded.
export const SCENE = Object.freeze([
  '深海', '云端', '屋顶', '清晨', '黄昏', '雨后', '深夜', '窗边',
  '林间', '山顶', '河畔', '街角', '书房', '花园', '海边', '雪地',
  '麦田', '荷塘', '竹林', '码头', '灯下', '桥上', '田野', '草原',
  '溪边', '果园', '庭院', '阳台', '车站', '旧城', '星空', '月下',
  '晨雾', '暖阳', '初春', '盛夏', '深秋', '寒冬', '巷口', '渡口',
  '山谷', '湖心', '沙洲', '崖边', '雾里', '檐下', '池畔', '岛上',
])

// 动作 / 状态 — what the orange is doing. Everyday, gentle, nothing to flag.
export const ACTION = Object.freeze([
  '在数星星', '正在打包', '学会了游泳', '开始睡觉', '晒着太阳', '写着日记',
  '煮了咖啡', '读完了书', '种下了花', '追着风筝', '听着雨声', '画着地图',
  '叠着纸船', '哼着小调', '堆着雪人', '收着行李', '点亮了灯', '练习跳舞',
  '修理时钟', '擦亮了窗', '翻着相册', '缝着口袋', '烤着面包', '织着围巾',
  '数着落叶', '追赶影子', '搭起帐篷', '整理书架', '浇着菜园', '放飞气球',
  '拼着积木', '记着菜谱', '编着故事', '系着鞋带', '扫着落花', '等着日出',
  '写着诗', '钓着月亮', '追着萤火', '数着雨滴', '晾着被子', '摆弄相机',
  '收集贝壳', '临摹字帖', '打理盆栽', '烘着饼干', '折着千纸鹤', '守着灯塔',
])

// The number slot: 第 N 颗. Reads naturally and multiplies the space. Starts at
// 2 (第1颗 reads oddly on its own) and stays two-digit-friendly for length.
const NUMBER_MIN = 2
const NUMBER_MAX = 99

/**
 * bits of entropy this generator produces, computed — not asserted by hand —
 * from the bank sizes and number range, so it moves with the banks.
 */
export const CHALLENGE_ENTROPY_BITS =
  Math.log2(SCENE.length * ACTION.length * (NUMBER_MAX - NUMBER_MIN + 1))

/**
 * One challenge phrase. `pick` is injectable for tests; it defaults to a
 * CSPRNG (randomInt is uniform over [0, n)).
 *
 * @param {(n: number) => number} [pick]  returns an int in [0, n)
 * @returns {string} e.g. 「深海的第7颗橘子在数星星」
 */
export function generateChallengePhrase(pick = randomInt) {
  const scene = SCENE[pick(SCENE.length)]
  const action = ACTION[pick(ACTION.length)]
  const n = NUMBER_MIN + pick(NUMBER_MAX - NUMBER_MIN + 1)
  return `${scene}的第${n}颗橘子${action}`
}

/**
 * The normal form used on BOTH sides of a danmaku match: NFKC folds full-width
 * digits and punctuation the danmaku box loves to insert (７ -> 7), and stripping
 * whitespace lets a visitor who types 「深海的 第7颗 橘子 在数星星」 still match.
 * The phrases themselves carry no whitespace, so this only ever helps.
 */
export function normalizeForMatch(text) {
  return typeof text === 'string' ? text.normalize('NFKC').replace(/\s+/g, '') : ''
}

/**
 * Does a danmaku carry this phrase? Containment, not equality: the phrase reads
 * like a sentence, so a visitor may wrap it in words of their own
 * (「今天也发一句：深海的第7颗橘子在数星星」) and still be understood — the same
 * latitude the old letter-code matcher gave by scanning for tokens.
 */
export function danmakuCarriesPhrase(danmakuText, phrase) {
  const normalPhrase = normalizeForMatch(phrase)
  if (normalPhrase === '') return false
  return normalizeForMatch(danmakuText).includes(normalPhrase)
}
