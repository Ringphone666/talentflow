import { DeleteOutlined, DownOutlined, DownloadOutlined, EditOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, UploadOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Checkbox, Col, DatePicker, Dropdown, Empty, Input, List, Row, Select, Space, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { Dayjs } from 'dayjs'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, download, openFile, send } from '../../api'
import type { Operation } from '../../api'
import { PageHeader } from '../../components/PageHeader'
import { ReservedEntry } from '../../components/ReservedEntry'
import { StatusTag } from '../../components/StatusTag'
import { can, useAdminSession } from '../../lib/access'
import { formatTime, parseTime } from '../../lib/format'
import { BatchFormModal, DeleteBatchesModal, RetryModal } from './PersonBatchModals'
import { PersonDetailDrawer } from './PersonDetailDrawer'
import { PersonImportModal } from './PersonImportModal'
import type { ImportOutcome } from './PersonImportModal'
import { FeedbackProvider, useFeedback } from './feedback'
import { followOperation, polling } from './operations'
import { IMPORT_LIMIT_FACTOR, UNKNOWN_NAME, categoryColors, operatorName } from './personModel'
import type { PersonBatch, PersonBatchDetail, PersonCategories, PersonRow } from './types'
import './library.css'

interface PageNotice {
  type: 'success' | 'warning' | 'error'
  title: string
  text?: string
}

type ExportKind = 'resumes' | 'profiles' | 'csv'

const exportNames: Record<ExportKind, string> = { resumes: '简历原件', profiles: '简历资料报告', csv: '人员明细.csv' }
const idleRetry = { busy: false, progress: '', error: '' }
/** 后端对列表中的摘要最多返回 120 个字，达到这个长度时提示到详情中看全文。 */
const SUMMARY_LIMIT = 120

function Summary({ label, text }: { label: string; text: string }) {
  if (!text) return null
  return (
    <div className="evidence-text person-summary-line">
      <Typography.Text type="secondary">{label}：</Typography.Text>{text}
      {text.length >= SUMMARY_LIMIT && <Typography.Text type="secondary">……（完整内容见详情）</Typography.Text>}
    </div>
  )
}

