import { DeleteOutlined, DesktopOutlined, EditOutlined, KeyOutlined, PlusOutlined, ReloadOutlined, TeamOutlined, UploadOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Checkbox, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip, Typography, Upload, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, api, openFile, send, uploadFile, waitForOperation, type Operation } from '../../api'
import { ocrStatusLabels } from '../../businessLabels'
import { PageHeader } from '../../components/PageHeader'
import { StatusTag } from '../../components/StatusTag'
import { can, useAdminSession } from '../../lib/access'
import { CredentialsModal, type Credential, type CredentialNotice } from './CredentialsModal'
import { OnsiteLaunchModal } from './OnsiteLaunch'
import { PersonPickerModal, type ImportResult } from './PersonPickerModal'
import { BatchSelect, CandidateName, batchLabel, errorMessage, useBatchParam, useBatches, type Batch, type BatchMode } from './shared'
import './interview.css'

interface Resume {
  uploaded: boolean
  original_name?: string
  ocr_status?: string
  ocr_error?: string
  source: 'library' | 'candidate'
  library_person_id: string | null
  text_preview?: string
}

interface Candidate {
  id: number
  code: string
  name: string
  profile: Record<string, unknown>
  batch_id: number
  batch_name: string
  batch_mode: BatchMode
  job_name: string
  library_person_id: string | null
  interview_status: string
  entry_mode: string
  report_status: string
  listening_status: string
  resume: Resume
  login_username: string
  has_login: boolean
  /** 密码由本系统生成的时间；为空表示沿用合并前旧系统设置的密码。 */
  password_set_at?: string | null
  login_locked: boolean
}

interface Scan { file: string; pages: number[]; page_count: number }
interface ResumeResult { status: string; message: string; library_person_id: string | null }

const RESUME_TYPES = ['.pdf', '.docx', '.txt']
// 固定列的宽度；简历列至少保留 resumeMin，屏幕更窄时才横向滚动。
const COLUMNS = { candidate: 120, scope: 156, login: 140, progress: 186, actions: 116, resumeMin: 200 }
const TABLE_WIDTH = Object.values(COLUMNS).reduce((sum, width) => sum + width, 0)
const RESUME_MAX_BYTES = 50 * 1024 * 1024
const parseStatus: Record<string, string> = { completed: '已解析', processing: '待解析', pending: '待解析', failed: '解析失败' }

function ResumeStatus({ status }: { status?: string }) {
  const parsed = parseStatus[status || '']
  if (parsed) return <StatusTag kind="parse" value={parsed} />
  return <Tag>{ocrStatusLabels[status || 'not_requested'] || '状态待核实'}</Tag>
}

