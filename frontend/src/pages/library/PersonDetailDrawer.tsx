import { EditOutlined, FileSearchOutlined } from '@ant-design/icons'
import { Alert, Button, Col, Descriptions, Drawer, Empty, Form, Input, List, Popconfirm, Row, Skeleton, Space, Table, Tabs, Tag, Typography } from 'antd'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, openFile, send } from '../../api'
import { StatusTag } from '../../components/StatusTag'
import { formatScore, formatTime } from '../../lib/format'
import { useFeedback } from './feedback'
import { UNKNOWN_NAME, fieldStatusColor } from './personModel'
import type { InterviewRecord, MatchRecord, PersonDetail } from './types'

interface MaterialFormValues {
  full_name: string
  fields: Record<string, string>
}

const modeLabels: Record<string, string> = { job_to_people: '岗位选才', people_to_jobs: '人才适岗' }

function materialValuesOf(person: PersonDetail): MaterialFormValues {
  const current = Object.fromEntries(person.profile.fields.map(item => [item.key, item.value || '']))
  return {
    full_name: person.name === UNKNOWN_NAME ? '' : person.name,
    fields: Object.fromEntries(person.editable_fields.map(item => [item.key, current[item.key] || ''])),
  }
}

/** 人员详情：资料、原文依据、匹配记录、面试记录；有权限时可修改和确认资料。 */
export function PersonDetailDrawer({ personId, onClose, onChanged }: { personId: string; onClose: () => void; onChanged: () => void }) {
  const { message, modal } = useFeedback()
  const [form] = Form.useForm<MaterialFormValues>()
  const [person, setPerson] = useState<PersonDetail | null>(null)
  const [loadError, setLoadError] = useState('')
  const [editing, setEditing] = useState<{ version: number; initial: MaterialFormValues } | null>(null)
  const [saving, setSaving] = useState<'' | 'save' | 'confirm'>('')
  const [saveError, setSaveError] = useState('')
  const sessions = useRef(0)

  const load = useCallback(async () => {
    try {
      setPerson(await api<PersonDetail>(`/library/persons/${personId}`))
      setLoadError('')
    } catch (e) {
      setLoadError((e as Error).message)
    }
  }, [personId])

  useEffect(() => {
    setPerson(null)
    setEditing(null)
    setSaveError('')
    void load()
  }, [load])

  const session = editing?.version
  useLayoutEffect(() => {
    if (session) form.resetFields()
  }, [session, form])

  const changesOf = (): { fields: Record<string, string>; full_name?: string } => {
    if (!editing || !person) return { fields: {} }
    const values = form.getFieldsValue(true) as MaterialFormValues
    const fields: Record<string, string> = {}
    for (const { key } of person.editable_fields) {
      const next = String(values.fields?.[key] ?? '').trim()
      if (next !== String(editing.initial.fields[key] ?? '').trim()) fields[key] = next
    }
    const name = String(values.full_name ?? '').trim()
    return name && name !== editing.initial.full_name ? { fields, full_name: name } : { fields }
  }

  const hasChanges = () => {
    const changes = changesOf()
    return Boolean(Object.keys(changes.fields).length || changes.full_name)
  }

  const submit = async (confirmed: boolean) => {
    if (!person) return
    const changes = changesOf()
    if (!confirmed && !Object.keys(changes.fields).length && !changes.full_name) {
      message.info('资料没有改动，无需保存')
      return
    }
    if (editing) {
      try {
        await form.validateFields()
      } catch {
        message.warning('请检查标红的内容')
        return
      }
    }
    setSaving(confirmed ? 'confirm' : 'save')
    setSaveError('')
    try {
      // 只提交改动过的内容，未改动的资料保留原有来源；带上资料版本，避免覆盖他人刚保存的修改。
      await send(`/library/persons/${person.id}/material`, 'PUT', { ...changes, confirmed, expected_material_version: person.material_version })
      setEditing(null)
      message.success(confirmed ? '资料已确认' : '修改已保存，资料待确认')
      await load()
      onChanged()
    } catch (e) {
      setSaveError((e as Error).message)
    } finally {
      setSaving('')
    }
  }

  const confirmDiscard = (action: () => void) => {
    if (!editing || !hasChanges()) { action(); return }
    modal.confirm({
      title: '放弃未保存的修改？',
      content: '人员资料的修改尚未保存，放弃后无法找回。',
      okText: '放弃修改',
      cancelText: '继续编辑',
      okButtonProps: { danger: true },
      onOk: action,
    })
  }

  const viewFile = async () => {
    if (!person) return
    try {
      await openFile(`/library/persons/${person.id}/file`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const parsing = person?.status === '待解析'
  const canEdit = Boolean(person?.can_edit) && !parsing
  const matchColumns = [
    { title: '匹配任务', dataIndex: 'task_name', render: (value: string) => <span className="evidence-text">{value}</span> },
    { title: '岗位', dataIndex: 'job_name', render: (value: string) => value || '—' },
    { title: '类型', dataIndex: 'mode', width: 96, render: (value: string) => modeLabels[value] || value },
    { title: '综合匹配度', dataIndex: 'total', width: 104, render: (value: number | null) => <span className="match-score">{formatScore(value)}</span> },
    { title: '结论', dataIndex: 'conclusion', render: (value: string) => <span className="evidence-text">{value || '—'}</span> },
    { title: '复核', dataIndex: 'review_status', width: 110, render: (value: string) => <StatusTag kind="review" value={value} /> },
    { title: '更新时间', dataIndex: 'updated_at', width: 150, render: (value: string) => formatTime(value) },
    { title: '操作', key: 'actions', width: 110, render: (_: unknown, row: MatchRecord) => <Link to={`/matching/tasks/${row.task_id}?person=${row.candidate_id}`}>查看匹配详情</Link> },
  ]
  const interviewColumns = [
    { title: '面试批次', dataIndex: 'batch_name', render: (value: string) => value || '—' },
    { title: '岗位', dataIndex: 'job_name', render: (value: string) => value || '—' },
    { title: '候选人编号', dataIndex: 'candidate_code', width: 120 },
    { title: '面试状态', dataIndex: 'interview_status', width: 120, render: (value: string) => <StatusTag kind="interview" value={value} /> },
    { title: '报告状态', dataIndex: 'report_status', width: 120, render: (value: string) => <StatusTag kind="report" value={value} /> },
    { title: '面试匹配分', dataIndex: 'match_score', width: 110, render: (value: number | null) => formatScore(value) },
  ]

  return (
    <Drawer
      className="person-drawer"
      open
      width="min(1080px, 100vw)"
      title={person ? (
        <Space wrap size={8}>
          <span>{person.name === UNKNOWN_NAME ? '姓名待确认' : person.name}</span>
          <StatusTag kind="parse" value={person.status} />
          <Tag color={person.confirmed ? 'green' : 'gold'}>{person.confirmed ? '资料已确认' : '资料待确认'}</Tag>
        </Space>
      ) : '人员详情'}
      extra={person ? <Button icon={<FileSearchOutlined />} onClick={() => void viewFile()}>查看原始简历</Button> : undefined}
      footer={editing ? (
        <Space wrap>
          <Button loading={saving === 'save'} disabled={saving === 'confirm'} onClick={() => void submit(false)}>保存修改</Button>
          <Button type="primary" loading={saving === 'confirm'} disabled={saving === 'save'} onClick={() => void submit(true)}>保存并确认资料无误</Button>
          <Button disabled={Boolean(saving)} onClick={() => confirmDiscard(() => setEditing(null))}>取消</Button>
        </Space>
      ) : undefined}
      onClose={() => { if (!saving) confirmDiscard(onClose) }}
    >
      {loadError && !person && <Alert type="error" showIcon message="人员资料加载失败" description={loadError} action={<Button size="small" onClick={() => void load()}>重新加载</Button>} />}
      {!person && !loadError && <Skeleton active />}
      {person && (
        <>
          <Descriptions
            size="small"
            column={{ xs: 1, md: 2 }}
            className="person-summary"
            items={[
              { key: 'file', label: '简历文件', children: <span className="evidence-text">{person.source_filename}</span> },
              { key: 'created', label: '导入时间', children: formatTime(person.created_at) },
              { key: 'parse', label: '资料状态', children: person.parse_status || '—' },
              { key: 'version', label: '资料版本', children: person.material_version ? `第 ${person.material_version} 次人工修订` : '系统解析，未经人工修改' },
            ]}
          />
          {person.status === '解析失败' && (
            <Alert className="page-alert" type="error" showIcon message="简历解析未完成" description={<div className="evidence-text">{person.error_message || '未能读取简历内容'}{'\n'}可在人员列表中重新解析，或在下方手工补充资料。</div>} />
          )}
          {parsing && <Alert className="page-alert" type="info" showIcon message="简历正在解析，完成后可查看和修改资料" />}
          {person.warning && <Alert className="page-alert" type="warning" showIcon message="解析提示" description={<div className="evidence-text">{person.warning}</div>} />}
          {saveError && <Alert className="page-alert" type="error" showIcon message="保存未完成" description={<div className="evidence-text">{saveError}</div>} action={<Button size="small" onClick={() => { setEditing(null); setSaveError(''); void load() }}>刷新资料</Button>} />}
          <Tabs
            items={[
              {
                key: 'profile', label: '人员资料',
                children: editing ? (
                  <Form key={editing.version} form={form} name="person-material" layout="vertical" initialValues={editing.initial} disabled={Boolean(saving)}>
                    <Alert className="page-alert" type="info" showIcon message="修改只影响人员库中的资料。已建立的匹配任务保留各自的资料快照，不受影响；请勿填写未脱敏的手机号或身份证号。" />
                    <Form.Item name="full_name" label="姓名" rules={[{ max: 100, message: '姓名最多 100 个字' }]}>
                      <Input placeholder="未识别到姓名时，可根据原始简历补充" />
                    </Form.Item>
                    <Row gutter={16}>
                      {person.editable_fields.map(item => (
                        <Col xs={24} lg={12} key={item.key}>
                          <Form.Item name={['fields', item.key]} label={item.label}>
                            <Input.TextArea autoSize={{ minRows: 3, maxRows: 14 }} />
                          </Form.Item>
                        </Col>
                      ))}
                    </Row>
                  </Form>
                ) : (
                  <>
                    {canEdit && (
                      <div className="tab-actions">
                        <Typography.Text type="secondary">{person.confirmed ? '资料已确认，仍可继续修改。' : '请对照原始简历核对资料；核对无误后确认。'}</Typography.Text>
                        <Space wrap>
                          <Button icon={<EditOutlined />} onClick={() => { setSaveError(''); setEditing({ version: ++sessions.current, initial: materialValuesOf(person) }) }}>修改资料</Button>
                          {!person.confirmed && person.status === '已解析' && (
                            <Popconfirm
                              title="确认资料无误？"
                              description="确认后资料状态变为“已确认”，之后仍可修改。"
                              okText="确认"
                              cancelText="取消"
                              onConfirm={() => submit(true)}
                            >
                              <Button type="primary" loading={saving === 'confirm'}>确认资料无误</Button>
                            </Popconfirm>
                          )}
                        </Space>
                      </div>
                    )}
                    <Descriptions
                      size="small"
                      bordered
                      column={1}
                      className="person-fields"
                      items={person.profile.fields.map(item => ({
                        key: item.key,
                        label: item.label,
                        children: (
                          <>
                            {item.value
                              ? <div className="evidence-text">{item.value}</div>
                              : <Typography.Text type="secondary">简历中未识别到</Typography.Text>}
                            <div className="field-meta">
                              <Tag color={fieldStatusColor(item.status)}>{item.status}</Tag>
                              {(item.source_file || item.location) && (
                                <Typography.Text type="secondary" className="evidence-source">来源：{[item.source_file, item.location].filter(Boolean).join(' · ')}</Typography.Text>
                              )}
                            </div>
                          </>
                        ),
                      }))}
                    />
                  </>
                ),
              },
              {
                key: 'evidence', label: `原文依据（${person.evidence_total}）`,
                children: !person.evidence.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有可显示的原文依据" /> : (
                  <>
                    {person.evidence_total > person.evidence.length && (
                      <Alert className="page-alert" type="info" showIcon message={`共 ${person.evidence_total} 段原文，这里显示前 ${person.evidence.length} 段；完整内容请查看原始简历。`} />
                    )}
                    <List
                      size="small"
                      dataSource={person.evidence}
                      renderItem={(item, index) => (
                        <List.Item>
                          <div className="evidence-item">
                            <div className="evidence-text">{item.text}</div>
                            <Typography.Text type="secondary" className="evidence-source">
                              {index + 1}. {[item.file, item.location].filter(Boolean).join(' · ') || '未标注出处'}{item.origin === 'human_review' ? ' · 人工核实记录，不是简历原文' : ''}
                            </Typography.Text>
                          </div>
                        </List.Item>
                      )}
                    />
                  </>
                ),
              },
              {
                key: 'matching', label: `匹配记录（${person.matching_history.length}）`,
                children: !person.matching_history.length
                  ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无匹配记录。可在“人岗匹配”中新建任务并选择该人员所在的批次。" />
                  : <Table<MatchRecord> size="small" rowKey="candidate_id" pagination={false} dataSource={person.matching_history} columns={matchColumns} scroll={{ x: 900 }} />,
              },
              {
                key: 'interviews', label: `面试记录（${person.interviews.length}）`,
                children: !person.interviews.length
                  ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无面试记录。在“AI面试 · 候选人管理”中关联该人员后，这里会显示面试和报告状态。" />
                  : <Table<InterviewRecord> size="small" rowKey="candidate_id" pagination={false} dataSource={person.interviews} columns={interviewColumns} scroll={{ x: 760 }} />,
              },
            ]}
          />
        </>
      )}
    </Drawer>
  )
}
