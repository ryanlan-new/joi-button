// SPDX-License-Identifier: MIT
//
// The Bilibili Live Open Platform transport — the thing that is actually
// listening when a visitor sends their one-time code as a danmaku.
//
// This module is the production half of danmaku-source.mjs's two-implementation
// shape. It owns the wire protocol and nothing else: the reference count, the
// lease TTL, the visitor verdict and the "were we listening continuously since
// the code was issued" arithmetic all live up there, and this file must not
// know about any of them. What it owes that lifecycle is exactly three methods
// (start / stop / heartbeat) and two callbacks (onDanmaku / onDisconnect), with
// one non-negotiable property: START MUST NOT RESOLVE UNTIL WE CAN HEAR THE
// ROOM, and a socket that has gone away must be REPORTED rather than papered
// over. The site has no OAuth to fall back on, so "we are deaf" and "the
// visitor has not sent it yet" are different answers to different people, and
// only this file knows which one is true.
//
// ---------------------------------------------------------------------------
// WHERE EVERY PROTOCOL DETAIL BELOW CAME FROM
//
// Two independent implementations were read, not remembered. Where they
// disagree, the disagreement is recorded at the point of use rather than
// silently resolved.
//
//   [OFFICIAL]  github.com/bilibili-openplatform/OpenLive_CSharpDemo (Bilibili's
//               own Live Open Platform demo), read 2026-08-01:
//                 OpenBLive/Runtime/Utilities/SignUtility.cs   (the signature)
//                 OpenBLive/Runtime/BApi.cs                    (host + paths + bodies)
//                 OpenBLive/Runtime/Data/PacketHeader.cs       (the 16-byte header)
//                 OpenBLive/Runtime/Data/Packet.cs             (auth/heartbeat packets)
//                 OpenBLive/Runtime/BLiveClient.cs             (dispatch, 30s WS beat)
//                 OpenBLive/Client/Data/AppStartInfo.cs        (start response shape)
//                 OpenBLive/Runtime/InteractivePlayHeartBeat.cs (20s app beat)
//   [BLIVEDM]   github.com/xfgryujk/blivedm @ dev, read 2026-08-01:
//                 blivedm/clients/open_live.py                 (gateway calls)
//                 blivedm/clients/ws_base.py                   (framing, batching)
//                 blivedm/models/open_live.py                  (LIVE_OPEN_PLATFORM_DM)
//   [SIGDEMO]   github.com/bilibili-openplatform/SignatureAlgorithm_DotnetDemo,
//               Signature_Algorithm_Demo/Program.cs — the SAME signature scheme
//               for a DIFFERENT product (member.bilibili.com/arcopen), which is
//               why its x-bili-signature-version is "2.0". Cited only to show
//               that the sort-and-join construction is the house standard; the
//               version constant here comes from the two Live sources above.
//
// NOT CONFIRMED, and flagged rather than invented:
//   * Whether the Open Platform's wss actually compresses. [BLIVEDM] ws_base.py
//     says it does ("web端已经不用zlib压缩了，但是开放平台会用" — the web no longer
//     uses zlib but the open platform does) and decodes it; [OFFICIAL]
//     BLiveClient.cs says the opposite in a comment ("no Zlib compress in
//     OpenBLive wss") and DROPS such packets on the floor. Decoding a format the
//     server never sends costs nothing; not decoding one it does send loses
//     every danmaku in the batch, and the loss is invisible — the socket stays
//     up and the visitor is told nothing arrived. So both are decoded.
//   * Whether wss_link can be empty or whether the ip/host/port fields of
//     [OFFICIAL] WebsocketInfoData.cs are ever the only thing returned. Only
//     wss_link is used, and its absence is an explicit refusal below rather than
//     an undefined dereference.
//   * The exact retry policy the platform wants. Neither source states one;
//     [BLIVEDM] retries at a constant 1s. The backoff here is this project's
//     choice, stated as such.
//
// KNOWN LIMIT OF THE RUNTIME, measured rather than assumed: Node's WebSocket
// cannot be forced closed, so a peer that is connected but silent costs one file
// descriptor per episode. It is counted rather than hidden — the full argument,
// the measurement and what it means operationally are at closeSocket().
//
// ---------------------------------------------------------------------------
// TWO THINGS THIS FILE DELIBERATELY DOES NOT DO
//
//   * It never writes to stdout or stderr. Every danmaku carries an open_id,
//     which is a stable pseudonymous handle for a real person; a log line is the
//     cheapest way to leak one somewhere nobody is guarding. danmaku-source.mjs
//     makes the same promise and this half would be the easy place to break it.
//   * No error it throws contains the request body. The /v2/app/start body
//     carries the room owner's auth code, which config.mjs reads with
//     read.secret() — an error message is a string that ends up in a log, and a
//     secret that reaches a log is a leaked secret. Errors carry the endpoint,
//     the HTTP status, the platform code and the request_id, which is what an
//     operator actually needs to open a support ticket.
//
// ---------------------------------------------------------------------------
// WHAT MAKES THIS GO RED
//
//   * Delete the `.sort()` in signOpenPlatformRequest() — the golden vector goes
//     red. The header object is built in [OFFICIAL] SignUtility.cs's insertion
//     order, which is NOT alphabetical, precisely so that the sort is the thing
//     producing the canonical string and not a coincidence of literal order. The
//     two orders give different signatures (proved in the test), and a wrong
//     signature comes back from the platform as an opaque code.
//   * Sign a re-serialised body instead of the bytes that are sent — the
//     "the gateway can verify what we sent" case goes red. The fake gateway
//     recomputes the signature from the received headers over the received
//     bytes; any re-encoding between signing and sending breaks content-md5.
//   * Advance past a HEARTBEAT_REPLY by its packet length — the reply's
//     pack_len excludes the echoed heartbeat body ([BLIVEDM] ws_base.py:415-419
//     calls this a server bug), so the walk lands mid-body and reads a garbage
//     header. Red input: a heartbeat reply frame with a body longer than four
//     bytes.
//   * JSON.parse the SEND_MSG_REPLY body instead of walking it — the
//     multi-packet zlib case goes red. That is the whole point of that case: a
//     naive parse works perfectly until the first compressed batch, and then
//     loses every danmaku inside it at once.
//   * Drop the endGameSession() call from the start() failure path, or from
//     teardown() before a re-dial — the "no session is left running" cases go
//     red. The lifecycle reconnects by calling start() again WITHOUT calling
//     stop() in between (see scheduleReconnect in danmaku-source.mjs), so if
//     start() did not release what it holds, every reconnect would leak one
//     session the platform believes is still running.
//   * Make the backoff a constant instead of a doubling, or let a start dial
//     while backing off — the backoff case goes red on the recorded delays and
//     on the gateway's call count respectively.
//   * Resolve start() on socket open instead of on AUTH_REPLY code 0 — the
//     "an auth rejection is not a listening socket" case goes red: the visitor
//     would be shown a code we cannot hear the answer to.
//   * Accept LIVE_OPEN_PLATFORM_DM_MIRROR as identity — the mirror case goes
//     red. A mirrored danmaku was sent in a different room; treating it as proof
//     of presence in ours would let someone verify without ever being here.
//   * Return a promise from heartbeat() — danmaku-source.mjs calls it
//     un-awaited inside a try/catch (startHeartbeat), so a rejected promise
//     becomes an unhandled rejection and takes the process down instead of
//     reaching the 'error' listeners. The "heartbeat never returns a thenable"
//     case is what holds that line.
// ---------------------------------------------------------------------------

