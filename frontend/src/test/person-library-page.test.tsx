import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PersonLibraryPage from '../pages/library/PersonLibraryPage'
import { polling } from '../pages/library/operations'
import type { Session } from '../types'

interface Call {
  method: string
  path: string
  query: URLSearchParams
  body: Record<string, unknown> | undefined
  form: FormData | null
}
type Handler = (call: Call) => Response | undefined | Promise<Response | undefined>

// 机器繁忙时页面响应会变慢，等待界面变化的时间放宽到 5 秒。
configure({ asyncUtilTimeout: 5000 })

const calls: Call[] = []
const unexpected: string[] = []
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL
const originalPolling = { ...polling }
const AUTHORISATION = '扫描页需要发送到文字识别服务处理，我确认已获得授权'

/**
 * jsdom 每次计算样式都要遍历全部样式表，Ant Design 的表单和弹窗会因此慢到超时。
 * 这里的断言只关心文字和请求，样式只读取元素自身的内联样式。
 */
const styleDefaults: Record<string, string> = {
  'box-sizing': 'border-box', 'padding-top': '0px', 'padding-bottom': '0px', 'border-top-width': '0px', 'border-bottom-width': '0px',
}
function inlineStyleOf(element: Element): CSSStyleDeclaration {
  return new Proxy((element as HTMLElement).style, {
    get(target, property) {
      if (property === 'getPropertyValue') return (name: string) => target.getPropertyValue(name) || styleDefaults[name] || ''
      const value = Reflect.get(target, property) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

const sessionWith = (permissions: string[], role: Session['role'] = 'hr_admin'): Session => ({
  access_token: 'test-token', expires_at: 4102444800, username: 'hr', display_name: 'HR管理员', role, role_label: 'HR管理员', permissions,
})
const editor = sessionWith(['person:read', 'person:edit', 'matching:view', 'matching:review', 'matching:export'])
const interviewer = sessionWith(['person:read', 'matching:view', 'matching:review'], 'interviewer')
const businessUser = sessionWith(['person:read', 'matching:view', 'matching:review', 'matching:export'], 'business_user')

const batch = (patch: Record<string, unknown>) => ({
  id: 'TLB-SOCIAL01', name: '2026年秋季社招第一批', category: '社招', created_by: '招聘人员｜hr_admin',
  created_at: '2026-09-18T09:00:00+08:00', updated_at: '2026-09-18T09:30:00+08:00',
  total_count: 3, parsed_count: 2, failed_count: 1, pending_count: 0,
  ...patch,
})
const batches = [
  batch({}),
  batch({ id: 'TLB-INNER002', name: '制造车间主任内部竞聘', category: '内聘', total_count: 0, parsed_count: 0, failed_count: 0 }),
  batch({ id: 'TLB-LEG-0003', name: '历史导入批次', category: '未分类', created_by: '历史资料迁移', total_count: 2, parsed_count: 2, failed_count: 0 }),
]
const person = (patch: Record<string, unknown>) => ({
  id: 'TLE-0001', batch_id: 'TLB-SOCIAL01', name: '张三', source_filename: '张三.pdf', status: '已解析', parse_status: '待人工确认',
  confirmed: false, error_message: '', created_at: '2026-09-18T09:10:00+08:00', updated_at: '2026-09-18T09:12:00+08:00',
  material_version: 0, education: '示例大学 本科 工业工程', work_experience: '某制造业公司生产主管，负责装配与加工管理',
  ...patch,
})
const scannedFailure = '李四.pdf 的第 2、3 页是扫描页，导入时未确认文字识别授权，未能读取这些页面的内容，请确认授权后重新解析'
const persons = [
  person({}),
  person({ id: 'TLE-0002', name: '待人工确认', source_filename: '李四.pdf', status: '解析失败', parse_status: '无法可靠解析，请人工确认', error_message: scannedFailure, education: '', work_experience: '' }),
  person({ id: 'TLE-0003', name: '王五', source_filename: '王五.docx', parse_status: '人工已复核', confirmed: true, material_version: 2, education: '四川大学 硕士 食品科学', work_experience: '质量管理部 质量工程师' }),
]
const longEvidence = '2019年7月至2024年8月在某制造业公司任生产主管，负责装配、加工和检验工段的日常生产组织；牵头完成产线管理标准化项目，良品率提升约3个百分点；带领12人班组连续三年无安全事故。'
const personDetail = {
  ...persons[0],
  profile: {
    person_id: 'TLE-0001', batch_id: 'TLB-SOCIAL01', name: '张三', source_filename: '张三.pdf', status: '已解析', parse_status: '待人工确认',
    confirmed: false, material_version: 0,
    fields: [
      { key: 'education', label: '教育经历', value: '示例大学 本科 工业工程', status: '待人工确认', source_file: '张三.pdf', location: '第1页' },
      { key: 'work_experience', label: '工作经历', value: '某制造业公司生产主管，负责装配与加工管理', status: '待人工确认', source_file: '张三.pdf', location: '第1页' },
      { key: 'tenure', label: '任职时间', value: '', status: '待人工确认', source_file: '', location: '' },
      { key: 'skills', label: '专业技能', value: '装配、加工、检验', status: '待人工确认', source_file: '张三.pdf', location: '第2页' },
      { key: 'projects', label: '项目经历', value: '', status: '待人工确认', source_file: '', location: '' },
      { key: 'interview_evaluation', label: '面试评价与纪要', value: '', status: '待人工确认', source_file: '', location: '' },
      { key: 'additional_material', label: '补充资料', value: '', status: '待人工确认', source_file: '', location: '' },
    ],
  },
  editable_fields: [
    { key: 'education', label: '教育经历' }, { key: 'work_experience', label: '工作经历' }, { key: 'projects', label: '项目经历' },
    { key: 'skills', label: '专业技能' }, { key: 'tenure', label: '任职时间' }, { key: 'interview_evaluation', label: '面试评价与纪要' },
    { key: 'additional_material', label: '补充资料' },
  ],
  warning: '第2页有一处表格未能完整读取，请对照原始简历核对',
  evidence: [
    { text: longEvidence, file: '张三.pdf', location: '第1页', origin: '' },
    { text: '人工核实专业技能：装配、加工、检验。该记录为当前人工修正，不视为原文。', file: '人工核实记录', location: '字段：专业技能；资料版本1', origin: 'human_review' },
  ],
  evidence_total: 2,
  can_edit: true,
  matching_history: [{
    task_id: 'TASK-001', task_name: '制造储备岗九月选才', mode: 'job_to_people', candidate_id: 'CAND-009', job_name: '制造生产储备岗',
    total: 82.5, conclusion: '高度匹配', review_status: '待审核', decision: null, updated_at: '2026-09-19T10:00:00+08:00',
  }],
  interviews: [{
    candidate_id: 7, candidate_code: 'C-007', batch_name: '九月初筛', job_name: '制造生产储备岗',
    interview_status: 'completed', report_status: 'pending_review', match_score: 78,
  }],
}
const integrations = [{
  key: 'organization_persons', name: '从组织架构选择人员', target: '人员库', system: '组织架构 / 人员主数据',
  pending: '组织人员数据适配器未配置，需实现数据协议与鉴权后启用', alternative: '目前可按批次上传简历导入人员',
  status: 'pending_interface', status_label: '待对接', available: false,
}]

const base: Handler = ({ method, path }) => {
  if (method !== 'GET') return undefined
  if (path === '/library/person-batches') return Response.json(batches)
  if (path === '/library/person-categories') return Response.json({ selectable: ['社招', '校招', '内聘'], all: ['校招', '社招', '内聘', '未分类'] })
  if (path === '/matching/options') return Response.json({ max_people: 20 })
  if (path === '/library/person-batches/TLB-SOCIAL01') return Response.json({ ...batches[0], persons })
  if (path === '/library/person-batches/TLB-INNER002') return Response.json({ ...batches[1], persons: [] })
  if (path === '/library/persons/TLE-0001') return Response.json(personDetail)
  if (path === '/library/integrations') return Response.json(integrations)
  return undefined
}

function mockApi(handler: Handler = () => undefined) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    const raw = init?.body
    const call: Call = {
      method: (init?.method || 'GET').toUpperCase(),
      path: url.pathname.replace(/^\/api/, ''),
      query: url.searchParams,
      body: typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : undefined,
      form: raw instanceof FormData ? raw : null,
    }
    calls.push(call)
    const response = await handler(call) ?? await base(call)
    if (response) return response
    unexpected.push(`${call.method} ${call.path}`)
    return Response.json({ detail: '测试未准备这个接口' }, { status: 500 })
  })
}

function renderPage(session: Session, entry = '/library/persons') {
  const Layout = () => <Outlet context={{ session }} />
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/library/persons" element={<PersonLibraryPage />} />
          <Route path="/matching/tasks/:taskId" element={<div>匹配任务详情页</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

const sent = (method: string, path: string | RegExp) => calls.filter(call => call.method === method && (typeof path === 'string' ? call.path === path : path.test(call.path)))
const rowOf = async (text: string) => (await screen.findByText(text)).closest('tr') as HTMLElement
const file = (name: string, type = 'application/pdf') => new File(['resume content'], name, { type })
const fileNames = (form: FormData | null, field: string) => (form?.getAll(field) as File[]).map(item => item.name)
const operation = (patch: Record<string, unknown>) => ({ id: 'op-1', kind: 'person_import', label: '', status: 'running', progress: '', result: null, error: '', ...patch })

/** 测试环境里所有弹窗标题的 id 相同，按标题文字找到所在的弹窗。 */
async function dialogOf(title: string | RegExp) {
  const heading = await screen.findByText(title, { selector: '.ant-modal-title, .ant-modal-title *' })
  return within(heading.closest('[role="dialog"]') as HTMLElement)
}

async function drawerOf(title: string) {
  const heading = await screen.findByText(title, { selector: '.ant-drawer-title *' })
  return within(heading.closest('.ant-drawer-content') as HTMLElement)
}

async function chooseOption(combobox: HTMLElement, label: string) {
  if (combobox.getAttribute('aria-expanded') !== 'true') fireEvent.mouseDown(combobox)
  const option = await waitFor(() => {
    const found = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')]
      .find(item => item.getAttribute('title') === label)
    if (!found) throw new Error(`没有找到选项：${label}`)
    return found
  })
  fireEvent.click(option)
}

const visibleOptions = () => [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')]
  .map(item => item.getAttribute('title'))

async function openImport() {
  renderPage(editor)
  await screen.findByText('张三.pdf')
  fireEvent.click(screen.getByRole('button', { name: /导入简历/ }))
  return dialogOf('向“2026年秋季社招第一批”导入简历')
}

beforeEach(() => {
  calls.length = 0
  unexpected.length = 0
  polling.intervalMs = 5
  vi.spyOn(window, 'getComputedStyle').mockImplementation(inlineStyleOf)
})

afterEach(() => {
  expect(unexpected).toEqual([])
  vi.restoreAllMocks()
  Object.assign(polling, originalPolling)
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
})

describe('人员库：批次与人员列表', () => {
  it('页面称为人员库；列出批次的分类和人数，以及所选批次的人员资料', async () => {
    mockApi()
    renderPage(editor)
    expect(await screen.findByRole('heading', { level: 2, name: '人员库' })).toBeInTheDocument()
    const first = within(await screen.findByRole('button', { name: /^2026年秋季社招第一批/ }))
    expect(first.getByText('社招')).toBeInTheDocument()
    for (const count of ['共 3 人', '已解析 2', '未能解析 1', '解析中 0']) expect(first.getByText(count)).toBeInTheDocument()
    expect(first.getByText(/hr_admin/)).toBeInTheDocument()
    expect(within(screen.getByRole('button', { name: /^制造车间主任内部竞聘/ })).getByText('内聘')).toBeInTheDocument()
    expect(within(screen.getByRole('button', { name: /^历史导入批次/ })).getByText('未分类')).toBeInTheDocument()

    const parsedRow = await rowOf('张三.pdf')
    const parsed = within(parsedRow)
    expect(parsed.getByText('张三')).toBeInTheDocument()
    expect(parsed.getByText('已解析')).toBeInTheDocument()
    expect(parsed.getByText('待确认')).toBeInTheDocument()
    // 学历和工作经历摘要紧跟在该人员下方，占整行完整显示。
    const summary = within(parsedRow.nextElementSibling as HTMLElement)
    expect(summary.getByText(/示例大学 本科 工业工程/)).toHaveClass('evidence-text')
    expect(summary.getByText(/某制造业公司生产主管，负责装配与加工管理/)).toHaveClass('evidence-text')
    expect(within(await rowOf('王五.docx')).getByText('已确认')).toBeInTheDocument()

    const failedRow = await rowOf('李四.pdf')
    const failed = within(failedRow)
    expect(failed.getByText('解析失败')).toBeInTheDocument()
    expect(failed.getByText('姓名待确认')).toBeInTheDocument()
    expect(within(failedRow.nextElementSibling as HTMLElement).getByText(new RegExp(scannedFailure))).toHaveClass('evidence-text')

    expect(document.body.textContent).toContain('人员库')
    expect(document.body.textContent).not.toContain('人才库')
  }, 20000)

  it('切换批次后显示该批次的人员；空批次说明下一步是导入简历', async () => {
    mockApi()
    renderPage(editor)
    await screen.findByText('张三.pdf')
    fireEvent.click(screen.getByRole('button', { name: /^制造车间主任内部竞聘/ }))
    expect(await screen.findByText('该批次还没有人员')).toBeInTheDocument()
    expect(screen.getByText('导入简历后，系统自动解析每个人的学历、工作经历等资料。')).toBeInTheDocument()
    expect(screen.queryByText('张三.pdf')).not.toBeInTheDocument()
    expect(sent('GET', '/library/person-batches/TLB-INNER002')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /导入简历/ }).length).toBeGreaterThan(0)

    fireEvent.change(screen.getByLabelText('搜索批次'), { target: { value: '历史' } })
    expect(screen.queryByRole('button', { name: /^2026年秋季社招第一批/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^历史导入批次/ })).toBeInTheDocument()
  }, 20000)

  it('还没有批次时说明先建批次、再导入简历', async () => {
    mockApi(({ method, path }) => method === 'GET' && path === '/library/person-batches' ? Response.json([]) : undefined)
    renderPage(editor)
    expect(await screen.findByText('人员库还没有人员批次')).toBeInTheDocument()
    expect(screen.getByText(/第一步：新建人员批次，选择社招、校招或内聘；第二步：向批次导入简历/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /新建第一个批次/ })).toBeInTheDocument()
  })

  it('有简历正在解析时自动刷新，解析结束后停止', async () => {
    polling.pendingMs = 20
    let reads = 0
    mockApi(({ method, path }) => {
      if (method !== 'GET' || path !== '/library/person-batches/TLB-SOCIAL01') return undefined
      reads += 1
      const parsing = reads < 3
      return Response.json({
        ...batches[0], parsed_count: parsing ? 1 : 2, pending_count: parsing ? 1 : 0,
        persons: [persons[0], persons[1], parsing ? person({ id: 'TLE-0003', name: '待人工确认', source_filename: '王五.docx', status: '待解析', education: '', work_experience: '' }) : persons[2]],
      })
    })
    renderPage(editor)
    expect(within(await rowOf('王五.docx')).getByText('解析中')).toBeInTheDocument()
    await waitFor(() => expect(within(screen.getByText('王五.docx').closest('tr') as HTMLElement).getByText('已解析')).toBeInTheDocument())
    const settled = reads
    await new Promise(resolve => window.setTimeout(resolve, 80))
    expect(reads).toBe(settled)
  }, 20000)
})

describe('人员库：权限', () => {
  it('只有查看权限时不显示新建、导入、修改、删除、重新解析、对接入口和导出', async () => {
    mockApi()
    renderPage(interviewer)
    const row = within(await rowOf('李四.pdf'))
    for (const name of [/新建批次/, /导入简历/, /从组织架构选择人员/, /修改批次/, /删除批次/, /导出/]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    }
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(row.queryByRole('button', { name: '重新解析' })).not.toBeInTheDocument()
    expect(row.getByRole('button', { name: '查看详情' })).toBeInTheDocument()
    expect(row.getByRole('button', { name: '查看原始简历' })).toBeInTheDocument()
    expect(sent('GET', '/matching/options')).toHaveLength(0)
  }, 20000)

  it('有导出权限的用人部门可以导出，但不能导入或修改批次', async () => {
    mockApi()
    renderPage(businessUser)
    await screen.findByText('张三.pdf')
    expect(screen.getByRole('button', { name: /导出/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /导入简历/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /新建批次/ })).not.toBeInTheDocument()
  }, 20000)

  it('外部系统预留入口如实显示尚未对接', async () => {
    mockApi()
    renderPage(editor)
    await screen.findByText('张三.pdf')
    fireEvent.click(screen.getByRole('button', { name: /从组织架构选择人员/ }))
    const dialog = await dialogOf('从组织架构选择人员')
    expect(await dialog.findByText('该入口已预留，尚未与对方系统对接')).toBeInTheDocument()
    expect(dialog.getByText('待对接')).toBeInTheDocument()
    expect(dialog.getByText('目前可按批次上传简历导入人员')).toBeInTheDocument()
    expect(sent('POST', /integrations/)).toHaveLength(0)
  }, 20000)
})

describe('人员库：批次维护', () => {
  it('新建批次时分类只有社招、校招、内聘，未分类不可选', async () => {
    const created = batch({ id: 'TLB-NEW00004', name: '2026年内部竞聘第二批', category: '内聘', total_count: 0, parsed_count: 0, failed_count: 0 })
    mockApi(({ method, path }) => {
      if (method === 'POST' && path === '/library/person-batches') return Response.json(created)
      if (method === 'GET' && path === '/library/person-batches/TLB-NEW00004') return Response.json({ ...created, persons: [] })
      return undefined
    })
    renderPage(editor)
    await screen.findByText('张三.pdf')
    fireEvent.click(screen.getByRole('button', { name: /新建批次/ }))
    const dialog = await dialogOf('新建人员批次')
    fireEvent.click(dialog.getByRole('button', { name: '新建批次' }))
    expect(await dialog.findByText('请填写批次名称')).toBeInTheDocument()
    expect(dialog.getByText('请选择社招、校招或内聘')).toBeInTheDocument()
    expect(sent('POST', '/library/person-batches')).toHaveLength(0)

    fireEvent.change(dialog.getByLabelText('批次名称'), { target: { value: ' 2026年内部竞聘第二批 ' } })
    fireEvent.mouseDown(dialog.getByRole('combobox', { name: '人员分类' }))
    await waitFor(() => expect(visibleOptions()).toEqual(['社招', '校招', '内聘']))
    await chooseOption(dialog.getByRole('combobox', { name: '人员分类' }), '内聘')
    fireEvent.click(dialog.getByRole('button', { name: '新建批次' }))
    await waitFor(() => expect(sent('POST', '/library/person-batches')).toHaveLength(1))
    expect(sent('POST', '/library/person-batches')[0].body).toEqual({ name: '2026年内部竞聘第二批', category: '内聘' })
    expect(await screen.findByText('批次“2026年内部竞聘第二批”已建立，可以导入简历了')).toBeInTheDocument()
  }, 20000)

  it('修改历史批次时可以保留原分类，也可以改为正式分类', async () => {
    mockApi(({ method, path, body }) => method === 'PUT' && path === '/library/person-batches/TLB-LEG-0003'
      ? Response.json({ ...batches[2], ...body })
      : undefined)
    renderPage(editor)
    await screen.findByText('张三.pdf')
    fireEvent.click(screen.getByRole('button', { name: '修改批次 历史导入批次' }))
    const dialog = await dialogOf('修改批次名称与分类')
    expect(dialog.getByLabelText('批次名称')).toHaveValue('历史导入批次')
    fireEvent.mouseDown(dialog.getByRole('combobox', { name: '人员分类' }))
    await waitFor(() => expect(visibleOptions()).toEqual(['社招', '校招', '内聘', '未分类（历史数据）']))
    await chooseOption(dialog.getByRole('combobox', { name: '人员分类' }), '校招')
    fireEvent.change(dialog.getByLabelText('批次名称'), { target: { value: '2025年校招补录' } })
    fireEvent.click(dialog.getByRole('button', { name: /保\s*存/ }))
    await waitFor(() => expect(sent('PUT', '/library/person-batches/TLB-LEG-0003')).toHaveLength(1))
    expect(sent('PUT', '/library/person-batches/TLB-LEG-0003')[0].body).toEqual({ name: '2025年校招补录', category: '校招' })
  }, 20000)

  it('可一次删除多个批次；后端拒绝时原样说明原因，批次保留', async () => {
    const refusal = '所选批次中有人员已关联AI面试候选人，不能删除；已建立的匹配任务和面试记录需要这些资料'
    mockApi(({ method, path }) => method === 'POST' && path === '/library/person-batches/delete'
      ? Response.json({ detail: refusal }, { status: 409 })
      : undefined)
    renderPage(editor)
    await screen.findByText('张三.pdf')
    fireEvent.click(screen.getByRole('checkbox', { name: '选择批次 2026年秋季社招第一批' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '选择批次 历史导入批次' }))
    expect(screen.getByText('已选 2 个批次')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '删除所选' }))

    const dialog = await dialogOf('确认删除人员批次')
    expect(dialog.getByText('将删除 2 个批次、5 份人员资料：')).toBeInTheDocument()
    expect(dialog.getByText('删除后不可恢复')).toBeInTheDocument()
    expect(sent('POST', '/library/person-batches/delete')).toHaveLength(0)
    fireEvent.click(dialog.getByRole('button', { name: '确认删除' }))
    expect(await dialog.findByText(refusal)).toBeInTheDocument()
    expect(sent('POST', '/library/person-batches/delete')[0].body).toEqual({ batch_ids: ['TLB-SOCIAL01', 'TLB-LEG-0003'] })
    expect(screen.getByRole('button', { name: /^2026年秋季社招第一批/ })).toBeInTheDocument()
  }, 20000)
})

