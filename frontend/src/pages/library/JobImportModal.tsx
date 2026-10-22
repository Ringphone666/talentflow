import { Alert, Button, Collapse, Form, Modal, Select, Space, Spin, Tag, Typography } from 'antd'
import { useRef, useState } from 'react'
import { postForm } from '../../api'
import type { Operation } from '../../api'
import { AiNotice } from '../../components/PageHeader'
import { FilePicker, FileRow } from './FilePicker'
import { JobForm, readJobForm, useCreateJob } from './JobForm'
import { ScorecardBasisList } from './JobFormFields'
import { useFeedback } from './feedback'
import { JD_FILE_TYPES, JD_MAX_BYTES, JD_MAX_FILES, fileExtension, jobValuesOfDraft } from './jobModel'
import type { JobFormValues } from './jobModel'
import { followOperation } from './operations'
import type { JobDetail, JobImportItem, JobImportResult, JobSummary } from './types'

interface ImportEntry extends JobImportItem {
  key: string
  saved?: JobDetail
}

const entryTitle = (item: ImportEntry) => item.draft
  ? `${item.draft.name || '待补充名称'} · ${item.source_file}`
  : item.source_file

function DraftReview({ item, onSaved }: { item: ImportEntry; onSaved: (job: JobDetail, overwritten: boolean) => void }) {
  const [form] = Form.useForm<JobFormValues>()
  const { message } = useFeedback()
  const creator = useCreateJob(onSaved)
  const [initialValues] = useState(() => jobValuesOfDraft(item.draft!))
  const draft = item.draft!

  if (item.saved) {
    return <Alert type="success" showIcon message={`已保存为岗位“${item.saved.name}”`} description="可在岗位列表中查看；需要修改时请在岗位详情中编辑。" />
  }

  const save = async () => {
    const payload = await readJobForm(form)
    if (!payload) {
      message.warning('请检查标红的内容和能力标签权重')
      return
    }
    await creator.submit(payload)
  }

  return (
    <div className="draft-review">
      {draft.warning && <Alert type="warning" showIcon message="识别提示" description={<div className="evidence-text">{draft.warning}</div>} />}
      {draft.scorecard_error && (
        <Alert
          type="warning"
          showIcon
          message="能力标签建议未生成"
          description={<div className="evidence-text">{draft.scorecard_error}{'\n'}可在下方点击“AI生成能力标签建议”重试，或手工填写能力标签。</div>}
        />
      )}
      <Typography.Paragraph type="secondary" className="draft-source">
        来源文件：{item.source_file}{draft.model_source ? ` · 能力标签来源：${draft.model_source}` : ''}。以下内容均可修改，确认后才会保存到岗位库。
      </Typography.Paragraph>
      {draft.scorecard_basis?.length > 0 && (
        <Collapse
          ghost
          items={[{ key: 'basis', label: '查看能力标签建议依据', children: <><AiNotice /><ScorecardBasisList basis={draft.scorecard_basis} /></> }]}
        />
      )}
      {creator.error && <Alert type="error" showIcon message="保存未完成" description={<div className="evidence-text">{creator.error}</div>} />}
      <JobForm form={form} name={`job-draft-${item.key}`} initialValues={initialValues} disabled={creator.saving} />
      <div className="draft-actions">
        <Button type="primary" loading={creator.saving} onClick={() => void save()}>确认并保存为岗位</Button>
      </div>
      {creator.overwriteModal}
    </div>
  )
}

