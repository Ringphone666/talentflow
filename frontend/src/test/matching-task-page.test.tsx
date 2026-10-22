import '@ant-design/v5-patch-for-react-19'
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { message } from 'antd'
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MatchingTaskPage, { MatchingTaskRedirect } from '../pages/matching/MatchingTaskPage'
import { failureSubject, operatorName, readableReason } from '../pages/matching/shared'
import type { Assessment, CandidateDetail, PersonRow, TaskDetail } from '../pages/matching/types'
import type { Session } from '../types'

const ALL = ['matching:view', 'matching:create', 'matching:review', 'matching:export', 'matching:delete', 'job:read', 'person:read']
const REVIEWER = ['matching:view', 'matching:review']

const LONG_REASON = '候选人在某制造业公司担任制造工艺工程师六年，主导装配、加工和检验三个工段的工艺参数优化，建立了加工温度与设备转速的参数控制表，'
  + '良品率提升明显；材料中给出了项目起止时间、本人职责和验收结论，能够支持该维度的较高评价。'
  + '仍需在面试中核实其在工艺优化项目中的个人贡献比例，以及验收结论是否由第三方出具；同时建议核对其所述控制表是否仍在原单位使用。'

const options = (permissions: string[]) => ({
  max_people: 20,
  decisions: [{ value: '进入下一轮', label: '通过 · 进入下一轮' }, { value: '保留', label: '保留 · 待进一步核验' }, { value: '淘汰', label: '未通过' }],
  fit_decisions: [{ value: '推荐至该岗位', label: '通过 · 推荐至该岗位' }, { value: '作为备选岗位', label: '保留 · 作为备选岗位' }, { value: '暂不推荐', label: '未通过 · 暂不推荐' }],
  can_create: permissions.includes('matching:create'), can_review: permissions.includes('matching:review'),
  can_export: permissions.includes('matching:export'), can_delete: permissions.includes('matching:delete'),
})

const row = (values: Partial<PersonRow> & Pick<PersonRow, 'candidate_id' | 'name'>): PersonRow => ({
  code: `CODE-${values.candidate_id}`, source_filename: `${values.name}.pdf`, total: null, conclusion: '待补充材料', analysis_status: '分析完成',
  review_status: '待审核', decision: '未确认', material_confirmed: false, reviewed_jobs: '—', review_comment: '', reviewer: '', reviewed_at: '',
  report_ready: false, report_blockers: ['候选人字段尚未完成人工确认', '尚未保存人工最终决策'], note: '', person_id: '', rank: null,
  strengths: [], risks: [], hard_failed: [], hard_unknown: [], ...values,
})

const task: TaskDetail = {
  id: 'TASK-1', name: '九月社招第一批', mode: 'job_to_people', mode_label: '岗位选才', status: '部分失败', running: false,
  jobs: [{ id: 'JOB-1', name: '制造工艺工程师' }], person_batch_id: 'TLB-1', total: 3, processed: 3, succeeded: 2, failed: 1,
  failures: [{ file: 'TLE-3', reason: 'ModelError: AI分析未完成：AI评分服务未配置或未确认', stage: 'analysis' }],
  created_at: '2026-09-28T09:00:00+08:00', updated_at: '2026-09-28T09:10:00+08:00',
  review: { passed: 1, rejected: 0, kept: 0, pending: 2, stale: 0, exportable: 1, people: 3 },
  job_standards: [{
    id: 'JOB-1', name: '制造工艺工程师', level: 'P5', sequence: '生产技术', weight_version: 'W-NEW-1.0',
    dimensions: [{ name: '工艺技术', weight: 60 }, { name: '质量意识', weight: 40 }],
    hard_conditions: ['本科及以上学历', '持有食品安全管理员证书'],
  }],
  people: [
    row({
      candidate_id: 'C-1', name: '候选人甲', person_id: 'TLE-1', rank: 1, total: 86.5, conclusion: '硬性条件待核实',
      strengths: [`工艺技术：${LONG_REASON}`], risks: ['硬性条件待核实 · 持有食品安全管理员证书：材料中未见证书信息'],
      hard_unknown: ['持有食品安全管理员证书'],
    }),
    row({
      candidate_id: 'C-2', name: '候选人乙', person_id: 'TLE-2', rank: 2, total: 72, conclusion: '较为匹配', review_status: '通过',
      decision: '进入下一轮', material_confirmed: true, review_comment: '经历符合岗位要求', reviewer: '招聘人员｜hr',
      reviewed_at: '2026-09-28T10:00:00+08:00', report_ready: true, report_blockers: [], strengths: ['质量意识：有完整的质量追溯经历'],
    }),
    row({
      candidate_id: 'C-3', name: '候选人丙', person_id: 'TLE-3', conclusion: '评分未完成', analysis_status: '待重试',
      note: 'AI分析未完成：AI评分服务未配置或未确认', risks: ['AI评分未完成：AI评分服务未配置或未确认'],
      hard_unknown: ['本科及以上学历', '持有食品安全管理员证书'],
      report_blockers: ['候选人字段尚未完成人工确认', '尚未保存人工最终决策', '评分尚未完成，请完成分析并人工复核后导出'],
    }),
  ],
}

const assessment = (values: Partial<Assessment>): Assessment => ({
  job_id: 'JOB-1', job_name: '制造工艺工程师', decision: null, review_comment: '', total: 86.5, coverage_percent: 100,
  conclusion: '硬性条件待核实', summary: '对照“制造工艺工程师”，当前材料支持的综合匹配度为86.5/100；已评估 2/2 项 · 覆盖岗位权重 100%。综合结论：硬性条件待核实。',
  score_note: '综合匹配度按完整岗位的100%权重加权计算，表示当前材料已支持的匹配程度，不是录用概率。',
  evidence_summary: '已评估 2/2 项 · 覆盖岗位权重 100%', next_step: '能力评分已完成，先补充任职资格证明，再由工作人员决定下一步。',
  recommended: false, analysis_status: '分析完成', stale: false, stale_reason: '',
  strengths: [`工艺技术：${LONG_REASON}`], gaps: [], risks: ['硬性条件待核实 · 持有食品安全管理员证书：材料中未见证书信息'],
  verification: ['补充任职资格证明 · 持有食品安全管理员证书：材料中未见证书信息'], questions: ['请提供可以核实“持有食品安全管理员证书”的材料或说明。'],
  dimensions: [
    { dimension: '工艺技术', weight: 60, score: 90, weighted: 54, status: '已评估', reason: LONG_REASON,
      evidence: [{ text: '主导装配、加工、检验三个工段的工艺参数优化，良品率提升 3.2%', file: '候选人甲.pdf', location: '第1页', origin: '' }] },
    { dimension: '质量意识', weight: 40, score: 81.25, weighted: 32.5, status: '已评估', reason: '参与建立批次质量追溯台账，能说明异常批次的处置过程。',
      evidence: [{ text: '建立批次质量追溯台账', file: '候选人甲.pdf', location: '第2页', origin: '' }] },
  ],
  hard_checks: [
    { condition: '本科及以上学历', status: '满足', evidence: '教育经历显示 2016 年本科毕业', sources: [{ text: '2012-2016 某大学 加工工程 本科', file: '候选人甲.pdf', location: '第1页', origin: '' }] },
    { condition: '持有食品安全管理员证书', status: '无法确认', evidence: '材料中未见证书信息', sources: [] },
  ],
  weight_version: 'W-NEW-1.0', assessed_at: '2026-09-28T09:05:00+08:00',
  model: { status: '调用成功', reason: '评分与证据已通过本地校验，总分由系统按岗位权重计算。', name: 'scoring-model' },
  ...values,
})

