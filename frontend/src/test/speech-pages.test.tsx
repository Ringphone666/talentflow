import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import ListeningPage from '../pages/interview/ListeningPage'
import CandidateInterviewPage from '../pages/candidate/CandidateInterviewPage'
import { startSpeech } from '../speech'
import { batches, candidatesByBatch, interviewer, linkedState } from './listening-fixtures'
import { requestsTo, stubServer } from './stub-server'

vi.mock('../speech', () => ({ startSpeech: vi.fn() }))
vi.setConfig({ testTimeout: 60_000 })
configure({ asyncUtilTimeout: 15_000 })

// 旁听页面内容较多，按按钮上的文字查找（按角色查找要遍历整页计算名称，明显更慢）。
const button = (text: string) => screen.getByText(text, { selector: 'button span' }).closest('button') as HTMLButtonElement
const mediaDevices = navigator.mediaDevices
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(startSpeech).mockReset()
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices })
})

function renderListening() {
  const Layout = () => <Outlet context={{ session: interviewer }} />
  return render(
    <MemoryRouter initialEntries={['/ai-interview/listening?batch=1&candidate=11']}>
      <Routes><Route element={<Layout />}><Route path="/ai-interview/listening" element={<ListeningPage />} /></Route></Routes>
    </MemoryRouter>,
  )
}

it('沿用候选人在系统内的同意连续旁听，新增转写自动触发建议，暂停时保存并关联转写', async () => {
  const trackStop = vi.fn()
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: trackStop }] }) } })
  const stop = vi.fn().mockResolvedValue({ capture_id: 'capture-1', text: '我先隔离异常批次。' })
  vi.mocked(startSpeech).mockImplementation(async (_stream, _target, onText) => {
    onText('我先隔离异常批次。')
    return { captureId: 'capture-1', stop, abort: vi.fn() }
  })
  let state = linkedState()
  const server = stubServer({
    'GET /batches': () => batches,
    'GET /listening/candidates': () => candidatesByBatch[1],
    'GET /listening/11': () => state,
    'POST /listening/11/start': () => { state = { ...state, status: 'running' }; return { ok: true, mode: 'linked' } },
    'POST /listening/11/capture': () => { state = { ...state, transcript: [...state.transcript, '[录音 capture-1] 我先隔离异常批次。'] }; return { ok: true } },
    'POST /listening/11/suggest': () => ({ suggestions: [] }),
  })
  renderListening()

  await screen.findByText('候选人完成了质量检验员岗位的第一阶段AI面试，能够说明取样和复检流程。')
  expect(screen.getByText('关联第一阶段AI面试报告')).toBeInTheDocument()
  expect(screen.getByText(/长期动机证据不足/)).toBeInTheDocument()
  expect(screen.getByText(/核实长期岗位动机/)).toBeInTheDocument()
  expect(button('开始AI旁听')).toBeEnabled()
  // 系统内已有同意记录：不要求面试官重复确认，也没有已下线的模拟推进按钮。
  expect(screen.queryByLabelText('已当面向候选人告知采集事项并取得同意')).not.toBeInTheDocument()
  expect(screen.queryByText('显示下一段')).not.toBeInTheDocument()

  fireEvent.click(button('开始AI旁听'))
  expect(await screen.findByText('我先隔离异常批次。')).toBeInTheDocument()
  expect(await screen.findByText('麦克风采集中 · 实时转写')).toBeInTheDocument()
  await waitFor(() => expect(button('暂停并保存')).toBeEnabled())
  await waitFor(() => expect(requestsTo(server, 'POST', '/listening/11/suggest').length).toBeGreaterThanOrEqual(1))

  fireEvent.click(button('暂停并保存'))
  await waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(requestsTo(server, 'POST', '/listening/11/capture')).toHaveLength(1))
  expect(requestsTo(server, 'POST', '/listening/11/capture')[0].body).toEqual({ capture_id: 'capture-1' })
  await waitFor(() => expect(requestsTo(server, 'POST', '/listening/11/suggest').length).toBeGreaterThanOrEqual(2))
  expect(trackStop).toHaveBeenCalled()
  // 暂停后可以继续录下一段。
  await waitFor(() => expect(button('继续录音')).toBeEnabled())
  expect(await screen.findByText('我先隔离异常批次。', { selector: '.listening-transcript .evidence-text' })).toBeInTheDocument()
  expect(requestsTo(server, 'POST', '/listening/11/next')).toHaveLength(0)
})

