import { DeleteOutlined, DownloadOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Collapse, Drawer, Empty, Popconfirm, Skeleton, Space, Table, Tabs, Tag, Tooltip, Typography, message } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, download } from '../../api'
import { AiNotice } from '../../components/PageHeader'
import { StatusTag } from '../../components/StatusTag'
import { formatScore, formatTime } from '../../lib/format'
import AssessmentView from './AssessmentView'
import MaterialPanel from './MaterialPanel'
import ReviewPanel from './ReviewPanel'
import type { AfterReview } from './ReviewPanel'
import { EvidenceQuotes, MODES, TextList, candidateQuery, nameKnown, personName } from './shared'
import type { MatchingAccess } from './shared'
import type { CandidateDetail, GeneratedReport, MatchingMode, MatchingOptions, MaterialUpdateResult } from './types'

interface Props {
  taskId: string
  mode: MatchingMode
  /** 为空时抽屉关闭。 */
  candidateId: string
  options: MatchingOptions | null
  access: MatchingAccess
  running: boolean
  /** 任务数据变化（如分析结束）后递增，抽屉随之重新读取。 */
  reloadToken: number
  reanalyzing: boolean
  hasNext: boolean
  onClose: () => void
  onChanged: () => void
  onReanalyze: () => void
  onRemove: (candidateId: string, name: string) => Promise<void>
  onNext: () => void
}

