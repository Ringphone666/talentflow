import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LoginPage from '../pages/candidate/LoginPage'
import CandidateInterviewPage from '../pages/candidate/CandidateInterviewPage'
import type { Session } from '../types'

const originalMediaDevices = navigator.mediaDevices
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: originalMediaDevices })
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
  localStorage.clear()
  document.cookie = 'talentflow-session=; Path=/; Max-Age=0; SameSite=Lax'
})

describe('候选人登录与面试', () => {
  it('使用独立账号和密码登录，不在登录页选择人员', async () => {
    const user = { username: 'candidate', display_name: '应聘者', role: 'candidate', role_label: '候选人', permissions: ['interview:use'] }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(user), { status: 200 }))
    const onLogin = vi.fn()
    render(<MemoryRouter><LoginPage onLogin={onLogin} /></MemoryRouter>)
    fireEvent.change(screen.getByPlaceholderText('请输入账号'), { target: { value: 'admin' } })
    fireEvent.change(screen.getByPlaceholderText('请输入密码'), { target: { value: 'ChangeMe123!' } })
    fireEvent.click(screen.getByRole('button', { name: /登录/ }))
    await waitFor(() => expect(onLogin).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/auth/login'), expect.objectContaining({ method: 'POST' }))
  })

  it('题目播报结束后自动录音且录音期间倒计时继续', async () => {
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })

    class MediaRecorderMock {
      state = 'inactive'
      mimeType = 'audio/webm'
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      onstart: (() => void) | null = null
      start() { this.state = 'recording'; queueMicrotask(() => this.onstart?.()) }
      stop() { this.state = 'inactive'; this.onstop?.() }
    }
    class SpeechSynthesisUtteranceMock {
      lang = ''
      rate = 1
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(public text: string) {}
    }
    vi.stubGlobal('MediaRecorder', MediaRecorderMock)
    vi.stubGlobal('SpeechSynthesisUtterance', SpeechSynthesisUtteranceMock)
    vi.stubGlobal('speechSynthesis', {
      cancel: vi.fn(),
      speak: vi.fn((utterance: SpeechSynthesisUtteranceMock) => queueMicrotask(() => utterance.onend?.())),
    })

    const questionText = '请说明一次你处理质量异常的具体经历。'
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      id: 1,
      candidate: { code: 'CAND-TEST-001', name: '测试候选人' },
      status: 'in_progress',
      consented: true,
      consent_version: 'v1',
      mic_checked: true,
      current_question: 1,
      question_version: 1,
      questions: [{ id: 1, sequence: 1, content: questionText, dimension: '岗位专业能力', time_limit: 5 }],
      answers: [],
      notice: '',
    }), { status: 200 }))

    const candidate: Session = { access_token: 'test-token', expires_at: 4102444800, username: 'candidate', display_name: '测试候选人', role: 'candidate', role_label: '候选人', permissions: [] }
    render(<MemoryRouter><CandidateInterviewPage session={candidate} onLogout={() => {}} /></MemoryRouter>)

    expect(await screen.findByText(questionText)).toBeInTheDocument()
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1))
    expect(screen.getByText('正在录音，请清晰作答')).toBeInTheDocument()
    expect(screen.getByText(/00:05/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(/00:04/)).toBeInTheDocument(), { timeout: 1800 })
  })

  it('主体题、动态追问、下一题依次播报且新题不会被旧追问取消', async () => {
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test-audio') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })

    class MediaRecorderMock {
      state = 'inactive'
      mimeType = 'audio/webm'
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      onstart: (() => void) | null = null
      start() { this.state = 'recording'; queueMicrotask(() => this.onstart?.()) }
      stop() {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob(['voice']) })
        this.onstop?.()
      }
    }
    class SpeechSynthesisUtteranceMock {
      lang = ''
      rate = 1
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(public text: string) {}
    }
    vi.stubGlobal('MediaRecorder', MediaRecorderMock)
    vi.stubGlobal('SpeechSynthesisUtterance', SpeechSynthesisUtteranceMock)
    const secondQuestion = '请说明你如何与同事沟通处理分歧。'
    let currentUtterance: SpeechSynthesisUtteranceMock | null = null
    const spoken: string[] = []
    vi.stubGlobal('speechSynthesis', {
      cancel: vi.fn(() => { currentUtterance = null }),
      speak: vi.fn((utterance: SpeechSynthesisUtteranceMock) => {
        currentUtterance = utterance
        spoken.push(utterance.text)
        if (utterance.text !== secondQuestion) queueMicrotask(() => {
          if (currentUtterance === utterance) utterance.onend?.()
        })
      }),
    })

    const questionText = '请说明一次你处理质量异常的具体经历。'
    const followupText = '你刚才提到“我先检查温度记录”。请说明当时使用的判断标准。'
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 1,
        candidate: { code: 'CAND-TEST-001', name: '测试候选人' },
        status: 'in_progress',
        consented: true,
        consent_version: 'v1',
        mic_checked: true,
        current_question: 1,
        question_version: 1,
        questions: [{ id: 1, sequence: 1, content: questionText, dimension: '岗位专业能力', time_limit: 30 }],
        answers: [],
        notice: '',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        answer_id: 10,
        transcript: '我先检查温度记录，再请同事复测。',
        followup: followupText,
        followup_basis: '我先检查温度记录',
        current_question: 1,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, saved: 'recordings/main.webm' }), { status: 200 }))
      .mockResolvedValueOnce(Response.json({ ok: true, current_question: 2 }))
      .mockResolvedValueOnce(Response.json({
        id: 1, candidate: { code: 'CAND-TEST-001', name: '测试候选人' }, status: 'in_progress',
        consented: true, current_question: 2, question_version: 1, mic_checked: true,
        questions: [{ id: 1, sequence: 1, content: questionText, dimension: '岗位专业能力', time_limit: 30 }, { id: 2, sequence: 2, content: secondQuestion, dimension: '沟通表达', time_limit: 90 }],
        answers: [{ id: 10, question_id: 1, transcript: '我先检查温度记录', followup_text: followupText, followup_answer: '按检查表执行' }],
      }))

    const candidate: Session = { access_token: 'test-token', expires_at: 4102444800, username: 'candidate', display_name: '测试候选人', role: 'candidate', role_label: '候选人', permissions: [] }
    render(<MemoryRouter><CandidateInterviewPage session={candidate} onLogout={() => {}} /></MemoryRouter>)

    await waitFor(() => expect(screen.getByText('正在录音，请清晰作答')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', {name:/停止录音/})).not.toHaveClass('ant-btn-loading'))
    fireEvent.click(screen.getByRole('button', { name: /停止录音/ }))
    await waitFor(() => expect(screen.getByText('录音已完成，可试听或重新录制')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /保存录音并提交回答/ }))

    expect(await screen.findByText(followupText)).toBeInTheDocument()
    expect(screen.getByText('追问依据：我先检查温度记录')).toBeInTheDocument()
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2))
    expect(screen.getByText('正在录制动态追问回答')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', {name:/停止录音/})).not.toHaveClass('ant-btn-loading'))
    fireEvent.click(screen.getByRole('button', { name: /停止录音/ }))
    fireEvent.click(screen.getByRole('button', { name: /保存追问录音并进入下一题/ }))
    expect(await screen.findByText(secondQuestion)).toBeInTheDocument()
    expect(spoken).toEqual([questionText, followupText, secondQuestion])
    expect((currentUtterance as SpeechSynthesisUtteranceMock | null)?.text).toBe(secondQuestion)
    expect(getUserMedia).toHaveBeenCalledTimes(2)
    await act(async () => { currentUtterance?.onend?.() })
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(3))
    expect(screen.getByText('正在录音，请清晰作答')).toBeInTheDocument()
  })
})
