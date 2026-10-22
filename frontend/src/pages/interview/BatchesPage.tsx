import { CheckOutlined, CloseOutlined, DeleteOutlined, EditOutlined, EyeOutlined, LoadingOutlined, PlusOutlined, PoweroffOutlined, RocketOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Col, Descriptions, Drawer, Empty, Form, Input, InputNumber, List, Modal, Popconfirm, Row, Select, Space, Table, Tabs, Tag, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, send, type Operation } from '../../api'
import { AiNotice, PageHeader } from '../../components/PageHeader'
import { StatusTag } from '../../components/StatusTag'
import { can, useAdminSession } from '../../lib/access'
import { formatTime } from '../../lib/format'
import type { Question } from '../../types'
import { BatchFormModal } from './BatchFormModal'
import { OnsiteEntries } from './OnsiteEntries'
import { errorMessage, jobStandardPath, type Batch } from './shared'
import './interview.css'

interface Dimension { id: number; name: string }
interface ChangeLogEntry { action?: string; actor?: string; reason?: string; comment?: string; previous?: string }
interface GenerationResult { version: number; count: number }
/** 批次的题目生成状态。生成在后台进行，同批次的工作人员看到的是同一份状态。 */
interface GenerationStatus {
  running: boolean
  operation?: Operation<GenerationResult>
  /** 本次要生成的题目数量。 */
  count?: number
  started_by?: string
  elapsed_seconds?: number
  finished_at?: string
  /** 最近一次生成失败、且之后没有新的成功生成时的失败原因。 */
  last_error?: string
  last_result?: GenerationResult
}

interface Props {
  /** 查询生成进度的间隔（毫秒），默认 2 秒；仅测试时传入较小的值。 */
  pollIntervalMs?: number
}

const EDITABLE = ['draft', 'returned']
// 题目表各固定列的宽度；正文列至少保留 QUESTION_TEXT_MIN，屏幕更窄时才横向滚动。
const QUESTION_COLUMNS = { sequence: 60, status: 96, actions: 172 }
const QUESTION_TEXT_MIN = 300
const QUESTION_TABLE_WIDTH = QUESTION_COLUMNS.sequence + QUESTION_COLUMNS.status + QUESTION_COLUMNS.actions + QUESTION_TEXT_MIN
const BULK_REVIEW_COMMENT = '已核对本版本全部题目，一键审核通过'
const GENERATION_POLL_MS = 2000
const GENERATION_UNCONFIRMED = '未能确认本次生成的结果，请查看题目列表；如果没有新版本，可以重新生成。'

/** 生成失败的说明：失败时不保存不完整的题目，有生成权限的人可以重新生成。 */
function failureDetail(reason: string, canGenerate: boolean): string {
  return `原因：${reason.replace(/[。.\s]+$/, '')}。本次没有保存任何题目${canGenerate ? '，可以重新生成' : ''}。`
}

