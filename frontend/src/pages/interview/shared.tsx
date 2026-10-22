import { Select, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../../api'

/** AI面试管理端几个页面共用的类型和小组件（批次、候选人姓名单元格、批次筛选、复制）。 */

export type BatchMode = 'ai_interview' | 'listening_only'

export interface Batch {
  id: number
  code: string
  name: string
  recruitment_type: string
  job_id: number
  job_name: string
  library_job_id: string | null
  /** 岗位的面试评价标准状态；approved 后才能生成题目。 */
  job_audit_status: string
  mode: BatchMode
  mode_label: string
  status: string
  question_version: number
  candidate_count: number
  accepts_candidates: boolean
}

export interface CandidateRef {
  id: number
  code: string
  name: string
  library_person_id?: string | null
}

export const RECRUITMENT_TYPES = ['社会招聘', '校园招聘', '内部竞聘']

export const BATCH_MODES: Array<{ value: BatchMode; label: string; note: string }> = [
  { value: 'ai_interview', label: 'AI面试 + 人工面试旁听', note: '候选人先完成AI面试（须先发布题目），之后可安排人工面试旁听。' },
  { value: 'listening_only', label: '仅人工面试旁听', note: '不出题、候选人无需登录、不做AI面试，直接依据简历和岗位要求旁听人工面试。' },
]

/** 岗位库中某个岗位的面试评价标准（岗位库页面支持用地址栏参数直接打开）。 */
export function jobStandardPath(libraryJobId: string | null | undefined): string {
  return libraryJobId ? `/library/jobs?job=${encodeURIComponent(libraryJobId)}&tab=standard` : '/library/jobs'
}

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '操作未完成，请稍后重试'
}

export function batchLabel(batch: Pick<Batch, 'name' | 'job_name' | 'mode'>): string {
  return `${batch.name} · ${batch.job_name}${batch.mode === 'listening_only' ? '（仅人工面试旁听）' : ''}`
}

export function CandidateName({ candidate }: { candidate: Pick<CandidateRef, 'name' | 'code'> }) {
  return (
    <>
      <Typography.Text strong>{candidate.name}</Typography.Text>
      <br />
      <Typography.Text type="secondary">{candidate.code}</Typography.Text>
    </>
  )
}

/** 读取招聘批次列表，供筛选和表单使用。 */
export function useBatches() {
  const [batches, setBatches] = useState<Batch[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setBatches(await api<Batch[]>('/batches'))
      setError('')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void reload() }, [reload])
  return { batches, loading, error, reload }
}

function positiveInteger(value: string | null): number | undefined {
  const parsed = Number(value)
  return value && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

/** 当前批次记在地址栏的 ?batch= 中，刷新或从其他页面跳转后仍保持。 */
export function useBatchParam(): [number | undefined, (id: number | undefined) => void] {
  const [params, setParams] = useSearchParams()
  const batchId = positiveInteger(params.get('batch'))
  const setBatchId = useCallback((id: number | undefined) => {
    setParams(current => {
      const next = new URLSearchParams(current)
      if (id) next.set('batch', String(id))
      else next.delete('batch')
      return next
    }, { replace: true })
  }, [setParams])
  return [batchId, setBatchId]
}

export function BatchSelect({ batches, value, onChange, label, placeholder, loading = false, allowClear = false }: {
  batches: Batch[]
  value: number | undefined
  onChange: (id: number | undefined) => void
  label: string
  placeholder: string
  loading?: boolean
  allowClear?: boolean
}) {
  return (
    <Select<number>
      aria-label={label}
      className="interview-batch-select"
      showSearch
      optionFilterProp="label"
      allowClear={allowClear}
      loading={loading}
      placeholder={placeholder}
      // 批次尚未读取完时不显示地址栏里的数字编号。
      value={batches.some(batch => batch.id === value) ? value : undefined}
      onChange={next => onChange(next ?? undefined)}
      options={batches.map(batch => ({ value: batch.id, label: batchLabel(batch) }))}
    />
  )
}

/** 复制文字。非 https 的内网地址没有 Clipboard API，退回到选中复制。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 浏览器拒绝时改用下面的办法。
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  document.body.removeChild(area)
  return copied
}
