import '@ant-design/v5-patch-for-react-19'
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { message } from 'antd'
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { polling } from '../pages/library/operations'
import MatchingTasksPage from '../pages/matching/MatchingTasksPage'
import type { MatchingMode, TaskSummary } from '../pages/matching/types'
import type { Session } from '../types'

const ALL = ['matching:view', 'matching:create', 'matching:review', 'matching:export', 'matching:delete', 'job:read', 'person:read']
/** 可以新建任务，也可以维护人员库（上传简历、新建批次）。 */
const UPLOADER = [...ALL, 'person:edit']

const options = (permissions: string[], maxPeople = 20) => ({
  max_people: maxPeople,
  decisions: [{ value: '进入下一轮', label: '通过 · 进入下一轮' }, { value: '保留', label: '保留 · 待进一步核验' }, { value: '淘汰', label: '未通过' }],
  fit_decisions: [{ value: '推荐至该岗位', label: '通过 · 推荐至该岗位' }, { value: '作为备选岗位', label: '保留 · 作为备选岗位' }, { value: '暂不推荐', label: '未通过 · 暂不推荐' }],
  can_create: permissions.includes('matching:create'), can_review: permissions.includes('matching:review'),
  can_export: permissions.includes('matching:export'), can_delete: permissions.includes('matching:delete'),
})

const runningTask: TaskSummary = {
  id: 'TASK-RUN', name: '九月社招第一批', mode: 'job_to_people', mode_label: '岗位选才', status: '处理中', running: true,
  jobs: [{ id: 'JOB-1', name: '制造工艺工程师' }], person_batch_id: 'TLB-1', total: 3, processed: 1, succeeded: 1, failed: 0,
  failures: [], created_at: '2026-09-28T09:00:00+08:00', updated_at: '2026-09-28T09:01:00+08:00',
  review: { passed: 0, rejected: 0, kept: 0, pending: 3, stale: 0, exportable: 0, people: 3 },
}
const finishedTask: TaskSummary = {
  id: 'TASK-DONE', name: '八月校招复核批', mode: 'job_to_people', mode_label: '岗位选才', status: '部分失败', running: false,
  jobs: [{ id: 'JOB-2', name: '质量管理岗' }], person_batch_id: 'TLB-2', total: 6, processed: 6, succeeded: 5, failed: 1,
  failures: [{ file: 'TLE-9', reason: 'AI分析未完成：AI评分服务未配置或未确认', stage: 'analysis' }],
  created_at: '2026-08-20T10:00:00+08:00', updated_at: '2026-08-20T10:30:00+08:00',
  review: { passed: 2, rejected: 1, kept: 1, pending: 1, stale: 1, exportable: 3, people: 6 },
}

const jobs = [
  { id: 'JOB-1', name: '制造工艺工程师', sequence: '生产技术', level: 'P5', updated_at: '2026-09-20T10:00:00+08:00', is_active: true, dimension_count: 5, hard_condition_count: 2 },
  { id: 'JOB-2', name: '质量管理岗', sequence: '质量管理', level: 'P4', updated_at: '2026-09-18T10:00:00+08:00', is_active: true, dimension_count: 4, hard_condition_count: 0 },
]
const batches = [{ id: 'TLB-1', name: '2026 社招第一批', category: '社招', created_at: '2026-09-01T08:00:00+08:00', total_count: 5, parsed_count: 3, failed_count: 1, pending_count: 1 }]
const person = (id: string, name: string, status: string, error = '') => ({
  id, batch_id: 'TLB-1', name, source_filename: `${name}.pdf`, status, parse_status: status === '已解析' ? '解析成功' : '待人工确认',
  confirmed: false, error_message: error, education: '', work_experience: '', created_at: '2026-09-01T08:00:00+08:00',
})
const persons = [
  person('TLE-1', '候选人甲', '已解析'), person('TLE-2', '候选人乙', '已解析'), person('TLE-3', '候选人丙', '已解析'),
  person('TLE-4', '候选人丁', '解析失败', '文件无法读取'), person('TLE-5', '候选人戊', '待解析'),
]

type Handler = (url: URL, init?: RequestInit) => unknown

/** 按接口地址返回数据（可以是 Promise，用来控制何时返回）；未列出的接口返回 404，避免测试悄悄依赖不存在的接口。 */
function mockApi(handler: Handler) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    const result = await handler(url, init)
    if (result instanceof Response) return result
    if (result === undefined) return Response.json({ detail: '所需记录不存在' }, { status: 404 })
    return Response.json(result)
  })
}

function library(url: URL) {
  if (url.pathname.endsWith('/library/jobs')) return jobs
  if (url.pathname.endsWith('/library/person-batches')) return batches
  if (url.pathname.endsWith('/library/person-batches/TLB-1')) return { ...batches[0], persons }
  return undefined
}

function Where() {
  const location = useLocation()
  return <div data-testid="where">{location.pathname}{location.search}</div>
}

function renderPage(mode: MatchingMode = 'job_to_people', permissions: string[] = ALL) {
  const session: Session = { access_token: 'test-token', expires_at: 4102444800, username: 'hr', display_name: 'HR管理员', role: 'hr_admin', role_label: 'HR管理员', permissions }
  const Layout = () => <Outlet context={{ session }} />
  const path = mode === 'job_to_people' ? '/matching/job-to-people' : '/matching/people-to-jobs'
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path={path} element={<MatchingTasksPage mode={mode} pollIntervalMs={20} />} />
          <Route path={`${path}/:taskId`} element={<Where />} />
          <Route path="/library/jobs" element={<Where />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

const pause = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
const rowOf = (text: string) => screen.getByText(text).closest('tr') as HTMLElement
/** 按按钮上的文字查找按钮。比按角色和名称查找快得多（后者要为页面上每个元素计算无障碍名称）。 */
const buttonIn = (scope: Pick<typeof screen, 'getByText'>, name: string | RegExp) =>
  scope.getByText(name, { selector: 'button, button *' }).closest('button') as HTMLButtonElement
const posted = (fetchMock: ReturnType<typeof mockApi>, method: string, path: string) => fetchMock.mock.calls
  .filter(([input, init]) => (init?.method || 'GET') === method && new URL(String(input)).pathname.endsWith(path))
  .map(([, init]) => init?.body ? JSON.parse(String(init.body)) : undefined)

// 按角色查找时不逐个计算元素是否可见，否则大表格下查询很慢；表单校验等异步结果在负载高时较慢，放宽等待时间。
configure({ defaultHidden: true, asyncUtilTimeout: 5000 })
// 测试环境里多行输入框的自适应高度计算较慢，放宽单个测试的时限。
vi.setConfig({ testTimeout: 40000 })

const computedStyle = window.getComputedStyle.bind(window)
beforeEach(() => {
  // jsdom 不支持读取伪元素样式，表格测量滚动条时只取元素本身的样式。
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element))
})
afterEach(async () => {
  await act(async () => { message.destroy() })
  vi.restoreAllMocks()
})

