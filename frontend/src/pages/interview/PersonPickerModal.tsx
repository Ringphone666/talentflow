import { Alert, Checkbox, Form, Modal, Select, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, send } from '../../api'
import { StatusTag } from '../../components/StatusTag'
import type { Credential } from './CredentialsModal'
import { batchLabel, errorMessage, type Batch } from './shared'

interface PersonBatch {
  id: string
  name: string
  category: string
  total_count: number
  parsed_count: number
}

interface Person {
  id: string
  name: string
  source_filename: string
  status: string
  confirmed: boolean
  education: string
  work_experience: string
}

export interface ImportResult {
  created: number
  skipped: Array<{ person_id: string; name?: string; reason: string }>
  credentials: Credential[]
}

const PARSED = '已解析'

/** 从人员库选择已解析的人员加入面试批次，复用其简历解析结果。 */
export function PersonPickerModal({ batches, defaultBatchId, onClose, onImported }: {
  /** 可以添加候选人的面试批次。 */
  batches: Batch[]
  defaultBatchId?: number
  onClose: () => void
  onImported: (result: ImportResult, batch: Batch) => void
}) {
  const [targetId, setTargetId] = useState<number | undefined>(() => batches.some(batch => batch.id === defaultBatchId) ? defaultBatchId : batches.length === 1 ? batches[0].id : undefined)
  const [personBatches, setPersonBatches] = useState<PersonBatch[] | null>(null)
  const [personBatchId, setPersonBatchId] = useState<string>()
  const [persons, setPersons] = useState<Person[]>([])
  const [personsLoading, setPersonsLoading] = useState(false)
  const [existing, setExisting] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string[]>([])
  const [createLogin, setCreateLogin] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const lock = useRef(false)
  const target = batches.find(batch => batch.id === targetId)

  useEffect(() => {
    let disposed = false
    api<PersonBatch[]>('/library/person-batches')
      .then(data => { if (!disposed) setPersonBatches(data) })
      .catch(e => { if (!disposed) { setPersonBatches([]); setError(errorMessage(e)) } })
    return () => { disposed = true }
  }, [])

  useEffect(() => {
    setPersons([])
    setSelected([])
    if (!personBatchId) return
    let disposed = false
    setPersonsLoading(true)
    api<{ persons: Person[] }>(`/library/person-batches/${encodeURIComponent(personBatchId)}`)
      .then(data => { if (!disposed) { setPersons(data.persons); setError('') } })
      .catch(e => { if (!disposed) setError(errorMessage(e)) })
      .finally(() => { if (!disposed) setPersonsLoading(false) })
    return () => { disposed = true }
  }, [personBatchId])

  // 已在目标批次中的人员不能重复添加。
  useEffect(() => {
    setExisting(new Set())
    if (!targetId) return
    let disposed = false
    api<Array<{ library_person_id: string | null }>>(`/candidates?batch_id=${targetId}`)
      .then(data => { if (!disposed) setExisting(new Set(data.flatMap(item => item.library_person_id ? [item.library_person_id] : []))) })
      .catch(() => { /* 读取失败时由保存结果说明哪些人员被跳过 */ })
    return () => { disposed = true }
  }, [targetId])

  const selectable = useMemo(() => new Set(persons.filter(person => person.status === PARSED && !existing.has(person.id)).map(person => person.id)), [persons, existing])
  const chosen = selected.filter(id => selectable.has(id))

  const submit = async () => {
    if (lock.current || !target || !chosen.length) return
    lock.current = true
    setSaving(true)
    setError('')
    try {
      const result = await send<ImportResult>('/candidates/import', 'POST', {
        batch_id: target.id,
        person_ids: chosen,
        ...(target.mode === 'ai_interview' ? { create_login: createLogin } : {}),
      })
      onImported(result, target)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      lock.current = false
      setSaving(false)
    }
  }

  const columns: ColumnsType<Person> = [
    {
      title: '姓名', dataIndex: 'name', width: 150, render: (value: string, person) => (
        <>
          <Typography.Text strong>{value}</Typography.Text>
          {existing.has(person.id) && <div><Tag>已在本批次</Tag></div>}
        </>
      ),
    },
    { title: '解析状态', dataIndex: 'status', width: 110, render: (value: string) => <StatusTag kind="parse" value={value} /> },
    { title: '教育经历', dataIndex: 'education', render: (value: string) => <div className="evidence-text">{value || '—'}</div> },
    { title: '工作经历', dataIndex: 'work_experience', render: (value: string) => <div className="evidence-text">{value || '—'}</div> },
    { title: '简历文件', dataIndex: 'source_filename', render: (value: string) => <div className="evidence-text">{value}</div> },
  ]

  return (
    <Modal
      open
      width={980}
      title="从人员库选择"
      okText={chosen.length ? `加入批次（${chosen.length} 人）` : '加入批次'}
      cancelText="取消"
      okButtonProps={{ disabled: !target || !chosen.length }}
      confirmLoading={saving}
      onOk={() => void submit()}
      onCancel={() => { if (!lock.current) onClose() }}
      destroyOnHidden
    >
      {error && <Alert className="page-alert" type="error" showIcon message={error} />}
      <Form layout="vertical" className="modal-form">
        <div className="interview-picker-filters">
          <Form.Item label="加入的面试批次" required>
            <Select<number>
              aria-label="加入的面试批次"
              showSearch
              optionFilterProp="label"
              placeholder="请选择面试批次"
              value={targetId}
              onChange={setTargetId}
              options={batches.map(batch => ({ value: batch.id, label: batchLabel(batch) }))}
            />
          </Form.Item>
          <Form.Item label="人员库批次" required>
            <Select<string>
              aria-label="人员库批次"
              showSearch
              optionFilterProp="label"
              placeholder="请选择人员库批次"
              loading={!personBatches}
              value={personBatchId}
              onChange={setPersonBatchId}
              options={(personBatches || []).map(batch => ({ value: batch.id, label: `${batch.name} · ${batch.category} · 已解析 ${batch.parsed_count}/${batch.total_count} 人` }))}
              notFoundContent={personBatches ? '人员库中还没有批次' : '正在读取人员库'}
            />
          </Form.Item>
        </div>
      </Form>
      {personBatches?.length === 0 && !error && (
        <Alert className="page-alert" type="info" showIcon message="人员库中还没有人员" description={<>请先在<Link to="/library/persons" target="_blank">人员库</Link>中导入简历，解析完成后再到这里选择。</>} />
      )}
      {target?.mode === 'ai_interview' && (
        <Checkbox checked={createLogin} onChange={event => setCreateLogin(event.target.checked)}>
          为所选人员生成登录账号和随机密码（只通过现场入口参加面试的候选人可以不生成）
        </Checkbox>
      )}
      {target?.mode === 'listening_only' && (
        <Typography.Paragraph type="secondary">该批次仅做人工面试旁听，候选人无需登录，不生成登录凭据。</Typography.Paragraph>
      )}
      {personBatchId && (
        <Table
          className="section-row"
          rowKey="id"
          size="small"
          loading={personsLoading}
          columns={columns}
          dataSource={persons}
          pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
          scroll={{ x: 860 }}
          locale={{ emptyText: '该批次中还没有人员' }}
          rowSelection={{
            selectedRowKeys: chosen,
            preserveSelectedRowKeys: true,
            onChange: keys => setSelected(keys.map(String)),
            getCheckboxProps: person => ({
              disabled: !selectable.has(person.id),
              'aria-label': `选择 ${person.name}`,
            }),
          }}
          footer={() => '只能选择简历已解析的人员；解析中或解析失败的请先在人员库中处理。'}
        />
      )}
    </Modal>
  )
}
