import { Alert, Button, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { formatScore, formatTime } from '../../lib/format'
import { AnalysisTag, EvidenceQuotes, TextList } from './shared'
import type { Assessment, DimensionScore, HardCheckResult } from './types'

const HARD_COLORS: Record<string, string> = { 满足: 'green', 不满足: 'red', 无法确认: 'gold' }
const MODEL_DONE = '调用成功'

const dimensionColumns: ColumnsType<DimensionScore> = [
  { title: '评价维度', dataIndex: 'dimension', render: (value: string) => <Typography.Text strong>{value}</Typography.Text> },
  { title: '岗位权重', dataIndex: 'weight', width: 110, render: (value: number | null) => typeof value === 'number' ? `${formatScore(value)}%` : '—' },
  {
    title: '维度得分', dataIndex: 'score', width: 110, render: (value: number | null) => typeof value === 'number'
      ? <span className="match-score">{formatScore(value)}</span>
      : <Typography.Text type="secondary">未评分</Typography.Text>,
  },
  { title: '计入综合分', dataIndex: 'weighted', width: 120, render: (value: number | null) => formatScore(value, 2) },
  { title: '状态', dataIndex: 'status', width: 110, render: (value: string) => <Tag color={value === '已评估' ? 'green' : 'gold'}>{value}</Tag> },
]

const hardColumns: ColumnsType<HardCheckResult> = [
  { title: '硬性条件', dataIndex: 'condition', width: '30%', render: (value: string) => <div className="evidence-text">{value}</div> },
  { title: '核验结果', dataIndex: 'status', width: 110, render: (value: string) => <Tag color={HARD_COLORS[value] || 'default'}>{value}</Tag> },
  {
    title: '依据与出处', key: 'evidence', render: (_, row) => (
      <>
        <div className="evidence-text">{row.evidence || '—'}</div>
        {row.sources.length > 0 && <EvidenceQuotes items={row.sources} />}
      </>
    ),
  },
]

/** 判断依据单独占一整行显示，不放在窄列里。 */
function DimensionReason({ row }: { row: DimensionScore }) {
  return (
    <div className="matching-reason">
      <div className="matching-reason-label">判断依据</div>
      <div className="evidence-text">{row.reason}</div>
      <div className="matching-reason-label">原文证据</div>
      {row.evidence.length > 0
        ? <EvidenceQuotes items={row.evidence} />
        : <Typography.Text type="secondary">本项没有引用原文证据</Typography.Text>}
    </div>
  )
}

/** 一个岗位的匹配分析：结论、各维度评分与判断依据、硬性条件核验、核验建议。 */
export default function AssessmentView({ assessment, reanalyze }: {
  assessment: Assessment
  /** 有权重新分析且任务空闲时提供。 */
  reanalyze?: { busy: boolean; run: () => void }
}) {
  const model = assessment.model
  const unfinished = Boolean(model.status) && model.status !== MODEL_DONE
  return (
    <div className="matching-assessment">
      {assessment.stale && (
        <Alert
          className="page-alert" type="warning" showIcon message="评分已失效，需要重新分析"
          description={`${assessment.stale_reason || '人员资料或岗位标准已变更'}。下面显示的是上一次分析的结果，重新分析完成后才能复核和导出报告。`}
          action={reanalyze && <Button size="small" type="primary" loading={reanalyze.busy} onClick={reanalyze.run}>重新分析</Button>}
        />
      )}
      {unfinished && (
        <Alert
          className="page-alert" type="warning" showIcon message="AI分析未完成"
          description={`${model.reason || '评分服务没有返回可用结果'}。系统不会用其他方式代替评分；评分服务可用后，请在任务页重试或重新分析。`}
        />
      )}
      <div className="matching-counters">
        <div className="matching-counter emphasis">
          <span>综合匹配度</span>
          {assessment.total === null ? <strong className="matching-counter-text">未形成得分</strong> : <strong>{formatScore(assessment.total)}</strong>}
        </div>
        <div className="matching-counter">
          <span>匹配结论</span>
          <strong className="matching-counter-text">{assessment.conclusion}</strong>
        </div>
        <div className="matching-counter">
          <span>依据覆盖的岗位权重</span>
          <strong>{typeof assessment.coverage_percent === 'number' ? `${formatScore(assessment.coverage_percent)}%` : '—'}</strong>
        </div>
        <div className="matching-counter">
          <span>分析状态</span>
          <div className="matching-counter-tag"><AnalysisTag status={assessment.analysis_status} /></div>
        </div>
      </div>
      <Typography.Paragraph className="evidence-text matching-summary">{assessment.summary}</Typography.Paragraph>
      <Typography.Paragraph type="secondary" className="evidence-text">{assessment.score_note}</Typography.Paragraph>
      {!unfinished && model.reason && <Typography.Paragraph type="secondary" className="evidence-text">分析说明：{model.reason}</Typography.Paragraph>}

      <h5 className="matching-subtitle">各维度评分与判断依据</h5>
      {assessment.dimensions.length ? (
        <Table<DimensionScore>
          className="matching-dimensions" size="small" rowKey="dimension" pagination={false}
          columns={dimensionColumns} dataSource={assessment.dimensions}
          expandable={{
            showExpandColumn: false,
            expandedRowKeys: assessment.dimensions.map(item => item.dimension),
            expandedRowRender: row => <DimensionReason row={row} />,
          }}
        />
      ) : <Typography.Text type="secondary">暂无维度评分</Typography.Text>}

      <h5 className="matching-subtitle">硬性条件核验</h5>
      {assessment.hard_checks.length ? (
        <>
          <Table<HardCheckResult> size="small" rowKey="condition" pagination={false} columns={hardColumns} dataSource={assessment.hard_checks} />
          <Typography.Paragraph type="secondary" className="matching-note">硬性条件只作核验提示，不会筛掉人员，也不计入综合匹配度。</Typography.Paragraph>
        </>
      ) : <Typography.Text type="secondary">该岗位未设置硬性条件</Typography.Text>}

      <div className="matching-lists">
        <section>
          <h5 className="matching-subtitle">关键优势</h5>
          <TextList items={assessment.strengths} empty="暂无可确认的优势" />
        </section>
        <section>
          <h5 className="matching-subtitle">差距与待核实项</h5>
          <TextList items={assessment.gaps} empty="暂无明确差距" />
        </section>
        <section>
          <h5 className="matching-subtitle">风险提示</h5>
          <TextList items={assessment.risks} empty="暂无风险提示" />
        </section>
        <section>
          <h5 className="matching-subtitle">建议核验材料</h5>
          <TextList items={assessment.verification} empty="暂无核验建议" />
        </section>
        <section className="matching-lists-wide">
          <h5 className="matching-subtitle">建议面试问题</h5>
          <TextList items={assessment.questions} empty="完成分析后显示针对性问题" />
        </section>
      </div>
      {assessment.next_step && <Alert className="section-row" type="info" showIcon message="下一步建议" description={<span className="evidence-text">{assessment.next_step}</span>} />}
      <Typography.Paragraph type="secondary" className="matching-note">
        {assessment.evidence_summary}
        {assessment.weight_version && ` · 评分标准版本 ${assessment.weight_version}`}
        {assessment.assessed_at && ` · 分析时间 ${formatTime(assessment.assessed_at)}`}
      </Typography.Paragraph>
    </div>
  )
}
