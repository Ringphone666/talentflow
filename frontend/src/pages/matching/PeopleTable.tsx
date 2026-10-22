import { Button, Card, Checkbox, Popconfirm, Segmented, Space, Table, Tag, Tooltip, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useMemo, useState } from 'react'
import { HardIndicatorSummary } from '../../components/HardIndicators'
import type { HardIndicatorData } from '../../components/HardIndicators'
import { StatusTag } from '../../components/StatusTag'
import { formatScore } from '../../lib/format'
import { heatColor } from './ComparisonCharts'
import { DECISION_COLORS } from './ReviewPanel'
import { AnalysisTag, TextList, decisionLabel, nameKnown, personName, readableReason } from './shared'
import type { MatchingAccess } from './shared'
import type { DecisionOption, MatrixCell, MatchingOptions, PersonRow, TaskDetail } from './types'

const REVIEW_STATES = ['待审核', '需重新审核', '通过', '保留', '未通过']

const rowKey = (row: PersonRow) => row.candidate_id || `unparsed:${row.source_filename}`

function Score({ value }: { value: number | null }) {
  return value === null
    ? <Typography.Text type="secondary">未形成得分</Typography.Text>
    : <span className="match-score">{formatScore(value)}</span>
}

/** 硬性条件只显示接口给出的“不满足 / 待核实”项，不推断其余条件的结果。 */
function HardConditions({ row, configured }: { row: PersonRow; configured: boolean }) {
  if (!row.candidate_id) return <Typography.Text type="secondary">—</Typography.Text>
  const failed = row.hard_failed || []
  const unknown = row.hard_unknown || []
  if (!failed.length && !unknown.length) {
    return <Typography.Text type="secondary">{configured ? '无不满足或待核实项' : '岗位未设置硬性条件'}</Typography.Text>
  }
  const data: HardIndicatorData = {
    available: true, reason: '', facts: [], matching: null, counted_in_score: false, notice: '',
    hard_checks: [
      ...failed.map(condition => ({ condition, status: '不满足', evidence: '', source: '' })),
      ...unknown.map(condition => ({ condition, status: '无法确认', evidence: '', source: '' })),
    ],
  }
  return <HardIndicatorSummary data={data} />
}

function Decision({ value, decisions }: { value: string | null | undefined; decisions: DecisionOption[] }) {
  return value && DECISION_COLORS[value]
    ? <Tag color={DECISION_COLORS[value]} className="matching-wrap-tag">{decisionLabel(value, decisions)}</Tag>
    : <Typography.Text type="secondary">未复核</Typography.Text>
}

function MatrixCellView({ cell, preferred, decisions }: { cell?: MatrixCell; preferred: boolean; decisions: DecisionOption[] }) {
  if (!cell) return <div className="matrix-cell"><Typography.Text type="secondary">尚未分析</Typography.Text></div>
  return (
    <div className={`matrix-cell${preferred ? ' preferred' : ''}`} style={{ background: heatColor(cell.total) }}>
      {preferred && <Tag color="green" className="matrix-flag">推荐岗位</Tag>}
      <div><Score value={cell.total} /></div>
      <div className="matrix-conclusion">{cell.conclusion}</div>
      {cell.analysis_status !== '分析完成' && <div><AnalysisTag status={cell.analysis_status} /></div>}
      <div><Decision value={cell.decision} decisions={decisions} /></div>
    </div>
  )
}

function hasDetail(row: PersonRow, fit: boolean): boolean {
  if (!row.candidate_id) return Boolean(row.note)
  return Boolean(
    (!fit && (row.strengths?.length || row.risks?.length || row.hard_failed?.length || row.hard_unknown?.length))
    || (!row.report_ready && row.report_blockers.length) || row.note || (!fit && row.review_comment),
  )
}

/** 表格每人下方的整行说明：优势、风险、报告未就绪原因等长文本完整显示。 */
function RowDetail({ row, fit }: { row: PersonRow; fit: boolean }) {
  const hard = [
    ...(row.hard_failed || []).map(item => `不满足：${item}`),
    ...(row.hard_unknown || []).map(item => `待核实：${item}`),
  ]
  return (
    <div className="matching-row-detail">
      {!fit && row.candidate_id && (
        <>
          <section><h5>主要优势</h5><TextList items={row.strengths} empty="暂无可确认的优势" /></section>
          <section><h5>风险与待核实</h5><TextList items={row.risks} empty="暂无风险提示" /></section>
          {hard.length > 0 && <section><h5>硬性条件</h5><TextList items={hard} /></section>}
        </>
      )}
      {!row.report_ready && row.report_blockers.length > 0 && (
        <section><h5>正式报告暂不能导出的原因</h5><TextList items={row.report_blockers} /></section>
      )}
      {!fit && row.review_comment && <section><h5>复核意见</h5><div className="evidence-text">{row.review_comment}</div></section>}
      {row.note && <section><h5>处理说明</h5><div className="evidence-text">{readableReason(row.note)}</div></section>}
    </div>
  )
}

