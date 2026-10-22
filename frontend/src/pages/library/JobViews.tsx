import { Descriptions, Empty, Space, Table, Tag, Typography } from 'antd'
import { formatWeight, weightTotal } from './jobModel'
import type { JobDetail, JobDimension } from './types'

function TextList({ items, empty }: { items: string[]; empty: string }) {
  const rows = items.map(item => item.trim()).filter(Boolean)
  if (!rows.length) return <Typography.Text type="secondary">{empty}</Typography.Text>
  return <ol className="job-text-list">{rows.map((item, index) => <li key={index} className="evidence-text">{item}</li>)}</ol>
}

/** 岗位说明（只读）。 */
export function JobProfileView({ job }: { job: JobDetail }) {
  const extras = Object.entries(job.extra_sections || {})
  return (
    <div className="job-view">
      <Descriptions
        size="small"
        bordered
        column={{ xs: 1, md: 2 }}
        items={[
          { key: 'sequence', label: '序列', children: job.sequence || '—' },
          { key: 'level', label: '层级', children: job.level || '—' },
          { key: 'version', label: '岗位说明书版本', children: job.jd_version || '—' },
          { key: 'id', label: '岗位编号', children: job.id },
          { key: 'scope', label: '适用范围或资料来源', span: 2, children: job.scope ? <div className="evidence-text">{job.scope}</div> : '—' },
        ]}
      />
      <section>
        <Typography.Title level={5}>岗位职责</Typography.Title>
        <TextList items={job.responsibilities} empty="尚未填写岗位职责" />
      </section>
      <section>
        <Typography.Title level={5}>任职要求</Typography.Title>
        <TextList items={job.requirements} empty="尚未填写任职要求" />
      </section>
      <section>
        <Typography.Title level={5}>硬性条件</Typography.Title>
        <TextList items={job.hard_conditions} empty="未设置硬性条件" />
      </section>
      {extras.length > 0 && (
        <section>
          <Typography.Title level={5}>补充信息</Typography.Title>
          <Descriptions
            size="small"
            bordered
            column={1}
            items={extras.map(([name, content]) => ({ key: name, label: name, children: <div className="evidence-text">{String(content)}</div> }))}
          />
        </section>
      )}
    </div>
  )
}

const keywordTags = (words: string[] | undefined) => words?.length
  ? <Space size={[4, 4]} wrap>{words.map(word => <Tag key={word} className="keyword-tag">{word}</Tag>)}</Space>
  : <Typography.Text type="secondary">—</Typography.Text>

/** 能力标签与权重（只读）。 */
export function JobScorecardView({ job }: { job: JobDetail }) {
  if (!job.dimensions.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未设置能力标签" />
  const total = weightTotal(job.dimensions.map(item => ({ weight: item.weight })))
  return (
    <div className="job-view">
      <Table<JobDimension>
        size="small"
        rowKey="name"
        pagination={false}
        dataSource={job.dimensions}
        scroll={{ x: 640 }}
        columns={[
          { title: '能力标签', dataIndex: 'name', width: 180, render: (value: string) => <Typography.Text strong>{value}</Typography.Text> },
          { title: '权重', dataIndex: 'weight', width: 90, render: (value: number) => `${formatWeight(Number(value) || 0)}%` },
          { title: '证据关键词', dataIndex: 'keywords', render: keywordTags },
          { title: '排除关键词', dataIndex: 'negative_keywords', render: keywordTags },
        ]}
      />
      <Typography.Paragraph type="secondary" className="job-view-note">
        权重合计 {formatWeight(total)}% · 权重版本 {job.weight_version || '—'} · 人岗匹配按以上能力标签和权重评分
      </Typography.Paragraph>
    </div>
  )
}
