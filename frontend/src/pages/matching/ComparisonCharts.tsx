import { Card, Col, Empty, Row, Typography } from 'antd'
import { Bar, BarChart, CartesianGrid, Cell, Legend, PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatScore } from '../../lib/format'
import { personName } from './shared'
import type { PersonRow, TaskDetail } from './types'

const COLORS = ['#197465', '#2e74fd', '#c98d58', '#7a5af8', '#e5483f', '#12b58e']
const RADAR_LIMIT = COLORS.length

/** 图表中区分人员（业务简历的姓名多为“待人工确认”）：姓名未确认时用简历文件名，后面带排名。 */
function label(row: PersonRow): string {
  const name = personName(row)
  return row.rank ? `${name}（第${row.rank}名）` : name
}

/**
 * 图表对比：综合匹配度柱状图和各维度得分雷达图。
 * 雷达图比较勾选的人员；没有勾选时比较排名靠前的几人。没有得分的维度留空，不按 0 分画。
 */
export default function ComparisonCharts({ task, selected }: { task: TaskDetail; selected: string[] }) {
  const scored = task.people.filter(row => row.candidate_id && row.total !== null)
  if (task.mode !== 'job_to_people' || scored.length < 2) return null

  const bars = scored.map(row => ({ name: label(row), total: row.total as number }))
  const chosen = scored.filter(row => selected.includes(row.candidate_id as string))
  const compared = (chosen.length >= 2 ? chosen : scored).slice(0, RADAR_LIMIT)
  const dimensions = [...new Set(compared.flatMap(row => (row.dimensions || []).map(item => item.dimension)))]
  const radar = dimensions.map(dimension => {
    const point: Record<string, string | number | null> = { dimension }
    compared.forEach(row => {
      point[row.candidate_id as string] = row.dimensions?.find(item => item.dimension === dimension)?.score ?? null
    })
    return point
  })

  return (
    <Card className="section-card" title="图表对比" extra={<Typography.Text type="secondary">得分由 AI 分析得出，须结合判断依据人工复核</Typography.Text>}>
      <Row gutter={[24, 24]}>
        <Col xs={24} xl={11}>
          <h5 className="matching-subtitle matching-chart-title">综合匹配度</h5>
          <ResponsiveContainer width="100%" height={Math.max(220, bars.length * 40 + 40)}>
            <BarChart data={bars} layout="vertical" margin={{ top: 4, right: 40, bottom: 4, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" domain={[0, 100]} />
              <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 12 }} />
              <Tooltip formatter={value => [formatScore(value as number), '综合匹配度']} />
              <Bar dataKey="total" barSize={18} label={{ position: 'right', formatter: value => formatScore(Number(value)) }}>
                {bars.map(item => <Cell key={item.name} fill="#197465" />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Col>
        <Col xs={24} xl={13}>
          <h5 className="matching-subtitle matching-chart-title">各维度得分</h5>
          {dimensions.length < 3
            ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="评分维度少于 3 个，请在人员详情中查看各维度得分" />
            : (
              <ResponsiveContainer width="100%" height={380}>
                <RadarChart data={radar} outerRadius="68%">
                  <PolarGrid />
                  <PolarAngleAxis dataKey="dimension" tick={{ fontSize: 12 }} />
                  <PolarRadiusAxis angle={90} domain={[0, 100]} tick={{ fontSize: 11 }} />
                  {compared.map((row, index) => (
                    <Radar key={row.candidate_id} name={label(row)} dataKey={row.candidate_id as string}
                      stroke={COLORS[index]} fill={COLORS[index]} fillOpacity={0.08} connectNulls={false} />
                  ))}
                  <Tooltip formatter={value => (value === null || value === undefined ? '未形成得分' : formatScore(value as number))} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                </RadarChart>
              </ResponsiveContainer>
            )}
          <Typography.Paragraph type="secondary" className="matching-note">
            {chosen.length >= 2
              ? `比较已勾选的 ${compared.length} 人${chosen.length > RADAR_LIMIT ? `（最多同时比较 ${RADAR_LIMIT} 人）` : ''}。`
              : `比较排名前 ${compared.length} 人；在下方表格勾选 2 至 ${RADAR_LIMIT} 人可以指定比较对象。`}
          </Typography.Paragraph>
        </Col>
      </Row>
    </Card>
  )
}

/** 适岗矩阵单元格的底色：得分越高颜色越深，只用浅色，保证文字清晰。 */
export function heatColor(total: number | null | undefined): string | undefined {
  if (total === null || total === undefined) return undefined
  const ratio = Math.max(0, Math.min(100, total)) / 100
  return `rgba(25, 116, 101, ${(0.04 + ratio * 0.24).toFixed(3)})`
}
