import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ReportsPage from '../pages/interview/ReportsPage'
import { activePane, batch, chooseOption, findDialog, permissions, quietComputedStyle, renderPage, stubApi, stubDownloads, type Call } from './interview-helpers'
import { ANALYSIS, comprehensive, comprehensiveContent, EXCERPT, report } from './report-fixtures'

let items: Array<ReturnType<typeof comprehensive>>

function backend(extra?: (call: Call) => unknown) {
  return stubApi(call => {
    const custom = extra?.(call)
    if (custom !== undefined) return custom
    if (call.method !== 'GET') return undefined
    if (call.path === '/batches') return [batch(), batch({ id: 2, code: 'B-LISTEN', name: '旁听批次', mode: 'listening_only', question_version: 0 })]
    const notice = '综合报告汇总AI面试（如有）与人工面试AI旁听信息，仅供人工评估，不构成自动录用或淘汰决定。'
    if (call.path === '/comprehensive-reports') return { notice, items: structuredClone(items) }
    const filtered = call.path.match(/^\/comprehensive-reports\?batch_id=(\d+)$/)
    if (filtered) return { notice, items: structuredClone(items.filter(item => item.batch.id === Number(filtered[1]))) }
    if (call.path === '/reports' || call.path.startsWith('/reports?')) return [report({ status: 'confirmed' })]
    return undefined
  })
}

const rowOf = (name: string) => within(activePane().getByText(name).closest('tr') as HTMLElement)
const location = () => screen.getByTestId('location').textContent

beforeEach(() => {
  quietComputedStyle()
  items = [comprehensive('linked'), comprehensive('standalone')]
})
afterEach(() => vi.restoreAllMocks())

describe('综合报告页签', () => {
  it('地址栏 type=comprehensive 选中综合报告；列表标明关联AI面试或仅人工面试，不再包含候选人对比', async () => {
    const api = backend()
    renderPage(<ReportsPage />, { granted: permissions.reportReviewer, entry: '/?type=comprehensive' })
    expect(await screen.findByText('李四')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '综合报告' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'AI面试报告' })).toHaveAttribute('aria-selected', 'false')
    expect(api.requests('GET', '/comprehensive-reports')).toHaveLength(1)
    expect(api.calls.some(call => call.path.startsWith('/reports') || call.path.startsWith('/comparison') || call.path === '/jobs')).toBe(false)

    expect(rowOf('张三').getByText('关联AI面试')).toBeInTheDocument()
    expect(rowOf('张三').getByText('82%')).toBeInTheDocument()
    expect(rowOf('李四').getByText('仅人工面试')).toBeInTheDocument()
    expect(rowOf('李四').getByText('—')).toBeInTheDocument()
    expect(rowOf('李四').getByText('待人工复核')).toBeInTheDocument()
    expect(screen.getByText(/综合报告汇总AI面试（如有）与人工面试AI旁听信息/)).toBeInTheDocument()
    expect(screen.queryByText(/候选人对比/)).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: /对比候选人/ })).not.toBeInTheDocument()
    expect(document.querySelector('.recharts-responsive-container')).toBeNull()
    expect(api.unexpected).toEqual([])
  })

  it('两个页签共用批次筛选', async () => {
    const api = backend()
    renderPage(<ReportsPage />, { granted: permissions.reportReviewer, entry: '/?type=comprehensive' })
    await screen.findByText('李四')
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '按批次筛选报告' }))
    await chooseOption('旁听批次 · 制造工艺岗（仅人工面试旁听）')
    await waitFor(() => expect(activePane().queryByText('张三')).not.toBeInTheDocument())
    expect(activePane().getByText('李四')).toBeInTheDocument()
    expect(api.requests('GET', '/comprehensive-reports?batch_id=2')).toHaveLength(1)
    expect(location()).toBe('/?type=comprehensive&batch=2')

    fireEvent.click(screen.getByRole('tab', { name: 'AI面试报告' }))
    await waitFor(() => expect(api.requests('GET', '/reports?batch_id=2')).toHaveLength(1))
    expect(location()).toBe('/?batch=2')
  })
})

