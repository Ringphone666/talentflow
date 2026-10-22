import { ApiError } from '../../api'
import type { JobConflict, JobDetail, JobDraft, JobPayload } from './types'

export const JD_FILE_TYPES = ['.pdf', '.docx', '.txt']
export const JD_MAX_BYTES = 20 * 1024 * 1024
export const JD_MAX_FILES = 10
export const MAX_DIMENSIONS = 12
export const MAX_KEYWORDS = 32
export const MAX_DIMENSION_NAME = 60

export interface DimensionFormValue {
  name: string
  weight: number | null
  keywords: string
  negative_keywords: string
}

export interface ExtraSectionFormValue {
  name: string
  content: string
}

export interface JobProfileFormValues {
  name: string
  sequence: string
  level: string
  jd_version: string
  responsibilities: string
  requirements: string
  hard_conditions: string
  scope: string
  extra_sections: ExtraSectionFormValue[]
}

export interface JobScorecardFormValues {
  dimensions: DimensionFormValue[]
}

export type JobFormValues = JobProfileFormValues & JobScorecardFormValues

/** AI 生成能力标签建议时需要的岗位内容。 */
export interface ScorecardContext {
  name: string
  responsibilities: string[]
  requirements: string[]
}

export function splitLines(text: string | null | undefined): string[] {
  return String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}

/** 关键词用顿号、逗号、分号或换行分隔。 */
export function parseKeywords(text: string | null | undefined): string[] {
  const words = String(text || '').split(/[、,，;；\n]+/).map(word => word.trim()).filter(Boolean)
  return [...new Set(words)]
}

export function joinKeywords(words: string[] | null | undefined): string {
  return (words || []).map(word => String(word).trim()).filter(Boolean).join('、')
}

const hundredths = (value: unknown) => Math.round((Number(value) || 0) * 100)

export function weightTotal(dimensions: Array<Partial<DimensionFormValue> | undefined> | undefined): number {
  return (dimensions || []).reduce((sum, item) => sum + hundredths(item?.weight), 0) / 100
}

export function isTotalValid(total: number): boolean {
  return Math.abs(total - 100) <= 0.01
}

export function formatWeight(value: number): string {
  return String(Math.round(value * 100) / 100)
}

/** 平均分配：保留两位小数，余数补到最后一项，合计正好 100。 */
export function equalWeights(count: number): number[] {
  if (count <= 0) return []
  const each = Math.floor(10000 / count)
  const weights = Array.from({ length: count }, () => each / 100)
  weights[count - 1] = (10000 - each * (count - 1)) / 100
  return weights
}

export function blankDimension(): DimensionFormValue {
  return { name: '', weight: null, keywords: '', negative_keywords: '' }
}

function isBlank(item: Partial<DimensionFormValue> | undefined): boolean {
  if (!item) return true
  const hasWeight = item.weight !== null && item.weight !== undefined
  return !item.name?.trim() && !hasWeight && !item.keywords?.trim() && !item.negative_keywords?.trim()
}

/** 返回第一处问题的说明；没有问题时返回 undefined。 */
export function validateDimensions(dimensions: Array<Partial<DimensionFormValue> | undefined> | undefined): string | undefined {
  const rows = (dimensions || []).filter(item => !isBlank(item)) as Array<Partial<DimensionFormValue>>
  if (!rows.length) return '请至少添加一项能力标签'
  if (rows.length > MAX_DIMENSIONS) return `能力标签最多 ${MAX_DIMENSIONS} 项，请合并相近的标签`
  const names = new Set<string>()
  for (const [index, item] of rows.entries()) {
    const name = item.name?.trim() || ''
    if (!name) return `第 ${index + 1} 项：请填写能力标签名称`
    if (name.length > MAX_DIMENSION_NAME) return `能力标签“${name}”过长，请控制在 ${MAX_DIMENSION_NAME} 个字以内`
    if (names.has(name)) return `能力标签“${name}”重复，请合并后保存`
    names.add(name)
    const weight = item.weight
    if (weight === null || weight === undefined || !Number.isFinite(Number(weight))) return `请填写“${name}”的权重`
    if (Number(weight) < 0 || Number(weight) > 100) return `“${name}”的权重须在 0 至 100 之间`
    if (parseKeywords(item.keywords).length > MAX_KEYWORDS) return `“${name}”的证据关键词最多 ${MAX_KEYWORDS} 个`
    if (parseKeywords(item.negative_keywords).length > MAX_KEYWORDS) return `“${name}”的排除关键词最多 ${MAX_KEYWORDS} 个`
  }
  const total = weightTotal(rows)
  if (!isTotalValid(total)) return `权重合计须为 100%，当前为 ${formatWeight(total)}%`
  return undefined
}

