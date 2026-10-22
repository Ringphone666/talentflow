import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ReportsPage from '../pages/interview/ReportsPage'
import { batch, chooseOption, findDialog, httpError, permissions, quietComputedStyle, renderPage, stubApi, stubDownloads, type Call } from './interview-helpers'
import { EXCERPT, REASON, emptyReport, report, reportContent } from './report-fixtures'

let reports: Array<ReturnType<typeof report>>

function backend(extra?: (call: Call) => unknown) {
  return stubApi(call => {
    const custom = extra?.(call)
    if (custom !== undefined) return custom
    if (call.method !== 'GET') return undefined
    if (call.path === '/batches') return [batch(), batch({ id: 2, code: 'B-2026-02', name: '第二批次' })]
    if (call.path === '/reports') return structuredClone(reports)
    const filtered = call.path.match(/^\/reports\?batch_id=(\d+)$/)
    if (filtered) return structuredClone(reports.filter(item => item.batch?.id === Number(filtered[1])))
    return undefined
  })
}

const rowOf = (name: string) => within(screen.getByText(name).closest('tr') as HTMLElement)
const location = () => screen.getByTestId('location').textContent

beforeEach(() => {
  quietComputedStyle()
  reports = [report()]
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('AI面试报告列表', () => {
  it('不选批次时显示全部报告，选择批次后按批次查询；未生成成功的报告没有查看入口', async () => {
    reports = [
      report(),
      emptyReport('generation_failed', { id: 11, candidate: { id: 3, code: 'B-2026-01-003', name: '李四' } }),
      report({ id: 12, candidate: { id: 4, code: 'B-2026-02-001', name: '王五' }, batch: { id: 2, code: 'B-2026-02', name: '第二批次' }, status: 'confirmed', match_score: 76.5 }),
    ]
    const api = backend()
    renderPage(<ReportsPage />, { granted: permissions.reportReviewer })
    expect(await screen.findByText('张三')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'AI面试报告' })).toHaveAttribute('aria-selected', 'true')
    for (const title of ['候选人', '批次', '岗位', '状态', '匹配度', '更新时间']) {
      expect(screen.getByRole('columnheader', { name: title })).toBeInTheDocument()
    }
    expect(api.requests('GET', '/reports')).toHaveLength(1)
    expect(api.calls.some(call => call.path === '/jobs')).toBe(false)

    const ready = rowOf('张三')
    expect(ready.getByText('待人工复核')).toBeInTheDocument()
    expect(ready.getByText('82%')).toBeInTheDocument()
    expect(ready.getByText('制造工艺岗')).toBeInTheDocument()
    expect(ready.getByRole('button', { name: /查看报告/ })).toBeInTheDocument()
    expect(ready.queryByRole('button', { name: /导出 Word/ })).not.toBeInTheDocument()
    const failed = rowOf('李四')
    expect(failed.getByText('生成失败')).toBeInTheDocument()
    expect(failed.getByText('—')).toBeInTheDocument()
    expect(failed.queryByRole('button', { name: /查看报告/ })).not.toBeInTheDocument()
    expect(failed.getByRole('button', { name: /重新生成/ })).toBeInTheDocument()
    expect(screen.getByText('生成失败原因：文本模型响应超时，报告未生成；候选人的回答已保存')).toHaveClass('evidence-text')
    expect(rowOf('王五').getByRole('button', { name: /导出 Word/ })).toBeInTheDocument()

    fireEvent.mouseDown(screen.getByRole('combobox', { name: '按批次筛选报告' }))
    await chooseOption('第二批次 · 制造工艺岗')
    await waitFor(() => expect(screen.queryByText('张三')).not.toBeInTheDocument())
    expect(screen.getByText('王五')).toBeInTheDocument()
    expect(api.requests('GET', '/reports?batch_id=2')).toHaveLength(1)
    expect(location()).toBe('/?batch=2')
    expect(api.unexpected).toEqual([])
  })

  it('有报告生成中时自动刷新，生成结束后停止', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let loads = 0
    backend(call => {
      if (call.method !== 'GET' || call.path !== '/reports') return undefined
      loads += 1
      return [loads >= 3 ? report({ id: 11 }) : emptyReport('generating', { id: 11 })]
    })
    renderPage(<ReportsPage />, { granted: permissions.reportReviewer })
    expect(await screen.findByText('报告生成中')).toBeInTheDocument()
    expect(screen.getByText('有报告正在生成，列表会自动刷新')).toBeInTheDocument()
    expect(screen.getByText('生成完成后可查看')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /查看报告/ })).not.toBeInTheDocument()

    for (let round = 0; round < 4 && loads < 3; round += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(4100) })
    }
    expect(await screen.findByText('待人工复核')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /查看报告/ })).toBeInTheDocument()
    expect(screen.queryByText('有报告正在生成，列表会自动刷新')).not.toBeInTheDocument()
    const settled = loads
    expect(settled).toBe(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(20000) })
    expect(loads).toBe(settled)
  })

  it('没有报告在生成时不定时刷新', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const api = backend()
    renderPage(<ReportsPage />, { granted: permissions.reportReviewer })
    expect(await screen.findByText('待人工复核')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(20000) })
    expect(api.requests('GET', '/reports')).toHaveLength(1)
  })

  it('生成失败的报告可以重新生成，随后继续自动刷新', async () => {
    reports = [emptyReport('generation_failed', { id: 11 })]
    const api = backend(call => {
      if (call.method !== 'POST' || call.path !== '/reports/11/retry-generation') return undefined
      reports = [emptyReport('generating', { id: 11 })]
      return reports[0]
    })
    renderPage(<ReportsPage />, { granted: permissions.reportReviewer })
    fireEvent.click(await screen.findByRole('button', { name: /重新生成/ }))
    expect(await screen.findByText('报告生成中')).toBeInTheDocument()
    // 表格收起该行后只是隐藏，不一定移除。
    const reason = screen.queryByText(/生成失败原因/)
    expect(reason === null || (reason.closest('tr') as HTMLElement).style.display === 'none').toBe(true)
    expect(screen.getByText('有报告正在生成，列表会自动刷新')).toBeInTheDocument()
    expect(api.writes().map(call => `${call.method} ${call.path}`)).toEqual(['POST /reports/11/retry-generation'])
  })
})