describe('综合报告详情', () => {
  it('仅人工面试：没有AI面试内容，完整显示分析和原文引用，硬指标单独展示', async () => {
    backend()
    renderPage(<ReportsPage />, { granted: permissions.reportReviewer, entry: '/?type=comprehensive&candidate=3' })
    const drawer = await findDialog('李四 · 综合报告')
    expect(drawer.getAllByText('仅人工面试').length).toBeGreaterThan(0)
    expect(drawer.getByText('候选人未做AI面试，依据简历、岗位要求和人工面试的旁听记录，不含量化评分。')).toBeInTheDocument()
    expect(drawer.queryByText('第一阶段 · AI面试')).not.toBeInTheDocument()
    expect(drawer.queryByRole('button', { name: /查看AI面试报告/ })).not.toBeInTheDocument()

    expect(drawer.getByText(ANALYSIS)).toHaveClass('evidence-text')
    expect(drawer.getByText('新增证据待复核')).toBeInTheDocument()
    expect(drawer.getByText('人工面试回答原文')).toBeInTheDocument()
    expect(drawer.getByText('我先隔离了异常批次')).toHaveClass('evidence-quote')
    expect(drawer.getByText('负责质量管理')).toHaveClass('evidence-quote')
    expect(drawer.queryByText('AI面试报告原文')).not.toBeInTheDocument()

    expect(drawer.getByText('人工面试证据（2 段）')).toBeInTheDocument()
    expect(drawer.getByText('面试官')).toBeInTheDocument()
    expect(drawer.getByText('请讲一次你处理质量异常的经历。')).toHaveClass('evidence-text')
    expect(drawer.getByText('复检之后你做了哪些改进？')).toBeInTheDocument()
    expect(drawer.getByText('本场没有第一阶段评分，综合分析不含量化评分，须由考官结合现场情况评价')).toHaveClass('evidence-text')
    const hard = within(drawer.getByText('硬指标（与面试评价分开，不计入评分）').closest('.ant-card') as HTMLElement)
    expect(hard.getByText('本科及以上学历')).toBeInTheDocument()
    expect(hard.getByText(/是否计入评分及具体规则待人力资源部确认/)).toBeInTheDocument()
  })

  it('关联AI面试：显示第一阶段纪要和评价，可以转到对应的AI面试报告', async () => {
    const api = backend()
    renderPage(<ReportsPage />, { granted: permissions.reportReviewer, entry: '/?type=comprehensive&candidate=2' })
    const drawer = await findDialog('张三 · 综合报告')
    const stage = within(drawer.getByText('第一阶段 · AI面试').closest('.ant-card') as HTMLElement)
    expect(stage.getByText('候选人能够结合质量异常案例说明处置过程。')).toBeInTheDocument()
    expect(stage.getByText('4 / 5')).toBeInTheDocument()
    expect(drawer.getByText('AI面试报告原文')).toBeInTheDocument()
    fireEvent.click(stage.getByRole('button', { name: /查看AI面试报告/ }))
    const reportDrawer = await findDialog('张三 · AI面试报告')
    expect(reportDrawer.getByText('六维评价（软性评价）')).toBeInTheDocument()
    expect(location()).toBe('/?report=10')
    expect(screen.getByRole('tab', { name: 'AI面试报告' })).toHaveAttribute('aria-selected', 'true')
    expect(api.requests('GET', '/reports')).toHaveLength(1)
  })

  it('人工修改须填写原因；人工确认后才能导出，已确认的不能再修改', async () => {
    const downloads = stubDownloads()
    const api = backend(call => {
      if (call.path === '/listening/3/report/export') return new Response(new Blob(['docx']))
      if (call.method === 'PUT' && call.path === '/listening/3/report') {
        const content = (call.body as { content: ReturnType<typeof comprehensiveContent> }).content
        items = [comprehensive('linked'), comprehensive('standalone', { current_version: 2, content, versions: [...comprehensive('standalone').versions, { version: 2, version_type: 'human_edit', editor: 'tester', reason: '补充核实结论', created_at: '2026-09-28T01:00:00+00:00', content }] })]
        return { session_id: 32, candidate_id: 3, status: 'pending_review', current_version: 2, current_content: content, versions: [] }
      }
      if (call.method === 'POST' && call.path === '/listening/3/report/confirm') {
        items = items.map(item => item.candidate.id === 3 ? { ...item, status: 'confirmed' } : item)
        return { ok: true, status: 'confirmed' }
      }
      return undefined
    })
    renderPage(<ReportsPage />, { granted: permissions.reportReviewer, entry: '/?type=comprehensive&candidate=3' })
    const drawer = await findDialog('李四 · 综合报告')
    expect(drawer.queryByRole('button', { name: /导出 Word/ })).not.toBeInTheDocument()

    fireEvent.click(drawer.getByRole('button', { name: /人工修改/ }))
    const editor = await findDialog('人工修改综合报告')
    expect(editor.queryByLabelText('第一阶段AI面试纪要')).not.toBeInTheDocument()
    fireEvent.change(editor.getByLabelText('岗位专业能力综合分析'), { target: { value: '经核对录音，候选人说明了复检后的改进措施。' } })
    fireEvent.click(editor.getByRole('button', { name: '保存人工版本' }))
    expect(await editor.findByText('请填写至少2个字的修改原因')).toBeInTheDocument()
    expect(api.writes()).toHaveLength(0)
    fireEvent.change(editor.getByLabelText('修改原因'), { target: { value: '补充核实结论' } })
    fireEvent.click(editor.getByRole('button', { name: '保存人工版本' }))
    expect(await drawer.findByText('人工修改版本已保存')).toBeInTheDocument()
    const saved = api.requests('PUT', '/listening/3/report')[0].body as { reason: string; content: ReturnType<typeof comprehensiveContent> }
    expect(saved.reason).toBe('补充核实结论')
    expect(saved.content.findings[0]).toMatchObject({ analysis: '经核对录音，候选人说明了复检后的改进措施。', answer_excerpt: '我先隔离了异常批次' })
    expect(saved.content.mode).toBe('standalone')
    expect(saved.content.stage_two_evidence).toHaveLength(2)
    expect(await drawer.findByText('经核对录音，候选人说明了复检后的改进措施。')).toBeInTheDocument()

    fireEvent.click(drawer.getByRole('button', { name: /人工确认/ }))
    const modal = await findDialog('人工确认报告')
    fireEvent.change(modal.getByLabelText('处理原因'), { target: { value: '已核对录音和转写' } })
    fireEvent.click(modal.getByRole('button', { name: '确认并允许导出' }))
    expect(await drawer.findByText('综合报告已人工确认，可以导出')).toBeInTheDocument()
    expect(api.requests('POST', '/listening/3/report/confirm')[0].body).toEqual({ reason: '已核对录音和转写' })
    await waitFor(() => expect(drawer.queryByRole('button', { name: /人工修改/ })).not.toBeInTheDocument())
    expect(drawer.queryByRole('button', { name: /人工确认/ })).not.toBeInTheDocument()
    expect(drawer.getByText('已确认的综合报告不能直接修改；如需修改请先退回。')).toBeInTheDocument()
    fireEvent.click(drawer.getByRole('button', { name: /导出 Word/ }))
    await waitFor(() => expect(api.requests('GET', '/listening/3/report/export')).toHaveLength(1))
    expect(downloads.names).toEqual(['李四_综合报告.docx'])
  })

  it('只有查看权限时不显示复核和导出操作', async () => {
    items = [comprehensive('standalone', { status: 'confirmed' })]
    backend()
    renderPage(<ReportsPage />, { granted: ['report:read'], entry: '/?type=comprehensive&candidate=3' })
    const drawer = await findDialog('李四 · 综合报告')
    expect(drawer.getByText(ANALYSIS)).toBeInTheDocument()
    for (const action of [/人工修改/, /退回/, /人工确认/, /导出 Word/]) {
      expect(screen.queryByRole('button', { name: action })).not.toBeInTheDocument()
    }
  })
})

