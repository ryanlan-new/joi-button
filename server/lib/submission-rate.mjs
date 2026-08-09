export const SUBMISSION_WINDOW_SECONDS = 60

/**
 * Rate decisions are pure so the red leg can be driven without a clock or a
 * database. The oldest batch determines the whole-second Retry-After value.
 */
export function decideSubmissionRate({ now, submitter, session, windowSeconds = SUBMISSION_WINDOW_SECONDS }) {
  const candidates = [submitter, session]
    .filter((value) => value && Number(value.count) > 0 && typeof value.oldest === 'string')
    .map((value) => Date.parse(value.oldest) + windowSeconds * 1000)
    .filter(Number.isFinite)

  if (candidates.length === 0) return { allowed: true, retryAfterSeconds: null }

  const deadline = Math.max(...candidates)
  const nowMs = Date.parse(now)
  const remaining = Number.isFinite(nowMs) ? Math.ceil((deadline - nowMs) / 1000) : windowSeconds
  const allowed = remaining <= 0
  return {
    allowed,
    retryAfterSeconds: allowed ? null : Math.max(1, remaining),
  }
}
