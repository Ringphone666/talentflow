import { ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Empty, Input, Select, Space, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useEffect, useMemo, useState } from 'react'
import { StatusTag } from '../../../components/StatusTag'
import { ResumeStatusTag } from './labels'
import type { BatchOption, ListeningCandidate } from './types'

interface Props {
  batches: BatchOption[]
  batchesLoading: boolean
  batchId?: number
  candidates: ListeningCandidate[]
  candidatesLoading: boolean
  candidateId?: number
  /** 正在录音或处理中：不能切换批次和候选人。 */
  locked: boolean
  error: string
  onBatchChange: (id: number) => void
  onCandidateChange: (id: number) => void
  onRefresh: () => void
}

function StageOneCell({ candidate }: { candidate: ListeningCandidate }) {
  if (candidate.stage_one) {
    return <Space size={4} wrap><Tag color="green">已有报告</Tag><StatusTag kind="report" value={candidate.stage_one.status} /></Space>
  }
  if (candidate.interview_status === 'not_required') return <Tag>不做AI面试</Tag>
  return <Space size={4} wrap><Tag>暂无报告</Tag><StatusTag kind="interview" value={candidate.interview_status} /></Space>
}

/** 先选招聘批次，再在该批次中选候选人。 */
export function CandidatePicker({ batches, batchesLoading, batchId, candidates, candidatesLoading, candidateId, locked, error, onBatchChange, onCandidateChange, onRefresh }: Props) {
  const [keyword, setKeyword] = useState('')
  const [choosing, setChoosing] = useState(false)
  const batch = batches.find(item => item.id === batchId)
  const current = candidates.find(item => item.id === candidateId)
  useEffect(() => { setKeyword(''); setChoosing(false) }, [batchId])

  const visible = useMemo(() => {
    const text = keyword.trim().toLowerCase()
    return text ? candidates.filter(item => item.name.toLowerCase().includes(text) || item.code.toLowerCase().includes(text)) : candidates
  }, [candidates, keyword])

  const columns: ColumnsType<ListeningCandidate> = [
    { title: '候选人', key: 'candidate', render: (_, row) => <><Typography.Text strong>{row.name}</Typography.Text><br /><Typography.Text type="secondary">{row.code}</Typography.Text></> },
    { title: '第一阶段AI面试', key: 'stage_one', render: (_, row) => <StageOneCell candidate={row} /> },
    { title: '简历', key: 'resume', render: (_, row) => <ResumeStatusTag status={row.resume_status} /> },
    { title: 'AI旁听', key: 'listening', render: (_, row) => <StatusTag kind="listening" value={row.listening_status} /> },
    { title: '综合报告', key: 'comprehensive', render: (_, row) => <StatusTag kind="report" value={row.comprehensive_status} /> },
    {
      title: '操作', key: 'action', width: 120,
      render: (_, row) => row.id === candidateId
        ? <Tag color="green">当前候选人</Tag>
        : <Button type="link" size="small" disabled={locked} aria-label={`选择 ${row.name}`} onClick={() => { setChoosing(false); onCandidateChange(row.id) }}>选择</Button>,
    },
  ]

  const showList = !current || choosing
  return (
    <Card
      title="选择批次和候选人"
      extra={<Button icon={<ReloadOutlined />} disabled={locked} loading={batchesLoading || candidatesLoading} onClick={onRefresh}>刷新</Button>}
    >
      <div className="toolbar">
        <Space wrap size={[12, 8]}>
          <Select
            className="listening-batch-select"
            aria-label="招聘批次"
            showSearch
            optionFilterProp="label"
            placeholder="请选择招聘批次"
            loading={batchesLoading}
            disabled={locked}
            value={batch ? batch.id : undefined}
            onChange={onBatchChange}
            options={batches.map(item => ({ value: item.id, label: `${item.name} · ${item.job_name}` }))}
            notFoundContent={batchesLoading ? '正在读取批次…' : '还没有招聘批次，请先在“批次与题目”中新建'}
          />
          {batch && <Typography.Text type="secondary">{batch.mode_label ? `${batch.mode_label} · ` : ''}候选人 {batch.candidate_count} 人</Typography.Text>}
        </Space>
        {batch && showList && candidates.length > 0 && (
          <Input
            className="listening-candidate-search"
            allowClear
            prefix={<SearchOutlined />}
            placeholder="按姓名或编号查找"
            aria-label="查找候选人"
            value={keyword}
            onChange={event => setKeyword(event.target.value)}
          />
        )}
      </div>
      {error && <Alert className="page-alert" type="error" showIcon message={error} action={<Button size="small" onClick={onRefresh}>重新读取</Button>} />}
      {!batch && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请先选择招聘批次，再选择要旁听的候选人" />}
      {batch && !showList && current && (
        <div className="selection-bar" aria-label="当前候选人">
          <Typography.Text strong>{current.name}</Typography.Text>
          <Typography.Text type="secondary">{current.code}</Typography.Text>
          <StageOneCell candidate={current} />
          <ResumeStatusTag status={current.resume_status} />
          <StatusTag kind="listening" value={current.listening_status} />
          <Button size="small" disabled={locked} onClick={() => setChoosing(true)}>更换候选人</Button>
        </div>
      )}
      {batch && showList && (
        <Table
          rowKey="id"
          size="middle"
          loading={candidatesLoading}
          columns={columns}
          dataSource={visible}
          scroll={{ x: 760 }}
          pagination={visible.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
          locale={{ emptyText: candidates.length ? '没有找到符合条件的候选人' : '本批次还没有候选人，请先在“候选人管理”中添加' }}
        />
      )}
    </Card>
  )
}
