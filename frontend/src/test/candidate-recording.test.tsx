import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CandidateInterviewPage from '../pages/candidate/CandidateInterviewPage'
import { startSpeech, type SpeechHandle } from '../speech'
import type { Session } from '../types'

vi.mock('../speech', () => ({ startSpeech: vi.fn() }))
const originalDevices = navigator.mediaDevices
const originalCreateUrl = URL.createObjectURL
const originalRevokeUrl = URL.revokeObjectURL
const session: Session = { access_token: 'test', expires_at: 4102444800, username: 'test', display_name: '测试候选人', role: 'candidate', role_label: '候选人', permissions: [] }
vi.setConfig({ testTimeout: 30_000 })
const initialState = {
  id: 1, entry_mode: 'account', candidate: { code: 'TEST', name: '测试候选人' }, status: 'in_progress', asr_mode: 'doubao',
  consented: true, consent_method: 'online', consent_version: 'v1', available_consent_version: 'v1', consent_text: '采集告知正文',
  needs_consent: false, needs_profile: false, profile_complete: true,
  mic_checked: true, current_question: 1, question_version: 1,
  questions: [{ id: 1, sequence: 1, content: '请说明一次质量问题处理经历', dimension: '岗位专业能力', time_limit: 5 }],
  answers: [],
}

class AudioTrack extends EventTarget { stop = vi.fn() }
function createStream() {
  const track = new AudioTrack()
  return { track, stream: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream }
}
class Recorder {
  state = 'inactive'
  mimeType = 'audio/webm'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onstart: (() => void) | null = null
  start() { this.state = 'recording'; this.onstart?.() }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['voice']) }); this.onstop?.() }
}
async function mount() {
  await act(async () => { render(<MemoryRouter><CandidateInterviewPage session={session} onLogout={() => {}} /></MemoryRouter>) })
  await advance(200)
}
function fetchState(state = initialState) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    if (options?.method === 'POST') return Response.json({ ok: true, current_question: 2 })
    return Response.json(state)
  })
}
function mockDevice(getUserMedia: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
}
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
function writes(fetchMock: ReturnType<typeof fetchState>) { return fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST') }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.stubGlobal('MediaRecorder', Recorder)
  vi.stubGlobal('speechSynthesis', { cancel: vi.fn(), speak: vi.fn((utterance: { onend: () => void }) => queueMicrotask(() => utterance.onend())) })
  vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(public text: string) {} })
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:recording-test') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  vi.mocked(startSpeech).mockImplementation(async (_stream, _target, _onText, onError) => ({
    captureId: 'test-capture', stop: vi.fn().mockResolvedValue({ capture_id: 'test-capture', text: '有效回答' }),
    abort: vi.fn(() => onError('录音已中断，已传输内容仍保留')),
  }))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.mocked(startSpeech).mockReset()
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: originalDevices })
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateUrl })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeUrl })
})

