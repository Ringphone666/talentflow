import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ComparisonPage from '../pages/interview/ComparisonPage'
import { batch, chooseOption, hardIndicators, httpError, permissions, quietComputedStyle, renderPage, stubApi, stubDownloads, type Call } from './interview-helpers'

const RISK = '候选人对复检后的改进措施说明不足，质量异常处置是否形成制度化做法需要在人工面试中进一步核实，语音转写和评分依据也须人工核对。'

const item = (id: number, name: string, overrides: Record<string, unknown> = {}) => ({
  report_id: id * 10,
  candidate: { id, code: `B-2026-01-00${id}`, name, library_person_id: `p-${id}` },
  batch_id: 1, status: 'pending_review', match_score: 60 + id,
  scores: { 岗位专业能力: 3, 逻辑思维: 4, 沟通表达: 3, 抗压能力: 3, 职业稳定性: 4, 企业价值观契合度: 3 },
  risks: [RISK], hard_indicators: hardIndicators(), stage_two: null, ...overrides,
})

let data: { items: Array<ReturnType<typeof item>>; default_selected: number[]; default_limit: number; notice: string; without_report: Array<Record<string, unknown>> }

function backend(extra?: (call: Call) => unknown) {
  return stubApi(call => {
    const custom = extra?.(call)
    if (custom !== undefined) return custom
    if (call.method !== 'GET') return undefined
    if (call.path === '/batches') return [batch(), batch({ id: 2, code: 'B-2026-02', name: '第二批次' })]
    if (call.path === '/comparison?batch_id=1') return structuredClone({ job_id: null, batch_id: 1, ...data })
    if (call.path === '/comparison?batch_id=2') return { job_id: null, batch_id: 2, items: [], default_selected: [], default_limit: 0, notice: data.notice, without_report: [] }
    return undefined
  })
}

const location = () => screen.getByTestId('location').textContent
const tableOf = (title: string) => within(screen.getByText(title).closest('.ant-card') as HTMLElement)
const rowOf = (title: string, name: string) => within(tableOf(title).getByText(name).closest('tr') as HTMLElement)
const SCORES = '六维评分与匹配度'
const DETAILS = '硬指标、人工面试证据与风险提示'

beforeEach(() => {
  quietComputedStyle()
  data = {
    items: [
      item(1, '张三', { status: 'confirmed', match_score: 82 }),
      item(2, '李四', { match_score: 74 }),
      item(3, '王五', { match_score: 68 }),
    ],
    default_selected: [1, 2, 3], default_limit: 0,
    notice: '对比结果仅供人工初筛参考，不构成自动录用或淘汰决定。',
    without_report: [],
  }
})
afterEach(() => vi.restoreAllMocks())

