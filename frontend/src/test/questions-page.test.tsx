import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BatchesPage from '../pages/interview/BatchesPage'
import type { Question } from '../types'
import { activePane, batch, chooseOption, findDialog, httpError, permissions, quietComputedStyle, renderPage, stubApi, type Call } from './interview-helpers'

const question = (id: number, version: number, status: string, batchId = 1): Question => ({
  id, batch_id: batchId, job_id: 11, sequence: id, dimension: '岗位专业能力', content: `测试题目 ${id}`, time_limit: 90, version, status, review_comment: '', change_log: [],
})
const libraryJobs = [
  { id: 'job-brew', name: '制造工艺岗', sequence: '生产序列', level: 'P3', interview: { configured: true, audit_status: 'approved' } },
  { id: 'job-qa', name: '质量检验岗', sequence: '质量序列', level: 'P2', interview: { configured: false, audit_status: 'not_configured' } },
]

let rows: Question[]
let batches: Array<ReturnType<typeof batch>>
let entries: Array<Record<string, unknown>>
/** 各批次的题目生成状态（批次编号 → 状态）；没有登记的批次没有进行中的生成。 */
let generations: Record<number, Record<string, unknown>>

/** 默认的后端应答；extra 返回 undefined 时落到默认应答。 */
function backend(extra?: (call: Call) => unknown) {
  return stubApi(call => {
    const custom = extra?.(call)
    if (custom !== undefined) return custom
    if (call.method !== 'GET') return undefined
    if (call.path === '/batches') return structuredClone(batches)
    if (call.path === '/dimensions') return [{ id: 1, name: '岗位专业能力' }]
    if (call.path === '/library/jobs') return libraryJobs
    const questions = call.path.match(/^\/questions\?batch_id=(\d+)$/)
    if (questions) return structuredClone(rows.filter(item => item.batch_id === Number(questions[1])))
    const generation = call.path.match(/^\/batches\/(\d+)\/questions\/generation$/)
    if (generation) return structuredClone(generations[Number(generation[1])] ?? { running: false })
    if (/^\/batches\/\d+\/onsite-entries$/.test(call.path)) return structuredClone(entries)
    return undefined
  })
}

const GENERATION_PATH = '/batches/1/questions/generation'
const TIMEOUT_REASON = 'AI服务响应超时，请稍后重试'
/** 后台作业记录，与发起生成的接口返回的一致。 */
const operation = (overrides: Record<string, unknown> = {}) => ({
  id: 'op-1', kind: 'question_generation', label: '生成 6 道主体题', status: 'running', progress: '', result: null, error: '', ...overrides,
})
// 时间取世界时正午，在任何时区换算后都是同一天。
const generationRunning = (progress: string, overrides: Record<string, unknown> = {}, id = 'op-1') => ({
  running: true, operation: operation({ id, progress }), count: 6, started_at: '2026-09-29T12:00:00+00:00', started_by: 'tester', elapsed_seconds: 0, ...overrides,
})
const generationCompleted = (version: number, count: number, id = 'op-1') => ({
  running: false, operation: operation({ id, status: 'completed', progress: `已生成 ${count} / ${count} 道`, result: { version, count } }),
  count, started_at: '2026-09-29T12:00:00+00:00', started_by: 'tester', elapsed_seconds: 40, finished_at: '2026-09-29T12:00:40+00:00',
  last_result: { version, count, message: 'AI辅助生成，须人工复核。' },
})
const generationFailed = (reason: string, id = 'op-1') => ({
  running: false, operation: operation({ id, status: 'failed', error: reason }),
  count: 6, started_at: '2026-09-29T12:00:00+00:00', started_by: 'hr_li', elapsed_seconds: 181, finished_at: '2026-09-29T12:03:01+00:00',
  last_error: reason,
})
/** 发起生成的接口：登记为进行中，返回后台作业记录。 */
const acceptGeneration = (progress: string, overrides: Record<string, unknown> = {}) => {
  let started = 0
  return (call: Call) => {
    if (call.method !== 'POST' || call.path !== '/batches/1/questions/generate') return undefined
    started += 1
    generations[1] = generationRunning(progress, overrides, `op-${started}`)
    return operation({ id: `op-${started}` })
  }
}
const pause = (milliseconds: number) => new Promise(resolve => window.setTimeout(resolve, milliseconds))
const generationNotice = async (text: RegExp) => (await screen.findByText(text)).closest('.ant-alert') as HTMLElement

