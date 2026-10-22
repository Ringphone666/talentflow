import { EditOutlined } from '@ant-design/icons'
import { Alert, Button, Descriptions, Form, Input, Space, Tag, Tooltip, Typography, message } from 'antd'
import { useState } from 'react'
import { send } from '../../api'
import { formatTime } from '../../lib/format'
import { operatorName } from './shared'
import type { CandidateDetail, MaterialUpdateResult } from './types'

interface MaterialForm {
  full_name: string
  fields: Record<string, string>
}

/** 本任务内的人员资料：查看各字段及出处；修改资料是可选操作，内容有改动时需要重新分析。 */
export default function MaterialPanel({ detail, canEdit, running, onSaved }: {
  detail: CandidateDetail
  canEdit: boolean
  running: boolean
  onSaved: (result: MaterialUpdateResult) => void
}) {
  const { material, redaction } = detail
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const save = async (values: MaterialForm) => {
    const changed: Record<string, string> = {}
    for (const field of material.fields) {
      const value = (values.fields?.[field.key] ?? '').trim()
      if (value !== field.value.trim()) changed[field.key] = value
    }
    const fullName = (values.full_name || '').trim()
    const renamed = fullName !== material.full_name.trim()
    if (!renamed && !Object.keys(changed).length) {
      message.info('资料内容没有改动')
      setEditing(false)
      return
    }
    setSaving(true)
    setError('')
    try {
      const result = await send<MaterialUpdateResult>(`/matching/candidates/${encodeURIComponent(detail.candidate_id)}/material`, 'PUT', {
        fields: changed,
        ...(renamed ? { full_name: fullName } : {}),
        confirmed: false,
        expected_material_version: material.material_version,
      })
      setEditing(false)
      onSaved(result)
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <Form<MaterialForm>
        layout="vertical" disabled={saving} onFinish={values => void save(values)}
        initialValues={{ full_name: material.full_name, fields: Object.fromEntries(material.fields.map(field => [field.key, field.value])) }}
      >
        <Alert
          className="page-alert" type="warning" showIcon message="修改资料会使原评分和人工结论失效"
          description="只改动需要更正的内容即可。保存后须在任务页“重新分析”，分析完成后再做人工复核；没有改动的内容不受影响。这里修改的是本任务保存的资料，原始简历文件和人员库中的资料不会被改动。请不要填写手机号、身份证号等个人敏感信息。"
        />
        {error && <Alert className="page-alert" type="error" showIcon message="资料未保存" description={error} />}
        <Form.Item name="full_name" label="姓名" rules={[{ required: true, whitespace: true, message: '请填写姓名' }, { max: 100, message: '姓名最多 100 个字' }]}>
          <Input maxLength={100} />
        </Form.Item>
        {material.fields.map(field => (
          <Form.Item key={field.key} name={['fields', field.key]} label={field.label}>
            <Input.TextArea autoSize={{ minRows: 2 }} placeholder="简历中未识别到，可根据原始简历补充" />
          </Form.Item>
        ))}
        <Space>
          <Button type="primary" htmlType="submit" loading={saving}>保存修改</Button>
          <Button onClick={() => { setEditing(false); setError('') }} disabled={saving}>取消</Button>
        </Space>
      </Form>
    )
  }

  return (
    <div className="matching-material">
      {material.warning && <Alert className="page-alert" type="warning" showIcon message="解析提示" description={<span className="evidence-text">{material.warning}</span>} />}
      <Descriptions size="small" column={{ xs: 1, md: 2 }} items={[
        { key: 'file', label: '原始文件', children: <span className="evidence-text">{material.source_filename || '—'}</span> },
        {
          key: 'status', label: '资料状态', children: material.confirmed
            ? <Tag color="green">人工已核对</Tag>
            : <Space size={4} wrap><Tag color="gold">待人工核对</Tag><Typography.Text type="secondary">{material.parse_status}</Typography.Text></Space>,
        },
        { key: 'version', label: '资料版本', children: material.material_version ? `第 ${material.material_version} 版` : '解析结果，未经修改' },
        {
          key: 'updated', label: '最近修改', children: material.updated_at
            ? `${formatTime(material.updated_at)}${material.updated_by ? ` · ${operatorName(material.updated_by)}` : ''}`
            : '—',
        },
        {
          key: 'redaction', label: '脱敏处理', span: 2, children: (
            <Space size={[4, 4]} wrap>
              <span>{redaction.status || '—'}</span>
              {redaction.types.map(type => <Tag key={type}>{type}</Tag>)}
            </Space>
          ),
        },
      ]} />
      <Descriptions className="matching-material-fields" size="small" column={1} bordered items={material.fields.map(field => ({
        key: field.key,
        label: field.label,
        children: (
          <>
            {field.value
              ? <div className="evidence-text">{field.value}</div>
              : <Typography.Text type="secondary">简历中未识别到</Typography.Text>}
            <div className="matching-field-meta">
              <Tag className="matching-tag-muted">{field.status}</Tag>
              {field.location && <Typography.Text type="secondary" className="evidence-text">出处：{field.location}</Typography.Text>}
            </div>
          </>
        ),
      }))} />
      {canEdit && (
        <div className="section-row">
          <Tooltip title={running ? '任务正在分析，完成后才能修改资料' : ''}>
            <Button icon={<EditOutlined />} disabled={running} onClick={() => { setError(''); setEditing(true) }}>修改资料</Button>
          </Tooltip>
          <Typography.Paragraph type="secondary" className="matching-note">
            修改资料不是必需步骤：资料无误时直接做人工复核即可。
          </Typography.Paragraph>
        </div>
      )}
    </div>
  )
}
