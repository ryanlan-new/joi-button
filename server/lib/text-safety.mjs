/**
 * Ingest guard for submitter-authored text.
 *
 * Submitted captions end up as vue-i18n *message values* — src/main.js folds
 * every `description` in voices.json into the locale bundles, and home.vue
 * renders them with $t('voice.' + name). So submitter text is handed to a
 * message compiler, not to a text node.
 *
 * Every claim below was measured against the vue-i18n actually installed
 * (8.21.1, node_modules/vue-i18n/src/{format,index}.js) using an i18n instance
 * built the way main.js builds it — importantly, with no fallbackLocale.
 * Re-run those checks if that version moves.
 *
 * Not a concern here, and deliberately not guarded: HTML. $t()'s result reaches
 * the page through mustache interpolation, which Vue escapes, and there is no
 * v-html anywhere in src/. "<b>hi</b>" renders as visible angle brackets, which
 * is ugly, not dangerous. If a v-html ever appears, this file needs a new rule.
 */

/**
 * Longest caption today: 54 code points — "Arctic Eggs_don't approach me...
 * (extremly scared ver.)" (en-US). Across all 45 captions in src/voices.json
 * (3 categories + 12 clips, 3 locales each) the median is 12 and p90 is 39.
 * 80 is ~1.5x the longest thing the owner has actually written: room to grow,
 * without letting a paragraph into a Bootstrap button label.
 */
export const CAPTION_MAX_LENGTH = 80;

/** Stable codes; the route layer owns the wording and the locale. */
export const CAPTION_REJECTIONS = Object.freeze({
  NOT_A_STRING: 'not_a_string',
  EMPTY: 'empty',
  TOO_LONG: 'too_long',
  LONE_SURROGATE: 'lone_surrogate',
  CONTROL_CHARACTER: 'control_character',
  BIDI_CONTROL: 'bidi_control',
  INVISIBLE_CHARACTER: 'invisible_character',
  LINKED_MESSAGE: 'linked_message'
});

/*
 * Character classes are written as escape sequences and each is defined exactly
 * once: validateCaption and escapeForI18n build their regexes from these, so
 * the gate and the sanitiser cannot drift apart. Spelling them as literal bytes
 * would put invisible characters in the source, where grep cannot see them and
 * a stray editor pass can silently delete them.
 */

// C0 + DEL + C1. Tested after trimming, so a trailing "\n" is normalised away
// while an interior one is refused: a caption is a single-line button label.
const CONTROL_CHARACTERS = '\\u0000-\\u001F\\u007F-\\u009F';

// ALM, LRM, RLM, the embedding/override family and the isolates. Their whole
// purpose is to make rendered order differ from stored order — a reviewer can
// approve one string while visitors are shown another, and an unterminated
// override leaks out into the surrounding UI. Genuine RTL text does not need
// them; the Unicode bidi algorithm derives direction from the letters.
const BIDI_CONTROLS = '\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069';

// Zero-width space, word joiner, ZWNBSP. Deliberately NOT ZWJ (U+200D) or
// ZWNJ (U+200C): those carry meaning — emoji sequences and Arabic/Indic
// shaping need them, and stripping them would corrupt legitimate text.
const INVISIBLE_CHARACTERS = '\\u200B\\u2060\\uFEFF';

// An unpaired surrogate survives JSON.stringify but becomes U+FFFD the moment
// catalog.json is encoded as UTF-8, so it corrupts the published file rather
// than this one record.
const LONE_SURROGATE =
  '[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]';

const HAS_CONTROL_CHARACTER = new RegExp(`[${CONTROL_CHARACTERS}]`);
const HAS_BIDI_CONTROL = new RegExp(`[${BIDI_CONTROLS}]`);
const HAS_INVISIBLE_CHARACTER = new RegExp(`[${INVISIBLE_CHARACTERS}]`);
const HAS_LONE_SURROGATE = new RegExp(LONE_SURROGATE);

const STRIP_UNRENDERABLE = new RegExp(
  `[${CONTROL_CHARACTERS}${BIDI_CONTROLS}${INVISIBLE_CHARACTERS}]|${LONE_SURROGATE}`,
  'g'
);

/*
 * vue-i18n's linked-message trigger. index.js runs the link pass whenever a
 * message contains "@:" or "@.", and substitutes everything matching
 *   /@(?:\.[a-z]+)?:(?:[\w\-_|.]+|\([\w\-_|.]+\))/g
 * This pattern matches only the *prefix*, making it a strict superset of what
 * can fire — that covers the parenthesised form @:(info.title), which a
 * key-shaped pattern would miss — and the modifier class is widened to [A-Za-z]
 * so the guard stays correct if vue-i18n ever accepts an uppercase modifier.
 * It over-matches "@: " with a space, which is harmless today because the key
 * charset needs at least one word character. That costs a submitter one edit;
 * under-matching would cost a silent content swap.
 */
const LINKED_MESSAGE = /@(?:\.[A-Za-z]+)?:/;
const LINKED_MESSAGE_AT = /@(?=(?:\.[A-Za-z]+)?:)/g;

/*
 * Fullwidth look-alikes: U+FF5B, U+FF5D, U+FF5C, U+FF20.
 *
 * vue-i18n 8 has NO escape syntax. format.js `parse()` special-cases exactly
 * two things — "{", and a "%" immediately preceding "{" — with no backslash
 * form and no {'{'} literal (that arrived in vue-i18n 9). Substituting a
 * different code point is therefore the only mechanism available. It is lossy,
 * since the glyph changes, which is precisely why it is used only on the
 * constructs that garble the submitter's own text, and not on the one that
 * reads other people's.
 */
