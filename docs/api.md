# Third-party submission API

The API is same-origin with the site. Set `JOI_BUTTON_URL` to the deployment URL; do not hard-code a deployment-specific host in a client.

This flow requires a person to send the challenge phrase as a danmaku in the configured live room. There is no password-only or unattended token-creation path. A complete zero-dependency Node 22 client is available at [`docs/api-client.mjs`](api-client.mjs): it reads the live contract, prompts for the danmaku, polls, submits one file, and prints `batchId`.

```sh
JOI_BUTTON_URL="https://your-instance.example" node docs/api-client.mjs sample.mp3
```

## 1. Obtain an API token

API credentials are separate from browser cookies. Start a challenge:

```sh
curl -sS -X POST "$JOI_BUTTON_URL/api/auth/challenge" \
  -H 'Content-Type: application/json' \
  --data '{"client":"my-importer"}'
```

The response contains `challenge`, `pollToken`, `roomId`, and `expiresAt`. Post the challenge phrase as a danmaku in the returned room, then poll:

```sh
curl -sS -X POST "$JOI_BUTTON_URL/api/auth/poll" \
  -H 'Content-Type: application/json' \
  --data "{\"pollToken\":\"$JOI_BUTTON_POLL_TOKEN\"}"
```

The verified response contains a one-time `token`. Store it securely; it is not shown again. The token lasts 30 days. A single submitter may have at most five active API tokens; issuing a sixth revokes the oldest active token. Polling the same verified challenge twice returns `token_already_issued`.

Every Bearer request must include a `User-Agent`. An API token is never accepted as a browser cookie, and an invalid Bearer header never falls back to a cookie.

## 2. Read the contract

```sh
curl -sS "$JOI_BUTTON_URL/api/submit/contract"
```

The response is public and contains `contractVersion`, active `groups`, supported `locales`, `limits`, accepted audio MIME types, and the authoritative error-code list. Use the returned group and locale values instead of hard-coding them; retired groups are omitted.

## 3. Submit a batch

The metadata field is JSON. Each metadata `key` maps to one multipart file named `file:<key>`:

```sh
curl -sS -X POST "$JOI_BUTTON_URL/api/submit" \
  -H "Authorization: Bearer $JOI_BUTTON_API_TOKEN" \
  -H 'User-Agent: my-importer/1.0' \
  -F "metadata={\"items\":[{\"key\":\"clip-1\",\"name\":\"Hello\",\"caption\":{\"locale\":\"$JOI_BUTTON_LOCALE\",\"text\":\"Hello\"},\"groupId\":\"$JOI_BUTTON_GROUP_ID\",\"note\":null}]};type=application/json" \
  -F "file:clip-1=@$JOI_BUTTON_AUDIO_FILE;type=audio/mpeg"
```

Set `JOI_BUTTON_GROUP_ID` and `JOI_BUTTON_LOCALE` from the contract response. Validation, deduplication, loudness normalization, and persistence are the same implementation used by the web form. A successful response contains `batchId`, `accepted`, `rejected`, and per-item verdicts. A second batch for the same submitter within 60 seconds returns `429`, `Retry-After`, and `{ "error": "rate_limited", "retryAfterSeconds": N }`.

Web and API submissions share both rate dimensions: the submitter and the individual session may each submit at most one batch in a rolling 60-second window. The storage gate uses `statfs`, preserves a fixed 256 MiB reserve, and accounts for the worst-case bytes already in flight. Admission is allowed only when `availableBytes > reserveBytes + inflightBytes`; public submissions and admin uploads are refused before their first disk write when it is not.

Node 22+ needs no package for the same request:

```js
import { openAsBlob } from 'node:fs'

const baseUrl = process.env.JOI_BUTTON_URL
const token = process.env.JOI_BUTTON_API_TOKEN
const audioFile = process.env.JOI_BUTTON_AUDIO_FILE

const form = new FormData()
form.set('metadata', JSON.stringify({
  items: [{
    key: 'clip-1',
    name: 'Hello',
    caption: { locale: 'en-US', text: 'Hello' },
    groupId: 'daily',
    note: null,
  }],
}))
form.set('file:clip-1', await openAsBlob(audioFile), 'clip-1.mp3')

const response = await fetch(`${baseUrl}/api/submit`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'my-importer/1.0',
  },
  body: form,
})
console.log(response.status, await response.json())
```

