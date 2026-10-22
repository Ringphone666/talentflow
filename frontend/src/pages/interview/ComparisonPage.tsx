import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Empty, Select, Space, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api, download } from '../../api'
import { HardIndicators, HardIndicatorSummary, type HardIndicatorData } from '../../components/HardIndicators'
import { AiNotice, PageHeader } from '../../components/PageHeader'
import { StatusTag } from '../../components/StatusTag'
import { can, useAdminSession } from '../../lib/access'
import { formatScore } from '../../lib/format'
import { scoreText } from './reportParts'
import { BatchSelect, CandidateName, errorMessage, useBatchParam, useBatches, type CandidateRef } from './shared'
import './interview.css'

interface ComparisonItem {
  /** 没有AI面试报告（例如仅人工面试的候选人）时为空。 */
  report_id: number | null
  candidate: CandidateRef
  status: string
  match_score: number | null
  scores: Record<string, number | null>
  risks: string[]
  hard_indicators: HardIndicatorData
  stage_two: { status: string; evidence_count: number; findings: Array<{ dimension: string; status: string }> } | null
}

interface ComparisonData {
  items: ComparisonItem[]
  default_selected: number[]
  /** 大于 0 时默认只选中匹配度最高的若干人。 */
  default_limit: number
  notice: string
  /** 同批次中还没有任何报告、无法参与对比的候选人。 */
  without_report?: Array<{ id: number; code: string; name: string; interview_status: string; report_status: string }>
}

interface ChartRow { id: number; name: string; code: string; scores: Record<string, number | null> }

// 六个评价维度各用一种颜色（按维度固定，不随候选人的增减变化）；已做色觉障碍可辨性校验。
const DIMENSION_COLORS = ['#108a73', '#2f73e8', '#cf925d', '#7a5af8', '#e87ba4', '#eda100']
const EXTRA_COLOR = '#9aa5a2'
const CANDIDATE_WIDTH = 120
const MATCH = '匹配度'
// 固定列的宽度；其余列平分剩余宽度，屏幕更窄时才横向滚动。
const SCORE_COLUMNS = { candidate: 140, match: 92, report: 132, dimensionMin: 84 }
const DETAIL_COLUMNS = { candidate: 140, hard: 190, evidence: 220, riskMin: 300 }
const findingColors: Record<string, string> = { 证据不足: 'warning', 存在差异待核实: 'orange', 新增证据待复核: 'processing' }
const missing = (value: number | null | undefined): value is null | undefined => value === null || value === undefined

function ScoreTooltip({ row, dimensions }: { row?: ChartRow; dimensions: string[] }) {
  if (!row) return null
  return (
    <div className="interview-chart-tooltip">
      <div className="interview-chart-tooltip-title">{row.name}（{row.code}）</div>
      {dimensions.map((dimension, index) => (
        <div className="interview-chart-tooltip-row" key={dimension}>
          <span className="interview-chart-key" style={{ background: DIMENSION_COLORS[index] || EXTRA_COLOR }} />
          <span>{dimension}</span>
          <strong>{scoreText(row.scores[dimension])}</strong>
        </div>
      ))}
    </div>
  )
}