const FIELD_LABELS: Array<[string, string]> = [
  ['education', '教育经历'], ['work_experience', '工作经历'], ['projects', '项目经历'], ['skills', '专业技能'],
  ['tenure', '任职时间'], ['interview_evaluation', '面试评价与纪要'], ['additional_material', '补充资料'],
]
const FIELD_VALUES: Record<string, string> = {
  education: '2012-2016 某大学 加工工程 本科', work_experience: '2018.03-2024.06 某制造业有限公司 制造工艺工程师',
  projects: '装配工艺参数优化项目', skills: '加工过程控制、理化分析', tenure: '6 年',
}

const detail = (values: Partial<CandidateDetail> = {}): CandidateDetail => ({
  task: { id: 'TASK-1', name: '九月社招第一批', mode: 'job_to_people', running: false },
  candidate_id: 'C-1', code: 'CAND-001', name: '候选人甲', person_id: 'TLE-1', rank: 1, review_status: '待审核', reviewer: '', reviewed_at: '',
  material: {
    full_name: '候选人甲', source_filename: '候选人甲.pdf', parse_status: '部分字段待人工确认', confirmed: false, material_version: 3,
    updated_at: '', updated_by: '', warning: '',
    fields: FIELD_LABELS.map(([key, label]) => ({ key, label, value: FIELD_VALUES[key] || '', status: FIELD_VALUES[key] ? '已识别' : '待人工确认', location: FIELD_VALUES[key] ? '第1页' : '' })),
  },
  redaction: { status: '已脱敏', types: ['手机号'] },
  assessments: [assessment({})],
  missing_jobs: [],
  report: { ready: false, blockers: ['候选人字段尚未完成人工确认', '尚未保存人工最终决策'] },
  reports: [],
  evidence: [{ text: '2018.03-2024.06 某制造业有限公司 制造工艺工程师，负责装配与加工工段', file: '候选人甲.pdf', location: '第1页' }],
  ...values,
})

const fitTask: TaskDetail = {
  ...task, id: 'FIT-1', name: '内聘适岗第一批', mode: 'people_to_jobs', mode_label: '人才适岗', status: '已完成', failed: 0, failures: [], total: 2, processed: 2,
  jobs: [{ id: 'JOB-1', name: '制造工艺工程师' }, { id: 'JOB-2', name: '质量管理岗' }],
  job_standards: [task.job_standards[0], { id: 'JOB-2', name: '质量管理岗', level: 'P4', sequence: '质量管理', weight_version: 'W-NEW-1.0', dimensions: [{ name: '质量体系', weight: 100 }], hard_conditions: [] }],
  review: { passed: 0, rejected: 0, kept: 1, pending: 1, stale: 0, exportable: 1, people: 2 },
  people: [
    row({
      candidate_id: 'F-1', name: '候选人庚', rank: 1, total: 82, conclusion: '高度匹配', review_status: '保留', material_confirmed: true,
      decision: '制造工艺工程师：待审核；质量管理岗：作为备选岗位', reviewed_jobs: '1/2', report_ready: true, report_blockers: [], preferred_job_id: 'JOB-1',
      matrix: {
        'JOB-1': { total: 82, decision: null, analysis_status: '分析完成', conclusion: '高度匹配' },
        'JOB-2': { total: 61, decision: '作为备选岗位', analysis_status: '分析完成', conclusion: '部分匹配' },
      },
    }),
    row({
      candidate_id: 'F-2', name: '候选人辛', conclusion: '评分未完成', analysis_status: '部分岗位待分析', reviewed_jobs: '0/2', preferred_job_id: null,
      report_blockers: ['暂无岗位匹配结果', '部分岗位尚未完成分析'],
      matrix: { 'JOB-1': { total: null, decision: null, analysis_status: '待重试', conclusion: '评分未完成' } },
    }),
  ],
}
const fitDetail = (): CandidateDetail => detail({
  task: { id: 'FIT-1', name: '内聘适岗第一批', mode: 'people_to_jobs', running: false },
  candidate_id: 'F-1', code: 'CAND-101', name: '候选人庚', review_status: '保留', reviewer: 'hr', reviewed_at: '2026-09-28T10:00:00+08:00',
  material: { ...detail().material, full_name: '候选人庚', confirmed: true, parse_status: '人工已复核', material_version: 4 },
  assessments: [
    assessment({ total: 82, conclusion: '高度匹配', recommended: true, hard_checks: [], summary: '对照“制造工艺工程师”，综合匹配度为82.0/100。' }),
    assessment({
      job_id: 'JOB-2', job_name: '质量管理岗', total: 61, conclusion: '部分匹配', decision: '作为备选岗位', review_comment: '质量体系经验偏少，可作为备选',
      summary: '对照“质量管理岗”，综合匹配度为61.0/100。', hard_checks: [],
      dimensions: [{ dimension: '质量体系', weight: 100, score: 61, weighted: 61, status: '已评估', reason: '有质量追溯经历，但缺少体系审核经验。', evidence: [] }],
    }),
  ],
  report: { ready: true, blockers: [] },
})

type Handler = (url: URL, init?: RequestInit) => unknown

/** 按接口地址返回数据；未列出的接口返回 404，避免测试悄悄依赖不存在的接口。 */
function mockApi(handler: Handler) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    const result = handler(url, init)
    if (result instanceof Response) return result
    if (result === undefined) return Response.json({ detail: '所需记录不存在' }, { status: 404 })
    return Response.json(result)
  })
}

/** 岗位选才任务 TASK-1 的只读接口。 */
const readOnly = (permissions: string[], overrides: { task?: () => TaskDetail; detail?: () => CandidateDetail } = {}): Handler => (url, init) => {
  if (init?.method && init.method !== 'GET') return undefined
  if (url.pathname.endsWith('/matching/options')) return options(permissions)
  if (url.pathname.endsWith('/matching/tasks/TASK-1')) return (overrides.task || (() => task))()
  if (url.pathname.endsWith('/matching/tasks/TASK-1/candidates/C-1')) return (overrides.detail || detail)()
  return undefined
}

