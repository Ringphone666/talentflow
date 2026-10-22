import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSession, setSession } from '../api'
import CandidateInterviewPage from '../pages/candidate/CandidateInterviewPage'
import type { Session } from '../types'
import { requestsTo, stubServer, type ServerMock } from './stub-server'

vi.setConfig({ testTimeout: 30_000 })
configure({ asyncUtilTimeout: 10_000 })

const accountSession: Session = { access_token: 'candidate-token', expires_at: 4102444800, username: 'FLOW-TEST', display_name: '流程测试', role: 'candidate', role_label: '候选人', permissions: ['interview:use'], candidate_id: 7 }
const onsiteSession = { ...accountSession, entry_mode: 'onsite' } as Session
const profile = { phone: '13800000000', email: 'flow@example.com', education: '本科', major: '食品科学', years: '应届生' }
const NOTICE_VERSION = 'INTERVIEW-TWO-STAGE-3.0'
const NOTICE_TEXT = '本次面试仅采集音频，不采集视频；音频发送至语音服务转写。\n\n录音、原始转写和时间信息在本地留存，仅用于面试评价，须人工复核。\n\n你可以不同意并退出，不同意时不会开始采集。'
const initial = {
  id: 77, asr_mode: 'mock', entry_mode: 'account' as 'account' | 'onsite',
  candidate: { code: 'FLOW-TEST', name: '流程测试' }, status: 'ready',
  consented: true, consent_version: NOTICE_VERSION, consent_method: 'online' as 'online' | 'offline_attested',
  available_consent_version: NOTICE_VERSION, consent_text: NOTICE_TEXT,
  needs_consent: false, needs_profile: false, profile_complete: true, mic_checked: true,
  current_question: 1, question_version: 1, questions: [] as unknown[], answers: [] as unknown[],
  profile, started_at: null as string | null, completed_at: null as string | null, notice: '',
}
let state = structuredClone(initial)
let logout = vi.fn()
let server: ServerMock

beforeEach(() => {
  state = structuredClone(initial)
  logout = vi.fn()
  setSession(null, 'candidate')
  server = stubServer({
    'GET /interviews/me': () => structuredClone(state),
    'PUT /interviews/me/profile': body => {
      state.profile = body as typeof profile
      state.needs_profile = false
      return { ok: true, profile: body, profile_complete: true }
    },
    'POST /interviews/77/consent': body => {
      state.consented = Boolean(body.consented)
      state.needs_consent = !state.consented
      if (state.status === 'consent_pending' || state.status === 'consent_declined') state.status = state.consented ? 'mic_check' : 'consent_declined'
      return { ok: true, status: state.status }
    },
    'POST /interviews/77/start': () => { state.status = 'in_progress'; state.started_at = '2026-09-28T03:00:00+00:00'; return { ok: true, status: 'in_progress' } },
    'POST /interviews/77/submit': () => { state.status = 'completed'; return { ok: true, report_id: 9, status: 'generating', message: '' } },
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setSession(null, 'candidate')
})

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname}</output>
}