describe('候选人录音故障与计时恢复', () => {
  it('采音就绪后仍等待录音器启动，音量反馈不依赖转写结果', async () => {
    let recorder!: Recorder
    vi.stubGlobal('MediaRecorder', class extends Recorder {
      constructor() { super(); recorder = this }
      start() { this.state = 'recording' }
    })
    mockDevice(vi.fn().mockResolvedValue(createStream().stream))
    const fetchMock = fetchState()
    await mount()
    await advance(3000)
    expect(screen.getByRole('timer')).toHaveTextContent('00:05')
    expect(screen.queryByText('正在录音，请清晰作答')).not.toBeInTheDocument()
    act(() => recorder.onstart?.())
    act(() => vi.mocked(startSpeech).mock.calls[0][4]?.onLevel?.(0.05))
    expect(screen.getByRole('meter', { name: '麦克风输入音量' })).toHaveAttribute('aria-valuenow', '57')
    expect(screen.getByText('已收到声音，正在等待识别文字，请继续回答。')).toBeInTheDocument()
    await advance(1250)
    expect(screen.getByRole('timer')).toHaveTextContent('00:04')
    expect(writes(fetchMock)).toHaveLength(0)
  })

  it('退出页面取消尚未完成的采音连接', async () => {
    mockDevice(vi.fn().mockResolvedValue(createStream().stream))
    vi.mocked(startSpeech).mockImplementation(() => new Promise(() => {}))
    fetchState()
    await mount()
    const signal = vi.mocked(startSpeech).mock.calls[0][4]?.signal
    expect(signal?.aborted).toBe(false)
    cleanup()
    expect(signal?.aborted).toBe(true)
  })

  it('麦克风不存在时不扣时不提交，中文提示只显示一次，重试恢复后才计时', async () => {
    const device = createStream()
    const getUserMedia = vi.fn().mockRejectedValueOnce(new DOMException('Requested device not found', 'NotFoundError')).mockResolvedValue(device.stream)
    mockDevice(getUserMedia)
    const fetchMock = fetchState()
    await mount()
    screen.getByText(/未找到可用麦克风/)
    expect(screen.getAllByText(/未找到可用麦克风/)).toHaveLength(1)
    expect(screen.queryByText('Requested device not found')).not.toBeInTheDocument()
    await advance(20_000)
    expect(screen.getByRole('timer')).toHaveTextContent('00:05')
    expect(writes(fetchMock)).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: /重新检测并录音/ }))
    await advance(2250)
    expect(screen.getByRole('timer')).toHaveTextContent('00:03')
    fireEvent.click(screen.getByRole('button', { name: /停止录音/ }))
    await advance(20_000)
    expect(screen.getByRole('timer')).toHaveTextContent('00:03')
    expect(writes(fetchMock)).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: /重新录制/ }))
    await advance(1250)
    expect(screen.getByRole('timer')).toHaveTextContent('00:02')
    expect(screen.queryByText(/录音已中断/)).not.toBeInTheDocument()
  })

  it('等待麦克风权限及语音服务连接时均不计时', async () => {
    const device = createStream()
    let allowDevice!: (stream: MediaStream) => void
    let speechReady!: (speech: SpeechHandle) => void
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(resolve => { allowDevice = resolve }))
    mockDevice(getUserMedia)
    vi.mocked(startSpeech).mockImplementation(() => new Promise(resolve => { speechReady = resolve }))
    const fetchMock = fetchState()
    await mount()
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    await advance(30_000)
    expect(screen.getByRole('timer')).toHaveTextContent('00:05')
    await act(async () => allowDevice(device.stream))
    await advance(30_000)
    expect(screen.getByRole('timer')).toHaveTextContent('00:05')
    expect(writes(fetchMock)).toHaveLength(0)
    await act(async () => speechReady({ captureId: 'test', stop: vi.fn(), abort: vi.fn() }))
    await advance(2250)
    expect(screen.getByRole('timer')).toHaveTextContent('00:03')
  })

  it('麦克风拔出后暂停并保留时间，重新连接不会重置或受到旧回调影响', async () => {
    const first = createStream(), second = createStream()
    mockDevice(vi.fn().mockResolvedValueOnce(first.stream).mockResolvedValue(second.stream))
    const fetchMock = fetchState()
    await mount()
    screen.getByText('正在录音，请清晰作答')
    const oldError = vi.mocked(startSpeech).mock.calls[0][3]
    await advance(2250)
    act(() => first.track.dispatchEvent(new Event('ended')))
    await advance(15_000)
    expect(screen.getByRole('timer')).toHaveTextContent('00:03')
    expect(screen.getByText(/麦克风连接已中断/)).toBeInTheDocument()
    expect(writes(fetchMock)).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: /重新检测并录音/ }))
    await advance(1250)
    act(() => oldError('过期的错误回调'))
    expect(screen.getByRole('timer')).toHaveTextContent('00:02')
    expect(screen.queryByText(/过期的错误回调/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /停止录音/ })).toBeEnabled()
  })

  it('语音服务断开时暂停，不将设备故障自动提交成超时答案', async () => {
    mockDevice(vi.fn().mockResolvedValue(createStream().stream))
    const fetchMock = fetchState()
    await mount()
    screen.getByText('正在录音，请清晰作答')
    await advance(2250)
    act(() => vi.mocked(startSpeech).mock.calls[0][3]('实时语音连接已中断，请重新录制'))
    await advance(20_000)
    expect(screen.getByRole('timer')).toHaveTextContent('00:03')
    expect(screen.getAllByText(/实时语音连接已中断/)).toHaveLength(1)
    expect(screen.getByRole('button', { name: /保存录音并提交回答/ })).toBeDisabled()
    expect(writes(fetchMock)).toHaveLength(0)
  })

  it('实时转写中断但录音仍在保存时只作提示，不打断作答；用录音重新转写得到结果后可以提交', async () => {
    let finishTranscription!: (result: { capture_id: string; text: string; recovered: boolean }) => void
    const stop = vi.fn(() => new Promise<{ capture_id: string; text: string; recovered: boolean }>(resolve => { finishTranscription = resolve }))
    vi.mocked(startSpeech).mockImplementation(async () => ({ captureId: 'test-capture', stop, abort: vi.fn() }))
    mockDevice(vi.fn().mockResolvedValue(createStream().stream))
    const fetchMock = fetchState()
    await mount()
    screen.getByText('正在录音，请清晰作答')
    const notice = vi.mocked(startSpeech).mock.calls[0][4]?.onNotice
    act(() => notice?.('实时转写暂时中断，录音仍在保存；停止录音后会用录音重新转写，请继续。'))
    expect(screen.getByRole('status')).toHaveTextContent('实时转写暂时中断，录音仍在保存')
    // 不算录音故障：继续录音和计时。
    expect(screen.queryByText('录音暂不可用')).not.toBeInTheDocument()
    await advance(1250)
    expect(screen.getByRole('timer')).toHaveTextContent('00:04')
    expect(screen.getByRole('button', { name: /停止录音/ })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: /停止录音/ }))
    act(() => notice?.('正在用已保存的录音重新转写，请稍候…'))
    expect(screen.getByRole('status')).toHaveTextContent('正在用已保存的录音重新转写，请稍候…')
    expect(screen.getByText('正在完成语音转写…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /保存录音并提交回答/ })).toBeDisabled()
    await act(async () => finishTranscription({ capture_id: 'test-capture', text: '用录音重新转写的回答', recovered: true }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /保存录音并提交回答/ })).toBeEnabled()
    expect(writes(fetchMock)).toHaveLength(0)
  })

  it('准备页重新核验当前麦克风，拒绝权限时不进入面试', async () => {
    mockDevice(vi.fn().mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError')))
    const fetchMock = fetchState({ ...initialState, status: 'ready' })
    await mount()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /开始面试/ })) })
    screen.getByText(/麦克风访问被阻止/)
    expect(writes(fetchMock)).toHaveLength(0)
    expect(screen.getByRole('button', { name: /开始面试/ })).toBeEnabled()
  })

  it('正常录音时间耗尽仍提交一次超时，等待和暂停不会禁用真实超时处理', async () => {
    mockDevice(vi.fn().mockResolvedValue(createStream().stream))
    const fetchMock = fetchState()
    await mount()
    screen.getByText('正在录音，请清晰作答')
    await advance(8000)
    const timeouts = writes(fetchMock).filter(([url]) => String(url).endsWith('/answers'))
    expect(timeouts).toHaveLength(1)
    expect(JSON.parse(String(timeouts[0][1]?.body))).toMatchObject({ question_id: 1, timed_out: true })
  })

  it('现场入口进入的面试按同样方式录音和计时，步骤中没有个人信息和合规须知', async () => {
    mockDevice(vi.fn().mockResolvedValue(createStream().stream))
    const fetchMock = fetchState({ ...initialState, entry_mode: 'onsite', consent_method: 'offline_attested', profile_complete: false })
    await mount()
    expect(Array.from(document.querySelectorAll('.candidate-steps .ant-steps-item-title')).map(item => item.textContent)).toEqual(['设备检测', '面试', '完成'])
    screen.getByText('正在录音，请清晰作答')
    expect(vi.mocked(startSpeech).mock.calls[0][1]).toEqual({ kind: 'interview', target_id: 1, question_id: 1, phase: 'main' })
    await advance(2250)
    expect(screen.getByRole('timer')).toHaveTextContent('00:03')
    expect(writes(fetchMock)).toHaveLength(0)
  })

  it('恢复待追问时麦克风缺失也保留完整60秒，重试后正常计时', async () => {
    mockDevice(vi.fn().mockRejectedValueOnce(new DOMException('Requested device not found', 'NotFoundError')).mockResolvedValue(createStream().stream))
    const state = { ...initialState, answers: [{ id: 7, question_id: 1, answer_code: 'A1', transcript: '主体回答', followup_text: '请补充处理依据', followup_answer: '', timed_out: false }] }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(state))
    await mount()
    screen.getByText(/未找到可用麦克风/)
    await advance(70_000)
    expect(screen.getByRole('timer')).toHaveTextContent('01:00')
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: /重新检测并录音/ }))
    await advance(2250)
    expect(screen.getByRole('timer')).toHaveTextContent('00:58')
  })
})