describe('报告详情与人工复核', () => {
  it('完整显示评价理由和证据，硬指标与六维评价分开；未确认不能导出', async () => {
    backend()
    renderPage(<ReportsPage />, { granted: permissions.reportReviewer, entry: '/?report=10' })
    const drawer = await findDialog('张三 · AI面试报告')
    expect(drawer.getByText(REASON)).toHaveClass('evidence-text')
    expect(drawer.getAllByText(EXCERPT).every(node => node.classList.contains('evidence-text'))).toBe(true)
    expect(drawer.getByText('4 / 5')).toBeInTheDocument()
    expect(drawer.getByText('六维评价（软性评价）')).toBeInTheDocument()

    const hard = within(drawer.getByText('硬指标（与六维评价分开，不计入评分）').closest('.ant-card') as HTMLElement)
    expect(hard.getAllByText('示例大学 工业工程 本科').length).toBeGreaterThan(0)
    expect(hard.getByText('持有食品检验工证书')).toBeInTheDocument()
    expect(hard.getByText('无法确认')).toBeInTheDocument()
    expect(hard.getByText('硬指标依据简历档案核对，供考官综合测评参考；是否计入评分及具体规则待人力资源部确认。')).toBeInTheDocument()
    expect(drawer.getByText('简历与回答核对')).toBeInTheDocument()

    expect(drawer.getByText('报告经人工确认后才能导出。')).toBeInTheDocument()
    expect(drawer.queryByRole('button', { name: /导出 Word/ })).not.toBeInTheDocument()
    for (const action of [/AI重新评分/, /人工修改/, /退回/, /人工确认/]) expect(drawer.getByRole('button', { name: action })).toBeInTheDocument()
  })

  it('人工确认后显示面试结论是否已同步到人员库，确认后才能导出', async () => {
    const downloads = stubDownloads()
    const api = backend(call => {
      if (call.path === '/reports/10/export') return new Response(new Blob(['docx']), { headers: { 'X-Download-Name': encodeURIComponent('张三_AI面试报告.docx') } })
      if (call.method !== 'POST' || call.path !== '/reports/10/confirm') return undefined
      reports = [report({ status: 'confirmed' })]
      return { ok: true, status: 'confirmed', library_sync: '面试结论已同步到人员库，可作为人岗匹配的输入材料' }
    })
    renderPage(<ReportsPage />, { granted: permissions.reportReviewer, entry: '/?report=10' })
    const drawer = await findDialog('张三 · AI面试报告')
    fireEvent.click(drawer.getByRole('button', { name: /人工确认/ }))
    const modal = await findDialog('人工确认报告')
    fireEvent.click(modal.getByRole('button', { name: '确认并允许导出' }))
    expect(await modal.findByText('请填写至少2个字的处理原因')).toBeInTheDocument()
    expect(api.writes()).toHaveLength(0)
    fireEvent.change(modal.getByLabelText('处理原因'), { target: { value: '已核对回答原文和评分依据' } })
    fireEvent.click(modal.getByRole('button', { name: '确认并允许导出' }))

    expect(await drawer.findByText('报告已人工确认，可以导出')).toBeInTheDocument()
    expect(drawer.getByText('面试结论已同步到人员库，可作为人岗匹配的输入材料')).toBeInTheDocument()
    expect(api.requests('POST', '/reports/10/confirm')[0].body).toEqual({ reason: '已核对回答原文和评分依据' })
    expect(drawer.queryByRole('button', { name: /人工确认/ })).not.toBeInTheDocument()
    fireEvent.click(await drawer.findByRole('button', { name: /导出 Word/ }))
    await waitFor(() => expect(downloads.names).toEqual(['张三_AI面试报告.docx']))
    expect(api.requests('GET', '/reports/10/export')).toHaveLength(1)
  })

  it('候选人未关联人员库时如实提示面试结论未同步', async () => {
    backend(call => {
      if (call.method !== 'POST') return undefined
      reports = [report({ status: 'confirmed' })]
      return { ok: true, status: 'confirmed', library_sync: '候选人未关联人员库，面试结论未同步' }
    })
    renderPage(<ReportsPage />, { granted: permissions.reportReviewer, entry: '/?report=10' })
    const drawer = await findDialog('张三 · AI面试报告')
    fireEvent.click(drawer.getByRole('button', { name: /人工确认/ }))
    const modal = await findDialog('人工确认报告')
    fireEvent.change(modal.getByLabelText('处理原因'), { target: { value: '已核对' } })
    fireEvent.click(modal.getByRole('button', { name: '确认并允许导出' }))
    const note = await drawer.findByText('候选人未关联人员库，面试结论未同步')
    expect(note.closest('.ant-alert')).toHaveClass('ant-alert-warning')
  })

  it('退回须填写原因', async () => {
    const api = backend(call => {
      if (call.method !== 'POST') return undefined
      reports = [report({ status: 'returned' })]
      return { ok: true, status: 'returned' }
    })
    renderPage(<ReportsPage />, { granted: permissions.reportReviewer, entry: '/?report=10' })
    const drawer = await findDialog('张三 · AI面试报告')
    fireEvent.click(drawer.getByRole('button', { name: /退回/ }))
    const modal = await findDialog('退回报告')
    fireEvent.change(modal.getByLabelText('处理原因'), { target: { value: '评分依据与回答原文不符' } })
    fireEvent.click(modal.getByRole('button', { name: '确认退回' }))
    expect(await drawer.findByText('报告已退回')).toBeInTheDocument()
    expect(api.requests('POST', '/reports/10/return')[0].body).toEqual({ reason: '评分依据与回答原文不符' })
    await waitFor(() => expect(drawer.queryByRole('button', { name: /退回/ })).not.toBeInTheDocument())
  })

  it('AI重新评分带上当前版本号，失败可重试，成功后切到新版本', async () => {
    let finish!: (value: unknown) => void
    const api = backend(call => call.path === '/reports/10/regenerate' ? new Promise(resolve => { finish = resolve }) : undefined)
    reports = [report({ status: 'confirmed' })]
    renderPage(<ReportsPage />, { granted: permissions.reportReviewer, entry: '/?report=10' })
    const drawer = await findDialog('张三 · AI面试报告')
    fireEvent.click(drawer.getByRole('button', { name: /AI重新评分/ }))
    fireEvent.click(drawer.getByRole('button', { name: /AI评分中/ }))
    expect(drawer.getByRole('button', { name: /人工修改/ })).toBeDisabled()
    expect(drawer.getByRole('button', { name: /导出 Word/ })).toBeDisabled()
    expect(api.requests('POST', '/reports/10/regenerate')).toHaveLength(1)
    expect(api.requests('POST', '/reports/10/regenerate')[0].body).toEqual({ expected_version: 1 })
    await act(async () => finish(httpError(504, 'AI服务响应超时')))
    expect(await drawer.findByText('AI重新评分未完成')).toBeInTheDocument()
    expect(drawer.getByText('AI服务响应超时')).toBeInTheDocument()

    fireEvent.click(drawer.getByRole('button', { name: /重\s*试/ }))
    await waitFor(() => expect(api.requests('POST', '/reports/10/regenerate')).toHaveLength(2))
    const rescored = reportContent({
      summary: '根据原话重新评为0分',
      evaluations: [{ dimension: '岗位专业能力', weight: 25, score: 0, level: '0级', reason: '答非所问', answer_ids: ['A1'], evidence_excerpt: '喂喂喂', evidence_sufficiency: '部分', insufficient: false }],
    })
    const original = report()
    await act(async () => finish({
      ...original, current_version: 2, status: 'pending_review', match_score: 0, current_content: rescored,
      versions: [...original.versions, { ...original.versions[0], version: 2, version_type: 'ai_regenerated', content: rescored }],
    }))
    expect(await drawer.findByText('根据原话重新评为0分')).toBeInTheDocument()
    expect(drawer.getByText('0 / 5')).toBeInTheDocument()
    expect(drawer.getByText('喂喂喂')).toBeInTheDocument()
    expect(drawer.getByText('AI重新评分已保存为新版本')).toBeInTheDocument()
    expect(drawer.queryByRole('button', { name: /导出 Word/ })).not.toBeInTheDocument()
    fireEvent.click(drawer.getByRole('tab', { name: '版本记录 (2)' }))
    expect(await drawer.findByText('AI重新评分版本')).toBeInTheDocument()
    expect(drawer.getByText('AI原始版本')).toBeInTheDocument()
  })

  it('人工修改须填写原因；改为0分时保存0级且保留已评分状态', async () => {
    const api = backend(call => {
      if (call.method !== 'PUT') return undefined
      const content = (call.body as { content: ReturnType<typeof reportContent> }).content
      return report({ current_version: 2, current_content: content })
    })
    renderPage(<ReportsPage />, { granted: permissions.reportReviewer, entry: '/?report=10' })
    const drawer = await findDialog('张三 · AI面试报告')
    fireEvent.click(drawer.getByRole('button', { name: /人工修改/ }))
    const modal = await findDialog('创建人工修改版本')
    const score = modal.getByRole('spinbutton', { name: '岗位专业能力人工辅助评分' })
    fireEvent.change(score, { target: { value: '0' } })
    fireEvent.blur(score)
    fireEvent.click(modal.getByRole('button', { name: '保存人工版本' }))
    expect(await modal.findByText('请填写至少2个字的修改原因')).toBeInTheDocument()
    expect(api.writes()).toHaveLength(0)
    fireEvent.change(modal.getByLabelText('修改原因'), { target: { value: '核对原话为答非所问' } })
    fireEvent.click(modal.getByRole('button', { name: '保存人工版本' }))
    await waitFor(() => expect(api.requests('PUT', '/reports/10')).toHaveLength(1))
    const saved = api.requests('PUT', '/reports/10')[0].body as { reason: string; content: ReturnType<typeof reportContent> }
    expect(saved.reason).toBe('核对原话为答非所问')
    expect(saved.content.evaluations[0]).toMatchObject({ score: 0, level: '0级', insufficient: false, reason: REASON })
    expect(saved.content.hard_indicators).toEqual(reportContent().hard_indicators)
    expect(await drawer.findByText('人工修改版本已保存')).toBeInTheDocument()
  })

  it('只有查看权限时不显示复核、重新生成和导出', async () => {
    reports = [report({ status: 'confirmed' }), emptyReport('generation_failed', { id: 11, candidate: { id: 3, code: 'B-2026-01-003', name: '李四' } })]
    backend()
    renderPage(<ReportsPage />, { granted: ['report:read'], entry: '/?report=10' })
    const drawer = await findDialog('张三 · AI面试报告')
    expect(drawer.getByText(REASON)).toBeInTheDocument()
    for (const action of [/AI重新评分/, /人工修改/, /退回/, /人工确认/, /导出 Word/, /重新生成/]) {
      expect(screen.queryByRole('button', { name: action })).not.toBeInTheDocument()
    }
    expect(screen.getByText(/生成失败原因/)).toBeInTheDocument()
  })
})
