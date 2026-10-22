import '@ant-design/v5-patch-for-react-19'
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { message } from 'antd'
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadAudioAsMp3 } from '../audioExport'
import ListeningPage from '../pages/interview/ListeningPage'
import { startSpeech } from '../speech'
import type { Session } from '../types'
import {
  batches, candidatesByBatch, interviewer, linkedState, NOTICE_VERSION, ONSITE_METHOD, preparedQuestions, standaloneState,
} from './listening-fixtures'
import { requestsTo, stubServer } from './stub-server'

vi.mock('../speech', () => ({ startSpeech: vi.fn() }))
vi.mock('../audioExport', () => ({ downloadAudioAsMp3: vi.fn() }))
vi.setConfig({ testTimeout: 60_000 })
configure({ asyncUtilTimeout: 15_000 })

const ATTESTATION = '已当面向候选人告知采集事项并取得同意'
const mediaDevices = navigator.mediaDevices
let trackStop: ReturnType<typeof vi.fn>

beforeEach(() => {
  trackStop = vi.fn()
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: trackStop }] }) },
  })
})
afterEach(async () => {
  await act(async () => { message.destroy() })
  vi.restoreAllMocks()
  vi.mocked(startSpeech).mockReset()
  vi.mocked(downloadAudioAsMp3).mockReset()
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices })
})

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname + location.search}</output>
}