function hardConditionNames(values: JobDraft['hard_conditions'] | string[] | undefined): string[] {
  return (values || [])
    .map(item => typeof item === 'string' ? item : String(item?.name || ''))
    .map(item => item.trim())
    .filter(Boolean)
}

type ProfileSource = Pick<JobDetail, 'name' | 'sequence' | 'level' | 'jd_version' | 'responsibilities' | 'requirements' | 'scope' | 'extra_sections'>
  & { hard_conditions: JobDraft['hard_conditions'] | string[] }

export function profileValuesOf(job: ProfileSource): JobProfileFormValues {
  return {
    name: job.name || '',
    sequence: job.sequence || '',
    level: job.level || '',
    jd_version: job.jd_version || '',
    responsibilities: (job.responsibilities || []).join('\n'),
    requirements: (job.requirements || []).join('\n'),
    hard_conditions: hardConditionNames(job.hard_conditions).join('\n'),
    scope: job.scope || '',
    extra_sections: Object.entries(job.extra_sections || {}).map(([name, content]) => ({ name, content: String(content ?? '') })),
  }
}

export function scorecardValuesOf(
  dimensions: Array<{ name: string; keywords?: string[]; negative_keywords?: string[] }> | undefined,
  weights: Record<string, number> | undefined,
): JobScorecardFormValues {
  const rows = (dimensions || []).map(item => {
    const weight = weights?.[item.name]
    return {
      name: item.name,
      weight: typeof weight === 'number' && Number.isFinite(weight) ? weight : null,
      keywords: joinKeywords(item.keywords),
      negative_keywords: joinKeywords(item.negative_keywords),
    }
  })
  return { dimensions: rows.length ? rows : [blankDimension()] }
}

export function blankJobValues(): JobFormValues {
  return {
    name: '', sequence: '', level: '', jd_version: '', responsibilities: '', requirements: '', hard_conditions: '',
    scope: '', extra_sections: [], dimensions: [blankDimension()],
  }
}

export function jobValuesOfDetail(job: JobDetail): JobFormValues {
  return { ...profileValuesOf(job), ...scorecardValuesOf(job.dimensions, job.weights) }
}

export function jobValuesOfDraft(draft: JobDraft): JobFormValues {
  return { ...profileValuesOf(draft), ...scorecardValuesOf(draft.dimensions, draft.weights) }
}

export function buildPayload(profile: JobProfileFormValues, scorecard: JobScorecardFormValues): JobPayload {
  const text = (value: unknown) => String(value ?? '').trim()
  const rows = (scorecard.dimensions || []).filter(item => !isBlank(item))
  const dimensions = rows.map(item => {
    const name = text(item.name)
    const keywords = parseKeywords(item.keywords)
    // 未填写证据关键词时，以标签名称作为关键词（界面上有说明）。
    return { name, keywords: keywords.length ? keywords : [name], negative_keywords: parseKeywords(item.negative_keywords) }
  })
  const weights: Record<string, number> = {}
  rows.forEach(item => { weights[text(item.name)] = hundredths(item.weight) / 100 })
  const extra: Record<string, string> = {}
  for (const item of profile.extra_sections || []) {
    const name = text(item?.name)
    const content = text(item?.content)
    if (name && content) extra[name] = content
  }
  return {
    name: text(profile.name),
    sequence: text(profile.sequence),
    level: text(profile.level),
    jd_version: text(profile.jd_version),
    responsibilities: splitLines(profile.responsibilities),
    requirements: splitLines(profile.requirements),
    hard_conditions: splitLines(profile.hard_conditions),
    dimensions,
    weights,
    scope: text(profile.scope),
    extra_sections: extra,
  }
}

/** 同名岗位冲突：后端返回 409，并在 detail.conflict 中给出原岗位和版本指纹。 */
export function conflictOf(error: unknown): JobConflict | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null
  const detail = error.detail
  if (!detail || typeof detail !== 'object') return null
  const conflict = (detail as { conflict?: Partial<JobConflict> }).conflict
  if (!conflict || typeof conflict.job_id !== 'string' || typeof conflict.revision !== 'string') return null
  return { job_id: conflict.job_id, name: String(conflict.name ?? ''), revision: conflict.revision }
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((item, index) => item === b[index])

/** 修改了名称、职责、任职要求或硬性条件时，后端会把该岗位已有的匹配结果标记为需重新分析。 */
export function profileAffectsMatching(before: JobDetail, payload: JobPayload): boolean {
  const clean = (items: string[]) => items.map(item => item.trim()).filter(Boolean)
  return before.name !== payload.name
    || !sameList(clean(before.responsibilities), payload.responsibilities)
    || !sameList(clean(before.requirements), payload.requirements)
    || !sameList(clean(before.hard_conditions), payload.hard_conditions)
}

export function fileExtension(name: string): string {
  const index = name.lastIndexOf('.')
  return index < 0 ? '' : name.slice(index).toLowerCase()
}