function Where() {
  const location = useLocation()
  return <div data-testid="where">{location.pathname}{location.search}</div>
}

function renderAt(path: string, permissions: string[] = ALL) {
  const session: Session = { access_token: 'test-token', expires_at: 4102444800, username: 'hr', display_name: 'HR管理员', role: 'hr_admin', role_label: 'HR管理员', permissions }
  const Layout = () => <Outlet context={{ session }} />
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/matching/job-to-people" element={<Where />} />
          <Route path="/matching/job-to-people/:taskId" element={<><MatchingTaskPage mode="job_to_people" pollIntervalMs={20} /><Where /></>} />
          <Route path="/matching/people-to-jobs/:taskId" element={<><MatchingTaskPage mode="people_to_jobs" pollIntervalMs={20} /><Where /></>} />
          <Route path="/matching/tasks/:taskId" element={<MatchingTaskRedirect />} />
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
const hasButton = (scope: Pick<typeof screen, 'queryByText'>, name: string | RegExp) =>
  Boolean(scope.queryByText(name, { selector: 'button, button *' }))
const requests = (fetchMock: ReturnType<typeof mockApi>, method: string, path: string) => fetchMock.mock.calls
  .filter(([input, init]) => (init?.method || 'GET') === method && new URL(String(input)).pathname.endsWith(path))
  .map(([input, init]) => ({ url: new URL(String(input)), body: init?.body ? JSON.parse(String(init.body)) : undefined }))

/** 等上一个导出结束（按钮可用且不在处理中）后再点击。 */
async function clickWhenReady(scope: Pick<typeof screen, 'getByText'>, name: string) {
  await waitFor(() => {
    const button = buttonIn(scope, name)
    expect(button).toBeEnabled()
    expect(button).not.toHaveClass('ant-btn-loading')
  })
  fireEvent.click(buttonIn(scope, name))
}

/** 按标题查找弹窗。测试环境里各弹窗的标题编号相同，不能按无障碍名称区分。 */
const modalOf = async (title: string) =>
  within((await screen.findByText(title, { selector: '.ant-modal-title' })).closest('[role="dialog"]') as HTMLElement)

async function openPerson(name: string) {
  fireEvent.click(buttonIn(within(rowOf(name)), '查看详情'))
  return within(await screen.findByRole('dialog'))
}

// 按角色查找时不逐个计算元素是否可见，否则大表格下查询很慢；表单校验等异步结果在负载高时较慢，放宽等待时间。
configure({ defaultHidden: true, asyncUtilTimeout: 5000 })
// 测试环境里多行输入框的自适应高度计算较慢，放宽单个测试的时限。
vi.setConfig({ testTimeout: 40000 })

const computedStyle = window.getComputedStyle.bind(window)
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL
beforeEach(() => {
  // jsdom 不支持读取伪元素样式，表格测量滚动条时只取元素本身的样式。
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element))
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:matching-test') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(async () => {
  await act(async () => { message.destroy() })
  vi.restoreAllMocks()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
})

