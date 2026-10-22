import { CheckCircleOutlined, DownloadOutlined, EditOutlined, FileTextOutlined, ReloadOutlined, RollbackOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Col, Descriptions, Drawer, Empty, Input, InputNumber, Modal, Row, Select, Space, Table, Tabs, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, download, send } from '../../api'
import { HardIndicators, type HardIndicatorData } from '../../components/HardIndicators'
import { ResumeEvidence } from '../../components/ResumeEvidence'
import { StatusTag } from '../../components/StatusTag'
import { can, useAdminSession } from '../../lib/access'
import { formatScore, formatTime } from '../../lib/format'
import type { Evaluation, ReportContent } from '../../types'
import { EvaluationList, REPORT_COLUMNS, REPORT_TABLE_WIDTH, ReasonModal, RiskList, VersionHistory, versionLabel, type ReviewAction, type VersionRecord } from './reportParts'
import { CandidateName, errorMessage, type CandidateRef } from './shared'

type Content = Partial<ReportContent> & { hard_indicators?: HardIndicatorData | null }

interface InterviewReport {
  id: number
  candidate: CandidateRef
  job: { id: number; code: string; name: string } | null
  batch: { id: number; code: string; name: string } | null
  status: string
  generation_error: string
  /** 尚未生成成功时为 0，此时报告没有内容。 */
  current_version: number
  match_score: number
  current_content: Content
  versions: Array<VersionRecord & { content: Content }>
  updated_at: string
}

const POLL_INTERVAL = 4000
const RESUME_CHECK_STATUSES = ['回答支持', '存在差异待核实', '尚未覆盖', '人工已核实', '待核实']
const hasContent = (report: InterviewReport) => report.current_version > 0 && !['generating', 'generation_failed'].includes(report.status)

function ReportBody({ content }: { content?: Content }) {
  if (!content || !Object.keys(content).length) return <Empty description="报告内容不可用" />
  const analysis = content.match_analysis
  return (
    <div className="report-body">
      <Alert type="warning" showIcon message={content.disclaimer || 'AI辅助生成，须人工复核'} />
      <Card size="small" title="面试纪要"><div className="evidence-text">{content.summary}</div></Card>
      <Card size="small" title="六维评价（软性评价）"><EvaluationList evaluations={content.evaluations || []} /></Card>
      <Card size="small" title="硬指标（与六维评价分开，不计入评分）"><HardIndicators data={content.hard_indicators} /></Card>
      <ResumeEvidence context={content.resume_context} checks={content.resume_checks} />
      <Card size="small" title="岗位匹配分析">
        <Descriptions column={{ xs: 1, md: 2 }} items={[
          { key: 'score', label: '辅助匹配度', children: `${formatScore(analysis?.score)}%` },
          { key: 'note', label: '说明', children: '仅供人工初筛参考' },
          { key: 'matched', label: '匹配点', children: <div className="evidence-text">{(analysis?.matched || []).join('；') || '—'}</div> },
          { key: 'verify', label: '待核实', children: <div className="evidence-text">{(analysis?.to_verify || []).join('；') || '—'}</div> },
        ]} />
      </Card>
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={12}><Card size="small" title="风险提示" className="full-height-card"><RiskList risks={content.risks || []} /></Card></Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="线下人工面试建议问题" className="full-height-card">
            {content.offline_questions?.length
              ? <ol className="interview-report-list">{content.offline_questions.map((item, index) => <li key={index} className="evidence-text">{item}</li>)}</ol>
              : <Typography.Text type="secondary">暂无建议问题</Typography.Text>}
          </Card>
        </Col>
      </Row>
      <Card size="small" title={`完整问答记录（${content.qa_records?.length || 0} 条）`}>
        {(content.qa_records || []).map((record, index) => (
          <div className="interview-qa-item" key={index}>
            <div className="interview-qa-question evidence-text">{String(record.answer_code || `A${index + 1}`)} · {String(record.question || '')}</div>
            <div className="evidence-text">{String(record.transcript || '未作答')}</div>
            {record.followup ? (
              <div className="evidence-quote">追问：{String(record.followup)}{'\n'}回答：{String(record.followup_answer || '未作答')}</div>
            ) : null}
          </div>
        ))}
      </Card>
    </div>
  )
}