/** 任务内的人员：岗位选才显示排序表，人才适岗显示人员 × 岗位矩阵。 */
export default function PeopleTable({ task, options, access, selected, removingId, onSelect, onOpen, onRemove }: {
  task: TaskDetail
  options: MatchingOptions | null
  access: MatchingAccess
  selected: string[]
  removingId: string
  onSelect: (ids: string[]) => void
  onOpen: (candidateId: string) => void
  onRemove: (candidateId: string, name: string) => void
}) {
  const fit = task.mode === 'people_to_jobs'
  const [filter, setFilter] = useState('')
  const [hardOnly, setHardOnly] = useState(false)
  const decisions = options ? (fit ? options.fit_decisions : options.decisions) : []
  const counts = useMemo(() => {
    const result: Record<string, number> = {}
    for (const row of task.people) result[row.review_status] = (result[row.review_status] || 0) + 1
    return result
  }, [task.people])
  const hardConfigured = Boolean(task.job_standards[0]?.hard_conditions.length)
  const failedHard = task.people.filter(row => row.hard_failed?.length).length
  // 硬性条件的筛选只改变显示范围，由使用者决定是否启用；不删除人员，也不改变得分和排名。
  const rows = task.people.filter(row => (!filter || row.review_status === filter)
    && (!hardOnly || !row.hard_failed?.length))
  const jobNames = new Map(task.jobs.map(job => [job.id, job.name]))

  // 每一列都给出宽度，合计即表格的最小宽度：窗口较窄时表格横向滚动，姓名和操作固定在两侧，不会把某一列挤窄。
  const name: ColumnsType<PersonRow>[number] = {
    title: '姓名', key: 'name', fixed: 'left', width: 132, render: (_, row) => (
      <>
        {row.candidate_id
          ? <Button type="link" className="matching-name-link" onClick={() => onOpen(row.candidate_id as string)}>{nameKnown(row.name) ? row.name : '姓名待确认'}</Button>
          : <Typography.Text strong>{row.name}</Typography.Text>}
        {/* 姓名还没有确认的人员用简历文件名辨认。 */}
        <Typography.Text type="secondary" className="evidence-source matching-code">{row.candidate_id && nameKnown(row.name) ? row.code : row.source_filename || row.code}</Typography.Text>
      </>
    ),
  }
  const analysis: ColumnsType<PersonRow>[number] = { title: '分析状态', dataIndex: 'analysis_status', width: 112, render: (value: string) => <AnalysisTag status={value} /> }
  const review: ColumnsType<PersonRow>[number] = { title: '审核状态', dataIndex: 'review_status', width: 92, render: (value: string) => <StatusTag kind="review" value={value} /> }
  const report: ColumnsType<PersonRow>[number] = {
    title: '报告', key: 'report', width: 100, render: (_, row) => row.report_ready
      ? <Tag color="green">可导出</Tag>
      : <Tooltip title="原因见本行下方"><Tag className="matching-tag-muted">暂不可导出</Tag></Tooltip>,
  }
  const actions: ColumnsType<PersonRow>[number] = {
    title: '操作', key: 'actions', fixed: 'right', width: access.remove ? 124 : 84, render: (_, row) => row.candidate_id ? (
      <Space size={0}>
        <Button type="link" size="small" onClick={() => onOpen(row.candidate_id as string)}>查看详情</Button>
        {access.remove && (task.running
          ? <Tooltip title="任务正在分析，完成后才能删除"><Button danger type="link" size="small" disabled>删除</Button></Tooltip>
          : (
            <Popconfirm
              title={`确认从本任务中删除 ${personName(row)}？`}
              description="将删除该人员在本任务中的匹配结果、人工复核记录和已生成的报告，不可恢复；人员库中的资料不受影响。"
              okText="删除" cancelText="取消" okButtonProps={{ danger: true }}
              onConfirm={() => onRemove(row.candidate_id as string, personName(row))}
            >
              <Button danger type="link" size="small" loading={removingId === row.candidate_id}>删除</Button>
            </Popconfirm>
          ))}
      </Space>
    ) : <Typography.Text type="secondary">尚未解析</Typography.Text>,
  }

  const rankingColumns: ColumnsType<PersonRow> = [
    { title: '排名', dataIndex: 'rank', width: 52, render: (value: number | null) => value ?? '—' },
    name,
    {
      title: '综合匹配度', dataIndex: 'total', width: 108, sortDirections: ['descend', 'ascend'],
      sorter: (a, b) => (a.total ?? -1) - (b.total ?? -1), render: (value: number | null) => <Score value={value} />,
    },
    { title: '匹配结论', dataIndex: 'conclusion', width: 116 },
    analysis,
    { title: '硬性条件', key: 'hard', width: 112, render: (_, row) => <HardConditions row={row} configured={hardConfigured} /> },
    review,
    { title: '人工结论', dataIndex: 'decision', width: 120, render: (value: string) => <Decision value={value} decisions={decisions} /> },
    report,
    actions,
  ]
  const matrixColumns: ColumnsType<PersonRow> = [
    name,
    {
      title: '推荐岗位', key: 'preferred', width: 128, render: (_, row) => row.preferred_job_id
        ? <Typography.Text strong>{jobNames.get(row.preferred_job_id) || row.preferred_job_id}</Typography.Text>
        : <Typography.Text type="secondary">{row.candidate_id ? '暂无，需先核验材料缺口或硬性条件' : '—'}</Typography.Text>,
    },
    ...task.jobs.map(job => ({
      title: job.name, key: `job:${job.id}`, width: 148,
      render: (_: unknown, row: PersonRow) => row.candidate_id
        ? <MatrixCellView cell={row.matrix?.[job.id]} preferred={row.preferred_job_id === job.id} decisions={decisions} />
        : <Typography.Text type="secondary">—</Typography.Text>,
    })),
    analysis,
    review,
    { title: '已复核岗位', dataIndex: 'reviewed_jobs', width: 92 },
    report,
    actions,
  ]
  const columns = fit ? matrixColumns : rankingColumns
  // 勾选只用于选择导出范围，没有导出权限时不显示勾选列。40 是勾选列的宽度。
  const selectable = access.export
  const tableWidth = (selectable ? 40 : 0) + columns.reduce((sum, column) => sum + Number(column.width || 0), 0)

  const expandable = rows.filter(row => hasDetail(row, fit)).map(rowKey)
  return (
    <Card className="section-card matching-people" size="small" title={fit ? `人员与岗位匹配矩阵（${task.people.length} 人 × ${task.jobs.length} 个岗位）` : `人员排序（${task.people.length} 人）`}>
      <div className="toolbar">
        <Segmented
          aria-label="按审核状态筛选" value={filter} onChange={value => setFilter(String(value))}
          options={[
            { value: '', label: `全部 ${task.people.length}` },
            ...REVIEW_STATES.map(state => ({ value: state, label: `${state} ${counts[state] || 0}` })),
          ]}
        />
        {!fit && hardConfigured && failedHard > 0 && (
          <Checkbox checked={hardOnly} onChange={event => setHardOnly(event.target.checked)}>
            只看没有不满足硬性条件的人员（另有 {failedHard} 人不满足）
          </Checkbox>
        )}
        <Typography.Text type="secondary">
          {fit
            ? '每格依次为综合匹配度、匹配结论和人工结论，底色越深得分越高；各岗位按各自的标准评分。'
            : '按综合匹配度从高到低排列；硬性条件逐项核验，是否据此筛选由复核人决定。'}
        </Typography.Text>
      </div>
      {selectable && selected.length > 0 && (
        <div className="selection-bar">
          <Typography.Text strong>已勾选 {selected.length} 人</Typography.Text>
          <Typography.Text type="secondary">上方的导出按钮只处理已勾选的人员</Typography.Text>
          <Button size="small" onClick={() => onSelect([])}>清空勾选</Button>
        </div>
      )}
      <Table<PersonRow>
        rowKey={rowKey} size="middle" pagination={false} dataSource={rows}
        columns={columns} scroll={{ x: tableWidth }}
        locale={{ emptyText: task.people.length ? '没有符合筛选条件的人员' : task.running ? '正在分析，结果会陆续显示' : '本任务还没有人员记录' }}
        rowSelection={selectable ? {
          selectedRowKeys: selected, preserveSelectedRowKeys: true, fixed: true, columnWidth: 40,
          onChange: keys => onSelect(keys.map(String)),
          getCheckboxProps: row => ({ disabled: !row.candidate_id, name: row.name }),
        } : undefined}
        expandable={{
          showExpandColumn: false, expandedRowKeys: expandable,
          rowExpandable: row => hasDetail(row, fit),
          expandedRowRender: row => <RowDetail row={row} fit={fit} />,
        }}
      />
    </Card>
  )
}
