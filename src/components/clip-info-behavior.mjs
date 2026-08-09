export const DESKTOP_CARD_WIDTH_PX = 448

export function desktopPanelStyle(anchor, viewport) {
  const width = Math.min(DESKTOP_CARD_WIDTH_PX, Math.max(0, viewport.width - 48))
  const maxLeft = Math.max(16, viewport.width - width - 16)
  const left = clamp(anchor.left, 16, maxLeft)
  const top = Math.max(88, Math.min(anchor.bottom + 12, Math.max(88, viewport.height - 280)))
  const anchorX = clamp(
    anchor.left + (Number.isFinite(anchor.width) ? anchor.width / 2 : 0) - left,
    0,
    width,
  )
  const anchorY = anchor.bottom - top
  return {
    left: left + 'px',
    top: top + 'px',
    right: 'auto',
    transformOrigin: anchorX + 'px ' + anchorY + 'px',
    '--clip-info-arrow-left': anchorX + 'px',
  }
}

export function buildInfoRows(clip, labels) {
  const source = clip && clip.source && typeof clip.source === 'object' ? clip.source : {}
  const rows = []
  if (source.kind) {
    rows.push({
      key: 'type',
      label: labels.typeLabel,
      value: labels.types[source.kind] || source.kind,
    })
  }
  if (source.title) rows.push({ key: 'source-title', label: labels.source, value: source.title })
  if (source.date) rows.push({ key: 'date', label: labels.date, value: source.date })
  if (Number.isInteger(source.seconds) && source.seconds >= 0) {
    rows.push({ key: 'time-point', label: labels.timePoint, value: formatSeconds(source.seconds) })
  }
  if (typeof source.url === 'string' && source.url !== '') {
    const hasMoment = Number.isInteger(source.seconds) && source.seconds >= 0
    rows.push({
      key: 'original',
      label: labels.original,
      value: source.url,
      href: sourceHref(source),
      linkText: hasMoment ? labels.jump : source.url,
    })
  }
  if (clip && clip.submitter && typeof clip.submitter.name === 'string' && clip.submitter.name !== '') {
    rows.push({ key: 'submitter', label: labels.submitter, value: clip.submitter.name })
  }
  return rows
}

export function sourceHref(source) {
  if (!source || typeof source.url !== 'string' || source.url === '') return ''
  if (!Number.isInteger(source.seconds) || source.seconds < 0) return source.url
  const hashAt = source.url.indexOf('#')
  const base = hashAt === -1 ? source.url : source.url.slice(0, hashAt)
  const hash = hashAt === -1 ? '' : source.url.slice(hashAt)
  const separator = base.indexOf('?') === -1 ? '?' : '&'
  return base + separator + 't=' + encodeURIComponent(source.seconds) + hash
}

export function formatSeconds(value) {
  if (!Number.isInteger(value) || value < 0) return ''
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  const seconds = value % 60
  const tail = (seconds < 10 ? '0' : '') + seconds
  return hours > 0 ? hours + ':' + (minutes < 10 ? '0' : '') + minutes + ':' + tail : minutes + ':' + tail
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(Number.isFinite(value) ? value : minimum, maximum))
}
