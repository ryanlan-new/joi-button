// The interaction decisions live outside the Vue component so the frontend
// tests can exercise the same rules without depending on a renderer.

export const HOLD_THRESHOLD_MS = 420
export const MOVE_CANCEL_DISTANCE_PX = 10

export function movedBeyondThreshold(startX, startY, currentX, currentY, threshold = MOVE_CANCEL_DISTANCE_PX) {
  return Math.hypot(currentX - startX, currentY - startY) > threshold
}

export function shouldPlayAfterPress({ moved = false, held = false } = {}) {
  return moved !== true && held !== true
}

/**
 * A wall-clock hold decision. Painting is deliberately not involved: rAF may
 * be throttled or stopped while a tab is backgrounded.
 */
export function scheduleHold({
  isActive = () => true,
  onHold,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  threshold = HOLD_THRESHOLD_MS,
} = {}) {
  let cancelled = false
  const timer = setTimer(() => {
    if (!cancelled && isActive()) onHold()
  }, threshold)
  return () => {
    cancelled = true
    clearTimer(timer)
  }
}

/**
 * Use only a recent sample that is at least 12ms old. A large gap means the
 * pointer stopped, so it carries no release momentum.
 */
export function sampleVelocity(samples, { max = 1800, minSampleGap = 12, stoppedAfter = 120 } = {}) {
  if (!Array.isArray(samples) || samples.length < 2) return 0
  const latest = samples[samples.length - 1]
  if (!latest || !Number.isFinite(latest.y) || !Number.isFinite(latest.time)) return 0

  let earlier = null
  for (let index = samples.length - 2; index >= 0; index -= 1) {
    const candidate = samples[index]
    if (!candidate || !Number.isFinite(candidate.y) || !Number.isFinite(candidate.time)) continue
    if (latest.time - candidate.time >= minSampleGap) {
      earlier = candidate
      break
    }
  }
  if (earlier === null) return 0

  const elapsed = latest.time - earlier.time
  if (elapsed <= 0 || elapsed > stoppedAfter) return 0
  const velocity = (latest.y - earlier.y) / elapsed * 1000
  return Math.max(-max, Math.min(max, velocity))
}

export function projectedOffset(offset, velocity, { decay = .998, horizon = 240 } = {}) {
  return offset + (velocity / 1000) * horizon / (1 - decay)
}

export function shouldDismissOffset(offset, velocity, height, options) {
  const targetHeight = Number.isFinite(height) && height > 0 ? height : 320
  const projected = projectedOffset(offset, velocity, options)
  return projected > targetHeight * .6 || velocity > 800
}

/**
 * A small spring with a terminal timer. If rAF stops, the visual interpolation
 * may stop, but the state still reaches its target and its completion callback
 * still runs.
 */
export function springValue(
  from,
  to,
  { duration = .34, bounce = 0, onUpdate = () => {}, onComplete = () => {} } = {},
) {
  const damping = Math.max(.05, 1 - bounce)
  const response = Math.max(.08, duration)
  const omega = 12 / response
  let value = from
  let velocity = 0
  let last = typeof performance === 'object' && typeof performance.now === 'function' ? performance.now() : Date.now()
  let stopped = false
  let frameId = null
  let fallbackTimer = null
  const requestFrame = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
    ? (callback) => window.requestAnimationFrame(callback)
    : (callback) => setTimeout(() => callback(Date.now()), 16)
  const cancelFrame = typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function'
    ? (id) => window.cancelAnimationFrame(id)
    : (id) => clearTimeout(id)

  const finish = () => {
    if (stopped) return
    stopped = true
    if (frameId !== null) cancelFrame(frameId)
    if (fallbackTimer !== null) clearTimeout(fallbackTimer)
    onUpdate(to)
    onComplete()
  }
  const tick = (now) => {
    if (stopped) return
    const delta = Math.min(.032, Math.max(.001, (now - last) / 1000))
    last = now
    const displacement = value - to
    const acceleration = -omega * omega * displacement - 2 * damping * omega * velocity
    velocity += acceleration * delta
    value += velocity * delta
    onUpdate(value)
    if (Math.abs(value - to) < .001 && Math.abs(velocity) < .01) return finish()
    frameId = requestFrame(tick)
  }
  if (Math.abs(from - to) < .001) {
    finish()
    return () => {}
  }
  frameId = requestFrame(tick)
  fallbackTimer = setTimeout(finish, Math.max(120, Math.ceil(response * 1000) + 120))
  return () => {
    if (stopped) return
    stopped = true
    if (frameId !== null) cancelFrame(frameId)
    if (fallbackTimer !== null) clearTimeout(fallbackTimer)
  }
}