async function openVersion(name: RegExp) {
  fireEvent.click(screen.getByRole('tab', { name }))
  await waitFor(() => expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true'))
  return activePane()
}

beforeEach(() => {
  quietComputedStyle()
  rows = [question(1, 1, 'published'), question(2, 2, 'draft'), question(3, 3, 'draft'), question(4, 4, 'approved'), question(5, 4, 'pending_review')]
  batches = [batch()]
  entries = []
  generations = {}
})
afterEach(() => vi.restoreAllMocks())

describe('题目版本与审核流程', () => {
  it('区分当前启用、草稿和待审核，显示下一步，不把最新版误当成启用版', async () => {
    const api = backend()
    renderPage(<BatchesPage />)
    expect(await screen.findByText('共 4 套题目版本 · 当前启用 v1')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /v1.*当前启用/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /v4.*待审核 1/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('共 2 道主体题 · 已通过 1/2 道')).toBeInTheDocument()
    expect(activePane().getByRole('button', { name: /一键审核/ })).toBeInTheDocument()
    expect(activePane().queryByRole('button', { name: /提交本版本审核/ })).not.toBeInTheDocument()
    const draft = await openVersion(/v3.*草稿/)
    expect(draft.getByRole('button', { name: /提交本版本审核/ })).toBeInTheDocument()
    expect(draft.queryByRole('button', { name: /一键审核/ })).not.toBeInTheDocument()
    expect(api.writes()).toHaveLength(0)
    expect(api.unexpected).toEqual([])
  })

  it('题目内容完整显示；只有待审核的题目可以逐题审核', async () => {
    rows = [question(1, 1, 'draft'), question(2, 1, 'pending_review')]
    rows[0].content = '请结合一次真实的质量异常，完整说明你如何发现问题、判断原因、采取措施并验证结果。'
    batches = [batch({ status: 'reviewing', question_version: 0 })]
    backend()
    renderPage(<BatchesPage />)
    expect(await screen.findByText(rows[0].content)).toHaveClass('evidence-text')
    const review = activePane().getAllByRole('button', { name: /审核$/ })
    expect(review).toHaveLength(1)
    expect(review[0].closest('tr')).toHaveTextContent('测试题目 2')
  })

  it('提交时阻止重复点击，成功后保留反馈及已通过题目，不自动发布', async () => {
    rows = [question(1, 1, 'published'), question(2, 2, 'approved'), question(3, 2, 'draft')]
    let complete!: (value: { count: number }) => void
    const pending = new Promise<{ count: number }>(resolve => { complete = resolve })
    const api = backend(call => call.path.endsWith('/submit-review') ? pending : undefined)
    renderPage(<BatchesPage />)
    const button = await screen.findByRole('button', { name: /提交本版本审核/ })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(button).toHaveClass('ant-btn-loading')
    expect(api.writes()).toHaveLength(1)
    rows[2].status = 'pending_review'
    await act(async () => { complete({ count: 1 }); await pending })
    expect(await screen.findByText(/v2 提交成功，1 道题等待审核/)).toBeInTheDocument()
    expect(screen.getByText('共 2 道主体题 · 已通过 1/2 道')).toBeInTheDocument()
    expect(screen.getByText('共 2 套题目版本 · 当前启用 v1')).toBeInTheDocument()
    expect(activePane().queryByRole('button', { name: /提交本版本审核/ })).not.toBeInTheDocument()
    expect(api.writes().map(call => `${call.method} ${call.path}`)).toEqual(['POST /batches/1/questions/2/submit-review'])
  })

  it('提交失败持续显示原因，并可重新提交', async () => {
    rows = [question(1, 1, 'published'), question(2, 2, 'draft')]
    let attempts = 0
    const api = backend(call => {
      if (!call.path.endsWith('/submit-review')) return undefined
      if (++attempts === 1) return httpError(503, '服务暂不可用')
      rows[1].status = 'pending_review'
      return { count: 1 }
    })
    renderPage(<BatchesPage />)
    fireEvent.click(await screen.findByRole('button', { name: /提交本版本审核/ }))
    expect(await screen.findByText(/v2 提交失败：服务暂不可用/)).toBeInTheDocument()
    const retry = screen.getByRole('button', { name: /提交本版本审核/ })
    await waitFor(() => expect(retry).not.toHaveClass('ant-btn-loading'))
    fireEvent.click(retry)
    expect(await screen.findByText(/v2 提交成功/)).toBeInTheDocument()
    expect(api.writes()).toHaveLength(2)
  })

  it('一键审核等操作与题目生成互不影响', async () => {
    generations[1] = generationRunning('已生成 6 / 12 道', { count: 12 })
    backend()
    renderPage(<BatchesPage pollIntervalMs={20} />)
    await generationNotice(/^正在生成题目：已生成 6 \/ 12 道/)
    // 生成在后台进行，期间只停用“AI生成新版本”，已有版本照常维护。
    expect(screen.getByRole('button', { name: /AI生成新版本/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /手动新增题目/ })).toBeEnabled()
    expect(activePane().getByRole('button', { name: /一键审核/ })).toBeEnabled()
    expect(activePane().getByRole('button', { name: /一键删除/ })).toBeEnabled()
    const draft = await openVersion(/v3.*草稿/)
    expect(draft.getByRole('button', { name: /提交本版本审核/ })).toBeEnabled()
  })

  it('一键审核经确认只提交一次整套审核，成功后显示发布按钮', async () => {
    const api = backend(call => {
      if (!call.path.endsWith('/review-all')) return undefined
      rows = rows.map(item => item.version === 4 ? { ...item, status: 'approved' } : item)
      return { count: 1 }
    })
    renderPage(<BatchesPage />)
    fireEvent.click(await screen.findByRole('button', { name: /一键审核/ }))
    expect(api.writes()).toHaveLength(0)
    fireEvent.click(await screen.findByRole('button', { name: '全部通过' }))
    expect(await screen.findByRole('button', { name: /发布本版本/ })).toBeInTheDocument()
    expect(api.writes()).toHaveLength(1)
    expect(api.writes()[0]).toMatchObject({ method: 'POST', path: '/batches/1/questions/4/review-all', body: { approved: true } })
    expect(activePane().queryByRole('button', { name: /一键审核/ })).not.toBeInTheDocument()
  })

  it('一键删除需确认且只删除当前版本，已发布版本不显示删除按钮', async () => {
    const api = backend(call => {
      if (call.method !== 'DELETE') return undefined
      rows = rows.filter(item => item.version !== 4)
      return { count: 2 }
    })
    renderPage(<BatchesPage />)
    fireEvent.click(await screen.findByRole('button', { name: /一键删除/ }))
    expect(api.writes()).toHaveLength(0)
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(screen.queryByRole('tab', { name: /v4/ })).not.toBeInTheDocument())
    expect(api.writes().map(call => `${call.method} ${call.path}`)).toEqual(['DELETE /batches/1/questions/4'])
    const published = await openVersion(/v1/)
    expect(published.getByText('测试题目 1')).toBeInTheDocument()
    expect(published.queryByRole('button', { name: /一键删除/ })).not.toBeInTheDocument()
  })

  it('切换批次后忽略上一批次延迟返回的题目', async () => {
    let complete!: (value: Question[]) => void
    const pending = new Promise<Question[]>(resolve => { complete = resolve })
    batches = [batch(), batch({ id: 2, code: 'B-2026-02', name: '第二批次' })]
    rows.push({ ...question(9, 1, 'published', 2), content: '第二批次专属题目' })
    backend(call => call.path === '/questions?batch_id=1' ? pending : undefined)
    renderPage(<BatchesPage />)
    fireEvent.click(await screen.findByText('B-2026-02'))
    expect(await screen.findByText('第二批次专属题目')).toBeInTheDocument()
    await act(async () => { complete(rows.filter(item => item.batch_id === 1)); await pending })
    expect(screen.getByText('第二批次专属题目')).toBeInTheDocument()
    expect(screen.queryByText('测试题目 5')).not.toBeInTheDocument()
  })
})

