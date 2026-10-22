import { CopyOutlined, DesktopOutlined, PlusOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Checkbox, Form, InputNumber, Modal, Popconfirm, Space, Table, Tag, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, send } from '../../api'
import { formatTime } from '../../lib/format'
import { onsiteLink } from '../candidate/onsiteEntry'
import { OnsiteLaunchModal } from './OnsiteLaunch'
import { copyText, errorMessage, type Batch } from './shared'

interface OnsiteEntry {
  id: number
  batch_id: number
  created_by: string
  consent_attested: boolean
  created_at: string
  expires_at: string
  revoked_at: string | null
  active: boolean
}

interface CreatedEntry extends OnsiteEntry {
  /** 入口凭证只在开启时返回一次。 */
  entry_token: string
}

// 固定列的宽度；文字列平分其余宽度，每列至少 textMin，屏幕更窄时才横向滚动。
const COLUMNS = { state: 88, expires: 150, actions: 100, textMin: 140 }

function entryState(entry: OnsiteEntry): { label: string; color: string } {
  if (entry.revoked_at) return { label: '已关闭', color: 'default' }
  return entry.active ? { label: '有效', color: 'green' } : { label: '已过期', color: 'orange' }
}

/**
 * 现场面试（线下集中面试）的入口：候选人在现场设备上选择本人后直接进入面试，不需要账号密码。
 * 现场设备就是正在使用的这台时，直接“在本机打开”；是另一台设备时，生成链接拿到那台设备上打开。
 */
