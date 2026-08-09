/** The caption for this locale, or null when there is not one. */
export function pickCaption(captions, locale) {
  const text = captions[locale]
  // '' is treated as absent. The server never emits it (an absent locale is an
  // absent key), and a hand-written document that does would otherwise render a
  // button with no text on it.
  if (typeof text !== 'string' || text === '') return null
  return text
}

/** Resolve exact locale first, then the ruled zh-CN -> ja-JP -> en-US chain. */
export function captionFor(captions, locale) {
  const exact = pickCaption(captions, locale)
  if (exact !== null) return { text: exact, locale }
  for (const fallback of ['zh-CN', 'ja-JP', 'en-US']) {
    if (fallback === locale) continue
    const text = pickCaption(captions, fallback)
    if (text !== null) return { text, locale: fallback }
  }
  return null
}
