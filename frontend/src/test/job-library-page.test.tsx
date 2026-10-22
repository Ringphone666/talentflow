import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import JobLibraryPage from '../pages/library/JobLibraryPage'
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
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL
const originalInterval = polling.intervalMs

const sessionWith = (permissions: string[]): Session => ({
  access_token: 'test-token', expires_at: 4102444800, username: 'hr', display_name: 'HR管理员', role: 'hr_admin', role_label: 'HR管理员', permissions,
})
const editor = sessionWith(['job:read', 'job:edit'])
const reader = sessionWith(['job:read'])

const summary = (patch: Record<string, unknown>) => ({
  id: 'JOB-AAAA0001', name: '制造生产储备岗', sequence: '生产类', level: '专员', jd_version: '2026.09', weight_version: 'W-NEW-1.0',
  scope: '人工新增岗位', is_active: true, updated_at: '2026-09-20T10:30:00+08:00', dimension_count: 3, hard_condition_count: 2,
  matching_task_count: 4, interview: { configured: true, interview_job_id: 1, audit_status: 'approved', batch_count: 2 },
  ...patch,
})
const activeJobs = [
  summary({}),
  summary({
    id: 'JOB-BBBB0002', name: '人力资源专员', sequence: '职能类', level: '主管', dimension_count: 4, hard_condition_count: 1, matching_task_count: 0,
    interview: { configured: false, interview_job_id: null, audit_status: 'not_configured', batch_count: 0 },
  }),
]
const archivedJob = summary({
  id: 'JOB-CCCC0003', name: '旧版质检岗', sequence: '生产类', level: '专员', is_active: false, matching_task_count: 1,
  interview: { configured: true, interview_job_id: 3, audit_status: 'draft', batch_count: 0 },
})

const sixDimensions = ['岗位专业能力', '逻辑思维', '沟通表达', '抗压能力', '职业稳定性', '企业价值观契合度']
const defaultModel = sixDimensions.map(name => ({ dimension: name, behavior: `${name}的通用定义`, levels: { '1': '缺少相关证据', '3': '能够完成基本要求', '5': '能够稳定完成并形成可复用方法' } }))
const savedModel = sixDimensions.map(name => ({
  dimension: name, behavior: `${name}的岗位要求`,
  levels: { '1': `${name}一分`, '2': `${name}二分`, '3': `${name}三分`, '5': `${name}五分` },
  source_evaluation_basis: ['原资料依据'], source_reference: { page: 3 },
}))
const standard = {
  configured: true, interview_job_id: 1, code: 'JOB-AAAA0001', audit_status: 'draft', material_version: 'v1.0',
  professional_requirements: '熟悉制造工艺与质量安全要求', competency_model: savedModel,
  materials: [{ id: 9, original_name: '制造岗位手册.pdf', size: 204800, ocr_status: 'completed', ocr_text_preview: '第一章 岗位职责', ocr_at: '2026-09-21T02:00:00' }],
  batch_count: 2, updated_at: '2026-09-21T02:00:00',
}
const detail = {
  ...summary({}),
  responsibilities: ['负责制造车间日常生产组织', '落实质量与安全管理要求'],
  requirements: ['熟悉工业产品制造工艺流程'],
  hard_conditions: ['本科及以上学历', '3年以上相关工作经验'],
  dimensions: [
    { name: '生产工艺', keywords: ['制造', '工艺'], negative_keywords: [], weight: 50 },
    { name: '质量管理', keywords: ['质量'], negative_keywords: [], weight: 30 },
    { name: '安全意识', keywords: ['安全'], negative_keywords: [], weight: 20 },
  ],
  weights: { 生产工艺: 50, 质量管理: 30, 安全意识: 20 },
  extra_sections: { 工作地点: '示例园区' },
  interview_standard: standard,
}
const integrations = [{
  key: 'recruitment_jobs', name: '从人资招聘系统导入岗位', target: '岗位库', system: '人力资源招聘系统',
  pending: '人资招聘系统的岗位数据接口（地址、字段、鉴权方式）尚未提供', alternative: '目前可上传岗位说明书（PDF、Word、TXT）由系统识别，或手工新增岗位',
  status: 'pending_interface', status_label: '待对接', available: false,
}]

/** 列表、详情等读取接口的默认应答；各用例再补充自己关心的接口。 */
const base: Handler = ({ method, path, query }) => {
  if (method !== 'GET') return undefined
  if (path === '/library/jobs') return Response.json(query.get('include_archived') === 'true' ? [...activeJobs, archivedJob] : activeJobs)
  if (path === '/library/jobs/JOB-AAAA0001') return Response.json(detail)
  if (path === '/library/jobs/JOB-AAAA0001/interview-standard') return Response.json({ ...standard, default_model: defaultModel })
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

function renderPage(session: Session, entry = '/library/jobs') {
  const Layout = () => <Outlet context={{ session }} />
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes><Route element={<Layout />}><Route path="/library/jobs" element={<JobLibraryPage />} /></Route></Routes>
    </MemoryRouter>,
  )
}

const sent = (method: string, path: string | RegExp) => calls.filter(call => call.method === method && (typeof path === 'string' ? call.path === path : path.test(call.path)))
const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement
const pdf = (name: string, content = '%PDF-1.4 test') => new File([content], name, { type: 'application/pdf' })
const readBlob = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result))
  reader.onerror = () => reject(reader.error)
  reader.readAsText(blob)
})

/** 测试环境里所有弹窗标题的 id 相同，按标题文字找到所在的弹窗或抽屉。 */
async function drawerOf(title: string) {
  const heading = await screen.findByText(title, { selector: '.ant-drawer-title *' })
  return within(heading.closest('.ant-drawer-content') as HTMLElement)
}

