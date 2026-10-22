import { CheckCircleOutlined, DownloadOutlined, EditOutlined, FileSearchOutlined, ReloadOutlined, RollbackOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Col, Descriptions, Drawer, Empty, Input, Modal, Popconfirm, Row, Select, Space, Table, Tabs, Tag, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, download, send } from '../../api'
import { HardIndicators, type HardIndicatorData } from '../../components/HardIndicators'
import { ResumeEvidence, type ResumeCheck, type ResumeContext } from '../../components/ResumeEvidence'
import { StatusTag } from '../../components/StatusTag'
import { can, useAdminSession } from '../../lib/access'
import { formatScore, formatTime } from '../../lib/format'
import type { Evaluation } from '../../types'
import { EvaluationList, REPORT_COLUMNS, REPORT_TABLE_WIDTH, ReasonModal, RiskList, VersionHistory, versionLabel, type ReviewAction, type VersionRecord } from './reportParts'
import { CandidateName, errorMessage, type CandidateRef } from './shared'

type Mode = 'linked' | 'standalone'

interface Finding {
  dimension: string
  status: string
  analysis: string
  stage_one_excerpt?: string
  answer_excerpt?: string
  resume_excerpt?: string
  speaker_basis?: string
}

interface ComprehensiveContent {
  mode?: Mode
  disclaimer?: string
  generation_mode?: string
  /** 没有得到模型分析时的原因。 */
  generation_note?: string
  resume_context?: ResumeContext
  resume_checks?: ResumeCheck[]
  stage_one?: { report_id?: number | null; content?: { summary?: string; evaluations?: Evaluation[]; risks?: string[] } } | null
  stage_one_summary?: string
  stage_one_evaluations?: Evaluation[]
  stage_one_risks?: string[]
  stage_two_summary?: string
  stage_two_evidence?: Array<{ id: string; speaker: string; text: string; turns?: SpokenTurn[] }>
  findings?: Finding[]
  adopted_questions?: string[]
  risks?: string[]
}

/** 连续对话中同一个人连着说的一段话。basis 为 confirmed 表示面试官确认过，其余是按对话语境推断的。 */
interface SpokenTurn {
  role: string
  basis: string
  text: string
}

interface ComprehensiveItem {
  session_id: number
  /** linked：关联第一阶段AI面试；standalone：仅人工面试，依据简历和岗位。 */
  mode: Mode
  candidate: CandidateRef
  job: { id: number; code: string; name: string } | null
  batch: { id: number; code: string; name: string } | null
  status: string
  current_version: number
  stage_one: { report_id: number | null; version: number | null; summary: string; match_score: number | null }
  stage_two: { summary: string; evidence_count: number }
  hard_indicators: HardIndicatorData
  risks: string[]
  content: ComprehensiveContent
  versions: Array<VersionRecord & { content?: ComprehensiveContent }>
}

const modeLabels: Record<Mode, { label: string; color: string; note: string }> = {
  linked: { label: '关联AI面试', color: 'green', note: '综合了第一阶段AI面试报告和人工面试的旁听记录。' },
  standalone: { label: '仅人工面试', color: 'blue', note: '候选人未做AI面试，依据简历、岗位要求和人工面试的旁听记录，不含量化评分。' },
}
const speakers: Record<string, { label: string; color: string }> = {
  interviewer: { label: '面试官', color: 'blue' },
  candidate: { label: '候选人', color: 'green' },
  dialogue: { label: '混合对话', color: 'gold' },
}
const roles: Record<string, { label: string; color: string }> = {
  interviewer: { label: '面试官', color: 'blue' },
  candidate: { label: '候选人', color: 'green' },
  unknown: { label: '未能判断', color: 'default' },
}
const findingColors: Record<string, string> = { 证据不足: 'warning', 存在差异待核实: 'orange', 新增证据待复核: 'processing' }
/** 后台重新生成期间，每隔多久读取一次结果。 */
const POLL_INTERVAL = 3000

const PRESERVED = '证据保全降级'

