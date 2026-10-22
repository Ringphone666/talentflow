import { ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { Button, Card, Input, Segmented, Select, Space, Table, Tag, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { PageHeader } from '../../components/PageHeader'
import { auditActionLabels, auditDetailLabel, auditTargetLabels } from '../../businessLabels'
import { formatTime } from '../../lib/format'

interface Audit {
  id: string
  source: 'platform' | 'matching'
  source_label: string
  actor: string
  role: string
  role_label: string
  action: string
  target_type: string
  target_id: string
  detail: string
  created_at: string
}

type Source = 'all' | 'platform' | 'matching'

/** 人岗匹配的处理记录本身就是中文名称；平台与AI面试的记录用标识，需要换成中文。 */
function actionLabel(row: Audit) {
  return row.source === 'matching' ? row.action : auditActionLabels[row.action] || row.action
}

function targetLabel(row: Audit) {
  if (row.source === 'matching') return `${row.target_type} ${row.target_id}`
  const target = auditTargetLabels[row.target_type] || '其他业务记录'
  if (row.target_type === 'config') return row.target_id === 'sensitive-rules' ? '敏感内容规则' : row.target_id === 'consent-notice' ? '面试采集告知' : target
  if (row.target_id === 'new') return `新增${target}`
  return row.target_type === 'system' ? target : `${target} ${row.target_id}`
}

export default function AuditsPage() {
  const [rows, setRows] = useState<Audit[]>([])
  const [loading, setLoading] = useState(false)
  const [source, setSource] = useState<Source>('all')
  const [keyword, setKeyword] = useState('')
  const [action, setAction] = useState<string>()
  const load = useCallback(async (nextSource: Source, nextKeyword: string) => {
    setLoading(true)
    try {
      const query = new URLSearchParams({ source: nextSource, limit: '500' })
      if (nextKeyword.trim()) query.set('keyword', nextKeyword.trim())
      setRows(await api<Audit[]>(`/audits?${query}`))
    } catch (error) {
      message.error((error as Error).message)
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load('all', '') }, [load])
  const filtered = useMemo(() => rows.filter(row => !action || row.action === action), [rows, action])
  const columns: ColumnsType<Audit> = [
    { title: '时间', dataIndex: 'created_at', width: 156, render: value => formatTime(value) },
    { title: '模块', dataIndex: 'source_label', width: 120, render: (value, row) => <Tag color={row.source === 'matching' ? 'blue' : 'green'}>{value}</Tag> },
    { title: '操作', key: 'action', width: 180, render: (_, row) => <Tag color={row.action === 'sensitive_content_blocked' || row.action.endsWith('_failed') ? 'error' : 'default'}>{actionLabel(row)}</Tag> },
    { title: '操作人 / 角色', key: 'actor', width: 170, render: (_, row) => <><Typography.Text>{row.actor}</Typography.Text><br /><Typography.Text type="secondary">{row.role_label}</Typography.Text></> },
    { title: '对象', key: 'target', width: 200, render: (_, row) => <span className="evidence-text">{targetLabel(row)}</span> },
    { title: '详情', key: 'detail', render: (_, row) => <div className="evidence-text">{row.source === 'matching' ? row.detail || '—' : auditDetailLabel(row.action, row.detail)}</div> },
  ]
  return (
    <>
      <PageHeader title="审计日志" description="查看人岗匹配和AI面试中关键操作的操作人、对象、时间和内容。" actions={<Button icon={<ReloadOutlined />} onClick={() => void load(source, keyword)}>刷新</Button>} />
      <Card>
        <Space wrap className="table-toolbar">
          <Space wrap>
            <Segmented<Source> value={source} onChange={value => { setSource(value); setAction(undefined); void load(value, keyword) }}
              options={[{ value: 'all', label: '全部' }, { value: 'matching', label: '人岗匹配' }, { value: 'platform', label: '平台与AI面试' }]} />
            <Input.Search allowClear prefix={<SearchOutlined />} placeholder="搜索操作人、对象或详情" value={keyword} onChange={event => setKeyword(event.target.value)}
              onSearch={value => void load(source, value)} style={{ width: 280 }} />
            <Select allowClear showSearch optionFilterProp="label" placeholder="筛选操作" value={action} onChange={setAction} style={{ width: 220 }}
              options={[...new Map(rows.map(row => [row.action, actionLabel(row)])).entries()].map(([value, label]) => ({ value, label }))} />
          </Space>
          <Typography.Text type="secondary">显示最近 {filtered.length} 条记录</Typography.Text>
        </Space>
        <Table rowKey="id" loading={loading} columns={columns} dataSource={filtered} pagination={{ pageSize: 20, showSizeChanger: false }} scroll={{ x: 1100 }} />
      </Card>
    </>
  )
}
