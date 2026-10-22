import { Tag } from 'antd'

const resumeStates: Record<string, [label: string, color: string]> = {
  ready: ['简历可用', 'green'],
  processing: ['简历识别中', 'processing'],
  failed: ['简历识别失败', 'red'],
  empty: ['简历无可用文字', 'orange'],
  not_requested: ['未上传简历', 'default'],
}

/** 候选人简历能否作为提问依据。 */
export function ResumeStatusTag({ status }: { status?: string }) {
  const [label, color] = resumeStates[status || ''] || ['简历状态待核实', 'gold']
  return <Tag color={color}>{label}</Tag>
}

const speakerLabels: Record<string, string> = {
  candidate: '候选人回答',
  interviewer: '面试官发言',
  unknown: '发言人无法确定',
  dialogue: '连续对话',
}

export function speakerLabel(value?: string): string {
  return speakerLabels[value || ''] || '连续对话'
}

export const speakerOptions = [
  { value: 'dialogue', label: '面试官和候选人的连续对话' },
  { value: 'candidate', label: '整段是候选人回答' },
  { value: 'interviewer', label: '整段是面试官发言' },
  { value: 'unknown', label: '无法确定，不作为依据' },
]

/** 连续对话中逐段区分出的发言人。 */
export const roleNames: Record<string, string> = { interviewer: '面试官', candidate: '候选人', unknown: '未能判断' }
export const roleColors: Record<string, string> = { interviewer: 'blue', candidate: 'green', unknown: 'default' }

/** 已用时间的写法：不足一分钟写秒，超过写分秒。 */
export function elapsedText(seconds: number | undefined): string {
  const value = Math.max(0, Math.floor(seconds || 0))
  return value < 60 ? `${value} 秒` : `${Math.floor(value / 60)} 分 ${value % 60} 秒`
}

const findingColors: Record<string, string> = { 新增证据待复核: 'blue', 存在差异待核实: 'orange', 证据不足: 'default' }

export function findingColor(status: string): string {
  return findingColors[status] || 'default'
}