describe('候选人对比', () => {
  it('必须先选批次；进入批次后默认选中该批次全部候选人，批次记在地址栏', async () => {
    const api = backend()
    renderPage(<ComparisonPage />, { granted: permissions.interviewer })
    expect(await screen.findByText('请先选择招聘批次')).toBeInTheDocument()
    expect(api.calls.some(call => call.path.startsWith('/comparison') || call.path === '/jobs')).toBe(false)

    fireEvent.mouseDown(screen.getByRole('combobox', { name: '选择对比批次' }))
    await chooseOption('第一批次 · 制造工艺岗')
    expect(await screen.findByText('参与对比的候选人（已选 3 / 3 人）')).toBeInTheDocument()
    expect(screen.getByText(/进入批次时默认选中该批次的全部候选人，可以自行增减。/)).toBeInTheDocument()
    expect(location()).toBe('/?batch=1')
    expect(api.requests('GET', '/comparison?batch_id=1')).toHaveLength(1)
    for (const name of ['张三', '李四', '王五']) {
      expect(rowOf(SCORES, name).getAllByText('4 / 5')).toHaveLength(2)
      expect(rowOf(DETAILS, name).getByText(RISK)).toHaveClass('evidence-text')
    }
    expect(screen.getByText('六维评分对比')).toBeInTheDocument()
    expect(rowOf(SCORES, '张三').getByText('82%')).toBeInTheDocument()
    expect(rowOf(SCORES, '张三').getByRole('link', { name: '查看报告' })).toHaveAttribute('href', '/ai-interview/reports?batch=1&report=10')
    expect(api.unexpected).toEqual([])
  })

  it('配置了默认人数上限时说明只选中匹配度最高的前 N 人，可以调整选择；刷新保留已调整的选择', async () => {
    data.default_selected = [1, 2]
    data.default_limit = 2
    const api = backend()
    renderPage(<ComparisonPage />, { granted: permissions.interviewer, entry: '/?batch=1' })
    expect(await screen.findByText('参与对比的候选人（已选 2 / 3 人）')).toBeInTheDocument()
    expect(screen.getByText(/进入批次时默认选中匹配度最高的前 2 人，可以自行增减。/)).toBeInTheDocument()
    expect(tableOf(SCORES).queryByText('王五')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /全\s*选/ }))
    expect(await screen.findByText('参与对比的候选人（已选 3 / 3 人）')).toBeInTheDocument()
    expect(tableOf(SCORES).getByText('王五')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /刷\s*新/ }))
    await waitFor(() => expect(api.requests('GET', '/comparison?batch_id=1')).toHaveLength(2))
    expect(screen.getByText('参与对比的候选人（已选 3 / 3 人）')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /清\s*空/ }))
    expect(await screen.findByText('请选择要对比的候选人')).toBeInTheDocument()
  })

  it('没有评分的维度显示证据不足而不是 0 分；硬指标只给摘要，明细可展开', async () => {
    data.items = [
      item(1, '张三', { scores: { 岗位专业能力: 0, 逻辑思维: null, 沟通表达: 3, 抗压能力: 3, 职业稳定性: 4, 企业价值观契合度: 3 } }),
      item(2, '李四', {
        report_id: null, status: 'not_generated', match_score: null, scores: {}, risks: [],
        hard_indicators: hardIndicators({ available: false, reason: '候选人尚未关联人员库档案', facts: [], hard_checks: [] }),
        stage_two: { status: 'pending_review', evidence_count: 3, findings: [{ dimension: '岗位专业能力', status: '新增证据待复核' }] },
      }),
    ]
    data.default_selected = [1, 2]
    backend()
    renderPage(<ComparisonPage />, { granted: permissions.interviewer, entry: '/?batch=1' })
    const scored = await waitFor(() => rowOf(SCORES, '张三'))
    expect(scored.getByText('0 / 5')).toBeInTheDocument()
    expect(scored.getAllByText('证据不足')).toHaveLength(1)
    expect(screen.getByText(/没有柱的维度表示证据不足（未评分），不按 0 分绘制/)).toBeInTheDocument()
    expect(screen.getByText(/另有 1 人没有六维评分/)).toBeInTheDocument()
    const unscored = rowOf(SCORES, '李四')
    expect(unscored.getByText('未评分')).toBeInTheDocument()
    expect(unscored.getAllByText('证据不足')).toHaveLength(6)
    expect(unscored.getByText('未生成')).toBeInTheDocument()
    expect(unscored.queryByRole('link', { name: '查看报告' })).not.toBeInTheDocument()

    const detail = rowOf(DETAILS, '张三')
    expect(detail.getByText('满足 1')).toBeInTheDocument()
    expect(detail.getByText('待核实 1')).toBeInTheDocument()
    expect(detail.getByText('暂无综合报告')).toBeInTheDocument()
    expect(screen.queryByText('持有食品检验工证书')).not.toBeInTheDocument()
    fireEvent.click(detail.getByRole('button', { name: '查看硬指标明细' }))
    expect(await screen.findByText('持有食品检验工证书')).toBeInTheDocument()
    expect(screen.getByText('硬指标依据简历档案核对，供考官综合测评参考；是否计入评分及具体规则待人力资源部确认。')).toBeInTheDocument()
    expect(detail.getByRole('button', { name: '收起硬指标明细' })).toBeInTheDocument()

    const listened = rowOf(DETAILS, '李四')
    expect(listened.getByText('候选人尚未关联人员库档案')).toBeInTheDocument()
    expect(listened.getByText(/3 段/)).toBeInTheDocument()
    expect(listened.getByText('岗位专业能力 · 新增证据待复核')).toBeInTheDocument()
    expect(listened.getByRole('link', { name: '查看综合报告' })).toHaveAttribute('href', '/ai-interview/reports?type=comprehensive&batch=1&candidate=2')
  })

  it('导出带上批次和所选候选人，并说明只包含已人工确认的报告', async () => {
    const downloads = stubDownloads()
    const api = backend(call => call.path.startsWith('/comparison/export') ? new Response(new Blob(['docx'])) : undefined)
    renderPage(<ComparisonPage />, { granted: permissions.interviewer, entry: '/?batch=1' })
    expect(await screen.findByText(/导出只包含AI面试报告已人工确认的候选人：所选 3 人中有 1 人可以导出。/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /导出对比结果 \(Word\)/ }))
    await waitFor(() => expect(api.requests('GET', /^\/comparison\/export/)).toHaveLength(1))
    expect(api.requests('GET', /^\/comparison\/export/)[0].path).toBe('/comparison/export?batch_id=1&candidate_ids=1,2,3')
    await waitFor(() => expect(downloads.names).toEqual(['候选人对比.docx']))
  })

  it('所选候选人都没有人工确认的报告时不能导出；后端拒绝时显示原因', async () => {
    data.items = [item(1, '张三'), item(2, '李四', { status: 'confirmed' })]
    data.default_selected = [1]
    const api = backend(call => call.path.startsWith('/comparison/export') ? httpError(409, '所选候选人暂无人工确认的报告，不能导出候选人对比结果') : undefined)
    stubDownloads()
    renderPage(<ComparisonPage />, { granted: permissions.interviewer, entry: '/?batch=1' })
    expect(await screen.findByText(/所选 1 人中有 0 人可以导出，请先在面试报告中完成人工确认。/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /导出对比结果 \(Word\)/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /全\s*选/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /导出对比结果 \(Word\)/ })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: /导出对比结果 \(Word\)/ }))
    expect(await screen.findByText('所选候选人暂无人工确认的报告，不能导出候选人对比结果')).toBeInTheDocument()
    // 李四的匹配度更高，排在前面。
    expect(api.requests('GET', /^\/comparison\/export/)[0].path).toBe('/comparison/export?batch_id=1&candidate_ids=2,1')
  })

  it('按所选指标从高到低排列，导出顺序随之变化', async () => {
    data.items = [
      item(1, '张三', { status: 'confirmed', match_score: 82, scores: { 岗位专业能力: 2, 逻辑思维: 4 } }),
      item(2, '李四', { status: 'confirmed', match_score: 74, scores: { 岗位专业能力: 5, 逻辑思维: 3 } }),
    ]
    data.default_selected = [1, 2]
    const api = backend(call => call.path.startsWith('/comparison/export') ? new Response(new Blob(['docx'])) : undefined)
    stubDownloads()
    renderPage(<ComparisonPage />, { granted: permissions.interviewer, entry: '/?batch=1' })
    const names = () => tableOf(SCORES).getAllByRole('row').map(row => row.querySelector('td strong')?.textContent).filter(Boolean)
    await waitFor(() => expect(names()).toEqual(['张三', '李四']))
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '排序指标' }))
    await chooseOption('岗位专业能力')
    await waitFor(() => expect(names()).toEqual(['李四', '张三']))
    fireEvent.click(screen.getByRole('button', { name: /导出对比结果 \(Word\)/ }))
    await waitFor(() => expect(api.requests('GET', /^\/comparison\/export/)).toHaveLength(1))
    expect(api.requests('GET', /^\/comparison\/export/)[0].path).toBe('/comparison/export?batch_id=1&candidate_ids=2,1')
  })

  it('本批次尚无报告的候选人单独列出，不参与对比', async () => {
    data.without_report = [
      { id: 7, code: 'B-2026-01-007', name: '赵六', interview_status: 'in_progress', report_status: 'not_generated' },
      { id: 8, code: 'B-2026-01-008', name: '钱七', interview_status: 'completed', report_status: 'generating' },
    ]
    backend()
    renderPage(<ComparisonPage />, { granted: permissions.interviewer, entry: '/?batch=1' })
    const notice = within((await screen.findByText('本批次另有 2 人尚无报告，未参与对比')).closest('.ant-alert') as HTMLElement)
    expect(notice.getByText('赵六（B-2026-01-007）')).toBeInTheDocument()
    expect(notice.getByText('面试中')).toBeInTheDocument()
    expect(notice.getByText('未生成')).toBeInTheDocument()
    expect(notice.getByText('钱七（B-2026-01-008）')).toBeInTheDocument()
    expect(notice.getByText('报告生成中')).toBeInTheDocument()
    expect(screen.getByText('参与对比的候选人（已选 3 / 3 人）')).toBeInTheDocument()
    expect(tableOf(SCORES).queryByText('赵六')).not.toBeInTheDocument()
  })

  it('批次没有可对比的候选人时给出说明', async () => {
    backend()
    renderPage(<ComparisonPage />, { granted: permissions.interviewer, entry: '/?batch=2' })
    expect(await screen.findByText('该批次还没有已生成报告的候选人')).toBeInTheDocument()
    expect(screen.queryByText('六维评分对比')).not.toBeInTheDocument()
  })
})