/** 报告还是AI生成的原样（没有人工修改或确认），且只保全了原文证据时，可以重新生成。 */
function regenerable(item: ComprehensiveItem): boolean {
  return item.content.generation_mode === PRESERVED && ['pending_review', 'returned'].includes(item.status)
    && item.versions.every(version => version.version_type === 'ai_original')
}

function ModeTag({ mode }: { mode: Mode }) {
  const item = modeLabels[mode] || modeLabels.linked
  return <Tag color={item.color}>{item.label}</Tag>
}

function mergedRisks(content: ComprehensiveContent): string[] {
  const all = [...(content.stage_one_risks || content.stage_one?.content?.risks || []), ...(content.risks || [])]
  return all.filter((risk, index) => all.indexOf(risk) === index)
}

function lastUpdated(item: ComprehensiveItem): string | undefined {
  return item.versions[item.versions.length - 1]?.created_at
}

function Quote({ label, text }: { label: string; text?: string }) {
  if (!text) return null
  return (
    <>
      <span className="interview-finding-label">{label}</span>
      <div className="evidence-quote">{text}</div>
    </>
  )
}

function ComprehensiveBody({ item, content, onOpenInterviewReport }: {
  item: ComprehensiveItem
  content: ComprehensiveContent
  onOpenInterviewReport?: (reportId: number) => void
}) {
  const mode = content.mode || item.mode
  const linked = mode === 'linked'
  const evaluations = content.stage_one_evaluations?.length ? content.stage_one_evaluations : content.stage_one?.content?.evaluations || []
  const evidence = content.stage_two_evidence || []
  const degraded = content.generation_mode === PRESERVED
  const inferred = evidence.some(line => line.turns?.some(turn => turn.basis !== 'confirmed'))
  return (
    <div className="report-body">
      <Alert
        type="warning"
        showIcon
        message={degraded
          ? `这份报告没有得到模型的分析结果，只保全了原文证据${content.generation_note ? `（原因：${content.generation_note}）` : ''}。请重新生成，或由人工补充核实后再确认。`
          : content.disclaimer || 'AI辅助生成，须人工复核'}
        description="综合报告仅供人工评估，不构成录用或淘汰决定。"
      />
      <Card size="small" title={<Space wrap>报告类型<ModeTag mode={mode} /></Space>}>
        <div className="evidence-text">{modeLabels[mode]?.note}</div>
      </Card>
      {linked && (
        <Card
          size="small"
          title="第一阶段 · AI面试"
          extra={item.stage_one.report_id && onOpenInterviewReport
            ? <Button type="link" size="small" icon={<FileSearchOutlined />} onClick={() => onOpenInterviewReport(item.stage_one.report_id as number)}>查看AI面试报告</Button>
            : undefined}
        >
          <Descriptions size="small" column={1} items={[
            { key: 'match', label: '辅助匹配度', children: item.stage_one.match_score === null || item.stage_one.match_score === undefined ? '—' : `${formatScore(item.stage_one.match_score)}%` },
            { key: 'summary', label: '面试纪要', children: <div className="evidence-text">{content.stage_one_summary || content.stage_one?.content?.summary || '—'}</div> },
          ]} />
          <EvaluationList evaluations={evaluations} />
        </Card>
      )}
      <Card size="small" title="硬指标（与面试评价分开，不计入评分）"><HardIndicators data={item.hard_indicators} /></Card>
      <ResumeEvidence context={content.resume_context} checks={content.resume_checks} />
      <Card size="small" title={`人工面试证据（${evidence.length} 段）`}>
        <div className="evidence-text">{content.stage_two_summary || item.stage_two.summary}</div>
        {inferred && (
          <Typography.Paragraph type="secondary" className="interview-report-note">
            连续对话由系统按对话语境区分发言人。标为“推断”的是系统的判断，请核对录音；标为“已确认”的由面试官确认过。
          </Typography.Paragraph>
        )}
        {evidence.length === 0
          ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无人工面试转写证据" />
          : evidence.map(line => {
            const speaker = speakers[line.speaker] || { label: '角色待核对', color: 'default' }
            if (line.speaker === 'dialogue' && line.turns?.length) {
              return (
                <div className="interview-transcript-turns" key={line.id}>
                  {line.turns.map((turn, index) => {
                    const role = roles[turn.role] || roles.unknown
                    return (
                      <div className="interview-transcript-line" key={index}>
                        <span>
                          <Tag color={role.color}>{role.label}</Tag>
                          <Tag color={turn.basis === 'confirmed' ? 'success' : 'gold'}>{turn.basis === 'confirmed' ? '已确认' : '推断'}</Tag>
                        </span>
                        <div className="evidence-text">{turn.text}</div>
                      </div>
                    )
                  })}
                </div>
              )
            }
            return (
              <div className="interview-transcript-line" key={line.id}>
                <span><Tag color={speaker.color}>{speaker.label}</Tag></span>
                <div className="evidence-text">{line.text}</div>
              </div>
            )
          })}
      </Card>
      <Card size="small" title="综合分析">
        {!content.findings?.length
          ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无综合分析" />
          : content.findings.map((finding, index) => (
            <div className="interview-finding-item" key={`${finding.dimension}-${index}`}>
              <Space wrap>
                <Typography.Text strong>{finding.dimension}</Typography.Text>
                <Tag color={findingColors[finding.status] || 'default'}>{finding.status}</Tag>
              </Space>
              <div className="evidence-text">{finding.analysis}</div>
              <Quote label="AI面试报告原文" text={finding.stage_one_excerpt} />
              <Quote label="人工面试回答原文" text={finding.answer_excerpt} />
              <Quote label="简历原文" text={finding.resume_excerpt} />
              <Quote label="回答归属依据" text={finding.speaker_basis} />
            </div>
          ))}
      </Card>
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={12}>
          <Card size="small" title="已采用的提问" className="full-height-card">
            {content.adopted_questions?.length
              ? <ol className="interview-report-list">{content.adopted_questions.map((question, index) => <li key={index} className="evidence-text">{question}</li>)}</ol>
              : <Typography.Text type="secondary">本场未采用AI建议的提问</Typography.Text>}
          </Card>
        </Col>
        <Col xs={24} lg={12}><Card size="small" title="风险提示" className="full-height-card"><RiskList risks={mergedRisks(content)} /></Card></Col>
      </Row>
    </div>
  )
}

