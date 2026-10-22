import type { Session } from '../types'

/** AI旁听页面测试共用的接口数据，字段与后端返回一致。 */
export const interviewer: Session = {
  access_token: 'interviewer-token', expires_at: 4102444800, username: 'interviewer-a', display_name: '面试官甲',
  role: 'interviewer', role_label: '面试官',
  permissions: ['dashboard', 'job:read', 'person:read', 'report:read', 'listening:use', 'compare:read', 'matching:view', 'matching:review'],
}

export const NOTICE_VERSION = 'INTERVIEW-TWO-STAGE-3.0'
export const ONSITE_METHOD = '面试官现场告知并取得同意'

export const batches = [
  { id: 2, code: 'B-2026-02', name: '2026年校园招聘', job_name: '制造工艺员', mode: 'listening_only', mode_label: '仅人工面试旁听', candidate_count: 2 },
  { id: 1, code: 'B-2026-01', name: '2026年社会招聘', job_name: '质量检验员', mode: 'ai_interview', mode_label: 'AI面试 + 人工面试旁听', candidate_count: 1 },
]

export const candidatesByBatch: Record<number, unknown[]> = {
  2: [
    { id: 21, code: 'XZ-021', name: '候选人甲', batch_id: 2, batch_name: '2026年校园招聘', job_name: '制造工艺员', library_person_id: 'P-21',
      interview_status: 'not_required', stage_one: null, resume_status: 'ready', listening_status: 'ready', comprehensive_status: 'not_generated' },
    { id: 22, code: 'XZ-022', name: '候选人乙', batch_id: 2, batch_name: '2026年校园招聘', job_name: '制造工艺员', library_person_id: null,
      interview_status: 'not_required', stage_one: null, resume_status: 'not_requested', listening_status: 'completed', comprehensive_status: 'pending_review' },
  ],
  1: [
    { id: 11, code: 'SZ-011', name: '候选人丙', batch_id: 1, batch_name: '2026年社会招聘', job_name: '质量检验员', library_person_id: 'P-11',
      interview_status: 'completed', stage_one: { report_id: 5, status: 'pending_review', match_score: 82 }, resume_status: 'ready',
      listening_status: 'ready', comprehensive_status: 'not_generated' },
  ],
}

export const hardIndicators = {
  available: true, reason: '', profile: null, counted_in_score: false, matching: null,
  facts: [
    { key: 'education', label: '教育经历', value: '2019年9月至2023年6月 某大学 食品科学与工程 本科', status: '已确认' },
    { key: 'work_experience', label: '工作经历', value: '2023年7月至今 某制造业公司 装配车间 工艺员', status: '待人工确认' },
    { key: 'tenure', label: '任职时间', value: '现岗位任职2年', status: '已确认' },
    { key: 'skills', label: '专业技能', value: '熟悉装配、加工工艺参数记录', status: '已确认' },
  ],
  hard_checks: [{ condition: '本科及以上学历', status: '满足', evidence: '简历显示2023年本科毕业', source: '关键词初核，待人工核实', sources: [] }],
  notice: '硬指标依据简历档案核对，供考官综合测评参考；是否计入评分及具体规则待人力资源部确认。',
}

export const stageOne = {
  report_id: 5, version: 2, version_type: 'ai_original', status: 'pending_review',
  content: {
    summary: '候选人完成了质量检验员岗位的第一阶段AI面试，能够说明取样和复检流程。',
    evaluations: [
      { dimension: '岗位专业能力', reason: '能够说明取样、复检和记录的顺序。', score: 4, level: '4级', insufficient: false },
      { dimension: '职业稳定性', reason: '长期动机证据不足', score: null, level: '', insufficient: true },
    ],
    match_analysis: { score: 82, matched: ['能够描述规范执行'], to_verify: ['核实长期岗位动机'] },
    risks: ['语音转写内容需人工核实准确性'],
    offline_questions: ['请补充一个你独立处理现场异常的完整例子。'],
  },
}

/** 没做过第一阶段AI面试、系统内也没有同意记录的候选人。 */
export function standaloneState(overrides: Record<string, unknown> = {}) {
  return {
    id: 9, candidate_id: 21,
    candidate: { id: 21, code: 'XZ-021', name: '候选人甲', library_person_id: 'P-21' },
    batch: { id: 2, code: 'B-2026-02', name: '2026年校园招聘', mode: 'listening_only' },
    job: { id: 3, name: '制造工艺员', library_job_id: 'J-3', duties: '负责装配、加工过程的工艺执行和记录。', requirements: '食品、生物工程相关专业；能适应倒班。' },
    hard_indicators: hardIndicators,
    prepared_questions: [] as unknown[],
    mode: 'standalone', stage_one: null,
    resume_context: { status: 'ready', text: '2023年7月至今在某制造业公司装配车间任工艺员，负责加工记录。', truncated: false, version: 'v', uploaded_at: '2026-09-01T02:00:00', source: '人员库', note: '仅核实与岗位有关的经历，不将简历自述直接作为得分证据。' },
    consent_record: {} as Record<string, unknown>, prior_consent_valid: false,
    notice_version: NOTICE_VERSION, notice_text: '本次面试仅采集音频，不采集视频。\n\n录音和转写在本地留存，须人工复核。',
    speakers: {} as Record<string, { speaker: string }>, asr_mode: 'doubao', status: 'ready',
    transcript_index: 0, transcript: [] as string[], suggestions: [] as unknown[], captures: [] as unknown[],
    comprehensive_report: null as unknown, comprehensive_report_meta: { status: 'not_generated', current_version: 0, versions: [] },
    message: '',
    ...overrides,
  }
}

/** 做过第一阶段AI面试、并在系统内同意过当前告知的候选人。 */
export function linkedState(overrides: Record<string, unknown> = {}) {
  return standaloneState({
    id: 4, candidate_id: 11,
    candidate: { id: 11, code: 'SZ-011', name: '候选人丙', library_person_id: 'P-11' },
    batch: { id: 1, code: 'B-2026-01', name: '2026年社会招聘', mode: 'ai_interview' },
    job: { id: 1, name: '质量检验员', library_job_id: 'J-1', duties: '负责原料和成品的取样检验。', requirements: '熟悉检验流程和记录要求。' },
    mode: 'linked', stage_one: stageOne, prior_consent_valid: true,
    ...overrides,
  })
}

export const preparedQuestions = [
  { id: 1, text: '请说明你在加工记录中发现异常时是怎么处理的？', dimension: '岗位专业能力', reason: '核实简历中“负责加工记录”的本人职责和处理结果。', resume_excerpt: '负责加工记录', job_excerpt: '负责装配、加工过程的工艺执行和记录', status: 'pending' },
  { id: 2, text: '倒班期间遇到工艺参数偏离，你会先做什么？', dimension: '抗压能力', reason: '岗位要求能适应倒班，核实压力下的处置顺序。', resume_excerpt: '', job_excerpt: '能适应倒班', status: 'pending' },
  { id: 3, text: '请举例说明你如何与班组长确认工艺调整。', dimension: '沟通表达', reason: '核实沟通确认的方式。', resume_excerpt: '', job_excerpt: '', status: 'pending' },
]
