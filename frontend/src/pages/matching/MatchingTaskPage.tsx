import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Collapse, Descriptions, Popconfirm, Progress, Result, Skeleton, Space, Table, Tag, Tooltip, Typography, message } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ApiError, api, send } from '../../api'
import { AiNotice, PageHeader } from '../../components/PageHeader'
import { StatusTag } from '../../components/StatusTag'
import { useAdminSession } from '../../lib/access'
import { formatScore, formatTime } from '../../lib/format'
import ComparisonCharts from './ComparisonCharts'
import ExportPanel from './ExportPanel'
import PeopleTable from './PeopleTable'
import PersonDrawer from './PersonDrawer'
import { JobTags, MODES, MatchingTheme, POLL_INTERVAL_MS, failureSubject, matchingAccess, readableReason, stageLabel, taskPath, usePolling } from './shared'
import type { JobStandard, MatchingMode, MatchingOptions, ReviewSummary, TaskDetail } from './types'
import './matching.css'

interface Props {
  mode: MatchingMode
  /** 自动刷新间隔（毫秒），默认 3 秒。 */
  pollIntervalMs?: number
}

interface LoadError {
  message: string
  missing: boolean
}

const COUNTERS: Array<[label: string, key: keyof ReviewSummary]> = [
  ['通过', 'passed'], ['保留', 'kept'], ['未通过', 'rejected'], ['待审核', 'pending'], ['需重新审核', 'stale'],
]

/** 从其他页面进入的通用地址：读取任务后转到对应的岗位选才或人才适岗页面，保留查询参数。 */
export function MatchingTaskRedirect() {
  const { taskId = '' } = useParams()
  const location = useLocation()
  const [target, setTarget] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    setError('')
    api<TaskDetail>(`/matching/tasks/${encodeURIComponent(taskId)}`)
      .then(task => { if (!disposed) setTarget(taskPath(task.mode, task.id, location.search)) })
      .catch(failure => { if (!disposed) setError((failure as Error).message) })
    return () => { disposed = true }
  }, [taskId, location.search])
  if (target) return <Navigate replace to={target} />
  if (error) {
    return (
      <Result status="warning" title="匹配任务未能打开" subTitle={error} extra={(
        <Space>
          <Link to={MODES.job_to_people.path}>查看岗位选才任务</Link>
          <Link to={MODES.people_to_jobs.path}>查看人才适岗任务</Link>
        </Space>
      )} />
    )
  }
  return <Card><Skeleton active paragraph={{ rows: 4 }} /></Card>
}

/** 匹配任务详情：进度、岗位标准、人员排序或适岗矩阵、人员详情抽屉、报告导出。 */
export default function MatchingTaskPage({ mode, pollIntervalMs }: Props) {
  const { taskId = '' } = useParams()
  return <MatchingTheme><TaskView key={`${mode}:${taskId}`} mode={mode} taskId={taskId} pollIntervalMs={pollIntervalMs} /></MatchingTheme>
}

function JobStandards({ standards }: { standards: JobStandard[] }) {
  return (
    <Collapse className="section-card" items={[{
      key: 'standards',
      label: `岗位标准（${standards.length} 个岗位的能力维度、权重和硬性条件）`,
      children: standards.length ? standards.map(job => (
        <div key={job.id} className="matching-standard">
          <Space size={[8, 4]} wrap>
            <Typography.Text strong>{job.name}</Typography.Text>
            {job.sequence && <Tag>{job.sequence}</Tag>}
            {job.level && <Tag>{job.level}</Tag>}
            {job.weight_version && <Typography.Text type="secondary">评分标准版本 {job.weight_version}</Typography.Text>}
          </Space>
          <div className="matching-standard-body">
            <Table
              size="small" rowKey="name" pagination={false} dataSource={job.dimensions}
              columns={[
                { title: '能力维度', dataIndex: 'name' },
                { title: '权重', dataIndex: 'weight', width: 100, render: (value: number) => `${formatScore(value)}%` },
              ]}
            />
            <div>
              <h5 className="matching-subtitle">硬性条件</h5>
              {job.hard_conditions.length
                ? <ul className="matching-text-list">{job.hard_conditions.map(item => <li key={item} className="evidence-text">{item}</li>)}</ul>
                : <Typography.Text type="secondary">未设置硬性条件</Typography.Text>}
              <Typography.Paragraph type="secondary" className="matching-note">硬性条件逐项核验并显示结果，不会筛掉人员，也不计入综合匹配度。</Typography.Paragraph>
            </div>
          </div>
        </div>
      )) : <Typography.Text type="secondary">岗位已删除，无法显示岗位标准</Typography.Text>,
    }]} />
  )
}

