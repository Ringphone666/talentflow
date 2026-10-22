import { UploadOutlined } from '@ant-design/icons'
import { Alert, Button, Descriptions, Drawer, Empty, Input, Modal, Radio, Select, Space, Spin, Steps, Table, Tag, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, send } from '../../api'
import { StatusTag } from '../../components/StatusTag'
import { can, useAdminSession } from '../../lib/access'
import { formatTime } from '../../lib/format'
import { BatchFormModal } from '../library/PersonBatchModals'
import { PersonImportModal } from '../library/PersonImportModal'
import type { ImportOutcome } from '../library/PersonImportModal'
import { IMPORT_LIMIT_FACTOR } from '../library/personModel'
import type { PersonBatch, PersonCategories, PersonImportResult } from '../library/types'
import { MAX_JOBS_PER_TASK, MODES, nameKnown, personName } from './shared'
import type { LibraryJob, LibraryPerson, MatchingMode, PersonBatchDetail, TaskSummary } from './types'
// “导入简历”“新建人员批次”两个窗口来自人员库，沿用人员库的样式。
import '../library/library.css'

const PARSED = '已解析'
/** 上传结果的说明里最多逐个列出的人数；其余只报数量，名单中可以看到全部。 */
const NOTICE_LIMIT = 10

function unavailableReason(person: LibraryPerson): string {
  if (person.status === PARSED) return ''
  if (person.status === '待解析') return '简历正在解析，完成后才能选择'
  return `${person.error_message || '简历解析未成功'}；请在人员库重新解析后再选择`
}

/** 姓名还没有确认的人员用简历文件名辨认。 */
const personLabel = (person: LibraryPerson) => nameKnown(person.name) ? person.name : `${personName({ ...person, code: person.id })}（姓名待确认）`

const batchLabel = (batch: PersonBatch) => `${batch.name} · ${batch.category} · 已解析 ${batch.parsed_count}/${batch.total_count} 人`

/** 上传简历时依次打开的窗口：选择保存到哪个批次 → 新建批次 → 导入简历。 */
type UploadDialog = { kind: 'choose' } | { kind: 'create' } | { kind: 'import'; batch: PersonBatch }

interface UploadNotice {
  type: 'success' | 'warning' | 'error'
  title: string
  lines: string[]
  /** 解析未成功的简历及原因，逐条列出。 */
  failures: string[]
}

/** 把导入结果并入当前名单：已有的人员按最新状态替换，新增的排在后面。 */
function mergePersons(current: LibraryPerson[] | null, rows: LibraryPerson[]): LibraryPerson[] {
  const incoming = new Map(rows.map(row => [row.id, row]))
  const kept = (current || []).map(person => incoming.get(person.id) || person)
  const known = new Set(kept.map(person => person.id))
  return [...kept, ...rows.filter(row => !known.has(row.id))]
}

/** 一次上传结束后的说明。selected 为 false 表示导入的批次不是当前选择的批次，没有自动选中。 */
function resultNotice(result: PersonImportResult, selected: boolean): UploadNotice {
  const parsed = result.imported.filter(person => person.status === PARSED)
  const unparsed = [...result.imported.filter(person => person.status !== PARSED), ...result.failed]
  const names = parsed.slice(0, NOTICE_LIMIT).map(personLabel).join('、')
  const failures = unparsed.slice(0, NOTICE_LIMIT).map(person => `${person.source_filename}：${person.error_message || '未能读取文件内容'}`)
  if (unparsed.length > NOTICE_LIMIT) failures.push(`其余 ${unparsed.length - NOTICE_LIMIT} 份见下方名单`)
  const failedText = unparsed.length ? `；${unparsed.length} 份解析未成功，可在人员库重新解析` : ''
  const where = selected ? '' : `“${result.batch_name}”`

  if (!parsed.length) {
    return {
      type: 'error', lines: [], failures,
      title: unparsed.length
        ? `${where}本次上传的 ${unparsed.length} 份简历解析均未成功，没有新增可以选择的人员；可在人员库重新解析`
        : `${where}本次没有导入简历`,
    }
  }
  const listed = `${names}${parsed.length > NOTICE_LIMIT ? ` 等 ${parsed.length} 人` : ''}`
  if (!selected) {
    return {
      type: unparsed.length ? 'warning' : 'success', failures,
      title: `${where}已导入 ${parsed.length} 份简历${failedText}`,
      lines: [
        `解析成功：${listed}`,
        `当前选择的不是这个批次，这些人员没有自动选中。需要使用时，请把人员批次切换为${where}后勾选。`,
      ],
    }
  }
  return {
    type: unparsed.length ? 'warning' : 'success', failures,
    title: `已导入 ${parsed.length} 份简历并选中${failedText}`,
    lines: [`已选中：${listed}`],
  }
}