describe('人员库：导入简历', () => {
  const scans = [{ file: '张三.pdf', pages: '2、3', page_count: 3, text_pages: 1, blank_pages: 0 }]
  const importResult = {
    batch_id: 'TLB-SOCIAL01', batch_name: '2026年秋季社招第一批',
    imported: [person({ id: 'TLE-0101' })],
    failed: [person({ id: 'TLE-0102', name: '待人工确认', source_filename: '赵六.docx', status: '解析失败', error_message: '未读取到有效简历内容，请检查文件是否为空白模板' })],
  }

  it('说明单次导入上限；包含扫描页的文件在确认授权前不能导入', async () => {
    let polls = 0
    let finish!: () => void
    const finished = new Promise<void>(resolve => { finish = resolve })
    mockApi(async ({ method, path }) => {
      if (method === 'POST' && path === '/library/uploads/preflight') return Response.json({ scans, errors: [] })
      if (method === 'POST' && path === '/library/person-batches/TLB-SOCIAL01/import') return Response.json(operation({ progress: '' }))
      if (method === 'GET' && path === '/library/operations/op-1') {
        polls += 1
        if (polls === 1) return Response.json(operation({ progress: '正在解析第 1/2 份：张三.pdf' }))
        await finished
        return Response.json(operation({ status: 'completed', result: importResult }))
      }
      return undefined
    })
    const dialog = await openImport()
    expect(await dialog.findByText(/每次最多导入 100 份简历/)).toBeInTheDocument()
    expect(dialog.getByText(/单个文件不超过 50MB/)).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: /开始导入/ })).toBeDisabled()

    fireEvent.change(dialog.getByLabelText('选择简历文件'), { target: { files: [file('张三.pdf'), file('赵六.docx', ''), file('照片.png', 'image/png')] } })
    expect(await dialog.findByText('照片.png：简历仅支持 PDF、Word（.docx）和 TXT 文件')).toBeInTheDocument()
    expect(dialog.getByText('已选择 2 份 / 每次最多 100 份')).toBeInTheDocument()

    fireEvent.change(dialog.getByLabelText('选择面试纪要或补充材料'), { target: { files: [file('张三_面试纪要.docx', ''), file('其他说明.txt', 'text/plain')] } })
    const paired = within((await dialog.findByText('张三_面试纪要.docx')).closest('li') as HTMLElement)
    expect(paired.getByText('张三.pdf')).toBeInTheDocument()
    const loose = within(dialog.getByText('其他说明.txt').closest('li') as HTMLElement)
    expect(loose.getByText('未指定（不导入）')).toBeInTheDocument()

    expect(dialog.getByRole('button', { name: /开始导入/ })).toBeDisabled()
    fireEvent.click(dialog.getByRole('button', { name: '检查文件' }))
    expect(await dialog.findByText('1 个文件包含扫描页')).toBeInTheDocument()
    expect(fileNames(sent('POST', '/library/uploads/preflight')[0].form, 'files')).toEqual(['张三.pdf', '赵六.docx', '张三_面试纪要.docx', '其他说明.txt'])
    expect(within(dialog.getByText('2、3').closest('tr') as HTMLElement).getByText('张三.pdf')).toBeInTheDocument()

    const authorise = dialog.getByRole('checkbox', { name: AUTHORISATION })
    expect(authorise).not.toBeChecked()
    expect(dialog.getByRole('button', { name: /开始导入/ })).toBeDisabled()
    fireEvent.click(dialog.getByRole('button', { name: /开始导入/ }))
    expect(sent('POST', /import$/)).toHaveLength(0)

    fireEvent.click(authorise)
    expect(dialog.getByRole('button', { name: /开始导入/ })).toBeEnabled()
    fireEvent.click(dialog.getByRole('button', { name: /开始导入/ }))
    expect(await dialog.findByText('正在解析第 1/2 份：张三.pdf')).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: '关闭窗口，在后台继续导入' })).toBeInTheDocument()

    const request = sent('POST', '/library/person-batches/TLB-SOCIAL01/import')[0].form
    expect(fileNames(request, 'files')).toEqual(['张三.pdf', '赵六.docx'])
    expect(fileNames(request, 'minutes')).toEqual(['张三_面试纪要.docx'])
    expect(JSON.parse(String(request?.get('minute_assignments')))).toEqual({ '张三.pdf': '张三_面试纪要.docx' })
    expect(request?.get('allow_ocr')).toBe('true')

    finish()
    expect(await dialog.findByText('导入完成：成功解析 1 人，1 份未能解析')).toBeInTheDocument()
    expect(polls).toBe(2)
    expect(dialog.getByText('未读取到有效简历内容，请检查文件是否为空白模板')).toBeInTheDocument()
    expect(dialog.getByText(/未解析成功的文件已保留在本批次/)).toBeInTheDocument()
    await waitFor(() => expect(sent('GET', '/library/person-batches/TLB-SOCIAL01').length).toBeGreaterThan(1))
  }, 30000)

  it('没有扫描页时检查通过即可导入，不带文字识别授权；手动指定的对应关系随请求提交', async () => {
    mockApi(({ method, path }) => {
      if (method === 'POST' && path === '/library/uploads/preflight') return Response.json({ scans: [], errors: [] })
      if (method === 'POST' && path === '/library/person-batches/TLB-SOCIAL01/import') return Response.json(operation({ status: 'completed', result: { ...importResult, failed: [] } }))
      return undefined
    })
    const dialog = await openImport()
    fireEvent.change(dialog.getByLabelText('选择简历文件'), { target: { files: [file('张三.pdf'), file('赵六.docx', '')] } })
    fireEvent.change(dialog.getByLabelText('选择面试纪要或补充材料'), { target: { files: [file('复试记录.txt', 'text/plain')] } })
    await chooseOption(await dialog.findByRole('combobox', { name: '复试记录.txt 对应的简历' }), '赵六.docx')

    fireEvent.click(dialog.getByRole('button', { name: '检查文件' }))
    expect(await dialog.findByText('文件检查通过，没有需要文字识别的扫描页')).toBeInTheDocument()
    expect(dialog.queryByRole('checkbox', { name: AUTHORISATION })).not.toBeInTheDocument()
    fireEvent.click(dialog.getByRole('button', { name: /开始导入/ }))
    expect(await dialog.findByText('导入完成：成功解析 1 人')).toBeInTheDocument()

    const request = sent('POST', '/library/person-batches/TLB-SOCIAL01/import')[0].form
    expect(JSON.parse(String(request?.get('minute_assignments')))).toEqual({ '赵六.docx': '复试记录.txt' })
    expect(fileNames(request, 'minutes')).toEqual(['复试记录.txt'])
    expect(request?.get('allow_ocr')).toBe('false')
  }, 30000)

  it('文件有变化后需要重新检查；检查发现的问题文件要先移除', async () => {
    let checks = 0
    mockApi(({ method, path }) => {
      if (method !== 'POST' || path !== '/library/uploads/preflight') return undefined
      checks += 1
      return Response.json(checks === 1 ? { scans: [], errors: ['加密简历.pdf：PDF已加密，请解密后重新上传。'] } : { scans: [], errors: [] })
    })
    const dialog = await openImport()
    fireEvent.change(dialog.getByLabelText('选择简历文件'), { target: { files: [file('张三.pdf'), file('加密简历.pdf')] } })
    fireEvent.click(await dialog.findByRole('button', { name: '检查文件' }))
    expect(await dialog.findByText('加密简历.pdf：PDF已加密，请解密后重新上传。')).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: /开始导入/ })).toBeDisabled()

    fireEvent.click(dialog.getByRole('button', { name: '移除 加密简历.pdf' }))
    expect(await dialog.findByText('文件有变化，请重新检查后再导入。')).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: /开始导入/ })).toBeDisabled()
    fireEvent.click(dialog.getByRole('button', { name: '检查文件' }))
    expect(await dialog.findByText('文件检查通过，没有需要文字识别的扫描页')).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: /开始导入/ })).toBeEnabled()
    expect(sent('POST', /import$/)).toHaveLength(0)
  }, 30000)

  it('后端因扫描页拒绝导入时列出扫描页，确认授权后才重新提交', async () => {
    const refusal = '文件包含扫描页，需确认已获识别服务处理授权后才能导入'
    mockApi(({ method, path, form }) => {
      if (method === 'POST' && path === '/library/uploads/preflight') return Response.json({ scans: [], errors: [] })
      if (method === 'POST' && path === '/library/person-batches/TLB-SOCIAL01/import') {
        return form?.get('allow_ocr') === 'true'
          ? Response.json(operation({ status: 'completed', result: { ...importResult, failed: [] } }))
          : Response.json({ detail: { message: refusal, scans } }, { status: 409 })
      }
      return undefined
    })
    const dialog = await openImport()
    fireEvent.change(dialog.getByLabelText('选择简历文件'), { target: { files: [file('张三.pdf')] } })
    fireEvent.click(await dialog.findByRole('button', { name: '检查文件' }))
    await dialog.findByText('文件检查通过，没有需要文字识别的扫描页')
    fireEvent.click(dialog.getByRole('button', { name: /开始导入/ }))

    expect(await dialog.findByText(refusal)).toBeInTheDocument()
    expect(dialog.getByText('1 个文件包含扫描页')).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: /开始导入/ })).toBeDisabled()
    expect(sent('POST', /import$/)).toHaveLength(1)

    fireEvent.click(dialog.getByRole('checkbox', { name: AUTHORISATION }))
    fireEvent.click(dialog.getByRole('button', { name: /开始导入/ }))
    expect(await dialog.findByText('导入完成：成功解析 1 人')).toBeInTheDocument()
    expect(sent('POST', /import$/).map(call => call.form?.get('allow_ocr'))).toEqual(['false', 'true'])
  }, 30000)
})

