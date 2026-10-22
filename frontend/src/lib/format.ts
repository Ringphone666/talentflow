/**
 * 后端有两种时间写法：面试库按 UTC 保存且不带时区；人岗匹配保存带时区的本地时间。
 * 不带时区的一律按 UTC 解析，统一显示为浏览器所在时区的时间。
 */
export function parseTime(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return new Date(value * (value < 1e12 ? 1000 : 1))
  const text = value.trim().replace(' ', 'T')
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
  const date = new Date(zoned || !text.includes('T') ? text : `${text}Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

const pad = (value: number) => String(value).padStart(2, '0')

export function formatTime(value: string | number | null | undefined, fallback = '—'): string {
  const date = parseTime(value)
  if (!date) return fallback
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatDate(value: string | number | null | undefined, fallback = '—'): string {
  const date = parseTime(value)
  return date ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` : fallback
}

export function formatScore(value: number | null | undefined, digits = 1, fallback = '—'): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits).replace(/\.0+$/, '') : fallback
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