describe('综合报告：按发言人显示证据与重新生成', () => {
  const QUESTION = '请讲一次你处理质量异常的经历。'
  const dialogue = {
    id: 'cap-3', speaker: 'dialogue', text: QUESTION + EXCERPT,
    turns: [{ role: 'interviewer', basis: 'inferred', text: QUESTION }, { role: 'candidate', basis: 'confirmed', text: EXCERPT }],
  }
  const preserved = (overrides: Record<string, unknown> = {}) => {
    const content = comprehensiveContent('standalone', {
      generation_mode: '证据保全降级', generation_note: 'AI服务响应超时，请稍后重试', stage_two_evidence: [dialogue],
      findings: [{ dimension: '岗位专业能力', status: '新增证据待复核', analysis: '文本模型暂未返回结构化结果，已保全原文证据；请人工核实后补充结论。', stage_one_excerpt: '', capture_id: 'cap-3', answer_excerpt: EXCERPT, resume_excerpt: '', speaker_basis: '面试官已确认这段话是候选人说的。' }],
    })
    return comprehensive('standalone', { content, versions: [{ version: 1, version_type: 'ai_original', editor: 'AI面试智能体', reason: 'AI原始生成', created_at: '2026-09-29T03:00:00+00:00', content }], ...overrides })
  }

  it('连续对话按面试官和候选人逐段显示，标明是推断还是已确认', async () => {
    items = [preserved()]
    backend()
    renderPage(<ReportsPage />, { granted: permissions.reportReviewer, entry: '/?type=comprehensive&candidate=3' })
    const drawer = await findDialog('李四 · 综合报告')
    const evidence = within(drawer.getByText('人工面试证据（1 段）').closest('.ant-card') as HTMLElement)
    const lines = Array.from((drawer.getByText('人工面试证据（1 段）').closest('.ant-card') as HTMLElement).querySelectorAll('.interview-transcript-line'))
    expect(lines.map(line => line.textContent)).toEqual([`面试官推断${QUESTION}`, `候选人已确认${EXCERPT}`])
    expect(evidence.getByText(/连续对话由系统按对话语境区分发言人。标为“推断”的是系统的判断，请核对录音/)).toBeInTheDocument()
    expect(evidence.queryByText('混合对话')).not.toBeInTheDocument()
    expect(drawer.getByText('面试官已确认这段话是候选人说的。')).toHaveClass('evidence-quote')
  })

  it('只保全了原文证据的报告说明原因；确认后重新生成，期间不能复核，生成后显示新版本', async () => {
    items = [preserved()]
    const api = backend(call => {
      if (call.method !== 'POST' || call.path !== '/listening/3/report/regenerate') return undefined
      items = [preserved({ status: 'generating' })]
      return { status: 'generating', operation: { id: 'op-1', status: 'running' } }
    })
    renderPage(<ReportsPage pollIntervalMs={30} />, { granted: permissions.reportReviewer, entry: '/?type=comprehensive&candidate=3' })
    const drawer = await findDialog('李四 · 综合报告')
    expect(drawer.getByText('这份报告没有得到模型的分析结果，只保全了原文证据（原因：AI服务响应超时，请稍后重试）。请重新生成，或由人工补充核实后再确认。')).toBeInTheDocument()

    fireEvent.click(drawer.getByRole('button', { name: /重新生成/ }))
    expect(await screen.findByText('重新生成综合报告？')).toBeInTheDocument()
    expect(api.writes()).toHaveLength(0)
    fireEvent.click(document.querySelector('.ant-popconfirm .ant-btn-primary') as HTMLElement)
    expect(await drawer.findByText('已开始重新生成')).toBeInTheDocument()
    expect(api.writes().map(call => `${call.method} ${call.path}`)).toEqual(['POST /listening/3/report/regenerate'])
    expect(await drawer.findByText('综合报告正在重新生成')).toBeInTheDocument()
    for (const action of [/重新生成/, /人工修改/, /退回/, /人工确认/]) {
      expect(drawer.queryByRole('button', { name: action })).not.toBeInTheDocument()
    }

    const content = comprehensiveContent('standalone', { stage_two_evidence: [dialogue] })
    items = [comprehensive('standalone', {
      current_version: 2, content,
      versions: [...preserved().versions, { version: 2, version_type: 'ai_original', editor: 'AI面试智能体', reason: 'AI重新生成（tester 发起）', created_at: '2026-09-29T03:05:00+00:00', content }],
    })]
    expect(await drawer.findByText(ANALYSIS)).toBeInTheDocument()
    await waitFor(() => expect(drawer.queryByText('综合报告正在重新生成')).not.toBeInTheDocument())
    expect(drawer.queryByText(/只保全了原文证据/)).not.toBeInTheDocument()
    expect(drawer.getByRole('button', { name: /人工确认/ })).toBeInTheDocument()
    // 模型已经给出分析的报告不再提供重新生成。
    expect(drawer.queryByRole('button', { name: /重新生成/ })).not.toBeInTheDocument()
    expect(drawer.getByRole('tab', { name: '版本记录 (2)' })).toBeInTheDocument()
    // 生成结束后不再定时读取。
    const settled = api.requests('GET', '/comprehensive-reports').length
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(api.requests('GET', '/comprehensive-reports').length).toBe(settled)
  })

  it('人工修改过、已确认的报告，以及没有权限的人，不提供重新生成', async () => {
    const edited = [...preserved().versions, { version: 2, version_type: 'human_edit', editor: 'tester', reason: '补充结论', created_at: '2026-09-29T04:00:00+00:00', content: preserved().content }]
    for (const [item, granted] of [
      [preserved({ versions: edited, current_version: 2 }), permissions.reportReviewer],
      [preserved({ status: 'confirmed' }), permissions.reportReviewer],
      [preserved(), ['report:read']],
    ] as const) {
      items = [item]
      backend()
      const view = renderPage(<ReportsPage />, { granted: [...granted], entry: '/?type=comprehensive&candidate=3' })
      const drawer = await findDialog('李四 · 综合报告')
      expect(drawer.getByText(/只保全了原文证据（原因：AI服务响应超时，请稍后重试）/)).toBeInTheDocument()
      expect(drawer.queryByRole('button', { name: /重新生成/ })).not.toBeInTheDocument()
      view.unmount()
      vi.restoreAllMocks()
      quietComputedStyle()
    }
  })
})
