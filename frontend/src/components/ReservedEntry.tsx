import { ApiOutlined } from '@ant-design/icons'
import { Alert, Button, Descriptions, Modal, Spin, Tag } from 'antd'
import { useState } from 'react'
import { api } from '../api'

interface Integration {
  key: string
  name: string
  target: string
  system: string
  pending: string
  alternative: string
  status: string
  status_label: string
  available: boolean
}

/**
 * 外部系统对接的预留入口（人资招聘系统导入岗位、组织架构选择人员）。
 * 对方接口尚未提供，入口只说明对接状态和目前可用的替代办法，不展示任何模拟数据。
 */
export function ReservedEntry({ integration, label }: { integration: 'recruitment_jobs' | 'organization_persons'; label: string }) {
  const [open, setOpen] = useState(false)
  const [entry, setEntry] = useState<Integration | null>(null)
  const [error, setError] = useState('')
  const show = async () => {
    setOpen(true)
    setError('')
    try {
      const entries = await api<Integration[]>('/library/integrations')
      setEntry(entries.find(item => item.key === integration) || null)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <>
      <Button icon={<ApiOutlined />} onClick={show}>{label}</Button>
      <Modal title={label} open={open} footer={<Button type="primary" onClick={() => setOpen(false)}>知道了</Button>} onCancel={() => setOpen(false)}>
        {error ? <Alert type="error" showIcon message={error} /> : !entry ? <Spin /> : (
          <>
            <Alert type="info" showIcon message="该入口已预留，尚未与对方系统对接" description={entry.pending} />
            <Descriptions className="section-row" size="small" column={1} bordered styles={{ label: { width: 108, whiteSpace: 'nowrap' } }} items={[
              { key: 'system', label: '对接系统', children: entry.system },
              { key: 'target', label: '导入到', children: entry.target },
              { key: 'status', label: '对接状态', children: <Tag color="gold">{entry.status_label}</Tag> },
              { key: 'alternative', label: '目前的办法', children: entry.alternative },
            ]} />
          </>
        )}
      </Modal>
    </>
  )
}
