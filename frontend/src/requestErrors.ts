const fieldLabels: Record<string, string> = {
  username: '登录账号', password: '密码', initial_password: '初始密码',
  code: '编号', name: '名称', duties: '岗位职责', requirements: '任职要求',
  professional_requirements: '专业能力要求', competency_model: '胜任力标准',
  material_version: '资料版本', audit_status: '审核状态', job_id: '关联岗位',
  batch_id: '招聘批次', recruitment_type: '招聘类型', profile: '候选人资料',
  phone: '手机号', email: '邮箱', education: '学历', major: '专业', years: '相关经历年限',
  dimension: '评价维度', behavior: '考察要求', levels: '评分标准',
  content: '内容', text: '告知内容', version: '版本', count: '题目数量',
  time_limit: '回答时限', change_reason: '修改原因', reason: '操作原因',
  approved: '审核结果', comment: '审核意见', rules: '敏感内容规则',
  consented: '采集同意', candidate_confirmed: '候选人确认', candidate_code: '候选人编号',
  notice_version: '告知版本', question_id: '面试题目', transcript: '转写内容',
  file: '上传文件', capture_id: '录音记录', suggestion_id: '建议问题',
  action: '操作方式', edited_text: '调整后的问题', speaker: '发言人',
  library_job_id: '关联岗位', mode: '面试方式', person_ids: '所选人员', person_batch_id: '人员批次', job_ids: '所选岗位',
  hours: '有效时间', consent_attested: '现场告知确认', expected_version: '报告版本', create_login: '登录凭据',
  category: '批次分类', sequence: '岗位类别', level: '职级', jd_version: '说明书版本', responsibilities: '岗位职责',
  hard_conditions: '硬性条件', dimensions: '能力标签', weights: '权重', keywords: '关键词',
  decision: '复核结论', material_checked: '资料核对确认', full_name: '姓名', fields: '人员资料', files: '上传文件',
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

// Only display short human-readable business messages. Never stringify response payloads.
function businessMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const message = value.trim()
  if (!message || message.length > 500 || !/[\u3400-\u9fff]/u.test(message)) return null
  if (/^[\[{]|<[^>]+>|Traceback|\b[A-Za-z_]*(?:Error|Exception)\b|\n\s*(?:at |File )|https?:\/\/|[A-Za-z]:[\\/]/i.test(message)) return null
  if (message.startsWith('当前角色无权限执行：')) return '当前账号无权执行此操作，请联系管理员调整权限'
  return message
}

function fieldLabel(location: unknown): string {
  if (!Array.isArray(location)) return '填写内容'
  const parts = location.filter(part => !['body', 'query', 'path', 'header', 'cookie'].includes(String(part)))
  return parts.map(part => typeof part === 'number' && Number.isInteger(part) && part >= 0
    ? `第 ${part + 1} 项`
    : typeof part === 'string' ? fieldLabels[part] || '' : '')
    .filter(Boolean).join(' · ') || '填写内容'
}

function validationMessage(value: unknown): string | null {
  const error = record(value)
  if (!error) return businessMessage(value)
  const label = fieldLabel(error.loc)
  const context = record(error.ctx)
  const limit = (key: string) => typeof context?.[key] === 'number' && Number.isFinite(context[key])
    ? String(context[key]) : null
  const type = typeof error.type === 'string' ? error.type : ''
  let reason = ''
  if (type === 'missing' || type === 'value_error.missing') reason = '不能为空'
  else if (type === 'string_too_short' && limit('min_length')) reason = `至少填写 ${limit('min_length')} 个字符`
  else if (type === 'string_too_long' && limit('max_length')) reason = `最多填写 ${limit('max_length')} 个字符`
  else if (type === 'greater_than_equal' && limit('ge')) reason = `不能小于 ${limit('ge')}`
  else if (type === 'less_than_equal' && limit('le')) reason = `不能大于 ${limit('le')}`
  else if (type === 'greater_than' && limit('gt')) reason = `必须大于 ${limit('gt')}`
  else if (type === 'less_than' && limit('lt')) reason = `必须小于 ${limit('lt')}`
  else if (['int_parsing', 'int_type', 'int_from_float'].includes(type)) reason = '请填写整数'
  else if (['float_parsing', 'float_type', 'finite_number'].includes(type)) reason = '请填写有效数字'
  else if (['bool_parsing', 'bool_type', 'literal_error', 'enum'].includes(type)) reason = '请选择有效的选项'
  else if (type === 'string_type') reason = '请填写文字'
  else if (type === 'json_invalid') return '提交内容格式不正确，请检查后重试'
  else reason = businessMessage(error.msg) || '填写格式不正确，请检查后重试'
  return `${label}：${reason}`
}

export function formatResponseError(status: number, body: unknown): string {
  const payload = record(body)
  const detail = payload?.detail
  const detailObject = record(detail)
  const message = businessMessage(detail) || businessMessage(detailObject?.message) || businessMessage(detailObject?.msg)
  if (message) return message
  if (status === 422 && Array.isArray(detail)) {
    const messages = [...new Set(detail.map(validationMessage).filter((item): item is string => Boolean(item)))]
    if (messages.length) return messages.slice(0, 4).join('；') + (messages.length > 4 ? '；其余填写项也请检查' : '')
  }
  if (status === 401) return '登录状态已失效，请重新登录'
  if (status === 403) return '当前账号无权执行此操作，请联系管理员'
  if (status === 404) return '所需记录或文件不存在，请确认后重试'
  if (status === 408 || status === 504) return '处理超时，请稍后重试'
  if (status === 409) return '当前状态无法完成此操作，请核对后重试'
  if (status === 413) return '提交的文件或内容过大，请缩小后重试'
  if (status === 422 || status === 400) return '提交内容有误，请检查填写内容后重试'
  if (status === 423) return '账号已临时锁定，请稍后再试或联系工作人员重置密码'
  if (status === 501) return '该功能尚未对接，暂时不能使用'
  if (status === 429) return '操作过于频繁，请稍后重试'
  if (status >= 500) return '服务暂时无法完成操作，请稍后重试；如仍失败，请联系管理员'
  return '操作未完成，请稍后重试'
}

export function formatConnectionError(error: unknown): string {
  const name = error instanceof Error ? error.name : record(error)?.name
  if (name === 'AbortError') return '操作已取消，请重新操作'
  if (name === 'TimeoutError') return '连接超时，请检查网络后重试'
  return '无法连接服务，请检查网络后重试；如仍失败，请联系管理员'
}
