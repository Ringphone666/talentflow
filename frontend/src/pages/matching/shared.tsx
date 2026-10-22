import { ConfigProvider, Space, Tag, Tooltip, Typography } from 'antd'
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { can } from '../../lib/access'
import type { Session } from '../../types'
import { UNKNOWN_NAME, stemOf } from '../library/personModel'
import type { DecisionOption, EvidenceItem, MatchingMode, MatchingOptions, PersonRow, ReviewSummary, TaskFailure, TaskJob } from './types'

/** 任务在后台分析期间，页面每 3 秒取一次最新进度。 */
export const POLL_INTERVAL_MS = 3000

/** 接口限制：一个人才适岗任务最多比较 20 个岗位。 */
export const MAX_JOBS_PER_TASK = 20

export const MODES: Record<MatchingMode, { title: string; path: string; description: string; reportName: string }> = {
  job_to_people: {
    title: '岗位选才',
    path: '/matching/job-to-people',
    description: '为一个岗位从人员库中选人，按综合匹配度排序，经人工复核后导出匹配报告。',
    reportName: '人岗匹配报告',
  },
  people_to_jobs: {
    title: '人才适岗',
    path: '/matching/people-to-jobs',
    description: '把人员与多个岗位逐一比对，找出每个人更适合的岗位，经人工复核后导出适岗推荐报告。',
    reportName: '人才适岗推荐报告',
  },
}

// 主题里没有给出表格“已勾选行”的底色，按主色自动推出的颜色偏深，盖住了行内文字，这里改用品牌浅色。
const MATCHING_THEME = { components: { Table: { rowSelectedBg: '#e7f5f2', rowSelectedHoverBg: '#d9efea' } } }

export function MatchingTheme({ children }: { children: ReactNode }) {
  return <ConfigProvider theme={MATCHING_THEME}>{children}</ConfigProvider>
}

export function taskPath(mode: MatchingMode, taskId: string, search = ''): string {
  return `${MODES[mode].path}/${encodeURIComponent(taskId)}${search}`
}

export interface MatchingAccess {
  create: boolean
  review: boolean
  export: boolean
  remove: boolean
}

/** 操作入口按会话权限显示；接口另行说明不可用时同样不显示。真正的校验在后端。 */
export function matchingAccess(session: Pick<Session, 'permissions'>, options: MatchingOptions | null): MatchingAccess {
  const allow = (permission: string, flag: 'can_create' | 'can_review' | 'can_export' | 'can_delete') =>
    can(session, permission) && options?.[flag] !== false
  return {
    create: allow('matching:create', 'can_create'),
    review: allow('matching:review', 'can_review'),
    export: allow('matching:export', 'can_export'),
    remove: allow('matching:delete', 'can_delete'),
  }
}

/**
 * 条件成立期间按固定间隔重复执行；上一次执行结束后才安排下一次，
 * 条件不再成立或页面卸载时停止。
 */
