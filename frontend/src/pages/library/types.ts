import type { Competency } from '../../components/CompetencyEditor'
import type { ProfileField } from '../../components/HardIndicators'

/* ---- 岗位库 ---- */

export interface JobInterviewSummary {
  configured: boolean
  interview_job_id: number | null
  audit_status: string
  batch_count: number
}

export interface JobSummary {
  id: string
  name: string
  sequence: string
  level: string
  jd_version: string
  weight_version: string
  scope: string
  is_active: boolean
  updated_at: string
  dimension_count: number
  hard_condition_count: number
  matching_task_count: number
  interview: JobInterviewSummary
}

export interface JobDimension {
  name: string
  keywords: string[]
  negative_keywords: string[]
  weight: number
}

export interface JobMaterial {
  id: number
  original_name: string
  size: number
  ocr_status: string
  ocr_text_preview: string
  ocr_at: string | null
}

export interface InterviewStandard {
  configured: boolean
  interview_job_id: number | null
  code?: string
  audit_status: string
  material_version: string
  professional_requirements: string
  competency_model: Competency[]
  materials: JobMaterial[]
  batch_count: number
  updated_at?: string
}

export interface InterviewStandardResponse extends InterviewStandard {
  default_model: Competency[]
}

export interface ScorecardChange {
  /** 能力标签或证据关键词有变化：已有匹配结果被标记为需重新分析。 */
  changed: boolean
  /** 只调整权重时，按新权重重新计算的人数。 */
  synchronized: number
}

export interface JobDetail extends JobSummary {
  responsibilities: string[]
  requirements: string[]
  hard_conditions: string[]
  dimensions: JobDimension[]
  weights: Record<string, number>
  extra_sections: Record<string, string>
  interview_standard: InterviewStandard
  scorecard_change?: ScorecardChange
}

export interface JobPayload {
  name: string
  sequence: string
  level: string
  jd_version: string
  responsibilities: string[]
  requirements: string[]
  hard_conditions: string[]
  dimensions: Array<{ name: string; keywords: string[]; negative_keywords: string[] }>
  weights: Record<string, number>
  scope: string
  extra_sections: Record<string, string>
  overwrite_job_id?: string
  overwrite_revision?: string
}

export interface JobConflict {
  job_id: string
  name: string
  revision: string
}

export interface ScorecardBasis {
  dimension: string
  reason: string
  evidence: string[]
}

export interface ScorecardSuggestion {
  dimensions: Array<{ name: string; keywords: string[]; negative_keywords?: string[] }>
  weights: Record<string, number>
  basis: ScorecardBasis[]
}

export interface JobDraft {
  name: string
  sequence: string
  level: string
  jd_version: string
  responsibilities: string[]
  requirements: string[]
  hard_conditions: Array<string | { name?: string }>
  dimensions: Array<{ name: string; keywords?: string[]; negative_keywords?: string[] }>
  weights: Record<string, number>
  scope: string
  extra_sections: Record<string, string>
  warning: string
  model_source: string
  scorecard_basis: ScorecardBasis[]
  scorecard_error: string
}

export interface JobImportItem {
  source_file: string
  index: number
  error: string
  draft: JobDraft | null
}

export interface JobImportResult {
  drafts: JobImportItem[]
}

export interface ScoringAdvice {
  job_code: string
  job_name: string
  total_weight: number
  rationale: string
  criteria: Array<{
    dimension: string
    suggested_weight: number
    definition: string
    levels: Record<string, string>
    evidence_focus: string[]
  }>
  guardrails: string[]
  status: string
  provenance: string
}

export interface CapabilityTags {
  job_id: string
  job_name: string
  [key: string]: unknown
}

/* ---- 人员库 ---- */

export interface PersonCategories {
  selectable: string[]
  all: string[]
  /** 后端若提供单次导入上限则直接使用。 */
  import_limit?: number
}

export interface PersonBatch {
  id: string
  name: string
  category: string
  created_by: string
  created_at: string
  updated_at: string
  total_count: number
  parsed_count: number
  failed_count: number
  pending_count: number
}

export interface PersonRow {
  id: string
  batch_id: string
  name: string
  source_filename: string
  status: string
  parse_status: string
  confirmed: boolean
  error_message: string
  created_at: string
  updated_at: string
  material_version: number
  education: string
  work_experience: string
}

export interface PersonBatchDetail extends PersonBatch {
  persons: PersonRow[]
}

export interface PersonProfile {
  person_id: string
  batch_id: string
  name: string
  source_filename: string
  status: string
  parse_status: string
  confirmed: boolean
  material_version: number
  fields: ProfileField[]
}

export interface EvidenceItem {
  text: string
  file: string
  location: string
  origin: string
}

export interface MatchRecord {
  task_id: string
  task_name: string
  mode: 'job_to_people' | 'people_to_jobs'
  candidate_id: string
  job_name: string
  total: number | null
  conclusion: string
  review_status: string
  decision: string | null
  updated_at: string
}

export interface InterviewRecord {
  candidate_id: number
  candidate_code: string
  batch_name: string
  job_name: string
  interview_status: string
  report_status: string
  match_score: number | null
}

export interface PersonDetail extends PersonRow {
  profile: PersonProfile
  editable_fields: Array<{ key: string; label: string }>
  warning: string
  evidence: EvidenceItem[]
  evidence_total: number
  can_edit: boolean
  matching_history: MatchRecord[]
  interviews: InterviewRecord[]
}

export interface ScanInfo {
  file: string
  pages: string
  page_count: number
  text_pages: number
  blank_pages: number
}

export interface PreflightReport {
  scans: ScanInfo[]
  errors: string[]
}

export interface PersonImportResult {
  batch_id: string
  batch_name: string
  imported: PersonRow[]
  failed: PersonRow[]
}