/** 第一阶段AI面试报告：列表、详情和人工复核。报告在候选人提交面试后由后台生成。 */
export function InterviewReports({ batchId, reportId, onOpen }: {
  batchId?: number
  /** 当前打开的报告（记在地址栏中）。 */
  reportId?: number
  onOpen: (reportId: number | undefined) => void
}) {
  const session = useAdminSession()
  const [reports, setReports] = useState<InterviewReport[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [pollTick, setPollTick] = useState(0)
  const [viewVersion, setViewVersion] = useState<number>()
  const [editContent, setEditContent] = useState<Content | null>(null)
  const [editReason, setEditReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState('')
  const [action, setAction] = useState<ReviewAction | null>(null)
  const [regenerating, setRegenerating] = useState(false)
  const [regenerateError, setRegenerateError] = useState('')
  const [retryingId, setRetryingId] = useState<number>()
  const [exportingId, setExportingId] = useState<number>()
  const [result, setResult] = useState<{ reportId: number; type: 'success' | 'warning'; title: string; text: string } | null>(null)
  const regeneratingRef = useRef(false)
  const request = useRef(0)
  const allow = {
    edit: can(session, 'report:edit'),
    back: can(session, 'report:return'),
    confirm: can(session, 'report:confirm'),
    export: can(session, 'report:export'),
  }

  const load = useCallback(async (silent = false) => {
    const current = ++request.current
    if (!silent) setLoading(true)
    try {
      const data = await api<InterviewReport[]>(batchId ? `/reports?batch_id=${batchId}` : '/reports')
      if (request.current === current) { setReports(data); setLoadError('') }
    } catch (error) {
      if (request.current === current && !silent) setLoadError(errorMessage(error))
    } finally {
      // 以最后一次读取为准结束“读取中”，定时刷新不会让列表一直停在读取状态。
      if (request.current === current) setLoading(false)
    }
  }, [batchId])
  useEffect(() => { void load() }, [load])

  // 只在有报告正在生成时定时刷新；全部生成结束后停止。
  const generating = reports.some(report => report.status === 'generating')
  useEffect(() => {
    if (!generating) return
    const timer = window.setTimeout(() => {
      load(true).finally(() => setPollTick(value => value + 1))
    }, POLL_INTERVAL)
    return () => window.clearTimeout(timer)
  }, [generating, pollTick, load])

  const selected = reports.find(report => report.id === reportId) || null
  const selectedId = selected?.id
  const selectedVersion = selected?.current_version
  useEffect(() => {
    setViewVersion(undefined)
    setRegenerateError('')
  }, [selectedId, selectedVersion])

  const replace = (updated: InterviewReport) => setReports(current => current.map(report => report.id === updated.id ? updated : report))
  const ready = !!selected && hasContent(selected)
  const displayed = !selected ? undefined
    : viewVersion && viewVersion !== selected.current_version ? selected.versions.find(item => item.version === viewVersion)?.content
      : selected.current_content

  const retry = async (report: InterviewReport) => {
    setRetryingId(report.id)
    try {
      replace(await send<InterviewReport>(`/reports/${report.id}/retry-generation`, 'POST'))
      message.success('已重新开始生成报告')
    } catch (error) {
      message.error(errorMessage(error))
      await load(true)
    } finally {
      setRetryingId(undefined)
    }
  }
  const exportReport = async (report: InterviewReport) => {
    setExportingId(report.id)
    try {
      await download(`/reports/${report.id}/export`, `${report.candidate.name}_AI面试报告.docx`)
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setExportingId(undefined)
    }
  }
  const startEdit = () => {
    if (!selected) return
    setEditContent(structuredClone(selected.current_content))
    setEditReason('')
    setEditError('')
  }
  const updateEvaluation = (index: number, patch: Partial<Evaluation>) => {
    setEditContent(content => {
      if (!content) return content
      const evaluations = [...(content.evaluations || [])]
      evaluations[index] = { ...evaluations[index], ...patch }
      return { ...content, evaluations }
    })
  }
  const saveEdit = async () => {
    if (!selected || !editContent || saving) return
    if (editReason.trim().length < 2) { setEditError('请填写至少2个字的修改原因'); return }
    setSaving(true)
    setEditError('')
    try {
      const updated = await send<InterviewReport>(`/reports/${selected.id}`, 'PUT', { content: editContent, reason: editReason.trim() })
      replace(updated)
      setEditContent(null)
      setResult({ reportId: updated.id, type: 'success', title: '人工修改版本已保存', text: 'AI原始版本未被覆盖；修改后的报告须重新人工确认后才能导出。' })
    } catch (error) {
      setEditError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }
  const submitAction = async (reason: string) => {
    if (!selected || !action) return
    try {
      const response = await send<{ status: string; library_sync?: string }>(`/reports/${selected.id}/${action}`, 'POST', { reason })
      const sync = response.library_sync || ''
      setResult(action === 'confirm'
        ? { reportId: selected.id, type: sync.includes('未同步') ? 'warning' : 'success', title: '报告已人工确认，可以导出', text: sync }
        : { reportId: selected.id, type: 'success', title: '报告已退回', text: '退回原因已写入审计日志。' })
      setAction(null)
      await load(true)
    } catch (error) {
      return errorMessage(error)
    }
  }
  const regenerate = async () => {
    if (!selected || regeneratingRef.current) return
    regeneratingRef.current = true
    setRegenerating(true)
    setRegenerateError('')
    try {
      const updated = await send<InterviewReport>(`/reports/${selected.id}/regenerate`, 'POST', { expected_version: selected.current_version })
      replace(updated)
      setResult({ reportId: updated.id, type: 'success', title: 'AI重新评分已保存为新版本', text: '请复核分数和回答原文后再人工确认。' })
    } catch (error) {
      setRegenerateError(errorMessage(error))
    } finally {
      regeneratingRef.current = false
      setRegenerating(false)
    }
  }
  const closeDetail = () => {
    if (regeneratingRef.current) return
    setResult(null)
    onOpen(undefined)
  }

  const columns: ColumnsType<InterviewReport> = [
    { title: '候选人', key: 'candidate', width: REPORT_COLUMNS.candidate, render: (_, report) => <CandidateName candidate={report.candidate} /> },
    { title: '批次', key: 'batch', render: (_, report) => <div className="evidence-text">{report.batch?.name || '—'}</div> },
    { title: '岗位', key: 'job', render: (_, report) => <div className="evidence-text">{report.job?.name || '—'}</div> },
    { title: '状态', dataIndex: 'status', width: REPORT_COLUMNS.status, render: (value: string) => <StatusTag kind="report" value={value} /> },
    { title: '匹配度', dataIndex: 'match_score', width: REPORT_COLUMNS.match, render: (value: number, report) => hasContent(report) ? <span className="match-score">{formatScore(value)}%</span> : '—' },
    { title: '更新时间', dataIndex: 'updated_at', width: REPORT_COLUMNS.updated, render: (value: string) => formatTime(value) },
    {
      title: '操作', key: 'actions', width: REPORT_COLUMNS.actions, render: (_, report) => (
        <Space size={[4, 0]} wrap className="interview-cell-actions">
          {hasContent(report) && <Button type="link" size="small" icon={<FileTextOutlined />} onClick={() => onOpen(report.id)}>查看报告</Button>}
          {report.status === 'generating' && <Typography.Text type="secondary">生成完成后可查看</Typography.Text>}
          {report.status === 'generation_failed' && allow.edit && (
            <Button type="link" size="small" icon={<ReloadOutlined />} loading={retryingId === report.id} onClick={() => retry(report)}>重新生成</Button>
          )}
          {report.status === 'confirmed' && allow.export && (
            <Button type="link" size="small" icon={<DownloadOutlined />} loading={exportingId === report.id} onClick={() => exportReport(report)}>导出 Word</Button>
          )}
        </Space>
      ),
    },
  ]

  return (
    <>
      {loadError && <Alert className="page-alert" type="error" showIcon message="未能读取面试报告" description={loadError} action={<Button size="small" onClick={() => void load()}>重新读取</Button>} />}
      {reportId && !loading && !loadError && !selected && (
        <Alert className="page-alert" type="info" showIcon closable onClose={() => onOpen(undefined)} message="没有找到要查看的报告" description="该报告可能不在当前筛选的批次中，或已被删除。" />
      )}
      {generating && <Alert className="page-alert" type="info" showIcon message="有报告正在生成，列表会自动刷新" description="候选人提交面试后报告在后台生成，通常需要一到几分钟，无需停留等待。" />}
      <Card>
        <Table
          className="interview-report-table"
          rowKey="id"
          columns={columns}
          dataSource={reports}
          loading={loading}
          pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
          scroll={{ x: REPORT_TABLE_WIDTH }}
          locale={{ emptyText: batchId ? '该批次暂无已提交面试的候选人报告' : '暂无已提交面试的候选人报告' }}
          // 生成失败的原因在该行下方整行显示，不挤在状态列里。
          expandable={{
            showExpandColumn: false,
            expandedRowKeys: reports.filter(report => report.status === 'generation_failed').map(report => report.id),
            expandedRowRender: report => <div className="interview-report-error evidence-text">生成失败原因：{report.generation_error || '生成未完成，请重新生成'}</div>,
          }}
        />
      </Card>
      <Drawer
        title={selected ? `${selected.candidate.name} · AI面试报告` : 'AI面试报告'}
        width="min(1040px, 94vw)"
        open={!!selected}
        onClose={closeDetail}
        extra={selected && (
          <Space wrap className="interview-drawer-actions">
            <StatusTag kind="report" value={selected.status} />
            {allow.edit && ready && <Button icon={<ReloadOutlined />} loading={regenerating} onClick={regenerate}>{regenerating ? 'AI评分中…' : 'AI重新评分'}</Button>}
            {allow.edit && ready && <Button disabled={regenerating} icon={<EditOutlined />} onClick={startEdit}>人工修改</Button>}
            {allow.back && ready && selected.status !== 'returned' && <Button disabled={regenerating} danger icon={<RollbackOutlined />} onClick={() => setAction('return')}>退回</Button>}
            {allow.confirm && ready && selected.status !== 'confirmed' && <Button disabled={regenerating} type="primary" icon={<CheckCircleOutlined />} onClick={() => setAction('confirm')}>人工确认</Button>}
            {allow.export && selected.status === 'confirmed' && <Button disabled={regenerating} icon={<DownloadOutlined />} loading={exportingId === selected.id} onClick={() => exportReport(selected)}>导出 Word</Button>}
          </Space>
        )}
      >
        {selected && (
          <>
            {result?.reportId === selected.id && (
              <Alert className="page-alert" type={result.type} showIcon closable onClose={() => setResult(null)} message={result.title} description={result.text || undefined} />
            )}
            {selected.status === 'generating' && <Alert className="page-alert" type="info" showIcon message="报告正在生成" description="生成完成后这里会自动显示报告内容。" />}
            {selected.status === 'generation_failed' && (
              <Alert
                className="page-alert"
                type="error"
                showIcon
                message="报告生成失败，候选人的回答已保存"
                description={<div className="evidence-text">{selected.generation_error || '生成未完成'}</div>}
                action={allow.edit ? <Button size="small" loading={retryingId === selected.id} onClick={() => retry(selected)}>重新生成</Button> : undefined}
              />
            )}
            {regenerating && <Alert className="page-alert" type="info" showIcon message="AI正在读取原始回答、逐项评分并生成报告，请稍候。" />}
            {regenerateError && <Alert className="page-alert" type="error" showIcon message="AI重新评分未完成" description={regenerateError} action={<Button size="small" onClick={regenerate}>重试</Button>} />}
            {ready && (
              <>
                {selected.status !== 'confirmed' && allow.export && <Typography.Paragraph className="interview-report-note">报告经人工确认后才能导出。</Typography.Paragraph>}
                <div className="version-bar">
                  <Typography.Text strong>报告版本</Typography.Text>
                  <Select
                    aria-label="查看的报告版本"
                    value={viewVersion ?? selected.current_version}
                    onChange={setViewVersion}
                    options={selected.versions.map(item => ({ value: item.version, label: `v${item.version} · ${versionLabel(item.version_type)} · ${item.editor}` }))}
                  />
                </div>
                <Tabs items={[
                  { key: 'report', label: '报告正文', children: <ReportBody content={displayed} /> },
                  { key: 'versions', label: `版本记录 (${selected.versions.length})`, children: <VersionHistory versions={selected.versions} current={selected.current_version} /> },
                ]} />
              </>
            )}
          </>
        )}
      </Drawer>
      <Modal
        title="创建人工修改版本"
        width={900}
        open={!!editContent}
        okText="保存人工版本"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void saveEdit()}
        onCancel={() => { if (!saving) setEditContent(null) }}
        destroyOnHidden
      >
        <Alert type="info" showIcon message="AI原始版本将完整保留；人工评分不会覆盖 AI 评分。硬指标来自简历档案，请在人员库中维护。" />
        {editError && <Alert className="section-row" type="error" showIcon message={editError} />}
        {editContent && (
          <div className="modal-form">
            <Typography.Text strong>面试纪要</Typography.Text>
            <Input.TextArea aria-label="面试纪要" autoSize={{ minRows: 3 }} value={editContent.summary} onChange={event => setEditContent({ ...editContent, summary: event.target.value })} />
            <div className="section-row">
              <Typography.Text strong>辅助岗位匹配度（%）</Typography.Text>
              <div>
                <InputNumber
                  aria-label="辅助岗位匹配度"
                  min={0}
                  max={100}
                  value={editContent.match_analysis?.score}
                  onChange={value => setEditContent({ ...editContent, match_analysis: { matched: [], to_verify: [], ...editContent.match_analysis, score: value || 0 } })}
                />
              </div>
            </div>
            <Typography.Title level={5} className="section-row">六维评价</Typography.Title>
            {(editContent.evaluations || []).map((evaluation, index) => (
              <Card size="small" key={evaluation.dimension} title={evaluation.dimension} className="edit-evaluation-card">
                <Row gutter={12}>
                  <Col xs={24} md={5}>
                    <Typography.Text>人工辅助评分</Typography.Text>
                    <InputNumber
                      aria-label={`${evaluation.dimension}人工辅助评分`}
                      min={0}
                      max={5}
                      precision={0}
                      value={evaluation.score}
                      onChange={value => updateEvaluation(index, { score: value, level: value !== null ? `${value}级` : '证据不足', insufficient: value === null })}
                    />
                  </Col>
                  <Col xs={24} md={19}>
                    <Typography.Text>评分理由</Typography.Text>
                    <Input.TextArea aria-label={`${evaluation.dimension}评分理由`} autoSize={{ minRows: 2 }} value={evaluation.reason} onChange={event => updateEvaluation(index, { reason: event.target.value })} />
                  </Col>
                </Row>
              </Card>
            ))}
            {!!editContent.resume_checks?.length && <Typography.Title level={5} className="section-row">简历核对意见</Typography.Title>}
            {(editContent.resume_checks || []).map((check, index) => {
              const update = (patch: Partial<typeof check>) => {
                const checks = [...(editContent.resume_checks || [])]
                checks[index] = { ...check, ...patch }
                setEditContent({ ...editContent, resume_checks: checks })
              }
              return (
                <Card size="small" key={index} className="edit-evaluation-card" title={`简历核对 ${index + 1}`}>
                  <div className="evidence-quote">简历：{check.resume_excerpt}{'\n'}回答：{check.answer_excerpt || '尚未覆盖'}</div>
                  <Select
                    className="section-row"
                    aria-label={`第${index + 1}项简历核对状态`}
                    value={check.status}
                    options={RESUME_CHECK_STATUSES.map(value => ({ value, label: value }))}
                    onChange={status => update({ status })}
                    style={{ minWidth: 200 }}
                  />
                  <Input.TextArea className="section-row" aria-label={`第${index + 1}项简历核对意见`} autoSize={{ minRows: 2 }} value={check.finding} onChange={event => update({ finding: event.target.value })} />
                </Card>
              )
            })}
            <div className="section-row">
              <Typography.Text strong>修改原因（必填）</Typography.Text>
              <Input.TextArea aria-label="修改原因" rows={2} value={editReason} onChange={event => setEditReason(event.target.value)} placeholder="说明核对了哪些回答证据及为何修改" />
            </div>
          </div>
        )}
      </Modal>
      {action && selected && (
        <ReasonModal action={action} subject={`${selected.candidate.name}的AI面试报告`} onCancel={() => setAction(null)} onSubmit={submitAction} />
      )}
    </>
  )
}