describe('人员库：人员详情与资料修改', () => {
  async function openPerson() {
    renderPage(editor)
    fireEvent.click(within(await rowOf('张三.pdf')).getByRole('button', { name: '查看详情' }))
    const drawer = await drawerOf('张三')
    await drawer.findByText('装配、加工、检验')
    return drawer
  }

  it('显示资料的状态和来源、解析提示、完整的原文依据，以及匹配和面试记录', async () => {
    mockApi()
    const drawer = await openPerson()
    expect(drawer.getByText('第2页有一处表格未能完整读取，请对照原始简历核对')).toBeInTheDocument()
    expect(drawer.getByText('来源：张三.pdf · 第2页')).toBeInTheDocument()
    expect(drawer.getAllByText('待人工确认').length).toBeGreaterThan(0)
    expect(drawer.getAllByText('简历中未识别到').length).toBe(4)

    fireEvent.click(drawer.getByRole('tab', { name: '原文依据（2）' }))
    const evidence = await drawer.findByText(longEvidence)
    expect(evidence).toHaveClass('evidence-text')
    expect(drawer.getByText(/人工核实记录，不是简历原文/)).toBeInTheDocument()

    fireEvent.click(drawer.getByRole('tab', { name: '匹配记录（1）' }))
    const match = within((await drawer.findByText('制造储备岗九月选才')).closest('tr') as HTMLElement)
    expect(match.getByText('岗位选才')).toBeInTheDocument()
    expect(match.getByText('82.5')).toBeInTheDocument()
    expect(match.getByText('高度匹配')).toBeInTheDocument()
    expect(match.getByText('待审核')).toBeInTheDocument()
    expect(match.getByRole('link', { name: '查看匹配详情' })).toHaveAttribute('href', '/matching/tasks/TASK-001?person=CAND-009')

    fireEvent.click(drawer.getByRole('tab', { name: '面试记录（1）' }))
    const interview = within((await drawer.findByText('九月初筛')).closest('tr') as HTMLElement)
    expect(interview.getByText('C-007')).toBeInTheDocument()
    expect(interview.getByText('已完成')).toBeInTheDocument()
    expect(interview.getByText('待人工复核')).toBeInTheDocument()
    expect(interview.getByText('78')).toBeInTheDocument()
  }, 20000)

  it('保存修改只提交改动的内容并带上资料版本；确认资料无误单独提交', async () => {
    let version = 0
    mockApi(({ method, path, body }) => {
      if (method === 'GET' && path === '/library/persons/TLE-0001') {
        return Response.json({
          ...personDetail, material_version: version, confirmed: version > 1,
          profile: { ...personDetail.profile, fields: personDetail.profile.fields.map(item => item.key === 'tenure' && version ? { ...item, value: '2019年7月至2024年8月', status: '人工已修改，待确认' } : item) },
        })
      }
      if (method === 'PUT' && path === '/library/persons/TLE-0001/material') {
        if (body?.expected_material_version !== version) return Response.json({ detail: '资料已被其他操作更新，请刷新后重新修改' }, { status: 422 })
        version += 1
        return Response.json({ ...persons[0], material_version: version, profile: personDetail.profile })
      }
      return undefined
    })
    const drawer = await openPerson()
    fireEvent.click(drawer.getByRole('button', { name: /修改资料/ }))
    expect(await drawer.findByLabelText('姓名')).toHaveValue('张三')
    expect(drawer.getByLabelText('教育经历')).toHaveValue('示例大学 本科 工业工程')
    fireEvent.change(drawer.getByLabelText('任职时间'), { target: { value: ' 2019年7月至2024年8月 ' } })
    fireEvent.click(drawer.getByRole('button', { name: '保存修改' }))

    await waitFor(() => expect(sent('PUT', '/library/persons/TLE-0001/material')).toHaveLength(1))
    expect(sent('PUT', '/library/persons/TLE-0001/material')[0].body).toEqual({
      fields: { tenure: '2019年7月至2024年8月' }, confirmed: false, expected_material_version: 0,
    })
    expect(await screen.findByText('修改已保存，资料待确认')).toBeInTheDocument()
    expect(await drawer.findByText('人工已修改，待确认')).toBeInTheDocument()
    expect(drawer.queryByRole('button', { name: '保存修改' })).not.toBeInTheDocument()

    fireEvent.click(drawer.getByRole('button', { name: '确认资料无误' }))
    fireEvent.click(await screen.findByRole('button', { name: /^确\s*认$/ }))
    await waitFor(() => expect(sent('PUT', '/library/persons/TLE-0001/material')).toHaveLength(2))
    expect(sent('PUT', '/library/persons/TLE-0001/material')[1].body).toEqual({ fields: {}, confirmed: true, expected_material_version: 1 })
    expect(await screen.findByText('资料已确认')).toBeInTheDocument()
    await waitFor(() => expect(drawer.queryByRole('button', { name: '确认资料无误' })).not.toBeInTheDocument())
  }, 30000)

  it('资料已被他人更新时保留后端的说明，不覆盖对方的修改', async () => {
    mockApi(({ method, path }) => method === 'PUT' && path === '/library/persons/TLE-0001/material'
      ? Response.json({ detail: '资料已被其他操作更新，请刷新后重新修改' }, { status: 422 })
      : undefined)
    const drawer = await openPerson()
    fireEvent.click(drawer.getByRole('button', { name: /修改资料/ }))
    fireEvent.change(await drawer.findByLabelText('项目经历'), { target: { value: '产线管理标准化项目' } })
    fireEvent.click(drawer.getByRole('button', { name: '保存并确认资料无误' }))
    expect(await drawer.findByText('资料已被其他操作更新，请刷新后重新修改')).toBeInTheDocument()
    expect(sent('PUT', '/library/persons/TLE-0001/material')[0].body).toEqual({
      fields: { projects: '产线管理标准化项目' }, confirmed: true, expected_material_version: 0,
    })
    expect(drawer.getByLabelText('项目经历')).toHaveValue('产线管理标准化项目')
  }, 20000)

  it('放弃修改需要确认；再次修改时回到已保存的资料', async () => {
    mockApi()
    const drawer = await openPerson()
    fireEvent.click(drawer.getByRole('button', { name: /修改资料/ }))
    fireEvent.change(await drawer.findByLabelText('教育经历'), { target: { value: '临时改动' } })
    fireEvent.click(drawer.getByRole('button', { name: /取\s*消/ }))
    expect(await screen.findByText('放弃未保存的修改？')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }))

    fireEvent.click(await drawer.findByRole('button', { name: /修改资料/ }))
    expect(await drawer.findByLabelText('教育经历')).toHaveValue('示例大学 本科 工业工程')
    expect(sent('PUT', /material/)).toHaveLength(0)
    fireEvent.click(drawer.getByRole('button', { name: '保存修改' }))
    expect(await screen.findByText('资料没有改动，无需保存')).toBeInTheDocument()
    expect(sent('PUT', /material/)).toHaveLength(0)
  }, 20000)

  it('没有修改权限时只能查看', async () => {
    mockApi(({ method, path }) => method === 'GET' && path === '/library/persons/TLE-0001'
      ? Response.json({ ...personDetail, can_edit: false })
      : undefined)
    const drawer = await openPerson()
    expect(drawer.queryByRole('button', { name: /修改资料/ })).not.toBeInTheDocument()
    expect(drawer.queryByRole('button', { name: '确认资料无误' })).not.toBeInTheDocument()
    expect(drawer.getByRole('button', { name: /查看原始简历/ })).toBeInTheDocument()
  }, 20000)
})