function mount(session: Session = accountSession) {
  return render(
    <MemoryRouter initialEntries={['/interview']}>
      <Where />
      <Routes>
        <Route path="/interview" element={<CandidateInterviewPage session={session} onLogout={logout} />} />
        <Route path="/interview/onsite" element={<div>候选人名单页面</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

const stepTitles = () => Array.from(document.querySelectorAll('.candidate-steps .ant-steps-item-title')).map(item => item.textContent)
const clickStep = (title: string) => fireEvent.click(screen.getByText(title, { selector: '.ant-steps-item-title' }))
const writes = () => server.mock.calls.filter(([, options]) => options?.method && options.method !== 'GET')

describe('账号登录的候选人：流程保持不变', () => {
  it('依次经过个人信息、合规须知、设备检测，步骤条按这个顺序显示', async () => {
    Object.assign(state, { status: 'consent_pending', consented: false, needs_consent: true, needs_profile: true, profile_complete: false, mic_checked: false, profile: {} })
    mount()
    expect(await screen.findByText('完善个人信息')).toBeVisible()
    expect(stepTitles()).toEqual(['个人信息', '合规须知', '设备检测', '面试', '完成'])

    fireEvent.change(screen.getByLabelText('手机号'), { target: { value: profile.phone } })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: profile.email } })
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '最高学历' }))
    fireEvent.click(await screen.findByText('本科', { selector: '.ant-select-item-option-content' }))
    fireEvent.change(screen.getByLabelText('所学专业'), { target: { value: profile.major } })
    fireEvent.change(screen.getByLabelText('相关经历年限'), { target: { value: profile.years } })
    fireEvent.click(screen.getByRole('button', { name: /保存并继续/ }))

    expect(await screen.findByText('音频及个人信息采集告知')).toBeVisible()
    expect(requestsTo(server, 'PUT', '/interviews/me/profile')[0].body).toEqual(profile)
    expect(screen.getByRole('button', { name: '同意并继续' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '同意并继续' }))

    expect(await screen.findByRole('heading', { name: '麦克风检测' })).toBeVisible()
    expect(requestsTo(server, 'POST', '/interviews/77/consent')[0].body).toEqual({ consented: true, notice_version: NOTICE_VERSION })
    expect(screen.getByRole('button', { name: /开始麦克风检测/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: '上一步：合规须知' })).toBeEnabled()
    // 尚未通过检测，不能跳过。
    expect(screen.queryByRole('button', { name: '检测已通过，继续' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /开始面试/ })).not.toBeInTheDocument()
  })

  it('语音转写没有配置时如实说明，不能检测麦克风，也不能开始面试', async () => {
    Object.assign(state, { asr_mode: 'unavailable', status: 'mic_check', mic_checked: false })
    const first = mount()
    expect(await screen.findByRole('heading', { name: '麦克风检测' })).toBeVisible()
    expect(screen.getByText('暂时不能进行AI面试')).toBeVisible()
    expect(screen.getByText(/语音转写服务尚未配置/)).toBeVisible()
    expect(screen.getByRole('button', { name: /开始麦克风检测/ })).toBeDisabled()
    first.unmount()

    // 设备检测早先已通过、之后服务才不可用：同样不能开始。
    Object.assign(state, { asr_mode: 'unavailable', status: 'ready', mic_checked: true })
    mount()
    expect(await screen.findByRole('heading', { name: '设备已就绪' })).toBeVisible()
    expect(screen.getByText('暂时不能进行AI面试')).toBeVisible()
    expect(screen.getByRole('button', { name: /开始面试/ })).toBeDisabled()
    expect(writes()).toHaveLength(0)
  })

  it('合规须知显示后端下发的告知正文并保留段落，页面不再自带告知内容', async () => {
    Object.assign(state, { status: 'consent_pending', consented: false, needs_consent: true, mic_checked: false })
    mount()
    const copy = await screen.findByLabelText('采集告知正文')
    const paragraphs = Array.from(copy.querySelectorAll('.evidence-text')).map(item => item.textContent)
    expect(paragraphs).toEqual(NOTICE_TEXT.split('\n\n'))
    expect(screen.getByText(NOTICE_VERSION)).toBeInTheDocument()
    for (const text of ['我们将采集什么', '数据如何使用', '你的选择']) expect(screen.queryByText(text)).not.toBeInTheDocument()
    expect(copy).not.toHaveTextContent('不进行面部、声纹、情绪或敏感属性分析')
  })

  it('读取不到告知正文时不能确认同意', async () => {
    Object.assign(state, { status: 'consent_pending', consented: false, needs_consent: true, mic_checked: false, consent_text: '' })
    mount()
    expect(await screen.findByText('未能读取采集告知内容')).toBeVisible()
    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(screen.getByRole('button', { name: '同意并继续' })).toBeDisabled()
  })

  it('完成后没有重考入口，刷新和过期准备标志都不会重新进入面试', async () => {
    state.status = 'completed'
    state.needs_consent = true
    state.needs_profile = true
    const first = mount()
    expect(await screen.findByText('面试已提交')).toBeVisible()
    expect(screen.queryByRole('button', { name: /重新开始面试|开始面试/ })).not.toBeInTheDocument()
    clickStep('个人信息')
    expect(screen.queryByText('完善个人信息')).not.toBeInTheDocument()
    expect(screen.queryByText('音频及个人信息采集告知')).not.toBeInTheDocument()
    first.unmount()
    mount()
    expect(await screen.findByText('面试已提交')).toBeVisible()
    // 账号登录不自动跳转，由候选人自己返回登录页。
    expect(screen.queryByText(/秒后自动返回/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '返回登录' }))
    expect(logout).toHaveBeenCalledOnce()
    expect(screen.getByTestId('where')).toHaveTextContent('/interview')
    expect(writes()).toHaveLength(0)
  })

  it('开始前可逐步返回，修改资料保存后按顺序继续并保留检测结果', async () => {
    mount()
    await screen.findByText('设备已就绪')
    expect(stepTitles()).toEqual(['个人信息', '合规须知', '设备检测', '面试', '完成'])
    fireEvent.click(screen.getByRole('button', { name: '重新检测麦克风' }))
    expect(screen.getByRole('heading', { name: '麦克风检测' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '上一步：合规须知' }))
    fireEvent.click(screen.getByRole('button', { name: '上一步：个人信息' }))
    expect(screen.getByLabelText('手机号')).toHaveValue(profile.phone)
    fireEvent.change(screen.getByLabelText('所学专业'), { target: { value: '制造工程' } })
    clickStep('设备检测')
    expect(screen.getByText('完善个人信息')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /保存并继续/ }))
    await screen.findByText('音频及个人信息采集告知')
    expect(state.profile.major).toBe('制造工程')
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '同意并继续' }))
    await screen.findByRole('heading', { name: '麦克风检测' })
    fireEvent.click(screen.getByRole('button', { name: '检测已通过，继续' }))
    expect(screen.getByText('设备已就绪')).toBeVisible()
    clickStep('个人信息')
    expect(screen.getByLabelText('所学专业')).toHaveValue('制造工程')
    expect(server.mock.calls.some(([url]) => String(url).endsWith('/reset'))).toBe(false)
  })

  it('资料尚未完成时不能通过步骤条跳过前置检查', async () => {
    state.needs_profile = true
    mount()
    await screen.findByText('完善个人信息')
    for (const title of ['合规须知', '设备检测', '面试', '完成']) clickStep(title)
    expect(screen.getByText('完善个人信息')).toBeVisible()
    expect(screen.queryByRole('button', { name: /开始面试/ })).not.toBeInTheDocument()
    expect(server.mock.calls).toHaveLength(1)
  })

  it('正在开始时锁住返回，正式开始后刷新仍不能回到准备步骤', async () => {
    let release!: (value: MediaStream) => void
    const originalDevices = navigator.mediaDevices
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(() => new Promise(resolve => { release = resolve })) } })
    vi.stubGlobal('MediaRecorder', class {})
    try {
      const first = mount()
      await screen.findByText('设备已就绪')
      fireEvent.click(screen.getByRole('button', { name: /开始面试/ }))
      expect(screen.getByRole('button', { name: '重新检测麦克风' })).toBeDisabled()
      clickStep('个人信息')
      expect(screen.getByText('设备已就绪')).toBeVisible()
      await act(async () => release({ getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream))
      await screen.findByText('全部题目已完成')
      first.unmount()
      mount()
      await screen.findByText('全部题目已完成')
      clickStep('个人信息')
      expect(screen.queryByText('完善个人信息')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /上一步|重新检测麦克风|开始面试/ })).not.toBeInTheDocument()
      expect(requestsTo(server, 'POST', '/interviews/77/start')).toHaveLength(1)
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: originalDevices })
    }
  })

  it('面试中补充确认告知仅恢复原进度，不开放前置准备', async () => {
    state.status = 'in_progress'
    state.started_at = '2026-09-28T03:00:00+00:00'
    state.needs_consent = true
    mount()
    await screen.findByText('音频及个人信息采集告知')
    expect(screen.queryByRole('button', { name: /上一步/ })).not.toBeInTheDocument()
    clickStep('个人信息')
    expect(screen.queryByText('完善个人信息')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '同意并继续' }))
    await screen.findByText('全部题目已完成')
    expect(state.status).toBe('in_progress')
    expect(screen.queryByRole('heading', { name: '麦克风检测' })).not.toBeInTheDocument()
  })

  it('不同意并退出会退出登录，不能继续进入设备检测', async () => {
    state.status = 'consent_pending'
    state.consented = false
    mount()
    await screen.findByText('音频及个人信息采集告知')
    fireEvent.click(screen.getByRole('button', { name: '不同意并退出' }))
    await waitFor(() => expect(logout).toHaveBeenCalledOnce())
    expect(state.consented).toBe(false)
    expect(requestsTo(server, 'POST', '/interviews/77/consent')[0].body).toEqual({ consented: false, notice_version: NOTICE_VERSION })
    expect(screen.queryByRole('heading', { name: '麦克风检测' })).not.toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent('/interview')
  })

  it('面试信息读取失败时说明原因，可以重新读取', async () => {
    let fail = true
    server.mockImplementation(async () => fail
      ? Response.json({ detail: '该候选账号尚未绑定面试记录' }, { status: 404 })
      : Response.json(structuredClone(state)))
    mount()
    expect(await screen.findByText('暂时无法读取面试信息')).toBeVisible()
    expect(screen.getByText('该候选账号尚未绑定面试记录')).toBeVisible()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
    expect(await screen.findByText('设备已就绪')).toBeVisible()
  })
})

