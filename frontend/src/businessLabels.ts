/** Display labels only; API values and stored records remain unchanged. */
export const roleLabels: Record<string, string> = {
  system_admin: '系统管理员', hr_admin: 'HR管理员', business_user: '用人部门', question_reviewer: '题目审核人',
  interviewer: '面试官', report_reviewer: '报告复核人', candidate: '候选人',
}

export const ocrStatusLabels: Record<string, string> = {
  not_requested: '待识别', pending: '待识别', processing: '识别中',
  completed: '已完成', failed: '识别失败', disabled: '未启用', unavailable: '服务不可用',
}

export const captureStatusLabels: Record<string, string> = {
  created: '待录音', recording: '录音中', completed: '已保存，待关联',
  linked: '已关联面试', interrupted: '录音中断', failed: '录音失败',
}

export function reportVersionLabel(value: string) {
  return ({
    ai_original: 'AI原始版本', ai_regenerated: 'AI重新评分版本', human_modified: '人工修改版本', human_edit: '人工修改版本',
  } as Record<string, string>)[value] || '其他历史版本'
}

export const auditActionLabels: Record<string, string> = {
  system_initialized: '系统初始化', login: '候选人登录', login_locked: '账号临时锁定', host_entry: '主系统授权进入',
  // 基础数据
  library_job_saved: '保存岗位', library_job_archived: '删除岗位', library_job_restored: '恢复岗位', library_job_purged: '彻底删除岗位',
  capability_tags_exported: '输出岗位能力标签',
  job_material_updated: '修改面试评价标准', job_material_uploaded: '上传岗位补充资料', job_material_deleted: '删除岗位补充资料',
  job_material_ocr_completed: '岗位资料文字识别完成', job_material_ocr_failed: '岗位资料文字识别失败', job_scoring_advice_generated: '生成面试评分标准建议',
  person_batch_created: '新建人员批次', person_batch_updated: '修改人员批次', person_batch_deleted: '删除人员批次',
  person_import_started: '导入人员简历', person_reparse_started: '重新解析简历', person_material_updated: '修改人员资料',
  person_material_confirmed: '确认人员资料', person_file_viewed: '查看原始简历', person_files_exported: '导出人员资料', person_list_exported: '导出人员明细',
  // 人岗匹配
  matching_task_created: '新建匹配任务', matching_task_retried: '重试匹配任务', matching_task_reanalyzed: '重新分析匹配任务',
  matching_task_deleted: '删除匹配任务', matching_candidate_deleted: '从任务中删除人员', matching_material_updated: '修改任务内人员资料',
  matching_material_confirmed: '确认任务内人员资料', matching_review_saved: '保存人工复核结论', matching_report_exported: '导出匹配报告',
  matching_review_sheet_exported: '导出审核明细', matching_results_exported: '输出结构化匹配结果', matching_evidence_exported: '导出佐证数据包',
  // AI面试
  batch_created: '新增招聘批次', batch_updated: '修改招聘批次', batch_deleted: '删除招聘批次',
  onsite_entry_created: '开启现场面试入口', onsite_entry_reopened: '在本机打开现场面试入口', onsite_entry_revoked: '关闭现场面试入口', onsite_session_started: '通过现场入口进入面试',
  candidate_created: '新增候选人', candidate_updated: '修改候选人', candidate_deleted: '删除候选人', candidate_password_reset: '重新生成候选人密码',
  candidate_profile_updated: '候选人填写面试资料', candidate_resume_uploaded: '上传或替换简历', candidate_resume_deleted: '移除简历',
  candidate_resume_viewed: '查看候选人简历', candidate_resume_ocr_completed: '简历解析完成', candidate_resume_ocr_failed: '简历解析失败',
  question_generated: '生成题目', question_generation_failed: '题目生成失败', question_created: '手动新增题目', question_updated: '修改题目', question_deleted: '删除题目',
  question_submitted: '提交题目审核', question_reviewed: '审核题目', question_version_reviewed: '整套题目审核通过', question_version_deleted: '删除题目版本',
  question_published: '发布题目', question_disabled: '停用题目',
  microphone_checked: '检测麦克风', interview_started: '开始面试', interview_submitted: '提交面试',
  candidate_consented: '同意面试采集', candidate_declined: '拒绝面试采集',
  dynamic_followup_generated: '生成补充问题', sensitive_content_blocked: '拦截敏感内容', sensitive_rules_updated: '修改敏感内容规则', consent_notice_updated: '更新采集告知',
  answer_saved: '保存主体题回答', followup_answer_saved: '保存追问回答', interview_reset: '重置面试',
  legacy_interview_completion_restored: '恢复历史面试完成状态',
  speech_consent: '同意语音采集', speech_transcribed: '语音转写完成', speech_interrupted: '语音转写未完成', speech_aligned: '录音与文字时间对应完成',
  ai_report_generated: '生成AI面试报告', ai_report_generation_failed: 'AI面试报告生成失败', ai_report_generation_retried: '重新生成AI面试报告',
  ai_report_regenerated: 'AI重新评分', human_report_modified: '人工修改面试报告', human_report_confirmed: '人工确认面试报告',
  report_returned: '退回面试报告', report_exported: '导出面试报告', interview_result_synced: '面试结论同步人员库', comparison_exported: '导出候选人对比',
  listening_questions_prepared: '生成旁听提问建议', listening_consent_attested: '面试官确认现场告知', listening_consent_reused: '核验已有采集同意',
  listening_started: '开始AI旁听', listening_suggestion_updated: '处理旁听建议', listening_transcribed: '关联旁听转写', listening_finished: '结束AI旁听',
  speaker_diarization_completed: '发言人区分完成', speaker_diarization_failed: '发言人区分失败', speaker_labelled: '标注发言人',
  speaker_turn_confirmed: '确认或改正发言人',
  combined_report_generated: '生成综合报告', combined_report_failed: '综合报告生成失败', combined_report_regenerate: '重新生成综合报告',
  human_comprehensive_report_modified: '人工修改综合报告', human_comprehensive_report_returned: '退回综合报告',
  human_comprehensive_report_confirmed: '人工确认综合报告', comprehensive_report_exported: '导出综合报告',
}

