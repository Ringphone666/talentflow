import { BulbOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Col, Descriptions, Empty, Form, Input, List, Popconfirm, Radio, Row, Skeleton, Space, Spin, Tag, Typography } from 'antd'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, send, uploadFile } from '../../api'
import { ocrStatusLabels } from '../../businessLabels'
import { CompetencyEditor, validateCompetencies } from '../../components/CompetencyEditor'
import type { Competency } from '../../components/CompetencyEditor'
import { AiNotice } from '../../components/PageHeader'
import { StatusTag } from '../../components/StatusTag'
import { formatFileSize, formatTime } from '../../lib/format'
import { FilePicker } from './FilePicker'
import { useFeedback } from './feedback'
import type { InterviewStandard, InterviewStandardResponse, JobDetail, JobMaterial, ScoringAdvice } from './types'

const MATERIAL_MAX_BYTES = 20 * 1024 * 1024
const GENERATION_RULE = '面试批次只有在评价标准为“已确认”后才能生成题目。'

interface StandardFormValues {
  professional_requirements: string
  competency_model: Competency[]
  material_version: string
  audit_status: 'draft' | 'approved'
}

const ocrColor = (status: string) => status === 'completed' ? 'green' : status === 'failed' ? 'red' : 'gold'

function CompetencyCards({ model }: { model: Competency[] }) {
  if (!model.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未填写评价标准" />
  return (
    <Row gutter={[16, 16]}>
      {model.map((item, index) => (
        <Col xs={24} lg={12} key={`${item.dimension}-${index}`}>
          <Card size="small" className="competency-card standard-card">
            <Typography.Title level={4}>{item.dimension}</Typography.Title>
            <div className="evidence-text">{item.behavior}</div>
            <dl className="standard-levels">
              {['1', '2', '3', '4', '5'].filter(score => item.levels?.[score]?.trim()).map(score => (
                <div key={score}><dt>{score} 分</dt><dd className="evidence-text">{item.levels[score]}</dd></div>
              ))}
            </dl>
            {Boolean(item.source_evaluation_basis?.filter(Boolean).length) && (
              <Typography.Paragraph type="secondary" className="evidence-text standard-basis">
                评价依据：{item.source_evaluation_basis!.filter(Boolean).join('；')}
              </Typography.Paragraph>
            )}
          </Card>
        </Col>
      ))}
    </Row>
  )
}

/** 面试评价标准：岗位的补充材料，在岗位详情中维护。 */
export function InterviewStandardTab({ job, canEdit, onChanged }: { job: JobDetail; canEdit: boolean; onChanged: () => void }) {
  const { message } = useFeedback()
  const [form] = Form.useForm<StandardFormValues>()
  const [data, setData] = useState<InterviewStandardResponse | null>(null)
  const [loadError, setLoadError] = useState('')
  const [editing, setEditing] = useState<{ version: number; initial: StandardFormValues } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [advice, setAdvice] = useState<ScoringAdvice | null>(null)
  const [adviceLoading, setAdviceLoading] = useState(false)
  const [adviceError, setAdviceError] = useState('')
  const [adviceSeconds, setAdviceSeconds] = useState(0)
  const adviceRequest = useRef<AbortController | null>(null)
  const [uploading, setUploading] = useState(false)
  const [materialError, setMaterialError] = useState('')
  const editVersion = useRef(0)
  const editable = canEdit && job.is_active

  const load = useCallback(async () => {
    try {
      setData(await api<InterviewStandardResponse>(`/library/jobs/${job.id}/interview-standard`))
      setLoadError('')
    } catch (e) {
      setLoadError((e as Error).message)
    }
  }, [job.id])

  useEffect(() => {
    setData(null)
    setEditing(null)
    setAdvice(null)
    setAdviceError('')
    setSaveError('')
    setMaterialError('')
    void load()
    return () => {
      adviceRequest.current?.abort()
      adviceRequest.current = null
    }
  }, [load])

  const editSession = editing?.version
  useLayoutEffect(() => {
    // 表单实例在多次编辑之间复用：每次进入编辑时回到本次的初始内容，不带出上次未保存的修改。
    if (editSession) form.resetFields()
  }, [editSession, form])

  useEffect(() => {
    if (!adviceLoading) return
    const startedAt = Date.now()
    const timer = window.setInterval(() => setAdviceSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [adviceLoading])

  if (loadError && !data) {
    return <Alert type="error" showIcon message="面试评价标准加载失败" description={loadError} action={<Button size="small" onClick={() => void load()}>重新加载</Button>} />
  }
  if (!data) return <Skeleton active />

  const dimensionNames = data.default_model.map(item => item.dimension)
  const savedModel = data.configured ? data.competency_model : data.default_model

  const startEdit = (model?: Competency[]) => {
    const initial: StandardFormValues = data.configured
      ? {
        professional_requirements: data.professional_requirements || '',
        competency_model: structuredClone(model ?? data.competency_model),
        material_version: data.material_version || 'v1.0',
        audit_status: data.audit_status === 'approved' ? 'approved' : 'draft',
      }
      : {
        professional_requirements: job.dimensions.map(item => item.name).join('；'),
        competency_model: structuredClone(model ?? data.default_model),
        material_version: (job.jd_version || 'v1.0').slice(0, 32),
        audit_status: 'draft',
      }
    setSaveError('')
    setEditing({ version: ++editVersion.current, initial })
  }

  const validateModel = async (_: unknown, value: Competency[]) => {
    const error = validateCompetencies(value)
    if (error) throw new Error(error)
    const outside = value.find(item => !dimensionNames.includes(item.dimension.trim()))
    if (outside) throw new Error(`评价维度“${outside.dimension.trim()}”不在六维评价体系内，请从 ${dimensionNames.join('、')} 中选择`)
  }

  const save = async () => {
    let values: StandardFormValues
    try {
      values = await form.validateFields()
    } catch {
      message.warning('请检查标红的内容和评价标准')
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      const saved = await send<InterviewStandard>(`/library/jobs/${job.id}/interview-standard`, 'PUT', {
        professional_requirements: (values.professional_requirements || '').trim(),
        competency_model: values.competency_model.map(item => ({
          ...item,
          dimension: item.dimension.trim(),
          behavior: item.behavior.trim(),
          ...(item.source_evaluation_basis ? { source_evaluation_basis: item.source_evaluation_basis.map(text => text.trim()).filter(Boolean) } : {}),
        })),
        material_version: values.material_version.trim(),
        audit_status: values.audit_status,
      })
      setData({ ...saved, default_model: data.default_model })
      setEditing(null)
      message.success(saved.audit_status === 'approved' ? '面试评价标准已保存并确认' : '面试评价标准已保存，状态为待确认')
      onChanged()
    } catch (e) {
      setSaveError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const generateAdvice = async () => {
    if (adviceRequest.current) return
    const controller = new AbortController()
    adviceRequest.current = controller
    setAdvice(null)
    setAdviceError('')
    setAdviceSeconds(0)
    setAdviceLoading(true)
    try {
      const result = await api<ScoringAdvice>(`/library/jobs/${job.id}/interview-standard/advice`, { method: 'POST', signal: controller.signal })
      if (adviceRequest.current !== controller) return
      setAdvice(result)
      // 首次生成建议时，后端会按六维默认标准建立一份待确认的评价标准。
      if (!data.configured) { void load(); onChanged() }
    } catch (e) {
      if (adviceRequest.current === controller) setAdviceError((e as Error).message)
    } finally {
      if (adviceRequest.current === controller) {
        adviceRequest.current = null
        setAdviceLoading(false)
      }
    }
  }

  const stopAdvice = () => {
    adviceRequest.current?.abort()
    adviceRequest.current = null
    setAdviceLoading(false)
    setAdviceError('已停止等待本次生成。需要时可重新生成，或直接编辑评价标准。')
  }

  const applyAdvice = () => {
    if (!advice) return
    const current: Competency[] = editing ? (form.getFieldValue('competency_model') || []) : savedModel
    const suggested = new Set(advice.criteria.map(item => item.dimension))
    const model: Competency[] = [
      ...advice.criteria.map(item => {
        const existing = current.find(criterion => criterion.dimension === item.dimension)
        return { ...existing, dimension: item.dimension, behavior: item.definition, levels: { ...existing?.levels, ...item.levels }, source_evaluation_basis: [...item.evidence_focus] }
      }),
      ...structuredClone(current.filter(item => !suggested.has(item.dimension))),
    ]
    if (editing) form.setFieldValue('competency_model', model)
    else startEdit(model)
    message.info('建议已带入编辑区，请核对修改；保存后才会生效')
  }

  const upload = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.pdf')) { setMaterialError(`${file.name}：补充材料目前只支持 PDF`); return }
    if (!file.size) { setMaterialError(`${file.name}：文件内容为空`); return }
    if (file.size > MATERIAL_MAX_BYTES) { setMaterialError(`${file.name}：补充材料不能超过 20MB`); return }
    setUploading(true)
    setMaterialError('')
    try {
      const material = await uploadFile<JobMaterial>(`/library/jobs/${job.id}/materials`, file)
      if (material.ocr_status === 'failed') setMaterialError(`${material.original_name} 已保存，但文字识别未完成。请检查文件清晰度后重新上传，或稍后再试。`)
      else message.success('补充材料已上传，文字识别完成')
      await load()
      onChanged()
    } catch (e) {
      setMaterialError((e as Error).message)
    } finally {
      setUploading(false)
    }
  }

  const removeMaterial = async (material: JobMaterial) => {
    try {
      await send(`/library/jobs/${job.id}/materials/${material.id}`, 'DELETE')
      message.success('补充材料已删除')
      await load()
    } catch (e) {
      setMaterialError((e as Error).message)
    }
  }

  return (
    <div className="standard-tab">
      {loadError && <Alert className="page-alert" type="warning" showIcon message="刷新未完成，当前显示上次读取的内容" description={loadError} />}
      {!job.is_active && <Alert className="page-alert" type="warning" showIcon message="该岗位已删除，恢复后才能维护面试评价标准" />}

      {editing ? (
        <Form key={editing.version} form={form} name="interview-standard" layout="vertical" initialValues={editing.initial} disabled={saving}>
          <Alert className="page-alert" type="info" showIcon message={`六个评价维度固定，按岗位调整考察要求和 1、3、5 分表现。${GENERATION_RULE}`} />
          {saveError && <Alert className="page-alert" type="error" showIcon message="保存未完成" description={<div className="evidence-text">{saveError}</div>} />}
          <Form.Item name="professional_requirements" label="专业能力要求" rules={[{ max: 12000, message: '最多 12000 个字' }]}>
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 12 }} placeholder="说明面试中需要重点考察的专业知识和技能" />
          </Form.Item>
          <Form.Item name="competency_model" label="评价标准" required rules={[{ validator: validateModel }]}>
            <CompetencyEditor dimensions={data.default_model.map(item => ({ name: item.dimension, definition: item.behavior }))} />
          </Form.Item>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="material_version" label="标准版本" rules={[{ required: true, whitespace: true, message: '请填写标准版本' }, { max: 32, message: '版本最多 32 个字' }]}>
                <Input placeholder="例如 v1.0" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="audit_status" label="确认状态" rules={[{ required: true, message: '请选择确认状态' }]}>
                <Radio.Group options={[{ value: 'draft', label: '待确认' }, { value: 'approved', label: '已确认' }]} />
              </Form.Item>
            </Col>
          </Row>
          <Space wrap>
            <Button type="primary" loading={saving} onClick={() => void save()}>保存面试评价标准</Button>
            <Button disabled={saving} onClick={() => setEditing(null)}>取消</Button>
          </Space>
        </Form>
      ) : (
        <>
          <Descriptions
            size="small"
            bordered
            column={{ xs: 1, md: 2 }}
            items={[
              { key: 'status', label: '确认状态', children: <StatusTag kind="standard" value={data.audit_status} /> },
              { key: 'version', label: '标准版本', children: data.material_version || '—' },
              { key: 'batches', label: '面试批次', children: `${data.batch_count} 个` },
              { key: 'updated', label: '更新时间', children: formatTime(data.updated_at) },
            ]}
          />
          <Typography.Paragraph type="secondary" className="section-row">{GENERATION_RULE}</Typography.Paragraph>
          {!data.configured ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该岗位尚未配置面试评价标准">
              {editable
                ? <Button type="primary" onClick={() => startEdit()}>按六维默认标准开始配置</Button>
                : <Typography.Text type="secondary">请联系 HR 管理员配置</Typography.Text>}
            </Empty>
          ) : (
            <>
              {editable && <div className="standard-actions"><Button type="primary" icon={<EditOutlined />} onClick={() => startEdit()}>编辑评价标准</Button></div>}
              <Typography.Title level={5}>专业能力要求</Typography.Title>
              {data.professional_requirements
                ? <div className="evidence-text">{data.professional_requirements}</div>
                : <Typography.Text type="secondary">尚未填写</Typography.Text>}
              <Typography.Title level={5} className="standard-heading">评价标准</Typography.Title>
              <Typography.Paragraph type="secondary">通用 0 分标准：已作答但答非所问，仅问候、测试口令或无关内容。未采集到回答时不评分。</Typography.Paragraph>
              <CompetencyCards model={data.competency_model} />
            </>
          )}
        </>
      )}

      {editable && (
        <Card size="small" className="section-card scoring-advice-card" title="评分标准建议" extra={(
          <Button icon={<BulbOutlined />} loading={adviceLoading} onClick={() => void generateAdvice()}>
            {adviceLoading ? '正在生成…' : advice || adviceError ? '重新生成建议' : '生成评分标准建议'}
          </Button>
        )}>
          {adviceLoading ? (
            <div className="scoring-advice-progress" role="status" aria-live="polite">
              <Spin />
              <div>
                <Typography.Text strong>正在生成“{job.name}”的评分标准建议 · 已等待 {adviceSeconds} 秒</Typography.Text>
                <Typography.Paragraph type="secondary">需要调用模型服务，通常需要一到两分钟，请勿重复点击。</Typography.Paragraph>
                <Button size="small" onClick={stopAdvice}>停止等待</Button>
              </div>
            </div>
          ) : adviceError ? (
            <Alert type="error" showIcon message="评分标准建议未生成" description={<div className="evidence-text">{adviceError}</div>} />
          ) : !advice ? (
            <Typography.Paragraph type="secondary" className="advice-idle">
              根据岗位说明和已上传的补充材料生成六维评分标准建议。建议只供参考，应用到编辑区并保存后才会生效。
            </Typography.Paragraph>
          ) : (
            <>
              <div className="tab-actions">
                <Space wrap><AiNotice /><Tag>建议权重合计 {advice.total_weight}%</Tag></Space>
                <Space wrap>
                  <Button type="primary" ghost onClick={applyAdvice}>应用到编辑区</Button>
                  <Button onClick={() => setAdvice(null)}>收起建议</Button>
                </Space>
              </div>
              <Typography.Paragraph type="secondary" className="advice-note">
                应用后可继续修改考察要求、评分描述和评价依据；建议权重仅供参考，不会调整六维评分权重。未保存前不会改变现行标准。
              </Typography.Paragraph>
              <Typography.Paragraph className="scoring-advice-rationale"><Typography.Text strong>建议依据：</Typography.Text><span className="evidence-text">{advice.rationale}</span></Typography.Paragraph>
              <List
                size="small"
                dataSource={advice.criteria}
                renderItem={item => (
                  <List.Item>
                    <div className="advice-item">
                      <Space wrap><Typography.Text strong>{item.dimension}</Typography.Text><Tag color="green">建议权重 {item.suggested_weight}%</Tag></Space>
                      <div className="evidence-text">{item.definition}</div>
                      <dl className="standard-levels">
                        {['0', '1', '2', '3', '4', '5'].filter(score => item.levels?.[score]).map(score => (
                          <div key={score}><dt>{score} 分</dt><dd className="evidence-text">{item.levels[score]}</dd></div>
                        ))}
                      </dl>
                      {item.evidence_focus.length > 0 && <Typography.Text type="secondary" className="evidence-text">证据重点：{item.evidence_focus.join('；')}</Typography.Text>}
                    </div>
                  </List.Item>
                )}
              />
              {advice.guardrails.length > 0 && (
                <ul className="plain-list advice-guardrails">{advice.guardrails.map(item => <li key={item} className="evidence-text">{item}</li>)}</ul>
              )}
            </>
          )}
        </Card>
      )}

      <Card
        size="small"
        className="section-card jobs-materials"
        title="补充材料"
        extra={editable ? <FilePicker label="上传补充材料（PDF）" accept=".pdf" loading={uploading} onPick={files => void upload(files[0])} /> : undefined}
      >
        <Typography.Paragraph type="secondary">
          上传岗位相关的 PDF 材料后，系统识别其中的文字，供面试出题和评分标准建议参考。单个文件不超过 20MB。
        </Typography.Paragraph>
        {uploading && <div className="library-progress" role="status"><Spin size="small" /><Typography.Text>正在上传并识别文字，请稍候…</Typography.Text></div>}
        {materialError && <Alert className="page-alert" type="error" showIcon closable onClose={() => setMaterialError('')} message={materialError} />}
        {!data.materials.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未上传补充材料" /> : (
          <List
            size="small"
            dataSource={data.materials}
            renderItem={item => (
              <List.Item
                actions={editable ? [
                  <Popconfirm
                    key="delete"
                    title={`删除“${item.original_name}”？`}
                    description="删除后不再用于出题和评分标准建议，无法恢复。"
                    okText="确认删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => removeMaterial(item)}
                  >
                    <Button danger type="link" size="small" icon={<DeleteOutlined />} aria-label={`删除 ${item.original_name}`}>删除</Button>
                  </Popconfirm>,
                ] : undefined}
              >
                <div className="material-item">
                  <Space wrap size={8}>
                    <Typography.Text strong className="material-name">{item.original_name}</Typography.Text>
                    <Tag color={ocrColor(item.ocr_status)}>{ocrStatusLabels[item.ocr_status] || '识别状态待核查'}</Tag>
                    <Typography.Text type="secondary">{formatFileSize(item.size)}{item.ocr_at ? ` · ${formatTime(item.ocr_at)}` : ''}</Typography.Text>
                  </Space>
                  {item.ocr_text_preview
                    ? <div className="evidence-text material-preview">识别文字开头：{item.ocr_text_preview}</div>
                    : <Typography.Text type="secondary">暂无识别文字</Typography.Text>}
                </div>
              </List.Item>
            )}
          />
        )}
      </Card>
    </div>
  )
}