describe('岗位选才任务页', () => {
  it('排序表显示结论、硬性条件和完整的优势风险；未完成项按人员说明原因', async () => {
    mockApi(readOnly(ALL))
    renderAt('/matching/job-to-people/TASK-1')

    expect(await screen.findByRole('heading', { name: '九月社招第一批' })).toBeInTheDocument()
    const first = within(rowOf('候选人甲'))
    expect(first.getByText('86.5')).toHaveClass('match-score')
    expect(first.getByText('硬性条件待核实')).toBeInTheDocument()
    expect(first.getByText('待核实 1')).toBeInTheDocument()
    expect(first.getByText('待审核')).toBeInTheDocument()
    expect(first.getByText('暂不可导出')).toBeInTheDocument()

    const second = within(rowOf('候选人乙'))
    expect(second.getByText('通过 · 进入下一轮')).toBeInTheDocument()
    expect(second.getByText('可导出')).toBeInTheDocument()
    expect(second.getByText('无不满足或待核实项')).toBeInTheDocument()

    // 没有得分时如实显示状态，不显示 0 分。
    const third = within(rowOf('候选人丙'))
    expect(third.getByText('未形成得分')).toBeInTheDocument()
    expect(third.getByText('待重试')).toBeInTheDocument()
    expect(third.queryByText('0')).not.toBeInTheDocument()

    // 优势、风险在每人下方整行显示，内容完整。
    const strength = screen.getByText(`工艺技术：${LONG_REASON}`)
    expect(strength).toHaveClass('evidence-text')
    expect(strength.closest('tr')).toHaveClass('ant-table-expanded-row')
    expect(screen.getByText('评分尚未完成，请完成分析并人工复核后导出')).toBeInTheDocument()

    // 未完成项：人员库编号换成姓名和文件名，去掉程序异常名称。
    expect(screen.getByText('有 1 项未完成')).toBeInTheDocument()
    const failure = screen.getByText('候选人丙（候选人丙.pdf）').closest('li') as HTMLElement
    expect(failure).toHaveTextContent('候选人丙（候选人丙.pdf）（匹配分析）：AI分析未完成：AI评分服务未配置或未确认')
    expect(failure).not.toHaveTextContent('ModelError')
    expect(document.querySelector('.ant-table-cell-ellipsis, .ant-typography-ellipsis')).toBeNull()
  })

  it('按审核状态筛选，并可按综合匹配度排序', async () => {
    mockApi(readOnly(ALL))
    renderAt('/matching/job-to-people/TASK-1')
    await screen.findByText('候选人甲')
    const names = () => [...document.querySelectorAll('.matching-people .matching-name-link')].map(item => item.textContent)
    expect(names()).toEqual(['候选人甲', '候选人乙', '候选人丙'])

    // 图表区也有“综合匹配度”标题，这里点的是排序表的表头。
    const table = within(document.querySelector('.matching-people') as HTMLElement)
    fireEvent.click(table.getByText('综合匹配度'))
    fireEvent.click(table.getByText('综合匹配度'))
    await waitFor(() => expect(names()).toEqual(['候选人丙', '候选人乙', '候选人甲']))

    fireEvent.click(screen.getByText('通过 1'))
    await waitFor(() => expect(names()).toEqual(['候选人乙']))
    fireEvent.click(screen.getByText('全部 3'))
    await waitFor(() => expect(names()).toHaveLength(3))
  })

  it('姓名尚未确认的人员显示“姓名待确认”和简历文件名，便于区分', async () => {
    const unnamed: TaskDetail = {
      ...task, status: '已完成', failed: 0, failures: [], total: 2, processed: 2, succeeded: 2,
      people: [
        row({ candidate_id: 'C-1', name: '待人工确认', source_filename: '张三简历.pdf', person_id: 'TLE-1', rank: 1, total: 86.5 }),
        row({ candidate_id: 'C-2', name: '待人工确认', source_filename: '李四简历.pdf', person_id: 'TLE-2', rank: 2, total: 72 }),
      ],
    }
    const unnamedDetail = () => detail({ name: '待人工确认', material: { ...detail().material, full_name: '待人工确认', source_filename: '张三简历.pdf' } })
    mockApi(readOnly(ALL, { task: () => unnamed, detail: unnamedDetail }))
    renderAt('/matching/job-to-people/TASK-1')

    await screen.findByText('张三简历.pdf')
    const first = within(rowOf('张三简历.pdf'))
    expect(first.getByText('姓名待确认').closest('button')).toHaveClass('matching-name-link')
    expect(first.queryByText('CODE-C-1')).not.toBeInTheDocument()
    expect(within(rowOf('李四简历.pdf')).getByText('姓名待确认')).toBeInTheDocument()
    expect(screen.queryByText('待人工确认')).not.toBeInTheDocument()

    await openPerson('张三简历.pdf')
    expect(await screen.findByText('姓名待确认（张三简历.pdf） · 匹配详情')).toBeInTheDocument()
  })

  it('任务分析期间导出区只说明“完成后才能导出”，不显示人数', async () => {
    const running: TaskDetail = {
      ...task, status: '处理中', running: true, failed: 0, failures: [], processed: 0, succeeded: 0,
      people: [row({ candidate_id: null, name: '尚未解析', source_filename: '张三简历.pdf', analysis_status: '排队 / 处理中' })],
    }
    mockApi(readOnly(ALL, { task: () => running }))
    renderAt('/matching/job-to-people/TASK-1')

    const panel = within((await screen.findByText('匹配报告与导出')).closest('.ant-card') as HTMLElement)
    expect(panel.getByText('任务正在分析，完成后才能导出')).toBeInTheDocument()
    expect(panel.queryByText(/导出范围/)).not.toBeInTheDocument()
    expect(buttonIn(panel, '导出报告包')).toBeDisabled()
  })

  it('图表对比：两人以上有得分时显示，默认比较排名靠前的人员', async () => {
    const scored = (): TaskDetail => ({
      ...task,
      people: task.people.map((item, index) => ({
        ...item, dimensions: [
          { dimension: '工艺技术', score: item.total === null ? null : 80 - index * 10 },
          { dimension: '质量意识', score: item.total === null ? null : 70 },
          { dimension: '沟通协调', score: null },
        ],
      })),
    })
    mockApi(readOnly(ALL, { task: scored }))
    renderAt('/matching/job-to-people/TASK-1')
    await screen.findByText('候选人甲')
    const card = screen.getByText('图表对比').closest('.ant-card') as HTMLElement
    expect(within(card).getByText('综合匹配度')).toBeInTheDocument()
    expect(within(card).getByText('各维度得分')).toBeInTheDocument()
    // 没有得分的候选人丙不参与比较。
    expect(within(card).getByText(/比较排名前 2 人/)).toBeInTheDocument()
  })

  it('只有一人有得分时不显示图表对比', async () => {
    mockApi(readOnly(ALL, { task: () => ({ ...task, people: task.people.slice(1) }) }))
    renderAt('/matching/job-to-people/TASK-1')
    await screen.findByText('候选人乙')
    expect(screen.queryByText('图表对比')).not.toBeInTheDocument()
  })

  it('硬性条件筛选由使用者决定是否启用，只改变显示范围', async () => {
    const withFailed = (): TaskDetail => ({
      ...task,
      people: task.people.map(item => item.candidate_id === 'C-2' ? { ...item, hard_failed: ['本科及以上学历'] } : item),
    })
    mockApi(readOnly(ALL, { task: withFailed }))
    renderAt('/matching/job-to-people/TASK-1')
    await screen.findByText('候选人甲')
    const names = () => [...document.querySelectorAll('.matching-people .matching-name-link')].map(item => item.textContent)
    expect(names()).toEqual(['候选人甲', '候选人乙', '候选人丙'])
    fireEvent.click(screen.getByLabelText(/只看没有不满足硬性条件的人员（另有 1 人不满足）/))
    await waitFor(() => expect(names()).toEqual(['候选人甲', '候选人丙']))
    // 排名和得分不因筛选而改变。
    expect(rowOf('候选人甲')).toHaveTextContent('86.5')
    fireEvent.click(screen.getByLabelText(/只看没有不满足硬性条件的人员/))
    await waitFor(() => expect(names()).toHaveLength(3))
  })

  it('没有人不满足硬性条件时不显示筛选开关', async () => {
    mockApi(readOnly(ALL))
    renderAt('/matching/job-to-people/TASK-1')
    await screen.findByText('候选人甲')
    expect(screen.queryByLabelText(/只看没有不满足硬性条件的人员/)).not.toBeInTheDocument()
  })

  it('详情抽屉完整显示判断依据、原文证据和硬性条件核验，不截断', async () => {
    mockApi(readOnly(ALL))
    renderAt('/matching/job-to-people/TASK-1')
    await screen.findByText('候选人甲')
    const drawer = await openPerson('候选人甲')
    expect(screen.getByTestId('where')).toHaveTextContent('/matching/job-to-people/TASK-1?person=C-1')

    const reason = await drawer.findByText(LONG_REASON)
    expect(reason).toHaveClass('evidence-text')
    expect(reason.closest('tr')).toHaveClass('ant-table-expanded-row')
    expect(reason.textContent).toHaveLength(LONG_REASON.length)
    expect(drawer.getByText('主导装配、加工、检验三个工段的工艺参数优化，良品率提升 3.2%')).toHaveClass('evidence-quote')
    expect(drawer.getAllByText('出处：候选人甲.pdf · 第1页').length).toBeGreaterThan(0)

    const dimension = within(drawer.getByText('工艺技术').closest('tr') as HTMLElement)
    expect(dimension.getByText('60%')).toBeInTheDocument()
    expect(dimension.getByText('90')).toBeInTheDocument()
    expect(dimension.getByText('54')).toBeInTheDocument()
    expect(dimension.getByText('已评估')).toBeInTheDocument()

    const hard = within(drawer.getByText('持有食品安全管理员证书', { selector: '.ant-table-cell *' }).closest('tr') as HTMLElement)
    expect(hard.getByText('无法确认')).toBeInTheDocument()
    expect(hard.getByText('材料中未见证书信息')).toHaveClass('evidence-text')
    expect(drawer.getByText('教育经历显示 2016 年本科毕业')).toBeInTheDocument()

    expect(drawer.getByText(/综合结论：硬性条件待核实。/)).toHaveClass('evidence-text')
    expect(drawer.getByText('请提供可以核实“持有食品安全管理员证书”的材料或说明。')).toBeInTheDocument()
    expect(drawer.getByText('2012-2016 某大学 加工工程 本科', { selector: '.matching-material-fields *' })).toHaveClass('evidence-text')
    expect(drawer.getByText('手机号')).toBeInTheDocument()
    expect(drawer.getByText('原文依据（1 条）')).toBeInTheDocument()
    expect(drawer.getByText('暂时不能导出正式报告')).toBeInTheDocument()
    expect(drawer.getByText('尚未保存人工最终决策')).toBeInTheDocument()

    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('.ant-table-cell-ellipsis, .ant-typography-ellipsis, [style*="text-overflow"]')).toBeNull()
  })

  it('人工复核一次提交：未勾选、未填意见或未选结论时不提交', async () => {
    let saved = false
    const reviewed = () => detail({
      review_status: '通过', reviewer: 'hr', reviewed_at: '2026-09-28T11:00:00+08:00',
      material: { ...detail().material, confirmed: true, parse_status: '人工已复核', material_version: 4 },
      assessments: [assessment({ decision: '进入下一轮', review_comment: '资料已核对，经历符合岗位要求' })],
      report: { ready: true, blockers: [] },
    })
    const base = readOnly(ALL, { detail: () => saved ? reviewed() : detail() })
    const fetchMock = mockApi((url, init) => {
      if (init?.method === 'POST' && url.pathname.endsWith('/matching/candidates/C-1/review')) { saved = true; return { ok: true } }
      return base(url, init)
    })
    renderAt('/matching/job-to-people/TASK-1?person=C-1')
    const drawer = within(await screen.findByRole('dialog'))
    await drawer.findByText(LONG_REASON)

    fireEvent.click(buttonIn(drawer, '提交人工复核'))
    expect(await drawer.findByText('请先确认已核对本人资料和评分依据')).toBeInTheDocument()
    expect(drawer.getByText('请填写复核意见，至少 2 个字')).toBeInTheDocument()
    expect(drawer.getByText('请选择复核结论')).toBeInTheDocument()

    fireEvent.click(drawer.getByLabelText('通过 · 进入下一轮'))
    fireEvent.change(drawer.getByLabelText('复核意见'), { target: { value: ' 可 ' } })
    fireEvent.click(buttonIn(drawer, '提交人工复核'))
    await waitFor(() => expect(drawer.queryByText('请选择复核结论')).not.toBeInTheDocument())
    expect(drawer.getByText('请填写复核意见，至少 2 个字')).toBeInTheDocument()
    expect(drawer.getByText('请先确认已核对本人资料和评分依据')).toBeInTheDocument()
    expect(requests(fetchMock, 'POST', '/review')).toHaveLength(0)

    fireEvent.change(drawer.getByLabelText('复核意见'), { target: { value: ' 资料已核对，经历符合岗位要求 ' } })
    fireEvent.click(drawer.getByLabelText('已核对本人资料和评分依据'))
    fireEvent.click(buttonIn(drawer, '提交人工复核'))

    await waitFor(() => expect(requests(fetchMock, 'POST', '/matching/candidates/C-1/review')).toHaveLength(1))
    expect(requests(fetchMock, 'POST', '/matching/candidates/C-1/review')[0].body).toEqual({
      decision: '进入下一轮', comment: '资料已核对，经历符合岗位要求', material_checked: true, expected_material_version: 3,
    })
    // 不需要另外保存资料确认。
    expect(requests(fetchMock, 'PUT', '/material')).toHaveLength(0)
    expect(await drawer.findByText('已完成人工复核，可以导出正式报告')).toBeInTheDocument()
    expect(drawer.getByText('复核意见：资料已核对，经历符合岗位要求')).toBeInTheDocument()
    expect(hasButton(drawer, '导出单人正式报告')).toBe(true)
  })

  it('提交失败时显示后端给出的原因', async () => {
    const base = readOnly(ALL)
    mockApi((url, init) => {
      if (init?.method === 'POST' && url.pathname.endsWith('/review')) return Response.json({ detail: '资料已被其他操作修改，请刷新后重新编辑' }, { status: 422 })
      return base(url, init)
    })
    renderAt('/matching/job-to-people/TASK-1?person=C-1')
    const drawer = within(await screen.findByRole('dialog'))
    await drawer.findByText(LONG_REASON)
    fireEvent.click(drawer.getByLabelText('已核对本人资料和评分依据'))
    fireEvent.change(drawer.getByLabelText('复核意见'), { target: { value: '建议保留观察' } })
    fireEvent.click(drawer.getByLabelText('保留 · 待进一步核验'))
    fireEvent.click(buttonIn(drawer, '提交人工复核'))
    expect(await drawer.findByText('资料已被其他操作修改，请刷新后重新编辑')).toBeInTheDocument()
    expect(drawer.getByText('复核未保存')).toBeInTheDocument()
  })

  it('评分失效时不能复核，重新分析后自动刷新直到完成', async () => {
    let phase: 'stale' | 'running' | 'done' = 'stale'
    let taskCalls = 0
    const stale = assessment({ stale: true, stale_reason: '人员资料已修改，请重新分析并审核', conclusion: '资料已变更，待重新分析', analysis_status: '资料已更新，待重分析' })
    const fetchMock = mockApi((url, init) => {
      if (init?.method === 'POST' && url.pathname.endsWith('/matching/tasks/TASK-1/reanalyze')) { phase = 'running'; taskCalls = 0; return { ok: true } }
      if (url.pathname.endsWith('/matching/options')) return options(REVIEWER)
      if (url.pathname.endsWith('/matching/tasks/TASK-1')) {
        taskCalls += 1
        if (phase === 'running' && taskCalls >= 3) phase = 'done'
        const current = phase
        return {
          ...task, failures: [], failed: 0, status: current === 'running' ? '处理中' : '已完成', running: current === 'running',
          processed: current === 'running' ? 1 : 3,
          review: { ...task.review, stale: current === 'stale' ? 1 : 0 },
          people: task.people.map(item => item.candidate_id === 'C-1' && current === 'stale'
            ? { ...item, review_status: '需重新审核', analysis_status: '资料已更新，待重分析' } : item),
        }
      }
      if (url.pathname.endsWith('/candidates/C-1')) return phase === 'done' ? detail() : detail({ review_status: '需重新审核', assessments: [stale] })
      return undefined
    })
    renderAt('/matching/job-to-people/TASK-1?person=C-1', REVIEWER)
    const drawer = within(await screen.findByRole('dialog'))

    expect(await drawer.findByText('暂时不能提交复核')).toBeInTheDocument()
    expect(drawer.getByText('人员资料已修改，请重新分析并审核，评分已失效。请先重新分析，再提交人工复核。')).toBeInTheDocument()
    expect(buttonIn(drawer, '提交人工复核')).toBeDisabled()
    expect(drawer.getByLabelText('复核意见')).toBeDisabled()
    expect(screen.getByText('有 1 人的评分已失效')).toBeInTheDocument()
    // 复核人员没有新建、导出、删除权限。
    expect(hasButton(screen, /导出/)).toBe(false)
    expect(hasButton(screen, /删除/)).toBe(false)

    fireEvent.click(drawer.getAllByText('重新分析', { selector: 'button *' })[0])
    await waitFor(() => expect(requests(fetchMock, 'POST', '/matching/tasks/TASK-1/reanalyze')).toHaveLength(1))
    expect(await screen.findByText('正在后台分析，进度和结果会自动更新')).toBeInTheDocument()
    expect(await drawer.findByText('任务正在分析，分析完成后才能提交人工复核。')).toBeInTheDocument()

    // 分析结束：停止刷新，抽屉内容随之更新，可以复核。
    await waitFor(() => expect(screen.queryByText('正在后台分析，进度和结果会自动更新')).not.toBeInTheDocument(), { timeout: 3000 })
    await waitFor(() => expect(drawer.queryByText('暂时不能提交复核')).not.toBeInTheDocument(), { timeout: 3000 })
    expect(buttonIn(drawer, '提交人工复核')).toBeEnabled()
    const settled = requests(fetchMock, 'GET', '/matching/tasks/TASK-1').length
    await pause(150)
    expect(requests(fetchMock, 'GET', '/matching/tasks/TASK-1')).toHaveLength(settled)
  })

  it('修改资料只提交改动的内容，保存后提示重新分析', async () => {
    let changed = false
    const stale = assessment({ stale: true, stale_reason: '人员资料已修改，请重新分析并审核' })
    const base = readOnly(ALL, {
      detail: () => changed
        ? detail({ review_status: '需重新审核', assessments: [stale], material: { ...detail().material, material_version: 4, parse_status: '待人工确认' } })
        : detail(),
    })
    const fetchMock = mockApi((url, init) => {
      if (init?.method === 'PUT' && url.pathname.endsWith('/matching/candidates/C-1/material')) {
        changed = true
        return { material: { ...detail().material, material_version: 4 }, requires_reanalysis: true, warning: '' }
      }
      return base(url, init)
    })
    renderAt('/matching/job-to-people/TASK-1?person=C-1')
    const drawer = within(await screen.findByRole('dialog'))
    await drawer.findByText(LONG_REASON)

    fireEvent.click(buttonIn(drawer, '修改资料'))
    expect(await drawer.findByText('修改资料会使原评分和人工结论失效')).toBeInTheDocument()
    fireEvent.change(drawer.getByLabelText('教育经历'), { target: { value: '2012-2016 某大学 加工工程 本科（已核对学位证）' } })
    fireEvent.click(buttonIn(drawer, '保存修改'))

    await waitFor(() => expect(requests(fetchMock, 'PUT', '/matching/candidates/C-1/material')).toHaveLength(1))
    expect(requests(fetchMock, 'PUT', '/matching/candidates/C-1/material')[0].body).toEqual({
      fields: { education: '2012-2016 某大学 加工工程 本科（已核对学位证）' }, confirmed: false, expected_material_version: 3,
    })
    expect(await drawer.findByText('暂时不能提交复核')).toBeInTheDocument()
    expect(drawer.getByText('评分已失效，需要重新分析')).toBeInTheDocument()
    expect(drawer.getAllByText('重新分析', { selector: 'button *' }).length).toBeGreaterThan(0)
  })

  it('没有导出权限时不显示导出入口', async () => {
    const ready = () => detail({ report: { ready: true, blockers: [] }, assessments: [assessment({ decision: '进入下一轮', review_comment: '符合要求' })] })
    mockApi(readOnly(REVIEWER, { detail: ready }))
    renderAt('/matching/job-to-people/TASK-1?person=C-1', REVIEWER)
    const drawer = within(await screen.findByRole('dialog'))
    expect(await drawer.findByText('已完成人工复核，可以导出正式报告')).toBeInTheDocument()
    expect(screen.queryByText('匹配报告与导出')).not.toBeInTheDocument()
    expect(hasButton(screen, /导出/)).toBe(false)
    expect(hasButton(screen, '重试未完成项')).toBe(false)
    expect(hasButton(screen, /删除/)).toBe(false)
  })

  it('导出按勾选的人员请求对应接口；佐证数据包默认不含原始简历', async () => {
    const base = readOnly(ALL)
    const fetchMock = mockApi((url, init) => {
      if (url.pathname.endsWith('/matching/tasks/TASK-1/results')) return { task: { id: 'TASK-1' }, jobs: [], people: [] }
      if (/\/(report|review-sheet|evidence-package)$/.test(url.pathname)) {
        return new Response('file', { headers: { 'X-Download-Name': encodeURIComponent('导出文件.zip') } })
      }
      return base(url, init)
    })
    renderAt('/matching/job-to-people/TASK-1')
    await screen.findByText('候选人甲')
    const panel = within(screen.getByText('匹配报告与导出').closest('.ant-card') as HTMLElement)
    expect(panel.getByText(/导出范围：本任务全部 3 人/)).toBeInTheDocument()
    expect(panel.getByText('其中 1 人已完成人工复核，可导出正式报告')).toBeInTheDocument()
    expect(buttonIn(panel, '导出单人正式报告')).toBeDisabled()

    // 未勾选：导出整个任务，不逐个传人员编号。
    fireEvent.click(buttonIn(panel, '导出审核明细表（CSV）'))
    await waitFor(() => expect(requests(fetchMock, 'GET', '/review-sheet')).toHaveLength(1))
    expect(requests(fetchMock, 'GET', '/review-sheet')[0].url.search).toBe('')

    fireEvent.click(within(rowOf('候选人乙')).getByRole('checkbox'))
    expect(await panel.findByText('导出范围：已勾选的 1 人')).toBeInTheDocument()
    await waitFor(() => expect(buttonIn(panel, '导出单人正式报告')).toBeEnabled())
    expect(buttonIn(panel, '导出多人对比报告')).toBeDisabled()
    await clickWhenReady(panel, '导出单人正式报告')
    await waitFor(() => expect(requests(fetchMock, 'GET', '/report')).toHaveLength(1))
    expect(requests(fetchMock, 'GET', '/report')[0].url.search).toBe('?kind=single&candidate_ids=C-2')

    fireEvent.click(within(rowOf('候选人甲')).getByRole('checkbox'))
    await clickWhenReady(panel, '导出多人对比报告')
    await waitFor(() => expect(requests(fetchMock, 'GET', '/report')).toHaveLength(2))
    expect(requests(fetchMock, 'GET', '/report')[1].url.search).toBe('?kind=comparison&candidate_ids=C-1,C-2')

    // 报告包：有人未完成复核时先说明，确认后才导出。
    await clickWhenReady(panel, '导出报告包')
    const notice = await modalOf('部分人员暂不能导出正式报告')
    expect(notice.getByText(/其中 1 人可导出正式报告，1 人暂不能导出/)).toBeInTheDocument()
    expect(notice.getByText('候选人甲').closest('li')).toHaveTextContent('候选人甲：候选人字段尚未完成人工确认；尚未保存人工最终决策')
    expect(requests(fetchMock, 'GET', '/report')).toHaveLength(2)
    fireEvent.click(buttonIn(notice, '导出 1 人的报告包'))
    await waitFor(() => expect(requests(fetchMock, 'GET', '/report')).toHaveLength(3))
    expect(requests(fetchMock, 'GET', '/report')[2].url.search).toBe('?kind=package&candidate_ids=C-1,C-2')

    // 佐证数据包：默认不含原始简历；勾选后须确认知悉才能导出。
    await clickWhenReady(panel, '导出佐证数据包（ZIP）')
    let evidence = await modalOf('导出佐证数据包')
    const originals = evidence.getByLabelText('包含原始简历（含未脱敏个人信息）')
    expect(originals).not.toBeChecked()
    fireEvent.click(buttonIn(evidence, '导出佐证数据包'))
    await waitFor(() => expect(requests(fetchMock, 'GET', '/evidence-package')).toHaveLength(1))
    expect(requests(fetchMock, 'GET', '/evidence-package')[0].url.search).toBe('?candidate_ids=C-1,C-2&include_originals=false')

    await clickWhenReady(panel, '导出佐证数据包（ZIP）')
    evidence = await modalOf('导出佐证数据包')
    await waitFor(() => expect(evidence.getByLabelText('包含原始简历（含未脱敏个人信息）')).not.toBeChecked())
    fireEvent.click(evidence.getByLabelText('包含原始简历（含未脱敏个人信息）'))
    expect(await evidence.findByText('原始简历含未脱敏的个人信息')).toBeInTheDocument()
    expect(buttonIn(evidence, '确认导出（含原始简历）')).toBeDisabled()
    fireEvent.click(evidence.getByLabelText('我已知悉，确有需要导出原始简历'))
    fireEvent.click(buttonIn(evidence, '确认导出（含原始简历）'))
    await waitFor(() => expect(requests(fetchMock, 'GET', '/evidence-package')).toHaveLength(2))
    expect(requests(fetchMock, 'GET', '/evidence-package')[1].url.search).toBe('?candidate_ids=C-1,C-2&include_originals=true')

    // 结构化结果：把接口返回的内容保存为文件。
    await clickWhenReady(panel, '导出结构化结果（JSON）')
    await waitFor(() => expect(requests(fetchMock, 'GET', '/matching/tasks/TASK-1/results')).toHaveLength(1))
    await waitFor(() => expect(vi.mocked(URL.createObjectURL).mock.calls.some(([blob]) => (blob as Blob).type.startsWith('application/json'))).toBe(true))
  })

  it('重试未完成项、从任务中删除人员', async () => {
    let removed = false
    const base = readOnly(ALL, { task: () => removed ? { ...task, people: task.people.filter(item => item.candidate_id !== 'C-3'), failures: [], failed: 0 } : task })
    const fetchMock = mockApi((url, init) => {
      if (init?.method === 'POST' && url.pathname.endsWith('/matching/tasks/TASK-1/retry')) return { ok: true }
      if (init?.method === 'DELETE' && url.pathname.endsWith('/matching/candidates/C-3')) { removed = true; return { ok: true } }
      return base(url, init)
    })
    renderAt('/matching/job-to-people/TASK-1')
    await screen.findByText('候选人丙')

    fireEvent.click(buttonIn(screen, '重试未完成项'))
    await waitFor(() => expect(requests(fetchMock, 'POST', '/matching/tasks/TASK-1/retry')).toHaveLength(1))

    fireEvent.click(buttonIn(within(rowOf('候选人丙')), /删除/))
    expect(await screen.findByText('确认从本任务中删除 候选人丙？')).toBeInTheDocument()
    expect(screen.getByText(/人员库中的资料不受影响/)).toBeInTheDocument()
    expect(requests(fetchMock, 'DELETE', '/matching/candidates/C-3')).toHaveLength(0)
    fireEvent.click(buttonIn(within(screen.getByRole('tooltip')), /^删\s*除$/))
    await waitFor(() => expect(screen.queryByText('候选人丙')).not.toBeInTheDocument())
    expect(requests(fetchMock, 'DELETE', '/matching/candidates/C-3')).toHaveLength(1)
    expect(screen.queryByText('有 1 项未完成')).not.toBeInTheDocument()
  })

  it('任务不存在时说明原因并可返回列表', async () => {
    mockApi(url => {
      if (url.pathname.endsWith('/matching/options')) return options(ALL)
      if (url.pathname.endsWith('/matching/tasks/TASK-404')) return Response.json({ detail: '匹配任务不存在' }, { status: 404 })
      return undefined
    })
    renderAt('/matching/job-to-people/TASK-404')
    expect(await screen.findByText('匹配任务不存在或已删除')).toBeInTheDocument()
    fireEvent.click(buttonIn(screen, '返回任务列表'))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/matching\/job-to-people$/))
  })
})