function TaskView({ mode, taskId, pollIntervalMs = POLL_INTERVAL_MS }: Props & { taskId: string }) {
  const session = useAdminSession()
  const navigate = useNavigate()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const meta = MODES[mode]
  const [task, setTask] = useState<TaskDetail | null>(null)
  const [options, setOptions] = useState<MatchingOptions | null>(null)
  const [error, setError] = useState<LoadError | null>(null)
  const [refreshError, setRefreshError] = useState('')
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState<'retry' | 'reanalyze' | ''>('')
  const [removingId, setRemovingId] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const alive = useRef(true)
  const loaded = useRef(false)
  const wasRunning = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true)
    try {
      const result = await api<TaskDetail>(`/matching/tasks/${encodeURIComponent(taskId)}`)
      if (!alive.current) return
      loaded.current = true
      setTask(result)
      setError(null)
      setRefreshError('')
      setSelected(current => current.filter(id => result.people.some(row => row.candidate_id === id)))
      // 分析结束后，已打开的人员详情随之更新。
      if (wasRunning.current && !result.running) setReloadToken(value => value + 1)
      wasRunning.current = result.running
    } catch (failure) {
      if (!alive.current) return
      const missing = failure instanceof ApiError && failure.status === 404
      if (loaded.current && !missing) {
        setRefreshError((failure as Error).message)
      } else {
        setTask(null)
        setError({ message: (failure as Error).message, missing })
      }
    } finally {
      if (alive.current && !background) setLoading(false)
    }
  }, [taskId])

  useEffect(() => {
    void load()
    api<MatchingOptions>('/matching/options')
      .then(value => { if (alive.current) setOptions(value) })
      .catch(failure => { if (alive.current) setRefreshError((failure as Error).message) })
  }, [load])

  usePolling(Boolean(task?.running), () => load(true), pollIntervalMs)

  const personId = params.get('person') || ''
  const showPerson = (candidateId: string) => setParams(current => {
    const next = new URLSearchParams(current)
    if (candidateId) next.set('person', candidateId)
    else next.delete('person')
    return next
  }, { replace: true })

  if (error) {
    return (
      <>
        <PageHeader title={meta.title} description={meta.description} />
        <Result
          status={error.missing ? '404' : 'warning'} title={error.missing ? '匹配任务不存在或已删除' : '匹配任务未能读取'} subTitle={error.message}
          extra={(
            <Space>
              <Button onClick={() => navigate(meta.path)}>返回任务列表</Button>
              {!error.missing && <Button type="primary" onClick={() => void load()}>重试</Button>}
            </Space>
          )}
        />
      </>
    )
  }
  if (!task) {
    return (
      <>
        <PageHeader title={meta.title} description={meta.description} />
        <Card><Skeleton active paragraph={{ rows: 6 }} /></Card>
      </>
    )
  }
  if (task.mode !== mode) return <Navigate replace to={taskPath(task.mode, task.id, location.search)} />

  const access = matchingAccess(session, options)
  const hasPeople = task.people.some(row => row.candidate_id)
  const pending = task.people.filter(row => row.candidate_id && row.review_status === '待审核')
  const position = task.people.findIndex(row => row.candidate_id === personId)
  const nextPending = pending.find(row => task.people.indexOf(row) > position && row.candidate_id !== personId)
    || pending.find(row => row.candidate_id !== personId)

  const start = async (kind: 'retry' | 'reanalyze') => {
    setBusy(kind)
    try {
      await send(`/matching/tasks/${encodeURIComponent(task.id)}/${kind}`, 'POST')
      message.success(kind === 'retry' ? '已开始重试未完成项，进度会自动更新' : '已开始重新分析，进度会自动更新')
      await load(true)
    } catch (failure) {
      message.error((failure as Error).message)
    } finally {
      if (alive.current) setBusy('')
    }
  }
  const remove = async (candidateId: string, name: string) => {
    setRemovingId(candidateId)
    try {
      await send(`/matching/candidates/${encodeURIComponent(candidateId)}`, 'DELETE')
      message.success(`已从任务中删除 ${name}`)
      if (personId === candidateId) showPerson('')
      await load(true)
    } catch (failure) {
      message.error((failure as Error).message)
    } finally {
      if (alive.current) setRemovingId('')
    }
  }

  const reanalyzeButton = access.review && hasPeople && (task.running
    ? <Tooltip title="任务正在分析，请等待完成"><Button disabled>重新分析</Button></Tooltip>
    : (
      <Popconfirm
        title="重新分析本任务全部人员？" okText="开始重新分析" cancelText="取消"
        description="用已保存的人员资料和当前岗位标准重新评分。已填写的复核意见会保留；分析完成后请再次核对评分依据。"
        onConfirm={() => start('reanalyze')}
      >
        <Button loading={busy === 'reanalyze'} disabled={busy === 'retry'}>重新分析</Button>
      </Popconfirm>
    ))
  const percent = task.total ? Math.round(task.processed * 100 / task.total) : 0

  return (
    <>
      <PageHeader
        title={task.name} section={`人岗匹配 / ${meta.title}`}
        description={`${meta.title}任务 · ${task.jobs.map(job => job.name).join('、')} · 共 ${task.total} 人`}
        actions={(
          <Space>
            <AiNotice />
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(meta.path)}>返回任务列表</Button>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>
          </Space>
        )}
      />
      {refreshError && <Alert className="page-alert" type="warning" showIcon message="最新数据未能读取，当前显示的是上一次的内容" description={refreshError} />}

      <Card className="matching-overview">
        <Descriptions size="small" column={{ xs: 1, md: 2, xl: 4 }} items={[
          { key: 'jobs', label: mode === 'people_to_jobs' ? '比较岗位' : '岗位', children: <JobTags jobs={task.jobs} /> },
          { key: 'status', label: '状态', children: <StatusTag kind="task" value={task.status} /> },
          {
            key: 'progress', label: '进度', children: task.status === '待处理' ? '排队中，即将开始分析' : (
              <div className="matching-progress">
                <span>已处理 {task.processed}/{task.total}{task.failed > 0 ? `，${task.failed} 项未完成` : ''}</span>
                {task.status === '处理中' && <Progress size="small" status="active" percent={percent} />}
              </div>
            ),
          },
          { key: 'time', label: '创建时间', children: formatTime(task.created_at) },
        ]} />
        {task.review ? (
          <div className="matching-counters">
            <div className="matching-counter"><span>人数</span><strong>{task.review.people}</strong></div>
            {COUNTERS.map(([label, key]) => (
              <div key={key} className="matching-counter"><span>{label}</span><strong>{task.review?.[key]}</strong></div>
            ))}
            <div className="matching-counter emphasis"><span>可导出正式报告</span><strong>{task.review.exportable}</strong></div>
          </div>
        ) : <Typography.Paragraph type="secondary" className="matching-note">任务正在排队，开始分析后显示复核进度。</Typography.Paragraph>}
        {reanalyzeButton && <div className="matching-overview-actions">{reanalyzeButton}</div>}
      </Card>

      {task.running && <Alert className="section-row" type="info" showIcon message="正在后台分析，进度和结果会自动更新" description="离开本页不影响分析。分析完成前不能修改资料、提交复核或导出。" />}
      {task.failures.length > 0 && (
        <Alert
          className="section-row" type="warning" showIcon message={`有 ${task.failures.length} 项未完成`}
          description={(
            <ul className="matching-failures">
              {task.failures.map((item, index) => (
                <li key={`${index}-${item.file}`} className="evidence-text">
                  <strong>{failureSubject(item, task.people)}</strong>（{stageLabel(item.stage)}）：{readableReason(item.reason)}
                </li>
              ))}
            </ul>
          )}
          action={access.create && (
            <Tooltip title={task.running ? '任务正在分析，请等待完成' : ''}>
              <Button type="primary" size="small" loading={busy === 'retry'} disabled={task.running || busy === 'reanalyze'} onClick={() => void start('retry')}>重试未完成项</Button>
            </Tooltip>
          )}
        />
      )}
      {Boolean(task.review?.stale) && !task.running && (
        <Alert
          className="section-row" type="warning" showIcon message={`有 ${task.review?.stale} 人的评分已失效`}
          description={`人员资料或岗位标准在分析后有改动。${access.review ? '请点击“重新分析”，完成后再复核和导出报告。' : '请联系有复核权限的人员重新分析。'}`}
        />
      )}

      <JobStandards standards={task.job_standards} />
      {access.export && <ExportPanel task={task} selected={selected} onExported={() => setReloadToken(value => value + 1)} />}
      <ComparisonCharts task={task} selected={selected} />
      <PeopleTable
        task={task} options={options} access={access} selected={selected} removingId={removingId}
        onSelect={setSelected} onOpen={showPerson} onRemove={(candidateId, name) => void remove(candidateId, name)}
      />
      <PersonDrawer
        taskId={task.id} mode={mode} candidateId={personId} options={options} access={access} running={task.running}
        reloadToken={reloadToken} reanalyzing={busy === 'reanalyze'} hasNext={Boolean(nextPending)}
        onClose={() => showPerson('')} onChanged={() => void load(true)} onReanalyze={() => void start('reanalyze')}
        onRemove={remove} onNext={() => showPerson(nextPending?.candidate_id || '')}
      />
    </>
  )
}