async function dialogOf(title: string) {
  const heading = await screen.findByText(title, { selector: '.ant-modal-title, .ant-modal-title *, .ant-drawer-title, .ant-drawer-title *' })
  return within(heading.closest('[role="dialog"]') as HTMLElement)
}

async function openCreateForm() {
  renderPage(editor)
  await screen.findByText('制造生产储备岗')
  fireEvent.click(screen.getByRole('button', { name: /新增岗位/ }))
  return dialogOf('新增岗位')
}

function fillProfile(form: ReturnType<typeof within>, name = '制造生产储备岗') {
  fireEvent.change(form.getByLabelText('岗位名称'), { target: { value: name } })
  fireEvent.change(form.getByLabelText('序列'), { target: { value: '生产类' } })
  fireEvent.change(form.getByLabelText('层级'), { target: { value: '专员' } })
  fireEvent.change(form.getByLabelText('岗位职责'), { target: { value: '负责制造车间日常生产组织\n\n落实质量与安全管理要求 ' } })
  fireEvent.change(form.getByLabelText('任职要求'), { target: { value: '熟悉工业产品制造工艺流程' } })
  fireEvent.change(form.getByLabelText('硬性条件'), { target: { value: '本科及以上学历' } })
}

function fillDimension(form: ReturnType<typeof within>, index: number, name: string, weight: number, keywords = '') {
  fireEvent.change(form.getByLabelText(`第${index}项能力标签`), { target: { value: name } })
  const input = form.getByLabelText(`第${index}项权重`)
  fireEvent.change(input, { target: { value: String(weight) } })
  fireEvent.blur(input)
  if (keywords) fireEvent.change(form.getByLabelText(`第${index}项证据关键词`), { target: { value: keywords } })
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
  polling.intervalMs = originalInterval
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
})

