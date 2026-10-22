import { Alert, Form, Modal, Typography } from 'antd'
import type { FormInstance } from 'antd'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { send } from '../../api'
import { JobProfileFields, JobScorecardFields } from './JobFormFields'
import { useFeedback } from './feedback'
import { blankJobValues, buildPayload, conflictOf, splitLines } from './jobModel'
import type { JobFormValues } from './jobModel'
import type { JobConflict, JobDetail, JobPayload } from './types'

/** 新增岗位和核对识别结果时使用的完整表单：岗位说明 + 能力标签与权重。 */
export function JobForm({ form, name, initialValues, disabled = false }: {
  form: FormInstance<JobFormValues>
  /** 同一页面上可能同时有多个岗位表单，名称用于区分各自的输入框。 */
  name: string
  initialValues: JobFormValues
  disabled?: boolean
}) {
  return (
    <Form form={form} name={name} layout="vertical" className="modal-form" initialValues={initialValues} disabled={disabled}>
      <Typography.Title level={5} className="job-form-section">岗位说明</Typography.Title>
      <JobProfileFields expandExtra={Boolean(initialValues.scope || initialValues.extra_sections.length)} />
      <Typography.Title level={5} className="job-form-section">能力标签与权重</Typography.Title>
      <JobScorecardFields getContext={() => ({
        name: String(form.getFieldValue('name') || '').trim(),
        responsibilities: splitLines(form.getFieldValue('responsibilities')),
        requirements: splitLines(form.getFieldValue('requirements')),
      })} />
    </Form>
  )
}

/** 校验并读取表单；未通过时滚动到第一处问题并返回 null。 */
export async function readJobForm(form: FormInstance<JobFormValues>): Promise<JobPayload | null> {
  try {
    await form.validateFields()
  } catch (error) {
    const fields = (error as { errorFields?: Array<{ name: Array<string | number> }> }).errorFields
    if (fields?.length) form.scrollToField(fields[0].name, { block: 'center' })
    return null
  }
  const values = form.getFieldsValue(true) as JobFormValues
  return buildPayload(values, values)
}

/**
 * 新增岗位。遇到同名的在用岗位时，后端返回 409 和原岗位的版本指纹；
 * 使用者确认覆盖后带上指纹重新提交。
 */
export function useCreateJob(onSaved: (job: JobDetail, overwritten: boolean) => void): {
  submit: (payload: JobPayload) => Promise<void>
  saving: boolean
  error: string
  overwriteModal: ReactNode
} {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<{ payload: JobPayload; conflict: JobConflict; message: string } | null>(null)

  const request = async (payload: JobPayload, overwrite?: JobConflict) => {
    setSaving(true)
    setError('')
    try {
      const body: JobPayload = overwrite
        ? { ...payload, overwrite_job_id: overwrite.job_id, overwrite_revision: overwrite.revision }
        : payload
      const job = await send<JobDetail>('/library/jobs', 'POST', body)
      setPending(null)
      onSaved(job, Boolean(overwrite))
    } catch (e) {
      const conflict = conflictOf(e)
      if (conflict) {
        setPending({ payload, conflict, message: (e as Error).message })
      } else {
        setPending(null)
        setError((e as Error).message)
      }
    } finally {
      setSaving(false)
    }
  }

  const overwriteModal = (
    <Modal
      title="已有同名岗位，是否覆盖？"
      open={Boolean(pending)}
      okText="确认覆盖"
      cancelText="不覆盖"
      okButtonProps={{ danger: true }}
      confirmLoading={saving}
      maskClosable={false}
      onOk={() => { if (pending) void request(pending.payload, pending.conflict) }}
      onCancel={() => { if (!saving) setPending(null) }}
    >
      {pending && (
        <>
          <Alert type="warning" showIcon message={pending.message} />
          <Typography.Paragraph className="section-row">
            覆盖后沿用原岗位“{pending.conflict.name}”的编号（{pending.conflict.job_id}），原有的岗位说明、硬性条件和能力标签将被本次内容替换；
            该岗位已有的匹配结果会标记为“需重新分析”。
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary">不想覆盖时，请选择“不覆盖”，修改岗位名称后再保存。</Typography.Paragraph>
        </>
      )}
    </Modal>
  )

  return { submit: payload => request(payload), saving, error, overwriteModal }
}

/** 手工新增岗位。 */
export function JobCreateModal({ onClose, onSaved }: { onClose: () => void; onSaved: (job: JobDetail, overwritten: boolean) => void }) {
  const [form] = Form.useForm<JobFormValues>()
  const { message } = useFeedback()
  const creator = useCreateJob(onSaved)
  const [initialValues] = useState(blankJobValues)

  const save = async () => {
    const payload = await readJobForm(form)
    if (!payload) {
      message.warning('请检查标红的内容和能力标签权重')
      return
    }
    await creator.submit(payload)
  }

  return (
    <Modal
      title="新增岗位"
      className="job-editor-modal"
      centered
      width={1120}
      open
      maskClosable={false}
      okText="保存岗位"
      cancelText="取消"
      confirmLoading={creator.saving}
      onOk={() => void save()}
      onCancel={() => { if (!creator.saving) onClose() }}
    >
      <Alert type="info" showIcon message="填写岗位说明和能力标签后保存。面试评价标准在岗位保存后，到岗位详情的“面试评价标准”中配置。" />
      {creator.error && <Alert className="section-row" type="error" showIcon message="保存未完成" description={<div className="evidence-text">{creator.error}</div>} />}
      <JobForm form={form} name="job-create" initialValues={initialValues} />
      {creator.overwriteModal}
    </Modal>
  )
}