describe('AI生成题目', () => {
  async function openGenerateDialog() {
    await screen.findByText('共 4 套题目版本 · 当前启用 v1')
    fireEvent.click(screen.getByRole('button', { name: /AI生成新版本/ }))
    return findDialog('AI生成主体题')
  }

  it('以后台方式发起，弹窗显示进度和已用时间，完成后选中新草稿版本', async () => {
    const api = backend(acceptGeneration('正在生成第 1 至 6 道（共 6 道）'))
    renderPage(<BatchesPage pollIntervalMs={20} />)
    const dialog = await openGenerateDialog()
    const generate = dialog.getByRole('button', { name: '生成草稿' })
    fireEvent.click(generate)
    fireEvent.click(generate)
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0]).toMatchObject({ method: 'POST', path: '/batches/1/questions/generate', body: { count: 6, background: true } })

    const progress = await dialog.findByRole('status')
    await waitFor(() => expect(progress).toHaveTextContent('正在生成第 1 至 6 道（共 6 道）'))
    expect(progress).toHaveTextContent('由 tester 发起，共 6 道')
    expect(progress).toHaveTextContent('可以关闭本窗口或离开本页，生成完成后在这里查看')
    expect(dialog.queryByText(/请勿刷新|不要重复|保持页面打开/)).not.toBeInTheDocument()
    expect(dialog.getByRole('spinbutton', { name: '主体题数量' })).toBeDisabled()
    expect(dialog.getByRole('button', { name: '在后台继续' })).toBeInTheDocument()
    expect(dialog.queryByRole('button', { name: '生成草稿' })).not.toBeInTheDocument()
    await dialog.findByText(/已用时 [1-9]\d* 秒/)

    rows.push(question(6, 5, 'draft'))
    generations[1] = generationCompleted(5, 1)
    expect(await screen.findByRole('tab', { name: /v5.*草稿/ })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(screen.queryByText('AI生成主体题')).not.toBeInTheDocument())
    expect(screen.getByText(/v5 生成完成，共 1 道题/)).toBeInTheDocument()
    expect(activePane().getByText('测试题目 6')).toBeInTheDocument()
    expect(api.writes()).toHaveLength(1)
    // 进度从批次的生成状态读取，不按作业编号查询。
    expect(api.calls.some(call => call.path.startsWith('/library/operations'))).toBe(false)
    expect(api.unexpected).toEqual([])
  })

  it('选择在后台继续后关闭弹窗，题目卡片显示进度，完成后自动刷新并选中新版本', async () => {
    const api = backend(acceptGeneration('正在生成第 1 至 6 道（共 12 道）', { count: 12 }))
    renderPage(<BatchesPage pollIntervalMs={20} />)
    const dialog = await openGenerateDialog()
    fireEvent.change(dialog.getByRole('spinbutton', { name: '主体题数量' }), { target: { value: '12' } })
    fireEvent.click(dialog.getByRole('button', { name: '生成草稿' }))
    fireEvent.click(await dialog.findByRole('button', { name: '在后台继续' }))
    await waitFor(() => expect(screen.queryByText('AI生成主体题')).not.toBeInTheDocument())
    expect(api.writes().map(call => call.body)).toEqual([{ count: 12, background: true }])

    const notice = await generationNotice(/^正在生成题目：正在生成第 1 至 6 道（共 12 道），已用时 \d+ 秒$/)
    expect(notice).toHaveAttribute('role', 'status')
    expect(notice).toHaveTextContent('由 tester 发起，共 12 道。可以离开本页，生成完成后在这里查看。')
    expect(notice.querySelector('.anticon-loading')).not.toBeNull()
    const button = screen.getByRole('button', { name: /AI生成新版本/ })
    expect(button).toBeDisabled()
    expect(button).toHaveClass('ant-btn-loading')

    generations[1] = generationRunning('已生成 6 / 12 道，正在生成第 7 至 12 道', { count: 12 })
    expect(await screen.findByText(/^正在生成题目：已生成 6 \/ 12 道，正在生成第 7 至 12 道，已用时 \d+ 秒$/)).toBeInTheDocument()

    rows.push(question(6, 5, 'draft'), question(7, 5, 'draft'))
    generations[1] = generationCompleted(5, 2)
    expect(await screen.findByRole('tab', { name: /v5.*草稿/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/v5 生成完成，共 2 道题/)).toBeInTheDocument()
    expect(screen.getByText('共 5 套题目版本 · 当前启用 v1')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText(/^正在生成题目/)).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: /AI生成新版本/ })).toBeEnabled())
    // 生成结束后不再查询进度。
    await pause(100)
    const queried = api.requests('GET', GENERATION_PATH).length
    await pause(200)
    expect(api.requests('GET', GENERATION_PATH)).toHaveLength(queried)
    expect(api.unexpected).toEqual([])
  })

  it('打开或刷新页面时恢复显示进行中的生成，按批次的生成状态查询到结束', async () => {
    generations[1] = generationRunning('已生成 6 / 12 道', { count: 12, started_by: 'hr_li', elapsed_seconds: 125 }, 'op-colleague')
    const api = backend()
    renderPage(<BatchesPage pollIntervalMs={20} />)
    const notice = await generationNotice(/^正在生成题目：已生成 6 \/ 12 道，已用时 12[5-9] 秒$/)
    expect(notice).toHaveTextContent('由 hr_li 发起，共 12 道。可以离开本页，生成完成后在这里查看。')
    expect(screen.getByRole('button', { name: /AI生成新版本/ })).toBeDisabled()
    expect(screen.getByRole('tab', { name: /v4.*待审核 1/ })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(api.requests('GET', GENERATION_PATH).length).toBeGreaterThan(3))

    rows.push(question(6, 5, 'draft'))
    generations[1] = generationCompleted(5, 1, 'op-colleague')
    expect(await screen.findByRole('tab', { name: /v5.*草稿/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/v5 生成完成，共 1 道题/)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText(/^正在生成题目/)).not.toBeInTheDocument())
    expect(api.writes()).toHaveLength(0)
    // 刷新后作业编号已经丢失，别人发起的作业也查不了：只查询批次的生成状态。
    expect(api.calls.some(call => call.path.startsWith('/library/operations'))).toBe(false)
    expect(api.unexpected).toEqual([])
  })

  it('最近一次生成失败时说明原因，关闭提示后在本次页面内不再显示', async () => {
    batches = [batch(), batch({ id: 2, code: 'B-2026-02', name: '第二批次' })]
    rows.push({ ...question(9, 1, 'published', 2), content: '第二批次专属题目' })
    generations[1] = generationFailed(TIMEOUT_REASON)
    const api = backend()
    renderPage(<BatchesPage pollIntervalMs={20} />)
    const alert = await generationNotice(/^最近一次题目生成没有完成（2026-09-29 \d{2}:\d{2}）$/)
    expect(alert).toHaveTextContent(`原因：${TIMEOUT_REASON}。本次没有保存任何题目，可以重新生成。`)
    expect(screen.getByRole('button', { name: /AI生成新版本/ })).toBeEnabled()
    expect(screen.queryByText(/^正在生成题目/)).not.toBeInTheDocument()

    fireEvent.click(within(alert).getByRole('button', { name: '关闭提示' }))
    await waitFor(() => expect(screen.queryByText(/^最近一次题目生成没有完成/)).not.toBeInTheDocument())
    // 切换到其他批次再回来，已经关闭的提示不再出现。
    fireEvent.click(screen.getByText('B-2026-02'))
    expect(await screen.findByText('第二批次专属题目')).toBeInTheDocument()
    fireEvent.click(screen.getByText('B-2026-01'))
    expect(await screen.findByText('共 4 套题目版本 · 当前启用 v1')).toBeInTheDocument()
    await waitFor(() => expect(api.requests('GET', GENERATION_PATH)).toHaveLength(2))
    await pause(100)
    expect(screen.queryByText(/^最近一次题目生成没有完成/)).not.toBeInTheDocument()
    // 不轮询没有进行中生成的批次。
    expect(api.requests('GET', GENERATION_PATH)).toHaveLength(2)

    // 之后又有一次失败时，照常提示。
    generations[1] = generationFailed('AI服务返回异常，请稍后重试', 'op-2')
    fireEvent.click(screen.getByText('B-2026-02'))
    expect(await screen.findByText('第二批次专属题目')).toBeInTheDocument()
    fireEvent.click(screen.getByText('B-2026-01'))
    expect(await generationNotice(/^最近一次题目生成没有完成/)).toHaveTextContent('原因：AI服务返回异常，请稍后重试。')
    expect(api.unexpected).toEqual([])
  })

  it('生成失败时在弹窗和题目卡片说明原因，可以重新生成', async () => {
    const api = backend(acceptGeneration('正在生成第 1 至 6 道（共 6 道）'))
    renderPage(<BatchesPage pollIntervalMs={20} />)
    const dialog = await openGenerateDialog()
    fireEvent.click(dialog.getByRole('button', { name: '生成草稿' }))
    await dialog.findByRole('button', { name: '在后台继续' })

    generations[1] = generationFailed(TIMEOUT_REASON)
    expect(await dialog.findByText('题目没有生成')).toBeInTheDocument()
    expect(dialog.getByText(`原因：${TIMEOUT_REASON}。本次没有保存任何题目，可以重新生成。`)).toBeInTheDocument()
    expect(dialog.queryByRole('status')).not.toBeInTheDocument()
    await waitFor(() => expect(dialog.getByRole('spinbutton', { name: '主体题数量' })).toBeEnabled())
    expect(await generationNotice(/^最近一次题目生成没有完成/)).toHaveTextContent(`原因：${TIMEOUT_REASON}。`)
    // 失败时不保存不完整的题目版本，列表不变。
    expect(screen.getByText('共 4 套题目版本 · 当前启用 v1')).toBeInTheDocument()

    fireEvent.click(dialog.getByRole('button', { name: '生成草稿' }))
    await waitFor(() => expect(api.writes()).toHaveLength(2))
    await dialog.findByRole('button', { name: '在后台继续' })
    expect(dialog.queryByText('题目没有生成')).not.toBeInTheDocument()
    expect(screen.queryByText(/^最近一次题目生成没有完成/)).not.toBeInTheDocument()
    rows.push(question(6, 5, 'draft'))
    generations[1] = generationCompleted(5, 1, 'op-2')
    expect(await screen.findByRole('tab', { name: /v5.*草稿/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/v5 生成完成，共 1 道题/)).toBeInTheDocument()
    expect(api.unexpected).toEqual([])
  })

  it('同批次已有生成在进行时不能再次发起，改为显示进行中的生成', async () => {
    const api = backend(call => {
      if (call.method !== 'POST' || call.path !== '/batches/1/questions/generate') return undefined
      // 打开页面之后，同事已经发起了生成。
      generations[1] = generationRunning('已生成 6 / 12 道', { count: 12, started_by: 'hr_li', elapsed_seconds: 60 }, 'op-colleague')
      return httpError(409, '该批次正在生成题目，请等待完成')
    })
    renderPage(<BatchesPage pollIntervalMs={20} />)
    const dialog = await openGenerateDialog()
    fireEvent.click(dialog.getByRole('button', { name: '生成草稿' }))
    expect(await dialog.findByText('没有开始生成')).toBeInTheDocument()
    expect(dialog.getByText('该批次正在生成题目，请等待完成')).toBeInTheDocument()
    const progress = await dialog.findByRole('status')
    expect(progress).toHaveTextContent('已生成 6 / 12 道')
    expect(progress).toHaveTextContent('由 hr_li 发起，共 12 道')
    expect(dialog.queryByRole('button', { name: '生成草稿' })).not.toBeInTheDocument()
    expect(api.writes()).toHaveLength(1)
    fireEvent.click(dialog.getByRole('button', { name: '在后台继续' }))
    expect(await generationNotice(/^正在生成题目：已生成 6 \/ 12 道/)).toHaveTextContent('由 hr_li 发起')
  })

  it('生成进行中可以切换查看其他批次，回到原批次时给出期间完成的结果', async () => {
    batches = [batch(), batch({ id: 2, code: 'B-2026-02', name: '第二批次' })]
    rows.push({ ...question(9, 1, 'published', 2), content: '第二批次专属题目' })
    generations[1] = generationRunning('已生成 6 / 12 道', { count: 12 })
    const api = backend()
    renderPage(<BatchesPage pollIntervalMs={20} />)
    await generationNotice(/^正在生成题目：已生成 6 \/ 12 道/)

    fireEvent.click(screen.getByText('B-2026-02'))
    expect(await screen.findByText('第二批次专属题目')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText(/^正在生成题目/)).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: /AI生成新版本/ })).toBeEnabled()
    expect(api.requests('GET', '/batches/2/questions/generation')).toHaveLength(1)
    // 离开后不再查询原批次的进度。
    await pause(100)
    const queried = api.requests('GET', GENERATION_PATH).length
    await pause(200)
    expect(api.requests('GET', GENERATION_PATH)).toHaveLength(queried)

    rows.push(question(6, 5, 'draft'))
    generations[1] = generationCompleted(5, 1)
    fireEvent.click(screen.getByText('B-2026-01'))
    expect(await screen.findByRole('tab', { name: /v5.*草稿/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/v5 生成完成，共 1 道题/)).toBeInTheDocument()
    expect(screen.queryByText(/^正在生成题目/)).not.toBeInTheDocument()
    expect(api.unexpected).toEqual([])
  })

  it('查询进度暂时失败时如实提示并继续查询', async () => {
    generations[1] = generationRunning('已生成 6 / 12 道', { count: 12 })
    let unreachable = false
    backend(call => unreachable && call.path === GENERATION_PATH ? httpError(503, '服务暂不可用') : undefined)
    renderPage(<BatchesPage pollIntervalMs={20} />)
    const notice = await generationNotice(/^正在生成题目：已生成 6 \/ 12 道/)
    unreachable = true
    await waitFor(() => expect(notice).toHaveTextContent('暂时读取不到最新进度，页面会继续查询；已发起的生成不受影响。'))
    expect(screen.getByRole('button', { name: /AI生成新版本/ })).toBeDisabled()
    unreachable = false
    await waitFor(() => expect(notice).toHaveTextContent('可以离开本页，生成完成后在这里查看。'))
    expect(notice).not.toHaveTextContent('暂时读取不到最新进度')
  })

  it('查不到本次生成的结果时如实说明，并刷新题目列表', async () => {
    const unconfirmed = '未能确认本次生成的结果，请查看题目列表；如果没有新版本，可以重新生成。'
    const api = backend(acceptGeneration('正在生成第 1 至 6 道（共 6 道）'))
    renderPage(<BatchesPage pollIntervalMs={20} />)
    const dialog = await openGenerateDialog()
    fireEvent.click(dialog.getByRole('button', { name: '生成草稿' }))
    await dialog.findByRole('button', { name: '在后台继续' })
    const loaded = api.requests('GET', '/questions?batch_id=1').length
    // 服务重启后，进行中的状态不再保留。
    generations[1] = { running: false }
    expect(await dialog.findByText('未能确认生成结果')).toBeInTheDocument()
    expect(dialog.getByText(unconfirmed)).toBeInTheDocument()
    expect(dialog.queryByRole('status')).not.toBeInTheDocument()
    expect(dialog.getByRole('button', { name: '生成草稿' })).toBeEnabled()
    await waitFor(() => expect(api.requests('GET', '/questions?batch_id=1').length).toBeGreaterThan(loaded))
    expect(screen.queryByText(/生成完成/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^最近一次题目生成没有完成/)).not.toBeInTheDocument()

    // 关闭弹窗后，题目卡片上保留这条说明，关闭后不再显示。
    fireEvent.click(dialog.getByRole('button', { name: /取\s*消/ }))
    await waitFor(() => expect(screen.queryByText('AI生成主体题')).not.toBeInTheDocument())
    const notice = await generationNotice(/^未能确认生成结果$/)
    expect(notice).toHaveTextContent(unconfirmed)
    expect(screen.getByRole('button', { name: /AI生成新版本/ })).toBeEnabled()
    fireEvent.click(within(notice).getByRole('button', { name: '关闭提示' }))
    await waitFor(() => expect(screen.queryByText('未能确认生成结果')).not.toBeInTheDocument())
  })
})

