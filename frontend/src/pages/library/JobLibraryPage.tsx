import { PlusOutlined, ReloadOutlined, SearchOutlined, UploadOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Empty, Grid, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, send } from '../../api'
import { PageHeader } from '../../components/PageHeader'
import { ReservedEntry } from '../../components/ReservedEntry'
import { StatusTag } from '../../components/StatusTag'
import { can, useAdminSession } from '../../lib/access'
import { formatTime } from '../../lib/format'
import { JobDetailDrawer, isJobTab } from './JobDetailDrawer'
import type { JobTab } from './JobDetailDrawer'
import { JobCreateModal } from './JobForm'
import { JobImportModal } from './JobImportModal'
import { FeedbackProvider, useFeedback } from './feedback'
import type { JobDetail, JobSummary } from './types'
import './library.css'

interface PageNotice {
  type: 'success' | 'warning' | 'error'
  title: string
  text?: string
}

function PurgeJobModal({ job, onClose, onPurged }: { job: JobSummary; onClose: () => void; onPurged: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const confirm = async () => {
    setBusy(true)
    setError('')
    try {
      await send(`/library/jobs/${job.id}`, 'DELETE')
      onPurged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={`彻底删除岗位“${job.name}”`}
      open
      maskClosable={false}
      okText="彻底删除"
      cancelText="取消"
      okButtonProps={{ danger: true, disabled: text.trim() !== job.name }}
      confirmLoading={busy}
      onOk={() => void confirm()}
      onCancel={() => { if (!busy) onClose() }}
    >
      <Alert
        type="error"
        showIcon
        message="彻底删除后无法恢复"
        description={`将同时删除该岗位的匹配任务（当前 ${job.matching_task_count} 个）及其中的人员匹配结果和报告，以及该岗位的面试评价标准和补充材料。已关联面试批次或候选人的岗位不能彻底删除。`}
      />
      <Typography.Paragraph className="section-row">请输入岗位名称 <Typography.Text strong>{job.name}</Typography.Text> 以确认：</Typography.Paragraph>
      <Input aria-label="输入岗位名称以确认彻底删除" value={text} disabled={busy} placeholder="请输入岗位名称" onChange={event => setText(event.target.value)} />
      {error && <Alert className="section-row" type="error" showIcon message="未能彻底删除" description={<div className="evidence-text">{error}</div>} />}
    </Modal>
  )
}

function JobLibrary() {
  const session = useAdminSession()
  const canEdit = can(session, 'job:edit')
  const { message } = useFeedback()
  const screens = Grid.useBreakpoint()
  const [params, setParams] = useSearchParams()
  const [jobs, setJobs] = useState<JobSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState<PageNotice | null>(null)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [sequence, setSequence] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  const [detail, setDetail] = useState<{ id: string; mode: 'view' | 'edit'; tab?: JobTab } | null>(null)
  const [purging, setPurging] = useState<JobSummary | null>(null)
  const [busyId, setBusyId] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setJobs(await api<JobSummary[]>(`/library/jobs${includeArchived ? '?include_archived=true' : ''}`))
      setLoadError('')
    } catch (e) {
      setLoadError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [includeArchived])

  useEffect(() => { void load() }, [load])

  // 其他页面可用 /library/jobs?job=岗位编号&tab=standard 直接打开某个岗位。
  const linkedJob = params.get('job')
  const linkedTab = params.get('tab')
  useEffect(() => {
    if (!linkedJob) return
    setDetail(current => current?.id === linkedJob ? current : { id: linkedJob, mode: 'view', tab: isJobTab(linkedTab) ? linkedTab : undefined })
  }, [linkedJob, linkedTab])

  const closeDetail = () => {
    setDetail(null)
    if (params.has('job')) {
      const next = new URLSearchParams(params)
      next.delete('job')
      next.delete('tab')
      setParams(next, { replace: true })
    }
  }

  const sequences = useMemo(
    () => [...new Set(jobs.map(job => job.sequence).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')),
    [jobs],
  )
  const visible = useMemo(() => {
    const text = keyword.trim().toLowerCase()
    return jobs.filter(job => (!text || `${job.name} ${job.sequence} ${job.level}`.toLowerCase().includes(text)) && (!sequence || job.sequence === sequence))
  }, [jobs, keyword, sequence])

  const run = async (job: JobSummary, path: string, done: string, failed: string) => {
    setBusyId(job.id)
    setNotice(null)
    try {
      await send(path, 'POST')
      message.success(done)
      await load()
    } catch (e) {
      setNotice({ type: 'error', title: failed, text: (e as Error).message })
    } finally {
      setBusyId('')
    }
  }

  const saved = (job: JobDetail, overwritten: boolean) => {
    setNotice(overwritten
      ? { type: 'warning', title: `已覆盖岗位“${job.name}”`, text: '该岗位已有的匹配结果已标记为“需重新分析”，请到对应的匹配任务中重新分析后再复核。' }
      : null)
    void load()
  }

  const columns: ColumnsType<JobSummary> = [
    {
      title: '岗位名称', dataIndex: 'name',
      render: (value: string, row) => <Space size={6} wrap><Typography.Text strong className="job-name">{value}</Typography.Text>{!row.is_active && <Tag>已删除</Tag>}</Space>,
    },
    { title: '序列', dataIndex: 'sequence', width: 108, render: (value: string) => <span className="job-name">{value}</span> },
    { title: '层级', dataIndex: 'level', width: 88, render: (value: string) => <span className="job-name">{value}</span> },
    { title: '硬性条件', dataIndex: 'hard_condition_count', width: 84, render: (value: number) => `${value} 项` },
    { title: '能力标签', dataIndex: 'dimension_count', width: 84, render: (value: number) => `${value} 项` },
    { title: '面试评价标准', key: 'standard', width: 112, render: (_, row) => <StatusTag kind="standard" value={row.interview.audit_status} /> },
    { title: '匹配任务', dataIndex: 'matching_task_count', width: 84, render: (value: number) => `${value} 个` },
    { title: '面试批次', key: 'batches', width: 84, render: (_, row) => `${row.interview.batch_count} 个` },
    { title: '更新时间', dataIndex: 'updated_at', width: 148, render: (value: string) => <span className="nowrap">{formatTime(value)}</span> },
    {
      title: '操作', key: 'actions', fixed: screens.md ? 'right' : undefined, width: canEdit ? 176 : 72,
      render: (_, row) => (
        <Space size={0} className="row-actions-inline">
          <Button type="link" size="small" onClick={() => setDetail({ id: row.id, mode: 'view' })}>查看</Button>
          {canEdit && row.is_active && <Button type="link" size="small" onClick={() => setDetail({ id: row.id, mode: 'edit' })}>编辑</Button>}
          {canEdit && row.is_active && (
            <Popconfirm
              title={`删除岗位“${row.name}”？`}
              description="删除后岗位不能再用于新建任务；已有的匹配任务和面试记录保留，可在“显示已删除”中恢复。"
              okText="确认删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => run(row, `/library/jobs/${row.id}/archive`, `岗位“${row.name}”已删除`, `岗位“${row.name}”未能删除`)}
            >
              <Button type="link" size="small" danger loading={busyId === row.id}>删除</Button>
            </Popconfirm>
          )}
          {canEdit && !row.is_active && (
            <Button type="link" size="small" loading={busyId === row.id} onClick={() => void run(row, `/library/jobs/${row.id}/restore`, `岗位“${row.name}”已恢复`, `岗位“${row.name}”未能恢复`)}>恢复</Button>
          )}
          {canEdit && !row.is_active && <Button type="link" size="small" danger onClick={() => setPurging(row)}>彻底删除</Button>}
        </Space>
      ),
    },
  ]

  const filtered = Boolean(keyword.trim() || sequence)
  return (
    <>
      <PageHeader
        title="岗位库"
        description="统一维护岗位说明、能力标签与权重和面试评价标准，人岗匹配与AI面试共用。"
        actions={canEdit ? (
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>新增岗位</Button>
            <Button icon={<UploadOutlined />} onClick={() => setImporting(true)}>上传岗位说明书</Button>
            <ReservedEntry integration="recruitment_jobs" label="从人资招聘系统导入" />
          </Space>
        ) : undefined}
      />
      {loadError && <Alert className="page-alert" type="error" showIcon message="岗位列表加载失败" description={loadError} action={<Button size="small" onClick={() => void load()}>重新加载</Button>} />}
      {notice && <Alert className="page-alert" type={notice.type} showIcon closable onClose={() => setNotice(null)} message={notice.title} description={notice.text ? <div className="evidence-text">{notice.text}</div> : undefined} />}
      <Card>
        <div className="toolbar">
          <Space wrap>
            <Input
              allowClear
              aria-label="搜索岗位"
              className="library-search"
              prefix={<SearchOutlined />}
              placeholder="搜索岗位名称、序列或层级"
              value={keyword}
              onChange={event => setKeyword(event.target.value)}
            />
            <Select
              allowClear
              aria-label="按序列筛选"
              className="library-filter"
              placeholder="全部序列"
              value={sequence}
              onChange={value => setSequence(value)}
              options={sequences.map(item => ({ value: item, label: item }))}
            />
          </Space>
          <Space wrap>
            <label className="switch-label">
              <Switch aria-label="显示已删除" checked={includeArchived} onChange={setIncludeArchived} />
              <span>显示已删除</span>
            </label>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
          </Space>
        </div>
        <Table<JobSummary>
          rowKey="id"
          className="library-table"
          size="middle"
          loading={loading}
          dataSource={visible}
          columns={columns}
          scroll={{ x: canEdit ? 1120 : 1016 }}
          rowClassName={row => row.is_active ? '' : 'library-row-muted'}
          pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false, showTotal: total => `共 ${total} 个岗位` }}
          locale={{
            emptyText: loading ? ' ' : filtered
              ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的岗位，请调整搜索内容或筛选条件" />
              : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={canEdit ? '岗位库还没有岗位。可以上传岗位说明书由系统识别，或手工新增岗位。' : '岗位库还没有岗位，请联系 HR 管理员维护。'}>
                  {canEdit && (
                    <Space wrap>
                      <Button type="primary" onClick={() => setImporting(true)}>上传岗位说明书</Button>
                      <Button onClick={() => setCreating(true)}>手工新增岗位</Button>
                    </Space>
                  )}
                </Empty>
              ),
          }}
        />
      </Card>
      {creating && (
        <JobCreateModal
          onClose={() => setCreating(false)}
          onSaved={(job, overwritten) => {
            setCreating(false)
            message.success(overwritten ? `已覆盖岗位“${job.name}”` : `岗位“${job.name}”已保存`)
            saved(job, overwritten)
            setDetail({ id: job.id, mode: 'view' })
          }}
        />
      )}
      {importing && <JobImportModal jobs={jobs} onClose={() => setImporting(false)} onSaved={saved} />}
      {detail && (
        <JobDetailDrawer
          key={detail.id}
          jobId={detail.id}
          initialMode={detail.mode}
          initialTab={detail.tab}
          canEdit={canEdit}
          onClose={closeDetail}
          onChanged={() => void load()}
        />
      )}
      {purging && (
        <PurgeJobModal
          job={purging}
          onClose={() => setPurging(null)}
          onPurged={() => {
            message.success(`岗位“${purging.name}”已彻底删除`)
            setPurging(null)
            void load()
          }}
        />
      )}
    </>
  )
}

export default function JobLibraryPage() {
  return <FeedbackProvider><JobLibrary /></FeedbackProvider>
}