const FULLWIDTH_LEFT_BRACE = '｛';
const FULLWIDTH_RIGHT_BRACE = '｝';
const FULLWIDTH_VERTICAL_LINE = '｜';
const FULLWIDTH_AT = '＠';

/**
 * Gate for raw submitter input.
 *
 * Pairs with escapeForI18n: validate the raw text, store escapeForI18n(raw).
 * escapeForI18n only strips and substitutes 1:1, so it can never turn a caption
 * that passed this gate into one that would fail it.
 *
 * @param {string} text
 * @param {{ maxLength?: number }} [options]
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function validateCaption(text, options = {}) {
  const { maxLength = CAPTION_MAX_LENGTH } = options;
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new TypeError('validateCaption: maxLength must be a positive integer');
  }
  if (typeof text !== 'string') {
    return reject(CAPTION_REJECTIONS.NOT_A_STRING);
  }

  // String.prototype.trim() strips the whole Unicode WhiteSpace + LineTerminator
  // set, so NBSP (U+00A0) and the ideographic space (U+3000) are covered here
  // and need no rule of their own.
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return reject(CAPTION_REJECTIONS.EMPTY);
  }

  // Code points, not UTF-16 units: an emoji is one character to the person
  // typing it, and charging them two would be an arbitrary tax.
  if ([...trimmed].length > maxLength) {
    return reject(CAPTION_REJECTIONS.TOO_LONG);
  }

  if (HAS_LONE_SURROGATE.test(trimmed)) {
    return reject(CAPTION_REJECTIONS.LONE_SURROGATE);
  }
  if (HAS_CONTROL_CHARACTER.test(trimmed)) {
    return reject(CAPTION_REJECTIONS.CONTROL_CHARACTER);
  }
  if (HAS_BIDI_CONTROL.test(trimmed)) {
    return reject(CAPTION_REJECTIONS.BIDI_CONTROL);
  }
  if (HAS_INVISIBLE_CHARACTER.test(trimmed)) {
    return reject(CAPTION_REJECTIONS.INVISIBLE_CHARACTER);
  }

  /*
   * REJECTED — where "{}" and "|" below are merely escaped.
   *
   * Measured on 8.21.1: the caption "shoutout to @:info.title !" renders as
   * "shoutout to Joi Button !" through plain $t() with no values. The link pass
   * runs before interpolation and needs no params object, so it fires on the
   * exact call path home.vue already uses; "@.upper:" applies a modifier on top.
   * When the target key does not exist there is no fallbackLocale to catch it,
   * so the raw key path is spliced into the caption instead.
   *
   * That is a read of data the submitter does not own — a different kind of
   * thing from mangling their own sentence, and never something a person meant
   * to type. Refusing it hands them a fixable error instead of silently
   * rewriting a character they chose on purpose. A bare "@" is untouched:
   * "thanks @Joi" and "a@b.com" both pass.
   */
  if (LINKED_MESSAGE.test(trimmed)) {
    return reject(CAPTION_REJECTIONS.LINKED_MESSAGE);
  }

  return { ok: true, reason: null };
}

/**
 * Canonical stored form of a caption. Total: it always returns something safe,
 * because admin-authored translations reach the same locale bundle without
 * necessarily passing validateCaption first.
 *
 * Idempotent — the substitutes are outside the set it rewrites.
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeForI18n(text) {
  if (typeof text !== 'string') {
    throw new TypeError('escapeForI18n: text must be a string');
  }

  // Order is load-bearing: unrenderable characters go first so they cannot be
  // used to smuggle a construct past the substitutions below. "@<ZWSP>:info.title"
  // would otherwise pass through here untouched and become a live link as soon
  // as any later stage normalised the zero-width space away. Removal can weld
  // two words together, which is exactly why validateCaption refuses these
  // outright — this pass is the second line of defence, not the first.
  let out = text.trim().replace(STRIP_UNRENDERABLE, '');

  /*
   * ESCAPED, not rejected.
   *
   * "{foo}" is inert on today's call path: format.js `interpolate()` returns
   * the message untouched when no values object is passed, and home.vue passes
   * none. It goes live the instant any caller adds params — "cost is {price}"
   * then renders as "cost is  ", because compile() pushes undefined for the
   * missing name and join('') swallows it. The damage is the submitter's own
   * words vanishing, never foreign content appearing: a lower class of harm
   * than a linked message, and braces are plausible prose. So: made inert
   * rather than refused.
   *
   * This fixes a second bug for free. parse() drops a "%" that immediately
   * precedes "{" (its rails-syntax skip), so "50%{price} off" loses the percent
   * sign too. With the brace substituted, "%" is no longer followed by "{" and
   * survives — verified, not inferred.
   */
  out = out.split('{').join(FULLWIDTH_LEFT_BRACE).split('}').join(FULLWIDTH_RIGHT_BRACE);

  /*
   * ESCAPED. "|" is the plural separator, but only on the $tc path: fetchChoice
   * splits the message and returns ONE branch, so "left|right" renders as
   * "left" and the rest is silently deleted. Nothing in src/ calls $tc today,
   * which makes this latent rather than live — and latent is exactly the case
   * for escaping instead of rejecting. A pipe is legitimate prose, and
   * neutralising it means the caption stays whole no matter which render call
   * a future page reaches for.
   */
  out = out.split('|').join(FULLWIDTH_VERTICAL_LINE);

  /*
   * Defence in depth for the construct validateCaption refuses. Only the "@"
   * that forms the trigger is substituted, via lookahead, so ordinary "@Joi"
   * survives. Length-preserving like the substitutions above, which is what
   * keeps this function from pushing a valid caption past the length limit.
   */
  out = out.replace(LINKED_MESSAGE_AT, FULLWIDTH_AT);

  return out;
}

function reject(reason) {
  return { ok: false, reason };
}