function ScoreChart({ items, dimensions }: { items: ComparisonItem[]; dimensions: string[] }) {
  const rows: ChartRow[] = items.map(item => ({ id: item.candidate.id, name: item.candidate.name, code: item.candidate.code, scores: item.scores }))
  return (
    <div className="interview-chart-scroll">
      <div style={{ minWidth: items.length * CANDIDATE_WIDTH + 80 }}>
        <ResponsiveContainer width="100%" height={400}>
          <BarChart data={rows} margin={{ top: 16, right: 16, bottom: 8, left: 0 }} barCategoryGap="24%" barGap={2}>
            <CartesianGrid vertical={false} stroke="#e5e5e5" />
            <XAxis dataKey="name" interval={0} tickLine={false} axisLine={{ stroke: '#d9d9d9' }} tick={{ fill: '#394b47', fontSize: 12 }} />
            <YAxis domain={[0, 5]} ticks={[0, 1, 2, 3, 4, 5]} allowDecimals={false} width={32} tickLine={false} axisLine={false} tick={{ fill: '#666666', fontSize: 12 }} />
            <Tooltip cursor={{ fill: 'rgba(25, 116, 101, .06)' }} content={props => <ScoreTooltip row={props.active ? props.payload?.[0]?.payload as ChartRow | undefined : undefined} dimensions={dimensions} />} />
            <Legend
              iconType="rect"
              iconSize={10}
              // 图例按评价维度的固定顺序排列，与柱的顺序一致（默认会按名称排序）。
              itemSorter={item => dimensions.indexOf(String(item.value))}
              formatter={value => <span style={{ color: '#394b47' }}>{value}</span>}
            />
            {dimensions.map((dimension, index) => (
              <Bar
                key={dimension}
                name={dimension}
                dataKey={(row: ChartRow) => row.scores[dimension] ?? null}
                fill={DIMENSION_COLORS[index] || EXTRA_COLOR}
                radius={[4, 4, 0, 0]}
                maxBarSize={18}
                // 0 分显示为贴近基线的短柱；没有评分（证据不足）不画柱。
                minPointSize={value => value === 0 ? 3 : 0}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

export default function ComparisonPage() {
  const session = useAdminSession()
  const [batchId, setBatchId] = useBatchParam()
  const { batches, loading: batchesLoading, error: batchesError } = useBatches()
  const [data, setData] = useState<ComparisonData | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [sortBy, setSortBy] = useState(MATCH)
  const [expanded, setExpanded] = useState<number[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const request = useRef(0)
  const canOpenReport = can(session, 'report:read')

  const load = useCallback(async (keepSelection: boolean) => {
    if (!batchId) return
    const current = ++request.current
    setLoading(true)
    try {
      const result = await api<ComparisonData>(`/comparison?batch_id=${batchId}`)
      if (request.current !== current) return
      setData(result)
      setLoadError('')
      // 进入批次时默认选中该批次的全部候选人；刷新时保留已调整的选择。
      setSelected(previous => keepSelection ? previous.filter(id => result.items.some(item => item.candidate.id === id)) : result.default_selected)
    } catch (error) {
      if (request.current === current) setLoadError(errorMessage(error))
    } finally {
      if (request.current === current) setLoading(false)
    }
  }, [batchId])

  useEffect(() => {
    request.current += 1
    setData(null)
    setSelected([])
    setExpanded([])
    setSortBy(MATCH)
    setLoadError('')
    setExportError('')
    setLoading(false)
    void load(false)
  }, [load])

  const items = useMemo(() => data?.items || [], [data])
  const dimensions = useMemo(() => [...new Set(items.flatMap(item => Object.keys(item.scores)))], [items])
  const valueOf = useCallback((item: ComparisonItem) => sortBy === MATCH ? item.match_score : item.scores[sortBy], [sortBy])
  // 两张表和图使用同一顺序：按所选指标从高到低，没有分数的排在最后。
  const ordered = useMemo(() => [...items].sort((a, b) => (valueOf(b) ?? -1) - (valueOf(a) ?? -1) || a.candidate.code.localeCompare(b.candidate.code)), [items, valueOf])
  const chosen = useMemo(() => ordered.filter(item => selected.includes(item.candidate.id)), [ordered, selected])
  const scored = chosen.filter(item => Object.values(item.scores).some(score => !missing(score)))
  const confirmed = chosen.filter(item => item.status === 'confirmed')
  const missingScores = scored.some(item => dimensions.some(dimension => missing(item.scores[dimension])))
  const withoutReport = data?.without_report || []
  const batchKnown = batches.some(batch => batch.id === batchId)

  const exportWord = async () => {
    if (!batchId || exporting) return
    setExporting(true)
    setExportError('')
    try {
      await download(`/comparison/export?batch_id=${batchId}&candidate_ids=${chosen.map(item => item.candidate.id).join(',')}`, '候选人对比.docx')
    } catch (error) {
      setExportError(errorMessage(error))
    } finally {
      setExporting(false)
    }
  }
  const toggle = (id: number) => setExpanded(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])

  const scoreColumns: ColumnsType<ComparisonItem> = [
    { title: '候选人', key: 'candidate', width: SCORE_COLUMNS.candidate, render: (_, item) => <CandidateName candidate={item.candidate} /> },
    {
      title: MATCH, dataIndex: 'match_score', width: SCORE_COLUMNS.match,
      render: (value: number | null) => missing(value) ? <Typography.Text type="secondary">未评分</Typography.Text> : <strong className="match-score">{formatScore(value)}%</strong>,
    },
    ...dimensions.map(dimension => ({
      title: dimension, key: dimension,
      render: (_: unknown, item: ComparisonItem) => missing(item.scores[dimension]) ? <Tag color="warning">证据不足</Tag> : scoreText(item.scores[dimension]),
    })),
    {
      title: 'AI面试报告', key: 'report', width: SCORE_COLUMNS.report, render: (_, item) => (
        <>
          <StatusTag kind="report" value={item.status} />
          {canOpenReport && item.report_id && <div><Link to={`/ai-interview/reports?batch=${batchId}&report=${item.report_id}`}>查看报告</Link></div>}
        </>
      ),
    },
  ]
  const detailColumns: ColumnsType<ComparisonItem> = [
    { title: '候选人', key: 'candidate', width: DETAIL_COLUMNS.candidate, render: (_, item) => <CandidateName candidate={item.candidate} /> },
    {
      title: '硬指标', key: 'hard', width: DETAIL_COLUMNS.hard, render: (_, item) => (
        <>
          <HardIndicatorSummary data={item.hard_indicators} />
          <div className="interview-cell-actions">
            <Button type="link" size="small" aria-expanded={expanded.includes(item.candidate.id)} onClick={() => toggle(item.candidate.id)}>
              {expanded.includes(item.candidate.id) ? '收起硬指标明细' : '查看硬指标明细'}
            </Button>
          </div>
        </>
      ),
    },
    {
      title: '人工面试证据', key: 'stage_two', width: DETAIL_COLUMNS.evidence, render: (_, item) => item.stage_two ? (
        <Space direction="vertical" size={4}>
          <span>{item.stage_two.evidence_count} 段 <StatusTag kind="report" value={item.stage_two.status} /></span>
          <Space size={[4, 4]} wrap>
            {item.stage_two.findings.map((finding, index) => <Tag key={`${finding.dimension}-${index}`} color={findingColors[finding.status] || 'default'}>{finding.dimension} · {finding.status}</Tag>)}
          </Space>
          {canOpenReport && <Link to={`/ai-interview/reports?type=comprehensive&batch=${batchId}&candidate=${item.candidate.id}`}>查看综合报告</Link>}
        </Space>
      ) : <Typography.Text type="secondary">暂无综合报告</Typography.Text>,
    },
    {
      title: '风险提示', key: 'risks', render: (_, item) => item.risks.length
        ? <ul className="interview-risk-list">{item.risks.map((risk, index) => <li key={index} className="evidence-text">{risk}</li>)}</ul>
        : <Typography.Text type="secondary">暂无</Typography.Text>,
    },
  ]

  return (
    <>
      <PageHeader
        title="候选人对比"
        description="按批次对比候选人的六维评分、硬指标、人工面试证据和风险提示。"
        actions={
          <Space wrap>
            <BatchSelect batches={batches} value={batchId} onChange={setBatchId} loading={batchesLoading} label="选择对比批次" placeholder="请选择招聘批次" />
            <AiNotice />
          </Space>
        }
      />
      {batchesError && <Alert className="page-alert" type="error" showIcon message="未能读取招聘批次" description={batchesError} />}
      <Alert className="page-alert strong-notice" type="warning" showIcon message={data?.notice || '对比结果仅供人工初筛参考，不构成自动录用或淘汰决定。'} />
      {loadError && <Alert className="page-alert" type="error" showIcon message="未能读取对比数据" description={loadError} action={<Button size="small" onClick={() => void load(true)}>重新读取</Button>} />}
      {withoutReport.length > 0 && (
        <Alert
          className="page-alert"
          type="info"
          showIcon
          message={`本批次另有 ${withoutReport.length} 人尚无报告，未参与对比`}
          description={
            <ul className="interview-without-report">
              {withoutReport.map(person => (
                <li key={person.id}>
                  <span>{person.name}（{person.code}）</span>
                  <StatusTag kind="interview" value={person.interview_status} />
                  {person.interview_status !== 'not_required' && <StatusTag kind="report" value={person.report_status} />}
                </li>
              ))}
            </ul>
          }
        />
      )}
      {!batchId || (!batchesLoading && !batchKnown && !data) ? (
        <Card><Empty description={batchId && !batchesLoading ? '没有找到这个批次，请重新选择招聘批次' : '请先选择招聘批次'} /></Card>
      ) : !data ? (
        <Card loading={!loadError}>{loadError && <Empty description="对比数据读取失败" />}</Card>
      ) : !items.length ? (
        <Card><Empty description="该批次还没有已生成报告的候选人" /></Card>
      ) : (
        <>
          <Card title="对比范围">
            <div className="interview-comparison-filters">
              <div>
                <span className="interview-comparison-label">参与对比的候选人（已选 {chosen.length} / {items.length} 人）</span>
                <Select<number[]>
                  mode="multiple"
                  aria-label="选择对比候选人"
                  placeholder="请选择候选人"
                  value={selected}
                  onChange={setSelected}
                  optionFilterProp="label"
                  maxTagCount="responsive"
                  options={ordered.map(item => ({ value: item.candidate.id, label: `${item.candidate.name} · ${item.candidate.code}` }))}
                />
              </div>
              <div>
                <span className="interview-comparison-label">排序（从高到低）</span>
                <Select<string> aria-label="排序指标" value={sortBy} onChange={setSortBy} options={[MATCH, ...dimensions].map(value => ({ value, label: value }))} />
              </div>
              <Space wrap className="interview-comparison-actions">
                <Button onClick={() => setSelected(items.map(item => item.candidate.id))} disabled={chosen.length === items.length}>全选</Button>
                <Button onClick={() => setSelected([])} disabled={!chosen.length}>清空</Button>
                <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load(true)}>刷新</Button>
                <Button type="primary" icon={<DownloadOutlined />} loading={exporting} disabled={!confirmed.length} onClick={() => void exportWord()}>导出对比结果 (Word)</Button>
              </Space>
            </div>
            <Typography.Paragraph className="interview-comparison-note">
              {data.default_limit > 0
                ? `进入批次时默认选中匹配度最高的前 ${data.default_limit} 人，可以自行增减。`
                : '进入批次时默认选中该批次的全部候选人，可以自行增减。'}
              导出只包含AI面试报告已人工确认的候选人：所选 {chosen.length} 人中有 {confirmed.length} 人可以导出{chosen.length && !confirmed.length ? '，请先在面试报告中完成人工确认' : ''}。
            </Typography.Paragraph>
            {exportError && <Alert className="section-row" type="error" showIcon message="导出未完成" description={exportError} />}
          </Card>
          {!chosen.length ? (
            <Card className="section-row"><Empty description="请选择要对比的候选人" /></Card>
          ) : (
            <>
              <Card title="六维评分对比" className="section-row chart-card">
                {scored.length ? (
                  <>
                    <ScoreChart items={scored} dimensions={dimensions} />
                    <Typography.Paragraph className="interview-comparison-note">
                      满分 5 分。没有柱的维度表示证据不足（未评分），不按 0 分绘制；0 分显示为贴近横轴的短柱。
                      {missingScores && '部分候选人的评分维度不全，匹配度不宜直接比较。'}
                      {scored.length < chosen.length && `另有 ${chosen.length - scored.length} 人没有六维评分（未做AI面试或尚未评分），只在下表中列出。`}
                    </Typography.Paragraph>
                  </>
                ) : <Empty description="所选候选人暂无六维评分" />}
              </Card>
              <Card title="六维评分与匹配度" className="section-row">
                <Table
                  className="interview-comparison-table"
                  rowKey={item => item.candidate.id}
                  columns={scoreColumns}
                  dataSource={chosen}
                  loading={loading}
                  pagination={false}
                  scroll={{ x: SCORE_COLUMNS.candidate + SCORE_COLUMNS.match + SCORE_COLUMNS.report + dimensions.length * SCORE_COLUMNS.dimensionMin }}
                />
              </Card>
              <Card title="硬指标、人工面试证据与风险提示" className="section-row">
                <Typography.Paragraph className="interview-report-note">硬指标来自简历档案，与六维评分分开展示，不计入评分。</Typography.Paragraph>
                <Table
                  className="interview-comparison-table"
                  rowKey={item => item.candidate.id}
                  columns={detailColumns}
                  dataSource={chosen}
                  loading={loading}
                  pagination={false}
                  scroll={{ x: DETAIL_COLUMNS.candidate + DETAIL_COLUMNS.hard + DETAIL_COLUMNS.evidence + DETAIL_COLUMNS.riskMin }}
                  expandable={{
                    expandedRowKeys: expanded,
                    showExpandColumn: false,
                    expandedRowRender: item => <HardIndicators data={item.hard_indicators} />,
                  }}
                />
              </Card>
            </>
          )}
        </>
      )}
    </>
  )
}