## 4. Inspect and revoke

The same token can call `GET /api/me`, `GET /api/submit/preflight`, and `GET /api/my/submissions`. Revoke only the current token with:

```sh
curl -sS -X POST "$JOI_BUTTON_URL/api/auth/revoke" \
  -H "Authorization: Bearer $JOI_BUTTON_API_TOKEN" \
  -H 'User-Agent: my-importer/1.0'
```

Revoke all API tokens for the submitter through `/api/auth/revoke-all`. That endpoint starts a fresh danmaku challenge and accepts the resulting `pollToken`; it never treats possession of an existing API token as sufficient authority. The fresh proof is spent after revocation, so its poll token cannot be replayed.

The contract endpoint is authoritative for the complete list. Standard refusals use `{ "error": { "code", "message" } }`; rate limiting and storage admission use the flat shapes documented above. Item-level failures carry the same code under each rejected item's verdict.

| Code | Meaning |
| --- | --- |
| `already_published` | The exact audio is already published. |
| `api_challenge_unavailable` | The live room could not be reached for an API challenge. |
| `api_identity_required` | This operation requires an API token. |
| `audio_processing_failed` | Loudness normalization failed. |
| `duplicate_in_batch` | The same file appears twice in one batch. |
| `empty_file` | The uploaded file is empty. |
| `expired_poll_token` | The API challenge poll token expired or was spent. |
| `file_too_large` | One file exceeds the configured size limit. |
| `group_choice_ambiguous` | Both an existing group and a new group were supplied. |
| `group_choice_required` | Every item needs an existing group or a new-group proposal. |
| `identity_required` | A verified browser or API identity is required. |
| `invalid_api_token` | The Bearer token is invalid, revoked, or expired. |
| `invalid_caption` | The caption cannot be used. |
| `invalid_client_label` | The API client label cannot be used. |
| `invalid_group_name` | The proposed group name cannot be used. |
| `invalid_name` | The item name cannot be used. |
| `invalid_note` | The item note cannot be used. |
| `invalid_source` | Source information must be an object. |
| `invalid_source_date` | The source date is not `YYYY-MM-DD`. |
| `invalid_source_kind` | The source type is not `video` or `stream`. |
| `invalid_source_seconds` | The source duration is not a non-negative number of seconds. |
| `invalid_source_title` | The source title cannot be used. |
| `invalid_source_url` | The source URL cannot be used. |
| `malformed_multipart` | The multipart upload ended before it was complete. |
| `metadata_malformed` | The metadata shape or item keys are invalid. |
| `metadata_missing` | A file has no matching metadata item. |
| `metadata_required` | The multipart request has no metadata field. |
| `missing_file` | An item has metadata but no matching file. |
| `multipart_required` | The submission must use multipart form data. |
| `no_items` | The submission has no clips. |
| `no_valid_items` | No item could be accepted, so nothing was saved. |
| `no_verification_in_progress` | No browser verification is currently active. |
| `note_too_long` | The encoded item note is too long. |
| `poll_token_required` | A poll token is required. |
| `rate_limited` | The submitter or session is inside the 60-second window. |
| `room_not_configured` | No live room is configured for identity verification. |
| `storage_exhausted` | Storage admission failed because the reserve could not be preserved. |
| `submitter_blocked` | The verified submitter is blocked from submitting. |
| `token_already_issued` | This verified poll token already issued its one-time token. |
| `too_many_fields` | The multipart request has too many fields. |
| `too_many_files` | The multipart request has too many files. |
| `too_many_items` | The batch exceeds the configured item limit. |
| `unknown_group` | The group does not exist or is retired. |
| `unknown_locale` | The locale is not published by this instance. |
| `unknown_poll_token` | The browser poll token is not known to its session. |
| `unreadable_audio` | The file cannot be read as supported audio. |
| `unreadable_duration` | The audio duration could not be determined. |
| `unsupported_audio_format` | The file format is not accepted. |
| `user_agent_required` | A Bearer request must include a User-Agent. |
| `verification_capacity` | Too many identity challenges are pending. |