describe('提交面试', () => {
  beforeEach(() => {
    Object.assign(state, { status: 'in_progress', started_at: '2026-09-28T03:00:00+00:00', current_question: 1, questions: [], answers: [] })
  })

  it('提交后立即显示完成页，不等待也不读取报告', async () => {
    mount()
    expect(await screen.findByText('全部题目已完成')).toBeVisible()
    const before = server.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /提交面试/ }))

    const done = (await screen.findByText('面试已提交')).closest('.ant-card') as HTMLElement
    expect(done).toHaveTextContent('你的回答已全部提交，本次面试到此结束，不需要等待。面试结果由招聘工作人员另行通知。')
    // 只发出提交这一个请求：不轮询、不读取报告、不重新读取面试状态。
    const after = server.mock.calls.slice(before)
    expect(after).toHaveLength(1)
    expect(String(after[0][0])).toMatch(/\/interviews\/77\/submit$/)
    expect(after[0][1]?.method).toBe('POST')
    expect(server.mock.calls.some(([url]) => /report/.test(String(url)))).toBe(false)
    // 没有等待提示，也不向候选人显示报告内容或评分。
    expect(done.querySelector('.ant-spin, .ant-progress')).toBeNull()
    expect(done).not.toHaveTextContent(/报告|评分|匹配度|生成中/)
    expect(screen.queryByText('全部题目已完成')).not.toBeInTheDocument()
    expect(stepTitles()).toEqual(['个人信息', '合规须知', '设备检测', '面试', '完成'])
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(server.mock.calls).toHaveLength(before + 1)
  })

  it('提交未成功时说明原因，可以重新提交', async () => {
    let attempts = 0
    server.mockImplementation(async (input, options) => {
      if (String(input).endsWith('/submit') && options?.method === 'POST') {
        attempts += 1
        return attempts === 1 ? Response.json({ detail: '服务暂时不可用' }, { status: 503 }) : Response.json({ ok: true, report_id: 9, status: 'generating' })
      }
      return Response.json(structuredClone(state))
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /提交面试/ }))
    expect(await screen.findByText('面试尚未提交')).toBeVisible()
    expect(screen.queryByText('面试已提交')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /提交面试/ }))
    expect(await screen.findByText('面试已提交')).toBeVisible()
    expect(attempts).toBe(2)
  })
})