/** 还没有选择人员批次时，先确定上传的简历保存到人员库的哪个批次。 */
function UploadTargetModal({ batches, categories, busy, problem, onCancel, onExisting, onCreate }: {
  batches: PersonBatch[]
  /** 新建批次时可选的分类；还没有读取到时为空。 */
  categories: string[]
  busy: boolean
  problem: string
  onCancel: () => void
  onExisting: (batch: PersonBatch) => void
  onCreate: () => void
}) {
  const [target, setTarget] = useState<'existing' | 'create'>('existing')
  const [chosen, setChosen] = useState<string>()
  const [missing, setMissing] = useState(false)

  const confirm = () => {
    if (target === 'create') {
      onCreate()
      return
    }
    const batch = batches.find(item => item.id === chosen)
    if (batch) onExisting(batch)
    else setMissing(true)
  }

  return (
    <Modal
      title="上传简历" open maskClosable={false} okText="下一步" cancelText="取消" confirmLoading={busy}
      onOk={confirm} onCancel={() => { if (!busy) onCancel() }}
    >
      <Typography.Paragraph type="secondary">
        上传的简历会保存到人员库的一个批次中，解析完成后自动选中。请选择保存到哪个批次。
      </Typography.Paragraph>
      {/* 每个选项需要补充的内容紧跟在该选项下面。 */}
      <Radio.Group
        className="matching-upload-target" value={target} disabled={busy}
        onChange={event => { setTarget(event.target.value as 'existing' | 'create'); setMissing(false) }}
      >
        <Radio value="existing">导入到已有批次</Radio>
        {target === 'existing' && (
          <Select
            aria-label="导入到的批次" placeholder="选择要导入到的批次" className="matching-upload-detail" showSearch optionFilterProp="label"
            disabled={busy} status={missing ? 'error' : undefined} value={chosen}
            onChange={value => { setChosen(value); setMissing(false) }}
            options={batches.map(item => ({ value: item.id, label: batchLabel(item) }))}
          />
        )}
        <Radio value="create">新建批次</Radio>
        {target === 'create' && (
          <Typography.Text type="secondary" className="matching-upload-detail">
            下一步填写批次名称，并选择人员分类{categories.length ? `（${categories.join('、')}）` : ''}；批次建好后接着选择要上传的简历。
          </Typography.Text>
        )}
      </Radio.Group>
      {missing && <Alert className="section-row" type="error" showIcon message="请选择要导入到的批次" />}
      {problem && <Alert className="section-row" type="error" showIcon message="暂时不能新建批次" description={<div className="evidence-text">{problem}</div>} />}
    </Modal>
  )
}

/**
 * 新建匹配任务：选择岗位 → 选择人员 → 确认并创建。每次打开都从第一步开始。
 * 人员统一来自人员库：可以从已有批次中选择，也可以在这里直接上传简历——上传的简历保存到人员库的批次，解析完成后自动选中。
 */
