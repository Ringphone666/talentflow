import { Alert, Space, Tabs } from 'antd'
import { useSearchParams } from 'react-router-dom'
import { AiNotice, PageHeader } from '../../components/PageHeader'
import { ComprehensiveReports } from './ComprehensiveReports'
import { InterviewReports } from './InterviewReports'
import { BatchSelect, useBatchParam, useBatches } from './shared'
import './interview.css'

type ReportType = 'interview' | 'comprehensive'

/**
 * 面试报告：AI面试报告和综合报告在同一页的两个页签中，共用批次筛选。
 * 地址栏参数：type=comprehensive 选中综合报告，batch 为批次，report / candidate 为正在查看的报告。
 */
export default function ReportsPage({ pollIntervalMs }: { pollIntervalMs?: number }) {
  const [params, setParams] = useSearchParams()
  const [batchId, setBatchId] = useBatchParam()
  const { batches, loading, error } = useBatches()
  const type: ReportType = params.get('type') === 'comprehensive' ? 'comprehensive' : 'interview'
  const reportId = Number(params.get('report')) || undefined
  const candidateId = Number(params.get('candidate')) || undefined

  const update = (changes: Record<string, string | undefined>) => setParams(current => {
    const next = new URLSearchParams(current)
    Object.entries(changes).forEach(([key, value]) => {
      if (value) next.set(key, value)
      else next.delete(key)
    })
    return next
  }, { replace: true })
  const show = (next: ReportType, detail: { report?: number; candidate?: number } = {}) => update({
    type: next === 'comprehensive' ? next : undefined,
    report: detail.report ? String(detail.report) : undefined,
    candidate: detail.candidate ? String(detail.candidate) : undefined,
  })

  return (
    <>
      <PageHeader
        title="面试报告"
        description="查看并人工复核AI面试报告和综合报告；报告经人工确认后才能导出。"
        actions={
          <Space wrap>
            <BatchSelect batches={batches} value={batchId} onChange={setBatchId} loading={loading} allowClear label="按批次筛选报告" placeholder="全部批次" />
            <AiNotice />
          </Space>
        }
      />
      {error && <Alert className="page-alert" type="error" showIcon message="未能读取招聘批次" description={error} />}
      <Alert className="page-alert" type="warning" showIcon message="未经人工确认的报告不得导出；系统不输出“录用”或“不录用”结论。" />
      <Tabs
        activeKey={type}
        onChange={key => show(key as ReportType)}
        destroyOnHidden
        items={[
          {
            key: 'interview',
            label: 'AI面试报告',
            children: <InterviewReports batchId={batchId} reportId={type === 'interview' ? reportId : undefined} onOpen={id => show('interview', { report: id })} />,
          },
          {
            key: 'comprehensive',
            label: '综合报告',
            children: (
              <ComprehensiveReports
                batchId={batchId}
                candidateId={type === 'comprehensive' ? candidateId : undefined}
                onOpen={id => show('comprehensive', { candidate: id })}
                onOpenInterviewReport={id => show('interview', { report: id })}
                pollIntervalMs={pollIntervalMs}
              />
            ),
          },
        ]}
      />
    </>
  )
}