describe('人才适岗任务页', () => {
  const fitApi = (permissions: string[]): Handler => (url, init) => {
    if (init?.method && init.method !== 'GET') return undefined
    if (url.pathname.endsWith('/matching/options')) return options(permissions)
    if (url.pathname.endsWith('/matching/tasks/FIT-1')) return fitTask
    if (url.pathname.endsWith('/matching/tasks/FIT-1/candidates/F-1')) return fitDetail()
    return undefined
  }

  it('矩阵每个岗位一列，单元格显示得分、结论和人工结论，推荐岗位高亮', async () => {
    mockApi(fitApi(ALL))
    renderAt('/matching/people-to-jobs/FIT-1')
    expect(await screen.findByRole('heading', { name: '内聘适岗第一批' })).toBeInTheDocument()
    expect(screen.getByText('人员与岗位匹配矩阵（2 人 × 2 个岗位）')).toBeInTheDocument()
    const headers = [...document.querySelectorAll('.matching-people thead th')].map(item => item.textContent)
    expect(headers).toEqual(expect.arrayContaining(['姓名', '制造工艺工程师', '质量管理岗', '推荐岗位', '审核状态', '已复核岗位']))

    const person = within(rowOf('候选人庚'))
    const preferred = person.getByText('82').closest('.matrix-cell') as HTMLElement
    expect(preferred).toHaveClass('preferred')
    expect(within(preferred).getByText('推荐岗位')).toBeInTheDocument()
    expect(within(preferred).getByText('高度匹配')).toBeInTheDocument()
    expect(within(preferred).getByText('未复核')).toBeInTheDocument()
    const backup = person.getByText('61').closest('.matrix-cell') as HTMLElement
    expect(backup).not.toHaveClass('preferred')
    expect(within(backup).getByText('部分匹配')).toBeInTheDocument()
    expect(within(backup).getByText('保留 · 作为备选岗位')).toBeInTheDocument()
    expect(person.getByText('1/2')).toBeInTheDocument()
    expect(person.getByText('保留')).toBeInTheDocument()

    const other = within(rowOf('候选人辛'))
    expect(other.getByText('尚未分析')).toBeInTheDocument()
    expect(other.getByText('未形成得分')).toBeInTheDocument()
    expect(other.getByText('暂无，需先核验材料缺口或硬性条件')).toBeInTheDocument()
    expect(screen.getByText('部分岗位尚未完成分析')).toHaveClass('evidence-text')
  })

  it('抽屉按岗位分页显示分析；复核时带上所选岗位', async () => {
    const base = fitApi(ALL)
    const fetchMock = mockApi((url, init) => {
      if (init?.method === 'POST' && url.pathname.endsWith('/matching/candidates/F-1/review')) return { ok: true }
      return base(url, init)
    })
    renderAt('/matching/people-to-jobs/FIT-1')
    await screen.findByText('候选人庚')
    const drawer = await openPerson('候选人庚')

    const tabs = await drawer.findAllByRole('tab')
    expect(tabs.map(item => item.textContent)).toEqual(['制造工艺工程师82推荐岗位', '质量管理岗61'])
    expect(drawer.getByText('对照“制造工艺工程师”，综合匹配度为82.0/100。')).toBeInTheDocument()
    expect(drawer.getByText('“制造工艺工程师”尚未复核。')).toBeInTheDocument()

    // 切换到另一个岗位：显示该岗位已保存的结论和意见。
    fireEvent.click(tabs[1])
    expect(await drawer.findByText('复核意见：质量体系经验偏少，可作为备选')).toBeInTheDocument()
    expect(drawer.getByText('有质量追溯经历，但缺少体系审核经验。')).toHaveClass('evidence-text')
    expect(drawer.getByLabelText('保留 · 作为备选岗位')).toBeChecked()

    fireEvent.click(tabs[0])
    await drawer.findByText('“制造工艺工程师”尚未复核。')
    fireEvent.click(drawer.getByLabelText('已核对本人资料和评分依据'))
    fireEvent.change(drawer.getByLabelText('复核意见'), { target: { value: '工艺经验与岗位要求一致' } })
    fireEvent.click(drawer.getByLabelText('通过 · 推荐至该岗位'))
    fireEvent.click(buttonIn(drawer, '提交人工复核'))
    await waitFor(() => expect(requests(fetchMock, 'POST', '/matching/candidates/F-1/review')).toHaveLength(1))
    expect(requests(fetchMock, 'POST', '/matching/candidates/F-1/review')[0].body).toEqual({
      decision: '推荐至该岗位', comment: '工艺经验与岗位要求一致', material_checked: true, expected_material_version: 4, job_id: 'JOB-1',
    })
  })
})