import { createHash, createHmac, randomUUID } from 'node:crypto'
import { brotliDecompressSync, inflateSync } from 'node:zlib'

// ---------------------------------------------------------------------------
// protocol constants

/** [OFFICIAL] BApi.cs:36 — the test environment is http://test-live-open.biliapi.net */
export const OPEN_LIVE_BASE_URL = 'https://live-open.biliapi.com'

/** [OFFICIAL] BApi.cs:41-56, [BLIVEDM] open_live.py:21-23 (identical). */
export const OPEN_LIVE_PATHS = Object.freeze({
  start: '/v2/app/start',
  end: '/v2/app/end',
  heartbeat: '/v2/app/heartbeat',
})

export const SIGNATURE_METHOD = 'HMAC-SHA256'

/**
 * "1.0" for the LIVE open platform. [OFFICIAL] SignUtility.cs:39 and [BLIVEDM]
 * open_live.py:132 agree. [SIGDEMO] uses "2.0", but that demo targets
 * member.bilibili.com/arcopen — a different product with the same signature
 * construction. Sending the wrong version here fails with an opaque code, which
 * is why the two sources for THIS endpoint are what settle it.
 */
export const SIGNATURE_VERSION = '1.0'

/** [OFFICIAL] PacketHeader.cs:17 (KPacketHeaderLength), [BLIVEDM] '>I2H2I'. */
export const HEADER_BYTES = 16

/** [BLIVEDM] ws_base.py:37-54; the subset [OFFICIAL] PacketHeader.cs names agrees. */
export const OPERATION = Object.freeze({
  HANDSHAKE: 0,
  HANDSHAKE_REPLY: 1,
  HEARTBEAT: 2,
  HEARTBEAT_REPLY: 3,
  SEND_MSG: 4,
  SEND_MSG_REPLY: 5,
  DISCONNECT_REPLY: 6,
  AUTH: 7,
  AUTH_REPLY: 8,
})

/** [BLIVEDM] ws_base.py:29-33, [OFFICIAL] PacketHeader.cs ProtocolVersion enum. */
export const PROTO_VERSION = Object.freeze({
  NORMAL: 0,
  HEARTBEAT: 1,
  DEFLATE: 2,
  BROTLI: 3,
})

/** [BLIVEDM] ws_base.py:62-64. */
export const AUTH_REPLY_OK = 0

/** [BLIVEDM] handlers.py:116, [OFFICIAL] BLiveClient.cs ProcessNotice. */
export const DANMAKU_CMD = 'LIVE_OPEN_PLATFORM_DM'

/**
 * The server telling us it has stopped pushing — usually an app heartbeat that
 * timed out. [BLIVEDM] open_live.py:297-304 treats it as "re-open the project".
 */
export const INTERACTION_END_CMD = 'LIVE_OPEN_PLATFORM_INTERACTION_END'

/**
 * [BLIVEDM] open_live.py:215-217 — /v2/app/end answering 7000 or 7003 means the
 * session was already closed, which is the outcome we wanted.
 */
export const SESSION_ALREADY_CLOSED_CODES = Object.freeze([7000, 7003])

/**
 * [BLIVEDM] open_live.py:261-266 — 7003 from /v2/app/heartbeat means the session
 * was closed under us. There is nothing to keep alive and we are already deaf.
 */
export const SESSION_CLOSED_CODE = 7003

export const TRANSPORT_DEFAULTS = Object.freeze({
  /**
   * [OFFICIAL] AppStartInfo.cs on game_id: "心跳保持20s-60s调用一次,超过60s无心跳
   * 自动关闭" — beat every 20-60s, no beat for 60s and the platform closes it.
   * The lifecycle's own heartbeatIntervalMs (20s) is what drives this; the value
   * here only bounds how many misses we tolerate before admitting deafness.
   */
  maxHeartbeatFailures: 3,
  /** [OFFICIAL] BLiveClient.cs:426 (30 * 1000), [BLIVEDM] ws_base.py:89. */
  wsHeartbeatIntervalMs: 30_000,
  /**
   * [BLIVEDM] ws_base.py:268 sets receive_timeout = heartbeat_interval + 5. A
   * socket that is open but silent is the exact shape of undetected deafness:
   * the OS has no complaint, we have no data, and without this we would keep
   * telling visitors we are listening.
   */
  wsIdleTimeoutMs: 35_000,
  requestTimeoutMs: 5_000,
  connectTimeoutMs: 5_000,
  /** How long a closing socket has to actually close before we count it. See closeSocket(). */
  closeGraceMs: 5_000,
  /**
   * This project's choice, not the platform's — neither source states a policy
   * ([BLIVEDM] retries at a constant 1s). No jitter: jitter exists to break up a
   * thundering herd, and this deployment is one process holding one room's
   * session, so it would buy nothing and cost the test a deterministic answer.
   */
  backoff: Object.freeze({ initialDelayMs: 1_000, factor: 2, maxDelayMs: 30_000 }),
  /** Ceilings on what a hostile or broken upstream can make us allocate. */
  maxFrameBytes: 4 * 1024 * 1024,
  maxDecompressedBytes: 8 * 1024 * 1024,
  maxDecodeDepth: 4,
})

// ---------------------------------------------------------------------------
// errors

