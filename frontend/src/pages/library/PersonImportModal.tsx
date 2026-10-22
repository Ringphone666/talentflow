import { Alert, Button, Checkbox, Modal, Select, Space, Spin, Table, Typography } from 'antd'
import { useMemo, useRef, useState } from 'react'
import { ApiError, postForm } from '../../api'
import type { Operation } from '../../api'
import { FilePicker, FileRow } from './FilePicker'
import { followOperation } from './operations'
import {
  OCR_AUTHORISATION, RESUME_FILE_TYPES, UNKNOWN_NAME, duplicatedAssignment, fileProblem, pairAttachments, selectionSignature, uploadName,
} from './personModel'
import type { AttachmentChoice } from './personModel'
import type { PersonBatch, PersonImportResult, PreflightReport, ScanInfo } from './types'

export interface ImportOutcome {
  batchId: string
  result?: PersonImportResult
  error?: string
  /** 导入窗口已被关闭，结果需要在页面上提示。 */
  background: boolean
}

interface Props {
  batch: PersonBatch
  /** 单次最多导入的简历份数；未能取得时为 null。 */
  limit: number | null
  onClose: () => void
  /** 导入请求已被接受，后台开始解析。 */
  onStarted: () => void
  /** 导入结束（成功或失败）。窗口提前关闭时也会通知。 */
  onFinished: (outcome: ImportOutcome) => void
}

function scansOf(error: unknown): ScanInfo[] | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null
  const detail = error.detail
  if (!detail || typeof detail !== 'object') return null
  const scans = (detail as { scans?: unknown }).scans
  return Array.isArray(scans) ? scans as ScanInfo[] : null
}

