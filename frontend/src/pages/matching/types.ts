/** 人岗匹配接口（/api/matching/*、/api/library/*）返回的数据结构。 */

export type MatchingMode = 'job_to_people' | 'people_to_jobs'

export interface DecisionOption {
  value: string
  label: string
}

export interface MatchingOptions {
  max_people: number
  max_jobs?: number
  decisions: DecisionOption[]
  fit_decisions: DecisionOption[]
  can_create: boolean
  can_review: boolean
  can_export: boolean
  can_delete: boolean
}

export interface TaskJob {
  id: string
  name: string
}

export interface TaskFailure {
  file: string
  reason: string
  stage: string
  /** 来自人员库的人员带人员库编号和姓名。 */
  person_id?: string
  name?: string
  candidate_id?: string
}

export interface ReviewSummary {
  passed: number
  rejected: number
  kept: number
  pending: number
  stale: number
  exportable: number
  people: number
}

export interface TaskSummary {
  id: string
  name: string
  mode: MatchingMode
  mode_label: string
  status: string
  running: boolean
  jobs: TaskJob[]
  person_batch_id: string
  total: number
  processed: number
  succeeded: number
  failed: number
  failures: TaskFailure[]
  created_at: string
  updated_at: string
  /** 排队中的任务还没有复核统计。 */
  review: ReviewSummary | null
}

export interface JobStandard {
  id: string
  name: string
  level: string
  sequence: string
  weight_version: string
  dimensions: Array<{ name: string; weight: number }>
  hard_conditions: string[]
}

export interface MatrixCell {
  total: number | null
  decision: string | null
  analysis_status: string
  conclusion: string
}

export interface PersonRow {
  /** 尚未解析成功的材料没有人员编号，只能查看处理说明。 */
  candidate_id: string | null
  code: string
  name: string
  source_filename: string
  total: number | null
  conclusion: string
  analysis_status: string
  review_status: string
  decision: string
  material_confirmed: boolean
  reviewed_jobs: string
  review_comment: string
  reviewer: string
  reviewed_at: string
  report_ready: boolean
  report_blockers: string[]
  note: string
  person_id: string
  rank: number | null
  strengths?: string[]
  risks?: string[]
  hard_failed?: string[]
  hard_unknown?: string[]
  /** 各维度得分，用于图表对比。 */
  dimensions?: Array<{ dimension: string; score: number | null }>
  matrix?: Record<string, MatrixCell>
  preferred_job_id?: string | null
}

export interface TaskDetail extends TaskSummary {
  job_standards: JobStandard[]
  people: PersonRow[]
}

export interface EvidenceItem {
  text: string
  file: string
  location: string
  origin?: string
}

export interface DimensionScore {
  dimension: string
  weight: number | null
  score: number | null
  weighted: number | null
  status: string
  reason: string
  evidence: EvidenceItem[]
}

export interface HardCheckResult {
  condition: string
  status: string
  evidence: string
  sources: EvidenceItem[]
}

export interface Assessment {
  job_id: string
  job_name: string
  decision: string | null
  review_comment: string
  total: number | null
  coverage_percent: number | null
  conclusion: string
  summary: string
  score_note: string
  evidence_summary: string
  next_step: string
  recommended: boolean
  analysis_status: string
  stale: boolean
  stale_reason: string
  strengths: string[]
  gaps: string[]
  risks: string[]
  verification: string[]
  questions: string[]
  dimensions: DimensionScore[]
  hard_checks: HardCheckResult[]
  weight_version: string
  assessed_at: string
  model: { status: string; reason: string; name: string }
}

export interface MaterialField {
  key: string
  label: string
  value: string
  status: string
  location: string
}

export interface Material {
  full_name: string
  source_filename: string
  parse_status: string
  confirmed: boolean
  material_version: number
  updated_at: string
  updated_by: string
  warning: string
  fields: MaterialField[]
}

export interface GeneratedReport {
  id: number
  file: string
  generated_at: string
  operator: string
}

export interface CandidateDetail {
  task: { id: string; name: string; mode: MatchingMode; running: boolean }
  candidate_id: string
  code: string
  name: string
  person_id: string
  rank?: number | null
  review_status?: string | null
  reviewer: string
  reviewed_at: string
  material: Material
  redaction: { status: string; types: string[] }
  assessments: Assessment[]
  missing_jobs: string[]
  report: { ready: boolean; blockers: string[] }
  reports: GeneratedReport[]
  evidence: EvidenceItem[]
}

export interface MaterialUpdateResult {
  material: Material
  requires_reanalysis: boolean
  warning: string
}

/** 岗位库列表项（GET /library/jobs）。 */
export interface LibraryJob {
  id: string
  name: string
  sequence: string
  level: string
  updated_at: string
  is_active: boolean
  dimension_count: number
  hard_condition_count: number
}

/** 人员库批次（GET /library/person-batches）。 */
export interface PersonBatch {
  id: string
  name: string
  category: string
  created_at: string
  total_count: number
  parsed_count: number
  failed_count: number
  pending_count: number
}

/** 人员库批次内的人员（GET /library/person-batches/{id} → persons）。 */
export interface LibraryPerson {
  id: string
  batch_id: string
  name: string
  source_filename: string
  status: string
  parse_status: string
  confirmed: boolean
  error_message: string
  education: string
  work_experience: string
  created_at: string
}

export interface PersonBatchDetail extends PersonBatch {
  persons: LibraryPerson[]
}
