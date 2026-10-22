import { DownloadOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Checkbox, Modal, Space, Tooltip, Typography, message } from 'antd'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { api, download } from '../../api'
import { MODES, candidateQuery, personName, safeFileName, saveJson } from './shared'
import type { PersonRow, TaskDetail } from './types'

type ExportKind = 'single' | 'package' | 'comparison' | 'sheet' | 'evidence' | 'results'

/** 匹配报告与数据导出。勾选了人员时导出所选人员，未勾选时导出本任务全部人员。 */
export default function ExportPanel({ task, selected, onExported }: {
  task: TaskDetail
  selected: string[]
  onExported: () => void
}) {
  const [busy, setBusy] = useState<ExportKind | ''>('')
  const [confirmPackage, setConfirmPackage] = useState(false)
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const [includeOriginals, setIncludeOriginals] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  const people = task.people.filter((row): row is PersonRow & { candidate_id: string } => Boolean(row.candidate_id))
  const chosen = people.filter(row => selected.includes(row.candidate_id))
  const scope = chosen.length ? chosen : people
  // 范围是全部人员时不逐个传编号，由后端按整个任务处理。
  const query = candidateQuery(chosen.length && chosen.length < people.length ? chosen.map(row => row.candidate_id) : [])
  const ready = scope.filter(row => row.report_ready)
  const blocked = scope.filter(row => !row.report_ready)
  const base = `/matching/tasks/${encodeURIComponent(task.id)}`
  const fileBase = safeFileName(task.name)
  const path = (route: string, ...params: string[]) => {
    const search = params.filter(Boolean).join('&')
    return `${base}/${route}${search ? `?${search}` : ''}`
  }

  const run = async (kind: ExportKind, work: () => Promise<void>, done: string, report = false) => {
    setBusy(kind)
    try {
      await work()
      message.success(done)
      if (report) onExported()
    } catch (failure) {
      message.error((failure as Error).message)
    } finally {
      setBusy('')
    }
  }

  const exportSingle = () => run('single',
    () => download(path('report', 'kind=single', candidateQuery([scope[0].candidate_id])), `${personName(scope[0])}_${MODES[task.mode].reportName}.docx`),
    '单人正式报告已导出', true)
  const exportPackage = () => {
    setConfirmPackage(false)
    return run('package', () => download(path('report', 'kind=package', query), `${fileBase}_报告包.zip`), `报告包已导出，包含 ${ready.length} 人的正式报告`, true)
  }
  const exportComparison = () => run('comparison',
    () => download(path('report', 'kind=comparison', query), `${fileBase}_多人对比报告.docx`), '多人对比报告已导出', true)
  const exportSheet = () => run('sheet', () => download(path('review-sheet', query), `${fileBase}_审核明细.csv`), '审核明细表已导出')
  const exportEvidence = () => {
    const originals = includeOriginals
    setEvidenceOpen(false)
    return run('evidence',
      () => download(path('evidence-package', query, `include_originals=${originals}`), `${fileBase}_佐证数据.zip`),
      originals ? '佐证数据包已导出（含原始简历），请在受控范围内保存' : '佐证数据包已导出')
  }
  const exportResults = () => run('results', async () => {
    saveJson(await api<unknown>(path('results')), `${fileBase}_结构化结果.json`)
  }, '结构化结果已导出')

  const openEvidence = () => {
    setIncludeOriginals(false)
    setAcknowledged(false)
    setEvidenceOpen(true)
  }

  const waiting = task.running ? '任务正在分析，完成后再导出' : ''
  const singleReason = waiting || (scope.length !== 1
    ? '请只勾选一名人员'
    : scope[0].report_ready ? '' : `暂不能导出：${scope[0].report_blockers.join('；') || '尚未完成人工复核'}`)
  const packageReason = waiting || (!scope.length ? '本任务还没有可导出的人员' : ready.length ? '' : '所选人员均未完成人工复核，暂不能导出正式报告')
  const comparisonReason = waiting || (scope.length < 2 ? '对比报告需要至少两名人员' : '')
  const dataReason = waiting || (!scope.length ? '本任务还没有可导出的人员' : '')

  const button = (kind: ExportKind, label: string, reason: string, onClick: () => void, primary = false): ReactNode => (
    <Tooltip title={reason} key={kind}>
      <Button
        type={primary ? 'primary' : 'default'} icon={<DownloadOutlined />} loading={busy === kind}
        disabled={Boolean(reason) || (busy !== '' && busy !== kind)} onClick={onClick}
      >
        {label}
      </Button>
    </Tooltip>
  )

  return (
    <Card className="section-card matching-export" title="匹配报告与导出" size="small">
      <div className="matching-export-scope">
        {task.running ? <Typography.Text strong>任务正在分析，完成后才能导出</Typography.Text> : (
          <>
            <Typography.Text strong>
              {chosen.length ? `导出范围：已勾选的 ${chosen.length} 人` : `导出范围：本任务全部 ${people.length} 人（在下方表格勾选可只导出部分人员）`}
            </Typography.Text>
            <Typography.Text type="secondary">其中 {ready.length} 人已完成人工复核，可导出正式报告</Typography.Text>
          </>
        )}
      </div>
      <div className="matching-export-group">
        <span className="matching-export-label">正式报告</span>
        <Space size={[8, 8]} wrap>
          {button('single', '导出单人正式报告', singleReason, () => void exportSingle(), true)}
          {button('package', '导出报告包', packageReason, () => blocked.length ? setConfirmPackage(true) : void exportPackage(), true)}
          {button('comparison', '导出多人对比报告', comparisonReason, () => void exportComparison())}
        </Space>
      </div>
      <div className="matching-export-group">
        <span className="matching-export-label">数据留存</span>
        <Space size={[8, 8]} wrap>
          {button('sheet', '导出审核明细表（CSV）', waiting, () => void exportSheet())}
          {button('evidence', '导出佐证数据包（ZIP）', dataReason, openEvidence)}
          {button('results', '导出结构化结果（JSON）', waiting, () => void exportResults())}
        </Space>
      </div>
      <Typography.Paragraph type="secondary" className="matching-note">
        正式报告只能在人工复核完成后导出；多人对比报告可以包含未复核人员，报告中会标明其状态。结构化结果始终包含本任务全部人员。
      </Typography.Paragraph>

      <Modal
        title="部分人员暂不能导出正式报告" open={confirmPackage} onCancel={() => setConfirmPackage(false)}
        okText={`导出 ${ready.length} 人的报告包`} cancelText="取消" onOk={() => void exportPackage()}
      >
        <Typography.Paragraph>
          导出范围内共 {scope.length} 人，其中 {ready.length} 人可导出正式报告，{blocked.length} 人暂不能导出。
          报告包只包含可导出的人员，未导出的原因会写入包内的“审核摘要.csv”。
        </Typography.Paragraph>
        <ul className="matching-text-list">
          {blocked.map(row => (
            <li key={row.candidate_id} className="evidence-text">
              <strong>{personName(row)}</strong>：{row.report_blockers.join('；') || '尚未完成人工复核'}
            </li>
          ))}
        </ul>
      </Modal>

      <Modal
        title="导出佐证数据包" open={evidenceOpen} onCancel={() => setEvidenceOpen(false)}
        okText={includeOriginals ? '确认导出（含原始简历）' : '导出佐证数据包'} cancelText="取消"
        okButtonProps={{ disabled: includeOriginals && !acknowledged, danger: includeOriginals }}
        onOk={() => void exportEvidence()}
      >
        <Typography.Paragraph>
          佐证数据包用于申诉处理和归档，包含：岗位标准、各维度评分与判断依据、硬性条件核验、人工结论、送入模型分析的脱敏材料、已导出的报告和本任务的操作记录。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary">
          {chosen.length ? `导出范围：已勾选的 ${chosen.length} 人` : `导出范围：本任务全部 ${people.length} 人`}
        </Typography.Paragraph>
        <Checkbox checked={includeOriginals} onChange={event => { setIncludeOriginals(event.target.checked); setAcknowledged(false) }}>
          包含原始简历（含未脱敏个人信息）
        </Checkbox>
        {includeOriginals && (
          <Alert
            className="section-row" type="warning" showIcon message="原始简历含未脱敏的个人信息"
            description={(
              <>
                <p className="matching-confirm-text">
                  原始简历中有姓名、手机号、身份证号、住址等未经脱敏的个人信息。仅在申诉处理或归档确有需要时导出，
                  并在受控范围内保存和传递；本次导出会记入审计日志。
                </p>
                <Checkbox checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)}>
                  我已知悉，确有需要导出原始简历
                </Checkbox>
              </>
            )}
          />
        )}
      </Modal>
    </Card>
  )
}