/** 向批次导入简历：选择文件 → 检查文件 → 导入并解析。 */
export function PersonImportModal({ batch, limit, onClose, onStarted, onFinished }: Props) {
  const [resumes, setResumes] = useState<File[]>([])
  const [attachments, setAttachments] = useState<AttachmentChoice[]>([])
  const [problems, setProblems] = useState<string[]>([])
  const [check, setCheck] = useState<{ signature: string; report: PreflightReport } | null>(null)
  const [authorized, setAuthorized] = useState(false)
  const [phase, setPhase] = useState<'select' | 'checking' | 'importing' | 'done'>('select')
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<PersonImportResult | null>(null)
  const closed = useRef(false)

  const resumeNames = useMemo(() => resumes.map(file => uploadName(file.name)), [resumes])
  const signature = useMemo(() => selectionSignature([...resumes, ...attachments.map(item => item.file)]), [resumes, attachments])
  const checked = check?.signature === signature ? check.report : null
  const assigned = attachments.filter(item => item.resume)
  const uploadNames = new Set([...resumeNames, ...assigned.map(item => uploadName(item.file.name))])
  const scans = (checked?.scans || []).filter(item => uploadNames.has(item.file))
  const duplicated = duplicatedAssignment(attachments)
  const busy = phase === 'checking' || phase === 'importing'
  const ready = Boolean(checked) && !checked!.errors.length && !duplicated && resumes.length > 0 && (!scans.length || authorized)

  const pickResumes = (picked: File[]) => {
    const rejected: string[] = []
    const next = [...resumes]
    for (const file of picked) {
      const problem = fileProblem(file, '简历')
      const name = uploadName(file.name).toLowerCase()
      if (problem) rejected.push(problem)
      else if (next.some(item => uploadName(item.name).toLowerCase() === name)) rejected.push(`${file.name}：列表中已有同名简历，请改名后再选择`)
      else if (limit !== null && next.length >= limit) rejected.push(`${file.name}：每次最多导入 ${limit} 份简历，请分批导入`)
      else next.push(file)
    }
    setResumes(next)
    setAttachments(current => pairAttachments(next.map(file => uploadName(file.name)), current))
    setProblems(rejected)
  }

  const pickAttachments = (picked: File[]) => {
    const rejected: string[] = []
    const next = [...attachments]
    for (const file of picked) {
      const problem = fileProblem(file, '面试纪要或补充材料')
      const name = uploadName(file.name).toLowerCase()
      if (problem) rejected.push(problem)
      else if (next.some(item => uploadName(item.file.name).toLowerCase() === name)) rejected.push(`${file.name}：列表中已有同名材料，请改名后再选择`)
      else next.push({ file, resume: null, manual: false })
    }
    setAttachments(pairAttachments(resumeNames, next))
    setProblems(rejected)
  }

  const removeResume = (file: File) => {
    const next = resumes.filter(item => item !== file)
    setResumes(next)
    setAttachments(current => pairAttachments(next.map(item => uploadName(item.name)), current))
  }

  const runCheck = async () => {
    if (!resumes.length) return
    const form = new FormData()
    ;[...resumes, ...attachments.map(item => item.file)].forEach(file => form.append('files', file))
    setPhase('checking')
    setError('')
    try {
      const report = await postForm<PreflightReport>('/library/uploads/preflight', form)
      setCheck({ signature, report: { scans: report.scans || [], errors: report.errors || [] } })
      setAuthorized(false)
    } catch (e) {
      setCheck(null)
      setError((e as Error).message)
    } finally {
      setPhase('select')
    }
  }

  const startImport = async () => {
    if (!ready) return
    const form = new FormData()
    resumes.forEach(file => form.append('files', file))
    assigned.forEach(item => form.append('minutes', item.file))
    if (assigned.length) {
      form.append('minute_assignments', JSON.stringify(Object.fromEntries(assigned.map(item => [item.resume as string, uploadName(item.file.name)]))))
    }
    form.append('allow_ocr', scans.length > 0 && authorized ? 'true' : 'false')
    setPhase('importing')
    setProgress('正在上传简历…')
    setError('')
    try {
      const operation = await postForm<Operation<PersonImportResult>>(`/library/person-batches/${batch.id}/import`, form)
      onStarted()
      const outcome = await followOperation(operation, text => { if (!closed.current) setProgress(text) })
      onFinished({ batchId: batch.id, result: outcome, background: closed.current })
      if (closed.current) return
      setResult(outcome)
      setPhase('done')
    } catch (e) {
      const found = scansOf(e)
      if (found) {
        // 后端发现扫描页而本次未带授权：列出扫描页，等使用者确认授权后再导入。
        setCheck({ signature, report: { scans: found, errors: [] } })
        setAuthorized(false)
      } else {
        onFinished({ batchId: batch.id, error: (e as Error).message, background: closed.current })
      }
      if (closed.current) return
      setError((e as Error).message)
      setPhase('select')
    }
  }

  const close = () => {
    closed.current = true
    onClose()
  }

  const reset = () => {
    setResumes([])
    setAttachments([])
    setProblems([])
    setCheck(null)
    setAuthorized(false)
    setResult(null)
    setError('')
    setPhase('select')
  }

  const footer = phase === 'done'
    ? <Space wrap><Button onClick={reset}>继续导入</Button><Button type="primary" onClick={close}>完成</Button></Space>
    : phase === 'importing'
      ? <Button onClick={close}>关闭窗口，在后台继续导入</Button>
      : (
        <Space wrap>
          <Button disabled={busy} onClick={close}>取消</Button>
          <Button loading={phase === 'checking'} disabled={!resumes.length} type={checked ? 'default' : 'primary'} onClick={() => void runCheck()}>{checked ? '重新检查' : '检查文件'}</Button>
          <Button type="primary" disabled={!ready || busy} onClick={() => void startImport()}>开始导入{resumes.length ? `（${resumes.length} 份）` : ''}</Button>
        </Space>
      )

  return (
    <Modal
      title={`向“${batch.name}”导入简历`}
      className="job-editor-modal"
      centered
      width={960}
      open
      maskClosable={false}
      closable={phase !== 'checking'}
      keyboard={false}
      onCancel={() => { if (phase !== 'checking') close() }}
      footer={footer}
    >
      {(phase === 'select' || phase === 'checking') && (
        <Space direction="vertical" size={16} className="full-width">
          <Alert
            type="info"
            showIcon
            message="每份简历对应一人，导入后系统自动解析学历、工作经历等资料"
            description={`支持 PDF、Word（.docx）、TXT，单个文件不超过 50MB；${limit !== null ? `每次最多导入 ${limit} 份简历，超过时请分批导入` : '单次导入份数有上限，超过时系统会提示分批导入'}。`}
          />
          {error && <Alert type="error" showIcon message="未能继续" description={<div className="evidence-text">{error}</div>} />}
          {problems.length > 0 && (
            <Alert type="warning" showIcon closable onClose={() => setProblems([])} message="以下文件未加入" description={<ul className="plain-list">{problems.map(item => <li key={item}>{item}</li>)}</ul>} />
          )}

          <section>
            <Typography.Title level={5}>简历文件</Typography.Title>
            <FilePicker label="选择简历文件" accept={RESUME_FILE_TYPES.join(',')} multiple disabled={busy} onPick={pickResumes} />
            <Typography.Text type="secondary" className="picker-hint">已选择 {resumes.length} 份{limit !== null ? ` / 每次最多 ${limit} 份` : ''}</Typography.Text>
            {resumes.length > 0 && (
              <ul className="file-list" aria-label="已选择的简历">
                {resumes.map(file => <FileRow key={file.name} file={file} disabled={busy} onRemove={() => removeResume(file)} />)}
              </ul>
            )}
          </section>

          <section>
            <Typography.Title level={5}>面试纪要或补充材料（选填）</Typography.Title>
            <Typography.Paragraph type="secondary" className="field-hint">
              每人最多一份，随简历一起解析。文件名为“简历文件名_面试纪要”时自动对应，例如“张三.pdf”与“张三_面试纪要.docx”；也可以在下方手动选择对应的简历。未指定对应简历的材料不会导入。
            </Typography.Paragraph>
            <FilePicker label="选择面试纪要或补充材料" accept={RESUME_FILE_TYPES.join(',')} multiple disabled={busy || !resumes.length} onPick={pickAttachments} />
            {!resumes.length && <Typography.Text type="secondary" className="picker-hint">请先选择简历文件</Typography.Text>}
            {attachments.length > 0 && (
              <ul className="file-list" aria-label="已选择的面试纪要或补充材料">
                {attachments.map(item => (
                  <FileRow key={item.file.name} file={item.file} disabled={busy} onRemove={() => setAttachments(current => current.filter(entry => entry !== item))}>
                    <Select
                      aria-label={`${item.file.name} 对应的简历`}
                      className="assignment-select"
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      placeholder="未指定（不导入）"
                      disabled={busy}
                      value={item.resume ?? undefined}
                      onChange={value => setAttachments(current => current.map(entry => entry === item ? { ...entry, resume: value ?? null, manual: true } : entry))}
                      options={resumeNames.map(name => ({ value: name, label: name }))}
                    />
                  </FileRow>
                ))}
              </ul>
            )}
            {duplicated && <Alert className="section-row" type="error" showIcon message={`“${duplicated}”对应了多份材料，每份简历最多对应一份，请调整`} />}
          </section>

          {phase === 'checking' && (
            <div className="library-progress" role="status" aria-live="polite"><Spin /><Typography.Text>正在检查文件是否可用、是否包含扫描页…</Typography.Text></div>
          )}
          {phase === 'select' && resumes.length > 0 && !checked && (
            <Typography.Text type="secondary">{check ? '文件有变化，请重新检查后再导入。' : '选好文件后请先点击“检查文件”，确认文件可用并查看是否包含扫描页。'}</Typography.Text>
          )}
          {phase === 'select' && checked && (
            <section>
              <Typography.Title level={5}>文件检查结果</Typography.Title>
              {checked.errors.length > 0 && (
                <Alert
                  type="error"
                  showIcon
                  message="以下文件无法导入，请移除或更换后重新检查"
                  description={<ul className="plain-list">{checked.errors.map(item => <li key={item} className="evidence-text">{item}</li>)}</ul>}
                />
              )}
              {!checked.errors.length && !scans.length && <Alert type="success" showIcon message="文件检查通过，没有需要文字识别的扫描页" />}
              {scans.length > 0 && (
                <>
                  <Alert
                    className="page-alert"
                    type="warning"
                    showIcon
                    message={`${scans.length} 个文件包含扫描页`}
                    description="文字页在本地提取；扫描页是图片，需要发送到文字识别服务处理后才能读取内容。未确认授权时，这些文件不能导入。"
                  />
                  <Table<ScanInfo>
                    size="small"
                    rowKey="file"
                    pagination={false}
                    dataSource={scans}
                    scroll={{ x: 640 }}
                    columns={[
                      { title: '文件', dataIndex: 'file', render: (value: string) => <span className="evidence-text">{value}</span> },
                      { title: '需识别的页码', dataIndex: 'pages', width: 140 },
                      { title: '总页数', dataIndex: 'page_count', width: 80 },
                      { title: '本地文字页数', dataIndex: 'text_pages', width: 116 },
                      { title: '空白页数', dataIndex: 'blank_pages', width: 90 },
                    ]}
                  />
                  <Checkbox className="section-row" checked={authorized} onChange={event => setAuthorized(event.target.checked)}>{OCR_AUTHORISATION}</Checkbox>
                </>
              )}
            </section>
          )}
        </Space>
      )}

      {phase === 'importing' && (
        <div className="library-progress library-progress-large" role="status" aria-live="polite">
          <Spin size="large" />
          <div>
            <Typography.Text strong>{progress || '正在导入简历…'}</Typography.Text>
            <Typography.Paragraph type="secondary">解析在后台进行。可以关闭本窗口，稍后在人员列表中查看结果。</Typography.Paragraph>
          </div>
        </div>
      )}

      {phase === 'done' && result && (
        <Space direction="vertical" size={16} className="full-width">
          <Alert
            type={result.failed.length ? 'warning' : 'success'}
            showIcon
            message={`导入完成：成功解析 ${result.imported.length} 人${result.failed.length ? `，${result.failed.length} 份未能解析` : ''}`}
            description={result.failed.length ? '未解析成功的文件已保留在本批次，可在人员列表中查看原因并重新解析，无需重复上传。' : '可在人员列表中查看详情并确认资料。'}
          />
          {result.imported.length > 0 && (
            <section>
              <Typography.Title level={5}>已导入</Typography.Title>
              <ul className="plain-list">{result.imported.map(item => <li key={item.id}>{item.name === UNKNOWN_NAME ? '姓名待确认' : item.name} · {item.source_filename}</li>)}</ul>
            </section>
          )}
          {result.failed.length > 0 && (
            <section>
              <Typography.Title level={5}>未能解析</Typography.Title>
              <ul className="plain-list">
                {result.failed.map(item => (
                  <li key={item.id}>
                    <Typography.Text strong>{item.source_filename}</Typography.Text>
                    <div className="evidence-text">{item.error_message || '未能读取文件内容'}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </Space>
      )}
    </Modal>
  )
}
