import { Tag } from 'antd'

type Entry = [label: string, color: string]

/** 各类状态的统一显示：同一状态在所有页面用同样的文字和颜色。 */
const groups = {
  report: {
    generating: ['报告生成中', 'processing'], generation_failed: ['生成失败', 'red'], pending_review: ['待人工复核', 'gold'],
    returned: ['已退回', 'orange'], confirmed: ['已人工确认', 'green'], not_generated: ['未生成', 'default'],
  },
  interview: {
    consent_pending: ['未开始', 'default'], consent_declined: ['未同意采集', 'red'], mic_check: ['设备检测中', 'blue'],
    ready: ['待开始', 'blue'], in_progress: ['面试中', 'processing'], completed: ['已完成', 'green'],
    not_required: ['不做AI面试', 'default'], not_created: ['未建立', 'default'],
  },
  listening: {
    ready: ['未开始', 'default'], not_started: ['未开始', 'default'], running: ['旁听中', 'processing'], completed: ['已结束', 'green'],
  },
  batch: {
    draft: ['待出题', 'default'], reviewing: ['题目审核中', 'gold'], approved: ['题目待发布', 'blue'], active: ['进行中', 'green'], closed: ['已结束', 'default'],
  },
  question: {
    draft: ['草稿', 'default'], pending_review: ['待审核', 'gold'], approved: ['已审核', 'blue'], returned: ['已退回', 'orange'],
    published: ['已发布', 'green'], disabled: ['已停用', 'default'],
  },
  review: {
    通过: ['通过', 'green'], 未通过: ['未通过', 'red'], 保留: ['保留', 'blue'], 待审核: ['待审核', 'gold'], 需重新审核: ['需重新审核', 'orange'],
  },
  parse: {
    已解析: ['已解析', 'green'], 待解析: ['解析中', 'processing'], 解析失败: ['解析失败', 'red'],
  },
  task: {
    待处理: ['排队中', 'default'], 处理中: ['分析中', 'processing'], 已完成: ['已完成', 'green'], 部分失败: ['部分未完成', 'orange'], 失败: ['未完成', 'red'],
  },
  standard: {
    approved: ['已确认', 'green'], draft: ['待确认', 'gold'], not_configured: ['未配置', 'default'],
  },
} satisfies Record<string, Record<string, Entry>>

export type StatusKind = keyof typeof groups

export function statusLabel(kind: StatusKind, value: string | null | undefined): string {
  const group = groups[kind] as Record<string, Entry>
  return group[value || '']?.[0] || value || '—'
}

export function StatusTag({ kind, value }: { kind: StatusKind; value: string | null | undefined }) {
  const group = groups[kind] as Record<string, Entry>
  const entry = group[value || '']
  return <Tag color={entry?.[1] || 'default'}>{entry?.[0] || value || '—'}</Tag>
}
