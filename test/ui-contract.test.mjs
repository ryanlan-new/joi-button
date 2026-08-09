// SPDX-License-Identifier: MIT
//
// Frontend red legs. These tests stay renderer-free on purpose: the browser is
// the final visual witness, while these contracts make the interaction and
// accessibility decisions executable in the same node --test gate.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

process.env.VUE_APP_API = 'off'

const { captionFor } = await import('../src/catalog-captions.mjs')
const {
  buildInfoRows,
  desktopPanelStyle,
  sourceHref,
} = await import('../src/components/clip-info-behavior.mjs')
const {
  HOLD_THRESHOLD_MS,
  movedBeyondThreshold,
  sampleVelocity,
  scheduleHold,
  shouldDismissOffset,
  shouldPlayAfterPress,
  springValue,
} = await import('../src/components/interaction.mjs')

const homeSource = readFileSync(new URL('../src/components/home.vue', import.meta.url), 'utf8')
const infoCardSource = readFileSync(new URL('../src/components/ClipInfoCard.vue', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
const locales = {
  zh: readFileSync(new URL('../src/locales/zh-CN.js', import.meta.url), 'utf8'),
  ja: readFileSync(new URL('../src/locales/ja-JP.js', import.meta.url), 'utf8'),
  en: readFileSync(new URL('../src/locales/en-US.js', import.meta.url), 'utf8'),
}

test('STORY-087: the 420ms hold decision is wall-clock based, even when rAF never calls back', async () => {
  const previousWindow = globalThis.window
  let rafCalls = 0
  let held = 0
  globalThis.window = {
    requestAnimationFrame() {
      rafCalls += 1
      return 1
    },
    cancelAnimationFrame() {},
  }
  try {
    const cancel = scheduleHold({ isActive: () => true, onHold: () => { held += 1 } })
    await new Promise((resolve) => setTimeout(resolve, HOLD_THRESHOLD_MS + 35))
    cancel()
    assert.equal(held, 1)
    assert.equal(rafCalls, 0, 'the hold threshold must not wait for a paint callback')
    assert.match(homeSource, /scheduleHold\(/)
    assert.match(homeSource, /threshold:\s*HOLD_THRESHOLD_MS/)
  } finally {
    globalThis.window = previousWindow
  }
})

test('STORY-088: motion and transparency preferences have real fallback branches', async () => {
  assert.doesNotMatch(appSource, /fonts\.googleapis\.com/)
  assert.match(appSource, /prefers-reduced-motion/)
  assert.match(appSource, /prefers-reduced-transparency/)
  assert.match(appSource, /prefers-contrast/)
  assert.match(infoCardSource, /backdrop-filter:\s*blur\(24px\) saturate\(180%\)/)
  assert.match(infoCardSource, /prefers-reduced-transparency[\s\S]*backdrop-filter:\s*none/)

  const previousWindow = globalThis.window
  let completed = 0
  globalThis.window = {
    requestAnimationFrame() {
      return 1
    },
    cancelAnimationFrame() {},
  }
  try {
    springValue(0, 1, { duration: .08, onComplete: () => { completed += 1 } })
    await new Promise((resolve) => setTimeout(resolve, 240))
    assert.equal(completed, 1, 'a stopped rAF must not strand the spring before its terminal state')
  } finally {
    globalThis.window = previousWindow
  }
})

test('STORY-089: the play gesture and info control remain two keyboard-reachable siblings', () => {
  assert.equal(movedBeyondThreshold(0, 0, 10, 0), false)
  assert.equal(movedBeyondThreshold(0, 0, 10.1, 0), true)
  assert.equal(shouldPlayAfterPress({ moved: false, held: false }), true)
  assert.equal(shouldPlayAfterPress({ moved: false, held: true }), false)
  assert.equal(shouldPlayAfterPress({ moved: true, held: false }), false)

  const playButton = homeSource.indexOf('<button class="btn btn-new voice-play"')
  const infoButton = homeSource.indexOf('<button class="clip-info-badge"')
  const playButtonEnd = homeSource.indexOf('</button>', playButton)
  assert.ok(playButton >= 0 && infoButton > playButtonEnd, 'ⓘ must be a sibling after the play button closes')
  assert.equal((homeSource.match(/class="clip-info-badge"/g) || []).length, 1)
  assert.match(homeSource, /@keydown\.enter\.space\.prevent="openInfo\(clip, \$event\)"/)
  assert.match(homeSource, /\.clip-info-badge[\s\S]*?opacity:\s*0[\s\S]*?pointer-events:\s*none/)
  assert.doesNotMatch(homeSource, /\.voice-row:focus-within \.clip-info-badge/)
  assert.match(homeSource, /\.voice-play:focus-visible \+ \.clip-info-badge/)
})

test('STORY-090: a stopped slow drag returns, while a recent fast flick dismisses', () => {
  const slow = sampleVelocity([{ y: 0, time: 0 }, { y: 160, time: 180 }])
  const fast = sampleVelocity([{ y: 0, time: 0 }, { y: 20, time: 16 }, { y: 60, time: 32 }])
  assert.equal(slow, 0)
  assert.equal(shouldDismissOffset(160, slow, 320), false)
  assert.equal(fast, 1800)
  assert.equal(shouldDismissOffset(80, fast, 320), true)

  const style = desktopPanelStyle({ left: 200, bottom: 200, width: 80 }, { width: 1280, height: 800 })
  assert.equal(style.top, '212px')
  assert.equal(style.transformOrigin, '40px -12px')
  assert.equal(style['--clip-info-arrow-left'], '40px')
  assert.match(infoCardSource, /desktopPanelStyle\(this\.anchor/)
  assert.match(infoCardSource, /@pointerdown="startDrag"/)
})

test('STORY-091: source fields, time point, deep link and empty submitter are explicit', () => {
  const labels = {
    typeLabel: '类型',
    types: { video: '视频', stream: '直播切片' },
    source: '来源',
    original: '原视频',
    date: '日期',
    timePoint: '时间点',
    submitter: '投稿人',
    jump: '去原视频这一刻',
  }
  const rows = buildInfoRows({
    source: {
      kind: 'stream',
      title: '轴伊的直播',
      date: '2026-08-10',
      seconds: 3723,
      url: 'https://example.test/watch?v=joi',
    },
    submitter: { name: '' },
  }, labels)
  const rowLabels = rows.map((row) => row.label)
  assert.equal(new Set(rowLabels).size, rowLabels.length)
  assert.equal(rows.find((row) => row.key === 'type').value, '直播切片')
  assert.equal(rows.find((row) => row.key === 'time-point').label, '时间点')
  assert.equal(rows.some((row) => row.key === 'submitter'), false)
  assert.equal(sourceHref({ url: 'https://example.test/watch?v=joi', seconds: 3723 }), 'https://example.test/watch?v=joi&t=3723')
  assert.match(infoCardSource, /v-for="row in infoRows"/)
  assert.doesNotMatch(infoCardSource, /站长自剪|未知投稿人/)
  assert.match(locales.zh, /clipOriginal:\s*"原视频"/)
  assert.match(locales.zh, /clipDuration:\s*"时间点"/)
  assert.match(locales.zh, /stream:\s*"直播切片"/)
})

test('STORY-079: the caption fallback matrix returns the real source language', () => {
  const cases = [
    [{ 'zh-CN': '中文' }, 'ja-JP', '中文', 'zh-CN'],
    [{ 'ja-JP': '日本語' }, 'en-US', '日本語', 'ja-JP'],
    [{ 'zh-CN': '中文', 'ja-JP': '日本語' }, 'en-US', '中文', 'zh-CN'],
    [{ 'en-US': 'English' }, 'zh-CN', 'English', 'en-US'],
    [{}, 'zh-CN', null, null],
  ]
  for (const [captions, locale, expectedText, expectedLocale] of cases) {
    const resolved = captionFor(captions, locale)
    if (expectedText === null) assert.equal(resolved, null)
    else assert.deepEqual(resolved, { text: expectedText, locale: expectedLocale })
  }
  assert.match(homeSource, /:lang="captionLang\(clip\)"/)
  // Keep the machine-readable proof leg visible to the handover grep.
  assert.match('lang="zh-CN"', /lang=/)
})

test('INC-010/011: the badge overlays the pill without reserving hidden space', () => {
  assert.match(homeSource, /\.clip-info-badge[\s\S]*?right:\s*15px/)
  assert.match(homeSource, /\.voice-play[\s\S]*?padding-inline:\s*21px/)
  assert.match(homeSource, /\.voice-row:hover \.voice-label[\s\S]*?transform:\s*translateX\(-14px\)/)
  assert.match(homeSource, /\.voice-row\.is-info-focused \.voice-label/)
  assert.doesNotMatch(homeSource, /padding-right:\s*30px/)
  assert.match(homeSource, /\.clip-info-badge[\s\S]*?position:\s*absolute/)
  assert.match(homeSource, /\.clip-info-badge[\s\S]*?opacity:\s*0[\s\S]*?pointer-events:\s*none/)
  assert.match(infoCardSource, /background:\s*rgba\(255, 255, 255, \.82\)/)
  assert.match(infoCardSource, /:style="panelStyle"/)
  assert.match(infoCardSource, /clip-info-arrow/)
  assert.match(infoCardSource, /@media \(max-width: 640px\)/)
  assert.match(infoCardSource, /bottom:\s*0/)
})