/** 综合报告：人工面试旁听结束后生成，汇总AI面试（如有）、简历和人工面试证据。 */
export function ComprehensiveReports({ batchId, candidateId, onOpen, onOpenInterviewReport, pollIntervalMs = POLL_INTERVAL }: {
  pollIntervalMs?: number
  batchId?: number
  /** 当前打开的综合报告所属候选人（记在地址栏中）。 */
  candidateId?: number
  onOpen: (candidateId: number | undefined) => void
  onOpenInterviewReport: (reportId: number) => void
}) {
  const session = useAdminSession()
  const [items, setItems] = useState<ComprehensiveItem[]>([])
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [viewVersion, setViewVersion] = useState<number>()
  const [editContent, setEditContent] = useState<ComprehensiveContent | null>(null)
  const [editReason, setEditReason] = useState('')
  const [editError, setEditError] = useState('')
  const [saving, setSaving] = useState(false)
  const [action, setAction] = useState<ReviewAction | null>(null)
  const [exportingId, setExportingId] = useState<number>()
  const [regeneratingId, setRegeneratingId] = useState<number>()
  const [result, setResult] = useState<{ candidateId: number; title: string; text: string } | null>(null)
  const request = useRef(0)
  const allow = {
    regenerate: can(session, 'report:edit') || can(session, 'listening:use'),
    edit: can(session, 'report:edit'),
    back: can(session, 'report:return'),
    confirm: can(session, 'report:confirm'),
    export: can(session, 'report:export'),
  }

  const load = useCallback(async (silent = false) => {
    const current = ++request.current
    if (!silent) setLoading(true)
    try {
      const data = await api<{ notice: string; items: ComprehensiveItem[] }>(batchId ? `/comprehensive-reports?batch_id=${batchId}` : '/comprehensive-reports')
      if (request.current === current) { setItems(data.items); setNotice(data.notice); setLoadError('') }
    } catch (error) {
      if (request.current === current) setLoadError(errorMessage(error))
    } finally {
      if (request.current === current) setLoading(false)
    }
  }, [batchId])
  useEffect(() => { void load() }, [load])

  const generating = items.some(item => item.status === 'generating')
  useEffect(() => {
    // 有报告正在重新生成时定时读取，生成后自动显示新版本。
    if (!generating) return
    const timer = window.setInterval(() => { void load(true) }, pollIntervalMs)
    return () => window.clearInterval(timer)
  }, [generating, load, pollIntervalMs])

  const selected = items.find(item => item.candidate.id === candidateId) || null
  const selectedKey = selected ? `${selected.session_id}-${selected.current_version}` : ''
  useEffect(() => { setViewVersion(undefined) }, [selectedKey])
  const displayed = !selected ? undefined
    : viewVersion && viewVersion !== selected.current_version ? selected.versions.find(item => item.version === viewVersion)?.content || selected.content
      : selected.content

  const exportReport = async (item: ComprehensiveItem) => {
    setExportingId(item.candidate.id)
    try {
      await download(`/listening/${item.candidate.id}/report/export`, `${item.candidate.name}_综合报告.docx`)
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setExportingId(undefined)
    }
  }
  const regenerate = async (item: ComprehensiveItem) => {
    setRegeneratingId(item.candidate.id)
    try {
      await send(`/listening/${item.candidate.id}/report/regenerate`, 'POST')
      setResult({ candidateId: item.candidate.id, title: '已开始重新生成', text: '一般需要一到两分钟，生成后这里自动显示新版本；现在这一版保留在版本记录里。' })
      await load(true)
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setRegeneratingId(undefined)
    }
  }
  const startEdit = () => {
    if (!selected) return
    setEditContent(structuredClone(selected.content))
    setEditReason('')
    setEditError('')
  }
  const saveEdit = async () => {
    if (!selected || !editContent || saving) return
    if (editReason.trim().length < 2) { setEditError('请填写至少2个字的修改原因'); return }
    setSaving(true)
    setEditError('')
    try {
      const content = { ...editContent, risks: (editContent.risks || []).map(risk => risk.trim()).filter(Boolean) }
      await send(`/listening/${selected.candidate.id}/report`, 'PUT', { content, reason: editReason.trim() })
      setEditContent(null)
      setResult({ candidateId: selected.candidate.id, title: '人工修改版本已保存', text: 'AI原始版本仍保留；修改后的综合报告须重新人工确认后才能导出。' })
      await load(true)
    } catch (error) {
      setEditError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }
  const submitAction = async (reason: string) => {
    if (!selected || !action) return
    try {
      const response = await send<{ status: string; library_sync?: string }>(`/listening/${selected.candidate.id}/report/${action}`, 'POST', { reason })
      setResult({
        candidateId: selected.candidate.id,
        title: action === 'confirm' ? '综合报告已人工确认，可以导出' : '综合报告已退回',
        text: action === 'confirm' ? response.library_sync || '' : '退回原因已写入审计日志。',
      })
      setAction(null)
      await load(true)
    } catch (error) {
      return errorMessage(error)
    }
  }
  const closeDetail = () => {
    setResult(null)
    onOpen(undefined)
  }

  const columns: ColumnsType<ComprehensiveItem> = [
    { title: '候选人', key: 'candidate', width: REPORT_COLUMNS.candidate, render: (_, item) => <CandidateName candidate={item.candidate} /> },
    { title: '批次', key: 'batch', render: (_, item) => <div className="evidence-text">{item.batch?.name || '—'}</div> },
    { title: '岗位', key: 'job', render: (_, item) => <div className="evidence-text">{item.job?.name || '—'}</div> },
    {
      title: '类型 / 状态', key: 'status', width: REPORT_COLUMNS.status, render: (_, item) => (
        <Space direction="vertical" size={4}>
          <ModeTag mode={item.mode} />
          <StatusTag kind="report" value={item.status} />
        </Space>
      ),
    },
    { title: '匹配度', key: 'match', width: REPORT_COLUMNS.match, render: (_, item) => item.stage_one.match_score === null || item.stage_one.match_score === undefined ? '—' : <span className="match-score">{formatScore(item.stage_one.match_score)}%</span> },
    { title: '更新时间', key: 'updated', width: REPORT_COLUMNS.updated, render: (_, item) => formatTime(lastUpdated(item)) },
    {
      title: '操作', key: 'actions', width: REPORT_COLUMNS.actions, render: (_, item) => (
        <Space size={[4, 0]} wrap className="interview-cell-actions">
          <Button type="link" size="small" icon={<FileSearchOutlined />} onClick={() => onOpen(item.candidate.id)}>查看报告</Button>
          {item.status === 'confirmed' && allow.export && (
            <Button type="link" size="small" icon={<DownloadOutlined />} loading={exportingId === item.candidate.id} onClick={() => exportReport(item)}>导出 Word</Button>
          )}
        </Space>
      ),
    },
  ]

  return (
    <>
      {loadError && <Alert className="page-alert" type="error" showIcon message="未能读取综合报告" description={loadError} action={<Button size="small" onClick={() => void load()}>重新读取</Button>} />}
      {candidateId && !loading && !loadError && !selected && (
        <Alert className="page-alert" type="info" showIcon closable onClose={() => onOpen(undefined)} message="没有找到要查看的综合报告" description="该候选人可能不在当前筛选的批次中，或人工面试旁听尚未结束。" />
      )}
      {notice && <Alert className="page-alert" type="info" showIcon message={notice} />}
      <Card>
        <Table
          className="interview-report-table"
          rowKey="session_id"
          columns={columns}
          dataSource={items}
          loading={loading}
          pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
          scroll={{ x: REPORT_TABLE_WIDTH }}
          locale={{ emptyText: '暂无综合报告。人工面试旁听结束后，综合报告会出现在这里。' }}
        />
      </Card>
      <Drawer
        title={selected ? `${selected.candidate.name} · 综合报告` : '综合报告'}
        width="min(1040px, 94vw)"
        open={!!selected}
        onClose={closeDetail}
        extra={selected && (
          <Space wrap className="interview-drawer-actions">
            <ModeTag mode={selected.mode} />
            <StatusTag kind="report" value={selected.status} />
            {allow.regenerate && regenerable(selected) && (
              <Popconfirm
                title="重新生成综合报告？"
                description="重新生成的内容记为新版本，现在这一版保留在版本记录里。"
                okText="重新生成"
                cancelText="取消"
                onConfirm={() => void regenerate(selected)}
              >
                <Button icon={<ReloadOutlined />} loading={regeneratingId === selected.candidate.id}>重新生成</Button>
              </Popconfirm>
            )}
            {allow.edit && !['confirmed', 'generating'].includes(selected.status) && <Button icon={<EditOutlined />} onClick={startEdit}>人工修改</Button>}
            {allow.back && !['returned', 'generating'].includes(selected.status) && <Button danger icon={<RollbackOutlined />} onClick={() => setAction('return')}>退回</Button>}
            {allow.confirm && !['confirmed', 'generating'].includes(selected.status) && <Button type="primary" icon={<CheckCircleOutlined />} onClick={() => setAction('confirm')}>人工确认</Button>}
            {allow.export && selected.status === 'confirmed' && <Button icon={<DownloadOutlined />} loading={exportingId === selected.candidate.id} onClick={() => exportReport(selected)}>导出 Word</Button>}
          </Space>
        )}
      >
        {selected && displayed && (
          <>
            {result?.candidateId === selected.candidate.id && (
              <Alert className="page-alert" type="success" showIcon closable onClose={() => setResult(null)} message={result.title} description={result.text || undefined} />
            )}
            {selected.status === 'generating' && (
              <Alert className="page-alert" type="info" showIcon message="综合报告正在重新生成" description="生成后这里自动显示新版本；期间不能修改、退回或确认。下面是此前的版本。" />
            )}
            {selected.status === 'confirmed' && allow.edit && <Typography.Paragraph className="interview-report-note">已确认的综合报告不能直接修改；如需修改请先退回。</Typography.Paragraph>}
            {!['confirmed', 'generating'].includes(selected.status) && allow.export && <Typography.Paragraph className="interview-report-note">报告经人工确认后才能导出。</Typography.Paragraph>}
            <div className="version-bar">
              <Typography.Text strong>报告版本</Typography.Text>
              <Select
                aria-label="查看的综合报告版本"
                value={viewVersion ?? selected.current_version}
                onChange={setViewVersion}
                options={selected.versions.map(item => ({ value: item.version, label: `v${item.version} · ${versionLabel(item.version_type)} · ${item.editor}` }))}
              />
            </div>
            <Tabs items={[
              { key: 'report', label: '报告正文', children: <ComprehensiveBody item={selected} content={displayed} onOpenInterviewReport={onOpenInterviewReport} /> },
              { key: 'versions', label: `版本记录 (${selected.versions.length})`, children: <VersionHistory versions={selected.versions} current={selected.current_version} /> },
            ]} />
          </>
        )}
      </Drawer>
      <Modal
        title="人工修改综合报告"
        width={900}
        open={!!editContent}
        okText="保存人工版本"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void saveEdit()}
        onCancel={() => { if (!saving) setEditContent(null) }}
        destroyOnHidden
      >
        <Alert type="info" showIcon message="AI原始版本会保留；修改后报告重新进入待人工复核状态。回答原文和简历原文不能修改。" />
        {editError && <Alert className="section-row" type="error" showIcon message={editError} />}
        {editContent && (
          <div className="modal-form">
            {(editContent.mode || selected?.mode) === 'linked' && (
              <>
                <Typography.Text strong>第一阶段AI面试纪要</Typography.Text>
                <Input.TextArea aria-label="第一阶段AI面试纪要" autoSize={{ minRows: 3 }} value={editContent.stage_one_summary || ''} onChange={event => setEditContent({ ...editContent, stage_one_summary: event.target.value })} />
              </>
            )}
            <div className="section-row">
              <Typography.Text strong>人工面试纪要</Typography.Text>
              <Input.TextArea aria-label="人工面试纪要" autoSize={{ minRows: 3 }} value={editContent.stage_two_summary || ''} onChange={event => setEditContent({ ...editContent, stage_two_summary: event.target.value })} />
            </div>
            {!!editContent.findings?.length && <Typography.Title level={5} className="section-row">综合分析</Typography.Title>}
            {(editContent.findings || []).map((finding, index) => (
              <Card size="small" key={`${finding.dimension}-${index}`} className="edit-evaluation-card" title={<Space wrap>{finding.dimension}<Tag color={findingColors[finding.status] || 'default'}>{finding.status}</Tag></Space>}>
                {finding.answer_excerpt && <div className="evidence-quote">回答原文：{finding.answer_excerpt}</div>}
                <Input.TextArea
                  className="section-row"
                  aria-label={`${finding.dimension}综合分析`}
                  autoSize={{ minRows: 2 }}
                  value={finding.analysis}
                  onChange={event => {
                    const findings = [...(editContent.findings || [])]
                    findings[index] = { ...finding, analysis: event.target.value }
                    setEditContent({ ...editContent, findings })
                  }}
                />
              </Card>
            ))}
            <div className="section-row">
              <Typography.Text strong>风险提示（每行一条）</Typography.Text>
              <Input.TextArea
                aria-label="风险提示"
                autoSize={{ minRows: 3 }}
                value={(editContent.risks || []).join('\n')}
                onChange={event => setEditContent({ ...editContent, risks: event.target.value.split('\n') })}
                onBlur={() => setEditContent(content => content && { ...content, risks: (content.risks || []).map(risk => risk.trim()).filter(Boolean) })}
              />
            </div>
            <div className="section-row">
              <Typography.Text strong>修改原因（必填）</Typography.Text>
              <Input.TextArea aria-label="修改原因" rows={2} value={editReason} onChange={event => setEditReason(event.target.value)} placeholder="请说明修改依据" />
            </div>
          </div>
        )}
      </Modal>
      {action && selected && (
        <ReasonModal action={action} subject={`${selected.candidate.name}的综合报告`} onCancel={() => setAction(null)} onSubmit={submitAction} />
      )}
    </>
  )
}