export default function BatchesPage({ pollIntervalMs = GENERATION_POLL_MS }: Props) {
  const session = useAdminSession()
  const [params] = useSearchParams()
  const [batches, setBatches] = useState<Batch[]>([])
  const [batchesLoading, setBatchesLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [dimensions, setDimensions] = useState<Dimension[]>([])
  const [batchId, setBatchId] = useState<number | undefined>(() => Number(params.get('batch')) || undefined)
  const [questions, setQuestions] = useState<Question[]>([])
  const [questionsLoading, setQuestionsLoading] = useState(false)
  const [selectedVersion, setSelectedVersion] = useState<string>()
  // 当前批次的生成状态；生成本身在后台进行，不随页面刷新或关闭而中断。
  const [generation, setGeneration] = useState<GenerationStatus>()
  const [starting, setStarting] = useState(false)
  const [, setClockTick] = useState(0)
  // 本页发起或看到的生成遇到的问题：没有发起成功、生成失败、结果无法确认。
  const [generationProblem, setGenerationProblem] = useState<{ kind: 'start' | 'failed' | 'unconfirmed'; title: string; detail: string }>()
  const [progressUnavailable, setProgressUnavailable] = useState(false)
  // 使用者关闭过的失败提示，只在本次打开页面期间记住。
  const [dismissedFailures, setDismissedFailures] = useState<string[]>([])
  const generationRequest = useRef(0)
  const generationClock = useRef({ operation: '', seconds: 0, at: 0 })
  // 本页看到过“进行中”的生成（批次 → 作业编号），结束时据此给出结果。
  const watchedGenerations = useRef(new Map<number, string>())
  const [busyVersion, setBusyVersion] = useState<number>()
  const [bulkBusy, setBulkBusy] = useState<'review-all' | 'delete'>()
  const [feedback, setFeedback] = useState<{ batchId: number; version: number; type: 'success' | 'error'; text: string }>()
  const selectedBatchRef = useRef(batchId)
  selectedBatchRef.current = batchId
  const questionRequest = useRef(0)
  const operationLock = useRef(false)
  const [batchForm, setBatchForm] = useState<{ batch: Batch | null }>()
  const [generateOpen, setGenerateOpen] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Question | null>(null)
  const [reviewTarget, setReviewTarget] = useState<Question | null>(null)
  const [historyTarget, setHistoryTarget] = useState<Question | null>(null)
  const [generateForm] = Form.useForm()
  const [manualForm] = Form.useForm()
  const [editForm] = Form.useForm()
  const [reviewForm] = Form.useForm()
  const allow = {
    createBatch: can(session, 'batch:create'),
    editBatch: can(session, 'batch:edit'),
    deleteBatch: can(session, 'batch:delete'),
    generate: can(session, 'question:generate'),
    edit: can(session, 'question:edit'),
    submit: can(session, 'question:submit'),
    review: can(session, 'question:review'),
    publish: can(session, 'question:publish'),
    disable: can(session, 'question:disable'),
    onsite: can(session, 'onsite:manage'),
  }

  const loadBatches = async () => {
    const data = await api<Batch[]>('/batches')
    setBatches(data)
    setBatchId(value => value && data.some(batch => batch.id === value) ? value : data[0]?.id)
  }
  const loadQuestions = async (id?: number) => {
    if (!id) return
    const request = ++questionRequest.current
    setQuestionsLoading(true)
    try {
      const data = await api<Question[]>(`/questions?batch_id=${id}`)
      if (selectedBatchRef.current === id && questionRequest.current === request) setQuestions(data)
    } finally {
      if (questionRequest.current === request) setQuestionsLoading(false)
    }
  }
  const refresh = (id: number, warning: string) => Promise.all([loadBatches(), selectedBatchRef.current === id ? loadQuestions(id) : Promise.resolve()])
    .then(() => undefined, () => { message.warning(warning) })

  /** 按最新的生成状态更新页面；本页看到过进行中的生成，结束时给出结果。 */
  const showGeneration = async (id: number, status: GenerationStatus) => {
    const watched = watchedGenerations.current.get(id)
    if (status.running) {
      const operation = status.operation?.id || ''
      if (operation) watchedGenerations.current.set(id, operation)
      // 已用时间以服务端给出的为起点，之后由页面计时；同一次生成只取一次起点，避免每次查询后秒数来回跳动。
      if (generationClock.current.operation !== operation || !generationClock.current.at) {
        generationClock.current = { operation, seconds: status.elapsed_seconds ?? 0, at: Date.now() }
      }
      setGeneration(status)
      return
    }
    watchedGenerations.current.delete(id)
    setGeneration(status)
    if (!watched) return
    const same = status.operation?.id === watched
    if (same && status.last_result) {
      const result = status.last_result
      message.success(`已生成 ${result.count} 道主体题草稿，版本 v${result.version}`)
      setGenerateOpen(false)
      setGenerationProblem(undefined)
      setSelectedVersion(String(result.version))
      setFeedback({ batchId: id, version: result.version, type: 'success', text: `v${result.version} 生成完成，共 ${result.count} 道题` })
      await loadQuestions(id).catch(() => message.warning('草稿已生成，但列表刷新失败，请重新选择批次查看，无需重复生成'))
    } else if (same && status.last_error) {
      setGenerationProblem({ kind: 'failed', title: '题目没有生成', detail: failureDetail(status.last_error, allow.generate) })
    } else {
      // 服务重启等情况下查不到这次生成的结果：如实说明，并刷新题目列表供核对。
      setGenerationProblem({ kind: 'unconfirmed', title: '未能确认生成结果', detail: GENERATION_UNCONFIRMED })
      await loadQuestions(id).catch(() => undefined)
    }
  }
  const loadGeneration = async (id: number) => {
    const request = ++generationRequest.current
    const status = await api<GenerationStatus>(`/batches/${id}/questions/generation`)
    // 只采用最后一次查询的结果，并忽略已切换走的批次。
    if (selectedBatchRef.current !== id || generationRequest.current !== request) return
    setProgressUnavailable(false)
    await showGeneration(id, status)
  }

  useEffect(() => {
    loadBatches().catch(error => setLoadError(errorMessage(error))).finally(() => setBatchesLoading(false))
    // 评价维度只在手动新增题目时使用。
    if (allow.edit) api<Dimension[]>('/dimensions').then(setDimensions).catch(error => message.error(errorMessage(error)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activeBatch = batches.find(batch => batch.id === batchId)
  const needsQuestions = activeBatch?.mode === 'ai_interview'
  useEffect(() => {
    setQuestions([])
    setSelectedVersion(undefined)
    setFeedback(undefined)
    setGeneration(undefined)
    setGenerationProblem(undefined)
    setProgressUnavailable(false)
    questionRequest.current += 1
    generationRequest.current += 1
    setQuestionsLoading(false)
    if (needsQuestions && batchId) {
      loadQuestions(batchId).catch(error => message.error(errorMessage(error)))
      // 进入页面、切换批次或刷新页面后，恢复显示进行中的生成和最近一次失败。读取不到时不影响查看题目。
      loadGeneration(batchId).catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId, needsQuestions])

  const versions = useMemo(() => [...new Set(questions.map(q => q.version))].sort((a, b) => b - a), [questions])
  const generating = generation?.running === true
  useEffect(() => {
    if (!generating || !batchId) return
    const id = batchId
    let stopped = false
    let timer = 0
    const poll = async () => {
      // 查询暂时失败时如实提示，并继续按间隔查询；已发起的生成不受影响。
      await loadGeneration(id).catch(() => { if (!stopped) setProgressUnavailable(true) })
      if (!stopped) timer = window.setTimeout(poll, pollIntervalMs)
    }
    timer = window.setTimeout(poll, pollIntervalMs)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generating, batchId, pollIntervalMs])
  useEffect(() => {
    if (!generating) return
    // 每秒重新显示一次已用时间。
    const timer = window.setInterval(() => setClockTick(value => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [generating])
  const generationSeconds = generating
    ? generationClock.current.seconds + Math.max(0, Math.floor((Date.now() - generationClock.current.at) / 1000))
    : 0

  const generate = async () => {
    if (operationLock.current || !batchId) return
    const id = batchId
    operationLock.current = true
    const values = await generateForm.validateFields().catch(() => null)
    if (!values) {
      operationLock.current = false
      return
    }
    setGenerationProblem(undefined)
    setStarting(true)
    try {
      // 生成在后台进行，接口立即返回后台作业记录；进度和结果从批次的生成状态读取。
      const operation = await send<Operation<GenerationResult>>(`/batches/${id}/questions/generate`, 'POST', { count: values.count, background: true })
      watchedGenerations.current.set(id, operation.id)
      // 发起之前发出的状态查询已经过时，不再采用。
      generationRequest.current += 1
      if (selectedBatchRef.current === id) {
        await showGeneration(id, { running: true, operation: { ...operation, status: 'running' }, count: values.count, started_by: session.username, elapsed_seconds: 0 })
      }
    } catch (error) {
      if (selectedBatchRef.current === id) setGenerationProblem({ kind: 'start', title: '没有开始生成', detail: errorMessage(error) })
      // 没有发起成功时，可能是同批次已经有生成在进行：读取一次当前状态。
      loadGeneration(id).catch(() => undefined)
    } finally {
      operationLock.current = false
      setStarting(false)
    }
  }
  const submitReview = async (version: number) => {
    if (operationLock.current || !batchId) return
    const id = batchId
    operationLock.current = true
    setBusyVersion(version)
    setFeedback(undefined)
    try {
      const result = await send<{ count: number }>(`/batches/${id}/questions/${version}/submit-review`, 'POST')
      if (selectedBatchRef.current === id) {
        setQuestions(current => current.map(q => q.version === version && EDITABLE.includes(q.status) ? { ...q, status: 'pending_review' } : q))
        setFeedback({ batchId: id, version, type: 'success', text: `v${version} 提交成功，${result.count} 道题等待审核` })
      }
    } catch (error) {
      setFeedback({ batchId: id, version, type: 'error', text: `v${version} 提交失败：${errorMessage(error)}。请检查后重试。` })
    } finally {
      operationLock.current = false
      setBusyVersion(undefined)
    }
    // 提交结果独立保留，刷新失败不能被误报成提交失败。
    await refresh(id, '状态刷新失败，请重新选择批次查看最新状态')
  }
  const createManualQuestion = async () => {
    const values = await manualForm.validateFields().catch(() => null)
    if (!values || !batchId) return
    try {
      const result = await send<Question & { cloned_count: number }>(`/batches/${batchId}/questions/manual`, 'POST', values)
      message.success(result.cloned_count ? `已从已发布版本复制 ${result.cloned_count} 道题，并新增第 ${result.sequence} 题` : `已手动新增第 ${result.sequence} 题`)
      setManualOpen(false)
      setSelectedVersion(String(result.version))
      await loadQuestions(batchId)
    } catch (error) {
      message.error(errorMessage(error))
    }
  }
  const operateVersion = async (version: number, action: 'review-all' | 'delete') => {
    if (operationLock.current || !batchId) return
    const id = batchId
    operationLock.current = true
    setBusyVersion(version)
    setBulkBusy(action)
    setFeedback(undefined)
    try {
      const result = action === 'review-all'
        ? await send<{ count: number }>(`/batches/${id}/questions/${version}/review-all`, 'POST', { approved: true, comment: BULK_REVIEW_COMMENT })
        : await send<{ count: number }>(`/batches/${id}/questions/${version}`, 'DELETE')
      message.success(action === 'delete' ? `已删除 v${version}，共 ${result.count} 道题` : `v${version} 审核通过，可发布启用`)
      if (selectedBatchRef.current === id) {
        setQuestions(current => action === 'delete' ? current.filter(q => q.version !== version) : current.map(q => q.version === version && q.status === 'pending_review' ? { ...q, status: 'approved' } : q))
        if (action === 'delete') setSelectedVersion(undefined)
      }
      await refresh(id, '操作已完成，列表刷新失败，请重新选择批次查看')
    } catch (error) {
      setFeedback({ batchId: id, version, type: 'error', text: `${action === 'delete' ? '删除' : '审核'}失败：${errorMessage(error)}` })
    } finally {
      operationLock.current = false
      setBusyVersion(undefined)
      setBulkBusy(undefined)
    }
  }
  const removeBatch = async (id: number) => {
    try {
      await send(`/batches/${id}`, 'DELETE')
      message.success('招聘批次已删除')
      await loadBatches()
    } catch (error) {
      message.error(errorMessage(error))
    }
  }
  const saveQuestion = async () => {
    const values = await editForm.validateFields().catch(() => null)
    if (!values || !editTarget) return
    try {
      await send(`/questions/${editTarget.id}`, 'PUT', values)
      message.success('题目已修改，修改前的内容已写入修改记录')
      setEditTarget(null)
      await loadQuestions(batchId)
    } catch (error) {
      message.error(errorMessage(error))
    }
  }
  const review = async (approved: boolean) => {
    const values = await reviewForm.validateFields().catch(() => null)
    if (!values || !reviewTarget || !batchId) return
    try {
      await send(`/questions/${reviewTarget.id}/review`, 'POST', { approved, comment: values.comment })
      message.success(approved ? '题目审核通过' : '题目已退回')
      setReviewTarget(null)
      await refresh(batchId, '状态刷新失败，请重新选择批次查看最新状态')
    } catch (error) {
      message.error(errorMessage(error))
    }
  }
  const publish = async (version: number) => {
    if (operationLock.current || !batchId) return
    const id = batchId
    operationLock.current = true
    setBusyVersion(version)
    setFeedback(undefined)
    try {
      await send(`/batches/${id}/questions/${version}/publish`, 'POST')
      setFeedback({ batchId: id, version, type: 'success', text: `v${version} 已发布启用` })
    } catch (error) {
      setFeedback({ batchId: id, version, type: 'error', text: `v${version} 发布失败：${errorMessage(error)}` })
    } finally {
      operationLock.current = false
      setBusyVersion(undefined)
    }
    await refresh(id, '状态刷新失败，请重新选择批次查看最新状态')
  }
  const disable = async (id: number) => {
    try {
      await send(`/questions/${id}/disable`, 'POST')
      message.success('题目已停用，历史版本仍保留')
      await loadQuestions(batchId)
    } catch (error) {
      message.error(errorMessage(error))
    }
  }
  const removeQuestion = async (id: number) => {
    try {
      const result = await send<{ count: number }>(`/questions/${id}`, 'DELETE')
      message.success(`题目已删除，当前版本剩余 ${result.count} 道`)
      await loadQuestions(batchId)
    } catch (error) {
      message.error(errorMessage(error))
    }
  }

  // 题目正文占用除固定列以外的全部宽度并完整换行；评价维度和时限放在题目下方，给正文留出空间。
  const columns: ColumnsType<Question> = [
    { title: '题号', dataIndex: 'sequence', width: QUESTION_COLUMNS.sequence, render: value => `Q${value}` },
    {
      title: '主体问题', dataIndex: 'content', render: (value: string, record) => (
        <>
          <div className="evidence-text">{value}</div>
          <div className="interview-question-meta"><Tag color="green">{record.dimension}</Tag><span>回答时限 {record.time_limit} 秒</span></div>
        </>
      ),
    },
    { title: '状态', dataIndex: 'status', width: QUESTION_COLUMNS.status, render: value => <StatusTag kind="question" value={value} /> },
    {
      title: '操作', key: 'actions', width: QUESTION_COLUMNS.actions, render: (_, record) => (
        <Space size={[4, 0]} wrap className="interview-cell-actions">
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => setHistoryTarget(record)}>版本记录</Button>
          {allow.edit && EDITABLE.includes(record.status) && (
            <Button type="link" size="small" icon={<EditOutlined />} onClick={() => setEditTarget(record)}>编辑</Button>
          )}
          {allow.edit && EDITABLE.includes(record.status) && (
            <Popconfirm title="确认删除这道题？" description="删除后本版本题号将自动重排。" okText="确认删除" cancelText="取消" onConfirm={() => removeQuestion(record.id)}>
              <Button danger type="link" size="small" icon={<DeleteOutlined />}>删除</Button>
            </Popconfirm>
          )}
          {allow.review && record.status === 'pending_review' && (
            <Button type="link" size="small" icon={<CheckOutlined />} onClick={() => setReviewTarget(record)}>审核</Button>
          )}
          {allow.disable && record.status === 'published' && (
            <Popconfirm title="确认停用这道题？" description="停用后该题不再用于新的面试，已完成的面试记录不受影响。" okText="确认停用" cancelText="取消" onConfirm={() => disable(record.id)}>
              <Button danger type="link" size="small" icon={<PoweroffOutlined />}>停用</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  // 生成在后台进行，期间只停用“AI生成新版本”；已有版本的维护、审核和发布照常进行。
  const questionActions = needsQuestions && (allow.edit || allow.generate) ? (
    <Space wrap>
      {allow.edit && (
        <Button icon={<EditOutlined />} disabled={busyVersion !== undefined} onClick={() => setManualOpen(true)}>手动新增题目</Button>
      )}
      {allow.generate && (
        <Button
          type="primary"
          icon={<RocketOutlined />}
          disabled={generating || busyVersion !== undefined || activeBatch?.job_audit_status !== 'approved'}
          loading={generating}
          onClick={() => { setGenerationProblem(undefined); setGenerateOpen(true) }}
        >
          AI生成新版本
        </Button>
      )}
    </Space>
  ) : null
  const generationProgress = generation?.operation?.progress || '正在准备生成'
  const generationSource = [
    generation?.started_by ? `由 ${generation.started_by} 发起` : '',
    generation?.count ? `共 ${generation.count} 道` : '',
  ].filter(Boolean).join('，')
  const lastFailure = generation && !generation.running ? generation.last_error : undefined
  const failureKey = lastFailure ? `${batchId}:${generation?.operation?.id || generation?.finished_at || ''}` : ''
  const generationNotice = generating ? (
    <Alert
      className="page-alert"
      type="info"
      showIcon
      role="status"
      icon={<LoadingOutlined spin />}
      message={`正在生成题目：${generationProgress}，已用时 ${generationSeconds} 秒`}
      description={progressUnavailable
        ? '暂时读取不到最新进度，页面会继续查询；已发起的生成不受影响。'
        : `${generationSource ? `${generationSource}。` : ''}可以离开本页，生成完成后在这里查看。`}
    />
  ) : lastFailure && !dismissedFailures.includes(failureKey) ? (
    <Alert
      key={failureKey}
      className="page-alert"
      type="error"
      showIcon
      closable={{ closeIcon: <CloseOutlined />, 'aria-label': '关闭提示' }}
      onClose={() => setDismissedFailures(current => [...current, failureKey])}
      message={`最近一次题目生成没有完成${generation?.finished_at ? `（${formatTime(generation.finished_at)}）` : ''}`}
      description={<div className="evidence-text">{failureDetail(lastFailure, allow.generate)}</div>}
    />
  ) : generationProblem?.kind === 'unconfirmed' ? (
    <Alert
      className="page-alert"
      type="warning"
      showIcon
      closable={{ closeIcon: <CloseOutlined />, 'aria-label': '关闭提示' }}
      onClose={() => setGenerationProblem(undefined)}
      message={generationProblem.title}
      description={generationProblem.detail}
    />
  ) : null

  const versionTabs = versions.map(version => {
    const rows = questions.filter(q => q.version === version)
    const ready = rows.length > 0 && rows.every(q => q.status === 'approved')
    const published = version === activeBatch?.question_version && rows.some(q => q.status === 'published')
    const pending = rows.filter(q => q.status === 'pending_review').length
    const approved = rows.filter(q => q.status === 'approved').length
    const drafts = rows.filter(q => q.status === 'draft').length
    const returned = rows.filter(q => q.status === 'returned').length
    const label = published ? '当前启用' : ready ? '待发布' : pending ? `待审核 ${pending}` : returned ? '待修改' : drafts ? '草稿' : '已停用'
    const canSubmit = rows.some(q => EDITABLE.includes(q.status)) && rows.every(q => [...EDITABLE, 'approved'].includes(q.status))
    const canBulkReview = pending > 0 && rows.every(q => ['pending_review', 'approved'].includes(q.status))
    const canDeleteVersion = version !== activeBatch?.question_version && rows.every(q => [...EDITABLE, 'pending_review', 'approved'].includes(q.status))
    const actionDisabled = busyVersion !== undefined || questionsLoading
    const otherBusy = busyVersion !== undefined && busyVersion !== version
    return {
      key: String(version),
      label: <Space size={6}><span>{`v${version}`}</span><Tag color={published ? 'success' : ready ? 'processing' : pending || returned ? 'warning' : 'default'}>{label}</Tag></Space>,
      children: (
        <>
          <div className="table-toolbar">
            <Space direction="vertical" size={2}>
              <Typography.Text type="secondary">共 {rows.length} 道主体题{!published && ` · 已通过 ${approved}/${rows.length} 道`}</Typography.Text>
              {feedback && feedback.batchId === batchId && feedback.version === version && (
                <Typography.Text role="status" type={feedback.type === 'error' ? 'danger' : 'success'}>{feedback.text}</Typography.Text>
              )}
            </Space>
            <Space wrap>
              {allow.edit && canDeleteVersion && (
                <Popconfirm title={`删除 v${version} 的整套题目？`} description={`将删除本版本全部 ${rows.length} 道题，此操作不可撤销。`} okText="确认删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => operateVersion(version, 'delete')}>
                  <Button danger icon={<DeleteOutlined />} loading={busyVersion === version && bulkBusy === 'delete'} disabled={actionDisabled}>一键删除</Button>
                </Popconfirm>
              )}
              {allow.review && canBulkReview && (
                <Popconfirm title={`确认一键审核 v${version}？`} description={`确认已核对本版本全部题目，将通过 ${pending} 道待审核题目。审核后仍需发布启用。`} okText="全部通过" cancelText="取消" onConfirm={() => operateVersion(version, 'review-all')}>
                  <Button type="primary" icon={<CheckOutlined />} loading={busyVersion === version && bulkBusy === 'review-all'} disabled={actionDisabled}>一键审核</Button>
                </Popconfirm>
              )}
              {allow.submit && canSubmit && (
                <Button type="primary" icon={<CheckOutlined />} loading={busyVersion === version} disabled={otherBusy} onClick={() => submitReview(version)}>提交本版本审核</Button>
              )}
              {allow.publish && ready && (
                <Popconfirm title={`确认发布 v${version}？`} description="发布后用于后续新分配的面试，已分配的面试保持原版本。" okText="确认发布" cancelText="取消" onConfirm={() => publish(version)}>
                  <Button type="primary" icon={<RocketOutlined />} loading={busyVersion === version} disabled={otherBusy}>发布本版本</Button>
                </Popconfirm>
              )}
            </Space>
          </div>
          <Table rowKey="id" columns={columns} dataSource={rows} pagination={false} scroll={{ x: QUESTION_TABLE_WIDTH }} />
        </>
      ),
    }
  })

  const questionPane = !activeBatch ? (
    <Card title="题目版本">
      <Empty description={batchesLoading ? '正在读取招聘批次' : allow.createBatch ? '还没有招聘批次，请先创建批次' : '还没有招聘批次'} />
    </Card>
  ) : activeBatch.mode === 'listening_only' ? (
    <Card title={`${activeBatch.code} · ${activeBatch.job_name}`}>
      <Alert
        type="info"
        showIcon
        message="本批次仅做人工面试旁听"
        description="不需要题目，候选人无需登录，也不进行AI面试。添加候选人后，即可在AI旁听中依据简历和岗位要求旁听人工面试。"
      />
      <Space wrap className="section-row">
        {can(session, 'candidate:read') && <Link to={`/ai-interview/candidates?batch=${activeBatch.id}`}>前往候选人管理</Link>}
        {can(session, 'listening:use') && <Link to={`/ai-interview/listening?batch=${activeBatch.id}`}>前往AI旁听</Link>}
      </Space>
    </Card>
  ) : (
    <>
      <Card title={`${activeBatch.code} · ${activeBatch.job_name}`} extra={questionActions} loading={questionsLoading && questions.length === 0}>
        {generationNotice}
        {activeBatch.job_audit_status !== 'approved' && (
          <Alert
            className="page-alert"
            type="warning"
            showIcon
            message="该岗位的面试评价标准尚未确认，暂时不能生成题目"
            description={<>请先在<Link to={jobStandardPath(activeBatch.library_job_id)}>岗位库</Link>中确认“{activeBatch.job_name}”的面试评价标准，再回到这里生成题目。</>}
          />
        )}
        {versions.length > 0 && (
          <Typography.Paragraph type="secondary">
            {`共 ${versions.length} 套题目版本 · ${questions.some(q => q.version === activeBatch.question_version && q.status === 'published') ? `当前启用 v${activeBatch.question_version}` : '暂无启用版本'}`}
          </Typography.Paragraph>
        )}
        {versions.length === 0
          ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={allow.generate || allow.edit ? '当前批次还没有题目，可用“AI生成新版本”或“手动新增题目”开始' : '当前批次还没有题目'} />
          : (
            <Tabs
              activeKey={selectedVersion && versions.includes(Number(selectedVersion)) ? selectedVersion : String(versions[0])}
              onChange={setSelectedVersion}
              items={versionTabs}
            />
          )}
      </Card>
      {allow.onsite && activeBatch.status === 'active' && activeBatch.question_version > 0 && <OnsiteEntries batch={activeBatch} />}
    </>
  )

  const history = (historyTarget?.change_log || []) as ChangeLogEntry[]
  return (
    <>
      <PageHeader
        title="批次与题目"
        description="管理招聘批次；需要AI面试的批次在这里生成、审核和发布题目。"
        actions={<Space wrap><AiNotice />{allow.createBatch && <Button icon={<PlusOutlined />} onClick={() => setBatchForm({ batch: null })}>创建批次</Button>}</Space>}
      />
      {loadError && <Alert className="page-alert" type="error" showIcon message="未能读取招聘批次" description={loadError} />}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={7} xl={6}>
          <Card title="招聘批次" extra={<Tag>{batches.length} 个</Tag>} loading={batchesLoading}>
            <List
              dataSource={batches}
              locale={{ emptyText: '还没有招聘批次' }}
              renderItem={batch => (
                <List.Item className={`batch-item interview-batch-item ${batch.id === batchId ? 'active' : ''}`} onClick={() => setBatchId(batch.id)}>
                  <List.Item.Meta
                    title={<Space size={6} wrap>{batch.code}<StatusTag kind="batch" value={batch.status} />{batch.mode === 'listening_only' && <Tag color="blue">仅人工面试旁听</Tag>}</Space>}
                    description={
                      <div className="interview-batch-meta">
                        <div>{batch.name}</div>
                        <div>{batch.recruitment_type} · {batch.job_name}</div>
                        <div>{batch.mode === 'listening_only' ? '不需要题目' : batch.question_version ? `当前题目 v${batch.question_version}` : '尚未发布题目'} · 候选人 {batch.candidate_count} 人</div>
                        {(allow.editBatch || allow.deleteBatch) && (
                          <div className="interview-batch-actions">
                            {allow.editBatch && (
                              <Button type="link" size="small" icon={<EditOutlined />} onClick={event => { event.stopPropagation(); setBatchForm({ batch }) }}>编辑</Button>
                            )}
                            {allow.deleteBatch && (
                              <Popconfirm title="确认删除此批次？" description="已有题目或候选人的批次不能删除。" okText="确认删除" cancelText="取消" onConfirm={() => void removeBatch(batch.id)} onPopupClick={event => event.stopPropagation()}>
                                <Button danger type="link" size="small" icon={<DeleteOutlined />} onClick={event => event.stopPropagation()}>删除</Button>
                              </Popconfirm>
                            )}
                          </div>
                        )}
                      </div>
                    }
                  />
                </List.Item>
              )}
            />
          </Card>
        </Col>
        <Col xs={24} lg={17} xl={18}>{questionPane}</Col>
      </Row>
      {batchForm && (
        <BatchFormModal
          batch={batchForm.batch}
          onClose={() => setBatchForm(undefined)}
          onSaved={saved => {
            setBatchForm(undefined)
            setBatchId(saved.id)
            loadBatches().catch(error => message.error(errorMessage(error)))
          }}
        />
      )}
      <Modal
        title="AI生成主体题"
        open={generateOpen}
        closable={!starting}
        maskClosable={!starting}
        keyboard={!starting}
        onCancel={() => { if (!starting) setGenerateOpen(false) }}
        destroyOnHidden
        footer={generating ? [
          <Button key="background" type="primary" onClick={() => setGenerateOpen(false)}>在后台继续</Button>,
        ] : [
          <Button key="cancel" disabled={starting} onClick={() => setGenerateOpen(false)}>取消</Button>,
          <Button key="generate" type="primary" loading={starting} onClick={generate}>生成草稿</Button>,
        ]}
      >
        <Alert type="info" showIcon message="请设置 1 至 30 道主体题。题目较多时，生成时间会相应延长；生成后请逐题核对并提交审核。" />
        {generationProblem && (
          <Alert className="generation-error" type="error" showIcon message={generationProblem.title} description={<div className="evidence-text">{generationProblem.detail}</div>} />
        )}
        {generating && (
          <div className="question-generation-wait" role="status" aria-live="polite">
            <LoadingOutlined spin className="question-generation-spinner" aria-hidden="true" />
            <Typography.Text strong>{generationProgress}</Typography.Text>
            <Typography.Text type="secondary">已用时 {generationSeconds} 秒{generationSource && `（${generationSource}）`}</Typography.Text>
            <Typography.Text type="secondary">生成在后台进行，可以关闭本窗口或离开本页，生成完成后在这里查看。</Typography.Text>
          </div>
        )}
        <Form form={generateForm} preserve={false} disabled={generating || starting} layout="vertical" className="modal-form" initialValues={{ count: 6 }}>
          <Form.Item name="count" label="主体题数量" rules={[{ required: true, message: '请填写主体题数量' }]}>
            <InputNumber min={1} max={30} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal title="手动新增主体题" open={manualOpen} onCancel={() => setManualOpen(false)} onOk={createManualQuestion} okText="保存为草稿" cancelText="取消" destroyOnHidden>
        <Alert type="info" showIcon message="若当前只有已发布版本，系统会先复制为新的草稿版本，再加入这道题，已参加面试的候选人不会受影响。" />
        <Form form={manualForm} preserve={false} layout="vertical" className="modal-form" initialValues={{ time_limit: 90 }}>
          <Form.Item name="dimension" label="评价维度" rules={[{ required: true, message: '请选择评价维度' }]}>
            <Select placeholder="请选择评价维度" options={dimensions.map(item => ({ value: item.name, label: item.name }))} />
          </Form.Item>
          <Form.Item name="content" label="题目内容" rules={[{ required: true, min: 4, message: '请填写至少4个字的题目内容' }]}>
            <Input.TextArea rows={5} maxLength={2000} />
          </Form.Item>
          <Form.Item name="time_limit" label="回答时限（秒）" rules={[{ required: true, message: '请填写回答时限' }]}>
            <InputNumber min={30} max={600} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal title={`编辑 Q${editTarget?.sequence || ''}`} open={!!editTarget} onCancel={() => setEditTarget(null)} onOk={saveQuestion} okText="保存修改" cancelText="取消" destroyOnHidden>
        <Alert type="info" showIcon message="保存前将执行敏感内容过滤；已发布版本不可直接编辑。" />
        <Form form={editForm} preserve={false} layout="vertical" className="modal-form" initialValues={{ content: editTarget?.content, time_limit: editTarget?.time_limit, change_reason: '' }}>
          <Form.Item name="content" label="题目内容" rules={[{ required: true, message: '请填写题目内容' }]}>
            <Input.TextArea rows={5} />
          </Form.Item>
          <Form.Item name="time_limit" label="回答时限（秒）" rules={[{ required: true, message: '请填写回答时限' }]}>
            <InputNumber min={30} max={600} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="change_reason" label="修改原因" rules={[{ required: true, min: 2, message: '请填写至少2个字的修改原因' }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={`审核 Q${reviewTarget?.sequence || ''}`}
        open={!!reviewTarget}
        onCancel={() => setReviewTarget(null)}
        destroyOnHidden
        footer={[
          <Button key="return" danger onClick={() => review(false)}>退回修改</Button>,
          <Button key="approve" type="primary" onClick={() => review(true)}>审核通过</Button>,
        ]}
      >
        <Descriptions column={1} items={[
          { key: 'dimension', label: '维度', children: reviewTarget?.dimension },
          { key: 'content', label: '问题', children: <div className="evidence-text">{reviewTarget?.content}</div> },
        ]} />
        <Form form={reviewForm} preserve={false} layout="vertical" className="modal-form">
          <Form.Item name="comment" label="审核意见" rules={[{ required: true, whitespace: true, message: '请填写审核意见' }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
      <Drawer title={`Q${historyTarget?.sequence || ''} · 版本与修改记录`} width={560} open={!!historyTarget} onClose={() => setHistoryTarget(null)}>
        <Descriptions column={1} items={[
          { key: 'version', label: '题目版本', children: `v${historyTarget?.version}` },
          { key: 'status', label: '当前状态', children: historyTarget && <StatusTag kind="question" value={historyTarget.status} /> },
          { key: 'comment', label: '审核意见', children: <div className="evidence-text">{historyTarget?.review_comment || '—'}</div> },
        ]} />
        <List
          header={<Typography.Text strong>修改记录</Typography.Text>}
          dataSource={history}
          locale={{ emptyText: '暂无修改记录' }}
          renderItem={(item, index) => (
            <List.Item>
              <List.Item.Meta
                title={`${index + 1}. ${item.action || ''}`}
                description={
                  <>
                    <div className="evidence-text">{[item.actor, item.reason || item.comment].filter(Boolean).join(' · ')}</div>
                    {item.previous && <div className="evidence-quote">修改前：{item.previous}</div>}
                  </>
                }
              />
            </List.Item>
          )}
        />
      </Drawer>
    </>
  )
}