describe('权限与显示文字', () => {
  it('会话有权限但接口说明不可用时，同样不显示对应入口', async () => {
    const base = readOnly(ALL)
    mockApi((url, init) => url.pathname.endsWith('/matching/options')
      ? { ...options(ALL), can_export: false, can_delete: false, can_create: false }
      : base(url, init))
    renderAt('/matching/job-to-people/TASK-1')
    await screen.findByText('候选人甲')
    await waitFor(() => expect(screen.queryByText('匹配报告与导出')).not.toBeInTheDocument())
    expect(hasButton(screen, /导出/)).toBe(false)
    expect(hasButton(screen, /删除/)).toBe(false)
    expect(hasButton(screen, '重试未完成项')).toBe(false)
    expect(hasButton(screen, '重新分析')).toBe(true)
    // 勾选只用于选择导出范围，没有导出权限时不显示。
    expect(within(rowOf('候选人甲')).queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('未完成原因去掉程序异常名称和服务器路径，操作人只显示登录名', () => {
    expect(readableReason('FileNotFoundError: 脱敏材料不存在：C:\\data\\matching\\talent\\a.txt')).toBe('脱敏材料不存在：[路径已隐藏]')
    expect(readableReason("KeyError: '候选人不存在'")).toBe('候选人不存在')
    expect(readableReason('质量管理岗：ModelError: AI评分服务未配置或未确认；JOB-2：ValueError: 读取 /srv/app/data/x.json 失败'))
      .toBe('质量管理岗：AI评分服务未配置或未确认；JOB-2：读取 [路径已隐藏] 失败')
    expect(readableReason('')).toBe('未记录原因')
    expect(operatorName('招聘人员｜hr_zhang')).toBe('hr_zhang')
    expect(operatorName('招聘人员')).toBe('招聘人员')
    expect(failureSubject({ file: 'TLE-404', reason: '', stage: 'parse' }, task.people)).toBe('人员库记录 TLE-404')
    expect(failureSubject({ file: '候选人乙.pdf', reason: '', stage: 'analysis' }, task.people)).toBe('候选人乙（候选人乙.pdf）')
  })
})

describe('任务地址跳转', () => {
  it('通用地址按任务类型跳转，并保留查询参数打开人员详情', async () => {
    mockApi((url, init) => {
      if (init?.method && init.method !== 'GET') return undefined
      if (url.pathname.endsWith('/matching/options')) return options(ALL)
      if (url.pathname.endsWith('/matching/tasks/FIT-1')) return fitTask
      if (url.pathname.endsWith('/matching/tasks/FIT-1/candidates/F-1')) return fitDetail()
      return undefined
    })
    renderAt('/matching/tasks/FIT-1?person=F-1')
    expect(await screen.findByTestId('where')).toHaveTextContent('/matching/people-to-jobs/FIT-1?person=F-1')
    const drawer = within(await screen.findByRole('dialog'))
    expect(await drawer.findByText('候选人庚 · 匹配详情')).toBeInTheDocument()
  })

  it('任务类型与地址不一致时转到正确的页面', async () => {
    mockApi((url, init) => {
      if (init?.method && init.method !== 'GET') return undefined
      if (url.pathname.endsWith('/matching/options')) return options(ALL)
      if (url.pathname.endsWith('/matching/tasks/FIT-1')) return fitTask
      return undefined
    })
    renderAt('/matching/job-to-people/FIT-1')
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/matching/people-to-jobs/FIT-1'))
    expect(await screen.findByText('人员与岗位匹配矩阵（2 人 × 2 个岗位）')).toBeInTheDocument()
  })

  it('任务打不开时显示原因和两个任务列表入口', async () => {
    mockApi(() => Response.json({ detail: '匹配任务不存在' }, { status: 404 }))
    renderAt('/matching/tasks/TASK-404')
    expect(await screen.findByText('匹配任务未能打开')).toBeInTheDocument()
    expect(screen.getByText('匹配任务不存在')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '查看岗位选才任务' })).toHaveAttribute('href', '/matching/job-to-people')
    expect(screen.getByRole('link', { name: '查看人才适岗任务' })).toHaveAttribute('href', '/matching/people-to-jobs')
  })
})