export function OnsiteEntries({ batch }: { batch: Pick<Batch, 'id' | 'name'> }) {
  const [entries, setEntries] = useState<OnsiteEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [created, setCreated] = useState<{ link: string; entry: OnsiteEntry } | null>(null)
  const [closingId, setClosingId] = useState<number>()
  const [launching, setLaunching] = useState(false)
  const [form] = Form.useForm<{ hours: number; consent_attested: boolean }>()
  const request = useRef(0)
  const lock = useRef(false)

  const load = useCallback(async () => {
    const current = ++request.current
    setLoading(true)
    try {
      const data = await api<OnsiteEntry[]>(`/batches/${batch.id}/onsite-entries`)
      if (request.current === current) { setEntries(data); setError('') }
    } catch (e) {
      if (request.current === current) setError(errorMessage(e))
    } finally {
      if (request.current === current) setLoading(false)
    }
  }, [batch.id])

  useEffect(() => {
    setEntries([])
    setCreated(null)
    void load()
  }, [load])

  const create = async () => {
    if (lock.current) return
    lock.current = true
    const values = await form.validateFields().catch(() => null)
    if (!values) {
      lock.current = false
      return
    }
    setSaving(true)
    setFormError('')
    try {
      const result = await send<CreatedEntry>(`/batches/${batch.id}/onsite-entries`, 'POST', {
        consent_attested: !!values.consent_attested,
        hours: values.hours,
      })
      const { entry_token: token, ...entry } = result
      setCreated({ link: onsiteLink(token), entry })
      setFormOpen(false)
      await load()
    } catch (e) {
      setFormError(errorMessage(e))
    } finally {
      lock.current = false
      setSaving(false)
    }
  }

  const close = async (entry: OnsiteEntry) => {
    setClosingId(entry.id)
    try {
      await send(`/onsite-entries/${entry.id}`, 'DELETE')
      message.success('现场入口已关闭')
      await load()
    } catch (e) {
      message.error(errorMessage(e))
    } finally {
      setClosingId(undefined)
    }
  }

  const copyLink = async () => {
    if (!created) return
    if (await copyText(created.link)) message.success('入口链接已复制')
    else message.warning('未能自动复制，请手动选中链接后复制')
  }

  const columns: ColumnsType<OnsiteEntry> = [
    { title: '状态', key: 'state', width: COLUMNS.state, render: (_, entry) => { const state = entryState(entry); return <Tag color={state.color}>{state.label}</Tag> } },
    {
      title: '开启人', dataIndex: 'created_by', render: (value: string, entry) => (
        <>
          <div className="evidence-text">{value}</div>
          <Typography.Text type="secondary">{formatTime(entry.created_at)} 开启</Typography.Text>
        </>
      ),
    },
    { title: '是否已现场告知', dataIndex: 'consent_attested', render: (value: boolean) => <div className="evidence-text">{value ? '是，候选人不再阅读合规须知' : '否，候选人在设备上阅读并同意'}</div> },
    { title: '到期时间', dataIndex: 'expires_at', width: COLUMNS.expires, render: (value: string) => formatTime(value) },
    {
      title: '操作', key: 'actions', width: COLUMNS.actions, render: (_, entry) => entry.active && !entry.revoked_at ? (
        <Popconfirm
          title="确认关闭这个现场入口？"
          description="关闭后现场设备不能再用它选择候选人；已经开始的面试不受影响。"
          okText="确认关闭"
          cancelText="取消"
          onConfirm={() => void close(entry)}
        >
          <Button danger type="link" size="small" loading={closingId === entry.id}>关闭入口</Button>
        </Popconfirm>
      ) : null,
    },
  ]

  return (
    <Card
      className="section-row"
      title="现场面试入口"
      extra={(
        <Space wrap>
          <Button type="primary" icon={<DesktopOutlined />} onClick={() => setLaunching(true)}>在本机打开现场面试</Button>
          <Button icon={<PlusOutlined />} onClick={() => { setFormError(''); setFormOpen(true) }}>生成入口链接</Button>
        </Space>
      )}
    >
      <Typography.Paragraph type="secondary">
        线下集中面试时使用：候选人在现场设备（会议室的智慧屏、投屏的电脑或平板）上选择本人后，直接进入设备检测和面试，不需要账号密码。
        现场设备就是这台时点“在本机打开现场面试”；是另一台设备时点“生成入口链接”，把链接拿到那台设备的浏览器中打开。
        也可以在“候选人管理”中对某位候选人直接点“现场面试”。
      </Typography.Paragraph>
      {error &&<Alert className="page-alert" type="error" showIcon message="未能读取现场入口" description={error} action={<Button size="small" onClick={() => void load()}>重新读取</Button>} />}
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={entries}
        loading={loading}
        pagination={false}
        scroll={{ x: COLUMNS.state + COLUMNS.expires + COLUMNS.actions + 2 * COLUMNS.textMin }}
        locale={{ emptyText: '还没有开启过现场入口' }}
      />
      {formOpen && (
        <Modal
          open
          title={`生成入口链接 · ${batch.name}`}
          okText="生成链接"
          cancelText="取消"
          confirmLoading={saving}
          onOk={() => void create()}
          onCancel={() => { if (!lock.current) setFormOpen(false) }}
          destroyOnHidden
        >
          {formError && <Alert type="error" showIcon message="入口链接未生成" description={formError} />}
          <Form form={form} preserve={false} layout="vertical" className="modal-form" initialValues={{ hours: 8, consent_attested: false }}>
            <Form.Item name="hours" label="有效时长（小时）" extra="到期后入口自动失效，可填 1 至 72 小时。" rules={[{ required: true, message: '请填写有效时长' }]}>
              <InputNumber min={1} max={72} precision={0} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="consent_attested"
              valuePropName="checked"
              extra="勾选后，候选人在设备上不再阅读合规须知，由您确认已在现场告知并取得同意，该确认会记录在您的名下。"
            >
              <Checkbox>已在现场向候选人告知采集事项并取得同意</Checkbox>
            </Form.Item>
          </Form>
        </Modal>
      )}
      {launching && <OnsiteLaunchModal batch={batch} onClose={() => { setLaunching(false); void load() }} />}
      {created && (
        <Modal
          open
          title="入口链接已生成"
          closable={false}
          maskClosable={false}
          keyboard={false}
          footer={<Button type="primary" onClick={() => setCreated(null)}>已保存，关闭</Button>}
        >
          <Alert
            type="warning"
            showIcon
            message="入口链接只显示这一次"
            description="关闭本窗口后无法再次查看。如遗失，请关闭该入口后重新开启。"
          />
          <div className="interview-onsite-link" data-testid="onsite-link">{created.link}</div>
          <Button icon={<CopyOutlined />} onClick={() => void copyLink()}>复制链接</Button>
          <Typography.Paragraph className="interview-onsite-note">
            请在现场面试设备的浏览器中打开这个链接，候选人在设备上选择本人后开始面试。链接有效至 {formatTime(created.entry.expires_at)}。
            {created.entry.consent_attested
              ? '本入口已确认现场告知，候选人进入后不再显示合规须知。'
              : '候选人进入后仍需在设备上阅读并同意合规须知。'}
          </Typography.Paragraph>
        </Modal>
      )}
    </Card>
  )
}