it('候选人等待最终转写才能提交录音标识', async () => {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) } })
  vi.stubGlobal('MediaRecorder', class {
    state = 'inactive'; mimeType = 'audio/webm'
    ondataavailable?: (event: { data: Blob }) => void; onstop?: () => void
    onstart?: () => void
    start() { this.state = 'recording'; this.onstart?.() }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['audio']) }); this.onstop?.() }
  })
  vi.stubGlobal('SpeechSynthesisUtterance', class { onend?: () => void })
  vi.stubGlobal('speechSynthesis', { cancel: vi.fn(), speak: vi.fn((u: { onend?: () => void }) => queueMicrotask(() => u.onend?.())) })
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  let resolve!: (value: { capture_id: string; text: string }) => void
  const final = new Promise<{ capture_id: string; text: string }>(r => { resolve = r })
  vi.mocked(startSpeech).mockResolvedValue({ captureId: 'main-capture', stop: () => final, abort: vi.fn() })
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({
    id: 1, asr_mode: 'doubao', entry_mode: 'account', status: 'in_progress', consented: true, current_question: 1,
    candidate: { code: 'TEST', name: '测试候选人' }, answers: [], mic_checked: true,
    questions: [{ id: 1, sequence: 1, content: '请说明质量异常处理方法', dimension: '岗位专业能力', time_limit: 120 }],
  }))
  render(<MemoryRouter><CandidateInterviewPage session={{ access_token: 'test-token', expires_at: 4102444800, username: 'candidate', role: 'candidate', display_name: '测试', role_label: '候选人', permissions: [] }} onLogout={() => {}} /></MemoryRouter>)
  await waitFor(() => expect(screen.getByRole('button', { name: /停止录音/ })).toBeInTheDocument())
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  expect(screen.queryByText('我理解并同意上述云端识别和本地留存')).not.toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', {name:/停止录音/})).not.toHaveClass('ant-btn-loading'))
  fireEvent.click(screen.getByRole('button', { name: /停止录音/ }))
  expect(screen.getByRole('button', { name: /保存录音并提交回答/ })).toBeDisabled()
  await act(async () => resolve({ capture_id: 'main-capture', text: '先记录异常' }))
  await waitFor(() => expect(screen.getByRole('button', { name: /保存录音并提交回答/ })).toBeEnabled())
  fetchMock
    .mockResolvedValueOnce(Response.json({ answer_id: 1, transcript: '先记录异常', followup: '请补充依据', current_question: 1 }))
    .mockResolvedValueOnce(Response.json({ ok: true, saved: 'recordings/main.webm' }))
  fireEvent.click(screen.getByRole('button', { name: /保存录音并提交回答/ }))
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, options]) => String(url).endsWith('/answers') && JSON.parse(String(options?.body)).capture_id === 'main-capture')).toBe(true))
  expect(await screen.findByText('请补充依据')).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: /保存追问录音并进入下一题/ })).not.toHaveClass('ant-btn-loading'))
})

it('AI旁听完整显示全部待处理的补充提问，不截取为两条', async () => {
  stubServer({
    'GET /batches': () => batches,
    'GET /listening/candidates': () => candidatesByBatch[1],
    'GET /listening/11': () => linkedState({
      status: 'running',
      transcript: ['[录音 capture-0] 请继续说明。'],
      suggestions: [1, 2, 3, 4].map(id => ({ id, text: `建议问题${id}`, status: 'pending', edited_text: '' })),
    }),
  })
  renderListening()
  for (const text of ['建议问题1', '建议问题2', '建议问题3', '建议问题4']) expect(await screen.findByText(text)).toBeVisible()
  expect(screen.getAllByText('备选')).toHaveLength(3)
  expect(screen.getAllByText('优先追问')).toHaveLength(1)
})
