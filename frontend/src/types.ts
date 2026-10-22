import type { ResumeContext, ResumeCheck } from './components/ResumeEvidence'
export type Role = 'system_admin' | 'hr_admin' | 'business_user' | 'question_reviewer' | 'interviewer' | 'report_reviewer' | 'candidate'

export interface Session {
  access_token: string
  expires_at: number
  username: string
  display_name: string
  role: Role
  role_label: string
  permissions: string[]
  candidate_id?: number | null
  /** 候选人会话的进入方式；线下集中面试现场入口为 onsite。 */
  entry_mode?: 'account' | 'onsite'
}

export interface Question {
  id: number
  batch_id: number
  job_id: number
  sequence: number
  dimension: string
  content: string
  time_limit: number
  version: number
  status: string
  review_comment: string
  change_log: Array<Record<string, unknown>>
}

export interface Evaluation {
  dimension: string
  definition: string
  weight: number
  score: number | null
  level: string
  reason: string
  answer_ids: string[]
  evidence_excerpt: string
  evidence_sufficiency: string
  insufficient: boolean
}

export interface ReportContent {
  resume_context?: ResumeContext
  resume_checks?: ResumeCheck[]
  disclaimer: string
  candidate: string
  summary: string
  qa_records: Array<Record<string, unknown>>
  evaluations: Evaluation[]
  match_analysis: { score: number; matched: string[]; to_verify: string[] }
  risks: string[]
  offline_questions: string[]
  decision: null
}

export interface ReportItem {
  id: number
  candidate: { id: number; code: string; name: string }
  job?: { id: number; code: string; name: string } | null
  batch?: { id: number; code: string; name: string } | null
  status: string
  current_version: number
  match_score: number
  current_content: ReportContent
  versions: Array<{ version: number; version_type: string; editor: string; reason: string; created_at: string; content: ReportContent }>
}