export default function CandidatesPage() {
  const session = useAdminSession()
  const [batchId, setBatchId] = useBatchParam()
  const { batches, loading: batchesLoading, error: batchesError, reload: reloadBatches } = useBatches()
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [editTarget, setEditTarget] = useState<Candidate | null>(null)
  const [credentials, setCredentials] = useState<CredentialNotice | null>(null)
  const [uploading, setUploading] = useState<{ id: number; text: string } | null>(null)
  const [scanRequest, setScanRequest] = useState<{ candidate: Candidate; file: File; scans: Scan[] } | null>(null)
  const [busyId, setBusyId] = useState<number>()
  const [onsite, setOnsite] = useState<{ batch: { id: number; name: string }; candidate?: Candidate } | null>(null)
  const [previews, setPreviews] = useState<number[]>([])
  const [createForm] = Form.useForm<{ name: string; batch_id: number; code?: string; create_login: boolean }>()
  const [editForm] = Form.useForm<{ code: string; name: string; batch_id: number }>()
  const createBatchId = Form.useWatch('batch_id', createForm)
  const saveLock = useRef(false)
  // 确认和结果提示随页面一起渲染，沿用页面的主题和语言设置。
  const [modal, modalHolder] = Modal.useModal()
  const request = useRef(0)
  const allow = {
    create: can(session, 'candidate:create'),
    edit: can(session, 'candidate:edit'),
    remove: can(session, 'candidate:delete'),
    library: can(session, 'person:read'),
    onsite: can(session, 'onsite:manage'),
  }
  const openBatches = batches.filter(batch => batch.accepts_candidates)
  const createBatch = batches.find(batch => batch.id === createBatchId)
  const filterBatch = batches.find(batch => batch.id === batchId)
  // 现场面试只用于需要AI面试、题目已发布的批次。
  const onsiteBatch = allow.onsite && filterBatch?.mode === 'ai_interview' && filterBatch.accepts_candidates ? filterBatch : undefined

  const load = useCallback(async () => {
    const current = ++request.current
    setLoading(true)
    try {
      const data = await api<Candidate[]>(batchId ? `/candidates?batch_id=${batchId}` : '/candidates')
      if (request.current === current) { setCandidates(data); setLoadError('') }
    } catch (error) {
      if (request.current === current) setLoadError(errorMessage(error))
    } finally {
      if (request.current === current) setLoading(false)
    }
  }, [batchId])
  useEffect(() => { void load() }, [load])
  const refresh = () => { void load(); void reloadBatches() }

  const showCredentials = (title: string, items: Credential[], fileLabel: string, note?: CredentialNotice['note']) => setCredentials({ title, items, fileLabel, note })

  const create = async () => {
    if (saveLock.current) return
    saveLock.current = true
    const values = await createForm.validateFields().catch(() => null)
    if (!values) {
      saveLock.current = false
      return
    }
    setSaving(true)
    setFormError('')
    try {
      const result = await send<Candidate & { credentials: Credential | null }>('/candidates', 'POST', {
        name: values.name.trim(),
        batch_id: values.batch_id,
        code: (values.code || '').trim(),
        profile: {},
        ...(createBatch?.mode === 'ai_interview' ? { create_login: values.create_login } : {}),
      })
      setCreateOpen(false)
      if (result.credentials) showCredentials('候选人已添加，请保存登录凭据', [result.credentials], result.name)
      else message.success(result.batch_mode === 'listening_only' ? '候选人已添加，该批次无需登录' : '候选人已添加，未生成登录凭据')
      refresh()
    } catch (error) {
      setFormError(errorMessage(error))
    } finally {
      saveLock.current = false
      setSaving(false)
    }
  }

  const imported = (result: ImportResult, batch: Batch) => {
    setPickerOpen(false)
    const skipped = result.skipped.length ? (
      <Alert
        className="section-row"
        type="info"
        showIcon
        message={`已添加 ${result.created} 人，跳过 ${result.skipped.length} 人`}
        description={<ul className="interview-scan-list">{result.skipped.map(item => <li key={item.person_id}>{item.name || item.person_id}：{item.reason}</li>)}</ul>}
      />
    ) : undefined
    if (result.credentials.length) {
      showCredentials(`已添加 ${result.created} 人，请保存登录凭据`, result.credentials, batch.code, skipped)
    } else if (skipped) {
      modal.info({ title: '从人员库添加候选人', content: skipped, okText: '知道了' })
    } else {
      message.success(`已添加 ${result.created} 人`)
    }
    refresh()
  }

  const resetPassword = async (candidate: Candidate) => {
    setBusyId(candidate.id)
    try {
      const result = await send<{ credentials: Credential }>(`/candidates/${candidate.id}/password`, 'POST')
      showCredentials(candidate.has_login ? '密码已重置，原密码立即失效' : '登录凭据已生成', [result.credentials], candidate.name)
      await load()
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setBusyId(undefined)
    }
  }

  const saveCandidate = async () => {
    if (saveLock.current || !editTarget) return
    saveLock.current = true
    const values = await editForm.validateFields().catch(() => null)
    if (!values) {
      saveLock.current = false
      return
    }
    setSaving(true)
    setFormError('')
    try {
      await send(`/candidates/${editTarget.id}`, 'PUT', { code: values.code.trim(), name: values.name.trim(), batch_id: values.batch_id, profile: editTarget.profile || {} })
      message.success('候选人资料已修改')
      setEditTarget(null)
      refresh()
    } catch (error) {
      setFormError(errorMessage(error))
    } finally {
      saveLock.current = false
      setSaving(false)
    }
  }

  const removeCandidate = async (candidate: Candidate) => {
    try {
      await send(`/candidates/${candidate.id}`, 'DELETE')
      message.success('候选人已删除')
      refresh()
    } catch (error) {
      message.error(errorMessage(error))
    }
  }

  const removeResume = async (candidate: Candidate) => {
    try {
      await send(`/candidates/${candidate.id}/resume`, 'DELETE')
      message.success('已移除简历关联，人员库中的资料仍保留')
      await load()
    } catch (error) {
      message.error(errorMessage(error))
    }
  }

  const uploadResume = async (candidate: Candidate, file: File, allowOcr = false) => {
    const name = file.name.toLowerCase()
    if (!RESUME_TYPES.some(type => name.endsWith(type))) { message.error('简历仅支持 PDF、Word（.docx）和 TXT 文件'); return }
    if (file.size > RESUME_MAX_BYTES) { message.error('简历文件不能超过 50MB，请压缩后重新上传'); return }
    setUploading({ id: candidate.id, text: '正在上传简历' })
    try {
      const operation = await uploadFile<Operation<ResumeResult>>(`/candidates/${candidate.id}/resume`, file, allowOcr ? { allow_ocr: 'true' } : {})
      const result = await waitForOperation(operation, text => setUploading({ id: candidate.id, text }))
      if (result?.status === 'failed') {
        modal.error({
          title: `${candidate.name} 的简历解析未完成`,
          content: `${result.message || '未能识别简历内容'}。原件已保存，可在人员库中重新解析，或更换文件后重新上传。`,
          okText: '知道了',
        })
      } else {
        message.success('简历已解析，并已关联人员库档案')
      }
    } catch (error) {
      const scans = error instanceof ApiError && error.status === 409 ? (error.detail as { scans?: Scan[] } | undefined)?.scans : undefined
      if (scans?.length) setScanRequest({ candidate, file, scans })
      else message.error(errorMessage(error))
    } finally {
      setUploading(null)
      await load()
    }
  }

  const chooseResume = (candidate: Candidate, file: File) => {
    if (!candidate.resume.uploaded) { void uploadResume(candidate, file); return }
    modal.confirm({
      title: `替换 ${candidate.name} 的简历？`,
      content: '替换后面试和报告以新简历为准；原简历仍保留在人员库中。',
      okText: '替换',
      cancelText: '取消',
      onOk: () => { void uploadResume(candidate, file) },
    })
  }

  // 固定列保持较窄，简历列占用其余宽度；各列内容都完整换行，桌面宽度下不需要横向滚动。
  const columns: ColumnsType<Candidate> = [
    { title: '候选人', key: 'candidate', width: COLUMNS.candidate, render: (_, row) => <CandidateName candidate={row} /> },
    {
      title: '批次 / 岗位', key: 'scope', width: COLUMNS.scope, render: (_, row) => (
        <>
          <div className="evidence-text">{row.batch_name}</div>
          <Typography.Text type="secondary" className="evidence-text">{row.job_name}</Typography.Text>
          {row.batch_mode === 'listening_only' && <div><Tag color="blue">仅人工面试旁听</Tag></div>}
        </>
      ),
    },
    {
      title: '登录账号', key: 'login', width: COLUMNS.login, render: (_, row) => {
        if (row.batch_mode === 'listening_only') return <Typography.Text type="secondary">无需登录</Typography.Text>
        if (!row.has_login) return <Typography.Text type="secondary">未生成登录凭据</Typography.Text>
        return (
          <>
            <Typography.Text className="evidence-text" copyable={{ text: row.login_username, tooltips: ['复制账号', '已复制'] }}>{row.login_username}</Typography.Text>
            {row.login_locked && <div><Tag color="red">已锁定</Tag></div>}
            {!row.password_set_at && row.interview_status !== 'completed' && (
              <div><Tooltip title="该账号沿用旧系统设置的密码，强度可能不符合要求。重置后生成随机强密码。"><Tag color="gold">旧密码，建议重置</Tag></Tooltip></div>
            )}
          </>
        )
      },
    },
    {
      title: '简历', key: 'resume', render: (_, row) => {
        const { resume } = row
        const busy = uploading?.id === row.id
        const personId = resume.library_person_id || row.library_person_id
        const previewOpen = previews.includes(row.id)
        return (
          <div className="interview-resume-cell">
            {resume.uploaded
              ? <Space size={[6, 4]} wrap><span className="evidence-text interview-resume-name">{resume.original_name || '简历'}</span><ResumeStatus status={resume.ocr_status} /></Space>
              : <Typography.Text type="secondary">未关联简历</Typography.Text>}
            {resume.ocr_status === 'failed' && resume.ocr_error && <Typography.Text type="danger" className="evidence-text">{resume.ocr_error}</Typography.Text>}
            <Space size={[4, 0]} wrap className="interview-cell-actions">
              {resume.uploaded && resume.ocr_status !== 'processing' && (
                <Button type="link" size="small" onClick={() => openFile(`/candidates/${row.id}/resume`).catch(error => message.error(errorMessage(error)))}>查看</Button>
              )}
              {resume.text_preview && (
                <Button type="link" size="small" aria-expanded={previewOpen} onClick={() => setPreviews(current => previewOpen ? current.filter(id => id !== row.id) : [...current, row.id])}>
                  {previewOpen ? '收起摘录' : '文字摘录'}
                </Button>
              )}
              {personId && allow.library && <Link className="interview-cell-link" to={`/library/persons?person=${encodeURIComponent(personId)}`}>人员库档案</Link>}
              {allow.create && row.interview_status !== 'in_progress' && (
                <Upload accept={RESUME_TYPES.join(',')} showUploadList={false} disabled={!!uploading} beforeUpload={file => { chooseResume(row, file); return false }}>
                  <Button type="link" size="small" icon={<UploadOutlined />} loading={busy} disabled={!!uploading && !busy}>{resume.uploaded ? '替换简历' : '上传简历'}</Button>
                </Upload>
              )}
              {allow.edit && resume.uploaded && !busy && (
                <Popconfirm title="移除这份简历的关联？" description="候选人不再关联该简历，人员库中的资料仍保留；面试开始后不能移除。" okText="确认移除" cancelText="取消" onConfirm={() => removeResume(row)}>
                  <Button danger type="link" size="small">移除关联</Button>
                </Popconfirm>
              )}
            </Space>
            {busy && <span className="interview-resume-progress" role="status">{uploading.text}</span>}
            {previewOpen && (
              <div>
                <Typography.Text type="secondary" className="interview-resume-progress">简历开头部分的文字，完整内容请查看简历或人员库档案</Typography.Text>
                <div className="evidence-quote">{resume.text_preview}</div>
              </div>
            )}
          </div>
        )
      },
    },
    {
      title: '面试进度', key: 'progress', width: COLUMNS.progress, render: (_, row) => (
        <div className="interview-progress-cell">
          <span>AI面试</span><span><StatusTag kind="interview" value={row.interview_status} />{row.entry_mode === 'onsite' && <Tag>现场入口</Tag>}</span>
          {row.interview_status !== 'not_required' && <><span>AI面试报告</span><span><StatusTag kind="report" value={row.report_status} /></span></>}
          <span>人工面试旁听</span><span><StatusTag kind="listening" value={row.listening_status} /></span>
        </div>
      ),
    },
    {
      title: '操作', key: 'actions', width: COLUMNS.actions, render: (_, row) => (
        <Space size={[4, 0]} wrap className="interview-cell-actions">
          {allow.onsite && row.batch_mode === 'ai_interview' && !['completed', 'not_required'].includes(row.interview_status) && (
            <Button type="link" size="small" icon={<DesktopOutlined />} onClick={() => setOnsite({ batch: { id: row.batch_id, name: row.batch_name }, candidate: row })}>现场面试</Button>
          )}
          {allow.edit && row.batch_mode === 'ai_interview' && row.interview_status !== 'completed' && (
            <Popconfirm
              title={row.has_login ? '重置该候选人的密码？' : '为该候选人生成登录凭据？'}
              description={row.has_login ? '原密码立即失效；新密码只显示一次，请及时交给候选人。' : '将生成随机密码，只显示一次。'}
              okText={row.has_login ? '确认重置' : '确认生成'}
              cancelText="取消"
              onConfirm={() => resetPassword(row)}
            >
              <Button type="link" size="small" icon={<KeyOutlined />} loading={busyId === row.id}>{row.has_login ? '重置密码' : '生成凭据'}</Button>
            </Popconfirm>
          )}
          {allow.edit && <Button type="link" size="small" icon={<EditOutlined />} onClick={() => { setFormError(''); setEditTarget(row) }}>编辑</Button>}
          {allow.remove && (
            <Popconfirm title="确认删除该候选人？" description="面试开始后或已有报告、旁听记录的候选人不能删除。" okText="确认删除" cancelText="取消" onConfirm={() => removeCandidate(row)}>
              <Button danger type="link" size="small" icon={<DeleteOutlined />}>删除</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  const editBatches = editTarget
    ? batches.filter(batch => batch.id === editTarget.batch_id || (batch.accepts_candidates && batch.mode === editTarget.batch_mode))
    : []

  return (
    <>
      <PageHeader
        title="候选人管理"
        description="按批次添加候选人、关联简历、发放登录凭据，或直接进入现场面试。"
        actions={
          <Space wrap>
            <BatchSelect batches={batches} value={batchId} onChange={setBatchId} loading={batchesLoading} allowClear label="按批次筛选" placeholder="全部批次" />
            <Button icon={<ReloadOutlined />} onClick={refresh}>刷新</Button>
            {allow.onsite && (
              <Tooltip title={onsiteBatch ? '在这台设备上打开本批次的候选人名单，候选人选择本人后直接面试' : '请先按批次筛选，选择一个已发布题目的AI面试批次'}>
                <Button icon={<DesktopOutlined />} disabled={!onsiteBatch} onClick={() => onsiteBatch && setOnsite({ batch: onsiteBatch })}>现场面试名单</Button>
              </Tooltip>
            )}
            {allow.create && allow.library && <Button icon={<TeamOutlined />} disabled={!openBatches.length} onClick={() => setPickerOpen(true)}>从人员库选择</Button>}
            {allow.create && <Button type="primary" icon={<PlusOutlined />} disabled={!openBatches.length} onClick={() => { setFormError(''); setCreateOpen(true) }}>新增候选人</Button>}
          </Space>
        }
      />
      {(batchesError || loadError) && <Alert className="page-alert" type="error" showIcon message="未能读取候选人" description={loadError || batchesError} />}
      {allow.create && !batchesLoading && !batchesError && !openBatches.length && (
        <Alert
          className="page-alert"
          type="info"
          showIcon
          message="还没有可以添加候选人的批次"
          description={<>AI面试批次须先发布题目；仅人工面试旁听的批次创建后即可添加候选人。请先到<Link to="/ai-interview/batches">批次与题目</Link>中处理。</>}
        />
      )}
      <Card>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={candidates}
          loading={loading}
          pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
          scroll={{ x: TABLE_WIDTH }}
          locale={{ emptyText: allow.create ? '还没有候选人，可以“新增候选人”或“从人员库选择”' : '还没有候选人' }}
        />
      </Card>
      <Modal
        title="新增候选人"
        open={createOpen}
        okText="添加"
        cancelText="取消"
        confirmLoading={saving}
        cancelButtonProps={{ disabled: saving }}
        onOk={() => void create()}
        onCancel={() => { if (!saveLock.current) setCreateOpen(false) }}
        destroyOnHidden
      >
        {formError && <Alert type="error" showIcon message="添加未完成" description={formError} />}
        <Form form={createForm} preserve={false} layout="vertical" className="modal-form" initialValues={{ batch_id: openBatches.some(batch => batch.id === batchId) ? batchId : undefined, create_login: true }}>
          <Form.Item name="name" label="候选人姓名" rules={[{ required: true, whitespace: true, message: '请填写候选人姓名' }, { max: 64, message: '姓名最多64个字符' }]}>
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item name="batch_id" label="招聘批次" rules={[{ required: true, message: '请选择招聘批次' }]}>
            <Select showSearch optionFilterProp="label" placeholder="请选择招聘批次" options={openBatches.map(batch => ({ value: batch.id, label: batchLabel(batch) }))} />
          </Form.Item>
          <Form.Item name="code" label="候选人编号" extra="留空时按“批次编号-流水号”自动生成；编号同时是候选人的登录账号，不能重复。" rules={[{ max: 32, message: '候选人编号最多32个字符' }]}>
            <Input maxLength={32} placeholder="留空自动生成" />
          </Form.Item>
          {createBatch?.mode === 'listening_only' ? (
            <Alert type="info" showIcon message="该批次仅做人工面试旁听，候选人无需登录，不生成登录凭据。" />
          ) : (
            <Form.Item name="create_login" valuePropName="checked" extra="密码为随机生成的强密码，只在添加成功后显示一次。只通过现场入口参加面试的候选人可以不生成。">
              <Checkbox>生成登录账号和密码</Checkbox>
            </Form.Item>
          )}
        </Form>
      </Modal>
      <Modal
        title="编辑候选人资料"
        open={!!editTarget}
        okText="保存修改"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void saveCandidate()}
        onCancel={() => { if (!saveLock.current) setEditTarget(null) }}
        destroyOnHidden
      >
        {formError && <Alert type="error" showIcon message="修改未完成" description={formError} />}
        <Form form={editForm} preserve={false} layout="vertical" className="modal-form" initialValues={editTarget ? { code: editTarget.code, name: editTarget.name, batch_id: editTarget.batch_id } : undefined}>
          <Form.Item name="code" label="候选人编号" extra={editTarget?.has_login ? '编号同时是登录账号，修改后候选人须使用新账号登录，密码不变。' : undefined} rules={[{ required: true, whitespace: true, message: '请填写候选人编号' }, { max: 32, message: '候选人编号最多32个字符' }]}>
            <Input maxLength={32} />
          </Form.Item>
          <Form.Item name="name" label="候选人姓名" rules={[{ required: true, whitespace: true, message: '请填写候选人姓名' }, { max: 64, message: '姓名最多64个字符' }]}>
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item name="batch_id" label="招聘批次" extra="面试开始后或已有旁听记录时不能更换批次；不能在不同面试方式的批次之间调整。" rules={[{ required: true, message: '请选择招聘批次' }]}>
            <Select showSearch optionFilterProp="label" options={editBatches.map(batch => ({ value: batch.id, label: batchLabel(batch) }))} />
          </Form.Item>
        </Form>
      </Modal>
      {pickerOpen && <PersonPickerModal batches={openBatches} defaultBatchId={batchId} onClose={() => setPickerOpen(false)} onImported={imported} />}
      <Modal
        title="简历包含扫描页，需要文字识别"
        open={!!scanRequest}
        okText="已获授权，继续上传"
        cancelText="取消"
        onOk={() => {
          if (!scanRequest) return
          const { candidate, file } = scanRequest
          setScanRequest(null)
          void uploadResume(candidate, file, true)
        }}
        onCancel={() => setScanRequest(null)}
        destroyOnHidden
      >
        <Alert type="warning" showIcon message="扫描页的图片需要发送到文字识别服务处理" description="请确认已取得处理授权后再继续；不继续则不会上传这份简历。" />
        <ul className="interview-scan-list">
          {scanRequest?.scans.map(scan => <li key={scan.file}>{scan.file}：第 {scan.pages.join('、')} 页需要识别（共 {scan.page_count} 页）</li>)}
        </ul>
      </Modal>
      <CredentialsModal notice={credentials} onClose={() => setCredentials(null)} />
      {onsite && <OnsiteLaunchModal batch={onsite.batch} candidate={onsite.candidate} onClose={() => { setOnsite(null); void load() }} />}
      {modalHolder}
    </>
  )
}