function PersonLibrary() {
  const session = useAdminSession()
  const canEdit = can(session, 'person:edit')
  // 简历原件、资料报告和明细的导出，后端都要求具备导出权限的角色。
  const canExport = can(session, 'matching:export')
  const { message } = useFeedback()
  const [params, setParams] = useSearchParams()
  const [batches, setBatches] = useState<PersonBatch[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [categories, setCategories] = useState<PersonCategories | null>(null)
  const [limit, setLimit] = useState<number | null>(null)
  const [selectedId, setSelectedId] = useState<string | undefined>(() => params.get('batch') || undefined)
  const [detail, setDetail] = useState<PersonBatchDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [checked, setChecked] = useState<string[]>([])
  const [selectedPersons, setSelectedPersons] = useState<string[]>([])
  const [batchKeyword, setBatchKeyword] = useState('')
  const [batchCategory, setBatchCategory] = useState<string>()
  const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null)
  const [personKeyword, setPersonKeyword] = useState('')
  const [personStatus, setPersonStatus] = useState<string>()
  const [batchForm, setBatchForm] = useState<{ batch: PersonBatch | null } | null>(null)
  const [deleting, setDeleting] = useState<PersonBatch[] | null>(null)
  const [importing, setImporting] = useState<PersonBatch | null>(null)
  const [viewing, setViewing] = useState<string | null>(() => params.get('person'))
  const [retrying, setRetrying] = useState<PersonRow | null>(null)
  const [retryState, setRetryState] = useState(idleRetry)
  const [notice, setNotice] = useState<PageNotice | null>(null)
  const [exporting, setExporting] = useState<ExportKind | ''>('')
  const wanted = useRef<string | undefined>(selectedId)

  const loadBatches = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const rows = await api<PersonBatch[]>('/library/person-batches')
      setBatches(rows)
      setLoadError('')
      setSelectedId(current => rows.some(item => item.id === current) ? current : rows[0]?.id)
      setChecked(current => current.filter(id => rows.some(item => item.id === id)))
    } catch (e) {
      if (!quiet) setLoadError((e as Error).message)
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [])

  const loadDetail = useCallback(async (id: string, quiet = false) => {
    wanted.current = id
    if (!quiet) setDetailLoading(true)
    try {
      const data = await api<PersonBatchDetail>(`/library/person-batches/${id}`)
      if (wanted.current !== id) return
      setDetail(data)
      setDetailError('')
    } catch (e) {
      if (wanted.current === id && !quiet) setDetailError((e as Error).message)
    } finally {
      if (wanted.current === id && !quiet) setDetailLoading(false)
    }
  }, [])

  const reload = useCallback(async (quiet = true) => {
    await Promise.all([loadBatches(quiet), wanted.current ? loadDetail(wanted.current, quiet) : Promise.resolve()])
  }, [loadBatches, loadDetail])

  useEffect(() => { void loadBatches() }, [loadBatches])

  useEffect(() => {
    api<PersonCategories>('/library/person-categories')
      .then(setCategories)
      .catch(e => setNotice({ type: 'error', title: '人员分类加载失败', text: (e as Error).message }))
  }, [])

  const providedLimit = categories?.import_limit
  const canSeeMatching = can(session, 'matching:view')
  useEffect(() => {
    if (!canEdit) return
    if (typeof providedLimit === 'number' && providedLimit > 0) { setLimit(providedLimit); return }
    if (!canSeeMatching) return
    let disposed = false
    api<{ max_people: number }>('/matching/options')
      .then(options => { if (!disposed && options.max_people > 0) setLimit(options.max_people * IMPORT_LIMIT_FACTOR) })
      .catch(() => undefined)
    return () => { disposed = true }
  }, [canEdit, canSeeMatching, providedLimit])

  useEffect(() => {
    setSelectedPersons([])
    setPersonKeyword('')
    setPersonStatus(undefined)
    if (!selectedId) {
      wanted.current = undefined
      setDetail(null)
      return
    }
    setDetail(current => current?.id === selectedId ? current : null)
    void loadDetail(selectedId)
  }, [selectedId, loadDetail])

  // 有简历正在解析时自动刷新，直到全部结束。
  const pending = detail?.pending_count || 0
  useEffect(() => {
    if (!pending) return
    const timer = window.setInterval(() => { void reload() }, polling.pendingMs)
    return () => window.clearInterval(timer)
  }, [pending, reload])

  const closePerson = () => {
    setViewing(null)
    if (params.has('person')) {
      const next = new URLSearchParams(params)
      next.delete('person')
      setParams(next, { replace: true })
    }
  }

  const batchCategories = useMemo(() => {
    const known = categories?.all || []
    const used = batches.map(item => item.category).filter(Boolean)
    return [...new Set([...known.filter(item => item !== '未分类' || used.includes(item)), ...used])]
  }, [categories, batches])

  const visibleBatches = useMemo(() => {
    const text = batchKeyword.trim().toLowerCase()
    const from = dateRange?.[0]?.startOf('day').valueOf()
    const to = dateRange?.[1]?.endOf('day').valueOf()
    return batches.filter(item => {
      if (text && !item.name.toLowerCase().includes(text)) return false
      if (batchCategory && item.category !== batchCategory) return false
      const created = parseTime(item.created_at)?.getTime()
      if (from !== undefined && (created === undefined || created < from)) return false
      if (to !== undefined && (created === undefined || created > to)) return false
      return true
    })
  }, [batches, batchKeyword, batchCategory, dateRange])

  const persons = useMemo(() => detail?.persons || [], [detail])
  const visiblePersons = useMemo(() => {
    const text = personKeyword.trim().toLowerCase()
    return persons.filter(item => (!text || `${item.name} ${item.source_filename}`.toLowerCase().includes(text)) && (!personStatus || item.status === personStatus))
  }, [persons, personKeyword, personStatus])
  const chosen = selectedPersons.filter(id => persons.some(item => item.id === id))

  const exportPersons = async (kind: ExportKind) => {
    if (!detail) return
    const query = new URLSearchParams({ kind })
    if (chosen.length) query.set('ids', chosen.join(','))
    setExporting(kind)
    try {
      await download(`/library/person-batches/${detail.id}/export?${query.toString()}`, `${detail.name}_${exportNames[kind]}`)
    } catch (e) {
      setNotice({ type: 'error', title: '导出未完成', text: (e as Error).message })
    } finally {
      setExporting('')
    }
  }

  const viewFile = async (person: PersonRow) => {
    try {
      await openFile(`/library/persons/${person.id}/file`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const retry = async (allowOcr: boolean) => {
    const person = retrying
    if (!person) return
    setRetryState({ busy: true, progress: '正在提交…', error: '' })
    try {
      const operation = await send<Operation<PersonRow>>(`/library/persons/${person.id}/retry?allow_ocr=${allowOcr ? 'true' : 'false'}`, 'POST')
      void reload()
      const row = await followOperation(operation, text => setRetryState(current => ({ ...current, progress: text })))
      await reload()
      if (row?.status === '解析失败') {
        setRetryState({ busy: false, progress: '', error: row.error_message || '仍未能解析，请检查原始简历后重试' })
        return
      }
      setRetrying(null)
      setRetryState(idleRetry)
      message.success(`${person.source_filename} 已重新解析`)
    } catch (e) {
      setRetryState({ busy: false, progress: '', error: (e as Error).message })
      void reload()
    }
  }

  const importFinished = (outcome: ImportOutcome) => {
    void reload()
    if (!outcome.background) return
    if (outcome.error) {
      setNotice({ type: 'error', title: '简历导入未完成', text: outcome.error })
    } else if (outcome.result) {
      const { imported, failed, batch_name: name } = outcome.result
      setNotice({
        type: failed.length ? 'warning' : 'success',
        title: `“${name}”导入完成：成功解析 ${imported.length} 人${failed.length ? `，${failed.length} 份未能解析` : ''}`,
        text: failed.length ? '未解析成功的文件已保留在批次中，可在人员列表中查看原因并重新解析。' : undefined,
      })
    }
  }

  const columns: ColumnsType<PersonRow> = [
    { title: '姓名', dataIndex: 'name', width: 104, render: (value: string) => value === UNKNOWN_NAME ? <Typography.Text type="secondary">姓名待确认</Typography.Text> : <Typography.Text strong className="job-name">{value}</Typography.Text> },
    { title: '简历文件', dataIndex: 'source_filename', render: (value: string) => <span className="evidence-text">{value}</span> },
    { title: '解析状态', dataIndex: 'status', width: 88, render: (value: string) => <StatusTag kind="parse" value={value} /> },
    { title: '资料确认', dataIndex: 'confirmed', width: 88, render: (value: boolean) => <Tag color={value ? 'green' : 'gold'}>{value ? '已确认' : '待确认'}</Tag> },
    { title: '导入时间', dataIndex: 'created_at', width: 140, render: (value: string) => <span className="nowrap">{formatTime(value)}</span> },
    {
      // 操作列固定在右侧：表格需要横向滚动时，摘要和未完成原因仍按可见宽度完整换行显示。
      title: '操作', key: 'actions', fixed: 'right', width: 112,
      render: (_, row) => (
        <Space size={0} direction="vertical" className="row-actions">
          <Button type="link" size="small" onClick={() => setViewing(row.id)}>查看详情</Button>
          <Button type="link" size="small" onClick={() => void viewFile(row)}>查看原始简历</Button>
          {canEdit && row.status !== '待解析' && row.material_version === 0 && (
            <Button type="link" size="small" onClick={() => { setRetryState(idleRetry); setRetrying(row) }}>重新解析</Button>
          )}
        </Space>
      ),
    },
  ]

  // 学历和工作经历摘要、解析未完成的原因占整行显示，不挤在窄列里。
  const hasDetailRow = (row: PersonRow) => Boolean(row.education || row.work_experience || (row.status === '解析失败' && row.error_message))
  const detailRow = (row: PersonRow) => (
    <div className="person-detail-row">
      {row.status === '解析失败' && row.error_message && (
        <Alert
          type="error"
          showIcon
          message={`${row.source_filename} 未能解析`}
          description={<div className="evidence-text">{row.error_message}{canEdit && row.material_version === 0 ? '\n可检查原始简历后点击“重新解析”；扫描件需确认文字识别授权。' : ''}</div>}
        />
      )}
      <Summary label="学历" text={row.education} />
      <Summary label="工作经历" text={row.work_experience} />
    </div>
  )

  const selected = batches.find(item => item.id === selectedId)
  const current = detail && detail.id === selectedId ? detail : null
  const batchFiltered = Boolean(batchKeyword.trim() || batchCategory || dateRange)
  const personFiltered = Boolean(personKeyword.trim() || personStatus)
  const exportScope = chosen.length ? `所选 ${chosen.length} 人` : '整个批次'

  return (
    <>
      <PageHeader
        title="人员库"
        description="按批次管理人员简历资料，人岗匹配与AI面试共用。"
        actions={canEdit ? (
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setBatchForm({ batch: null })}>新建批次</Button>
            <ReservedEntry integration="organization_persons" label="从组织架构选择人员" />
          </Space>
        ) : undefined}
      />
      {loadError && <Alert className="page-alert" type="error" showIcon message="人员批次加载失败" description={loadError} action={<Button size="small" onClick={() => void loadBatches()}>重新加载</Button>} />}
      {notice && <Alert className="page-alert" type={notice.type} showIcon closable onClose={() => setNotice(null)} message={notice.title} description={notice.text ? <div className="evidence-text">{notice.text}</div> : undefined} />}

      {!loading && !loadError && !batches.length ? (
        <Card>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="人员库还没有人员批次">
            <Typography.Paragraph type="secondary">
              {canEdit
                ? '第一步：新建人员批次，选择社招、校招或内聘；第二步：向批次导入简历，系统自动解析人员资料。'
                : '人员批次由 HR 管理员建立并导入简历，导入后这里会显示人员资料。'}
            </Typography.Paragraph>
            {canEdit && <Button type="primary" icon={<PlusOutlined />} onClick={() => setBatchForm({ batch: null })}>新建第一个批次</Button>}
          </Empty>
        </Card>
      ) : (
        <Row gutter={[16, 16]} align="top">
          <Col xs={24} xl={8} xxl={6}>
            <Card title="人员批次" className="batch-panel" loading={loading && !batches.length} extra={<Typography.Text type="secondary">共 {batches.length} 个</Typography.Text>}>
              <Space direction="vertical" size={8} className="full-width">
                <Input allowClear aria-label="搜索批次" prefix={<SearchOutlined />} placeholder="搜索批次名称" value={batchKeyword} onChange={event => setBatchKeyword(event.target.value)} />
                <div className="batch-filters">
                  <Select
                    allowClear
                    aria-label="按分类筛选批次"
                    placeholder="全部分类"
                    value={batchCategory}
                    onChange={value => setBatchCategory(value)}
                    options={batchCategories.map(item => ({ value: item, label: item }))}
                  />
                  <DatePicker.RangePicker
                    aria-label="按导入日期筛选批次"
                    allowEmpty={[true, true]}
                    placeholder={['导入日期起', '导入日期止']}
                    value={dateRange}
                    onChange={value => setDateRange(value && (value[0] || value[1]) ? [value[0], value[1]] : null)}
                  />
                </div>
              </Space>
              {canEdit && checked.length > 0 && (
                <div className="selection-bar section-row">
                  <span>已选 {checked.length} 个批次</span>
                  <Button danger size="small" onClick={() => setDeleting(batches.filter(item => checked.includes(item.id)))}>删除所选</Button>
                  <Button type="link" size="small" onClick={() => setChecked([])}>清空选择</Button>
                </div>
              )}
              <List
                className="batch-list"
                dataSource={visibleBatches}
                pagination={visibleBatches.length > 10 ? { pageSize: 10, size: 'small', showSizeChanger: false } : false}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={batchFiltered ? '没有符合条件的批次' : '暂无批次'} /> }}
                renderItem={batch => (
                  <List.Item className={`batch-item${batch.id === selectedId ? ' active' : ''}`}>
                    {canEdit && (
                      <Checkbox
                        aria-label={`选择批次 ${batch.name}`}
                        checked={checked.includes(batch.id)}
                        onChange={event => setChecked(items => event.target.checked ? [...items, batch.id] : items.filter(id => id !== batch.id))}
                      />
                    )}
                    <button type="button" className="library-batch-select" aria-pressed={batch.id === selectedId} onClick={() => setSelectedId(batch.id)}>
                      <span className="batch-title">
                        <span className="batch-name">{batch.name}</span>
                        <Tag color={categoryColors[batch.category] || 'default'}>{batch.category}</Tag>
                      </span>
                      <span className="batch-counts">
                        <span>共 {batch.total_count} 人</span>
                        <span>已解析 {batch.parsed_count}</span>
                        <span>未能解析 {batch.failed_count}</span>
                        <span>解析中 {batch.pending_count}</span>
                      </span>
                      <span className="library-batch-meta">{formatTime(batch.created_at)} 建立 · {operatorName(batch.created_by)}</span>
                    </button>
                    {canEdit && (
                      <Space size={0} className="library-batch-actions">
                        <Button type="text" size="small" icon={<EditOutlined />} title="修改名称与分类" aria-label={`修改批次 ${batch.name}`} onClick={() => setBatchForm({ batch })} />
                        <Button type="text" size="small" danger icon={<DeleteOutlined />} title="删除批次" aria-label={`删除批次 ${batch.name}`} onClick={() => setDeleting([batch])} />
                      </Space>
                    )}
                  </List.Item>
                )}
              />
            </Card>
          </Col>
          <Col xs={24} xl={16} xxl={18}>
            <Card
              className="person-panel"
              title={selected ? <Space wrap size={8}><span className="batch-name">{selected.name}</span><Tag color={categoryColors[selected.category] || 'default'}>{selected.category}</Tag></Space> : '人员'}
              extra={selected ? (
                <Space wrap>
                  {canEdit && <Button type="primary" icon={<UploadOutlined />} onClick={() => setImporting(selected)}>导入简历</Button>}
                  {canExport && persons.length > 0 && (
                    <Dropdown
                      trigger={['click']}
                      menu={{
                        items: [
                          { key: 'resumes', label: `导出简历原件（${exportScope}）` },
                          { key: 'profiles', label: `导出简历资料报告（${exportScope}）` },
                          { key: 'csv', label: `导出人员明细 CSV（${exportScope}）` },
                        ],
                        onClick: ({ key }) => void exportPersons(key as ExportKind),
                      }}
                    >
                      <Button icon={<DownloadOutlined />} loading={Boolean(exporting)}>导出 <DownOutlined /></Button>
                    </Dropdown>
                  )}
                  <Button icon={<ReloadOutlined />} onClick={() => void reload(false)}>刷新</Button>
                </Space>
              ) : undefined}
            >
              {detailError && <Alert className="page-alert" type="error" showIcon message="人员列表加载失败" description={detailError} action={selectedId ? <Button size="small" onClick={() => void loadDetail(selectedId)}>重新加载</Button> : undefined} />}
              {!selected ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请在左侧选择一个批次" /> : (
                <>
                  <Typography.Paragraph type="secondary">
                    共 {current?.total_count ?? selected.total_count} 人 · 已解析 {current?.parsed_count ?? selected.parsed_count} · 未能解析 {current?.failed_count ?? selected.failed_count} · 解析中 {current?.pending_count ?? selected.pending_count}
                    {pending > 0 && '（解析完成后自动刷新）'}
                  </Typography.Paragraph>
                  {current && !persons.length ? (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该批次还没有人员">
                      <Typography.Paragraph type="secondary">
                        {canEdit ? '导入简历后，系统自动解析每个人的学历、工作经历等资料。' : '请联系 HR 管理员向该批次导入简历。'}
                      </Typography.Paragraph>
                      {canEdit && <Button type="primary" icon={<UploadOutlined />} onClick={() => setImporting(selected)}>导入简历</Button>}
                    </Empty>
                  ) : (
                    <>
                      <div className="toolbar">
                        <Space wrap>
                          <Input allowClear aria-label="搜索人员" className="library-search" prefix={<SearchOutlined />} placeholder="搜索姓名或简历文件名" value={personKeyword} onChange={event => setPersonKeyword(event.target.value)} />
                          <Select
                            allowClear
                            aria-label="按解析状态筛选"
                            className="library-filter"
                            placeholder="全部解析状态"
                            value={personStatus}
                            onChange={value => setPersonStatus(value)}
                            options={[{ value: '已解析', label: '已解析' }, { value: '解析失败', label: '解析失败' }, { value: '待解析', label: '解析中' }]}
                          />
                        </Space>
                        {canExport && <Typography.Text type="secondary">勾选人员后导出所选，未勾选时导出整个批次</Typography.Text>}
                      </div>
                      {chosen.length > 0 && (
                        <div className="selection-bar">
                          <span>已选 {chosen.length} 人</span>
                          <Button type="link" size="small" onClick={() => setSelectedPersons([])}>清空选择</Button>
                        </div>
                      )}
                      <Table<PersonRow>
                        rowKey="id"
                        className="library-table person-table"
                        size="middle"
                        loading={detailLoading}
                        dataSource={visiblePersons}
                        columns={columns}
                        scroll={{ x: 720 }}
                        rowSelection={canExport ? { selectedRowKeys: selectedPersons, preserveSelectedRowKeys: true, onChange: keys => setSelectedPersons(keys.map(String)) } : undefined}
                        expandable={{
                          showExpandColumn: false,
                          expandedRowKeys: visiblePersons.filter(hasDetailRow).map(item => item.id),
                          rowExpandable: hasDetailRow,
                          expandedRowRender: detailRow,
                        }}
                        pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false, showTotal: total => `共 ${total} 人` }}
                        locale={{ emptyText: detailLoading ? ' ' : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={personFiltered ? '没有符合条件的人员' : '暂无人员'} /> }}
                      />
                    </>
                  )}
                </>
              )}
            </Card>
          </Col>
        </Row>
      )}

      {batchForm && categories && (
        <BatchFormModal
          batch={batchForm.batch}
          categories={categories.selectable}
          onClose={() => setBatchForm(null)}
          onSaved={(batch, created) => {
            setBatchForm(null)
            message.success(created ? `批次“${batch.name}”已建立，可以导入简历了` : '批次名称与分类已保存')
            if (created) setSelectedId(batch.id)
            void reload()
          }}
        />
      )}
      {deleting && (
        <DeleteBatchesModal
          batches={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={result => {
            setDeleting(null)
            setChecked([])
            message.success(`已删除 ${result.deleted_batches} 个批次、${result.deleted_entries} 份人员资料`)
            void reload()
          }}
        />
      )}
      {importing && (
        <PersonImportModal
          batch={importing}
          limit={limit}
          onClose={() => setImporting(null)}
          onStarted={() => void reload()}
          onFinished={importFinished}
        />
      )}
      {retrying && (
        <RetryModal
          person={retrying}
          busy={retryState.busy}
          progress={retryState.progress}
          error={retryState.error}
          onClose={() => { setRetrying(null); setRetryState(idleRetry) }}
          onConfirm={allowOcr => void retry(allowOcr)}
        />
      )}
      {viewing && <PersonDetailDrawer key={viewing} personId={viewing} onClose={closePerson} onChanged={() => void reload()} />}
    </>
  )
}

export default function PersonLibraryPage() {
  return <FeedbackProvider><PersonLibrary /></FeedbackProvider>
}
