import { statfs } from 'node:fs/promises'

import { toCanonicalTimestamp } from '../db/migrate.mjs'

export const STORAGE_RESERVE_BYTES = 256 * 1024 * 1024

export function decideStorage({ availableBytes, reserveBytes = STORAGE_RESERVE_BYTES, inflightBytes = 0 }) {
  const available = Number(availableBytes)
  const reserve = Number(reserveBytes)
  const inflight = Number(inflightBytes)
  if (![available, reserve, inflight].every(Number.isFinite)) {
    return { allowed: false, reason: 'storage_unreadable' }
  }
  return {
    allowed: available > reserve + inflight,
    reason: available > reserve + inflight ? null : 'storage_exhausted',
  }
}

export async function readStorageStats(dataDir) {
  const stats = await statfs(dataDir)
  const blockSize = Number(stats.bsize)
  const totalBytes = blockSize * Number(stats.blocks)
  const freeBlocks = Number.isFinite(Number(stats.bfree)) ? Number(stats.bfree) : Number(stats.bavail)
  const availableBytes = blockSize * Number(stats.bavail)
  return {
    totalBytes,
    usedBytes: Math.max(0, totalBytes - blockSize * freeBlocks),
    availableBytes,
  }
}

export function createStorageGuard({ dataDir, now = () => new Date(), readStats = () => readStorageStats(dataDir) } = {}) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new TypeError('storage guard needs dataDir')
  if (typeof readStats !== 'function') throw new TypeError('storage guard needs a stats reader')
  let inflightBytes = 0
  let lastRefusalAt = null

  async function snapshot() {
    try {
      const stats = await readStats()
      const decision = decideStorage({ ...stats, inflightBytes })
      return {
        ...stats,
        reserveBytes: STORAGE_RESERVE_BYTES,
        inflightBytes,
        refusing: !decision.allowed,
        lastRefusalAt,
      }
    } catch {
      return {
        totalBytes: null,
        usedBytes: null,
        availableBytes: null,
        reserveBytes: STORAGE_RESERVE_BYTES,
        inflightBytes,
        refusing: true,
        lastRefusalAt,
        error: 'storage_unreadable',
      }
    }
  }

  async function reserve(bytes) {
    const requested = Number(bytes)
    if (!Number.isFinite(requested) || requested < 0) throw new TypeError('storage reservation must be a finite byte count')
    const stats = await readStats()
    const decision = decideStorage({ ...stats, inflightBytes: inflightBytes + requested })
    if (!decision.allowed) {
      lastRefusalAt = toCanonicalTimestamp(now())
      return {
        allowed: false,
        snapshot: {
          ...stats,
          reserveBytes: STORAGE_RESERVE_BYTES,
          inflightBytes: inflightBytes + requested,
          refusing: true,
          lastRefusalAt,
        },
      }
    }
    inflightBytes += requested
    return {
      allowed: true,
      snapshot: { ...stats, reserveBytes: STORAGE_RESERVE_BYTES, inflightBytes, refusing: false, lastRefusalAt },
    }
  }

  function release(bytes) {
    inflightBytes = Math.max(0, inflightBytes - Number(bytes))
  }

  return Object.freeze({ snapshot, reserve, release })
}