function renderPage(entry = '/ai-interview/listening', session: Session = interviewer, pollIntervalMs?: number) {
  const Layout = () => <><Where /><Outlet context={{ session }} /></>
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/ai-interview/listening" element={<ListeningPage pollIntervalMs={pollIntervalMs} />} />
          <Route path="/ai-interview/reports" element={<div>综合报告页面</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

// 页面内容较多，按文字和标签查找（按角色查找要遍历整页计算名称，明显更慢）。
const inButton = { selector: 'button span' }
const button = (text: string, scope: HTMLElement = document.body) => within(scope).getByText(text, inButton).closest('button') as HTMLButtonElement
const findButton = async (text: string) => (await screen.findByText(text, inButton)).closest('button') as HTMLButtonElement
const queryButton = (text: string, scope: HTMLElement = document.body) => within(scope).queryByText(text, inButton)
const heading = (name: string) => screen.findByText(name, { selector: 'h3' })
const cardOf = (element: HTMLElement) => element.closest('section') as HTMLElement
const editDialog = async () => (await screen.findByText('修改后采用', { selector: '.ant-modal-title' })).closest('.ant-modal') as HTMLElement

const listRoutes = {
  'GET /batches': () => batches,
  'GET /listening/candidates': (_body: unknown, url: URL) => candidatesByBatch[Number(url.searchParams.get('batch_id'))] || [],
}

describe('AI旁听：选择批次和候选人', () => {
  it('先选批次，再在该批次中选候选人，选择记在地址中', async () => {
    const server = stubServer({ ...listRoutes, 'GET /listening/21': () => standaloneState() })
    renderPage()

    expect(await screen.findByText('请先选择招聘批次，再选择要旁听的候选人')).toBeInTheDocument()
    // 未选择候选人之前不读取任何人的旁听资料。
    expect(server.mock.calls.some(([url]) => String(url).includes('/listening/'))).toBe(false)

    fireEvent.mouseDown(screen.getByLabelText('招聘批次', { selector: 'input' }))
    fireEvent.click(await screen.findByText('2026年校园招聘 · 制造工艺员'))

    const first = (await screen.findByText('候选人甲')).closest('tr') as HTMLElement
    const second = screen.getByText('候选人乙').closest('tr') as HTMLElement
    expect(requestsTo(server, 'GET', '/listening/candidates')[0].url.searchParams.get('batch_id')).toBe('2')
    expect(within(first).getByText('不做AI面试')).toBeInTheDocument()
    expect(within(first).getByText('简历可用')).toBeInTheDocument()
    expect(within(first).getByText('未开始')).toBeInTheDocument()
    expect(within(second).getByText('未上传简历')).toBeInTheDocument()
    expect(within(second).getByText('已结束')).toBeInTheDocument()
    expect(within(second).getByText('待人工复核')).toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent('/ai-interview/listening?batch=2')
    expect(requestsTo(server, 'GET', '/listening/21')).toHaveLength(0)

    fireEvent.click(within(first).getByLabelText('选择 候选人甲'))
    expect(await heading('候选人甲')).toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent('/ai-interview/listening?batch=2&candidate=21')
    expect(requestsTo(server, 'GET', '/listening/21')).toHaveLength(1)
    // 选定后名单收起，可以更换候选人。
    expect(button('更换候选人')).toBeEnabled()
    fireEvent.click(button('更换候选人'))
    expect(within((await screen.findByText('候选人甲', { selector: 'td *' })).closest('tr') as HTMLElement).getByText('当前候选人')).toBeInTheDocument()
  })

  it('有第一阶段报告的候选人在名单中标明，并从地址恢复选择', async () => {
    stubServer({ ...listRoutes, 'GET /listening/11': () => linkedState() })
    renderPage('/ai-interview/listening?batch=1&candidate=11')

    expect(await heading('候选人丙')).toBeInTheDocument()
    const current = await screen.findByLabelText('当前候选人')
    expect(within(current).getByText('已有报告')).toBeInTheDocument()
    expect(within(current).getByText('待人工复核')).toBeInTheDocument()
    expect(await screen.findByTitle('2026年社会招聘 · 质量检验员')).toBeInTheDocument()
  })

  it('只带候选人打开时，批次以候选人所在批次为准', async () => {
    const server = stubServer({ ...listRoutes, 'GET /listening/11': () => linkedState() })
    renderPage('/ai-interview/listening?candidate=11')

    expect(await heading('候选人丙')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('batch=1'))
    expect(screen.getByTestId('where')).toHaveTextContent('candidate=11')
    await waitFor(() => expect(requestsTo(server, 'GET', '/listening/candidates').some(item => item.url.searchParams.get('batch_id') === '1')).toBe(true))
  })

  it('候选人资料读取失败时说明原因，可以重新读取', async () => {
    let fail = true
    stubServer({ ...listRoutes, 'GET /listening/21': () => fail ? Response.json({ detail: '候选人不存在' }, { status: 404 }) : standaloneState() })
    renderPage('/ai-interview/listening?batch=2&candidate=21')

    expect(await screen.findByText('候选人的旁听资料暂时无法读取')).toBeInTheDocument()
    expect(screen.getByText('候选人不存在')).toBeInTheDocument()
    fail = false
    fireEvent.click(button('重新读取'))
    expect(await heading('候选人甲')).toBeInTheDocument()
    expect(screen.queryByText('候选人的旁听资料暂时无法读取')).not.toBeInTheDocument()
  })
})

describe('AI旁听：开始前的准备', () => {
  it('显示依据、岗位要求、简历和硬指标；没有第一阶段时不显示第一阶段内容', async () => {
    stubServer({ ...listRoutes, 'GET /listening/21': () => standaloneState() })
    renderPage('/ai-interview/listening?batch=2&candidate=21')

    expect(await screen.findByText('仅依据简历和岗位要求')).toBeInTheDocument()
    expect(screen.queryByText('关联第一阶段AI面试报告')).not.toBeInTheDocument()
    expect(screen.queryByText('第一阶段AI面试报告（软性评价）')).not.toBeInTheDocument()
    expect(screen.getByText('负责装配、加工过程的工艺执行和记录。')).toHaveClass('evidence-text')
    expect(screen.getByText('食品、生物工程相关专业；能适应倒班。')).toHaveClass('evidence-text')
    // 硬指标与简历放在一起，和软性评价分开。
    const resume = screen.getByText('简历与硬指标').closest('.ant-collapse-item') as HTMLElement
    expect(within(resume).getByText('2019年9月至2023年6月 某大学 食品科学与工程 本科')).toHaveClass('evidence-text')
    expect(within(resume).getByText('本科及以上学历')).toBeInTheDocument()
    expect(within(resume).getByText('满足')).toBeInTheDocument()
    expect(within(resume).getByText(/是否计入评分及具体规则待人力资源部确认/)).toBeInTheDocument()
    expect(within(resume).getByText('简历可用')).toBeInTheDocument()
    fireEvent.click(within(resume).getByText(/查看简历全文/))
    expect(await within(resume).findByText('2023年7月至今在某制造业公司装配车间任工艺员，负责加工记录。')).toHaveClass('evidence-text')
  })

  it('关联第一阶段报告时显示纪要、各维度评价、待核实内容和风险', async () => {
    stubServer({ ...listRoutes, 'GET /listening/11': () => linkedState() })
    renderPage('/ai-interview/listening?batch=1&candidate=11')

    expect(await screen.findByText('关联第一阶段AI面试报告')).toBeInTheDocument()
    const stage = screen.getByText('第一阶段AI面试报告（软性评价）').closest('.ant-collapse-item') as HTMLElement
    expect(within(stage).getByText('报告 #5 · v2')).toBeInTheDocument()
    expect(within(stage).getByText('该报告尚未经人工确认，内容仅供提问参考。')).toBeInTheDocument()
    expect(within(stage).getByText('候选人完成了质量检验员岗位的第一阶段AI面试，能够说明取样和复检流程。')).toHaveClass('evidence-text')
    expect(within(stage).getByText('长期动机证据不足')).toHaveClass('evidence-text')
    expect(within(stage).getByText('核实长期岗位动机')).toBeInTheDocument()
    expect(within(stage).getByText('请补充一个你独立处理现场异常的完整例子。')).toBeInTheDocument()
    expect(within(stage).getByText('语音转写内容需人工核实准确性')).toBeInTheDocument()
    // 硬指标不放在软性评价里。
    expect(within(stage).queryByText('本科及以上学历')).not.toBeInTheDocument()
    expect(within(screen.getByText('简历与硬指标').closest('.ant-collapse-item') as HTMLElement).getByText('本科及以上学历')).toBeInTheDocument()
  })

  it('没有第一阶段面试也能生成提问建议，理由和引用完整显示', async () => {
    const reason = '核实简历中“负责加工记录”的本人职责和处理结果。'.repeat(12)
    let state = standaloneState()
    const server = stubServer({
      ...listRoutes,
      'GET /listening/21': () => state,
      'POST /listening/21/prepare': () => {
        state = standaloneState({ prepared_questions: [{ ...preparedQuestions[0], reason }, preparedQuestions[1]] })
        return { prepared_questions: state.prepared_questions }
      },
    })
    renderPage('/ai-interview/listening?batch=2&candidate=21')

    fireEvent.click(await findButton('生成提问建议'))
    const question = await screen.findByLabelText('准备的提问 1')
    // 以后台方式发起，页面不用等这一次请求。
    expect(requestsTo(server, 'POST', '/listening/21/prepare').map(item => item.body)).toEqual([{ background: true }])
    expect(within(question).getByText('请说明你在加工记录中发现异常时是怎么处理的？')).toHaveClass('evidence-text')
    expect(within(question).getByText('岗位专业能力')).toBeInTheDocument()
    expect(within(question).getByText(reason)).toHaveClass('evidence-text')
    expect(within(question).getByText('负责加工记录').closest('blockquote')).toHaveTextContent('简历原文')
    expect(within(question).getByText('负责装配、加工过程的工艺执行和记录').closest('blockquote')).toHaveTextContent('岗位要求原文')
    for (const name of ['采用', '修改后采用', '忽略']) expect(button(name, question)).toBeEnabled()
    expect(screen.getByLabelText('准备的提问 2')).toHaveTextContent('倒班期间遇到工艺参数偏离，你会先做什么？')
    // 已有建议后，重新生成需要确认。
    expect(queryButton('生成提问建议')).not.toBeInTheDocument()
    expect(button('重新生成')).toBeInTheDocument()
    // 生成提问建议不需要先开始旁听。
    expect(requestsTo(server, 'POST', '/listening/21/start')).toHaveLength(0)
  })

  it('提问建议生成失败时说明原因并可以重新生成', async () => {
    let attempts = 0
    let state = standaloneState()
    stubServer({
      ...listRoutes,
      'GET /listening/21': () => state,
      'POST /listening/21/prepare': () => {
        attempts += 1
        if (attempts === 1) return Response.json({ detail: '缺少候选人简历和岗位资料，无法生成提问建议' }, { status: 409 })
        state = standaloneState({ prepared_questions: preparedQuestions })
        return { operation: { id: 'op-1', status: 'completed' }, prepared_questions: [] }
      },
    })
    renderPage('/ai-interview/listening?batch=2&candidate=21')

    fireEvent.click(await findButton('生成提问建议'))
    expect(await screen.findByText('缺少候选人简历和岗位资料，无法生成提问建议')).toBeInTheDocument()
    fireEvent.click(button('重新生成'))
    expect(await screen.findByLabelText('准备的提问 3')).toBeInTheDocument()
    expect(screen.queryByText('缺少候选人简历和岗位资料，无法生成提问建议')).not.toBeInTheDocument()
  })

  it('开始旁听前就可以处理准备的提问，请求注明来源是准备的提问', async () => {
    let state = standaloneState({ prepared_questions: preparedQuestions })
    const server = stubServer({
      ...listRoutes,
      'GET /listening/21': () => state,
      'POST /listening/21/suggestions': body => {
        const prepared = (state.prepared_questions as typeof preparedQuestions).map(item => item.id !== body.suggestion_id ? item : {
          ...item,
          status: body.action === 'ignored' ? 'ignored' : 'adopted',
          ...(body.action === 'edited' ? { text: String(body.edited_text), edited: true } : {}),
        })
        state = standaloneState({ prepared_questions: prepared })
        return { ok: true, suggestions: [], prepared_questions: prepared }
      },
    })
    renderPage('/ai-interview/listening?batch=2&candidate=21')
    const sent = () => requestsTo(server, 'POST', '/listening/21/suggestions').map(item => item.body)

    fireEvent.click(button('采用', await screen.findByLabelText('准备的提问 1')))
    await waitFor(() => expect(sent()).toHaveLength(1))
    expect(sent()[0]).toEqual({ suggestion_id: 1, action: 'adopted', edited_text: '', source: 'prepared' })
    await waitFor(() => expect(cardOf(screen.getByText('请说明你在加工记录中发现异常时是怎么处理的？'))).toHaveTextContent('已采用'))

    fireEvent.click(button('修改后采用', cardOf(screen.getByText('倒班期间遇到工艺参数偏离，你会先做什么？'))))
    const dialog = await editDialog()
    expect(within(dialog).getByLabelText('修改后的问题')).toHaveValue('倒班期间遇到工艺参数偏离，你会先做什么？')
    fireEvent.change(within(dialog).getByLabelText('修改后的问题'), { target: { value: '  ' } })
    fireEvent.click(button('保存并采用', dialog))
    expect(await within(dialog).findByText('请填写修改后的问题')).toBeInTheDocument()
    expect(sent()).toHaveLength(1)
    fireEvent.change(within(dialog).getByLabelText('修改后的问题'), { target: { value: '夜班发现加工温度偏高，你会先做什么？' } })
    fireEvent.click(button('保存并采用', dialog))
    await waitFor(() => expect(sent()).toHaveLength(2))
    expect(sent()[1]).toEqual({ suggestion_id: 2, action: 'edited', edited_text: '夜班发现加工温度偏高，你会先做什么？', source: 'prepared' })
    const edited = cardOf(await screen.findByText('夜班发现加工温度偏高，你会先做什么？', { selector: '.listening-question-text' }))
    expect(edited).toHaveTextContent('已采用')
    expect(edited).toHaveTextContent('已修改')

    fireEvent.click(button('忽略', cardOf(screen.getByText('请举例说明你如何与班组长确认工艺调整。'))))
    await waitFor(() => expect(sent()).toHaveLength(3))
    expect(sent()[2]).toEqual({ suggestion_id: 3, action: 'ignored', edited_text: '', source: 'prepared' })
    await waitFor(() => expect(cardOf(screen.getByText('请举例说明你如何与班组长确认工艺调整。'))).toHaveTextContent('已忽略'))
    // 处理提问不需要先开始旁听。
    expect(requestsTo(server, 'POST', '/listening/21/start')).toHaveLength(0)
  })

  it('修改后的问题被后端拒绝时，原因显示在修改窗口中，可以继续修改', async () => {
    const server = stubServer({
      ...listRoutes,
      'GET /listening/21': () => standaloneState({ prepared_questions: preparedQuestions }),
      'POST /listening/21/suggestions': () => Response.json({ detail: '编辑后的问题触发敏感过滤' }, { status: 422 }),
    })
    renderPage('/ai-interview/listening?batch=2&candidate=21')

    fireEvent.click(button('修改后采用', await screen.findByLabelText('准备的提问 1')))
    const dialog = await editDialog()
    fireEvent.change(within(dialog).getByLabelText('修改后的问题'), { target: { value: '请问你今年多大年龄？' } })
    fireEvent.click(button('保存并采用', dialog))
    expect(await within(dialog).findByText('编辑后的问题触发敏感过滤')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('修改后的问题')).toHaveValue('请问你今年多大年龄？')
    expect(requestsTo(server, 'POST', '/listening/21/suggestions')).toHaveLength(1)
    expect(screen.getByLabelText('准备的提问 1')).not.toHaveTextContent('已采用')
  })
})

describe('AI旁听：采集同意与开始', () => {
  it('没有系统内同意记录时，未勾选现场确认不能开始', async () => {
    const server = stubServer({ ...listRoutes, 'GET /listening/21': () => standaloneState() })
    renderPage('/ai-interview/listening?batch=2&candidate=21')

    const notice = await screen.findByLabelText('采集告知')
    expect(within(notice).getByText(NOTICE_VERSION)).toBeInTheDocument()
    expect(within(notice).getByText('本次面试仅采集音频，不采集视频。')).toHaveClass('evidence-text')
    expect(within(notice).getByText('录音和转写在本地留存，须人工复核。')).toHaveClass('evidence-text')
    expect(within(notice).getByText('系统内没有候选人对当前版本告知的同意记录')).toBeInTheDocument()
    expect(within(notice).getByLabelText(ATTESTATION)).not.toBeChecked()
    const start = button('开始AI旁听')
    expect(start).toBeDisabled()
    expect(screen.getByText('勾选上方确认后才能开始旁听。')).toBeInTheDocument()
    fireEvent.click(start)
    expect(requestsTo(server, 'POST', '/listening/21/start')).toHaveLength(0)
    expect(startSpeech).not.toHaveBeenCalled()
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled()
  })

  it('面试官确认已当面告知并取得同意后开始旁听，请求带上现场确认', async () => {
    let state = standaloneState()
    const server = stubServer({
      ...listRoutes,
      'GET /listening/21': () => state,
      'POST /listening/21/start': () => {
        state = standaloneState({ status: 'running', consent_record: { accepted: true, method: ONSITE_METHOD, confirmed_at: '2026-09-28T03:00:00+00:00', recorded_by: 'interviewer-a', notice_version: NOTICE_VERSION } })
        return { ok: true, mode: 'standalone' }
      },
    })
    vi.mocked(startSpeech).mockResolvedValue({ captureId: 'capture-1', stop: vi.fn(), abort: vi.fn() })
    renderPage('/ai-interview/listening?batch=2&candidate=21')

    fireEvent.click(await screen.findByLabelText(ATTESTATION))
    expect(button('开始AI旁听')).toBeEnabled()
    fireEvent.click(button('开始AI旁听'))

    await waitFor(() => expect(requestsTo(server, 'POST', '/listening/21/start')).toHaveLength(1))
    expect(requestsTo(server, 'POST', '/listening/21/start')[0].body).toEqual({
      consented: true, candidate_confirmed: true, candidate_code: 'XZ-021', notice_version: NOTICE_VERSION,
    })
    await waitFor(() => expect(startSpeech).toHaveBeenCalledWith(
      expect.anything(), { kind: 'listening', target_id: 21 }, expect.any(Function), expect.any(Function),
      { onNotice: expect.any(Function) }))
    await waitFor(() => expect(button('暂停并保存')).toBeEnabled())
    expect(await screen.findByText(new RegExp(`采集同意：${ONSITE_METHOD}`))).toBeInTheDocument()
    // 已经记录过现场确认，继续录音时不再要求勾选。
    expect(screen.queryByLabelText(ATTESTATION)).not.toBeInTheDocument()
  })

  it('候选人在系统内同意过当前告知时不需要现场确认', async () => {
    const server = stubServer({
      ...listRoutes,
      'GET /listening/11': () => linkedState(),
      'POST /listening/11/start': () => ({ ok: true, mode: 'linked' }),
    })
    vi.mocked(startSpeech).mockResolvedValue({ captureId: 'capture-1', stop: vi.fn(), abort: vi.fn() })
    renderPage('/ai-interview/listening?batch=1&candidate=11')

    expect(await screen.findByText('候选人已在系统内同意当前版本的采集告知，开始旁听时引用该记录。')).toBeInTheDocument()
    expect(screen.queryByLabelText(ATTESTATION)).not.toBeInTheDocument()
    fireEvent.click(button('开始AI旁听'))
    await waitFor(() => expect(requestsTo(server, 'POST', '/listening/11/start')).toHaveLength(1))
    expect(requestsTo(server, 'POST', '/listening/11/start')[0].body).toEqual({ consented: true, candidate_code: 'SZ-011', notice_version: NOTICE_VERSION })
  })

  it('开始旁听被后端拒绝时说明原因，不打开麦克风', async () => {
    const refused = '未找到候选人的采集同意记录。请先当面告知采集事项并取得同意，再勾选确认后开始旁听'
    stubServer({
      ...listRoutes,
      'GET /listening/11': () => linkedState(),
      'POST /listening/11/start': () => Response.json({ detail: refused }, { status: 409 }),
    })
    renderPage('/ai-interview/listening?batch=1&candidate=11')

    fireEvent.click(await findButton('开始AI旁听'))
    expect(await screen.findByText(refused)).toBeInTheDocument()
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled()
    expect(startSpeech).not.toHaveBeenCalled()
    await waitFor(() => expect(button('开始AI旁听')).toBeEnabled())
  })

  it('麦克风被拒绝时说明原因，不显示浏览器的英文错误', async () => {
    let state = standaloneState({ prior_consent_valid: true })
    stubServer({
      ...listRoutes,
      'GET /listening/21': () => state,
      'POST /listening/21/start': () => { state = standaloneState({ prior_consent_valid: true, status: 'running' }); return { ok: true } },
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError')) },
    })
    renderPage('/ai-interview/listening?batch=2&candidate=21')

    fireEvent.click(await findButton('开始AI旁听'))
    expect(await screen.findByText(/麦克风访问被阻止/)).toBeInTheDocument()
    expect(screen.queryByText('Permission denied')).not.toBeInTheDocument()
    expect(startSpeech).not.toHaveBeenCalled()
    // 本场旁听已经开始，解决麦克风问题后可以继续。
    expect(await findButton('继续录音')).toBeEnabled()
  })
})

describe('AI旁听：语音转写未配置', () => {
  it('说明原因并隐藏录音控制，准备功能照常可用', async () => {
    let state = standaloneState({ asr_mode: 'unavailable' })
    const server = stubServer({
      ...listRoutes,
      'GET /listening/21': () => state,
      'POST /listening/21/prepare': () => {
        state = standaloneState({ asr_mode: 'unavailable', prepared_questions: preparedQuestions })
        return { prepared_questions: preparedQuestions }
      },
      'POST /listening/21/suggestions': body => ({ ok: true, suggestions: [], prepared_questions: preparedQuestions.map(item => item.id === body.suggestion_id ? { ...item, status: 'adopted' } : item) }),
    })
    renderPage('/ai-interview/listening?batch=2&candidate=21')

    expect(await screen.findByText('语音转写服务尚未配置，暂时不能录音和转写')).toBeInTheDocument()
    for (const name of ['开始AI旁听', '继续录音', '暂停并保存', '结束并生成综合报告', '立即分析当前对话', '下载 MP3 音频']) {
      expect(queryButton(name)).not.toBeInTheDocument()
    }
    expect(screen.queryByText('旁听记录')).not.toBeInTheDocument()
    expect(screen.queryByText('录音留存')).not.toBeInTheDocument()
    expect(screen.queryByLabelText(ATTESTATION)).not.toBeInTheDocument()
    // 准备资料和提问建议不受影响。
    expect(screen.getByText('本科及以上学历')).toBeInTheDocument()
    expect(screen.getByText('负责装配、加工过程的工艺执行和记录。')).toBeInTheDocument()
    fireEvent.click(button('生成提问建议'))
    fireEvent.click(button('采用', await screen.findByLabelText('准备的提问 1')))
    await waitFor(() => expect(requestsTo(server, 'POST', '/listening/21/suggestions')).toHaveLength(1))
    expect(requestsTo(server, 'POST', '/listening/21/suggestions')[0].body).toMatchObject({ source: 'prepared', action: 'adopted' })
    expect(requestsTo(server, 'POST', '/listening/21/start')).toHaveLength(0)
  })
})

describe('AI旁听：旁听过程', () => {
  const capture = { id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', status: 'linked', text: '我先记录异常并请班组长核实。', speaker_status: 'completed', speaker_analysis: { turns: [{ cluster_id: 'voice-1', start_ms: 0, end_ms: 900 }, { cluster_id: 'voice-2', start_ms: 900, end_ms: 2000 }] } }
  const pendingCapture = { id: 'ffeeddccbbaa99887766554433221100', status: 'completed', text: '后来我又复测了一次。', speaker_status: 'not_requested', speaker_analysis: {} }
  const running = (overrides: Record<string, unknown> = {}) => linkedState({
    status: 'running',
    consent_record: { accepted: true, method: '引用前置两阶段合规告知', confirmed_at: '2026-09-28T03:00:00+00:00', recorded_by: 'interviewer-a', notice_version: NOTICE_VERSION },
    transcript: [`[录音 ${capture.id}] ${capture.text}`],
    captures: [capture, pendingCapture],
    speakers: { [capture.id]: { speaker: 'dialogue' }, [pendingCapture.id]: { speaker: 'dialogue' } },
    suggestions: [
      { id: 1, text: '请补充异常判断标准。', status: 'pending', edited_text: '', reason: '核实判断依据', dimension: '岗位专业能力', stage_one_excerpt: '能够说明取样、复检和记录的顺序。', answer_excerpt: '我先记录异常并请班组长核实。', capture_id: capture.id, provisional: false, speaker_inferred: true, speaker_basis: '疑似在回答前一句提问，身份须现场核实' },
      { id: 2, text: '复检结果不一致时你怎么处理？', status: 'pending', edited_text: '', reason: '核实处置顺序', dimension: '逻辑思维', stage_one_excerpt: '', answer_excerpt: '后来我又复测了一次。', capture_id: capture.id },
      { id: 3, text: '已经问过的问题', status: 'adopted', edited_text: '', reason: '', dimension: '沟通表达' },
    ],
    ...overrides,
  })

  it('转写不显示录音内部编号；补充提问的依据完整显示，处理时注明来源', async () => {
    let state = running()
    const server = stubServer({
      ...listRoutes,
      'GET /listening/11': () => state,
      'POST /listening/11/suggestions': body => {
        const suggestions = (state.suggestions as Array<Record<string, unknown>>).map(item => item.id !== body.suggestion_id ? item : { ...item, status: body.action, edited_text: body.action === 'edited' ? body.edited_text : '' })
        state = running({ suggestions })
        return { ok: true, suggestions, prepared_questions: [] }
      },
    })
    renderPage('/ai-interview/listening?batch=1&candidate=11')

    const transcript = await screen.findByLabelText('已保存的转写')
    expect(within(transcript).getByText('我先记录异常并请班组长核实。')).toHaveClass('evidence-text')
    expect(transcript).not.toHaveTextContent(capture.id)
    expect(within(transcript).getByText('连续对话')).toBeInTheDocument()

    // 最新的补充提问排在最前面，标为优先追问；序号按生成顺序，不随处理变化。
    const cards = screen.getAllByLabelText(/^补充提问 \d+$/)
    expect(cards.map(card => card.getAttribute('aria-label'))).toEqual(['补充提问 3', '补充提问 2', '补充提问 1'])
    expect(cards[0]).toHaveTextContent('已经问过的问题')
    const first = cardOf(screen.getByText('请补充异常判断标准。'))
    expect(within(first).getByText('备选')).toBeInTheDocument()
    expect(within(first).getByText('核实判断依据')).toHaveClass('evidence-text')
    expect(within(first).getByText('我先记录异常并请班组长核实。').closest('blockquote')).toHaveTextContent('候选人现场回答')
    expect(within(first).getByText('能够说明取样、复检和记录的顺序。').closest('blockquote')).toHaveTextContent('第一阶段报告原文')
    expect(within(first).getByText('回答归属按对话语境推测，请面试官核对')).toBeInTheDocument()
    expect(within(first).getByText('疑似在回答前一句提问，身份须现场核实')).toHaveClass('evidence-text')
    expect(within(cardOf(screen.getByText('复检结果不一致时你怎么处理？'))).getByText('优先追问')).toBeInTheDocument()
    expect(cardOf(screen.getByText('已经问过的问题'))).toHaveTextContent('已采用')

    fireEvent.click(button('采用', first))
    await waitFor(() => expect(requestsTo(server, 'POST', '/listening/11/suggestions')).toHaveLength(1))
    expect(requestsTo(server, 'POST', '/listening/11/suggestions')[0].body).toEqual({ suggestion_id: 1, action: 'adopted', edited_text: '', source: 'followup' })
    await waitFor(() => expect(cardOf(screen.getByText('请补充异常判断标准。'))).toHaveTextContent('已采用'))

    fireEvent.click(button('修改后采用', cardOf(screen.getByText('复检结果不一致时你怎么处理？'))))
    const dialog = await editDialog()
    fireEvent.change(within(dialog).getByLabelText('修改后的问题'), { target: { value: '两次复检结果不一致，你先做什么？' } })
    fireEvent.click(button('保存并采用', dialog))
    await waitFor(() => expect(requestsTo(server, 'POST', '/listening/11/suggestions')).toHaveLength(2))
    expect(requestsTo(server, 'POST', '/listening/11/suggestions')[1].body).toEqual({ suggestion_id: 2, action: 'edited', edited_text: '两次复检结果不一致，你先做什么？', source: 'followup' })
    expect(cardOf(await screen.findByText('两次复检结果不一致，你先做什么？', { selector: '.listening-question-text' }))).toHaveTextContent('已修改后采用')
  })

  it('立即分析当前对话：没有新增回答时说明原因', async () => {
    const server = stubServer({
      ...listRoutes,
      'GET /listening/11': () => running({ suggestions: [] }),
      'POST /listening/11/suggest': () => ({ suggestions: [], skipped: '没有新增回答证据' }),
    })
    renderPage('/ai-interview/listening?batch=1&candidate=11')

    // 还没有补充提问时先显示准备的提问；补充提问在另一栏。
    fireEvent.click(await screen.findByText('现场补充提问'))
    fireEvent.click(await findButton('立即分析当前对话'))
    expect(await screen.findByText('没有新增回答证据')).toBeInTheDocument()
    expect(requestsTo(server, 'POST', '/listening/11/suggest')).toHaveLength(1)
  })

  it('准备的提问和现场补充提问各占一栏，栏名标出待处理条数；暂停保存后切到补充提问栏', async () => {
    const stop = vi.fn().mockResolvedValue({ capture_id: pendingCapture.id, text: pendingCapture.text })
    vi.mocked(startSpeech).mockResolvedValue({ captureId: pendingCapture.id, stop, abort: vi.fn() })
    let state = running({ prepared_questions: preparedQuestions.map(item => item.id === 1 ? { ...item, status: 'adopted' } : item) })
    const server = stubServer({
      ...listRoutes,
      'GET /listening/11': () => state,
      'POST /listening/11/start': () => ({ ok: true, mode: 'linked' }),
      'POST /listening/11/capture': () => ({ ok: true }),
      'POST /listening/11/roles': () => ({ handled: 0, speakers: {} }),
      'POST /listening/11/suggest': () => {
        const suggestions = [...(state.suggestions as unknown[]), { id: 4, text: '复测的依据是什么？', status: 'pending', edited_text: '', reason: '', dimension: '逻辑思维', answer_excerpt: pendingCapture.text }]
        state = { ...state, suggestions }
        return { suggestions }
      },
    })
    renderPage('/ai-interview/listening?batch=1&candidate=11')

    // 旁听进行中且已有补充提问：先显示补充提问栏，准备的提问不占位置。
    const followupTab = (await screen.findByText('现场补充提问')).closest('.ant-tabs-tab') as HTMLElement
    const preparedTab = screen.getByText('开始前准备的提问').closest('.ant-tabs-tab') as HTMLElement
    expect(followupTab).toHaveClass('ant-tabs-tab-active')
    expect(screen.getAllByLabelText(/^补充提问 \d+$/)).toHaveLength(3)
    expect(screen.queryByLabelText('准备的提问 1')).not.toBeInTheDocument()
    expect(within(followupTab).getByLabelText('2 条待处理')).toHaveTextContent('2')
    expect(within(preparedTab).getByLabelText('2 条待处理')).toHaveTextContent('2')

    fireEvent.click(screen.getByText('开始前准备的提问'))
    expect(await screen.findByLabelText('准备的提问 1')).toHaveTextContent('已采用')
    expect(screen.getByLabelText('准备的提问 3')).toBeInTheDocument()
    expect(screen.queryByLabelText(/^补充提问 \d+$/)).not.toBeInTheDocument()
    expect(preparedTab).toHaveClass('ant-tabs-tab-active')

    // 暂停并保存一段回答后，针对这段回答的补充提问生成完，自动切到补充提问栏。
    fireEvent.click(button('继续录音'))
    await waitFor(() => expect(button('暂停并保存')).toBeEnabled())
    fireEvent.click(button('暂停并保存'))
    await waitFor(() => expect(requestsTo(server, 'POST', '/listening/11/suggest')).toHaveLength(1))
    expect(await screen.findByText('复测的依据是什么？')).toBeInTheDocument()
    expect(followupTab).toHaveClass('ant-tabs-tab-active')
    expect(within(followupTab).getByLabelText('3 条待处理')).toHaveTextContent('3')
    expect(screen.queryByLabelText('准备的提问 1')).not.toBeInTheDocument()
  })

  it('录音可以下载为MP3、关联转写、标注发言人', async () => {
    const server = stubServer({
      ...listRoutes,
      'GET /listening/11': () => running(),
      'POST /listening/11/capture': () => ({ ok: true }),
      'POST /listening/11/speaker': () => ({ ok: true }),
    })
    vi.mocked(downloadAudioAsMp3).mockResolvedValue(undefined)
    renderPage('/ai-interview/listening?batch=1&candidate=11')

    const first = await screen.findByLabelText('第 1 段录音')
    const second = screen.getByLabelText('第 2 段录音')
    expect(within(first).getByText('已关联面试')).toBeInTheDocument()
    expect(within(first).getByText('识别到 2 组声音，身份须人工核对')).toBeInTheDocument()
    expect(queryButton('关联已完成转写', first)).not.toBeInTheDocument()

    fireEvent.click(button('下载 MP3 音频', first))
    await waitFor(() => expect(downloadAudioAsMp3).toHaveBeenCalledWith(`/speech/captures/${capture.id}/audio`, '面试录音-SZ-011-第1段.mp3'))

    fireEvent.click(button('关联已完成转写', second))
    await waitFor(() => expect(requestsTo(server, 'POST', '/listening/11/capture')).toHaveLength(1))
    expect(requestsTo(server, 'POST', '/listening/11/capture')[0].body).toEqual({ capture_id: pendingCapture.id })

    fireEvent.mouseDown(within(first).getByLabelText('第 1 段录音的发言人', { selector: 'input' }))
    fireEvent.click(await screen.findByText('整段是候选人回答'))
    await waitFor(() => expect(requestsTo(server, 'POST', '/listening/11/speaker')).toHaveLength(1))
    expect(requestsTo(server, 'POST', '/listening/11/speaker')[0].body).toEqual({ capture_id: capture.id, speaker: 'candidate' })
  })

  it('结束前需要确认；生成综合报告后显示摘要并可进入综合报告', async () => {
    const report = {
      disclaimer: 'AI辅助生成，须人工复核', status: 'pending_review', mode: 'standalone', generation_mode: '文本模型分析',
      stage_one: null, stage_one_summary: '本场未进行第一阶段AI面试，综合分析依据简历、岗位要求和人工面试回答。',
      stage_two_summary: '人工面试共留存 1 段有效转写，其中 1 段包含候选人回答或待核对的混合对话。',
      findings: [{ dimension: '岗位专业能力', status: '新增证据待复核', analysis: '回答说明了异常记录和复核的顺序。', stage_one_excerpt: '', answer_excerpt: '我先记录异常并请班组长核实。', capture_id: capture.id, speaker_inferred: true, speaker_basis: '语境推测' }],
      adopted_questions: ['请说明你在加工记录中发现异常时是怎么处理的？'],
      risks: ['本场没有第一阶段评分，综合分析不含量化评分，须由考官结合现场情况评价'],
      decision: null,
    }
    let state = standaloneState({
      status: 'running', prior_consent_valid: true,
      transcript: [`[录音 ${capture.id}] ${capture.text}`], captures: [capture], speakers: { [capture.id]: { speaker: 'candidate' } },
    })
    const server = stubServer({
      ...listRoutes,
      'GET /listening/21': () => state,
      'POST /listening/21/finish': () => {
        state = { ...state, status: 'completed', comprehensive_report: report, comprehensive_report_meta: { status: 'pending_review', current_version: 1, versions: [] } }
        return report
      },
    })
    renderPage('/ai-interview/listening?batch=2&candidate=21')

    fireEvent.click(await findButton('结束并生成综合报告'))
    expect(await screen.findByText('结束本场旁听并生成综合报告？')).toBeInTheDocument()
    expect(screen.getByText(/综合报告在后台生成，不用停在这里等/)).toBeInTheDocument()
    expect(requestsTo(server, 'POST', '/listening/21/finish')).toHaveLength(0)
    fireEvent.click(button('结束并生成'))

    const summary = (await screen.findByText('综合报告已生成', { selector: '.ant-card-head-title' })).closest('.ant-card') as HTMLElement
    expect(requestsTo(server, 'POST', '/listening/21/finish').map(item => item.body)).toEqual([{ background: true }])
    expect(within(summary).getByText('仅依据简历和岗位要求')).toBeInTheDocument()
    expect(within(summary).getByText('待人工复核')).toBeInTheDocument()
    expect(within(summary).getByText('回答说明了异常记录和复核的顺序。')).toHaveClass('evidence-text')
    expect(within(summary).getByText('新增证据待复核')).toBeInTheDocument()
    expect(within(summary).getByText('回答归属待核对')).toBeInTheDocument()
    expect(within(summary).getByText('请说明你在加工记录中发现异常时是怎么处理的？')).toBeInTheDocument()
    expect(within(summary).getByText('本场未进行第一阶段AI面试，综合分析依据简历、岗位要求和人工面试回答。')).toBeInTheDocument()
    // 结束后不能继续录音。
    expect(await screen.findByText('本场旁听已结束，录音和转写已保存，不能继续录音。')).toBeInTheDocument()
    for (const name of ['继续录音', '开始AI旁听', '暂停并保存']) expect(queryButton(name)).not.toBeInTheDocument()

    fireEvent.click(button('进入综合报告', summary))
    expect(await screen.findByText('综合报告页面')).toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent('/ai-interview/reports?type=comprehensive')
  })

  it('综合报告没有生成时说明原因，旁听保持进行中', async () => {
    const refused = '请先保存录音，并标注至少一段候选人回答；混合或未知发言不作为候选人证据'
    stubServer({
      ...listRoutes,
      'GET /listening/11': () => running(),
      'POST /listening/11/finish': () => Response.json({ detail: refused }, { status: 409 }),
    })
    renderPage('/ai-interview/listening?batch=1&candidate=11')

    fireEvent.click(await findButton('结束并生成综合报告'))
    fireEvent.click(await findButton('结束并生成'))
    expect(await screen.findByText(refused)).toBeInTheDocument()
    expect(screen.queryByText('综合报告已生成', { selector: '.ant-card-head-title' })).not.toBeInTheDocument()
    await waitFor(() => expect(button('继续录音')).toBeEnabled())
  })

  it('没有查看报告权限的角色不显示综合报告入口', async () => {
    const report = { mode: 'standalone', stage_one: null, stage_one_summary: '', stage_two_summary: '人工面试共留存 1 段有效转写。', findings: [], adopted_questions: [], risks: [] }
    stubServer({
      ...listRoutes,
      'GET /listening/21': () => standaloneState({ status: 'completed', comprehensive_report: report, comprehensive_report_meta: { status: 'pending_review', current_version: 1, versions: [] } }),
    })
    renderPage('/ai-interview/listening?batch=2&candidate=21', { ...interviewer, permissions: ['listening:use'] })

    expect(await screen.findByText('综合报告已生成', { selector: '.ant-card-head-title' })).toBeInTheDocument()
    expect(queryButton('进入综合报告')).not.toBeInTheDocument()
  })
})

describe('AI旁听：后台生成', () => {
  type State = Record<string, unknown>
  const POLL = 25
  const URL = '/ai-interview/listening?batch=2&candidate=21'
  const capture = { id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', status: 'linked', text: '我先记录异常并请班组长核实。', speaker_status: 'not_requested', speaker_analysis: {} }
  const task = (overrides: State = {}) => ({
    status: 'running', progress: '正在依据简历和岗位要求向模型请求提问建议', error: '', started_at: '2026-09-29T03:00:00+00:00',
    started_by: 'interviewer-a', elapsed_seconds: 12, operation_id: 'op-1', ...overrides,
  })
  const report = (overrides: State = {}) => ({
    disclaimer: 'AI辅助生成，须人工复核', status: 'pending_review', mode: 'standalone', generation_mode: '文本模型分析', generation_note: '',
    stage_one: null, stage_one_summary: '本场未进行第一阶段AI面试，综合分析依据简历、岗位要求和人工面试回答。',
    stage_two_summary: '人工面试共留存 1 段有效转写，其中 1 段包含候选人回答或待核对的混合对话。',
    findings: [{ dimension: '岗位专业能力', status: '新增证据待复核', analysis: '回答说明了异常记录和复核的顺序。', stage_one_excerpt: '', answer_excerpt: capture.text, capture_id: capture.id }],
    adopted_questions: [], risks: [], decision: null, ...overrides,
  })
  const original = [{ version: 1, version_type: 'ai_original' }]
  const meta = (status: string, versions: unknown[] = [], extra: State = {}) => ({ status, current_version: versions.length, versions, ...extra })
  const ended = (overrides: State = {}): State => standaloneState({
    status: 'completed', prior_consent_valid: true,
    transcript: [`[录音 ${capture.id}] ${capture.text}`], captures: [capture], speakers: { [capture.id]: { speaker: 'candidate' } },
    ...overrides,
  })
  const progressCard = async (title: string) => (await screen.findByText(title, { selector: '.ant-card-head-title' })).closest('.ant-card') as HTMLElement
  const reads = (server: ReturnType<typeof stubServer>) => requestsTo(server, 'GET', '/listening/21').length

  it('提问建议在后台生成：显示进度和已用时间，期间可以开始旁听，完成后显示结果并停止读取进度', async () => {
    let state: State = standaloneState({ prior_consent_valid: true })
    const server = stubServer({
      ...listRoutes,
      'GET /listening/21': () => state,
      'POST /listening/21/prepare': () => {
        state = { ...state, tasks: { prepare: task(), report: null } }
        return { operation: { id: 'op-1', status: 'running' }, prepared_questions: [] }
      },
    })
    renderPage(URL, interviewer, POLL)

    fireEvent.click(await findButton('生成提问建议'))
    const wait = (await screen.findByText('正在生成提问建议，已用时 12 秒')).closest('[role="status"]') as HTMLElement
    expect(wait).toHaveTextContent('正在依据简历和岗位要求向模型请求提问建议')
    expect(wait).toHaveTextContent('不用停在这里等：可以先查看候选人资料，也可以先开始旁听。')
    expect(requestsTo(server, 'POST', '/listening/21/prepare').map(item => item.body)).toEqual([{ background: true }])
    // 生成期间可以开始旁听，也可以更换候选人。
    expect(button('开始AI旁听')).toBeEnabled()
    expect(button('更换候选人')).toBeEnabled()
    const before = reads(server)
    await waitFor(() => expect(reads(server)).toBeGreaterThan(before + 1))

    state = { ...state, prepared_questions: preparedQuestions, tasks: { prepare: task({ status: 'completed', progress: '' }), report: null } }
    expect(await screen.findByLabelText('准备的提问 3')).toBeInTheDocument()
    expect(await screen.findByText('已生成 3 个提问建议')).toBeInTheDocument()
    expect(screen.queryByText(/正在生成提问建议/)).not.toBeInTheDocument()
    const settled = reads(server)
    await new Promise(resolve => setTimeout(resolve, POLL * 5))
    expect(reads(server)).toBe(settled)
  })

  it('打开页面时提问建议正在生成：恢复显示进度；没有生成时说明原因，可以重新生成', async () => {
    let state: State = standaloneState({ tasks: { prepare: task({ elapsed_seconds: 75, progress: '模型服务暂时没有返回结果（AI服务响应超时，请稍后重试），正在重试' }), report: null } })
    const server = stubServer({
      ...listRoutes,
      'GET /listening/21': () => state,
      'POST /listening/21/prepare': () => {
        state = { ...state, tasks: { prepare: task({ elapsed_seconds: 0 }), report: null } }
        return { operation: { id: 'op-2', status: 'running' }, prepared_questions: [] }
      },
    })
    renderPage(URL, interviewer, POLL)

    const wait = (await screen.findByText('正在生成提问建议，已用时 1 分 15 秒')).closest('[role="status"]') as HTMLElement
    expect(wait).toHaveTextContent('正在重试')
    state = { ...state, tasks: { prepare: task({ status: 'failed', progress: '', error: 'AI服务响应超时，请稍后重试' }), report: null } }
    const alert = (await screen.findByText('提问建议没有生成')).closest('.ant-alert') as HTMLElement
    expect(alert).toHaveTextContent('AI服务响应超时，请稍后重试')
    // 不是本页发起的生成，结束时不弹出提示。
    expect(screen.queryByText(/已生成 \d+ 个提问建议/)).not.toBeInTheDocument()

    fireEvent.click(button('重新生成', alert))
    expect(await screen.findByText('正在生成提问建议，已用时 0 秒')).toBeInTheDocument()
    expect(requestsTo(server, 'POST', '/listening/21/prepare')).toHaveLength(1)
    expect(screen.queryByText('提问建议没有生成')).not.toBeInTheDocument()
  })

  it('结束旁听后综合报告在后台生成：显示进度，可以更换候选人；生成后显示摘要', async () => {
    let state: State = ended({ status: 'running' })
    const server = stubServer({
      ...listRoutes,
      'GET /listening/21': () => state,
      'POST /listening/21/finish': () => {
        state = { ...state, status: 'completed', comprehensive_report_meta: meta('generating'),
          tasks: { prepare: null, report: task({ progress: '正在区分对话中的发言人并汇总本场记录', elapsed_seconds: 5 }) } }
        return { status: 'generating', operation: { id: 'op-3', status: 'running' }, report: null }
      },
    })
    renderPage(URL, interviewer, POLL)

    fireEvent.click(await findButton('结束并生成综合报告'))
    fireEvent.click(await findButton('结束并生成'))
    const progress = await progressCard('综合报告正在生成')
    expect(progress).toHaveTextContent('正在区分对话中的发言人并汇总本场记录，已用时 5 秒')
    expect(progress).toHaveTextContent('不用停在这里等：可以接着旁听下一位候选人')
    expect(requestsTo(server, 'POST', '/listening/21/finish').map(item => item.body)).toEqual([{ background: true }])
    // 本场已经结束；报告生成期间可以更换候选人。
    expect(await screen.findByText('本场旁听已结束，录音和转写已保存，不能继续录音。')).toBeInTheDocument()
    await waitFor(() => expect(button('更换候选人')).toBeEnabled())
    expect(screen.queryByText('综合报告已生成', { selector: '.ant-card-head-title' })).not.toBeInTheDocument()

    state = { ...state, comprehensive_report: report(), comprehensive_report_meta: meta('pending_review', original),
      tasks: { prepare: null, report: task({ status: 'completed', progress: '' }) } }
    const summary = await progressCard('综合报告已生成')
    expect(within(summary).getByText('回答说明了异常记录和复核的顺序。')).toBeInTheDocument()
    expect(within(summary).getByText('待人工复核')).toBeInTheDocument()
    expect(await screen.findByText('综合报告已生成，请进行人工复核')).toBeInTheDocument()
    expect(screen.queryByText('综合报告正在生成', { selector: '.ant-card-head-title' })).not.toBeInTheDocument()
    // 模型给出了分析结果的报告不提示重新生成。
    expect(queryButton('重新生成', summary)).not.toBeInTheDocument()
  })

  it('综合报告没有生成时说明原因，可以重新生成', async () => {
    let state: State = ended({
      comprehensive_report_meta: meta('generation_failed', [], { generation_error: '本场材料超出当前分析容量，请人工复核' }),
      tasks: { prepare: null, report: task({ status: 'failed', progress: '', error: '本场材料超出当前分析容量，请人工复核' }) },
    })
    const server = stubServer({
      ...listRoutes,
      'GET /listening/21': () => state,
      'POST /listening/21/report/regenerate': () => {
        state = { ...state, comprehensive_report_meta: meta('generating'),
          tasks: { prepare: null, report: task({ progress: '正在准备生成综合报告', elapsed_seconds: 0 }) } }
        return { status: 'generating', operation: { id: 'op-4', status: 'running' } }
      },
    })
    renderPage(URL, interviewer, POLL)

    const alert = (await screen.findByText('综合报告没有生成')).closest('.ant-alert') as HTMLElement
    expect(alert).toHaveTextContent('原因：本场材料超出当前分析容量，请人工复核')
    expect(alert).toHaveTextContent('本场的录音和转写已经保存，不受影响。')
    fireEvent.click(button('重新生成', alert))
    expect(await progressCard('综合报告正在生成')).toHaveTextContent('正在准备生成综合报告，已用时 0 秒')
    expect(requestsTo(server, 'POST', '/listening/21/report/regenerate')).toHaveLength(1)
    expect(screen.queryByText('综合报告没有生成')).not.toBeInTheDocument()

    state = { ...state, comprehensive_report_meta: meta('generation_failed', [], { generation_error: 'AI服务响应超时，请稍后重试' }),
      tasks: { prepare: null, report: task({ status: 'failed', progress: '', error: 'AI服务响应超时，请稍后重试' }) } }
    expect(await screen.findByText('综合报告没有生成：AI服务响应超时，请稍后重试')).toBeInTheDocument()
    expect((await screen.findByText('综合报告没有生成')).closest('.ant-alert')).toHaveTextContent('原因：AI服务响应超时，请稍后重试')
  })

  it('服务重启打断了生成时如实说明，可以重新生成', async () => {
    stubServer({
      ...listRoutes,
      'GET /listening/21': () => ended({
        comprehensive_report_meta: meta('generating'),
        tasks: { prepare: null, report: { status: 'interrupted', progress: '', error: '综合报告生成被中断，请重新生成' } },
      }),
    })
    renderPage(URL, interviewer, POLL)

    const alert = (await screen.findByText('综合报告的生成被中断')).closest('.ant-alert') as HTMLElement
    expect(alert).toHaveTextContent('原因：综合报告生成被中断，请重新生成')
    expect(button('重新生成', alert)).toBeEnabled()
    expect(screen.queryByText('综合报告正在生成', { selector: '.ant-card-head-title' })).not.toBeInTheDocument()
  })

  it('只保全了原文证据的报告说明原因，确认后重新生成；人工修改过的报告不能重新生成', async () => {
    const preserved = report({ generation_mode: '证据保全降级', generation_note: 'AI服务响应超时，请稍后重试' })
    let state: State = ended({ comprehensive_report: preserved, comprehensive_report_meta: meta('pending_review', original) })
    const server = stubServer({
      ...listRoutes,
      'GET /listening/21': () => state,
      'POST /listening/21/report/regenerate': () => {
        state = { ...state, comprehensive_report_meta: meta('generating', original),
          tasks: { prepare: null, report: task({ progress: '正在准备生成综合报告', elapsed_seconds: 1 }) } }
        return { status: 'generating', operation: { id: 'op-5', status: 'running' } }
      },
    })
    const view = renderPage(URL, interviewer, POLL)

    const summary = await progressCard('综合报告已生成')
    const warning = within(summary).getByText('这份报告没有得到模型的分析结果，只保全了原文证据').closest('.ant-alert') as HTMLElement
    expect(warning).toHaveTextContent('原因：AI服务响应超时，请稍后重试')
    expect(warning).toHaveTextContent('可以重新生成；也可以在综合报告中由人工补充结论。')
    expect(within(summary).getByText('只保全了原文证据')).toBeInTheDocument()
    fireEvent.click(button('重新生成', warning))
    expect(await screen.findByText('重新生成综合报告？')).toBeInTheDocument()
    expect(requestsTo(server, 'POST', '/listening/21/report/regenerate')).toHaveLength(0)
    fireEvent.click(document.querySelector('.ant-popconfirm .ant-btn-primary') as HTMLElement)

    // 重新生成期间此前的报告仍然显示，状态为生成中，不能重复发起。
    expect(await progressCard('综合报告正在重新生成')).toHaveTextContent('正在准备生成综合报告，已用时 1 秒')
    expect(requestsTo(server, 'POST', '/listening/21/report/regenerate')).toHaveLength(1)
    const during = await progressCard('综合报告已生成')
    expect(within(during).getByText('报告生成中')).toBeInTheDocument()
    expect(within(during).getByText('正在重新生成，完成后这里显示新的内容。')).toBeInTheDocument()
    expect(queryButton('重新生成', during)).not.toBeInTheDocument()

    state = { ...state, comprehensive_report: report(), comprehensive_report_meta: meta('pending_review', [...original, { version: 2, version_type: 'ai_original' }]),
      tasks: { prepare: null, report: task({ status: 'completed', progress: '' }) } }
    await waitFor(() => expect(screen.queryByText('这份报告没有得到模型的分析结果，只保全了原文证据')).not.toBeInTheDocument())
    view.unmount()

    // 人工修改或确认过的报告不提供重新生成。
    for (const changed of [meta('pending_review', [...original, { version: 2, version_type: 'human_edit' }]), meta('confirmed', original)]) {
      state = ended({ comprehensive_report: preserved, comprehensive_report_meta: changed })
      const next = renderPage(URL, interviewer, POLL)
      const card = await progressCard('综合报告已生成')
      expect(within(card).getByText('这份报告没有得到模型的分析结果，只保全了原文证据').closest('.ant-alert')).toHaveTextContent('请在综合报告中由人工补充结论。')
      expect(queryButton('重新生成', card)).not.toBeInTheDocument()
      next.unmount()
    }
  })
})

describe('AI旁听：区分发言人', () => {
  type State = Record<string, unknown>
  const URL = '/ai-interview/listening?batch=1&candidate=11'
  const QUESTION = '请介绍一下你最近负责的招聘项目。'
  const ANSWER = '我最近负责销售团队的扩招，三个月内招聘了十五名销售代表。'
  const mine = { id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', status: 'linked', text: QUESTION + ANSWER, speaker_status: 'not_requested', speaker_analysis: {} }
  const other = 'ffeeddccbbaa99887766554433221100'
  const turns = (basis = 'inferred', role = 'candidate') => [
    { role: 'interviewer', basis: 'inferred', first: 0, last: 0, text: QUESTION },
    { role, basis, first: 1, last: 1, text: ANSWER },
  ]
  const running = (overrides: State = {}): State => linkedState({
    status: 'running',
    consent_record: { accepted: true, method: '引用前置两阶段合规告知', confirmed_at: '2026-09-28T03:00:00+00:00', recorded_by: 'interviewer-a', notice_version: NOTICE_VERSION },
    transcript: [`[录音 ${mine.id}] ${mine.text}`, `[录音 ${other}] 别的面试官采集的一段对话。它也区分了发言人。`],
    captures: [mine],
    speakers: {
      [mine.id]: { speaker: 'dialogue', roles_status: 'completed', roles_error: '', turns: turns() },
      [other]: { speaker: 'dialogue', roles_status: 'completed', turns: [{ role: 'candidate', basis: 'inferred', first: 0, last: 1, text: '别的面试官采集的一段对话。它也区分了发言人。' }] },
    },
    ...overrides,
  })
  const spoken = async (line: number) => within(await screen.findByLabelText(`第 ${line} 段转写的发言`)).getAllByRole('listitem')
  const choose = async (row: HTMLElement, label: string, option: string) => {
    fireEvent.mouseDown(within(row).getByLabelText(label, { selector: 'input' }))
    fireEvent.click(await screen.findByText(option))
  }

  it('连续对话按面试官和候选人逐段显示，推断的结果标明；可以确认或改正本人采集的录音', async () => {
    const state = running()
    const server = stubServer({
      ...listRoutes,
      'GET /listening/11': () => state,
      'POST /listening/11/turns': body => ({ ok: true, turns: turns('confirmed', String(body.role)) }),
    })
    renderPage(URL)

    const rows = await spoken(1)
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('面试官')).toBeInTheDocument()
    expect(within(rows[0]).getByText('推断')).toBeInTheDocument()
    expect(within(rows[0]).getByText(QUESTION)).toHaveClass('evidence-text')
    expect(within(rows[1]).getByText('候选人')).toBeInTheDocument()
    expect(within(rows[1]).getByText(ANSWER)).toHaveClass('evidence-text')
    expect(screen.getAllByText('连续对话 · 系统按对话语境区分了发言人，标为“推断”的请核对')).toHaveLength(2)
    // 别人采集的录音只能查看。
    const others = await spoken(2)
    expect(within(others[0]).getByText('候选人')).toBeInTheDocument()
    expect(within(others[0]).queryByRole('combobox')).not.toBeInTheDocument()

    await choose(rows[1], '第 1 段转写第 2 段发言的发言人', '确认是候选人')
    await waitFor(() => expect(requestsTo(server, 'POST', '/listening/11/turns')).toHaveLength(1))
    expect(requestsTo(server, 'POST', '/listening/11/turns')[0].body).toEqual({ capture_id: mine.id, first: 1, last: 1, role: 'candidate' })
    expect(await screen.findByText('已确认这段话的发言人')).toBeInTheDocument()
    await waitFor(async () => expect(within((await spoken(1))[1]).getByText('已确认')).toBeInTheDocument())

    await choose((await spoken(1))[1], '第 1 段转写第 2 段发言的发言人', '改为面试官')
    await waitFor(() => expect(requestsTo(server, 'POST', '/listening/11/turns')).toHaveLength(2))
    expect(requestsTo(server, 'POST', '/listening/11/turns')[1].body).toEqual({ capture_id: mine.id, first: 1, last: 1, role: 'interviewer' })
    expect(await screen.findByText('已改正这段话的发言人')).toBeInTheDocument()
    await waitFor(async () => expect(within((await spoken(1))[1]).getByText('面试官')).toBeInTheDocument())
  })

  it('改正被拒绝时说明原因，显示不变', async () => {
    stubServer({
      ...listRoutes,
      'GET /listening/11': () => running(),
      'POST /listening/11/turns': () => Response.json({ detail: '这段话的位置已经变化，请刷新后重试' }, { status: 409 }),
    })
    renderPage(URL)

    await choose((await spoken(1))[1], '第 1 段转写第 2 段发言的发言人', '改为未能判断')
    expect(await screen.findByText('这段话的位置已经变化，请刷新后重试')).toBeInTheDocument()
    expect(within((await spoken(1))[1]).getByText('候选人')).toBeInTheDocument()
    expect(within((await spoken(1))[1]).getByText('推断')).toBeInTheDocument()
  })

  it('旁听结束后只能查看；没有区分出发言人的对话说明原因', async () => {
    stubServer({
      ...listRoutes,
      'GET /listening/11': () => running({
        status: 'completed',
        speakers: {
          [mine.id]: { speaker: 'dialogue', roles_status: 'completed', turns: turns('confirmed') },
          [other]: { speaker: 'dialogue', roles_status: 'failed', roles_error: 'AI服务响应超时，请稍后重试' },
        },
      }),
    })
    renderPage(URL)

    const rows = await spoken(1)
    expect(within(rows[1]).getByText('已确认')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: /发言的发言人/ })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('第 2 段转写的发言')).not.toBeInTheDocument()
    expect(screen.getByText('这段对话没有区分出发言人（AI服务响应超时，请稍后重试），按连续对话处理，引用时请核对是谁说的。')).toBeInTheDocument()
    expect(screen.getByText('别的面试官采集的一段对话。它也区分了发言人。')).toHaveClass('evidence-text')
  })

  it('暂停保存一段录音后区分发言人，结果显示在转写里；整段标注可以改回连续对话', async () => {
    const stop = vi.fn().mockResolvedValue({ capture_id: mine.id, text: mine.text })
    vi.mocked(startSpeech).mockResolvedValue({ captureId: mine.id, stop, abort: vi.fn() })
    let state: State = running({ transcript: [], captures: [], speakers: {} })
    const server = stubServer({
      ...listRoutes,
      'GET /listening/11': () => state,
      'POST /listening/11/start': () => ({ ok: true, mode: 'linked' }),
      'POST /listening/11/capture': () => {
        state = { ...state, transcript: [`[录音 ${mine.id}] ${mine.text}`], captures: [mine], speakers: { [mine.id]: { speaker: 'dialogue' } } }
        return { ok: true }
      },
      'POST /listening/11/roles': () => {
        const speakers = { [mine.id]: { speaker: 'dialogue', roles_status: 'completed', turns: turns() } }
        state = { ...state, speakers }
        return { handled: 1, speakers }
      },
      'POST /listening/11/suggest': () => ({ suggestions: [] }),
      'POST /listening/11/speaker': () => ({ ok: true }),
    })
    renderPage(URL)

    fireEvent.click(await findButton('继续录音'))
    await waitFor(() => expect(button('暂停并保存')).toBeEnabled())
    fireEvent.click(button('暂停并保存'))
    await waitFor(() => expect(requestsTo(server, 'POST', '/listening/11/roles')).toHaveLength(1))
    expect(requestsTo(server, 'POST', '/listening/11/roles')[0].body).toEqual({ capture_id: mine.id })
    expect(await spoken(1)).toHaveLength(2)

    const record = await screen.findByLabelText('第 1 段录音')
    expect(within(record).getByText('面试官和候选人的连续对话')).toBeInTheDocument()
    await choose(record, '第 1 段录音的发言人', '整段是候选人回答')
    await waitFor(() => expect(requestsTo(server, 'POST', '/listening/11/speaker')).toHaveLength(1))
    // 整段标注不需要区分发言人。
    expect(requestsTo(server, 'POST', '/listening/11/roles')).toHaveLength(1)
  })
})