/**
 * Everything the gateway can refuse with, in one shape.
 *
 * Deliberately carries no request body: /v2/app/start's body contains the room
 * owner's auth code.
 */
export class OpenPlatformError extends Error {
  constructor(message, { endpoint = null, status = null, platformCode = null, requestId = null } = {}) {
    super(message)
    this.name = 'OpenPlatformError'
    this.endpoint = endpoint
    this.status = status
    this.platformCode = platformCode
    this.requestId = requestId
  }
}

// ---------------------------------------------------------------------------
// the signature

/**
 * Sign one Open Platform request.
 *
 * The construction, from [OFFICIAL] SignUtility.cs:32-79 and [BLIVEDM]
 * open_live.py:126-143, which agree line for line:
 *
 *   1. six headers, all lower-case, all x-bili-*
 *   2. sorted by header name, ascending
 *   3. each rendered `name:value`
 *   4. joined with '\n' (no trailing newline)
 *   5. HMAC-SHA256 over that string, keyed with the access key secret, rendered
 *      as lower-case hex
 *   6. that hex string IS the Authorization header — no scheme prefix
 *
 * x-bili-content-md5 is the lower-case hex MD5 of the REQUEST BODY BYTES. It is
 * the only part of the request that the signature actually commits to, which is
 * why this function takes bytes and the caller sends those same bytes rather
 * than re-serialising: a body that is re-encoded between here and the socket is
 * a body the signature does not cover.
 *
 * @param {{accessKeyId: string, accessKeySecret: string, bodyBytes: Uint8Array,
 *          nonce?: string, timestamp?: string}} params
 * @returns {{contentMd5: string, canonicalString: string, signature: string,
 *            headers: Record<string, string>}}
 */
export function signOpenPlatformRequest({ accessKeyId, accessKeySecret, bodyBytes, nonce, timestamp }) {
  if (typeof accessKeyId !== 'string' || accessKeyId === '') {
    throw new TypeError('signOpenPlatformRequest: accessKeyId is required')
  }
  if (typeof accessKeySecret !== 'string' || accessKeySecret === '') {
    throw new TypeError('signOpenPlatformRequest: accessKeySecret is required')
  }
  const body = Buffer.isBuffer(bodyBytes) ? bodyBytes : Buffer.from(bodyBytes ?? [])

  // Built in [OFFICIAL] SignUtility.cs's insertion order, which is NOT
  // alphabetical. That is on purpose: the sort below is then the only thing
  // producing the canonical order, so deleting it changes the signature and the
  // golden vector catches it. Written in sorted order this file would pass with
  // the sort removed, and the guard would be worth nothing.
  const signed = {
    'x-bili-content-md5': createHash('md5').update(body).digest('hex'),
    'x-bili-timestamp': timestamp ?? String(Math.floor(Date.now() / 1000)),
    'x-bili-signature-method': SIGNATURE_METHOD,
    'x-bili-signature-nonce': nonce ?? randomUUID(),
    'x-bili-accesskeyid': accessKeyId,
    'x-bili-signature-version': SIGNATURE_VERSION,
  }

  const canonicalString = Object.keys(signed)
    .sort()
    .map((name) => `${name}:${signed[name]}`)
    .join('\n')

  const signature = createHmac('sha256', accessKeySecret).update(canonicalString, 'utf8').digest('hex')

  return {
    contentMd5: signed['x-bili-content-md5'],
    canonicalString,
    signature,
    headers: {
      ...signed,
      Authorization: signature,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  }
}

/**
 * Recompute the canonical string from headers as RECEIVED.
 *
 * Exported for one reason: a signature test that re-implements the construction
 * proves only that two copies of my own mistake agree. This is what a verifier
 * on the other side would do — take every x-bili-* header off the wire, sort,
 * join — and the test drives it from a fake gateway so the assertion is made
 * against the bytes that were actually sent.
 *
 * [SIGDEMO] Program.cs ToSortedString() is this exact filter-sort-join.
 */
export function canonicalStringFromHeaders(headers) {
  const pairs = []
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase()
    if (name.startsWith('x-bili-')) pairs.push(`${name}:${value}`)
  }
  return pairs.sort().join('\n')
}

// ---------------------------------------------------------------------------
// the binary packet format

/**
 * One packet: a 16-byte big-endian header followed by the body.
 *
 * Header layout, from [OFFICIAL] PacketHeader.cs:36-40 and [BLIVEDM]
 * struct '>I2H2I':
 *
 *   offset 0  uint32  total packet length, header included
 *   offset 4  uint16  header length (always 16)
 *   offset 6  uint16  protocol version
 *   offset 8  uint32  operation
 *   offset 12 uint32  sequence
 *
 * Outgoing packets use protocol version 1 and sequence 1. Both sources do:
 * [BLIVEDM] ws_base.py:224-230 hardcodes ver=1, seq_id=1 for every packet it
 * sends, and [OFFICIAL] Packet.cs gives both the auth packet and the heartbeat
 * packet ProtocolVersion.HeartBeat (1) with SequenceId 1.
 */
export function encodePacket({ operation, body = '', protocolVersion = PROTO_VERSION.HEARTBEAT, sequence = 1 }) {
  if (!Number.isInteger(operation)) throw new TypeError('encodePacket: operation must be an integer')
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body)
  const packet = Buffer.alloc(HEADER_BYTES + payload.length)
  packet.writeUInt32BE(HEADER_BYTES + payload.length, 0)
  packet.writeUInt16BE(HEADER_BYTES, 4)
  packet.writeUInt16BE(protocolVersion, 6)
  packet.writeUInt32BE(operation, 8)
  packet.writeUInt32BE(sequence, 12)
  payload.copy(packet, HEADER_BYTES)
  return packet
}

function readHeader(buf, offset) {
  return {
    packetLength: buf.readUInt32BE(offset),
    headerLength: buf.readUInt16BE(offset + 4),
    protocolVersion: buf.readUInt16BE(offset + 6),
    operation: buf.readUInt32BE(offset + 8),
    sequence: buf.readUInt32BE(offset + 12),
  }
}

