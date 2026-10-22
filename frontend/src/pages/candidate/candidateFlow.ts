import type { Question } from '../../types'

export interface InterviewAnswer {
  id: number
  question_id: number
  answer_code: string
  transcript: string
  followup_text: string
  followup_answer: string
  timed_out: boolean
}

/** GET /interviews/me 的返回内容。 */
export interface InterviewState {
  id: number
  asr_mode?: string
  /** account：账号密码登录；onsite：线下集中面试现场入口。 */
  entry_mode?: 'account' | 'onsite'
  candidate: { code: string; name: string }
  status: string
  consented: boolean
  consent_version: string
  /** online：候选人在页面上阅读并同意；offline_attested：工作人员确认已在现场告知并取得同意。 */
  consent_method?: 'online' | 'offline_attested'
  available_consent_version?: string
  consent_text?: string
  needs_consent?: boolean
  profile?: Record<string, string>
  profile_complete?: boolean
  needs_profile?: boolean
  mic_checked: boolean
  current_question: number
  question_version: number
  questions: Question[]
  answers: InterviewAnswer[]
  started_at?: string | null
  completed_at?: string | null
}

export type StepKey = 'profile' | 'consent' | 'device' | 'interview' | 'done'

export const STEP_TITLES: Record<StepKey, string> = {
  profile: '个人信息',
  consent: '合规须知',
  device: '设备检测',
  interview: '面试',
  done: '完成',
}

const PREPARATION_STATUSES = ['consent_pending', 'consent_declined', 'mic_check', 'ready']

/** 尚未正式开始：可以返回修改准备内容。 */
export function isPreparing(interview: InterviewState): boolean {
  return PREPARATION_STATUSES.includes(interview.status) && !interview.started_at && !interview.completed_at
}

/** 候选人是否还需要在页面上阅读并同意采集须知。 */
export function consentPending(interview: InterviewState): boolean {
  return Boolean(interview.needs_consent) || !interview.consented
    || interview.status === 'consent_pending' || interview.status === 'consent_declined'
}

/**
 * 本次面试显示的步骤。
 * 账号登录：个人信息 → 合规须知 → 设备检测 → 面试 → 完成；
 * 现场入口：不填写个人信息；工作人员已在现场告知并取得同意的，合规须知一并跳过。
 */
export function flowSteps(interview: InterviewState): StepKey[] {
  const onsite = interview.entry_mode === 'onsite'
  const steps: StepKey[] = []
  if (!onsite || interview.needs_profile) steps.push('profile')
  if (!onsite || interview.consent_method !== 'offline_attested' || consentPending(interview)) steps.push('consent')
  steps.push('device', 'interview', 'done')
  return steps
}

/** 准备阶段按服务端状态能够到达的最远一步；候选人只能从这一步往回修改。 */
export function reachedStep(interview: InterviewState): StepKey {
  if (interview.needs_profile) return 'profile'
  if (consentPending(interview)) return 'consent'
  return 'device'
}

/** 采集须知按段落显示：空行分段，段内换行保留。 */
export function noticeParagraphs(text: string | undefined): string[] {
  return (text || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(part => part.trim()).filter(Boolean)
}
