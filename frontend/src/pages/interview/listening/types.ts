import type { HardIndicatorData } from '../../../components/HardIndicators'

/** GET /batches 中本页用到的字段。 */
export interface BatchOption {
  id: number
  code: string
  name: string
  job_name: string
  mode: string
  mode_label?: string | null
  candidate_count: number
}

/** GET /listening/candidates?batch_id= 的一行。 */
export interface ListeningCandidate {
  id: number
  code: string
  name: string
  batch_id: number
  batch_name: string
  job_name: string
  interview_status: string
  stage_one: { report_id: number; status: string; match_score: number } | null
  resume_status: string
  listening_status: string
  comprehensive_status: string
}

export interface StageOneEvaluation {
  dimension: string
  reason: string
  score?: number | null
  level?: string
  insufficient?: boolean
}

/** 第一阶段AI面试报告（旁听关联的版本）。 */
export interface StageOne {
  report_id: number
  version: number
  status: string
  content: {
    summary?: string
    evaluations?: StageOneEvaluation[]
    match_analysis?: { score?: number; matched?: string[]; to_verify?: string[] }
    risks?: string[]
    offline_questions?: string[]
  }
}

export interface ResumeInfo {
  status?: string
  text?: string
  truncated?: boolean
  uploaded_at?: string
  source?: string
  note?: string
}

export type QuestionSource = 'prepared' | 'followup'
export type QuestionAction = 'adopted' | 'edited' | 'ignored'

/** 旁听开始前依据简历和岗位要求准备的提问。 */
export interface PreparedQuestion {
  id: number
  text: string
  dimension: string
  reason: string
  resume_excerpt: string
  job_excerpt: string
  status: string
  edited?: boolean
}

/** 旁听过程中依据现场回答给出的补充提问。 */
export interface Suggestion {
  id: number
  text: string
  status: string
  edited_text: string
  reason?: string
  dimension?: string
  stage_one_excerpt?: string
  answer_excerpt?: string
  resume_excerpt?: string
  capture_id?: string
  provisional?: boolean
  speaker_inferred?: boolean
  speaker_basis?: string
}

export type SpeakerRole = 'interviewer' | 'candidate' | 'unknown'

/** 连续对话中同一个人连着说的一段话。first、last 是这段话的首句和末句在整段转写中的序号。 */
export interface SpeakerTurn {
  role: SpeakerRole
  /** inferred：系统按对话语境推断；confirmed：面试官确认或改正过；pending：还没有区分。 */
  basis: 'inferred' | 'confirmed' | 'pending'
  first: number
  last: number
  text: string
}

export interface SpeakerLabel {
  speaker: string
  turns?: SpeakerTurn[]
  roles_status?: 'completed' | 'failed'
  roles_error?: string
}

/** 后台处理（生成提问建议、生成综合报告）的状态。interrupted：服务中途重启，处理没有完成。 */
export interface TaskState {
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  progress: string
  error: string
  started_at?: string
  started_by?: string
  elapsed_seconds?: number
}

export interface Capture {
  id: string
  status: string
  text: string
  speaker_status?: string
  speaker_analysis?: { turns?: Array<{ cluster_id: string }> }
}

export interface ConsentRecord {
  accepted?: boolean
  method?: string
  method_code?: 'onsite_attested' | 'prior_consent'
  confirmed_at?: string
  recorded_by?: string
  notice_version?: string
}

export interface Finding {
  dimension: string
  status: string
  analysis: string
  stage_one_excerpt?: string
  answer_excerpt?: string
  resume_excerpt?: string
  speaker_inferred?: boolean
  speaker_basis?: string
}

/** 结束旁听后生成的综合报告内容；没有第一阶段时 stage_one 为空。 */
export interface ComprehensiveReport {
  mode?: 'linked' | 'standalone'
  generation_mode?: string
  /** 没有得到模型分析时的原因。 */
  generation_note?: string
  stage_one?: StageOne | null
  stage_one_summary?: string
  stage_two_summary?: string
  findings?: Finding[]
  adopted_questions?: string[]
  risks?: string[]
}

/** GET /listening/{candidate_id} 的返回内容。 */
export interface ListeningState {
  id: number
  candidate_id: number
  candidate: { id: number; code: string; name: string }
  batch: { id: number; code: string; name: string; mode: string } | null
  job: { id: number; name: string; duties: string; requirements: string } | null
  hard_indicators: HardIndicatorData | null
  prepared_questions: PreparedQuestion[]
  /** linked：关联第一阶段AI面试报告；standalone：仅依据简历和岗位要求。 */
  mode: 'linked' | 'standalone'
  stage_one: StageOne | null
  resume_context?: ResumeInfo
  consent_record?: ConsentRecord
  prior_consent_valid: boolean
  notice_version: string
  notice_text: string
  asr_mode: 'doubao' | 'mock' | 'unavailable'
  status: 'ready' | 'running' | 'completed'
  speakers?: Record<string, SpeakerLabel>
  transcript: string[]
  suggestions: Suggestion[]
  captures: Capture[]
  comprehensive_report: ComprehensiveReport | null
  comprehensive_report_meta?: {
    status: string
    current_version: number
    generation_error?: string
    versions?: Array<{ version: number; version_type: string }>
  }
  tasks?: { prepare: TaskState | null; report: TaskState | null }
}

/** 旁听记录当前正在进行的处理：开始录音、保存本段、结束并生成综合报告。 */
export type SessionPhase = 'idle' | 'starting' | 'saving' | 'finishing'

export interface SuggestionResult {
  suggestions: Suggestion[]
  prepared_questions: PreparedQuestion[]
}

/** 后端记录“面试官现场告知并取得同意”时使用的方式名称。 */
export const ONSITE_CONSENT_METHOD = '面试官现场告知并取得同意'
