import { Alert, Descriptions, Empty, Space, Table, Tag, Typography } from 'antd'
import { Link } from 'react-router-dom'
import { formatScore } from '../lib/format'

export interface ProfileField {
  key: string
  label: string
  value: string
  status: string
  source_file?: string
  location?: string
}

export interface HardCheck {
  condition: string
  status: string
  evidence: string
  source: string
}

export interface HardIndicatorData {
  available: boolean
  reason: string
  facts: ProfileField[]
  hard_checks: HardCheck[]
  matching: { task_id: string; candidate_id: string; total: number | null; conclusion: string; coverage_percent?: number | null } | null
  counted_in_score: boolean
  notice: string
}

const checkColors: Record<string, string> = { 满足: 'green', 不满足: 'red', 无法确认: 'gold' }

export function hardCheckSummary(data?: HardIndicatorData | null): { met: number; unmet: number; unknown: number } {
  const checks = data?.hard_checks || []
  return {
    met: checks.filter(item => item.status === '满足').length,
    unmet: checks.filter(item => item.status === '不满足').length,
    unknown: checks.filter(item => !['满足', '不满足'].includes(item.status)).length,
  }
}

/** 硬指标的一行摘要，用于表格单元格。 */
export function HardIndicatorSummary({ data }: { data?: HardIndicatorData | null }) {
  if (!data?.available) return <Typography.Text type="secondary">{data?.reason || '暂无档案'}</Typography.Text>
  if (!data.hard_checks.length) return <Typography.Text type="secondary">岗位未设置硬性条件</Typography.Text>
  const { met, unmet, unknown } = hardCheckSummary(data)
  return (
    <Space size={4} wrap>
      {met > 0 && <Tag color="green">满足 {met}</Tag>}
      {unmet > 0 && <Tag color="red">不满足 {unmet}</Tag>}
      {unknown > 0 && <Tag color="gold">待核实 {unknown}</Tag>}
    </Space>
  )
}

/** 硬指标：简历档案中可核对的事实，以及岗位硬性条件的核验结果。与面试软性评价分开展示。 */
export function HardIndicators({ data, compact = false }: { data?: HardIndicatorData | null; compact?: boolean }) {
  if (!data) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无硬指标" />
  if (!data.available && !data.facts.length) {
    return <Alert type="info" showIcon message={data.reason || '暂无简历档案'} description="在候选人管理中关联人员库或上传简历后，这里会显示学历、履历和岗位硬性条件的核验结果。" />
  }
  const facts = data.facts.filter(item => item.value)
  return (
    <div className="hard-indicators">
      {!data.available && data.reason && <Alert className="page-alert" type="warning" showIcon message={data.reason} />}
      <Descriptions size="small" column={1} bordered className="hard-facts"
        items={(facts.length ? facts : data.facts).map(item => ({
          key: item.key,
          label: item.label,
          children: item.value
            ? <><div className="evidence-text">{item.value}</div>{item.status !== '已确认' && item.status !== '人工已复核' && <Tag className="fact-status">{item.status}</Tag>}</>
            : <Typography.Text type="secondary">简历中未识别到</Typography.Text>,
        }))}
      />
      {data.hard_checks.length > 0 && (
        <Table
          className="hard-checks"
          size="small"
          rowKey="condition"
          pagination={false}
          dataSource={data.hard_checks}
          columns={[
            { title: '岗位硬性条件', dataIndex: 'condition', render: (value: string) => <div className="evidence-text">{value}</div> },
            { title: '核验', dataIndex: 'status', width: 96, render: (value: string) => <Tag color={checkColors[value] || 'default'}>{value}</Tag> },
            ...(compact ? [] : [{ title: '依据', dataIndex: 'evidence', render: (value: string, row: HardCheck) => <><div className="evidence-text">{value || '—'}</div><Typography.Text type="secondary" className="evidence-source">{row.source}</Typography.Text></> }]),
          ]}
        />
      )}
      {data.matching && (
        <Typography.Paragraph className="hard-matching">
          人岗匹配结果：{data.matching.conclusion}
          {data.matching.total !== null && <>，综合匹配度 <strong>{formatScore(data.matching.total)}</strong></>}
          {' '}<Link to={`/matching/tasks/${data.matching.task_id}?person=${data.matching.candidate_id}`}>查看匹配详情</Link>
        </Typography.Paragraph>
      )}
      <Typography.Paragraph type="secondary" className="hard-notice">{data.notice}</Typography.Paragraph>
    </div>
  )
}