describe('招聘批次', () => {
  async function openCreateForm() {
    renderPage(<BatchesPage />)
    fireEvent.click(await screen.findByRole('button', { name: /创建批次/ }))
    const dialog = await findDialog('创建招聘批次')
    fireEvent.change(dialog.getByLabelText('批次编号'), { target: { value: '2026-D04' } })
    fireEvent.change(dialog.getByLabelText('批次名称'), { target: { value: '质量检验岗社招' } })
    fireEvent.mouseDown(dialog.getByLabelText('招聘类型'))
    await chooseOption('校园招聘')
    return dialog
  }

  it('岗位从岗位库选择，创建时提交岗位库编号和面试方式', async () => {
    const api = backend(call => call.method === 'POST' && call.path === '/batches' ? batch({ id: 9, code: '2026-D04', mode: 'listening_only' }) : undefined)
    const dialog = await openCreateForm()
    expect(api.requests('GET', '/library/jobs')).toHaveLength(1)
    expect(api.calls.some(call => call.path === '/jobs')).toBe(false)
    fireEvent.mouseDown(dialog.getByLabelText('岗位'))
    await chooseOption('制造工艺岗 · 生产序列 · P3')
    expect(await dialog.findByText('已确认')).toBeInTheDocument()
    expect(dialog.queryByText(/暂时不能生成题目/)).not.toBeInTheDocument()
    expect(dialog.getByRole('link', { name: '岗位库' })).toHaveAttribute('href', '/library/jobs')
    fireEvent.click(dialog.getByRole('radio', { name: /仅人工面试旁听/ }))
    fireEvent.click(dialog.getByRole('button', { name: /创\s*建/ }))
    await waitFor(() => expect(api.requests('POST', '/batches')).toHaveLength(1))
    expect(api.requests('POST', '/batches')[0].body).toEqual({
      code: '2026-D04', name: '质量检验岗社招', recruitment_type: '校园招聘', library_job_id: 'job-brew', mode: 'listening_only',
    })
    await waitFor(() => expect(screen.queryByText('创建招聘批次')).not.toBeInTheDocument())
  })

  it('岗位的面试评价标准未确认时提示不能生成题目，并指向岗位库', async () => {
    backend()
    const dialog = await openCreateForm()
    fireEvent.mouseDown(dialog.getByLabelText('岗位'))
    await chooseOption('质量检验岗 · 质量序列 · P2')
    expect(await dialog.findByText('该岗位的面试评价标准尚未确认，暂时不能生成题目')).toBeInTheDocument()
    expect(dialog.getByText('未配置')).toBeInTheDocument()
    // 提示中的链接直接打开该岗位的面试评价标准。
    expect(dialog.getAllByRole('link', { name: '岗位库' }).map(link => link.getAttribute('href'))).toEqual(['/library/jobs', '/library/jobs?job=job-qa&tab=standard'])
    // 仅人工面试旁听不需要题目，不再提示。
    fireEvent.click(dialog.getByRole('radio', { name: /仅人工面试旁听/ }))
    await waitFor(() => expect(dialog.queryByText(/暂时不能生成题目/)).not.toBeInTheDocument())
  })

  it('批次关联岗位的评价标准未确认时，题目区提示并停用AI生成', async () => {
    rows = []
    batches = [batch({ job_audit_status: 'draft', status: 'draft', question_version: 0 })]
    backend()
    renderPage(<BatchesPage />)
    expect(await screen.findByText('该岗位的面试评价标准尚未确认，暂时不能生成题目')).toBeVisible()
    expect(screen.getByRole('link', { name: '岗位库' })).toHaveAttribute('href', '/library/jobs?job=job-brew&tab=standard')
    expect(screen.getByRole('button', { name: /AI生成新版本/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /手动新增题目/ })).toBeEnabled()
    expect(screen.queryByText('现场面试入口')).not.toBeInTheDocument()
  })

  it('仅人工面试旁听的批次不显示题目，给出说明和去向', async () => {
    batches = [batch({ id: 3, code: 'B-LISTEN', mode: 'listening_only', mode_label: '仅人工面试旁听', question_version: 0 })]
    const api = backend()
    renderPage(<BatchesPage />)
    expect(await screen.findByText('本批次仅做人工面试旁听')).toBeVisible()
    expect(screen.getByText(/不需要题目，候选人无需登录，也不进行AI面试/)).toBeVisible()
    expect(screen.getByRole('link', { name: '前往候选人管理' })).toHaveAttribute('href', '/ai-interview/candidates?batch=3')
    expect(screen.getByRole('link', { name: '前往AI旁听' })).toHaveAttribute('href', '/ai-interview/listening?batch=3')
    expect(screen.queryByRole('button', { name: /AI生成新版本/ })).not.toBeInTheDocument()
    expect(screen.queryByText('现场面试入口')).not.toBeInTheDocument()
    expect(api.calls.some(call => call.path.startsWith('/questions'))).toBe(false)
    expect(api.calls.some(call => call.path.includes('/questions/generation'))).toBe(false)
    expect(api.calls.some(call => call.path.includes('onsite-entries'))).toBe(false)
  })

  it('编辑已有候选人的批次时不能更换岗位和面试方式', async () => {
    const api = backend(call => call.method === 'PUT' ? { ok: true, ...batch({ name: '第一批次（改）' }) } : undefined)
    renderPage(<BatchesPage />)
    await screen.findByText('B-2026-01')
    fireEvent.click(within(document.querySelector('.batch-item') as HTMLElement).getByRole('button', { name: /编辑/ }))
    const dialog = await findDialog('编辑招聘批次')
    expect(dialog.getByLabelText('岗位')).toBeDisabled()
    expect(dialog.getByText('批次已有题目或候选人，不能更换岗位。')).toBeInTheDocument()
    expect(dialog.getByRole('radio', { name: /仅人工面试旁听/ })).toBeDisabled()
    fireEvent.change(dialog.getByLabelText('批次名称'), { target: { value: '第一批次（改）' } })
    fireEvent.click(dialog.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(api.requests('PUT', '/batches/1')).toHaveLength(1))
    expect(api.requests('PUT', '/batches/1')[0].body).toEqual({
      code: 'B-2026-01', name: '第一批次（改）', recruitment_type: '社会招聘', library_job_id: 'job-brew', mode: 'ai_interview',
    })
  })
})

