#!/usr/bin/env node

// Zero-dependency Node 22 example for the third-party submission API.
// Usage: JOI_BUTTON_URL=https://example.invalid node docs/api-client.mjs sample.mp3

import { openAsBlob } from 'node:fs'
import { basename, extname } from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'

const baseUrl = required('JOI_BUTTON_URL').replace(/\/+$/, '')
const audioPath = process.argv[2] ?? process.env.JOI_BUTTON_AUDIO_FILE ?? 'sample.mp3'
const clientLabel = process.env.JOI_BUTTON_CLIENT ?? 'joi-button-example'
const userAgent = 'joi-button-example/1.0'

const audioTypes = Object.freeze({
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
})

function required(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`set ${name} before running this example`)
  }
  return value
}

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options)
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(`${response.status} ${path}: ${JSON.stringify(body)}`)
  }
  return body
}

function jsonPost(path, body) {
  return jsonRequest(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const contract = await jsonRequest('/api/submit/contract')
  const group = contract.groups?.[0]
  const locale = contract.locales?.[0]
  if (group === undefined || locale === undefined) {
    throw new Error('the contract has no active group and locale to submit')
  }

  const challenge = await jsonPost('/api/auth/challenge', { client: clientLabel })
  if (challenge.state !== 'waiting' || typeof challenge.pollToken !== 'string') {
    throw new Error(`the API did not return a waiting challenge: ${JSON.stringify(challenge)}`)
  }

  console.log(`请在直播间发送：${challenge.challenge}`)
  const prompt = createInterface({ input, output })
  await prompt.question('发送后按 Enter 开始轮询：')
  prompt.close()

  let verified = await jsonPost('/api/auth/poll', { pollToken: challenge.pollToken })
  while (verified.state === 'waiting') {
    await sleep(Math.max(250, Number(verified.pollAfterMs) || 1000))
    verified = await jsonPost('/api/auth/poll', { pollToken: challenge.pollToken })
  }
  if (verified.state !== 'verified' || typeof verified.token !== 'string') {
    throw new Error(`the identity challenge did not verify: ${JSON.stringify(verified)}`)
  }

  const extension = extname(audioPath).toLowerCase()
  const contentType = audioTypes[extension]
  if (contentType === undefined) {
    throw new Error(`unsupported example file extension: ${extension || '(none)'}`)
  }
  const fileName = basename(audioPath)
  const form = new FormData()
  form.set('metadata', JSON.stringify({
    items: [{
      key: 'clip-1',
      name: fileName,
      caption: { locale: locale.code, text: `Example submission: ${fileName}` },
      groupId: group.id,
      note: null,
    }],
  }))
  form.set('file:clip-1', await openAsBlob(audioPath, { type: contentType }), fileName)

  const result = await jsonRequest('/api/submit', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${verified.token}`,
      'User-Agent': userAgent,
    },
    body: form,
  })
  if (typeof result.batchId !== 'string') {
    throw new Error(`the submission did not return a batchId: ${JSON.stringify(result)}`)
  }
  console.log(`batchId: ${result.batchId}`)
  console.log('已进入审核队列。')
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