export function usePolling(active: boolean, task: () => Promise<unknown>, intervalMs: number) {
  const latest = useRef(task)
  useEffect(() => { latest.current = task })
  useEffect(() => {
    if (!active) return
    let stopped = false
    let timer = 0
    const run = async () => {
      try {
        await latest.current()
      } catch {
        // 失败原因由调用方显示，这里继续按间隔重试。
      }
      if (!stopped) timer = window.setTimeout(run, intervalMs)
    }
    timer = window.setTimeout(run, intervalMs)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [active, intervalMs])
}

/** 后端的操作人标识为“业务角色｜登录名”，界面只显示登录名。 */
export function operatorName(value: string | null | undefined): string {
  const text = String(value || '').trim()
  const index = text.indexOf('｜')
  if (index < 0) return text
  return text.slice(index + 1) || text.slice(0, index)
}

const EXCEPTION_NAME = /\b[A-Za-z_][\w.]*(?:Error|Exception)\s*[:：]\s*/g
const WINDOWS_PATH = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>，；。,;]+/g
const UNIX_PATH = /(^|[\s"'（(：:，；])\/(?:[^/\s"'<>，；。]+\/)+[^\s"'<>，；。]+/g

/** 处理未完成的原因按后端记录显示，只去掉程序异常名称和服务器路径。 */
export function readableReason(reason: string | null | undefined): string {
  let text = String(reason ?? '').trim().replace(EXCEPTION_NAME, '')
  const quoted = /^(['"])([\s\S]*)\1$/.exec(text)
  if (quoted) text = quoted[2]
  text = text.replace(WINDOWS_PATH, '[路径已隐藏]').replace(UNIX_PATH, '$1[路径已隐藏]').trim()
  return text || '未记录原因'
}

/** 人员库里姓名还没有确认的人员，姓名记为“待人工确认”。 */
export function nameKnown(name: string | null | undefined): boolean {
  return Boolean(name) && name !== UNKNOWN_NAME
}

/** 用来辨认人员的名称：姓名还没有确认时用简历文件名（不带扩展名）。 */
export function personName(person: { name?: string | null; source_filename?: string | null; code?: string | null }): string {
  if (nameKnown(person.name)) return person.name as string
  return stemOf(person.source_filename || '') || person.code || '姓名待确认'
}

const STAGES: Record<string, string> = { parse: '简历解析', analysis: '匹配分析', task: '任务处理' }

export function stageLabel(stage: string | null | undefined): string {
  return STAGES[stage || ''] || '处理'
}

/** 未完成项对应的人员：从人员库选人的任务里，记录的是人员库编号，这里换成姓名和文件名。 */
export function failureSubject(failure: TaskFailure, people: PersonRow[]): string {
  const person = people.find(item => item.candidate_id && item.candidate_id === failure.candidate_id)
    || people.find(item => item.candidate_id && item.person_id && item.person_id === (failure.person_id || failure.file))
    || people.find(item => item.candidate_id && item.source_filename === failure.file)
  if (person) return nameKnown(person.name) && person.name !== person.source_filename ? `${person.name}（${person.source_filename}）` : person.source_filename
  // 人员还没有进入任务时，用接口给出的人员库姓名和简历文件名。
  if (nameKnown(failure.name) && failure.file && failure.name !== failure.file) return `${failure.name}（${failure.file}）`
  if (!failure.file) return '未命名材料'
  return /^TLE-/i.test(failure.file) ? `人员库记录 ${failure.file}` : failure.file
}

export function decisionLabel(value: string | null | undefined, options: DecisionOption[]): string {
  if (!value) return ''
  return options.find(item => item.value === value)?.label || value
}

/** 所选人员的查询参数；未指定人员时由后端按整个任务处理。 */
export function candidateQuery(ids: string[]): string {
  return ids.length ? `candidate_ids=${ids.map(encodeURIComponent).join(',')}` : ''
}

export function safeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 80) || '匹配任务'
}

export function saveJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function analysisColor(status: string): string {
  if (status === '分析完成') return 'green'
  if (status.includes('处理中')) return 'processing'
  if (status.includes('重试') || status.includes('重分析')) return 'orange'
  if (status.includes('待')) return 'gold'
  return 'default'
}

export function AnalysisTag({ status }: { status: string }) {
  return <Tag color={analysisColor(status || '')} className="matching-wrap-tag">{status || '—'}</Tag>
}

/** 岗位名称标签，名称较长时在标签内换行。列表里岗位很多时只列前几个，其余在提示中列出。 */
export function JobTags({ jobs, limit }: { jobs: TaskJob[]; limit?: number }) {
  const shown = limit && jobs.length > limit ? jobs.slice(0, limit - 1) : jobs
  return (
    <Space size={[4, 4]} wrap>
      {shown.map(job => <Tag key={job.id} className="matching-wrap-tag">{job.name}</Tag>)}
      {shown.length < jobs.length && (
        <Tooltip title={jobs.map(job => job.name).join('、')}>
          <Tag className="matching-tag-muted">等 {jobs.length} 个岗位</Tag>
        </Tooltip>
      )}
    </Space>
  )
}

const REVIEW_ITEMS: Array<[label: string, key: keyof ReviewSummary, color: string]> = [
  ['通过', 'passed', 'green'], ['保留', 'kept', 'blue'], ['未通过', 'rejected', 'red'],
  ['待审核', 'pending', 'gold'], ['需重新审核', 'stale', 'orange'],
]

/** 复核进度：各审核状态的人数。 */
export function ReviewTags({ review }: { review: ReviewSummary | null }) {
  if (!review) return <Typography.Text type="secondary">开始分析后显示</Typography.Text>
  return (
    <Space size={[4, 4]} wrap>
      {REVIEW_ITEMS.map(([label, key, color]) => review[key] > 0
        ? <Tag key={key} color={color}>{label} {review[key]}</Tag>
        : <Tag key={key} className="matching-tag-muted">{label} 0</Tag>)}
    </Space>
  )
}

/** 逐条完整显示的文字清单（优势、风险、核验事项等）。 */
export function TextList({ items, empty = '暂无' }: { items?: string[] | null; empty?: string }) {
  if (!items?.length) return <Typography.Text type="secondary">{empty}</Typography.Text>
  return (
    <ul className="matching-text-list">
      {items.map((item, index) => <li key={`${index}-${item}`} className="evidence-text">{item}</li>)}
    </ul>
  )
}

export function sourceLabel(item: Pick<EvidenceItem, 'file' | 'location'>): string {
  return [item.file, item.location].filter(Boolean).join(' · ') || '来源未记录'
}

/** 原文引用及出处（文件 · 位置）。 */
export function EvidenceQuotes({ items }: { items: EvidenceItem[] }) {
  return (
    <>
      {items.map((item, index) => (
        <figure key={`${index}-${item.location}`} className="matching-quote">
          <blockquote className="evidence-quote">{item.text}</blockquote>
          <figcaption><Typography.Text type="secondary" className="evidence-source">出处：{sourceLabel(item)}</Typography.Text></figcaption>
        </figure>
      ))}
    </>
  )
}