describe('岗位库：列表与权限', () => {
  it('列出岗位的序列、层级、数量和面试评价标准状态，可搜索并显示已删除岗位', async () => {
    mockApi()
    renderPage(editor)
    const first = within(await rowOf('制造生产储备岗'))
    expect(first.getByText('生产类')).toBeInTheDocument()
    expect(first.getByText('专员')).toBeInTheDocument()
    expect(first.getByText('2 项')).toBeInTheDocument()
    expect(first.getByText('3 项')).toBeInTheDocument()
    expect(first.getByText('已确认')).toBeInTheDocument()
    expect(first.getByText('4 个')).toBeInTheDocument()
    expect(first.getByText('2 个')).toBeInTheDocument()
    expect(within(await rowOf('人力资源专员')).getByText('未配置')).toBeInTheDocument()
    expect(sent('GET', '/library/jobs')[0].query.get('include_archived')).toBeNull()

    fireEvent.change(screen.getByLabelText('搜索岗位'), { target: { value: '人力' } })
    expect(screen.queryByText('制造生产储备岗')).not.toBeInTheDocument()
    expect(screen.getByText('人力资源专员')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('搜索岗位'), { target: { value: '' } })

    fireEvent.click(screen.getByRole('switch', { name: '显示已删除' }))
    const archived = within(await rowOf('旧版质检岗'))
    expect(sent('GET', '/library/jobs').at(-1)?.query.get('include_archived')).toBe('true')
    expect(archived.getByText('已删除')).toBeInTheDocument()
    expect(archived.getByText('待确认')).toBeInTheDocument()
    expect(archived.getByRole('button', { name: '恢复' })).toBeInTheDocument()
    expect(archived.getByRole('button', { name: '彻底删除' })).toBeInTheDocument()
    expect(archived.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument()
  })

  it('只读角色看不到新增、上传、对接入口和编辑删除，仍可查看详情和导出能力标签', async () => {
    mockApi()
    renderPage(reader)
    const row = within(await rowOf('制造生产储备岗'))
    for (const name of [/新增岗位/, /上传岗位说明书/, /从人资招聘系统导入/]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    }
    expect(row.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument()
    expect(row.queryByRole('button', { name: '删除' })).not.toBeInTheDocument()

    fireEvent.click(row.getByRole('button', { name: '查看' }))
    const drawer = await drawerOf('制造生产储备岗')
    expect(await drawer.findByText('负责制造车间日常生产组织')).toBeInTheDocument()
    expect(drawer.getByText('3年以上相关工作经验')).toBeInTheDocument()
    expect(drawer.getByText('示例园区')).toBeInTheDocument()
    expect(drawer.queryByRole('button', { name: /编辑岗位/ })).not.toBeInTheDocument()

    fireEvent.click(drawer.getByRole('tab', { name: '能力标签与权重' }))
    expect(await drawer.findByRole('button', { name: /导出能力标签/ })).toBeInTheDocument()
    expect(drawer.getByText('生产工艺')).toBeInTheDocument()

    fireEvent.click(drawer.getByRole('tab', { name: /面试评价标准/ }))
    expect(await drawer.findByText('岗位专业能力的岗位要求')).toBeInTheDocument()
    expect(drawer.queryByRole('button', { name: /编辑评价标准/ })).not.toBeInTheDocument()
    expect(drawer.queryByRole('button', { name: /生成评分标准建议/ })).not.toBeInTheDocument()
    expect(drawer.queryByRole('button', { name: /上传补充材料/ })).not.toBeInTheDocument()
    expect(drawer.queryByRole('button', { name: /删除 制造岗位手册/ })).not.toBeInTheDocument()
  })

  it('外部系统预留入口如实显示尚未对接', async () => {
    mockApi()
    renderPage(editor)
    await screen.findByText('制造生产储备岗')
    fireEvent.click(screen.getByRole('button', { name: /从人资招聘系统导入/ }))
    const dialog = await dialogOf('从人资招聘系统导入')
    expect(await dialog.findByText('该入口已预留，尚未与对方系统对接')).toBeInTheDocument()
    expect(dialog.getByText('待对接')).toBeInTheDocument()
    expect(dialog.getByText('人力资源招聘系统')).toBeInTheDocument()
    expect(sent('POST', /integrations/)).toHaveLength(0)
  })
})

describe('岗位库：新增岗位', () => {
  it('权重合计不是 100% 时不能保存，平均分配后可以保存', async () => {
    mockApi(({ method, path }) => method === 'POST' && path === '/library/jobs'
      ? Response.json({ ...detail, id: 'JOB-NEW00001', name: '新岗位' })
      : path === '/library/jobs/JOB-NEW00001' ? Response.json({ ...detail, id: 'JOB-NEW00001', name: '新岗位' })
        : path === '/library/jobs/JOB-NEW00001/interview-standard' ? Response.json({ ...standard, configured: false, default_model: defaultModel }) : undefined)
    const form = await openCreateForm()
    fillProfile(form, '新岗位')
    fillDimension(form, 1, '生产工艺', 60, '制造、工艺，加工')
    fireEvent.click(form.getByRole('button', { name: /添加能力标签/ }))
    fillDimension(form, 2, '质量管理', 30)
    expect(form.getByRole('status')).toHaveTextContent('权重合计 90%，还差 10%')

    fireEvent.click(form.getByRole('button', { name: '保存岗位' }))
    expect(await form.findByText('权重合计须为 100%，当前为 90%')).toBeInTheDocument()
    expect(sent('POST', '/library/jobs')).toHaveLength(0)

    fireEvent.click(form.getByRole('button', { name: '平均分配' }))
    await waitFor(() => expect(form.getByRole('status')).toHaveTextContent('权重合计 100%'))
    await waitFor(() => expect(form.queryByText(/权重合计须为 100%，当前为/)).not.toBeInTheDocument())
    fireEvent.click(form.getByRole('button', { name: '保存岗位' }))
    await waitFor(() => expect(sent('POST', '/library/jobs')).toHaveLength(1))
    expect(sent('POST', '/library/jobs')[0].body).toEqual({
      name: '新岗位', sequence: '生产类', level: '专员', jd_version: '',
      responsibilities: ['负责制造车间日常生产组织', '落实质量与安全管理要求'],
      requirements: ['熟悉工业产品制造工艺流程'],
      hard_conditions: ['本科及以上学历'],
      dimensions: [
        { name: '生产工艺', keywords: ['制造', '工艺', '加工'], negative_keywords: [] },
        { name: '质量管理', keywords: ['质量管理'], negative_keywords: [] },
      ],
      weights: { 生产工艺: 50, 质量管理: 50 },
      scope: '', extra_sections: {},
    })
    expect(await screen.findByText('岗位“新岗位”已保存')).toBeInTheDocument()
  }, 20000)

  it('必填项和能力标签重复时给出说明并阻止保存', async () => {
    mockApi()
    const form = await openCreateForm()
    fireEvent.click(form.getByRole('button', { name: '保存岗位' }))
    expect(await form.findByText('请填写岗位名称')).toBeInTheDocument()
    expect(form.getByText('请至少填写一项岗位职责')).toBeInTheDocument()
    expect(form.getByText('请至少添加一项能力标签')).toBeInTheDocument()

    fillProfile(form)
    fillDimension(form, 1, '生产工艺', 50)
    fireEvent.click(form.getByRole('button', { name: /添加能力标签/ }))
    fillDimension(form, 2, ' 生产工艺 ', 50)
    fireEvent.click(form.getByRole('button', { name: '保存岗位' }))
    expect(await form.findByText('能力标签“生产工艺”重复，请合并后保存')).toBeInTheDocument()
    expect(sent('POST', '/library/jobs')).toHaveLength(0)
  }, 20000)

  it('同名岗位返回冲突后，确认覆盖才带上原岗位编号和版本指纹重新提交', async () => {
    mockApi(({ method, path, body }) => {
      if (method !== 'POST' || path !== '/library/jobs') return undefined
      if (!body?.overwrite_job_id) {
        return Response.json({ detail: { message: '已有岗位“制造生产储备岗”，请选择是否覆盖。', conflict: { job_id: 'JOB-AAAA0001', name: '制造生产储备岗', revision: 'rev-1' } } }, { status: 409 })
      }
      return Response.json(detail)
    })
    const form = await openCreateForm()
    fillProfile(form)
    fillDimension(form, 1, '生产工艺', 100)
    fireEvent.click(form.getByRole('button', { name: '保存岗位' }))

    const confirm = await dialogOf('已有同名岗位，是否覆盖？')
    expect(confirm.getByText('已有岗位“制造生产储备岗”，请选择是否覆盖。')).toBeInTheDocument()
    expect(confirm.getByText(/已有的匹配结果会标记为“需重新分析”/)).toBeInTheDocument()
    expect(sent('POST', '/library/jobs')).toHaveLength(1)
    expect(sent('POST', '/library/jobs')[0].body).not.toHaveProperty('overwrite_job_id')

    fireEvent.click(confirm.getByRole('button', { name: '确认覆盖' }))
    await waitFor(() => expect(sent('POST', '/library/jobs')).toHaveLength(2))
    const [firstBody, secondBody] = sent('POST', '/library/jobs').map(call => call.body)
    expect(secondBody).toEqual({ ...firstBody, overwrite_job_id: 'JOB-AAAA0001', overwrite_revision: 'rev-1' })
    expect(await screen.findByText('已覆盖岗位“制造生产储备岗”', { selector: '.ant-alert-message' })).toBeInTheDocument()
    expect(screen.getByText(/已有的匹配结果已标记为“需重新分析”/)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('新增岗位', { selector: '.ant-modal-title' })).not.toBeInTheDocument())
  }, 20000)

  it('不覆盖时不再提交，表单内容保留', async () => {
    mockApi(({ method, path }) => method === 'POST' && path === '/library/jobs'
      ? Response.json({ detail: { message: '已有岗位“制造生产储备岗”，请选择是否覆盖。', conflict: { job_id: 'JOB-AAAA0001', name: '制造生产储备岗', revision: 'rev-1' } } }, { status: 409 })
      : undefined)
    const form = await openCreateForm()
    fillProfile(form)
    fillDimension(form, 1, '生产工艺', 100)
    fireEvent.click(form.getByRole('button', { name: '保存岗位' }))
    const confirm = await dialogOf('已有同名岗位，是否覆盖？')
    fireEvent.click(confirm.getByRole('button', { name: '不覆盖' }))
    await waitFor(() => expect(screen.queryByText('已有同名岗位，是否覆盖？')).not.toBeVisible())
    expect(sent('POST', '/library/jobs')).toHaveLength(1)
    expect(form.getByLabelText('岗位名称')).toHaveValue('制造生产储备岗')
  }, 20000)

  it('AI生成的能力标签建议由使用者决定是否采用', async () => {
    const suggestion = {
      dimensions: [
        { name: '生产组织', keywords: ['生产组织', '排产'], negative_keywords: [] },
        { name: '质量安全', keywords: ['质量', '安全'], negative_keywords: [] },
        { name: '工艺知识', keywords: ['制造工艺'], negative_keywords: [] },
      ],
      weights: { 生产组织: 40, 质量安全: 35, 工艺知识: 25 },
      basis: [{ dimension: '生产组织', reason: '岗位职责强调车间生产组织', evidence: ['负责制造车间日常生产组织'] }],
    }
    mockApi(({ method, path }) => method === 'POST' && path === '/library/jobs/scorecard-suggestion' ? Response.json(suggestion) : undefined)
    const form = await openCreateForm()
    fillProfile(form)
    fireEvent.click(form.getByRole('button', { name: /AI生成能力标签建议/ }))
    const dialog = await dialogOf('AI生成能力标签建议')
    expect(await dialog.findByText('岗位职责强调车间生产组织')).toBeInTheDocument()
    expect(dialog.getByText('岗位原文：负责制造车间日常生产组织')).toBeInTheDocument()
    expect(dialog.getByText('AI辅助生成，须人工复核')).toBeInTheDocument()
    expect(sent('POST', '/library/jobs/scorecard-suggestion')[0].body).toEqual({
      name: '制造生产储备岗',
      responsibilities: ['负责制造车间日常生产组织', '落实质量与安全管理要求'],
      requirements: ['熟悉工业产品制造工艺流程'],
      dimensions: [], weights: {},
    })
    expect(form.getByLabelText('第1项能力标签')).toHaveValue('')

    fireEvent.click(dialog.getByRole('button', { name: '采用建议' }))
    await waitFor(() => expect(form.getByLabelText('第1项能力标签')).toHaveValue('生产组织'))
    expect(form.getByLabelText('第2项证据关键词')).toHaveValue('质量、安全')
    expect(form.getByLabelText('第3项权重')).toHaveValue('25')
    expect(form.getByRole('status')).toHaveTextContent('权重合计 100%')
    expect(sent('POST', '/library/jobs')).toHaveLength(0)
  }, 20000)
})

describe('岗位库：上传岗位说明书', () => {
  const draft = {
    name: '质量检验员', sequence: '生产类', level: '', jd_version: '2026版',
    responsibilities: ['负责原辅料和成品的检验'], requirements: ['熟悉检验标准'], hard_conditions: ['大专及以上学历'],
    dimensions: [{ name: '检验技能', keywords: ['检验'] }, { name: '质量意识', keywords: ['质量'] }],
    weights: { 检验技能: 60, 质量意识: 40 },
    scope: '导入岗位说明书：质检岗位说明书.pdf；评分标准来源：AI根据岗位说明书生成（待人工确认）',
    extra_sections: { 资料来源: '质检岗位说明书.pdf' },
    warning: '职级未能与原文对应，已留空，请核对补充。',
    model_source: 'AI根据岗位说明书生成（待人工确认）',
    scorecard_basis: [{ dimension: '检验技能', reason: '职责以检验为主', evidence: ['负责原辅料和成品的检验'] }],
    scorecard_error: '',
  }

  it('识别在后台进行并显示进度；草稿核对保存前不写入岗位库，失败的文件说明原因', async () => {
    let polls = 0
    let finish!: () => void
    const finished = new Promise<void>(resolve => { finish = resolve })
    mockApi(async ({ method, path }) => {
      if (method === 'POST' && path === '/library/jobs/import') {
        return Response.json({ id: 'op-1', kind: 'job_import', label: '识别 1 份岗位说明书', status: 'running', progress: '', result: null, error: '' })
      }
      if (method === 'GET' && path === '/library/operations/op-1') {
        polls += 1
        if (polls < 3) return Response.json({ id: 'op-1', kind: 'job_import', label: '', status: 'running', progress: '正在识别第 1/1 份：质检岗位说明书.pdf', result: null, error: '' })
        // 等页面显示过进度后再结束，避免轮询太快看不到进行中的状态。
        await finished
        return Response.json({
          id: 'op-1', kind: 'job_import', label: '', status: 'completed', progress: '', error: '',
          result: { drafts: [
            { source_file: '质检岗位说明书.pdf', index: 1, error: '', draft },
            { source_file: '质检岗位说明书.pdf', index: 2, error: 'chat-primary 提取未完成：未识别到可核对的岗位信息，请重试。', draft: null },
          ] },
        })
      }
      if (method === 'POST' && path === '/library/jobs') return Response.json({ ...detail, id: 'JOB-QC000001', name: '质量检验员' })
      return undefined
    })
    renderPage(editor)
    await screen.findByText('制造生产储备岗')
    fireEvent.click(screen.getByRole('button', { name: /上传岗位说明书/ }))
    const dialog = await dialogOf('上传岗位说明书')
    expect(dialog.getByRole('button', { name: '开始识别' })).toBeDisabled()

    fireEvent.change(dialog.getByLabelText('选择岗位说明书'), { target: { files: [pdf('质检岗位说明书.pdf'), new File(['x'], '岗位清单.xlsx')] } })
    expect(await dialog.findByText('岗位清单.xlsx：请上传 PDF、Word（.docx）或 TXT 文件')).toBeInTheDocument()
    expect(dialog.getByText('质检岗位说明书.pdf')).toBeInTheDocument()
    expect(dialog.getByText('已选择 1 / 10 份')).toBeInTheDocument()

    fireEvent.click(dialog.getByRole('button', { name: '开始识别' }))
    expect(await dialog.findByText('正在识别第 1/1 份：质检岗位说明书.pdf')).toBeInTheDocument()
    const upload = sent('POST', '/library/jobs/import')[0]
    expect((upload.form?.getAll('files') as File[]).map(file => file.name)).toEqual(['质检岗位说明书.pdf'])
    expect(upload.form?.get('reference_job_id')).toBeNull()
    expect(dialog.getByRole('button', { name: '停止等待' })).toBeInTheDocument()
    expect(sent('POST', '/library/jobs')).toHaveLength(0)

    finish()
    expect(await dialog.findByText(/识别出 1 个岗位草稿，已保存 0 个，待核对 1 个；另有 1 项未能识别/)).toBeInTheDocument()
    expect(polls).toBe(3)
    expect(dialog.getByLabelText('岗位名称')).toHaveValue('质量检验员')
    expect(dialog.getByLabelText('岗位职责')).toHaveValue('负责原辅料和成品的检验')
    expect(dialog.getByLabelText('第1项能力标签')).toHaveValue('检验技能')
    expect(dialog.getByLabelText('第1项权重')).toHaveValue('60')
    expect(dialog.getByText('职级未能与原文对应，已留空，请核对补充。')).toBeInTheDocument()
    expect(dialog.getByText(/能力标签来源：AI根据岗位说明书生成（待人工确认）/)).toBeInTheDocument()
    expect(sent('POST', '/library/jobs')).toHaveLength(0)

    fireEvent.click(dialog.getByText('2. 质检岗位说明书.pdf'))
    expect(await dialog.findByText(/未识别到可核对的岗位信息/)).toBeInTheDocument()

    fireEvent.click(dialog.getByRole('button', { name: '确认并保存为岗位' }))
    expect(await dialog.findByText('请填写岗位层级')).toBeInTheDocument()
    expect(sent('POST', '/library/jobs')).toHaveLength(0)

    fireEvent.change(dialog.getByLabelText('层级'), { target: { value: '专员' } })
    fireEvent.click(dialog.getByRole('button', { name: '确认并保存为岗位' }))
    expect(await dialog.findByText('已保存为岗位“质量检验员”')).toBeInTheDocument()
    expect(sent('POST', '/library/jobs')).toHaveLength(1)
    expect(sent('POST', '/library/jobs')[0].body).toMatchObject({
      name: '质量检验员', level: '专员', jd_version: '2026版', hard_conditions: ['大专及以上学历'],
      dimensions: [{ name: '检验技能', keywords: ['检验'], negative_keywords: [] }, { name: '质量意识', keywords: ['质量'], negative_keywords: [] }],
      weights: { 检验技能: 60, 质量意识: 40 },
      extra_sections: { 资料来源: '质检岗位说明书.pdf' },
    })
    expect(dialog.getByText(/识别出 1 个岗位草稿，已保存 1 个，待核对 0 个/)).toBeInTheDocument()
    await waitFor(() => expect(sent('GET', '/library/jobs').length).toBeGreaterThan(1))
  }, 30000)

  it('模型服务不可用时显示后端给出的原因，可重新开始', async () => {
    mockApi(({ method, path }) => {
      if (method === 'POST' && path === '/library/jobs/import') {
        return Response.json({ id: 'op-2', kind: 'job_import', label: '', status: 'running', progress: '', result: null, error: '' })
      }
      if (path === '/library/operations/op-2') {
        return Response.json({ id: 'op-2', kind: 'job_import', label: '', status: 'failed', progress: '', result: null, error: '识别服务尚未启用，请检查模型配置后重试。' })
      }
      return undefined
    })
    renderPage(editor)
    await screen.findByText('制造生产储备岗')
    fireEvent.click(screen.getByRole('button', { name: /上传岗位说明书/ }))
    const dialog = await dialogOf('上传岗位说明书')
    fireEvent.change(dialog.getByLabelText('选择岗位说明书'), { target: { files: [pdf('岗位说明书.pdf')] } })
    fireEvent.click(await dialog.findByRole('button', { name: '开始识别' }))
    expect(await dialog.findByText('识别服务尚未启用，请检查模型配置后重试。')).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: '开始识别' })).toBeEnabled()
    expect(dialog.getByText('岗位说明书.pdf')).toBeInTheDocument()
  }, 20000)
})

