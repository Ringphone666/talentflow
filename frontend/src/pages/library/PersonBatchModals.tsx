import { Alert, Checkbox, Form, Input, Modal, Select, Typography } from 'antd'
import { useState } from 'react'
import { send } from '../../api'
import { OCR_AUTHORISATION } from './personModel'
import type { PersonBatch, PersonRow } from './types'

interface BatchFormValues {
  name: string
  category: string
}

/** 新建批次，或修改批次的名称和分类。 */
export function BatchFormModal({ batch, categories, onClose, onSaved }: {
  batch: PersonBatch | null
  categories: string[]
  onClose: () => void
  onSaved: (batch: PersonBatch, created: boolean) => void
}) {
  const [form] = Form.useForm<BatchFormValues>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // “未分类”只属于历史数据：新建时不可选；修改历史批次时保留它当前的分类，避免改名时被迫改分类。
  const legacy = batch && !categories.includes(batch.category) ? batch.category : ''
  const options = [
    ...categories.map(item => ({ value: item, label: item })),
    ...(legacy ? [{ value: legacy, label: `${legacy}（历史数据）` }] : []),
  ]

  const save = async () => {
    let values: BatchFormValues
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    setSaving(true)
    setError('')
    try {
      const body = { name: values.name.trim(), category: values.category }
      const saved = batch
        ? await send<PersonBatch>(`/library/person-batches/${batch.id}`, 'PUT', body)
        : await send<PersonBatch>('/library/person-batches', 'POST', body)
      onSaved(saved, !batch)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={batch ? '修改批次名称与分类' : '新建人员批次'}
      open
      maskClosable={false}
      okText={batch ? '保存' : '新建批次'}
      cancelText="取消"
      confirmLoading={saving}
      onOk={() => void save()}
      onCancel={() => { if (!saving) onClose() }}
    >
      {!batch && <Typography.Paragraph type="secondary">先建立批次，再向批次导入简历。批次建好后可用于人岗匹配和AI面试。</Typography.Paragraph>}
      {error && <Alert className="page-alert" type="error" showIcon message={batch ? '保存未完成' : '新建未完成'} description={<div className="evidence-text">{error}</div>} />}
      <Form form={form} name="person-batch" layout="vertical" initialValues={{ name: batch?.name || '', category: batch?.category }} disabled={saving}>
        <Form.Item name="name" label="批次名称" rules={[{ required: true, whitespace: true, message: '请填写批次名称' }, { max: 100, message: '批次名称最多 100 个字' }]}>
          <Input placeholder="例如：2026 年秋季校招第一批" />
        </Form.Item>
        <Form.Item name="category" label="人员分类" rules={[{ required: true, message: '请选择社招、校招或内聘' }]}>
          <Select aria-label="人员分类" placeholder="请选择" options={options} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

/** 删除一个或多个批次。后端拒绝时原样说明原因。 */
export function DeleteBatchesModal({ batches, onClose, onDeleted }: {
  batches: PersonBatch[]
  onClose: () => void
  onDeleted: (result: { deleted_batches: number; deleted_entries: number }) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const persons = batches.reduce((sum, item) => sum + item.total_count, 0)

  const confirm = async () => {
    setBusy(true)
    setError('')
    try {
      onDeleted(await send<{ deleted_batches: number; deleted_entries: number }>('/library/person-batches/delete', 'POST', { batch_ids: batches.map(item => item.id) }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="确认删除人员批次"
      open
      maskClosable={false}
      okText="确认删除"
      cancelText="取消"
      okButtonProps={{ danger: true }}
      confirmLoading={busy}
      onOk={() => void confirm()}
      onCancel={() => { if (!busy) onClose() }}
    >
      <Typography.Paragraph>将删除 {batches.length} 个批次、{persons} 份人员资料：</Typography.Paragraph>
      <ul className="plain-list">
        {batches.map(item => <li key={item.id}>{item.name}（{item.category} · {item.total_count} 人）</li>)}
      </ul>
      <Alert
        className="section-row"
        type="warning"
        showIcon
        message="删除后不可恢复"
        description="已建立的匹配任务及其报告会保留。批次中有人员已关联AI面试候选人、有简历正在解析，或有关联的匹配任务正在处理时不能删除。"
      />
      {error && <Alert className="section-row" type="error" showIcon message="未能删除" description={<div className="evidence-text">{error}</div>} />}
    </Modal>
  )
}

/** 重新解析一份简历。扫描页只有在确认授权后才会发送到文字识别服务。 */
export function RetryModal({ person, busy, progress, error, onClose, onConfirm }: {
  person: PersonRow
  busy: boolean
  progress: string
  error: string
  onClose: () => void
  onConfirm: (allowOcr: boolean) => void
}) {
  const [allowOcr, setAllowOcr] = useState(false)
  return (
    <Modal
      title="重新解析简历"
      open
      maskClosable={false}
      okText="开始重新解析"
      cancelText={busy ? '关闭' : '取消'}
      confirmLoading={busy}
      onOk={() => onConfirm(allowOcr)}
      onCancel={onClose}
    >
      <Typography.Paragraph>
        将重新读取 <Typography.Text strong>{person.source_filename}</Typography.Text> 并提取资料，现有的解析结果会被替换。
      </Typography.Paragraph>
      <Checkbox checked={allowOcr} disabled={busy} onChange={event => setAllowOcr(event.target.checked)}>{OCR_AUTHORISATION}</Checkbox>
      <Typography.Paragraph type="secondary" className="field-hint">简历没有扫描页时无需勾选。未勾选时，扫描页不会发送到文字识别服务，其中的内容无法提取。</Typography.Paragraph>
      {busy && <Typography.Paragraph role="status">{progress || '正在重新解析简历…'}</Typography.Paragraph>}
      {error && <Alert type="error" showIcon message="重新解析未完成" description={<div className="evidence-text">{error}</div>} />}
    </Modal>
  )
}