describe('现场面试入口', () => {
  const entry = (overrides: Record<string, unknown>) => ({
    id: 1, batch_id: 1, created_by: 'hr_wang', consent_attested: false, notice_version: 'CONSENT-1.0',
    created_at: '2026-09-27T01:00:00', expires_at: '2026-09-27T09:00:00', revoked_at: null, active: false, ...overrides,
  })
  const onsiteCard = async () => within((await screen.findByText('现场面试入口')).closest('.ant-card') as HTMLElement)

  it('列出入口状态；给另一台设备生成入口链接时提交现场告知确认，链接只显示一次', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    entries = [entry({ id: 1 }), entry({ id: 2, created_by: 'hr_li', revoked_at: '2026-09-27T03:00:00', consent_attested: true })]
    const api = backend(call => {
      if (call.method !== 'POST' || call.path !== '/batches/1/onsite-entries') return undefined
      const created = entry({ id: 5, created_by: 'tester', consent_attested: true, expires_at: '2099-01-01T08:00:00', active: true })
      entries = [created, ...entries]
      return { ...created, entry_token: 'payload-abc.signature_123', token_expires_at: 4102444800 }
    })
    renderPage(<BatchesPage />, { granted: permissions.hr })
    const card = await onsiteCard()
    expect(await card.findByText('已过期')).toBeInTheDocument()
    expect(card.getByText('已关闭')).toBeInTheDocument()
    expect(card.getByText('hr_li')).toBeInTheDocument()
    expect(card.getByText('是，候选人不再阅读合规须知')).toBeInTheDocument()
    expect(card.getByText('否，候选人在设备上阅读并同意')).toBeInTheDocument()
    expect(card.queryByRole('button', { name: /关闭入口/ })).not.toBeInTheDocument()

    fireEvent.click(card.getByRole('button', { name: /生成入口链接/ }))
    const form = await findDialog('生成入口链接 · 第一批次')
    expect(form.getByLabelText('有效时长（小时）')).toHaveValue('8')
    expect(form.getByText(/候选人在设备上不再阅读合规须知.*记录在您的名下/)).toBeInTheDocument()
    fireEvent.click(form.getByRole('checkbox', { name: '已在现场向候选人告知采集事项并取得同意' }))
    fireEvent.click(form.getByRole('button', { name: '生成链接' }))

    const link = `${window.location.origin}/interview/onsite#entry=payload-abc.signature_123`
    const result = await findDialog('入口链接已生成')
    expect(result.getByTestId('onsite-link')).toHaveTextContent(link)
    expect(result.getByText('入口链接只显示这一次')).toBeInTheDocument()
    expect(result.getByText(/请在现场面试设备的浏览器中打开这个链接/)).toBeInTheDocument()
    expect(api.requests('POST', '/batches/1/onsite-entries')[0].body).toEqual({ consent_attested: true, hours: 8 })
    fireEvent.click(result.getByRole('button', { name: /复制链接/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(link))

    fireEvent.click(result.getByRole('button', { name: '已保存，关闭' }))
    await waitFor(() => expect(screen.queryByTestId('onsite-link')).not.toBeInTheDocument())
    expect(screen.queryByText(/payload-abc/)).not.toBeInTheDocument()
    expect(await card.findByText('有效')).toBeInTheDocument()
    expect(api.requests('POST', /onsite-entries/)).toHaveLength(1)
    expect(api.unexpected).toEqual([])
  })

  it('现场设备就是这台时，在本机打开现场面试：沿用已开启的入口，在新窗口打开名单', async () => {
    const opened = { opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() }
    const open = vi.spyOn(window, 'open').mockReturnValue(opened as unknown as Window)
    const api = backend(call => call.method === 'POST' && call.path === '/batches/1/onsite-entries'
      ? { ...entry({ id: 9, active: true, consent_attested: true }), entry_token: 'entry-token.signature', reused: true }
      : undefined)
    try {
      renderPage(<BatchesPage />, { granted: permissions.hr })
      const card = await onsiteCard()
      expect(card.getByText(/现场设备就是这台时点“在本机打开现场面试”/)).toBeInTheDocument()
      fireEvent.click(card.getByRole('button', { name: /在本机打开现场面试/ }))
      const dialog = await findDialog('现场面试 · 第一批次')
      fireEvent.click(dialog.getByRole('checkbox', { name: '已在现场向候选人告知采集事项并取得同意' }))
      fireEvent.click(dialog.getByRole('button', { name: '进入现场面试' }))
      await waitFor(() => expect(opened.location.replace).toHaveBeenCalledWith(
        `${window.location.origin}/interview/onsite#entry=entry-token.signature`))
      expect(api.requests('POST', '/batches/1/onsite-entries')[0].body).toEqual({ consent_attested: true, hours: 8, reuse: true })
      expect(opened.opener).toBeNull()
      await waitFor(() => expect(screen.queryByText('现场面试 · 第一批次')).not.toBeInTheDocument())
    } finally {
      open.mockRestore()
    }
  })

  it('关闭入口需要确认', async () => {
    entries = [entry({ id: 7, expires_at: '2099-01-01T08:00:00', active: true })]
    const api = backend(call => {
      if (call.method !== 'DELETE') return undefined
      entries = [entry({ id: 7, revoked_at: '2026-09-28T02:00:00' })]
      return entries[0]
    })
    renderPage(<BatchesPage />, { granted: permissions.hr })
    const card = await onsiteCard()
    fireEvent.click(await card.findByRole('button', { name: '关闭入口' }))
    expect(api.writes()).toHaveLength(0)
    expect(await screen.findByText(/已经开始的面试不受影响/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认关闭' }))
    expect(await card.findByText('已关闭')).toBeInTheDocument()
    expect(api.writes().map(call => `${call.method} ${call.path}`)).toEqual(['DELETE /onsite-entries/7'])
  })
})

describe('按权限显示操作', () => {
  it('题目审核人只看到审核和发布，看不到批次维护、出题和现场入口', async () => {
    const api = backend()
    renderPage(<BatchesPage />, { granted: permissions.questionReviewer })
    expect(await screen.findByRole('button', { name: /一键审核/ })).toBeInTheDocument()
    for (const hidden of [/创建批次/, /AI生成新版本/, /手动新增题目/, /一键删除/, /编辑/, /删除/, /生成入口链接/, /在本机打开现场面试/]) {
      expect(screen.queryByRole('button', { name: hidden })).not.toBeInTheDocument()
    }
    expect(screen.queryByText('现场面试入口')).not.toBeInTheDocument()
    expect(api.calls.some(call => call.path.includes('onsite-entries') || call.path === '/dimensions')).toBe(false)
    const published = await openVersion(/v1.*当前启用/)
    expect(published.getByRole('button', { name: /停用/ })).toBeInTheDocument()
  })

  it('没有出题权限的人也能看到正在生成和失败原因', async () => {
    generations[1] = generationRunning('已生成 6 / 12 道', { count: 12, started_by: 'hr_li' })
    const api = backend()
    renderPage(<BatchesPage pollIntervalMs={20} />, { granted: permissions.questionReviewer })
    expect(await generationNotice(/^正在生成题目：已生成 6 \/ 12 道/)).toHaveTextContent('由 hr_li 发起，共 12 道')
    expect(screen.queryByRole('button', { name: /AI生成新版本/ })).not.toBeInTheDocument()
    generations[1] = generationFailed(TIMEOUT_REASON)
    const alert = await generationNotice(/^最近一次题目生成没有完成/)
    expect(alert).toHaveTextContent(`原因：${TIMEOUT_REASON}。本次没有保存任何题目。`)
    expect(alert).not.toHaveTextContent('可以重新生成')
    expect(api.writes()).toHaveLength(0)
  })

  it('HR 可以维护批次、出题和提交审核，看不到审核和发布', async () => {
    rows = [question(1, 1, 'published'), question(2, 2, 'pending_review'), question(3, 3, 'draft'), question(4, 4, 'approved')]
    backend()
    renderPage(<BatchesPage />, { granted: permissions.hr })
    expect(await screen.findByText('共 4 套题目版本 · 当前启用 v1')).toBeInTheDocument()
    for (const visible of [/创建批次/, /AI生成新版本/, /手动新增题目/, /生成入口链接/, /在本机打开现场面试/]) {
      expect(screen.getByRole('button', { name: visible })).toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: /发布本版本/ })).not.toBeInTheDocument()
    const pending = await openVersion(/v2.*待审核 1/)
    expect(pending.getByText('测试题目 2')).toBeInTheDocument()
    expect(pending.queryByRole('button', { name: /审核/ })).not.toBeInTheDocument()
    const draft = await openVersion(/v3.*草稿/)
    expect(draft.getByRole('button', { name: /提交本版本审核/ })).toBeInTheDocument()
    const published = await openVersion(/v1.*当前启用/)
    expect(published.getByText('测试题目 1')).toBeInTheDocument()
    expect(published.queryByRole('button', { name: /停用/ })).not.toBeInTheDocument()
  })
})