describe('线下集中面试现场入口进入的候选人', () => {
  beforeEach(() => {
    setSession(onsiteSession, 'candidate')
    Object.assign(state, { entry_mode: 'onsite', consent_method: 'offline_attested', status: 'mic_check', mic_checked: false, profile: {}, profile_complete: false, needs_profile: false, needs_consent: false, consented: true })
  })

  it('现场已取得同意：不填写个人信息、不显示合规须知，直接进入设备检测', async () => {
    mount(onsiteSession)
    expect(await screen.findByRole('heading', { name: '麦克风检测' })).toBeVisible()
    expect(stepTitles()).toEqual(['设备检测', '面试', '完成'])
    expect(screen.queryByText('完善个人信息')).not.toBeInTheDocument()
    expect(screen.queryByText('音频及个人信息采集告知')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /上一步/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /开始麦克风检测/ })).toBeEnabled()
    expect(writes()).toHaveLength(0)
  })

  it('现场已取得同意且设备检测通过后可以直接开始面试', async () => {
    Object.assign(state, { status: 'ready', mic_checked: true })
    const originalDevices = navigator.mediaDevices
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) } })
    vi.stubGlobal('MediaRecorder', class {})
    try {
      mount(onsiteSession)
      expect(await screen.findByText('设备已就绪')).toBeVisible()
      expect(stepTitles()).toEqual(['设备检测', '面试', '完成'])
      fireEvent.click(screen.getByRole('button', { name: /开始面试/ }))
      expect(await screen.findByText('全部题目已完成')).toBeVisible()
      expect(writes().map(([url]) => new URL(String(url)).pathname)).toEqual(['/api/interviews/77/start'])
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: originalDevices })
    }
  })

  it('现场未确认同意：先阅读合规须知，仍不填写个人信息', async () => {
    Object.assign(state, { consent_method: 'online', status: 'consent_pending', consented: false, needs_consent: true })
    mount(onsiteSession)
    expect(await screen.findByText('音频及个人信息采集告知')).toBeVisible()
    expect(stepTitles()).toEqual(['合规须知', '设备检测', '面试', '完成'])
    expect(screen.queryByText('完善个人信息')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /上一步/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '同意并继续' }))
    expect(await screen.findByRole('heading', { name: '麦克风检测' })).toBeVisible()
    expect(requestsTo(server, 'POST', '/interviews/77/consent')[0].body).toEqual({ consented: true, notice_version: NOTICE_VERSION })
    expect(requestsTo(server, 'PUT', '/interviews/me/profile')).toHaveLength(0)
    expect(screen.getByRole('button', { name: '上一步：合规须知' })).toBeEnabled()
  })

  it('不同意采集时回到候选人名单，不显示账号登录页', async () => {
    Object.assign(state, { consent_method: 'online', status: 'consent_pending', consented: false, needs_consent: true })
    mount(onsiteSession)
    await screen.findByText('音频及个人信息采集告知')
    fireEvent.click(screen.getByRole('button', { name: '不同意并退出' }))
    expect(await screen.findByText('候选人名单页面')).toBeVisible()
    expect(screen.getByTestId('where')).toHaveTextContent('/interview/onsite')
    expect(logout).not.toHaveBeenCalled()
    expect(getSession('candidate')).toBeNull()
  })

  it('退出按钮回到候选人名单并清除本次会话', async () => {
    mount(onsiteSession)
    await screen.findByRole('heading', { name: '麦克风检测' })
    expect(getSession('candidate')?.username).toBe('FLOW-TEST')
    fireEvent.click(screen.getByRole('button', { name: /退出/ }))
    expect(await screen.findByText('候选人名单页面')).toBeVisible()
    expect(screen.getByTestId('where')).toHaveTextContent('/interview/onsite')
    expect(logout).not.toHaveBeenCalled()
    expect(getSession('candidate')).toBeNull()
  })

  it('提交后立即显示完成页，可以马上返回候选人名单', async () => {
    Object.assign(state, { status: 'in_progress', started_at: '2026-09-28T03:00:00+00:00', mic_checked: true })
    mount(onsiteSession)
    fireEvent.click(await screen.findByRole('button', { name: /提交面试/ }))
    const done = (await screen.findByText('面试已提交')).closest('.ant-card') as HTMLElement
    expect(within(done).getByRole('status')).toHaveTextContent('10 秒后自动返回候选人名单')
    expect(within(done).queryByRole('button', { name: '返回登录' })).not.toBeInTheDocument()
    expect(requestsTo(server, 'GET', '/interviews/me')).toHaveLength(1)
    fireEvent.click(within(done).getByRole('button', { name: '返回候选人名单' }))
    expect(await screen.findByText('候选人名单页面')).toBeVisible()
    expect(logout).not.toHaveBeenCalled()
    expect(getSession('candidate')).toBeNull()
  })

  it('完成页倒计时结束后自动返回候选人名单', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    state.status = 'completed'
    await act(async () => { mount(onsiteSession) })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    const countdown = () => within(screen.getByText('面试已提交').closest('.ant-card') as HTMLElement).getByRole('status')
    expect(countdown()).toHaveTextContent('10 秒后自动返回候选人名单')
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(countdown()).toHaveTextContent('6 秒后自动返回候选人名单')
    expect(screen.getByTestId('where')).toHaveTextContent('/interview')
    expect(getSession('candidate')).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(screen.getByText('候选人名单页面')).toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent('/interview/onsite')
    expect(getSession('candidate')).toBeNull()
    expect(logout).not.toHaveBeenCalled()
  })

  it('由现场入口建立的会话即使面试记录是账号方式，也回到候选人名单', async () => {
    // 候选人先用账号开始了面试，之后在现场设备上从名单继续。
    Object.assign(state, { entry_mode: 'account', consent_method: 'online', status: 'completed' })
    mount(onsiteSession)
    const done = (await screen.findByText('面试已提交')).closest('.ant-card') as HTMLElement
    fireEvent.click(within(done).getByRole('button', { name: '返回候选人名单' }))
    expect(await screen.findByText('候选人名单页面')).toBeVisible()
  })
})
