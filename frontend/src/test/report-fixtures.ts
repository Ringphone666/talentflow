import { hardIndicators } from './interview-helpers'

/** 面试报告页面测试用的数据（AI面试报告、综合报告）。 */

export const REASON = '能够说明隔离、复检和上报的先后顺序，判断依据清楚；但没有说明复检后的改进措施，结果描述较笼统，需要在人工面试中进一步核实。'
export const EXCERPT = '我先隔离了异常批次，然后按内控标准复检，并上报了班组长。'

export const reportContent = (overrides: Record<string, unknown> = {}) => ({
  disclaimer: 'AI辅助生成，须人工复核。',
  candidate: '张三',
  summary: '候选人能够结合质量异常案例说明处置过程。',
  qa_records: [{
    sequence: 1, dimension: '岗位专业能力', answer_code: 'A1', question: '请说明一次质量异常的处理过程',
    transcript: EXCERPT, followup: '复检的依据是什么', followup_answer: '依据企业内控标准。', timed_out: false,
  }],
  evaluations: [{
    dimension: '岗位专业能力', definition: '运用生产、质量与安全知识解决岗位问题', weight: 25, score: 4, level: '4级',
    reason: REASON, answer_ids: ['A1'], evidence_excerpt: EXCERPT, evidence_sufficiency: '部分', insufficient: false,
  }],
  resume_context: { status: 'ready', text: '2019年起在某制造业公司负责质量管理', truncated: false },
  resume_checks: [],
  match_analysis: { score: 82, matched: ['岗位专业能力'], to_verify: ['抗压能力'] },
  risks: ['语音转写和评分依据须人工核实；AI不作录用决定。'],
  offline_questions: ['请补充说明复检后的改进措施。'],
  hard_indicators: hardIndicators(),
  decision: null,
  ...overrides,
})

export const report = (overrides: Record<string, unknown> = {}) => {
  const content = reportContent()
  return {
    id: 10,
    candidate: { id: 2, code: 'B-2026-01-002', name: '张三', library_person_id: 'p-1' },
    job: { id: 11, code: 'job-brew', name: '制造工艺岗', library_job_id: 'job-brew' },
    batch: { id: 1, code: 'B-2026-01', name: '第一批次' },
    status: 'pending_review', generation_error: '', current_version: 1, match_score: 82,
    current_content: content,
    versions: [{ version: 1, version_type: 'ai_original', editor: 'AI面试智能体', reason: '本次面试完成后 AI 原始生成', created_at: '2026-09-27T02:00:00', content }],
    updated_at: '2026-09-27T02:00:00',
    ...overrides,
  }
}

/** 尚未生成成功的报告没有任何版本和内容。 */
export const emptyReport = (status: 'generating' | 'generation_failed', overrides: Record<string, unknown> = {}) => report({
  status, current_version: 0, match_score: 0, current_content: {}, versions: [],
  generation_error: status === 'generation_failed' ? '文本模型响应超时，报告未生成；候选人的回答已保存' : '',
  ...overrides,
})

export const ANALYSIS = '候选人说明了隔离和复检两个动作，与简历中“负责质量异常处置”的描述一致；但复检后的改进措施没有说明，是否形成制度化做法仍需核实。'

export const comprehensiveContent = (mode: 'linked' | 'standalone', overrides: Record<string, unknown> = {}) => ({
  disclaimer: 'AI辅助生成，须人工复核', mode, generation_mode: '文本模型分析',
  stage_one: mode === 'linked' ? { report_id: 10, version: 1, status: 'confirmed', content: reportContent() } : null,
  stage_one_summary: mode === 'linked' ? '候选人能够结合质量异常案例说明处置过程。' : '本场未进行第一阶段AI面试，综合分析依据简历、岗位要求和人工面试回答。',
  stage_one_evaluations: mode === 'linked' ? reportContent().evaluations : [],
  stage_one_risks: mode === 'linked' ? ['语音转写和评分依据须人工核实；AI不作录用决定。'] : [],
  stage_two_summary: '人工面试共留存 2 段有效转写，其中 1 段包含候选人回答或待核对的混合对话。',
  stage_two_evidence: [
    { id: 'cap-1', speaker: 'interviewer', text: '请讲一次你处理质量异常的经历。' },
    { id: 'cap-2', speaker: 'candidate', text: EXCERPT },
  ],
  findings: [{
    dimension: '岗位专业能力', status: '新增证据待复核', analysis: ANALYSIS,
    stage_one_excerpt: mode === 'linked' ? '能够说明隔离、复检和上报的先后顺序' : '',
    capture_id: 'cap-2', answer_excerpt: '我先隔离了异常批次', resume_excerpt: '负责质量管理', speaker_basis: '',
  }],
  resume_context: { status: 'ready', text: '2019年起在某制造业公司负责质量管理', truncated: false },
  resume_checks: [],
  adopted_questions: ['复检之后你做了哪些改进？'],
  risks: [mode === 'linked' ? '综合分析不修改第一阶段报告或人工评分' : '本场没有第一阶段评分，综合分析不含量化评分，须由考官结合现场情况评价'],
  decision: null,
  ...overrides,
})

export const comprehensive = (mode: 'linked' | 'standalone', overrides: Record<string, unknown> = {}) => {
  const content = comprehensiveContent(mode)
  const linked = mode === 'linked'
  return {
    session_id: linked ? 31 : 32,
    mode,
    candidate: linked ? { id: 2, code: 'B-2026-01-002', name: '张三', library_person_id: 'p-1' } : { id: 3, code: 'B-LISTEN-001', name: '李四', library_person_id: 'p-2' },
    job: { id: 11, code: 'job-brew', name: '制造工艺岗' },
    batch: linked ? { id: 1, code: 'B-2026-01', name: '第一批次' } : { id: 2, code: 'B-LISTEN', name: '旁听批次' },
    status: 'pending_review', current_version: 1,
    stage_one: linked
      ? { report_id: 10, version: 1, summary: '候选人能够结合质量异常案例说明处置过程。', scores: { 岗位专业能力: 4 }, match_score: 82 }
      : { report_id: null, version: null, summary: '', scores: {}, match_score: null },
    stage_two: { summary: content.stage_two_summary, evidence_count: 2, finding_statuses: { 岗位专业能力: '新增证据待复核' } },
    hard_indicators: hardIndicators(),
    risks: [...content.stage_one_risks, ...content.risks],
    content,
    versions: [{ version: 1, version_type: 'ai_original', editor: 'AI面试智能体', reason: 'AI原始生成', created_at: '2026-09-27T03:00:00+00:00', content }],
    ...overrides,
  }
}