export const auditTargetLabels: Record<string, string> = {
  system: '系统', user: '用户账号', job: '岗位', job_material: '岗位资料', person_batch: '人员批次', person: '人员',
  matching_task: '匹配任务', matching_candidate: '任务内人员',
  batch: '招聘批次', candidate: '候选人', question: '面试题',
  interview: '面试记录', answer: '回答记录', report: '面试报告', listening: 'AI旁听', listening_report: '综合报告',
  speech_capture: '录音记录', sensitive_block: '敏感内容拦截记录', config: '系统设置',
}

export function auditDetailLabel(action: string, detail: string) {
  if (!detail) return '—'
  if (action === 'candidate_consented' || action === 'candidate_declined') {
    try {
      const parsed: unknown = JSON.parse(detail)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>
        if (typeof record.version === 'string' && typeof record.notice === 'string') return `告知版本：${record.version}；告知内容：${record.notice}`
      }
    } catch { /* Historical plain-text details already have a readable form. */ }
  }
  if (action === 'question_reviewed') return ({ approved: '审核通过', returned: '已退回修改' } as Record<string, string>)[detail] || detail
  if (action === 'speaker_labelled') return ({ candidate: '标记为候选人', interviewer: '标记为面试官', unknown: '发言人待核对', mixed: '包含多位发言人', dialogue: '标记为面试官和候选人的连续对话' } as Record<string, string>)[detail] || detail
  if (action === 'speaker_turn_confirmed') return detail.replace(/(interviewer|candidate|unknown)$/, value => ({ interviewer: '面试官', candidate: '候选人', unknown: '无法判断' }[value] || value))
  if (action === 'listening_suggestion_updated') return detail.replace(/执行 (adopted|ignored|edited)$/, (_, value: string) => ({ adopted: '已提问', ignored: '已跳过', edited: '已调整并提问' }[value] || value))
  if (action === 'microphone_checked') {
    const passed = detail.match(/(?:^|, )passed=(True|False)/)?.[1]
    const duration = detail.match(/duration_ms=(\d+)/)?.[1]
    const spoken = detail.match(/speech_text=(.*)$/)?.[1]
    if (passed) return `${passed === 'True' ? '检测通过' : '检测未通过'}${duration ? `；检测时长：${(Number(duration) / 1000).toFixed(1)}秒` : ''}${spoken ? `；识别内容：${spoken}` : ''}`
  }
  if (action === 'answer_saved' || action === 'followup_answer_saved') return detail.replace(/超时=(True|False)/, (_, value: string) => `是否超时：${value === 'True' ? '是' : '否'}`)
  if (action.includes('_ocr_')) return detail.replace(/PaddleOCR/g, '文字识别服务')
  if (action === 'speaker_diarization_completed' || action === 'speaker_diarization_failed') return detail.replace(/3D-Speaker(?:本地服务)?/g, '发言人区分服务')
  return detail
}