export default function CreateTaskDrawer({ mode, maxPeople, onClose, onCreated }: {
  mode: MatchingMode
  maxPeople: number
  onClose: () => void
  onCreated: (task: TaskSummary) => void
}) {
  const session = useAdminSession()
  // 上传的简历要写入人员库，需要人员库的维护权限；没有权限时不显示上传入口。
  const canUpload = can(session, 'person:edit')
  const fit = mode === 'people_to_jobs'
  const [step, setStep] = useState(0)
  const [jobs, setJobs] = useState<LibraryJob[] | null>(null)
  const [batches, setBatches] = useState<PersonBatch[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [jobKeyword, setJobKeyword] = useState('')
  const [jobIds, setJobIds] = useState<string[]>([])
  const [batchId, setBatchId] = useState<string>()
  const [persons, setPersons] = useState<LibraryPerson[] | null>(null)
  const [personsError, setPersonsError] = useState('')
  const [personKeyword, setPersonKeyword] = useState('')
  const [personIds, setPersonIds] = useState<string[]>([])
  const [name, setName] = useState('')
  const [problem, setProblem] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [categories, setCategories] = useState<PersonCategories | null>(null)
  const [dialog, setDialog] = useState<UploadDialog | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [uploadProblem, setUploadProblem] = useState('')
  /** 正在导入简历的批次；导入窗口关闭后，向导里据此显示进行中状态。 */
  const [importing, setImporting] = useState<PersonBatch | null>(null)
  const [notice, setNotice] = useState<UploadNotice | null>(null)
  const batchRequest = useRef(0)
  // 导入在后台进行，结束时要按“此刻”选择的批次处理，不能用开始导入时的值。
  const selectedBatch = useRef<string | undefined>(undefined)
  /** 名单已经读取到的批次；据此区分“刷新未成功但仍有名单可用”和“还没有名单”。 */
  const listedBatch = useRef<string | undefined>(undefined)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  useEffect(() => {
    let disposed = false
    Promise.all([api<LibraryJob[]>('/library/jobs'), api<PersonBatch[]>('/library/person-batches')])
      .then(([jobList, batchList]) => {
        if (disposed) return
        setJobs(jobList.filter(job => job.is_active !== false))
        setBatches(batchList)
      })
      .catch(error => { if (!disposed) setLoadError((error as Error).message) })
    return () => { disposed = true }
  }, [])

  useEffect(() => {
    if (!canUpload) return
    let disposed = false
    api<PersonCategories>('/library/person-categories')
      .then(loaded => { if (!disposed) setCategories(loaded) })
      // 这里读取失败不影响选人；新建批次时会再读取一次，并在那时说明原因。
      .catch(() => undefined)
    return () => { disposed = true }
  }, [canUpload])

  /** 读取批次内的人员名单。quiet：保留现有名单和已选人员，只在读取成功后替换名单。 */
  const loadPersons = async (id: string, quiet = false) => {
    const request = ++batchRequest.current
    if (!quiet) {
      listedBatch.current = undefined
      setPersons(null)
      setPersonsError('')
    }
    try {
      const detail = await api<PersonBatchDetail>(`/library/person-batches/${encodeURIComponent(id)}`)
      if (!alive.current || request !== batchRequest.current) return
      listedBatch.current = id
      setPersons(detail.persons)
      setPersonsError('')
    } catch (error) {
      if (!alive.current || request !== batchRequest.current) return
      // 刷新未成功时保留已有的名单；还没有名单可用时说明原因，由使用者重试。
      if (!quiet || listedBatch.current !== id) setPersonsError((error as Error).message)
    }
  }

  const refreshBatches = async () => {
    try {
      const list = await api<PersonBatch[]>('/library/person-batches')
      if (alive.current) setBatches(list)
    } catch {
      // 保留现有的批次列表；人员名单另行读取。
    }
  }

  const chooseBatch = (id: string) => {
    selectedBatch.current = id
    setBatchId(id)
    setPersonIds([])
    setPersonKeyword('')
    setProblem('')
    setNotice(null)
    return loadPersons(id)
  }

  const clearBatch = () => {
    batchRequest.current += 1
    selectedBatch.current = undefined
    listedBatch.current = undefined
    setBatchId(undefined)
    setPersons(null)
    setPersonsError('')
    setPersonIds([])
    setPersonKeyword('')
    setProblem('')
    setNotice(null)
  }

  /** 打开“新建人员批次”。人员分类还没有读取到时先读取。 */
  const prepareCreate = async () => {
    setUploadProblem('')
    if (categories) {
      setDialog({ kind: 'create' })
      return
    }
    setPreparing(true)
    try {
      const loaded = await api<PersonCategories>('/library/person-categories')
      if (!alive.current) return
      setCategories(loaded)
      setDialog({ kind: 'create' })
    } catch (error) {
      if (alive.current) setUploadProblem(`人员分类未能读取：${(error as Error).message}\n可以再试一次；也可以先到人员库新建批次，再回到这里选择。`)
    } finally {
      if (alive.current) setPreparing(false)
    }
  }

  const startUpload = () => {
    setUploadProblem('')
    setProblem('')
    const current = batches?.find(item => item.id === batchId)
    if (current) setDialog({ kind: 'import', batch: current })
    else if (batches?.length) setDialog({ kind: 'choose' })
    else void prepareCreate()
  }

  const importTo = (target: PersonBatch) => {
    if (target.id !== selectedBatch.current) void chooseBatch(target.id)
    setDialog({ kind: 'import', batch: target })
  }

  const batchCreated = (created: PersonBatch) => {
    setBatches(current => [created, ...(current || []).filter(item => item.id !== created.id)])
    message.success(`批次“${created.name}”已建立，请选择要上传的简历`)
    importTo(created)
    void refreshBatches()
  }

  const importStarted = (target: PersonBatch) => {
    if (!alive.current) return
    setImporting(target)
    setNotice(null)
    void refreshBatches()
    if (target.id === selectedBatch.current) void loadPersons(target.id, true)
  }

  /** 导入结束：刷新批次和名单，选中本次解析成功的人员，并说明结果。导入窗口提前关闭时同样处理。 */
  const importFinished = (target: PersonBatch, outcome: ImportOutcome) => {
    if (!alive.current) return
    setImporting(null)
    setProblem('')
    const current = target.id === selectedBatch.current
    if (outcome.result) {
      const { imported, failed } = outcome.result
      if (current) {
        const parsed = imported.filter(person => person.status === PARSED).map(person => person.id)
        // 先把导入结果并入名单，随后的刷新即使未成功，名单和勾选也是一致的。
        listedBatch.current = target.id
        setPersons(list => mergePersons(list, [...imported, ...failed]))
        setPersonsError('')
        // 与已勾选的人员合并；超过单个任务人数上限时由名单上方的提示说明，不自动去掉任何人。
        setPersonIds(ids => [...new Set([...ids, ...parsed])])
        setPersonKeyword('')
      }
      setNotice(resultNotice(outcome.result, current))
    } else {
      setNotice({
        type: 'error',
        title: current ? '简历导入未完成' : `“${target.name}”的简历导入未完成`,
        lines: [
          `原因：${outcome.error || '处理未完成'}`,
          '请按原因处理后，重新点击“上传简历”。已经保存到人员库的简历会出现在该批次的名单中，不需要重复上传。',
        ],
        failures: [],
      })
    }
    void refreshBatches()
    if (current) void loadPersons(target.id, true)
  }

  const jobProblem = () => {
    if (!jobIds.length) return fit ? '请选择至少两个岗位' : '请选择一个岗位'
    if (fit && jobIds.length < 2) return '人才适岗需要至少选择两个岗位，才能比较人员更适合哪个岗位'
    if (jobIds.length > MAX_JOBS_PER_TASK) return `一个任务最多比较 ${MAX_JOBS_PER_TASK} 个岗位，请取消 ${jobIds.length - MAX_JOBS_PER_TASK} 个后继续`
    return ''
  }
  const overLimit = personIds.length > maxPeople
    ? `已选择 ${personIds.length} 人，超过单个任务上限 ${maxPeople} 人，请取消 ${personIds.length - maxPeople} 人后继续`
    : ''
  const peopleProblem = () => {
    if (importing) return `正在向“${importing.name}”导入并解析简历，完成后会自动选中解析成功的人员，请等待完成后再继续`
    if (!batchId) return canUpload ? '请选择人员批次，或点击“上传简历”直接上传' : '请选择人员批次'
    if (!personIds.length) return '请至少选择一名已解析的人员'
    return overLimit
  }

  const next = () => {
    const found = step === 0 ? jobProblem() : peopleProblem()
    setProblem(found)
    if (!found) setStep(step + 1)
  }
  const back = () => {
    setProblem('')
    setStep(step - 1)
  }
  const submit = async () => {
    const found = jobProblem() || peopleProblem()
    setProblem(found)
    if (found || submitting) return
    setSubmitting(true)
    try {
      const task = await send<TaskSummary>('/matching/tasks', 'POST', {
        mode, job_ids: jobIds, person_batch_id: batchId, person_ids: personIds, name: name.trim(),
      })
      message.success('任务已创建，正在后台分析')
      onCreated(task)
    } catch (error) {
      setProblem((error as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const visibleJobs = useMemo(() => {
    const keyword = jobKeyword.trim().toLowerCase()
    return (jobs || []).filter(job => !keyword || [job.name, job.sequence, job.level].some(value => String(value || '').toLowerCase().includes(keyword)))
  }, [jobs, jobKeyword])
  const visiblePersons = useMemo(() => {
    const keyword = personKeyword.trim().toLowerCase()
    return (persons || []).filter(person => !keyword || [person.name, person.source_filename].some(value => String(value || '').toLowerCase().includes(keyword)))
  }, [persons, personKeyword])
  const parsedPersons = (persons || []).filter(person => person.status === PARSED)
  const batch = batches?.find(item => item.id === batchId)
  const chosenJobs = (jobs || []).filter(job => jobIds.includes(job.id))
  const chosenPersons = (persons || []).filter(person => personIds.includes(person.id))
  const importLimit = categories?.import_limit && categories.import_limit > 0 ? categories.import_limit : maxPeople * IMPORT_LIMIT_FACTOR

  // 表格各列都有宽度，窗口较窄时横向滚动，不把姓名、岗位名称这类列挤窄。
  const jobColumns: ColumnsType<LibraryJob> = [
    { title: '岗位名称', dataIndex: 'name', width: 230, render: (value: string) => <div className="matching-task-name">{value}</div> },
    { title: '岗位类别', dataIndex: 'sequence', width: 140, render: (value: string) => value || '—' },
    { title: '职级', dataIndex: 'level', width: 100, render: (value: string) => value || '—' },
    { title: '硬性条件', dataIndex: 'hard_condition_count', width: 100, render: (value: number) => value ? `${value} 项` : <Typography.Text type="secondary">未设置</Typography.Text> },
    { title: '能力维度', dataIndex: 'dimension_count', width: 130, render: (value: number) => value ? `${value} 项` : <Tag color="orange" className="matching-wrap-tag">未配置，无法评分</Tag> },
    { title: '最近更新', dataIndex: 'updated_at', width: 140, render: (value: string) => formatTime(value) },
  ]
  const personColumns: ColumnsType<LibraryPerson> = [
    { title: '姓名', dataIndex: 'name', width: 150, render: (value: string) => nameKnown(value) ? <div className="matching-task-name">{value}</div> : <Typography.Text type="secondary">姓名待确认</Typography.Text> },
    { title: '简历文件', dataIndex: 'source_filename', width: 230, render: (value: string) => <div className="matching-file-name">{value}</div> },
    { title: '解析状态', dataIndex: 'status', width: 100, render: (value: string) => <StatusTag kind="parse" value={value} /> },
    { title: '资料确认', dataIndex: 'confirmed', width: 96, render: (value: boolean, row) => row.status !== PARSED ? '—' : value ? <Tag color="green">已确认</Tag> : <Tag className="matching-tag-muted">待确认</Tag> },
    {
      title: '说明', key: 'reason', width: 280, render: (_, row) => row.status === PARSED
        ? <Typography.Text type="secondary">可选择</Typography.Text>
        : <div className="evidence-text">不可选择：{unavailableReason(row)}</div>,
    },
  ]
  const widthOf = (columns: Array<{ width?: string | number }>) => 40 + columns.reduce((sum, column) => sum + Number(column.width || 0), 0)

  const jobStep = jobs && !jobs.length ? (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="岗位库中还没有可用的岗位。请先在岗位库新增或导入岗位，并配置能力维度和权重。">
      <Link to="/library/jobs">前往岗位库</Link>
    </Empty>
  ) : (
    <>
      <Typography.Paragraph type="secondary">
        {fit
          ? `选择要比较的岗位（至少 2 个，最多 ${MAX_JOBS_PER_TASK} 个）。每个岗位按各自的能力维度、权重和硬性条件分析。`
          : '选择本次选才的岗位（只能选一个）。系统按该岗位的能力维度、权重和硬性条件分析人员。'}
      </Typography.Paragraph>
      <div className="toolbar">
        <Input.Search allowClear placeholder="按岗位名称、类别或职级筛选" aria-label="筛选岗位" className="matching-search"
          value={jobKeyword} onChange={event => setJobKeyword(event.target.value)} />
        <Typography.Text type="secondary">已选 {jobIds.length} 个岗位</Typography.Text>
      </div>
      <Table<LibraryJob>
        rowKey="id" size="small" loading={!jobs} columns={jobColumns} dataSource={visibleJobs} scroll={{ x: widthOf(jobColumns) }}
        pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
        rowSelection={{
          type: fit ? 'checkbox' : 'radio', selectedRowKeys: jobIds, preserveSelectedRowKeys: true, columnWidth: 40,
          onChange: keys => { setJobIds(keys.map(String)); setProblem('') },
          getCheckboxProps: job => ({ disabled: !job.dimension_count, name: job.name, title: job.dimension_count ? undefined : '该岗位未配置能力维度，无法评分' }),
        }}
      />
    </>
  )

  const uploadButton = (primary: boolean) => canUpload && (
    <Button type={primary ? 'primary' : 'default'} icon={<UploadOutlined />} loading={preparing || Boolean(importing)} onClick={startUpload}>
      {importing ? '正在导入简历' : '上传简历'}
    </Button>
  )
  // 选择保存批次的窗口打开时，原因显示在该窗口里。
  const uploadAlert = uploadProblem && dialog?.kind !== 'choose' && (
    <Alert className="section-row matching-upload-alert" type="error" showIcon message="暂时不能新建批次" description={<div className="evidence-text">{uploadProblem}</div>}
      action={<Button size="small" onClick={() => void prepareCreate()}>重试</Button>} />
  )

  const peopleStep = batches && !batches.length ? (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={canUpload
        ? '人员库中还没有人员批次。可以点击“上传简历”直接上传：先新建一个批次，简历保存到该批次，解析完成后自动选中。'
        : '人员库中还没有人员批次。请先在人员库新建批次并导入简历，解析完成后再来选择。'}
    >
      <Space direction="vertical" size={8}>
        {uploadButton(true)}
        <Link to="/library/persons">前往人员库</Link>
      </Space>
      {uploadAlert}
    </Empty>
  ) : (
    <>
      <Typography.Paragraph type="secondary">
        {canUpload
          ? `选择人员有两种方式：从人员库已有的批次中选择，或者点击“上传简历”直接上传。上传的简历会保存到人员库的批次中，解析完成后自动选中。只有简历已解析的人员可以选择，单个任务最多 ${maxPeople} 人。`
          : `人员来自人员库。先选择批次，再勾选参加本次匹配的人员；只有简历已解析的人员可以选择。单个任务最多 ${maxPeople} 人。需要补充简历时，请联系 HR 管理员在人员库导入。`}
      </Typography.Paragraph>
      <div className="matching-batch-row">
        <Select
          aria-label="选择人员批次" placeholder="选择人员批次" className="matching-batch-select" showSearch optionFilterProp="label"
          // 可以上传时允许清空批次：清空后再点“上传简历”，可以改为导入到其他批次或新建批次。
          allowClear={canUpload}
          loading={!batches} value={batchId} onChange={value => { if (value) void chooseBatch(value); else clearBatch() }}
          options={(batches || []).map(item => ({ value: item.id, label: batchLabel(item) }))}
        />
        {uploadButton(false)}
      </div>
      {canUpload && batch && (
        <Typography.Paragraph type="secondary" className="matching-note">
          “上传简历”会导入到当前批次“{batch.name}”。要导入到其他批次或新建批次，请先清空上面的批次选择。
        </Typography.Paragraph>
      )}
      {uploadAlert}
      {importing && (
        <div className="matching-upload-progress section-row" role="status" aria-live="polite">
          <Spin size="small" />
          <span>正在向“{importing.name}”导入并解析简历，完成后自动选中解析成功的人员。解析需要一些时间，请稍候。</span>
        </div>
      )}
      {notice && (
        <Alert
          className="section-row" type={notice.type} showIcon closable onClose={() => setNotice(null)} message={notice.title}
          description={notice.lines.length || notice.failures.length ? (
            <div className="matching-upload-result">
              {notice.lines.map((line, index) => <div key={`${index}-${line}`} className="evidence-text">{line}</div>)}
              {notice.failures.length > 0 && (
                <>
                  <div>解析未成功的简历：</div>
                  <ul className="plain-list">{notice.failures.map((item, index) => <li key={`${index}-${item}`} className="evidence-text">{item}</li>)}</ul>
                </>
              )}
            </div>
          ) : undefined}
        />
      )}
      {personsError && <Alert className="section-row" type="error" showIcon message="人员名单未能读取" description={personsError}
        action={batchId && <Button size="small" onClick={() => void chooseBatch(batchId)}>重试</Button>} />}
      {batchId && !personsError && (
        <>
          <div className="selection-bar section-row">
            <Typography.Text strong>已选 {personIds.length} 人</Typography.Text>
            <Typography.Text type="secondary">单个任务最多 {maxPeople} 人 · 本批次已解析 {parsedPersons.length} 人</Typography.Text>
            <Button size="small" disabled={!parsedPersons.length} onClick={() => { setPersonIds(parsedPersons.map(person => person.id)); setProblem('') }}>全选已解析</Button>
            <Button size="small" disabled={!personIds.length} onClick={() => setPersonIds([])}>清空选择</Button>
            <Input.Search allowClear size="small" placeholder="按姓名或文件名筛选" aria-label="筛选人员" className="matching-search"
              value={personKeyword} onChange={event => setPersonKeyword(event.target.value)} />
          </div>
          {overLimit && <Alert className="page-alert" type="error" showIcon message={overLimit} />}
          <Table<LibraryPerson>
            rowKey="id" size="small" loading={!persons} columns={personColumns} dataSource={visiblePersons} scroll={{ x: widthOf(personColumns) }}
            pagination={{ pageSize: 50, hideOnSinglePage: true, showSizeChanger: false }}
            locale={{
              emptyText: persons && !persons.length
                ? canUpload ? '该批次还没有人员，请点击“上传简历”导入' : '该批次还没有人员，请先在人员库导入简历'
                : '没有符合筛选条件的人员',
            }}
            rowSelection={{
              selectedRowKeys: personIds, preserveSelectedRowKeys: true, columnWidth: 40,
              onChange: keys => { setPersonIds(keys.map(String)); setProblem('') },
              getCheckboxProps: person => ({ disabled: person.status !== PARSED, name: person.name, title: unavailableReason(person) || undefined }),
            }}
          />
        </>
      )}
    </>
  )

  const confirmStep = (
    <>
      <Descriptions size="small" column={1} bordered items={[
        { key: 'mode', label: '任务类型', children: MODES[mode].title },
        { key: 'jobs', label: `岗位（${chosenJobs.length} 个）`, children: <Space size={[4, 4]} wrap>{chosenJobs.map(job => <Tag key={job.id}>{job.name}</Tag>)}</Space> },
        { key: 'batch', label: '人员批次', children: batch ? `${batch.name} · ${batch.category}` : '—' },
        { key: 'people', label: `人员（${chosenPersons.length} 人）`, children: <span className="evidence-text">{chosenPersons.map(personLabel).join('、')}</span> },
      ]} />
      <div className="section-row">
        <label htmlFor="matching-task-name" className="matching-field-label">任务名称（可选）</label>
        <Input id="matching-task-name" maxLength={100} showCount value={name} onChange={event => setName(event.target.value)}
          placeholder={batch ? `留空时使用人员批次名称“${batch.name}”` : '留空时使用人员批次名称'} />
      </div>
      <Alert className="section-row" type="info" showIcon message="创建后在后台逐人分析"
        description="分析期间可以离开页面，进度会自动更新；分析完成后核对评分依据并做人工复核，复核通过后才能导出正式报告。硬性条件只作核验提示，不会筛掉人员，也不改变得分。" />
    </>
  )

  return (
    <>
      <Drawer
        open title={`新建${MODES[mode].title}任务`} width="min(960px, 100vw)" onClose={() => { if (!submitting) onClose() }}
        footer={(
          <div className="matching-drawer-footer">
            <Button onClick={onClose} disabled={submitting}>取消</Button>
            <Space>
              {step > 0 && <Button onClick={back} disabled={submitting}>上一步</Button>}
              {step < 2
                ? <Button type="primary" onClick={next} disabled={Boolean(loadError) || !jobs || !batches}>下一步</Button>
                : <Button type="primary" loading={submitting} onClick={() => void submit()}>创建并开始分析</Button>}
            </Space>
          </div>
        )}
      >
        <Steps className="matching-steps" size="small" current={step} items={[
          { title: '选择岗位' }, { title: '选择人员' }, { title: '确认并创建' },
        ]} />
        {loadError
          ? <Alert type="error" showIcon message="岗位库或人员库未能读取" description={loadError} />
          : !jobs || !batches
            ? <div className="matching-loading"><Spin /><span>正在读取岗位库和人员库…</span></div>
            : step === 0 ? jobStep : step === 1 ? peopleStep : confirmStep}
        {problem && <Alert className="section-row" type="error" showIcon message={problem} />}
      </Drawer>
      {/* 上传用到的窗口放在抽屉之外：窗口里的按键（如 Esc）不会被抽屉当作“关闭向导”。 */}
      {dialog?.kind === 'choose' && (
        <UploadTargetModal
          batches={batches || []} categories={categories?.selectable || []} busy={preparing} problem={uploadProblem}
          onCancel={() => { setDialog(null); setUploadProblem('') }}
          onExisting={importTo}
          onCreate={() => void prepareCreate()}
        />
      )}
      {dialog?.kind === 'create' && categories && (
        <BatchFormModal batch={null} categories={categories.selectable} onClose={() => setDialog(null)} onSaved={batchCreated} />
      )}
      {dialog?.kind === 'import' && (
        <PersonImportModal
          // 换了批次就是另一次导入，不沿用上一次选的文件。
          key={dialog.batch.id}
          batch={dialog.batch}
          limit={importLimit}
          onClose={() => setDialog(null)}
          onStarted={() => importStarted(dialog.batch)}
          onFinished={outcome => importFinished(dialog.batch, outcome)}
        />
      )}
    </>
  )
}