/** 人员详情：评分与判断依据、人员资料、原文依据、人工复核和报告，集中在同一个抽屉里核对。 */
export default function PersonDrawer({
  taskId, mode, candidateId, options, access, running, reloadToken, reanalyzing, hasNext,
  onClose, onChanged, onReanalyze, onRemove, onNext,
}: Props) {
  const fit = mode === 'people_to_jobs'
  const [detail, setDetail] = useState<CandidateDetail | null>(null)
  const [error, setError] = useState('')
  // 当前查看的岗位按人员记录：换一个人时回到其综合匹配度最高的岗位。
  const [active, setActive] = useState({ candidate: '', job: '' })
  const activeJob = active.candidate === candidateId ? active.job : ''
  const setActiveJob = (job: string) => setActive({ candidate: candidateId, job })
  const [exporting, setExporting] = useState(false)
  const [removing, setRemoving] = useState(false)
  const request = useRef(0)

  const load = useCallback(async () => {
    if (!candidateId) return
    const current = ++request.current
    try {
      const result = await api<CandidateDetail>(`/matching/tasks/${encodeURIComponent(taskId)}/candidates/${encodeURIComponent(candidateId)}`)
      if (current !== request.current) return
      setDetail(result)
      setError('')
    } catch (failure) {
      if (current === request.current) setError((failure as Error).message)
    }
  }, [taskId, candidateId])

  useEffect(() => {
    setError('')
    void load()
    return () => { request.current += 1 }
  }, [load, reloadToken])

  // 关闭过程中保留已显示的内容；切换到另一人时先显示读取状态。
  const shown = detail && (!candidateId || detail.candidate_id === candidateId) ? detail : null
  const shownName = shown ? personName({ name: shown.name, source_filename: shown.material.source_filename, code: shown.code }) : ''
  const assessment = shown?.assessments.find(item => item.job_id === activeJob) || shown?.assessments[0]
  const preferredJob = shown?.assessments.find(item => item.recommended)?.job_id
  const reanalyze = access.review && !running ? { busy: reanalyzing, run: onReanalyze } : undefined
  const decisions = options ? (fit ? options.fit_decisions : options.decisions) : []

  const materialSaved = (result: MaterialUpdateResult) => {
    if (result.warning) message.warning(result.warning)
    if (result.requires_reanalysis) message.warning('资料已保存。原评分和人工结论已失效，请重新分析后再复核')
    else message.success('资料已保存')
    void load()
    onChanged()
  }
  const reviewSaved = (after: AfterReview) => {
    onChanged()
    if (after.kind === 'person') {
      onNext()
      return
    }
    if (after.kind === 'job') setActiveJob(after.jobId)
    void load()
  }
  const exportReport = async () => {
    if (!shown) return
    setExporting(true)
    try {
      await download(
        `/matching/tasks/${encodeURIComponent(taskId)}/report?kind=single&${candidateQuery([shown.candidate_id])}`,
        `${shownName}_${MODES[mode].reportName}.docx`,
      )
      message.success('正式报告已导出')
      await load()
    } catch (failure) {
      message.error((failure as Error).message)
    } finally {
      setExporting(false)
    }
  }
  const remove = async () => {
    if (!shown) return
    setRemoving(true)
    try {
      await onRemove(shown.candidate_id, shownName)
    } finally {
      setRemoving(false)
    }
  }

  const body = !shown ? (
    error
      ? <Alert type="error" showIcon message="人员详情未能读取" description={error} action={<Button size="small" onClick={() => void load()}>重试</Button>} />
      : <Skeleton active paragraph={{ rows: 8 }} />
  ) : (
    <>
      {error && <Alert className="page-alert" type="warning" showIcon message="最新内容未能读取，当前显示的是上一次的内容" description={error} />}
      <div className="matching-person-head">
        <Space size={[8, 6]} wrap>
          <Typography.Text type="secondary">编号 {shown.code}</Typography.Text>
          {typeof shown.rank === 'number' && <Tag color="green">{fit ? `最高匹配度排第 ${shown.rank}` : `排名第 ${shown.rank}`}</Tag>}
          <StatusTag kind="review" value={shown.review_status || '待审核'} />
          {shown.reviewer && <Typography.Text type="secondary">复核人 {shown.reviewer}{shown.reviewed_at ? ` · ${formatTime(shown.reviewed_at)}` : ''}</Typography.Text>}
        </Space>
        <AiNotice />
      </div>
      {running && <Alert className="page-alert" type="info" showIcon message="任务正在分析，结果会自动更新" description="分析完成前不能修改资料、提交复核或导出报告。" />}
      {shown.missing_jobs.length > 0 && (
        <Alert className="page-alert" type="warning" showIcon message="部分岗位尚未完成分析"
          description={`尚未完成：${shown.missing_jobs.join('、')}。请在任务页重试未完成项；全部岗位分析完成后才能导出报告。`} />
      )}

      <Card size="small" className="section-card matching-first-card" title={fit ? '各岗位评分与判断依据' : '评分与判断依据'}>
        {!shown.assessments.length
          ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有匹配分析结果" />
          : fit ? (
            <Tabs
              activeKey={assessment?.job_id} onChange={setActiveJob}
              items={shown.assessments.map(item => ({
                key: item.job_id,
                label: (
                  <span>
                    {item.job_name}
                    <span className="matching-tab-score">{item.total === null ? '未形成得分' : formatScore(item.total)}</span>
                    {item.job_id === preferredJob && <Tag color="green" className="matching-tab-flag">推荐岗位</Tag>}
                  </span>
                ),
                children: <AssessmentView assessment={item} reanalyze={reanalyze} />,
              }))}
            />
          ) : assessment && <AssessmentView assessment={assessment} reanalyze={reanalyze} />}
      </Card>

      <Card size="small" className="section-card" title="人员资料">
        <MaterialPanel key={`${shown.candidate_id}:${shown.material.material_version}`} detail={shown} canEdit={access.review} running={running} onSaved={materialSaved} />
      </Card>

      <Collapse className="section-card matching-evidence" items={[{
        key: 'evidence',
        label: `原文依据（${shown.evidence.length} 条）`,
        children: shown.evidence.length
          ? <EvidenceQuotes items={shown.evidence} />
          : <Typography.Text type="secondary">没有可显示的原文片段</Typography.Text>,
      }]} />

      <Card size="small" className="section-card" title="人工复核">
        <ReviewPanel
          detail={shown} mode={mode} decisions={decisions} assessment={assessment} canReview={access.review && Boolean(options)}
          running={running} reanalyze={reanalyze} hasNext={hasNext} onJobChange={setActiveJob} onSaved={reviewSaved}
        />
      </Card>

      <Card size="small" className="section-card" title={`匹配报告（${MODES[mode].reportName}）`}>
        {shown.report.ready
          ? <Alert type="success" showIcon message="已完成人工复核，可以导出正式报告" description="报告使用最新保存的人员资料、评分依据、复核意见和结论；手机号、身份证号等保持脱敏。" />
          : (
            <Alert type="warning" showIcon message="暂时不能导出正式报告"
              description={<TextList items={shown.report.blockers} empty="尚未满足导出条件" />} />
          )}
        {access.export && shown.report.ready && (
          <div className="section-row">
            <Tooltip title={running ? '任务正在分析，完成后再导出' : ''}>
              <Button type="primary" icon={<DownloadOutlined />} loading={exporting} disabled={running} onClick={() => void exportReport()}>导出单人正式报告</Button>
            </Tooltip>
          </div>
        )}
        <h5 className="matching-subtitle">已生成的报告</h5>
        {shown.reports.length ? (
          <Table<GeneratedReport>
            size="small" rowKey="id" pagination={false} dataSource={shown.reports}
            columns={[
              { title: '文件', dataIndex: 'file', render: (value: string) => <span className="evidence-text">{value}</span> },
              { title: '生成时间', dataIndex: 'generated_at', width: 150, render: (value: string) => formatTime(value) },
              { title: '生成人', dataIndex: 'operator', width: 120, render: (value: string) => value || '—' },
            ]}
          />
        ) : <Typography.Text type="secondary">还没有生成过报告</Typography.Text>}
      </Card>
    </>
  )

  return (
    <Drawer
      open={Boolean(candidateId)} onClose={onClose} width="min(880px, 100vw)" className="matching-person-drawer"
      title={shown ? `${nameKnown(shown.name) ? shown.name : `姓名待确认（${shown.material.source_filename || shown.code}）`} · 匹配详情` : '匹配详情'}
      extra={shown && access.remove && (running
        ? <Tooltip title="任务正在分析，完成后才能删除"><Button danger icon={<DeleteOutlined />} disabled>从任务中删除</Button></Tooltip>
        : (
          <Popconfirm
            title={`确认从本任务中删除 ${shownName}？`} placement="bottomRight"
            description="将删除该人员在本任务中的匹配结果、人工复核记录和已生成的报告，不可恢复；人员库中的资料不受影响。"
            okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={remove}
          >
            <Button danger icon={<DeleteOutlined />} loading={removing}>从任务中删除</Button>
          </Popconfirm>
        ))}
    >
      {body}
    </Drawer>
  )
}