describe('人员库：重新解析与导出', () => {
  it('重新解析在后台进行；扫描页授权由使用者明确勾选', async () => {
    mockApi(({ method, path }) => {
      if (method === 'POST' && path === '/library/persons/TLE-0002/retry') return Response.json(operation({ id: 'op-9', kind: 'person_retry', progress: '正在重新解析简历' }))
      if (method === 'GET' && path === '/library/operations/op-9') return Response.json(operation({ id: 'op-9', kind: 'person_retry', status: 'completed', result: person({ id: 'TLE-0002', name: '李四', source_filename: '李四.pdf' }) }))
      return undefined
    })
    renderPage(editor)
    expect(within(await rowOf('王五.docx')).queryByRole('button', { name: '重新解析' })).not.toBeInTheDocument()
    fireEvent.click(within(await rowOf('李四.pdf')).getByRole('button', { name: '重新解析' }))
    const dialog = await dialogOf('重新解析简历')
    fireEvent.click(dialog.getByRole('checkbox', { name: AUTHORISATION }))
    fireEvent.click(dialog.getByRole('button', { name: '开始重新解析' }))
    expect(await screen.findByText('李四.pdf 已重新解析')).toBeInTheDocument()
    const request = sent('POST', '/library/persons/TLE-0002/retry')
    expect(request).toHaveLength(1)
    expect(request[0].query.get('allow_ocr')).toBe('true')
  }, 20000)

  it('重新解析仍未成功时说明原因', async () => {
    mockApi(({ method, path }) => {
      if (method === 'POST' && path === '/library/persons/TLE-0002/retry') return Response.json(operation({ id: 'op-9', kind: 'person_retry' }))
      if (method === 'GET' && path === '/library/operations/op-9') return Response.json(operation({ id: 'op-9', status: 'completed', result: persons[1] }))
      return undefined
    })
    renderPage(editor)
    fireEvent.click(within(await rowOf('李四.pdf')).getByRole('button', { name: '重新解析' }))
    const dialog = await dialogOf('重新解析简历')
    fireEvent.click(dialog.getByRole('button', { name: '开始重新解析' }))
    expect(await dialog.findByText('重新解析未完成')).toBeInTheDocument()
    expect(dialog.getByText(scannedFailure)).toBeInTheDocument()
    expect(sent('POST', '/library/persons/TLE-0002/retry')[0].query.get('allow_ocr')).toBe('false')
  }, 20000)

  it('勾选人员后导出所选，未勾选时导出整个批次', async () => {
    mockApi(({ method, path }) => method === 'GET' && path === '/library/person-batches/TLB-SOCIAL01/export'
      ? new Response('file', { headers: { 'X-Download-Name': encodeURIComponent('2026年秋季社招第一批_简历原件.zip') } })
      : undefined)
    const downloads: string[] = []
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:export') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download) })

    renderPage(editor)
    await screen.findByText('张三.pdf')
    fireEvent.click(screen.getByRole('button', { name: /导出/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '导出人员明细 CSV（整个批次）' }))
    await waitFor(() => expect(sent('GET', '/library/person-batches/TLB-SOCIAL01/export')).toHaveLength(1))
    expect(sent('GET', '/library/person-batches/TLB-SOCIAL01/export')[0].query.get('kind')).toBe('csv')
    expect(sent('GET', '/library/person-batches/TLB-SOCIAL01/export')[0].query.get('ids')).toBeNull()

    fireEvent.click(within(await rowOf('张三.pdf')).getByRole('checkbox'))
    fireEvent.click(within(await rowOf('王五.docx')).getByRole('checkbox'))
    expect(screen.getByText('已选 2 人')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /导出/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '导出简历原件（所选 2 人）' }))
    await waitFor(() => expect(sent('GET', '/library/person-batches/TLB-SOCIAL01/export')).toHaveLength(2))
    const request = sent('GET', '/library/person-batches/TLB-SOCIAL01/export')[1]
    expect(request.query.get('kind')).toBe('resumes')
    expect(request.query.get('ids')).toBe('TLE-0001,TLE-0003')
    await waitFor(() => expect(downloads).toHaveLength(2))
    expect(downloads[1]).toBe('2026年秋季社招第一批_简历原件.zip')
  }, 20000)
})