describe('岗位库：岗位详情', () => {
  async function openDetail(action: '查看' | '编辑') {
    renderPage(editor)
    fireEvent.click(within(await rowOf('制造生产储备岗')).getByRole('button', { name: action }))
    const drawer = await drawerOf('制造生产储备岗')
    await drawer.findByRole('tab', { name: '岗位说明' })
    return drawer
  }

  it('修改能力标签后保存完整内容，并提示已有匹配结果需要重新分析', async () => {
    mockApi(({ method, path, body }) => method === 'PUT' && path === '/library/jobs/JOB-AAAA0001'
      ? Response.json({ ...detail, ...body, hard_conditions: body?.hard_conditions, scorecard_change: { changed: true, synchronized: 0 } })
      : undefined)
    const drawer = await openDetail('编辑')
    expect(await drawer.findByLabelText('岗位名称')).toHaveValue('制造生产储备岗')
    expect(drawer.getByLabelText('岗位职责')).toHaveValue('负责制造车间日常生产组织\n落实质量与安全管理要求')
    expect(drawer.getByLabelText('第1项补充信息名称')).toHaveValue('工作地点')

    fireEvent.click(drawer.getByRole('tab', { name: '能力标签与权重' }))
    expect(drawer.getByLabelText('第1项能力标签')).toHaveValue('生产工艺')
    expect(drawer.getByLabelText('第1项证据关键词')).toHaveValue('制造、工艺')
    fireEvent.change(drawer.getByLabelText('第1项证据关键词'), { target: { value: '制造、工艺、装配' } })
    fireEvent.click(drawer.getByRole('button', { name: '保存岗位说明与能力标签' }))

    await waitFor(() => expect(sent('PUT', '/library/jobs/JOB-AAAA0001')).toHaveLength(1))
    expect(sent('PUT', '/library/jobs/JOB-AAAA0001')[0].body).toEqual({
      name: '制造生产储备岗', sequence: '生产类', level: '专员', jd_version: '2026.09',
      responsibilities: ['负责制造车间日常生产组织', '落实质量与安全管理要求'],
      requirements: ['熟悉工业产品制造工艺流程'],
      hard_conditions: ['本科及以上学历', '3年以上相关工作经验'],
      dimensions: [
        { name: '生产工艺', keywords: ['制造', '工艺', '装配'], negative_keywords: [] },
        { name: '质量管理', keywords: ['质量'], negative_keywords: [] },
        { name: '安全意识', keywords: ['安全'], negative_keywords: [] },
      ],
      weights: { 生产工艺: 50, 质量管理: 30, 安全意识: 20 },
      scope: '人工新增岗位', extra_sections: { 工作地点: '示例园区' },
    })
    expect(await drawer.findByText('该岗位已有的匹配结果需要重新分析')).toBeInTheDocument()
    expect(drawer.getByText(/本次修改了能力标签或证据关键词。该岗位已用于 4 个匹配任务/)).toBeInTheDocument()
    expect(drawer.queryByRole('button', { name: '保存岗位说明与能力标签' })).not.toBeInTheDocument()
  }, 20000)

  it('只调整权重时说明已按新权重重新计算；另一页签里的问题会被带到眼前', async () => {
    mockApi(({ method, path, body }) => method === 'PUT' && path === '/library/jobs/JOB-AAAA0001'
      ? Response.json({ ...detail, weights: body?.weights, scorecard_change: { changed: false, synchronized: 7 } })
      : undefined)
    const drawer = await openDetail('编辑')
    fireEvent.click(await drawer.findByRole('tab', { name: '能力标签与权重' }))
    const weight = drawer.getByLabelText('第1项权重')
    fireEvent.change(weight, { target: { value: '40' } })
    fireEvent.blur(weight)
    fireEvent.click(drawer.getByRole('tab', { name: '岗位说明' }))
    fireEvent.click(drawer.getByRole('button', { name: '保存岗位说明与能力标签' }))
    expect(await drawer.findByText('权重合计须为 100%，当前为 90%')).toBeInTheDocument()
    expect(drawer.getByRole('tab', { name: '能力标签与权重' })).toHaveAttribute('aria-selected', 'true')
    expect(sent('PUT', '/library/jobs/JOB-AAAA0001')).toHaveLength(0)

    const third = drawer.getByLabelText('第3项权重')
    fireEvent.change(third, { target: { value: '30' } })
    fireEvent.blur(third)
    fireEvent.click(drawer.getByRole('button', { name: '保存岗位说明与能力标签' }))
    expect(await drawer.findByText('已按新权重重新计算匹配得分')).toBeInTheDocument()
    expect(drawer.getByText(/重新计算 7 人的匹配得分/)).toBeInTheDocument()
    expect(sent('PUT', '/library/jobs/JOB-AAAA0001')[0].body?.weights).toEqual({ 生产工艺: 40, 质量管理: 30, 安全意识: 30 })
  }, 20000)

  it('放弃修改需要确认；再次编辑时回到已保存的内容', async () => {
    mockApi()
    const drawer = await openDetail('编辑')
    fireEvent.change(await drawer.findByLabelText('岗位名称'), { target: { value: '临时改名' } })
    fireEvent.click(drawer.getByRole('tab', { name: '能力标签与权重' }))
    fireEvent.click(drawer.getByRole('button', { name: '删除第3项能力标签' }))
    fireEvent.click(drawer.getByRole('button', { name: '取消编辑' }))
    expect(await screen.findByText('放弃未保存的修改？')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }))

    fireEvent.click(await drawer.findByRole('button', { name: /编辑岗位/ }))
    expect(await drawer.findByLabelText('第3项能力标签')).toHaveValue('安全意识')
    expect(drawer.getByRole('status')).toHaveTextContent('权重合计 100%')
    fireEvent.click(drawer.getByRole('tab', { name: '岗位说明' }))
    expect(drawer.getByLabelText('岗位名称')).toHaveValue('制造生产储备岗')
    expect(sent('PUT', '/library/jobs/JOB-AAAA0001')).toHaveLength(0)

    fireEvent.click(drawer.getByRole('button', { name: '取消编辑' }))
    expect(await drawer.findByRole('button', { name: /编辑岗位/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '放弃修改' })).not.toBeInTheDocument()
  }, 20000)

  it('导出能力标签：读取结构化数据并在浏览器端生成 JSON 文件', async () => {
    const tags = {
      job_id: 'JOB-AAAA0001', job_name: '制造生产储备岗', sequence: '生产类', level: '专员',
      required_tags: [{ name: '本科及以上学历', type: '硬性条件' }],
      capability_tags: [{ name: '生产工艺', weight: 50, keywords: ['制造', '工艺'] }],
      notice: '能力标签由AI根据岗位说明书识别并经人工维护，仅供业务参考。',
    }
    mockApi(({ path }) => path === '/library/jobs/JOB-AAAA0001/capability-tags' ? Response.json(tags) : undefined)
    const blobs: Blob[] = []
    const downloads: string[] = []
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:capability-tags' }) })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download) })

    const drawer = await openDetail('查看')
    fireEvent.click(drawer.getByRole('tab', { name: '能力标签与权重' }))
    fireEvent.click(await drawer.findByRole('button', { name: /导出能力标签 \(JSON\)/ }))
    await waitFor(() => expect(downloads).toEqual(['制造生产储备岗_能力标签.json']))
    expect(blobs).toHaveLength(1)
    expect(blobs[0].type).toContain('application/json')
    expect(JSON.parse(await readBlob(blobs[0]))).toEqual(tags)
  }, 20000)

  it('面试评价标准在岗位详情中维护：编辑后按结构保存，保留原有的中间等级和扩展字段', async () => {
    mockApi(({ method, path, body }) => method === 'PUT' && path === '/library/jobs/JOB-AAAA0001/interview-standard'
      ? Response.json({ ...standard, ...body })
      : undefined)
    const drawer = await openDetail('查看')
    fireEvent.click(drawer.getByRole('tab', { name: /面试评价标准/ }))
    expect(await drawer.findByText('面试批次只有在评价标准为“已确认”后才能生成题目。')).toBeInTheDocument()
    expect(drawer.getByText('熟悉制造工艺与质量安全要求')).toBeInTheDocument()
    expect(drawer.getByText('制造岗位手册.pdf')).toBeInTheDocument()
    expect(drawer.getByText('已完成')).toBeInTheDocument()

    fireEvent.click(drawer.getByRole('button', { name: /编辑评价标准/ }))
    const level = await drawer.findByLabelText('第1项3分表现')
    expect(level).toHaveValue('岗位专业能力三分')
    fireEvent.change(level, { target: { value: '能独立完成异常分析' } })
    fireEvent.click(drawer.getByRole('radio', { name: '已确认' }))
    fireEvent.click(drawer.getByRole('button', { name: '保存面试评价标准' }))

    await waitFor(() => expect(sent('PUT', '/library/jobs/JOB-AAAA0001/interview-standard')).toHaveLength(1))
    const body = sent('PUT', '/library/jobs/JOB-AAAA0001/interview-standard')[0].body as { competency_model: typeof savedModel } & Record<string, unknown>
    expect(body).toMatchObject({ professional_requirements: '熟悉制造工艺与质量安全要求', material_version: 'v1.0', audit_status: 'approved' })
    expect(body.competency_model).toHaveLength(6)
    expect(body.competency_model[0]).toEqual({ ...savedModel[0], levels: { ...savedModel[0].levels, '3': '能独立完成异常分析' } })
    expect(body.competency_model[1]).toEqual(savedModel[1])
    expect(await drawer.findByText('能独立完成异常分析')).toBeInTheDocument()
    expect(drawer.queryByRole('button', { name: '保存面试评价标准' })).not.toBeInTheDocument()
  }, 20000)

  it('评价维度不在六维体系内时不能保存', async () => {
    mockApi()
    const drawer = await openDetail('查看')
    fireEvent.click(drawer.getByRole('tab', { name: /面试评价标准/ }))
    fireEvent.click(await drawer.findByRole('button', { name: /编辑评价标准/ }))
    fireEvent.change(await drawer.findByRole('combobox', { name: '第1项能力维度' }), { target: { value: '现场协作' } })
    fireEvent.click(drawer.getByRole('button', { name: '保存面试评价标准' }))
    expect(await drawer.findByText(/评价维度“现场协作”不在六维评价体系内/)).toBeInTheDocument()
    expect(sent('PUT', /interview-standard/)).toHaveLength(0)
  }, 20000)

  it('评分标准建议生成时显示进度，应用到编辑区后仍需人工保存', async () => {
    let finish!: (response: Response) => void
    const advice = {
      job_code: 'JOB-AAAA0001', job_name: '制造生产储备岗', total_weight: 100, rationale: '生产类岗位重点考察现场专业能力',
      criteria: sixDimensions.map((name, index) => ({
        dimension: name, suggested_weight: [30, 20, 15, 15, 10, 10][index], definition: `${name}的建议要求`,
        levels: { '0': '答非所问', '1': `${name}建议一分`, '3': `${name}建议三分`, '5': `${name}建议五分` },
        evidence_focus: ['具体处置行动'],
      })),
      guardrails: ['不输出录用或淘汰结论'], status: 'suggested', provenance: 'AI辅助生成，须人工复核',
    }
    mockApi(({ method, path }) => method === 'POST' && path === '/library/jobs/JOB-AAAA0001/interview-standard/advice'
      ? new Promise<Response>(resolve => { finish = resolve })
      : undefined)
    const drawer = await openDetail('查看')
    fireEvent.click(drawer.getByRole('tab', { name: /面试评价标准/ }))
    fireEvent.click(await drawer.findByRole('button', { name: /生成评分标准建议/ }))
    expect(await drawer.findByRole('status')).toHaveTextContent('正在生成“制造生产储备岗”的评分标准建议')
    fireEvent.click(drawer.getByRole('button', { name: /正在生成/ }))
    expect(sent('POST', /advice/)).toHaveLength(1)

    finish(Response.json(advice))
    expect(await drawer.findByText('生产类岗位重点考察现场专业能力')).toBeInTheDocument()
    expect(drawer.getByText('岗位专业能力的建议要求')).toBeInTheDocument()
    expect(drawer.getByText('不输出录用或淘汰结论')).toBeInTheDocument()
    expect(drawer.getByText('岗位专业能力的岗位要求')).toBeInTheDocument()

    fireEvent.click(drawer.getByRole('button', { name: '应用到编辑区' }))
    expect(await drawer.findByLabelText('第1项考察要求')).toHaveValue('岗位专业能力的建议要求')
    expect(drawer.getByLabelText('第1项5分表现')).toHaveValue('岗位专业能力建议五分')
    expect(sent('PUT', /interview-standard/)).toHaveLength(0)

    fireEvent.click(drawer.getByRole('button', { name: /取\s*消/ }))
    expect(await drawer.findByText('岗位专业能力的岗位要求')).toBeInTheDocument()
    expect(sent('PUT', /interview-standard/)).toHaveLength(0)

    fireEvent.click(drawer.getByRole('button', { name: /编辑评价标准/ }))
    expect(await drawer.findByLabelText('第1项考察要求')).toHaveValue('岗位专业能力的岗位要求')
    expect(drawer.getByLabelText('第1项5分表现')).toHaveValue('岗位专业能力五分')
  }, 20000)

  it('补充材料：只接受 PDF，上传后显示识别状态，可删除', async () => {
    const materials = [...standard.materials]
    mockApi(({ method, path, form }) => {
      if (method === 'GET' && path === '/library/jobs/JOB-AAAA0001/interview-standard') return Response.json({ ...standard, materials: [...materials], default_model: defaultModel })
      if (method === 'POST' && path === '/library/jobs/JOB-AAAA0001/materials') {
        const file = form?.get('file') as File
        const material = { id: 10, original_name: file.name, size: file.size, ocr_status: 'failed', ocr_text_preview: '', ocr_at: '2026-09-22T02:00:00' }
        materials.push(material)
        return Response.json({ ...material, ocr_provider: 'paddleocr', ocr_error: 'RuntimeError: service unavailable' })
      }
      if (method === 'DELETE' && path === '/library/jobs/JOB-AAAA0001/materials/9') {
        materials.splice(0, 1)
        return Response.json({ ok: true })
      }
      return undefined
    })
    const drawer = await openDetail('查看')
    fireEvent.click(drawer.getByRole('tab', { name: /面试评价标准/ }))
    const picker = await drawer.findByLabelText('上传补充材料（PDF）')

    fireEvent.change(picker, { target: { files: [new File(['x'], '岗位说明.docx')] } })
    expect(await drawer.findByText('岗位说明.docx：补充材料目前只支持 PDF')).toBeInTheDocument()
    expect(sent('POST', /materials/)).toHaveLength(0)

    fireEvent.change(picker, { target: { files: [pdf('工艺规程.pdf')] } })
    expect(await drawer.findByText(/工艺规程.pdf 已保存，但文字识别未完成/)).toBeInTheDocument()
    expect(drawer.getByText('识别失败')).toBeInTheDocument()
    expect(drawer.queryByText(/RuntimeError/)).not.toBeInTheDocument()

    fireEvent.click(drawer.getByRole('button', { name: '删除 制造岗位手册.pdf' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(sent('DELETE', '/library/jobs/JOB-AAAA0001/materials/9')).toHaveLength(1))
    await waitFor(() => expect(drawer.queryByText('制造岗位手册.pdf')).not.toBeInTheDocument())
  }, 20000)
})