/**
 * Decode one WebSocket message into the flat list of packets it contains.
 *
 * Three things make this not a one-liner, and each of them has bitten someone:
 *
 *   1. ONE MESSAGE IS MANY PACKETS. A business message carries packets back to
 *      back and the only way across them is pack_len ([BLIVEDM] ws_base.py's
 *      `offset += header.pack_len` loop).
 *   2. THE BODY MAY BE COMPRESSED, and what comes out of the decompressor is
 *      itself a run of complete packets, not a JSON document — so the walk
 *      recurses rather than parses.
 *   3. A HEARTBEAT_REPLY LIES ABOUT ITS LENGTH. Its pack_len does not include
 *      the echoed heartbeat body ([BLIVEDM] ws_base.py:415-419 calls it a server
 *      bug), so continuing the walk past it lands in the middle of a body. It is
 *      always alone in its message, so this returns at once instead.
 *
 * Returns leaves only: every entry has an uncompressed body, and it is the
 * caller who decides what a body means. Bodies are returned as bytes rather
 * than parsed objects so that one unparseable packet costs one packet instead
 * of the whole batch.
 *
 * Throws on a malformed frame. The caller counts that and keeps the session:
 * a broken upstream must not be able to end a visitor's wait with one bad frame.
 */
export function decodeFrame(bytes, limits = {}) {
  const maxDepth = limits.maxDecodeDepth ?? TRANSPORT_DEFAULTS.maxDecodeDepth
  const maxDecompressedBytes = limits.maxDecompressedBytes ?? TRANSPORT_DEFAULTS.maxDecompressedBytes
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const packets = []
  walk(buf, 0)
  return packets

  function walk(chunk, depth) {
    if (depth > maxDepth) {
      // A packet that decompresses into a packet that decompresses into… is a
      // zip bomb with extra steps. Nothing legitimate nests: the platform sends
      // one compressed layer.
      throw new RangeError(`bili packet: nesting deeper than ${maxDepth} levels`)
    }
    if (chunk.length < HEADER_BYTES) {
      throw new RangeError(`bili packet: ${chunk.length} bytes is shorter than the ${HEADER_BYTES}-byte header`)
    }

    let offset = 0
    while (offset + HEADER_BYTES <= chunk.length) {
      const header = readHeader(chunk, offset)

      if (header.headerLength < HEADER_BYTES) {
        throw new RangeError(`bili packet: header length ${header.headerLength} is below ${HEADER_BYTES}`)
      }

      if (header.operation === OPERATION.HEARTBEAT_REPLY) {
        // Reason 3 above. The first four body bytes are the popularity value;
        // anything after them is our own heartbeat echoed back.
        const start = offset + header.headerLength
        packets.push({ ...header, body: chunk.subarray(start, Math.min(start + 4, chunk.length)) })
        return
      }

      if (header.packetLength < header.headerLength) {
        throw new RangeError(
          `bili packet: packet length ${header.packetLength} is below its own header length ${header.headerLength}`,
        )
      }
      if (offset + header.packetLength > chunk.length) {
        throw new RangeError(
          `bili packet: packet claims ${header.packetLength} bytes but only ${chunk.length - offset} remain`,
        )
      }

      const body = chunk.subarray(offset + header.headerLength, offset + header.packetLength)
      offset += header.packetLength

      if (header.protocolVersion === PROTO_VERSION.DEFLATE) {
        walk(expand(inflateSync(body), 'zlib'), depth + 1)
      } else if (header.protocolVersion === PROTO_VERSION.BROTLI) {
        walk(expand(brotliDecompressSync(body), 'brotli'), depth + 1)
      } else {
        packets.push({ ...header, body })
      }
    }
  }

  function expand(out, kind) {
    if (out.length > maxDecompressedBytes) {
      throw new RangeError(`bili packet: ${kind} body expanded past ${maxDecompressedBytes} bytes`)
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// the transport

/**
 * createBiliTransport(config) -> { kind, start, stop, heartbeat, state }
 *
 * The three methods are danmaku-source.mjs's transport contract, matched exactly
 * — read createDanmakuSource before changing any signature here:
 *
 *   start({ onDanmaku, onDisconnect })  resolves ONLY once the room is audible
 *   stop()                              releases everything, both halves
 *   heartbeat()                         SYNCHRONOUS, may throw, never thenable
 *
 * config (this is config.danmaku, handed over by createDanmakuSource verbatim):
 *   appId, accessKeyId, accessKeySecret, roomOwnerAuthCode, roomId   required
 *   clock            injectable timers; the same object the lifecycle uses
 *   transport        timing/ceiling overrides, see TRANSPORT_DEFAULTS
 *   gatewayBaseUrl   TESTS ONLY — see the refusal below
 *
 * `state()` exists for tests and diagnostics. The lifecycle never calls it, and
 * it returns counters only: no open_id, no auth code, no credential.
 */
export function createBiliTransport(config = {}) {
  const appId = config.appId
  const accessKeyId = config.accessKeyId
  const accessKeySecret = config.accessKeySecret
  const roomOwnerAuthCode = config.roomOwnerAuthCode
  const roomId = config.roomId

  // Refused HERE, at construction, and not at the first visitor. That is the
  // argument danmaku-source.mjs's header makes for why the production transport
  // used to throw unconditionally, and it survives the transport being real: an
  // API that boots happily and only discovers under load that it cannot verify
  // anyone fails in front of a person who did nothing wrong.
  const missing = []
  if (!Number.isInteger(appId) || appId < 1) missing.push('appId (BILI_APP_ID)')
  if (typeof accessKeyId !== 'string' || accessKeyId === '') missing.push('accessKeyId (BILI_ACCESS_KEY_ID)')
  if (typeof accessKeySecret !== 'string' || accessKeySecret === '') {
    missing.push('accessKeySecret (BILI_ACCESS_KEY_SECRET)')
  }
  if (typeof roomOwnerAuthCode !== 'string' || roomOwnerAuthCode === '') {
    missing.push('roomOwnerAuthCode (BILI_ROOM_OWNER_AUTH_CODE)')
  }
  if (!Number.isInteger(roomId) || roomId < 1) missing.push('roomId (BILI_ROOM_ID)')
  if (missing.length > 0) {
    throw new Error(
      'bili transport: the production danmaku source cannot be built without every Open Platform ' +
        `credential. Missing or invalid: ${missing.join(', ')}. This throws at construction rather ` +
        'than at the first visitor: an API that starts and only discovers under load that it cannot ' +
        'verify anyone fails in front of someone who did nothing wrong.',
    )
  }

  // The one seam, and it is a bypass in exactly the sense env-guard uses the
  // word: whoever sets it decides which host answers "is this the owner's room",
  // and therefore who gets to be anybody. It is shaped like turnstile.mjs's
  // verifyUrl for that reason, config.mjs must never populate it, and
  // env-guard's BYPASS_FLAGS roster should carry it at refuse severity beside
  // turnstile.verifyUrl. Everything else the tests need is reachable without a
  // seam, because the wss URL arrives in the gateway's own answer.
  const baseUrl = config.gatewayBaseUrl ?? OPEN_LIVE_BASE_URL

  const opts = Object.freeze({
    ...TRANSPORT_DEFAULTS,
    ...(config.transport ?? {}),
    backoff: Object.freeze({ ...TRANSPORT_DEFAULTS.backoff, ...(config.transport?.backoff ?? {}) }),
  })

  const clock = config.clock ?? realClock()
  const WebSocketImpl = globalThis.WebSocket
  if (typeof WebSocketImpl !== 'function') {
    throw new Error(
      'bili transport: this runtime has no global WebSocket. Node 22 or newer is required ' +
        '(package.json engines says >=22); on an older runtime the room can never be heard.',
    )
  }

  // --- everything mutable ---------------------------------------------------
  let handlers = { onDanmaku: null, onDisconnect: null }
  let session = null // { gameId, authBody, wssLinks, roomId }
  let socket = null
  let socketGeneration = 0 // bumped on every teardown; late events check it
  let wsHeartbeatTimer = null
  let idleTimer = null
  let authenticated = false

  let consecutiveStartFailures = 0
  let nextDialAllowedAtMs = 0
  let consecutiveHeartbeatFailures = 0
  let dialCount = 0

  // The only channel this transport has for a failure that is nobody's return
  // value. heartbeat() is called synchronously by the lifecycle and its throw
  // reaches the 'error' listeners; an HTTP heartbeat that fails, or a frame we
  // could not decode, has no such caller. Parking it here and throwing it from
  // the next beat costs one heartbeat interval of delay and buys the difference
  // between a reported fault and a silent one. Only the most recent is kept —
  // a queue of stale errors would delay the current one behind history.
  let deferredError = null
  let deferredErrorCount = 0

  const stats = {
    danmaku: 0,
    undecodableFrames: 0,
    unparseablePackets: 0,
    wsBeatsSent: 0,
    appBeatsSent: 0,
    socketsStuckClosing: 0,
  }

  // --- the gateway ----------------------------------------------------------

  async function callGateway(path, body) {
    // Signed and sent as the SAME bytes. JSON.stringify runs once; anything that
    // re-encoded between the md5 and the socket would produce a signature over a
    // body that was never sent, and the platform would refuse it opaquely.
    const bodyBytes = Buffer.from(JSON.stringify(body), 'utf8')
    const { headers } = signOpenPlatformRequest({ accessKeyId, accessKeySecret, bodyBytes })

    let response
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: bodyBytes,
        signal: AbortSignal.timeout(opts.requestTimeoutMs),
      })
    } catch (err) {
      // Transport-level: DNS, TLS, refused, timed out. Named as "unreachable"
      // rather than folded into a platform code, because the fix is different.
      throw new OpenPlatformError(
        `bili gateway: POST ${path} did not complete (${errorText(err)}) — we cannot hear the room`,
        { endpoint: path },
      )
    }

    const text = await response.text()
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }

    if (!response.ok) {
      throw new OpenPlatformError(
        `bili gateway: POST ${path} answered HTTP ${response.status}` +
          (payload?.message ? ` (${payload.message})` : '') +
          ' — we cannot hear the room',
        {
          endpoint: path,
          status: response.status,
          platformCode: typeof payload?.code === 'number' ? payload.code : null,
          requestId: payload?.request_id ?? null,
        },
      )
    }
    if (payload === null || typeof payload !== 'object') {
      throw new OpenPlatformError(`bili gateway: POST ${path} answered HTTP 200 with a body that is not JSON`, {
        endpoint: path,
        status: response.status,
      })
    }
    return {
      code: payload.code,
      message: payload.message ?? '',
      requestId: payload.request_id ?? null,
      data: payload.data ?? null,
      status: response.status,
    }
  }

  function refuseNonZero(path, result) {
    if (result.code === 0) return result
    throw new OpenPlatformError(
      `bili gateway: POST ${path} answered code ${result.code}` +
        (result.message ? ` (${result.message})` : '') +
        ' — we cannot hear the room',
      { endpoint: path, status: result.status, platformCode: result.code, requestId: result.requestId },
    )
  }

  /**
   * Open the app session. [OFFICIAL] BApi.cs:65-72 — body {code, app_id}.
   * `code` is the room owner's auth code from play-live.bilibili.com, which is
   * what scopes this app to exactly one room; there is no room id in the request.
   */
  async function startGameSession() {
    const result = refuseNonZero(
      OPEN_LIVE_PATHS.start,
      await callGateway(OPEN_LIVE_PATHS.start, { code: roomOwnerAuthCode, app_id: appId }),
    )

    const gameId = result.data?.game_info?.game_id
    const websocketInfo = result.data?.websocket_info
    const authBody = websocketInfo?.auth_body
    const wssLinks = websocketInfo?.wss_link
    const anchorRoomId = result.data?.anchor_info?.room_id

    if (typeof gameId !== 'string' || gameId === '') {
      throw new OpenPlatformError('bili gateway: /v2/app/start returned no game_id, so no session to keep alive', {
        endpoint: OPEN_LIVE_PATHS.start,
        requestId: result.requestId,
      })
    }
    // Take ownership of the game_id the INSTANT it parses, before validating
    // anything else. The platform has already opened the session by now, so a
    // throw from the checks below leaves it running — and the caller's failure
    // path can only end a session it can see. Assigning after the checks meant
    // `session` was still null in that catch and /v2/app/end was never called:
    // measured zero. An un-ended session can block re-connecting to the same
    // room, at which point the visitor is told the room is unreachable because
    // of our bookkeeping.
    session = { gameId, authBody: null, wssLinks: null, roomId: anchorRoomId ?? null }

    if (typeof authBody !== 'string' || authBody === '') {
      throw new OpenPlatformError('bili gateway: /v2/app/start returned no websocket_info.auth_body', {
        endpoint: OPEN_LIVE_PATHS.start,
        requestId: result.requestId,
      })
    }
    if (!Array.isArray(wssLinks) || wssLinks.length === 0) {
      // The session is open at this point AND `session` now holds its game_id,
      // so the caller's failure path can actually end it.
      throw new OpenPlatformError('bili gateway: /v2/app/start returned no websocket_info.wss_link to dial', {
        endpoint: OPEN_LIVE_PATHS.start,
        requestId: result.requestId,
      })
    }

    return { gameId, authBody, wssLinks, roomId: anchorRoomId ?? null }
  }

  /**
   * Both halves, as the task's own wording has it. An un-ended session is a
   * resource the platform believes is still running, and [BLIVEDM]
   * open_live.py:198 warns that leaving one open can block re-connecting to the
   * same room for a while — which is a visitor being told the room is
   * unreachable because of our bookkeeping.
   */
  async function endGameSession(gameId) {
    const result = await callGateway(OPEN_LIVE_PATHS.end, { app_id: appId, game_id: gameId })
    if (result.code === 0) return
    if (SESSION_ALREADY_CLOSED_CODES.includes(result.code)) return // already closed IS the outcome
    throw new OpenPlatformError(
      `bili gateway: POST ${OPEN_LIVE_PATHS.end} answered code ${result.code}` +
        (result.message ? ` (${result.message})` : '') +
        ` — game session ${gameId} may still be running on the platform`,
      { endpoint: OPEN_LIVE_PATHS.end, platformCode: result.code, requestId: result.requestId },
    )
  }

  // --- the socket -----------------------------------------------------------

  function clearTimers() {
    if (wsHeartbeatTimer !== null) {
      clock.clearInterval(wsHeartbeatTimer)
      wsHeartbeatTimer = null
    }
    if (idleTimer !== null) {
      clock.clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  /**
   * Drop the socket and forget it.
   *
   * The generation bump is what makes this safe against a close event that
   * arrives after we have moved on: a socket we closed ourselves must not be
   * reported to the lifecycle as a disconnect, or a clean stop would look like a
   * dropped room and a visitor would be told we lost them.
   *
   * KNOWN LIMIT, measured on this runtime rather than assumed. close() sends a
   * close frame and waits for the peer's reply before releasing the TCP socket
   * (RFC 6455 §7.1.2). A peer that is CONNECTED BUT SILENT never sends that
   * reply, and Node's WebSocket holds the socket open with no timeout of its own
   * — a direct probe on Node 24 was still holding one 45 seconds after close().
   * The standard API this project chose over a `ws` dependency has no
   * terminate() and no access to the underlying socket, so it cannot be forced.
   *
   * That matters because a connected-but-silent peer is exactly what the idle
   * watchdog exists for, i.e. the case that REPEATS: one file descriptor per
   * episode, held until the process restarts. What is fixable is the silence
   * around it, so a socket that has not reported itself closed within the grace
   * window is counted and state().socketsStuckClosing carries it — an operator
   * watching an fd count climb can then see why, instead of finding out when
   * accept() starts failing.
   */
  function closeSocket() {
    socketGeneration += 1
    clearTimers()
    authenticated = false
    const doomed = socket
    socket = null
    if (doomed === null) return
    try {
      doomed.onopen = null
      doomed.onmessage = null
      doomed.onclose = null
      doomed.onerror = null
      doomed.close(1000)
    } catch {
      // A socket that cannot be closed is already gone; there is nothing this
      // path can do about it and nobody left to tell.
      return
    }
    const stuckTimer = clock.setTimeout(() => {
      // 3 is WebSocket.CLOSED. Read from the instance rather than hardcoded so
      // this says what it means.
      if (doomed.readyState !== doomed.CLOSED) stats.socketsStuckClosing += 1
    }, opts.closeGraceMs)
    // Not tracked for cancellation on purpose: it is one shot, it is unref'd by
    // the clock, and cancelling it would mean holding a reference to a socket we
    // have deliberately let go of.
    void stuckTimer
  }

  function armIdleWatchdog(generation) {
    if (idleTimer !== null) clock.clearTimeout(idleTimer)
    idleTimer = clock.setTimeout(() => {
      idleTimer = null
      goDeaf(generation, 'ws-idle', new Error(`no websocket message for ${opts.wsIdleTimeoutMs}ms`))
    }, opts.wsIdleTimeoutMs)
  }

  /**
   * Admit deafness upward.
   *
   * This does NOT retry. The lifecycle owns the retry, because it is the only
   * side that knows whether anyone is still waiting — and because a transport
   * that silently reconnected would hide the gap, and the gap is precisely what
   * turns LISTENING_NO_MATCH ("you have not sent it") into LISTENING_AFTER_GAP
   * ("we were away, we cannot say"). Hiding it would let the UI blame a visitor
   * for our disconnect.
   */
  function goDeaf(generation, reason, error = null) {
    if (generation !== socketGeneration) return // an older socket's death throes
    closeSocket()
    const onDisconnect = handlers.onDisconnect
    if (typeof onDisconnect === 'function') onDisconnect({ reason, error })
  }

  function defer(err) {
    deferredError = err
    deferredErrorCount += 1
  }

  function openSocket(url, authBody) {
    const generation = socketGeneration + 1
    socketGeneration = generation
    authenticated = false
    dialCount += 1

    return new Promise((resolve, reject) => {
      let settled = false
      const ws = new WebSocketImpl(url)
      // Without this, undici hands binary messages over as a Blob and every
      // read below becomes async for no reason.
      ws.binaryType = 'arraybuffer'
      socket = ws

      // The lifecycle's startTimeoutMs is the outer bound on the whole start;
      // this is the inner one, so a socket that never opens is closed by the
      // side that owns it rather than abandoned half-open.
      const connectTimer = clock.setTimeout(() => {
        finish(
          new OpenPlatformError(
            `bili transport: the danmaku socket did not authenticate within ${opts.connectTimeoutMs}ms`,
          ),
        )
      }, opts.connectTimeoutMs)

      function finish(err) {
        if (settled) return
        settled = true
        clock.clearTimeout(connectTimer)
        if (err) {
          closeSocket()
          reject(err)
        } else {
          resolve()
        }
      }

      ws.onopen = () => {
        if (generation !== socketGeneration) return
        try {
          // [BLIVEDM] open_live.py:293 — the auth body is sent VERBATIM as the
          // packet body. It is an opaque JSON string minted by /v2/app/start;
          // re-serialising it would change bytes the platform signed.
          ws.send(encodePacket({ operation: OPERATION.AUTH, body: authBody }))
        } catch (err) {
          finish(new OpenPlatformError(`bili transport: could not send the auth packet (${errorText(err)})`))
          return
        }
        armIdleWatchdog(generation)
      }

      ws.onmessage = (event) => {
        if (generation !== socketGeneration) return
        armIdleWatchdog(generation)

        let packets
        try {
          const raw = Buffer.from(event.data)
          if (raw.length > opts.maxFrameBytes) {
            throw new RangeError(`frame of ${raw.length} bytes exceeds the ${opts.maxFrameBytes} byte ceiling`)
          }
          packets = decodeFrame(raw, opts)
        } catch (err) {
          // One bad frame costs one frame. A broken or hostile upstream must not
          // be able to end a visitor's wait by sending garbage.
          stats.undecodableFrames += 1
          defer(new Error(`bili transport: undecodable frame (${errorText(err)})`))
          return
        }

        for (const packet of packets) {
          if (packet.operation === OPERATION.AUTH_REPLY) {
            const reply = parseJson(packet.body)
            if (reply === null || reply.code !== AUTH_REPLY_OK) {
              // Resolving on open instead of here is the bug this guards: a
              // socket that is connected but unauthenticated hears nothing, and
              // showing the visitor a code then is showing it into a void.
              finish(
                new OpenPlatformError(
                  `bili transport: the danmaku server rejected our auth packet (code ${reply?.code ?? 'unknown'})`,
                ),
              )
              return
            }
            authenticated = true
            // Both sources beat once immediately on a successful auth
            // ([BLIVEDM] ws_base.py:468; [OFFICIAL] BLiveClient.cs's timer has
            // dueTime 0) and then on the interval.
            sendWsHeartbeat(generation)
            wsHeartbeatTimer = clock.setInterval(() => sendWsHeartbeat(generation), opts.wsHeartbeatIntervalMs)
            finish(null)
            continue
          }
          if (packet.operation === OPERATION.SEND_MSG_REPLY) {
            handleCommand(packet, generation)
            continue
          }
          // HEARTBEAT_REPLY carries the popularity number and nothing we act on;
          // its value is that it arrived, which the idle watchdog already read.
        }
      }

      ws.onerror = () => {
        if (generation !== socketGeneration) return
        // The event carries no useful detail in undici, and the close that
        // follows is where the truth is. Settle a start that is still waiting so
        // it does not sit out the connect timeout for a socket that is done.
        if (!settled) finish(new OpenPlatformError('bili transport: the danmaku socket errored before authenticating'))
      }

      ws.onclose = () => {
        if (generation !== socketGeneration) return
        if (!settled) {
          finish(new OpenPlatformError('bili transport: the danmaku socket closed before authenticating'))
          return
        }
        goDeaf(generation, 'ws-closed')
      }
    })
  }

  function sendWsHeartbeat(generation) {
    if (generation !== socketGeneration || socket === null) return
    try {
      // A body-less heartbeat, ver 1, op 2 — [OFFICIAL] Packet.cs's
      // s_NoBodyHeartBeatPacket, [BLIVEDM] ws_base.py:361 sends `{}` instead.
      // The empty body is the official demo's shape and the platform accepts it;
      // this is the one place the two sources differ harmlessly.
      socket.send(encodePacket({ operation: OPERATION.HEARTBEAT }))
      stats.wsBeatsSent += 1
    } catch (err) {
      goDeaf(generation, 'ws-heartbeat-failed', err instanceof Error ? err : new Error(String(err)))
    }
  }

  function handleCommand(packet, generation) {
    const command = parseJson(packet.body)
    if (command === null) {
      stats.unparseablePackets += 1
      defer(new Error('bili transport: a business packet was not JSON'))
      return
    }

    if (command.cmd === INTERACTION_END_CMD) {
      // The platform has stopped pushing — usually our app heartbeat timed out
      // ([BLIVEDM] open_live.py:297-304). The socket may stay open and silent,
      // which is the worst possible state: audible-looking and deaf.
      if (command.data?.game_id === undefined || command.data.game_id === session?.gameId) {
        goDeaf(generation, 'interaction-end', new Error('the platform ended the app session'))
      }
      return
    }

    // ONLY LIVE_OPEN_PLATFORM_DM. Not LIVE_OPEN_PLATFORM_DM_MIRROR: a mirrored
    // danmaku was typed in a DIFFERENT room and relayed here, so accepting it
    // would let someone prove presence in the owner's room without ever having
    // been in it. The narrowing is deliberate and it is the whole reason this
    // switch is a whitelist rather than a "not a gift" filter.
    if (command.cmd !== DANMAKU_CMD) return

    const data = command.data
    if (data === null || typeof data !== 'object') {
      stats.unparseablePackets += 1
      return
    }

    const onDanmaku = handlers.onDanmaku
    if (typeof onDanmaku !== 'function') return
    stats.danmaku += 1
    // Handed over with the platform's own field names. normalizeDanmaku() in
    // danmaku-source.mjs accepts open_id / uname / msg precisely so that this
    // side does not become a second normaliser — two normalisers is two
    // contracts, and the one that drifts is always the one nobody tests.
    onDanmaku(data)
  }

  // --- lifecycle ------------------------------------------------------------

  /**
   * Release everything we hold: socket first, then the platform's session.
   *
   * `endSession` is false only when the session is already known to be gone.
   */
  async function releaseAll({ endSession }) {
    closeSocket()
    const held = session
    session = null
    if (!endSession || held === null) return
    await endGameSession(held.gameId)
  }

  function backoffDelayMs(failures) {
    if (failures <= 0) return 0
    const raw = opts.backoff.initialDelayMs * opts.backoff.factor ** (failures - 1)
    return Math.min(raw, opts.backoff.maxDelayMs)
  }

  async function start({ onDanmaku, onDisconnect } = {}) {
    handlers = { onDanmaku: onDanmaku ?? null, onDisconnect: onDisconnect ?? null }

    // The backoff is a GATE, not a sleep. Sleeping here would burn the
    // lifecycle's startTimeoutMs on doing nothing, and a backoff longer than
    // that timeout would turn every retry into a timeout and grow the backoff
    // that caused it. Refusing instead keeps the wait free and says out loud
    // that we are still deaf, which is the honest answer while it is true.
    const waitMs = nextDialAllowedAtMs - clock.now().getTime()
    if (waitMs > 0) {
      throw new OpenPlatformError(
        `bili transport: still backing off after ${consecutiveStartFailures} consecutive failures — ` +
          `not dialling the room for another ${waitMs}ms. We are deaf, not idle.`,
      )
    }

    // The lifecycle reconnects by calling start() again WITHOUT an intervening
    // stop() (scheduleReconnect in danmaku-source.mjs), so this is the only
    // place a session opened by the previous attempt gets ended. Best effort:
    // failing to end an old session must not stop us opening a new one, or one
    // platform hiccup would keep the room unreachable for as long as it lasted.
    if (session !== null) {
      try {
        await releaseAll({ endSession: true })
      } catch (err) {
        defer(err)
      }
    }

    try {
      const opened = await startGameSession()
      session = opened

      if (opened.roomId !== null && opened.roomId !== roomId) {
        // Listening to the wrong room is deafness that looks exactly like
        // listening: the socket is up, packets arrive, and no code ever matches.
        // env-guard calls BILI_ROOM_ID "the only room whose danmaku confer
        // identity", so a mismatch means the auth code and the room id name
        // different rooms and one of them is wrong.
        throw new OpenPlatformError(
          `bili transport: the auth code opened room ${opened.roomId}, but BILI_ROOM_ID is ${roomId}. ` +
            'Refusing to listen to a room whose danmaku are not the ones that confer identity here.',
        )
      }

      // Round-robin across the offered endpoints so a single bad host is
      // survivable — [BLIVEDM] open_live.py:287 indexes by retry count.
      const url = opened.wssLinks[consecutiveStartFailures % opened.wssLinks.length]
      await openSocket(url, opened.authBody)

      consecutiveStartFailures = 0
      nextDialAllowedAtMs = 0
      consecutiveHeartbeatFailures = 0
    } catch (err) {
      consecutiveStartFailures += 1
      nextDialAllowedAtMs = clock.now().getTime() + backoffDelayMs(consecutiveStartFailures)
      // A session opened here and abandoned here is ours to close. The
      // lifecycle does call stop() after a failed start, but only when it still
      // owns the source — the generation guard in its error handler declines
      // otherwise, and a leaked session outlives both of us.
      try {
        await releaseAll({ endSession: true })
      } catch (endErr) {
        defer(endErr)
      }
      throw err
    }
  }

  async function stop() {
    handlers = { onDanmaku: null, onDisconnect: null }
    consecutiveHeartbeatFailures = 0
    // Rejects if the platform refuses the end. That reaches the lifecycle's
    // 'error' listeners (scheduleStop catches it) and the process shutdown path
    // logs it, which is where a session we could not close belongs — silence
    // here is a session running on the platform that nobody knows about.
    await releaseAll({ endSession: true })
  }

  /**
   * The application-level heartbeat, driven by the lifecycle's 20s timer.
   *
   * SYNCHRONOUS AND NEVER THENABLE. danmaku-source.mjs calls this un-awaited
   * inside a try/catch; a returned promise would be ignored and a returned
   * REJECTED promise would become an unhandled rejection, which on Node kills
   * the process — a room heartbeat failing must degrade, not detonate. So the
   * HTTP call is dispatched here and its outcome is reported on the next beat,
   * one interval later, through the only synchronous channel there is.
   */
  function heartbeat() {
    if (session === null) {
      throw new Error('bili transport: heartbeat with no open app session — there is nothing to keep alive')
    }

    const pending = deferredError
    const pendingCount = deferredErrorCount
    deferredError = null
    deferredErrorCount = 0

    const gameId = session.gameId
    const generation = socketGeneration
    stats.appBeatsSent += 1

    // [OFFICIAL] BApi.cs:84-92 — body is {game_id}. No app_id.
    void callGateway(OPEN_LIVE_PATHS.heartbeat, { game_id: gameId }).then(
      (result) => {
        if (result.code === 0) {
          consecutiveHeartbeatFailures = 0
          return
        }
        if (result.code === SESSION_CLOSED_CODE) {
          // Not a missed beat: the session is gone and everything we would hear
          // through this socket is already not arriving.
          consecutiveHeartbeatFailures = 0
          goDeaf(generation, 'app-session-closed', new Error(`the platform closed the app session (code ${result.code})`))
          return
        }
        countHeartbeatFailure(
          generation,
          new Error(`bili gateway: app heartbeat answered code ${result.code}${result.message ? ` (${result.message})` : ''}`),
        )
      },
      (err) => countHeartbeatFailure(generation, err),
    )

    if (pending) {
      pending.message =
        pendingCount > 1 ? `${pending.message} (and ${pendingCount - 1} earlier fault(s) this interval)` : pending.message
      throw pending
    }
  }

  function countHeartbeatFailure(generation, err) {
    consecutiveHeartbeatFailures += 1
    defer(err)
    if (consecutiveHeartbeatFailures < opts.maxHeartbeatFailures) return
    // The platform closes a session after 60s without a beat ([OFFICIAL]
    // AppStartInfo.cs on game_id), so three missed beats at the lifecycle's 20s
    // cadence is the moment the platform has given up on us. Claiming to be
    // listening past it is claiming something we cannot support.
    consecutiveHeartbeatFailures = 0
    goDeaf(generation, 'app-heartbeat-failed', err)
  }

  return {
    kind: 'bilibili-open-platform',
    start,
    stop,
    heartbeat,
    /** Counters only — no open_id, no auth code, no credential. */
    state: () => ({
      hasSession: session !== null,
      authenticated,
      dialCount,
      consecutiveStartFailures,
      consecutiveHeartbeatFailures,
      nextDialInMs: Math.max(0, nextDialAllowedAtMs - clock.now().getTime()),
      deferredErrors: deferredErrorCount,
      ...stats,
    }),
  }
}

// ---------------------------------------------------------------------------
// small shared pieces

function parseJson(body) {
  if (body.length === 0) return null
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return null
  }
}

function errorText(err) {
  return err instanceof Error ? err.message : String(err)
}

// unref'd, for the reason danmaku-source.mjs's own realClock() states: no timer
// this project creates may be the reason a container refuses to exit. A 30
// second websocket heartbeat outliving its session must not hold the loop open.
function realClock() {
  return {
    now: () => new Date(),
    setTimeout: (fn, ms) => {
      const t = globalThis.setTimeout(fn, ms)
      t.unref?.()
      return t
    },
    clearTimeout: (t) => globalThis.clearTimeout(t),
    setInterval: (fn, ms) => {
      const t = globalThis.setInterval(fn, ms)
      t.unref?.()
      return t
    },
    clearInterval: (t) => globalThis.clearInterval(t),
  }
}