/** 上传岗位说明书：识别出岗位草稿，逐个核对后保存。确认前不写入岗位库。 */
export function JobImportModal({ jobs, onClose, onSaved }: {
  jobs: JobSummary[]
  onClose: () => void
  onSaved: (job: JobDetail, overwritten: boolean) => void
}) {
  const { modal, message } = useFeedback()
  const [files, setFiles] = useState<File[]>([])
  const [problems, setProblems] = useState<string[]>([])
  const [referenceId, setReferenceId] = useState<string>()
  const [phase, setPhase] = useState<'select' | 'running' | 'review'>('select')
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [items, setItems] = useState<ImportEntry[]>([])
  const [activeKeys, setActiveKeys] = useState<string[]>([])
  const run = useRef(0)

  const drafts = items.filter(item => item.draft)
  const failed = items.filter(item => !item.draft)
  const unsaved = drafts.filter(item => !item.saved)

  const pick = (picked: File[]) => {
    const rejected: string[] = []
    const next = [...files]
    for (const file of picked) {
      if (!JD_FILE_TYPES.includes(fileExtension(file.name))) rejected.push(`${file.name}：请上传 PDF、Word（.docx）或 TXT 文件`)
      else if (!file.size) rejected.push(`${file.name}：文件内容为空`)
      else if (file.size > JD_MAX_BYTES) rejected.push(`${file.name}：岗位说明书不能超过 20MB`)
      else if (next.some(item => item.name === file.name && item.size === file.size)) rejected.push(`${file.name}：已在列表中`)
      else if (next.length >= JD_MAX_FILES) rejected.push(`${file.name}：每次最多上传 ${JD_MAX_FILES} 份，请分批识别`)
      else next.push(file)
    }
    setFiles(next)
    setProblems(rejected)
  }

  const start = async () => {
    if (!files.length) return
    const id = ++run.current
    const form = new FormData()
    files.forEach(file => form.append('files', file))
    if (referenceId) form.append('reference_job_id', referenceId)
    setPhase('running')
    setProgress('正在上传岗位说明书…')
    setError('')
    try {
      const operation = await postForm<Operation<JobImportResult>>('/library/jobs/import', form)
      const result = await followOperation(operation, text => { if (run.current === id) setProgress(text) })
      if (run.current !== id) return
      const entries = (result?.drafts || []).map((item, index) => ({ ...item, key: String(index) }))
      if (!entries.length) {
        setError('没有从文件中识别到岗位，请确认文件内容是岗位说明书，或手工新增岗位')
        setPhase('select')
        return
      }
      setItems(entries)
      setActiveKeys(entries.filter(item => item.draft).slice(0, 1).map(item => item.key))
      setPhase('review')
    } catch (e) {
      if (run.current !== id) return
      setError((e as Error).message)
      setPhase('select')
    }
  }

  const stopWaiting = () => {
    run.current += 1
    setPhase('select')
    setError('已停止等待本次识别。需要时请重新点击“开始识别”。')
  }

  const leave = (action: () => void) => {
    if (phase === 'review' && unsaved.length) {
      modal.confirm({
        title: `还有 ${unsaved.length} 个岗位草稿未保存`,
        content: '离开后草稿不会保留，需要重新上传识别。',
        okText: '仍然离开',
        cancelText: '继续核对',
        onOk: action,
      })
      return
    }
    action()
  }

  const markSaved = (key: string, job: JobDetail, overwritten: boolean) => {
    setItems(current => current.map(item => item.key === key ? { ...item, saved: job } : item))
    const following = items.find(item => item.draft && !item.saved && item.key !== key)
    setActiveKeys(following ? [following.key] : [])
    message.success(overwritten ? `已覆盖岗位“${job.name}”` : `岗位“${job.name}”已保存`)
    onSaved(job, overwritten)
  }

  const restart = () => leave(() => {
    setItems([])
    setFiles([])
    setProblems([])
    setError('')
    setPhase('select')
  })

  return (
    <Modal
      title="上传岗位说明书"
      className="job-editor-modal"
      centered
      width={1120}
      open
      maskClosable={false}
      closable={phase !== 'running'}
      keyboard={phase !== 'running'}
      onCancel={() => { if (phase !== 'running') leave(onClose) }}
      footer={phase === 'select'
        ? <Space wrap><Button onClick={onClose}>取消</Button><Button type="primary" disabled={!files.length} onClick={() => void start()}>开始识别</Button></Space>
        : phase === 'running'
          ? <Button onClick={stopWaiting}>停止等待</Button>
          : <Space wrap><Button onClick={restart}>继续上传其他文件</Button><Button type="primary" onClick={() => leave(onClose)}>完成</Button></Space>}
    >
      {phase === 'select' && (
        <Space direction="vertical" size={16} className="full-width">
          <Alert
            type="info"
            showIcon
            message="系统识别岗位职责、任职要求、硬性条件和能力标签，生成待核对的岗位草稿"
            description="支持 PDF、Word（.docx）、TXT，单个文件不超过 20MB，每次 1 至 10 份；一份文件中有多个岗位时会分别识别。识别结果需逐个核对，确认保存前不会写入岗位库。"
          />
          {error && <Alert type="error" showIcon message="识别未完成" description={<div className="evidence-text">{error}</div>} />}
          <div>
            <FilePicker label="选择岗位说明书" accept={JD_FILE_TYPES.join(',')} multiple onPick={pick} />
            <Typography.Text type="secondary" className="picker-hint">已选择 {files.length} / {JD_MAX_FILES} 份</Typography.Text>
          </div>
          {problems.length > 0 && (
            <Alert type="warning" showIcon closable onClose={() => setProblems([])} message="以下文件未加入" description={<ul className="plain-list">{problems.map(item => <li key={item}>{item}</li>)}</ul>} />
          )}
          {files.length > 0 && (
            <ul className="file-list" aria-label="已选择的岗位说明书">
              {files.map(file => <FileRow key={`${file.name}-${file.size}`} file={file} onRemove={() => setFiles(current => current.filter(item => item !== file))} />)}
            </ul>
          )}
          <div>
            <Typography.Text strong>借用已有岗位的能力标签（选填）</Typography.Text>
            <Typography.Paragraph type="secondary" className="field-hint">
              说明书中已有能力标签时直接采用；没有时，借用所选岗位的能力标签和权重，未选择则由 AI 根据职责和任职要求生成。不会借用所选岗位的职责、任职要求和硬性条件。
            </Typography.Paragraph>
            <Select
              aria-label="借用已有岗位的能力标签"
              className="job-selector"
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="不借用"
              value={referenceId}
              onChange={value => setReferenceId(value)}
              options={jobs.filter(job => job.is_active).map(job => ({ value: job.id, label: `${job.name} · ${job.sequence}` }))}
            />
          </div>
        </Space>
      )}
      {phase === 'running' && (
        <div className="library-progress library-progress-large" role="status" aria-live="polite">
          <Spin size="large" />
          <div>
            <Typography.Text strong>{progress || '正在识别岗位说明书…'}</Typography.Text>
            <Typography.Paragraph type="secondary">识别需要调用模型服务，每份文件通常需要一到数分钟。请保持本窗口打开。</Typography.Paragraph>
          </div>
        </div>
      )}
      {phase === 'review' && (
        <Space direction="vertical" size={16} className="full-width">
          <Alert
            type={unsaved.length ? 'info' : 'success'}
            showIcon
            message={`识别出 ${drafts.length} 个岗位草稿，已保存 ${drafts.length - unsaved.length} 个，待核对 ${unsaved.length} 个${failed.length ? `；另有 ${failed.length} 项未能识别` : ''}`}
            description="请展开每个岗位核对并修改，点击“确认并保存为岗位”后才会写入岗位库。"
          />
          <AiNotice />
          <Collapse
            activeKey={activeKeys}
            onChange={keys => setActiveKeys(Array.isArray(keys) ? keys.map(String) : [String(keys)])}
            items={items.map((item, index) => ({
              key: item.key,
              label: `${index + 1}. ${entryTitle(item)}`,
              extra: !item.draft ? <Tag color="red">未能识别</Tag> : item.saved ? <Tag color="green">已保存</Tag> : <Tag color="gold">待核对</Tag>,
              children: item.draft
                ? <DraftReview item={item} onSaved={(job, overwritten) => markSaved(item.key, job, overwritten)} />
                : <Alert type="error" showIcon message={`${item.source_file} 未能识别`} description={<div className="evidence-text">{item.error || '未能读取文件内容'}{'\n'}请检查文件后重新上传，或手工新增岗位。</div>} />,
            }))}
          />
        </Space>
      )}
    </Modal>
  )
}