describe('岗位库：删除、恢复与彻底删除', () => {
  it('删除需要二次确认；后端拒绝时显示原因', async () => {
    mockApi(({ method, path }) => method === 'POST' && path === '/library/jobs/JOB-AAAA0001/archive'
      ? Response.json({ detail: '该岗位已有面试批次和候选人，删除后将无法新建任务；如确需停用，请先处理相关批次' }, { status: 409 })
      : undefined)
    renderPage(editor)
    fireEvent.click(within(await rowOf('制造生产储备岗')).getByRole('button', { name: '删除' }))
    expect(sent('POST', /archive/)).toHaveLength(0)
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }))
    expect(await screen.findByText('岗位“制造生产储备岗”未能删除')).toBeInTheDocument()
    expect(screen.getByText('该岗位已有面试批次和候选人，删除后将无法新建任务；如确需停用，请先处理相关批次')).toBeInTheDocument()
    expect(sent('POST', '/library/jobs/JOB-AAAA0001/archive')).toHaveLength(1)
  }, 20000)

  it('已删除岗位可以恢复；彻底删除需要输入岗位名称确认', async () => {
    mockApi(({ method, path }) => {
      if (method === 'POST' && path === '/library/jobs/JOB-CCCC0003/restore') return Response.json({ ok: true })
      if (method === 'DELETE' && path === '/library/jobs/JOB-CCCC0003') return Response.json({ detail: '该岗位已关联面试批次或候选人，不能彻底删除' }, { status: 409 })
      return undefined
    })
    renderPage(editor)
    await screen.findByText('制造生产储备岗')
    fireEvent.click(screen.getByRole('switch', { name: '显示已删除' }))
    const row = within(await rowOf('旧版质检岗'))

    fireEvent.click(row.getByRole('button', { name: '彻底删除' }))
    const dialog = await dialogOf('彻底删除岗位“旧版质检岗”')
    expect(dialog.getByText('彻底删除后无法恢复')).toBeInTheDocument()
    const confirm = dialog.getByRole('button', { name: '彻底删除' })
    expect(confirm).toBeDisabled()
    fireEvent.change(dialog.getByLabelText('输入岗位名称以确认彻底删除'), { target: { value: '旧版质检岗' } })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    expect(await dialog.findByText('该岗位已关联面试批次或候选人，不能彻底删除')).toBeInTheDocument()
    expect(sent('DELETE', '/library/jobs/JOB-CCCC0003')).toHaveLength(1)
    fireEvent.click(dialog.getByRole('button', { name: /取\s*消/ }))

    fireEvent.click(row.getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(sent('POST', '/library/jobs/JOB-CCCC0003/restore')).toHaveLength(1))
    expect(await screen.findByText('岗位“旧版质检岗”已恢复')).toBeInTheDocument()
  }, 20000)
})