describe('人岗匹配任务列表', () => {
  it('显示进度、复核进度和可导出报告数；分析结束后停止自动刷新', async () => {
    let listCalls = 0
    mockApi(url => {
      if (url.pathname.endsWith('/matching/options')) return options(ALL)
      if (url.pathname.endsWith('/matching/tasks')) {
        expect(url.searchParams.get('mode')).toBe('job_to_people')
        listCalls += 1
        return listCalls < 3
          ? [runningTask, finishedTask]
          : [{ ...runningTask, status: '已完成', running: false, processed: 3, succeeded: 3 }, finishedTask]
      }
      return undefined
    })
    renderPage()

    expect(await screen.findByText('九月社招第一批')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '岗位选才' })).toBeInTheDocument()
    expect(screen.getByText('已处理 1/3')).toBeInTheDocument()
    expect(screen.getByText('分析中')).toBeInTheDocument()
    expect(screen.getByText(/有任务正在后台分析/)).toBeInTheDocument()

    const done = within(rowOf('八月校招复核批'))
    expect(done.getByText('质量管理岗')).toBeInTheDocument()
    expect(done.getByText('已处理 6/6')).toBeInTheDocument()
    expect(done.getByText('部分未完成')).toBeInTheDocument()
    expect(done.getByText('1 项未完成')).toBeInTheDocument()
    for (const label of ['通过 2', '保留 1', '未通过 1', '待审核 1', '需重新审核 1']) expect(done.getByText(label)).toBeInTheDocument()
    expect(done.getByText('3')).toHaveClass('match-score')

    await waitFor(() => expect(screen.getByText('已处理 3/3')).toBeInTheDocument())
    expect(screen.queryByText(/有任务正在后台分析/)).not.toBeInTheDocument()
    expect(listCalls).toBe(3)
    await pause(150)
    expect(listCalls).toBe(3)
  })

  it('离开页面后不再刷新', async () => {
    let listCalls = 0
    mockApi(url => {
      if (url.pathname.endsWith('/matching/options')) return options(ALL)
      if (url.pathname.endsWith('/matching/tasks')) { listCalls += 1; return [runningTask] }
      return undefined
    })
    const view = renderPage()
    await screen.findByText('九月社招第一批')
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(3))
    view.unmount()
    const settled = listCalls
    await pause(150)
    expect(listCalls).toBe(settled)
  })

  it('没有任务时说明准备工作并给出岗位库、人员库入口', async () => {
    mockApi(url => {
      if (url.pathname.endsWith('/matching/options')) return options(ALL)
      if (url.pathname.endsWith('/matching/tasks')) return []
      return undefined
    })
    renderPage('people_to_jobs')
    expect(await screen.findByText('还没有人才适岗任务')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '前往岗位库' })).toHaveAttribute('href', '/library/jobs')
    expect(screen.getByRole('link', { name: '前往人员库' })).toHaveAttribute('href', '/library/persons')
    expect(screen.getByText(/选择至少两个岗位和参加匹配的人员/)).toBeInTheDocument()
    expect(screen.queryByText(/人才库/)).not.toBeInTheDocument()
  })

  it('没有新建、删除权限时不显示对应入口', async () => {
    const permissions = ['matching:view', 'matching:review']
    mockApi(url => {
      if (url.pathname.endsWith('/matching/options')) return options(permissions)
      if (url.pathname.endsWith('/matching/tasks')) return [finishedTask]
      return undefined
    })
    renderPage('job_to_people', permissions)
    await screen.findByText('八月校招复核批')
    expect(screen.queryByRole('button', { name: /新建任务/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /删除/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看' })).toBeInTheDocument()
  })

  it('点击任务进入任务页；删除需确认，分析中的任务不能删除', async () => {
    let removed = false
    const fetchMock = mockApi((url, init) => {
      if (url.pathname.endsWith('/matching/options')) return options(ALL)
      if (url.pathname.endsWith('/matching/tasks')) return removed ? [runningTask] : [runningTask, finishedTask]
      if (init?.method === 'DELETE' && url.pathname.endsWith('/matching/tasks/TASK-DONE')) { removed = true; return { ok: true } }
      return undefined
    })
    renderPage()
    await screen.findByText('八月校招复核批')
    expect(within(rowOf('九月社招第一批')).getByRole('button', { name: /删除/ })).toBeDisabled()

    fireEvent.click(within(rowOf('八月校招复核批')).getByRole('button', { name: /删除/ }))
    expect(await screen.findByText('确认删除任务“八月校招复核批”？')).toBeInTheDocument()
    expect(screen.getByText(/人员库和岗位库中的资料不受影响/)).toBeInTheDocument()
    expect(posted(fetchMock, 'DELETE', '/matching/tasks/TASK-DONE')).toHaveLength(0)
    fireEvent.click(buttonIn(within(screen.getByRole('tooltip')), /^删\s*除$/))
    await waitFor(() => expect(screen.queryByText('八月校招复核批')).not.toBeInTheDocument())
    expect(posted(fetchMock, 'DELETE', '/matching/tasks/TASK-DONE')).toHaveLength(1)
    // 确认删除时的点击不应被当作“打开任务”。
    expect(screen.queryByTestId('where')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('九月社招第一批'))
    expect(await screen.findByTestId('where')).toHaveTextContent('/matching/job-to-people/TASK-RUN')
  })
})

describe('新建匹配任务', () => {
  it('岗位选才：必须选岗位和人员，未解析人员不可选，超过人数上限不能继续，提交内容正确', async () => {
    const fetchMock = mockApi((url, init) => {
      if (url.pathname.endsWith('/matching/options')) return options(ALL, 2)
      if (url.pathname.endsWith('/matching/tasks') && init?.method === 'POST') return { ...runningTask, id: 'TASK-NEW', status: '待处理', review: null }
      if (url.pathname.endsWith('/matching/tasks')) return []
      return library(url)
    })
    renderPage()
    fireEvent.click((await screen.findAllByRole('button', { name: /新建任务/ }))[0])
    const drawer = within(await screen.findByRole('dialog'))
    expect(drawer.getByText('新建岗位选才任务')).toBeInTheDocument()

    // 第一步：岗位
    const jobRow = within((await drawer.findByText('制造工艺工程师')).closest('tr') as HTMLElement)
    expect(jobRow.getByText('2 项')).toBeInTheDocument()
    expect(jobRow.getByText('5 项')).toBeInTheDocument()
    fireEvent.click(buttonIn(drawer, '下一步'))
    expect(await drawer.findByText('请选择一个岗位')).toBeInTheDocument()
    expect(drawer.queryByLabelText('选择人员批次', { selector: 'input' })).not.toBeInTheDocument()
    fireEvent.click(jobRow.getByRole('radio'))
    fireEvent.click(buttonIn(drawer, '下一步'))

    // 第二步：人员
    expect(await drawer.findByText(/单个任务最多 2 人/)).toBeInTheDocument()
    fireEvent.click(buttonIn(drawer, '下一步'))
    expect(await drawer.findByText('请选择人员批次')).toBeInTheDocument()
    fireEvent.mouseDown(drawer.getByLabelText('选择人员批次', { selector: 'input' }))
    fireEvent.click(await screen.findByText('2026 社招第一批 · 社招 · 已解析 3/5 人'))
    await drawer.findByText('候选人甲')
    const row = (name: string) => within(drawer.getByText(name).closest('tr') as HTMLElement)
    expect(row('候选人丁').getByRole('checkbox')).toBeDisabled()
    expect(row('候选人丁').getByText('不可选择：文件无法读取；请在人员库重新解析后再选择')).toBeInTheDocument()
    expect(row('候选人戊').getByRole('checkbox')).toBeDisabled()
    expect(row('候选人戊').getByText('不可选择：简历正在解析，完成后才能选择')).toBeInTheDocument()
    expect(row('候选人甲').getByRole('checkbox')).toBeEnabled()

    fireEvent.click(buttonIn(drawer, '下一步'))
    expect(await drawer.findByText('请至少选择一名已解析的人员')).toBeInTheDocument()

    fireEvent.click(buttonIn(drawer, '全选已解析'))
    expect(await drawer.findByText('已选择 3 人，超过单个任务上限 2 人，请取消 1 人后继续')).toBeInTheDocument()
    expect(row('候选人丁').getByRole('checkbox')).not.toBeChecked()
    fireEvent.click(buttonIn(drawer, '下一步'))
    expect(drawer.queryByLabelText('任务名称（可选）')).not.toBeInTheDocument()

    fireEvent.click(row('候选人丙').getByRole('checkbox'))
    await waitFor(() => expect(drawer.queryByText(/超过单个任务上限/)).not.toBeInTheDocument())
    expect(drawer.getByText('已选 2 人')).toBeInTheDocument()
    fireEvent.click(buttonIn(drawer, '下一步'))

    // 第三步：确认
    fireEvent.change(await drawer.findByLabelText('任务名称（可选）'), { target: { value: ' 九月社招第一批 ' } })
    expect(drawer.getByText('候选人甲、候选人乙')).toBeInTheDocument()
    expect(posted(fetchMock, 'POST', '/matching/tasks')).toHaveLength(0)
    fireEvent.click(buttonIn(drawer, '创建并开始分析'))

    expect(await screen.findByTestId('where')).toHaveTextContent('/matching/job-to-people/TASK-NEW')
    expect(posted(fetchMock, 'POST', '/matching/tasks')).toEqual([{
      mode: 'job_to_people', job_ids: ['JOB-1'], person_batch_id: 'TLB-1', person_ids: ['TLE-1', 'TLE-2'], name: '九月社招第一批',
    }])
  })

  it('姓名尚未确认的人员在选择和确认时用简历文件名辨认', async () => {
    const unnamed = [
      { ...person('TLE-1', '待人工确认', '已解析'), source_filename: '张三简历.pdf' },
      { ...person('TLE-2', '待人工确认', '已解析'), source_filename: '李四简历.docx' },
      person('TLE-3', '候选人丙', '已解析'),
    ]
    mockApi(url => {
      if (url.pathname.endsWith('/matching/options')) return options(ALL, 20)
      if (url.pathname.endsWith('/matching/tasks')) return []
      if (url.pathname.endsWith('/library/person-batches/TLB-1')) return { ...batches[0], persons: unnamed }
      return library(url)
    })
    renderPage()
    fireEvent.click((await screen.findAllByRole('button', { name: /新建任务/ }))[0])
    const drawer = within(await screen.findByRole('dialog'))
    fireEvent.click(within((await drawer.findByText('制造工艺工程师')).closest('tr') as HTMLElement).getByRole('radio'))
    fireEvent.click(buttonIn(drawer, '下一步'))
    fireEvent.mouseDown(await drawer.findByLabelText('选择人员批次', { selector: 'input' }))
    fireEvent.click(await screen.findByText('2026 社招第一批 · 社招 · 已解析 3/5 人'))

    const first = within((await drawer.findByText('张三简历.pdf')).closest('tr') as HTMLElement)
    expect(first.getByText('姓名待确认')).toBeInTheDocument()
    expect(drawer.queryByText('待人工确认')).not.toBeInTheDocument()
    fireEvent.click(buttonIn(drawer, '全选已解析'))
    fireEvent.click(buttonIn(drawer, '下一步'))
    expect(await drawer.findByText('张三简历（姓名待确认）、李四简历（姓名待确认）、候选人丙')).toBeInTheDocument()
  })

  it('人才适岗：至少选择两个岗位，创建失败时显示后端给出的原因', async () => {
    let attempts = 0
    const fetchMock = mockApi((url, init) => {
      if (url.pathname.endsWith('/matching/options')) return options(ALL)
      if (url.pathname.endsWith('/matching/tasks') && init?.method === 'POST') {
        attempts += 1
        return attempts === 1
          ? Response.json({ detail: '所选人员有未完成解析的简历，请先在人员库处理' }, { status: 422 })
          : { ...runningTask, id: 'FIT-NEW', mode: 'people_to_jobs', mode_label: '人才适岗', status: '待处理', review: null }
      }
      if (url.pathname.endsWith('/matching/tasks')) return []
      return library(url)
    })
    renderPage('people_to_jobs')
    fireEvent.click((await screen.findAllByRole('button', { name: /新建任务/ }))[0])
    const drawer = within(await screen.findByRole('dialog'))
    const jobRow = (name: string) => within(drawer.getByText(name).closest('tr') as HTMLElement)
    await drawer.findByText('制造工艺工程师')

    fireEvent.click(jobRow('制造工艺工程师').getByRole('checkbox'))
    fireEvent.click(buttonIn(drawer, '下一步'))
    expect(await drawer.findByText(/人才适岗需要至少选择两个岗位/)).toBeInTheDocument()
    fireEvent.click(jobRow('质量管理岗').getByRole('checkbox'))
    fireEvent.click(buttonIn(drawer, '下一步'))

    fireEvent.mouseDown(await drawer.findByLabelText('选择人员批次', { selector: 'input' }))
    fireEvent.click(await screen.findByText('2026 社招第一批 · 社招 · 已解析 3/5 人'))
    fireEvent.click(within((await drawer.findByText('候选人乙')).closest('tr') as HTMLElement).getByRole('checkbox'))
    fireEvent.click(buttonIn(drawer, '下一步'))

    await drawer.findByLabelText('任务名称（可选）')
    fireEvent.click(buttonIn(drawer, '创建并开始分析'))
    expect(await drawer.findByText('所选人员有未完成解析的简历，请先在人员库处理')).toBeInTheDocument()
    expect(screen.queryByTestId('where')).not.toBeInTheDocument()

    fireEvent.click(buttonIn(drawer, '创建并开始分析'))
    expect(await screen.findByTestId('where')).toHaveTextContent('/matching/people-to-jobs/FIT-NEW')
    expect(posted(fetchMock, 'POST', '/matching/tasks')[1]).toEqual({
      mode: 'people_to_jobs', job_ids: ['JOB-1', 'JOB-2'], person_batch_id: 'TLB-1', person_ids: ['TLE-2'], name: '',
    })
  })

  it('岗位库没有岗位时提示先到岗位库维护', async () => {
    mockApi(url => {
      if (url.pathname.endsWith('/matching/options')) return options(ALL)
      if (url.pathname.endsWith('/matching/tasks')) return []
      if (url.pathname.endsWith('/library/jobs')) return []
      return library(url)
    })
    renderPage()
    fireEvent.click((await screen.findAllByRole('button', { name: /新建任务/ }))[0])
    const drawer = within(await screen.findByRole('dialog'))
    expect(await drawer.findByText(/岗位库中还没有可用的岗位/)).toBeInTheDocument()
    expect(drawer.getByRole('link', { name: '前往岗位库' })).toHaveAttribute('href', '/library/jobs')
  })
})

describe('新建匹配任务：直接上传简历', () => {
  const FIRST_BATCH = '2026 社招第一批 · 社招 · 已解析 3/5 人'
  const IMPORT_TITLE = '向“2026 社招第一批”导入简历'
  const categories = { selectable: ['社招', '校招', '内聘'], all: ['校招', '社招', '内聘', '未分类'], import_limit: 60 }
  const newBatch = {
    id: 'TLB-NEW', name: '十月社招补充批', category: '社招', created_by: '招聘人员｜hr', created_at: '2026-09-29T09:00:00+08:00',
    updated_at: '2026-09-29T09:00:00+08:00', total_count: 0, parsed_count: 0, failed_count: 0, pending_count: 0,
  }
  const named = person('TLE-6', '候选人己', '已解析')
  const unnamed = { ...person('TLE-7', '待人工确认', '已解析'), source_filename: '李四简历.docx' }
  const unreadable = { ...person('TLE-8', '待人工确认', '解析失败', '未读取到有效简历内容，请检查文件是否为空白模板'), source_filename: '赵六.docx' }
  const unexplained = { ...person('TLE-9', '待人工确认', '解析失败'), source_filename: '钱七.pdf' }
  const newTask = { ...runningTask, id: 'TASK-NEW', status: '待处理', review: null }

  const resume = (name: string, type = 'application/pdf') => new File(['resume content'], name, { type })
  const operation = (patch: Record<string, unknown>) => ({ id: 'op-1', kind: 'person_import', label: '', status: 'running', progress: '', result: null, error: '', ...patch })
  const requests = (fetchMock: ReturnType<typeof mockApi>, method: string, path: string) => fetchMock.mock.calls
    .filter(([input, init]) => (init?.method || 'GET') === method && new URL(String(input)).pathname.endsWith(path))
    .map(([, init]) => init?.body)

  /** 测试环境里所有弹窗标题的 id 相同，按标题文字找到所在的弹窗。 */
  async function dialogOf(title: string) {
    const heading = await screen.findByText(title, { selector: '.ant-modal-title, .ant-modal-title *' })
    return within(heading.closest('[role="dialog"]') as HTMLElement)
  }
  const closed = (title: string) => waitFor(() => expect(screen.queryByText(title, { selector: '.ant-modal-title, .ant-modal-title *' })).not.toBeInTheDocument())

  async function chooseOption(combobox: HTMLElement, label: string) {
    fireEvent.mouseDown(combobox)
    const option = await waitFor(() => {
      const found = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')]
        .find(item => item.getAttribute('title') === label)
      if (!found) throw new Error(`没有找到选项：${label}`)
      return found
    })
    fireEvent.click(option)
  }

  /** 打开新建任务向导，选好岗位，进入“选择人员”。 */
  async function openPeopleStep(permissions: string[]) {
    renderPage('job_to_people', permissions)
    fireEvent.click((await screen.findAllByRole('button', { name: /新建任务/ }))[0])
    const element = await screen.findByRole('dialog')
    const drawer = within(element)
    fireEvent.click(within((await drawer.findByText('制造工艺工程师')).closest('tr') as HTMLElement).getByRole('radio'))
    fireEvent.click(buttonIn(drawer, '下一步'))
    const row = (text: string) => within(drawer.getByText(text).closest('tr') as HTMLElement)
    return { drawer, element, row }
  }

  async function chooseFirstBatch(drawer: ReturnType<typeof within>) {
    fireEvent.mouseDown(await drawer.findByLabelText('选择人员批次', { selector: 'input' }))
    fireEvent.click(await screen.findByText(FIRST_BATCH))
    await drawer.findByText('候选人甲')
  }

  /** 在导入窗口里选择文件、检查文件并开始导入。 */
  async function importFiles(dialog: ReturnType<typeof within>, files: File[]) {
    fireEvent.change(dialog.getByLabelText('选择简历文件'), { target: { files } })
    fireEvent.click(buttonIn(dialog, '检查文件'))
    await dialog.findByText('文件检查通过，没有需要文字识别的扫描页')
    fireEvent.click(buttonIn(dialog, /开始导入/))
  }

  const originalPolling = { ...polling }
  beforeEach(() => { polling.intervalMs = 5 })
  afterEach(() => { Object.assign(polling, originalPolling) })

  it('已选批次时导入到当前批次；完成后刷新名单，自动勾选解析成功的人员并随任务提交', async () => {
    let imported = false
    const fetchMock = mockApi((url, init) => {
      const path = url.pathname
      if (path.endsWith('/matching/options')) return options(UPLOADER)
      if (path.endsWith('/matching/tasks')) return init?.method === 'POST' ? newTask : []
      if (path.endsWith('/library/person-categories')) return categories
      if (path.endsWith('/library/uploads/preflight')) return { scans: [], errors: [] }
      if (path.endsWith('/library/person-batches/TLB-1/import')) {
        imported = true
        return operation({ status: 'completed', result: { batch_id: 'TLB-1', batch_name: batches[0].name, imported: [named, unnamed], failed: [unreadable] } })
      }
      if (imported && path.endsWith('/library/person-batches')) return [{ ...batches[0], total_count: 8, parsed_count: 6, failed_count: 2, pending_count: 0 }]
      // 刷新后的名单除了本次导入的人员，还反映其他变化：候选人戊的简历此时已解析完成。
      if (imported && path.endsWith('/library/person-batches/TLB-1')) {
        return { ...batches[0], persons: [...persons.map(item => item.id === 'TLE-5' ? { ...item, status: '已解析' } : item), named, unnamed, unreadable] }
      }
      return library(url)
    })
    const { drawer, row } = await openPeopleStep(UPLOADER)
    expect(await drawer.findByText(/选择人员有两种方式：从人员库已有的批次中选择，或者点击“上传简历”直接上传。上传的简历会保存到人员库的批次中，解析完成后自动选中。/)).toBeInTheDocument()
    await chooseFirstBatch(drawer)
    fireEvent.click(row('候选人甲').getByRole('checkbox'))
    expect(drawer.getByText('已选 1 人')).toBeInTheDocument()
    expect(row('候选人戊').getByRole('checkbox')).toBeDisabled()

    fireEvent.click(buttonIn(drawer, '上传简历'))
    const dialog = await dialogOf(IMPORT_TITLE)
    expect(dialog.getByText(/每次最多导入 60 份简历/)).toBeInTheDocument()
    await importFiles(dialog, [resume('候选人己.pdf'), resume('李四简历.docx', ''), resume('赵六.docx', '')])
    expect(await dialog.findByText('导入完成：成功解析 2 人，1 份未能解析')).toBeInTheDocument()
    fireEvent.click(buttonIn(dialog, /^完\s*成$/))
    await closed(IMPORT_TITLE)

    const sent = requests(fetchMock, 'POST', '/library/person-batches/TLB-1/import')
    expect(sent).toHaveLength(1)
    expect(((sent[0] as FormData).getAll('files') as File[]).map(item => item.name)).toEqual(['候选人己.pdf', '李四简历.docx', '赵六.docx'])

    // 结果提示：姓名未确认的人员用简历文件名辨认。
    expect(await drawer.findByText('已导入 2 份简历并选中；1 份解析未成功，可在人员库重新解析')).toBeInTheDocument()
    expect(drawer.getByText('已选中：候选人己、李四简历（姓名待确认）')).toBeInTheDocument()
    expect(drawer.getByText('赵六.docx：未读取到有效简历内容，请检查文件是否为空白模板')).toBeInTheDocument()

    // 名单和批次列表已刷新；本次解析成功的人员与原先勾选的合并。
    await waitFor(() => expect(row('候选人戊').getByRole('checkbox')).toBeEnabled())
    expect(await drawer.findByText('2026 社招第一批 · 社招 · 已解析 6/8 人')).toBeInTheDocument()
    expect(row('候选人甲').getByRole('checkbox')).toBeChecked()
    expect(row('候选人己').getByRole('checkbox')).toBeChecked()
    expect(row('李四简历.docx').getByText('姓名待确认')).toBeInTheDocument()
    expect(row('李四简历.docx').getByRole('checkbox')).toBeChecked()
    expect(row('候选人戊').getByRole('checkbox')).not.toBeChecked()
    expect(row('赵六.docx').getByRole('checkbox')).toBeDisabled()
    expect(row('赵六.docx').getByRole('checkbox')).not.toBeChecked()
    expect(row('赵六.docx').getByText('不可选择：未读取到有效简历内容，请检查文件是否为空白模板；请在人员库重新解析后再选择')).toBeInTheDocument()
    expect(drawer.getByText('已选 3 人')).toBeInTheDocument()

    fireEvent.click(buttonIn(drawer, '下一步'))
    expect(await drawer.findByText('候选人甲、候选人己、李四简历（姓名待确认）')).toBeInTheDocument()
    fireEvent.click(buttonIn(drawer, '创建并开始分析'))
    expect(await screen.findByTestId('where')).toHaveTextContent('/matching/job-to-people/TASK-NEW')
    expect(posted(fetchMock, 'POST', '/matching/tasks')).toEqual([{
      mode: 'job_to_people', job_ids: ['JOB-1'], person_batch_id: 'TLB-1', person_ids: ['TLE-1', 'TLE-6', 'TLE-7'], name: '',
    }])
  })

  it('未选批次时先选择保存到哪个批次；新建批次后上传，超过人数上限时提示而不去掉人员', async () => {
    const added = [{ ...named, batch_id: 'TLB-NEW' }, { ...unnamed, batch_id: 'TLB-NEW' }]
    let stage: 'start' | 'created' | 'imported' = 'start'
    const fetchMock = mockApi((url, init) => {
      const path = url.pathname
      const current = stage === 'imported' ? { ...newBatch, total_count: 2, parsed_count: 2 } : newBatch
      if (path.endsWith('/matching/options')) return options(UPLOADER, 1)
      if (path.endsWith('/matching/tasks')) return init?.method === 'POST' ? newTask : []
      if (path.endsWith('/library/person-categories')) return categories
      if (path.endsWith('/library/uploads/preflight')) return { scans: [], errors: [] }
      if (path.endsWith('/library/person-batches') && init?.method === 'POST') { stage = 'created'; return newBatch }
      if (path.endsWith('/library/person-batches/TLB-NEW/import')) {
        stage = 'imported'
        return operation({ status: 'completed', result: { batch_id: 'TLB-NEW', batch_name: newBatch.name, imported: added, failed: [] } })
      }
      if (path.endsWith('/library/person-batches/TLB-NEW')) return { ...current, persons: stage === 'imported' ? added : [] }
      if (path.endsWith('/library/person-batches') && stage !== 'start') return [current, ...batches]
      return library(url)
    })
    const { drawer, row } = await openPeopleStep(UPLOADER)
    await drawer.findByText(/单个任务最多 1 人/)
    fireEvent.click(buttonIn(drawer, '下一步'))
    expect(await drawer.findByText('请选择人员批次，或点击“上传简历”直接上传')).toBeInTheDocument()

    fireEvent.click(buttonIn(drawer, '上传简历'))
    const chooser = await dialogOf('上传简历')
    expect(chooser.getByLabelText('导入到已有批次')).toBeChecked()
    fireEvent.click(chooser.getByLabelText('新建批次'))
    expect(chooser.getByText(/下一步填写批次名称，并选择人员分类（社招、校招、内聘）/)).toBeInTheDocument()
    fireEvent.click(buttonIn(chooser, '下一步'))

    const form = await dialogOf('新建人员批次')
    fireEvent.change(form.getByLabelText('批次名称'), { target: { value: ' 十月社招补充批 ' } })
    await chooseOption(form.getByRole('combobox', { name: '人员分类' }), '社招')
    fireEvent.click(buttonIn(form, '新建批次'))

    const dialog = await dialogOf('向“十月社招补充批”导入简历')
    expect(posted(fetchMock, 'POST', '/library/person-batches')).toEqual([{ name: '十月社招补充批', category: '社招' }])
    await importFiles(dialog, [resume('候选人己.pdf'), resume('李四简历.docx', '')])
    expect(await dialog.findByText('导入完成：成功解析 2 人')).toBeInTheDocument()
    fireEvent.click(buttonIn(dialog, /^完\s*成$/))
    await closed('向“十月社招补充批”导入简历')
    expect(requests(fetchMock, 'POST', '/library/person-batches/TLB-NEW/import')).toHaveLength(1)

    // 向导已切换到新建的批次，本次导入的人员全部勾选；超过上限时只提示，不自动去掉。
    expect(await drawer.findByText('已导入 2 份简历并选中')).toBeInTheDocument()
    expect(await drawer.findByText('十月社招补充批 · 社招 · 已解析 2/2 人')).toBeInTheDocument()
    expect(drawer.queryByText('请选择人员批次，或点击“上传简历”直接上传')).not.toBeInTheDocument()
    expect(row('候选人己').getByRole('checkbox')).toBeChecked()
    expect(row('李四简历.docx').getByRole('checkbox')).toBeChecked()
    expect(drawer.getByText('已选择 2 人，超过单个任务上限 1 人，请取消 1 人后继续')).toBeInTheDocument()
    fireEvent.click(buttonIn(drawer, '下一步'))
    expect(drawer.queryByLabelText('任务名称（可选）')).not.toBeInTheDocument()

    fireEvent.click(row('李四简历.docx').getByRole('checkbox'))
    await waitFor(() => expect(drawer.queryByText(/超过单个任务上限/)).not.toBeInTheDocument())
    fireEvent.click(buttonIn(drawer, '下一步'))
    await drawer.findByLabelText('任务名称（可选）')
    expect(drawer.getByText('十月社招补充批 · 社招')).toBeInTheDocument()
    fireEvent.click(buttonIn(drawer, '创建并开始分析'))
    expect(await screen.findByTestId('where')).toHaveTextContent('/matching/job-to-people/TASK-NEW')
    expect(posted(fetchMock, 'POST', '/matching/tasks')).toEqual([{
      mode: 'job_to_people', job_ids: ['JOB-1'], person_batch_id: 'TLB-NEW', person_ids: ['TLE-6'], name: '',
    }])
  })

  it('未选批次时也可以导入到已有批次；清空批次选择后可以重新选择保存位置', async () => {
    const fetchMock = mockApi(url => {
      if (url.pathname.endsWith('/matching/options')) return options(UPLOADER)
      if (url.pathname.endsWith('/matching/tasks')) return []
      if (url.pathname.endsWith('/library/person-categories')) return categories
      return library(url)
    })
    const { drawer, element } = await openPeopleStep(UPLOADER)
    await drawer.findByText(/单个任务最多 20 人/)
    fireEvent.click(buttonIn(drawer, '上传简历'))
    const chooser = await dialogOf('上传简历')
    fireEvent.click(buttonIn(chooser, '下一步'))
    expect(await chooser.findByText('请选择要导入到的批次')).toBeInTheDocument()
    await chooseOption(chooser.getByRole('combobox', { name: '导入到的批次' }), FIRST_BATCH)
    fireEvent.click(buttonIn(chooser, '下一步'))

    const dialog = await dialogOf(IMPORT_TITLE)
    await closed('上传简历')
    fireEvent.click(buttonIn(dialog, /^取\s*消$/))
    await closed(IMPORT_TITLE)
    expect(await drawer.findByText('候选人甲')).toBeInTheDocument()
    expect(drawer.getByText(/“上传简历”会导入到当前批次“2026 社招第一批”/)).toBeInTheDocument()
    expect(requests(fetchMock, 'POST', '/library/person-batches/TLB-1/import')).toHaveLength(0)

    fireEvent.mouseDown(element.querySelector('.matching-batch-select .ant-select-clear') as HTMLElement)
    await waitFor(() => expect(drawer.queryByText('候选人甲')).not.toBeInTheDocument())
    fireEvent.click(buttonIn(drawer, '上传简历'))
    expect((await dialogOf('上传简历')).getByLabelText('新建批次')).toBeInTheDocument()
  })

  it('没有人员库维护权限时不显示上传入口', async () => {
    const fetchMock = mockApi(url => {
      if (url.pathname.endsWith('/matching/options')) return options(ALL)
      if (url.pathname.endsWith('/matching/tasks')) return []
      return library(url)
    })
    const { drawer, element } = await openPeopleStep(ALL)
    expect(await drawer.findByText(/人员来自人员库。先选择批次，再勾选参加本次匹配的人员/)).toBeInTheDocument()
    expect(drawer.queryByText(/上传简历/)).not.toBeInTheDocument()
    await chooseFirstBatch(drawer)
    expect(drawer.queryByText(/上传简历/)).not.toBeInTheDocument()
    expect(element.querySelector('.ant-select-clear')).toBeNull()
    expect(requests(fetchMock, 'GET', '/library/person-categories')).toHaveLength(0)
  })

  it('人员库还没有批次、又没有维护权限时，只提示前往人员库', async () => {
    mockApi(url => {
      if (url.pathname.endsWith('/matching/options')) return options(ALL)
      if (url.pathname.endsWith('/matching/tasks')) return []
      if (url.pathname.endsWith('/library/person-batches')) return []
      return library(url)
    })
    const { drawer } = await openPeopleStep(ALL)
    expect(await drawer.findByText('人员库中还没有人员批次。请先在人员库新建批次并导入简历，解析完成后再来选择。')).toBeInTheDocument()
    expect(drawer.getByRole('link', { name: '前往人员库' })).toHaveAttribute('href', '/library/persons')
    expect(drawer.queryByText(/上传简历/)).not.toBeInTheDocument()
  })

  it('人员库还没有批次时可以直接上传：先新建批次；人员分类读取失败时说明原因并可重试', async () => {
    let categoryReads = 0
    let created = false
    const fetchMock = mockApi((url, init) => {
      const path = url.pathname
      if (path.endsWith('/matching/options')) return options(UPLOADER)
      if (path.endsWith('/matching/tasks')) return []
      if (path.endsWith('/library/person-categories')) {
        categoryReads += 1
        return categoryReads < 3 ? Response.json({ detail: '人员分类暂时无法读取' }, { status: 503 }) : categories
      }
      if (path.endsWith('/library/person-batches') && init?.method === 'POST') { created = true; return newBatch }
      if (path.endsWith('/library/person-batches/TLB-NEW')) return { ...newBatch, persons: [] }
      if (path.endsWith('/library/person-batches')) return created ? [newBatch] : []
      return library(url)
    })
    const { drawer } = await openPeopleStep(UPLOADER)
    expect(await drawer.findByText(/人员库中还没有人员批次。可以点击“上传简历”直接上传：先新建一个批次/)).toBeInTheDocument()
    expect(drawer.getByRole('link', { name: '前往人员库' })).toHaveAttribute('href', '/library/persons')
    await waitFor(() => expect(categoryReads).toBe(1))

    fireEvent.click(buttonIn(drawer, '上传简历'))
    expect(await drawer.findByText('暂时不能新建批次')).toBeInTheDocument()
    expect(drawer.getByText(/人员分类未能读取：人员分类暂时无法读取/)).toBeInTheDocument()
    expect(drawer.getByText(/可以再试一次；也可以先到人员库新建批次，再回到这里选择。/)).toBeInTheDocument()
    expect(screen.queryByText('新建人员批次')).not.toBeInTheDocument()

    fireEvent.click(buttonIn(drawer, /^重\s*试$/))
    const form = await dialogOf('新建人员批次')
    expect(drawer.queryByText('暂时不能新建批次')).not.toBeInTheDocument()
    fireEvent.change(form.getByLabelText('批次名称'), { target: { value: '十月社招补充批' } })
    await chooseOption(form.getByRole('combobox', { name: '人员分类' }), '社招')
    fireEvent.click(buttonIn(form, '新建批次'))

    const dialog = await dialogOf('向“十月社招补充批”导入简历')
    expect(posted(fetchMock, 'POST', '/library/person-batches')).toEqual([{ name: '十月社招补充批', category: '社招' }])
    fireEvent.click(buttonIn(dialog, /^取\s*消$/))
    await closed('向“十月社招补充批”导入简历')
    // 批次已建立但还没有上传：向导停在新批次上，名单为空，可以继续上传。
    expect(await drawer.findByText('十月社招补充批 · 社招 · 已解析 0/0 人')).toBeInTheDocument()
    expect(await drawer.findByText('该批次还没有人员，请点击“上传简历”导入')).toBeInTheDocument()
    expect(buttonIn(drawer, '上传简历')).toBeInTheDocument()
  })

  it('关闭导入窗口后向导显示进行中状态；导入未完成时说明原因和下一步，已勾选的人员不变', async () => {
    let finish!: () => void
    const finished = new Promise<void>(resolve => { finish = resolve })
    mockApi(async url => {
      const path = url.pathname
      if (path.endsWith('/matching/options')) return options(UPLOADER)
      if (path.endsWith('/matching/tasks')) return []
      if (path.endsWith('/library/person-categories')) return categories
      if (path.endsWith('/library/uploads/preflight')) return { scans: [], errors: [] }
      if (path.endsWith('/library/person-batches/TLB-1/import')) return operation({ progress: '正在解析第 1/2 份：候选人己.pdf' })
      if (path.endsWith('/library/operations/op-1')) {
        await finished
        return operation({ status: 'failed', error: '文字识别服务暂时不可用，本次导入已停止' })
      }
      return library(url)
    })
    const { drawer, row } = await openPeopleStep(UPLOADER)
    await chooseFirstBatch(drawer)
    fireEvent.click(row('候选人甲').getByRole('checkbox'))
    fireEvent.click(buttonIn(drawer, '上传简历'))
    const dialog = await dialogOf(IMPORT_TITLE)
    await importFiles(dialog, [resume('候选人己.pdf'), resume('李四简历.docx', '')])
    expect(await dialog.findByText('正在解析第 1/2 份：候选人己.pdf')).toBeInTheDocument()
    fireEvent.click(buttonIn(dialog, '关闭窗口，在后台继续导入'))
    await closed(IMPORT_TITLE)

    expect(drawer.getByText(/正在向“2026 社招第一批”导入并解析简历，完成后自动选中解析成功的人员。/)).toBeInTheDocument()
    expect(buttonIn(drawer, '正在导入简历')).toHaveClass('ant-btn-loading')
    fireEvent.click(buttonIn(drawer, '下一步'))
    expect(await drawer.findByText(/完成后会自动选中解析成功的人员，请等待完成后再继续/)).toBeInTheDocument()
    expect(drawer.queryByLabelText('任务名称（可选）')).not.toBeInTheDocument()

    finish()
    expect(await drawer.findByText('简历导入未完成')).toBeInTheDocument()
    expect(drawer.getByText('原因：文字识别服务暂时不可用，本次导入已停止')).toBeInTheDocument()
    expect(drawer.getByText(/请按原因处理后，重新点击“上传简历”。/)).toBeInTheDocument()
    expect(drawer.queryByText(/完成后自动选中解析成功的人员。/)).not.toBeInTheDocument()
    expect(drawer.queryByText(/请等待完成后再继续/)).not.toBeInTheDocument()
    expect(buttonIn(drawer, '上传简历')).not.toHaveClass('ant-btn-loading')
    expect(row('候选人甲').getByRole('checkbox')).toBeChecked()
    expect(drawer.getByText('已选 1 人')).toBeInTheDocument()
  })

  it('导入完成后名单刷新未成功时，按导入结果显示和勾选，已勾选的人员保留', async () => {
    let imported = false
    const fetchMock = mockApi((url, init) => {
      const path = url.pathname
      if (path.endsWith('/matching/options')) return options(UPLOADER)
      if (path.endsWith('/matching/tasks')) return init?.method === 'POST' ? newTask : []
      if (path.endsWith('/library/person-categories')) return categories
      if (path.endsWith('/library/uploads/preflight')) return { scans: [], errors: [] }
      if (path.endsWith('/library/person-batches/TLB-1/import')) {
        imported = true
        return operation({ status: 'completed', result: { batch_id: 'TLB-1', batch_name: batches[0].name, imported: [named], failed: [unreadable] } })
      }
      if (imported && /\/library\/person-batches(\/TLB-1)?$/.test(path)) return Response.json({ detail: '人员库暂时无法读取' }, { status: 503 })
      return library(url)
    })
    const { drawer, row } = await openPeopleStep(UPLOADER)
    await chooseFirstBatch(drawer)
    fireEvent.click(row('候选人乙').getByRole('checkbox'))
    fireEvent.click(buttonIn(drawer, '上传简历'))
    const dialog = await dialogOf(IMPORT_TITLE)
    await importFiles(dialog, [resume('候选人己.pdf'), resume('赵六.docx', '')])
    expect(await dialog.findByText('导入完成：成功解析 1 人，1 份未能解析')).toBeInTheDocument()
    fireEvent.click(buttonIn(dialog, /^完\s*成$/))
    await closed(IMPORT_TITLE)

    expect(await drawer.findByText('已导入 1 份简历并选中；1 份解析未成功，可在人员库重新解析')).toBeInTheDocument()
    await waitFor(() => expect(requests(fetchMock, 'GET', '/library/person-batches/TLB-1').length).toBeGreaterThan(1))
    expect(drawer.queryByText('人员名单未能读取')).not.toBeInTheDocument()
    expect(row('候选人乙').getByRole('checkbox')).toBeChecked()
    expect(row('候选人己').getByRole('checkbox')).toBeChecked()
    expect(row('赵六.docx').getByRole('checkbox')).toBeDisabled()
    expect(drawer.getByText('已选 2 人')).toBeInTheDocument()

    fireEvent.click(buttonIn(drawer, '下一步'))
    expect(await drawer.findByText('候选人乙、候选人己')).toBeInTheDocument()
    fireEvent.click(buttonIn(drawer, '创建并开始分析'))
    expect(await screen.findByTestId('where')).toHaveTextContent('/matching/job-to-people/TASK-NEW')
    expect(posted(fetchMock, 'POST', '/matching/tasks')[0].person_ids).toEqual(['TLE-2', 'TLE-6'])
  })

  it('导入在后台进行期间换了批次：完成后说明结果，不把其他批次的人员勾选进来', async () => {
    const second = { ...batches[0], id: 'TLB-2', name: '2026 校招第一批', category: '校招', total_count: 1, parsed_count: 1, failed_count: 0, pending_count: 0 }
    let finish!: () => void
    const finished = new Promise<void>(resolve => { finish = resolve })
    const fetchMock = mockApi(async url => {
      const path = url.pathname
      if (path.endsWith('/matching/options')) return options(UPLOADER)
      if (path.endsWith('/matching/tasks')) return []
      if (path.endsWith('/library/person-categories')) return categories
      if (path.endsWith('/library/uploads/preflight')) return { scans: [], errors: [] }
      if (path.endsWith('/library/person-batches')) return [batches[0], second]
      if (path.endsWith('/library/person-batches/TLB-2')) return { ...second, persons: [{ ...person('TLE-20', '候选人庚', '已解析'), batch_id: 'TLB-2' }] }
      if (path.endsWith('/library/person-batches/TLB-1/import')) return operation({})
      if (path.endsWith('/library/operations/op-1')) {
        await finished
        return operation({ status: 'completed', result: { batch_id: 'TLB-1', batch_name: batches[0].name, imported: [named, unnamed], failed: [unreadable] } })
      }
      return library(url)
    })
    const { drawer, row } = await openPeopleStep(UPLOADER)
    await chooseFirstBatch(drawer)
    fireEvent.click(buttonIn(drawer, '上传简历'))
    const dialog = await dialogOf(IMPORT_TITLE)
    await importFiles(dialog, [resume('候选人己.pdf'), resume('李四简历.docx', ''), resume('赵六.docx', '')])
    await dialog.findByText('关闭窗口，在后台继续导入')
    fireEvent.click(buttonIn(dialog, '关闭窗口，在后台继续导入'))
    await closed(IMPORT_TITLE)

    fireEvent.mouseDown(drawer.getByLabelText('选择人员批次', { selector: 'input' }))
    fireEvent.click(await screen.findByText('2026 校招第一批 · 校招 · 已解析 1/1 人'))
    await drawer.findByText('候选人庚')
    fireEvent.click(row('候选人庚').getByRole('checkbox'))
    const readsBefore = requests(fetchMock, 'GET', '/library/person-batches/TLB-1').length

    finish()
    expect(await drawer.findByText('“2026 社招第一批”已导入 2 份简历；1 份解析未成功，可在人员库重新解析')).toBeInTheDocument()
    expect(drawer.getByText('解析成功：候选人己、李四简历（姓名待确认）')).toBeInTheDocument()
    expect(drawer.getByText(/当前选择的不是这个批次，这些人员没有自动选中。需要使用时，请把人员批次切换为“2026 社招第一批”后勾选。/)).toBeInTheDocument()
    expect(drawer.queryByText('候选人己')).not.toBeInTheDocument()
    expect(row('候选人庚').getByRole('checkbox')).toBeChecked()
    expect(drawer.getByText('已选 1 人')).toBeInTheDocument()
    expect(requests(fetchMock, 'GET', '/library/person-batches/TLB-1')).toHaveLength(readsBefore)
  })

  it('上传的简历全部解析未成功时逐份说明原因，名单中显示为不可选择', async () => {
    let imported = false
    mockApi(url => {
      const path = url.pathname
      if (path.endsWith('/matching/options')) return options(UPLOADER)
      if (path.endsWith('/matching/tasks')) return []
      if (path.endsWith('/library/person-categories')) return categories
      if (path.endsWith('/library/uploads/preflight')) return { scans: [], errors: [] }
      if (path.endsWith('/library/person-batches/TLB-1/import')) {
        imported = true
        return operation({ status: 'completed', result: { batch_id: 'TLB-1', batch_name: batches[0].name, imported: [], failed: [unreadable, unexplained] } })
      }
      if (imported && path.endsWith('/library/person-batches/TLB-1')) return { ...batches[0], persons: [...persons, unreadable, unexplained] }
      return library(url)
    })
    const { drawer, row } = await openPeopleStep(UPLOADER)
    await chooseFirstBatch(drawer)
    fireEvent.click(buttonIn(drawer, '上传简历'))
    const dialog = await dialogOf(IMPORT_TITLE)
    await importFiles(dialog, [resume('赵六.docx', ''), resume('钱七.pdf')])
    expect(await dialog.findByText('导入完成：成功解析 0 人，2 份未能解析')).toBeInTheDocument()
    fireEvent.click(buttonIn(dialog, /^完\s*成$/))
    await closed(IMPORT_TITLE)

    expect(await drawer.findByText('本次上传的 2 份简历解析均未成功，没有新增可以选择的人员；可在人员库重新解析')).toBeInTheDocument()
    expect(drawer.getByText('赵六.docx：未读取到有效简历内容，请检查文件是否为空白模板')).toBeInTheDocument()
    expect(drawer.getByText('钱七.pdf：未能读取文件内容')).toBeInTheDocument()
    expect(row('赵六.docx').getByRole('checkbox')).toBeDisabled()
    expect(row('钱七.pdf').getByRole('checkbox')).toBeDisabled()
    expect(row('钱七.pdf').getByText('不可选择：简历解析未成功；请在人员库重新解析后再选择')).toBeInTheDocument()
    expect(drawer.getByText('已选 0 人')).toBeInTheDocument()
    fireEvent.click(buttonIn(drawer, '下一步'))
    expect(await drawer.findByText('请至少选择一名已解析的人员')).toBeInTheDocument()
  })
})
