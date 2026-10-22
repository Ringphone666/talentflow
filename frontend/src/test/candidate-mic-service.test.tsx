import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import CandidateInterviewPage from '../pages/candidate/CandidateInterviewPage'
import { startSpeech } from '../speech'
import type { Session } from '../types'

vi.mock('../speech', () => ({ startSpeech: vi.fn() }))
vi.setConfig({ testTimeout: 30_000 })
const session: Session = { access_token: 'test', expires_at: 4102444800, username: 'mic-test', display_name: '设备测试', role: 'candidate', role_label: '候选人', permissions: [] }
const initialState = { id: 7, entry_mode: 'account', candidate: { code: 'TEST', name: '设备测试' }, status: 'mic_check', asr_mode: 'doubao',
  consented: true, consent_method: 'online', consent_version: 'v1', available_consent_version: 'v1', consent_text: '采集告知正文',
  needs_consent: false, needs_profile: false, profile_complete: true,
  mic_checked: false, current_question: 1, question_version: 1, questions: [], answers: [] }
let state = { ...initialState }
const originalDevices = navigator.mediaDevices
let fetchMock: MockInstance<typeof fetch>
let stopTrack: ReturnType<typeof vi.fn>
let closeContext: ReturnType<typeof vi.fn>
let finishSpeech: ReturnType<typeof vi.fn>
let audioLevel = 0.06

beforeEach(() => {
  vi.useFakeTimers()
  state = { ...initialState }
  stopTrack = vi.fn()
  closeContext = vi.fn()
  audioLevel = 0.06
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }),
  } })
  vi.stubGlobal('MediaRecorder', class { onstop?: () => void; start() {} stop() { this.onstop?.() } })
  vi.stubGlobal('SpeechRecognition', undefined)
  vi.stubGlobal('webkitSpeechRecognition', undefined)
  vi.stubGlobal('AudioContext', class {
    state = 'running'
    resume = vi.fn()
    close = closeContext
    createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() } }
    createAnalyser() {
      let frame = 0
      return { fftSize: 2048, getFloatTimeDomainData(samples: Float32Array) { samples.fill(frame++ < 10 ? 0.001 : audioLevel) } }
    }
  })
  finishSpeech = vi.fn().mockResolvedValue({ capture_id: 'mic-test', text: '麦克风测试，一二三' })
  vi.mocked(startSpeech).mockResolvedValue({ captureId: 'mic-test', stop: finishSpeech, abort: vi.fn() })
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (options?.method !== 'POST') return Response.json(state)
    // 后端在检测通过后把面试状态改为“待开始”。
    if (String(url).endsWith('/mic-check')) state = { ...state, status: 'ready', mic_checked: true }
    return Response.json({ ok: true, status: state.status })
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.mocked(startSpeech).mockReset()
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: originalDevices })
})
async function startTest() {
  await act(async () => { render(<MemoryRouter><CandidateInterviewPage session={session} onLogout={() => {}} /></MemoryRouter>) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /开始麦克风检测/ })) })
  await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
}
function micWrites() { return fetchMock.mock.calls.filter(([url, options]) => String(url).endsWith('/mic-check') && options?.method === 'POST') }
function stepTitles() { return Array.from(document.querySelectorAll('.candidate-steps .ant-steps-item-title')).map(item => item.textContent) }

it('浏览器无自带识别能力时仍使用项目语音服务完成检测', async () => {
  await startTest()
  expect(startSpeech).toHaveBeenCalledWith(expect.anything(), { kind: 'mic_check', target_id: 7 }, expect.any(Function), expect.any(Function), { onNotice: expect.any(Function) })
  expect(finishSpeech).toHaveBeenCalledOnce()
  expect(micWrites()).toHaveLength(1)
  expect(JSON.parse(String(micWrites()[0][1]?.body))).toMatchObject({ passed: true, speech_text: '麦克风测试，一二三' })
  expect(stopTrack).toHaveBeenCalled()
  expect(closeContext).toHaveBeenCalled()
  // 检测通过后仍在“设备检测”这一步，确认设备就绪后开始面试。
  expect(screen.getByText('设备已就绪')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /开始面试/ })).toBeEnabled()
  expect(stepTitles()).toEqual(['个人信息', '合规须知', '设备检测', '面试', '完成'])
})
it('现场入口且现场已取得同意时，从设备检测开始，通过后即可开始面试', async () => {
  state = { ...initialState, entry_mode: 'onsite', consent_method: 'offline_attested', profile_complete: false }
  await startTest()
  expect(startSpeech).toHaveBeenCalledWith(expect.anything(), { kind: 'mic_check', target_id: 7 }, expect.any(Function), expect.any(Function), { onNotice: expect.any(Function) })
  expect(micWrites()).toHaveLength(1)
  expect(screen.getByText('设备已就绪')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /开始面试/ })).toBeEnabled()
  expect(stepTitles()).toEqual(['设备检测', '面试', '完成'])
  const writes = fetchMock.mock.calls.filter(([, options]) => options?.method && options.method !== 'GET').map(([url]) => new URL(String(url)).pathname)
  expect(writes).toEqual(['/api/interviews/7/mic-check'])
})
it('服务返回错误口令不能通过', async () => {
  finishSpeech.mockResolvedValue({ capture_id: 'mic-test', text: '其他内容' })
  await startTest()
  expect(micWrites()).toHaveLength(0)
  expect(screen.getByText(/未识别到指定测试口令/)).toBeInTheDocument()
  expect(screen.queryByText('设备已就绪')).not.toBeInTheDocument()
})
it('无持续人声时不能仅凭文字识别通过', async () => {
  audioLevel = 0.001
  await startTest()
  expect(micWrites()).toHaveLength(0)
  expect(screen.getByText(/未检测到持续有效的人声/)).toBeInTheDocument()
})
it('项目语音服务连接失败时保留明确错误并释放麦克风', async () => {
  vi.mocked(startSpeech).mockRejectedValue(new Error('语音服务连接超时'))
  await startTest()
  expect(micWrites()).toHaveLength(0)
  expect(screen.getByText('语音服务连接超时')).toBeInTheDocument()
  expect(stopTrack).toHaveBeenCalled()
  expect(screen.getByRole('button', { name: /开始麦克风检测/ })).toBeEnabled()
})
