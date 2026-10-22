import { Alert, Form, Input, Modal, Radio, Select, Space, Typography, message } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, send } from '../../api'
import { StatusTag } from '../../components/StatusTag'
import { BATCH_MODES, RECRUITMENT_TYPES, errorMessage, jobStandardPath, type Batch, type BatchMode } from './shared'

interface LibraryJob {
  id: string
  name: string
  sequence: string
  level: string
  interview: { configured: boolean; audit_status: string }
}

interface BatchFormValues {
  code: string
  name: string
  recruitment_type: string
  library_job_id?: string
  mode: BatchMode
}

/** 新建或修改招聘批次。岗位只能从岗位库选择，岗位资料在岗位库中维护。 */
export function BatchFormModal({ batch, onClose, onSaved }: {
  /** 为空表示新建。 */
  batch: Batch | null
  onClose: () => void
  onSaved: (saved: Batch) => void
}) {
  const [form] = Form.useForm<BatchFormValues>()
  const [jobs, setJobs] = useState<LibraryJob[] | null>(null)
  const [jobsError, setJobsError] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const lock = useRef(false)
  const jobId = Form.useWatch('library_job_id', form)
  const mode = Form.useWatch('mode', form)

  useEffect(() => {
    let disposed = false
    api<LibraryJob[]>('/library/jobs')
      .then(data => { if (!disposed) setJobs(data) })
      .catch(e => { if (!disposed) { setJobs([]); setJobsError(errorMessage(e)) } })
    return () => { disposed = true }
  }, [])

  // 批次原来的岗位已从岗位库删除时仍要能显示名称。
  const archived = batch?.library_job_id && jobs && !jobs.some(job => job.id === batch.library_job_id)
  const options = [
    ...(jobs || []).map(job => ({ value: job.id, label: [job.name, job.sequence, job.level].filter(Boolean).join(' · ') })),
    ...(archived ? [{ value: batch.library_job_id as string, label: `${batch.job_name}（岗位库中已删除）` }] : []),
  ]
  const selectedJob = jobs?.find(job => job.id === jobId)
  const standard = selectedJob ? selectedJob.interview.audit_status : jobId && jobId === batch?.library_job_id ? batch.job_audit_status : undefined
  const legacyJob = !!batch && !batch.library_job_id
  const jobLocked = !!batch && (batch.candidate_count > 0 || batch.question_version > 0)
  const modeLocked = !!batch && batch.candidate_count > 0

  const submit = async () => {
    if (lock.current) return
    lock.current = true
    const values = await form.validateFields().catch(() => null)
    if (!values) {
      lock.current = false
      return
    }
    setSaving(true)
    setError('')
    const payload = {
      code: values.code.trim(),
      name: values.name.trim(),
      recruitment_type: values.recruitment_type,
      library_job_id: values.library_job_id || null,
      // 尚未纳入岗位库的旧批次保持原岗位不变。
      ...(!values.library_job_id && batch ? { job_id: batch.job_id } : {}),
      mode: values.mode,
    }
    try {
      const saved = batch
        ? await send<Batch>(`/batches/${batch.id}`, 'PUT', payload)
        : await send<Batch>('/batches', 'POST', payload)
      message.success(batch ? '招聘批次已修改' : '招聘批次已创建')
      onSaved(saved)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      lock.current = false
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      title={batch ? '编辑招聘批次' : '创建招聘批次'}
      okText={batch ? '保存修改' : '创建'}
      cancelText="取消"
      confirmLoading={saving}
      onOk={() => void submit()}
      onCancel={() => { if (!lock.current) onClose() }}
      destroyOnHidden
    >
      {error && <Alert type="error" showIcon message={batch ? '修改未完成' : '创建未完成'} description={error} />}
      <Form
        form={form}
        layout="vertical"
        className="modal-form"
        initialValues={batch
          ? { code: batch.code, name: batch.name, recruitment_type: batch.recruitment_type, library_job_id: batch.library_job_id || undefined, mode: batch.mode }
          : { mode: 'ai_interview' }}
      >
        <Form.Item name="code" label="批次编号" extra="候选人编号（登录账号）按“批次编号-流水号”自动生成。" rules={[{ required: true, whitespace: true, message: '请填写批次编号' }, { max: 32, message: '批次编号最多32个字符' }]}>
          <Input placeholder="例如 2026-D04" maxLength={32} />
        </Form.Item>
        <Form.Item name="name" label="批次名称" rules={[{ required: true, whitespace: true, message: '请填写批次名称' }, { max: 120, message: '批次名称最多120个字符' }]}>
          <Input maxLength={120} />
        </Form.Item>
        <Form.Item name="recruitment_type" label="招聘类型" rules={[{ required: true, message: '请选择招聘类型' }]}>
          <Select placeholder="请选择招聘类型" options={RECRUITMENT_TYPES.map(value => ({ value, label: value }))} />
        </Form.Item>
        <Form.Item
          name="library_job_id"
          label="岗位"
          rules={[{ required: !legacyJob, message: '请从岗位库选择岗位' }]}
          extra={jobLocked ? '批次已有题目或候选人，不能更换岗位。' : <>岗位来自岗位库，岗位说明和面试评价标准请在<Link to="/library/jobs" target="_blank">岗位库</Link>中维护。</>}
        >
          <Select
            showSearch
            optionFilterProp="label"
            placeholder="请从岗位库选择岗位"
            loading={!jobs}
            disabled={jobLocked}
            options={options}
            notFoundContent={jobs ? '岗位库中还没有岗位' : '正在读取岗位库'}
          />
        </Form.Item>
        {jobsError && <Alert className="interview-form-note" type="error" showIcon message="未能读取岗位库" description={jobsError} />}
        {legacyJob && !jobId && <Alert className="interview-form-note" type="info" showIcon message={`该批次的岗位“${batch.job_name}”尚未纳入岗位库，不选择时保持原岗位不变。`} />}
        {standard && (
          <div className="interview-form-note">
            <Space size={8} wrap>
              <Typography.Text type="secondary">面试评价标准</Typography.Text>
              <StatusTag kind="standard" value={standard} />
            </Space>
            {standard !== 'approved' && mode !== 'listening_only' && (
              <Alert
                className="interview-form-note"
                type="warning"
                showIcon
                message="该岗位的面试评价标准尚未确认，暂时不能生成题目"
                description={<>批次可以先创建；请在<Link to={jobStandardPath(jobId)} target="_blank">岗位库</Link>中确认该岗位的面试评价标准后，再生成题目。</>}
              />
            )}
          </div>
        )}
        <Form.Item name="mode" label="面试方式" rules={[{ required: true, message: '请选择面试方式' }]} extra={modeLocked ? '批次已有候选人，不能更改面试方式。' : undefined}>
          <Radio.Group className="interview-mode-options" disabled={modeLocked}>
            {BATCH_MODES.map(item => (
              <Radio key={item.value} value={item.value}>
                <span className="interview-mode-label">{item.label}</span>
                <span className="interview-mode-note">{item.note}</span>
              </Radio>
            ))}
          </Radio.Group>
        </Form.Item>
      </Form>
    </Modal>
  )
}
