import {
  AudioOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  LogoutOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  RobotOutlined,
  SendOutlined,
  SoundOutlined,
} from '@ant-design/icons'
import { Alert, Button, Card, Form, Progress, Space, Spin, Steps, Tag, Typography, message } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError, send, setSession } from '../../api'
import { startSpeech, type SpeechHandle } from '../../speech'
import { Brand, EnvironmentBadge } from '../../components/Brand'
import { CandidateProfileForm } from '../../components/CandidateProfileForm'
import { evaluateMicLevels, validateMicPhrase } from '../../micDetection'
import { recordingErrorMessage } from '../../recordingErrors'
import type { Session } from '../../types'
import { flowSteps, isPreparing, reachedStep, STEP_TITLES, type InterviewState, type StepKey } from './candidateFlow'
import { CompletionCard } from './CompletionCard'
import { ConsentCard } from './ConsentCard'
import { ONSITE_PATH, type CandidateSession } from './onsiteEntry'
import { ScreenControls } from './ScreenControls'
import './candidateRecording.css'

interface MicSpeechRecognition {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((event: { resultIndex?: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}
type MicSpeechRecognitionCtor = new () => MicSpeechRecognition

interface AnswerResult { answer_id: number; transcript: string; followup: string | null; followup_basis?: string | null; current_question: number }

const FOLLOWUP_TIME_LIMIT = 60

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

export default function CandidateInterviewPage({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const navigate = useNavigate()
  const [interview, setInterview] = useState<InterviewState | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [agreed, setAgreed] = useState(false)
  // 候选人主动返回的较早步骤；不能超过服务端允许到达的步骤。
  const [chosenStep, setChosenStep] = useState<StepKey | null>(null)
  // 设备检测已通过后，候选人要求重新检测麦克风。
  const [recheckMic, setRecheckMic] = useState(false)
  const [savingConsent, setSavingConsent] = useState(false)
  const [consentError, setConsentError] = useState('')
  const [profileForm] = Form.useForm()
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileError, setProfileError] = useState('')
  const profileSaving = useRef(false)
  const [micTesting, setMicTesting] = useState(false)
  const [micTestStage, setMicTestStage] = useState('')
  const [micRecognizedText, setMicRecognizedText] = useState('')
  const [recording, setRecording] = useState(false)
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null)
  const [recordedUrl, setRecordedUrl] = useState('')
  const [autoStartPending, setAutoStartPending] = useState(false)
  const [requestingMic, setRequestingMic] = useState(false)
  const [recordingStage, setRecordingStage] = useState('')
  const [inputLevel, setInputLevel] = useState(0)
  const [receivedSound, setReceivedSound] = useState(false)
  const [recordingError, setRecordingError] = useState('')
  const [startingInterview, setStartingInterview] = useState(false)
  const [timerRunning, setTimerRunning] = useState(false)
  const [timerStarted, setTimerStarted] = useState(false)
  const [remaining, setRemaining] = useState(90)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [transcript, setTranscript] = useState('')
  const [storedFollowup, setFollowup] = useState<{ questionId: number; answerId: number; text: string; basis: string } | null>(null)
  const question = interview?.questions.find(item => item.sequence === interview.current_question)
  const followup = storedFollowup?.questionId === question?.id ? storedFollowup : null
  const mediaRecorder = useRef<MediaRecorder | null>(null)
  const mediaStream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const timeoutHandled = useRef(false)
  const answerSubmission = useRef(false)
  const activeQuestionId = useRef<number | null>(null)
  const deadline = useRef<number | null>(null)
  const remainingMs = useRef(90_000)
  const recordingAttempt = useRef(0)
  const recordingRequest = useRef(false)
  const discardRecording = useRef(false)
  const speech = useRef<SpeechHandle | null>(null)
  const speechStart = useRef<AbortController | null>(null)
  const [captureId, setCaptureId] = useState('')
  const [liveText, setLiveText] = useState('')
  const [recognizing, setRecognizing] = useState(false)
  const [speechNotice, setSpeechNotice] = useState('')
  const speechContext = useRef({ id: 0, enabled: false, phase: 'main', consented: false })
  const renewingConsent = interview?.status === 'in_progress' && Boolean(interview.needs_consent)
  speechContext.current = { id: interview?.id || 0, enabled: interview?.asr_mode === 'doubao', phase: followup ? 'followup' : 'main', consented: interview?.consented === true && !interview.needs_consent }
  // 现场共用设备上，退出和完成后都回到候选人名单，而不是账号登录页。
  const onsite = (session as CandidateSession).entry_mode === 'onsite' || interview?.entry_mode === 'onsite'

  const leave = useCallback(() => {
    if (!onsite) {
      onLogout()
      return
    }
    setSession(null, 'candidate')
    navigate(ONSITE_PATH, { replace: true })
  }, [onsite, onLogout, navigate])

  const pauseAnswerTimer = useCallback(() => {
    if (deadline.current !== null) remainingMs.current = Math.max(0, deadline.current - Date.now())
    deadline.current = null
    setRemaining(Math.ceil(remainingMs.current / 1000))
    setTimerRunning(false)
  }, [])

  const resumeAnswerTimer = useCallback(() => {
    deadline.current = Date.now() + remainingMs.current
    setTimerRunning(true)
    setTimerStarted(true)
  }, [])

  const load = useCallback(async () => {
    try {
      const next = await api<InterviewState>('/interviews/me')
      const current = next.questions.find(item => item.sequence === next.current_question)
      const pending = next.answers.find(answer => answer.question_id === current?.id && answer.followup_text && !answer.followup_answer)
      setInterview(next)
      setLoadError('')
      if (next.profile) profileForm.setFieldsValue(next.profile)
      setFollowup(pending ? { questionId: pending.question_id, answerId: pending.id, text: pending.followup_text, basis: pending.transcript.slice(0, 34) } : null)
      setTranscript(pending?.transcript || '')
    }
    catch (error) {
      setLoadError((error as Error).message)
      message.error((error as Error).message)
    }
    finally { setLoading(false) }
  }, [profileForm])
  useEffect(() => {
    void load()
    return () => {
      recordingAttempt.current += 1
      speechStart.current?.abort()
      window.speechSynthesis?.cancel()
      speech.current?.abort()
      mediaStream.current?.getTracks().forEach(track => track.stop())
    }
  }, [load])


  const startRecording = useCallback(async (automatic = false, expectedQuestionId = activeQuestionId.current) => {
    if (speechContext.current.enabled && !speechContext.current.consented) {
      setAutoStartPending(false)
      setRecordingError('请先完成面试前的合规须知确认')
      return
    }
    if (recordingRequest.current || mediaRecorder.current?.state === 'recording') return
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      const error = '当前浏览器不支持录音，请使用最新版 Edge 或 Chrome'
      setAutoStartPending(false)
      setRecordingError(error)
      return
    }
    if (!expectedQuestionId || timeoutHandled.current || (deadline.current !== null && Date.now() >= deadline.current)) return

    recordingRequest.current = true
    const attempt = ++recordingAttempt.current
    const isCurrent = () => attempt === recordingAttempt.current && activeQuestionId.current === expectedQuestionId
    pauseAnswerTimer()
    // Dispose an old attempt only after invalidating its callbacks.
    speechStart.current?.abort()
    const controller = new AbortController()
    speechStart.current = controller
    speech.current?.abort()
    speech.current = null
    mediaStream.current?.getTracks().forEach(track => track.stop())
    let stream: MediaStream | undefined
    let currentSpeech: SpeechHandle | null = null
    let recorder: MediaRecorder | null = null
    let failed = false
    const failRecording = (cause: unknown) => {
      if (!isCurrent() || failed) return
      failed = true
      pauseAnswerTimer()
      setRecordingError(recordingErrorMessage(cause))
      setCaptureId('')
      setAutoStartPending(false)
      setRequestingMic(false)
      setRecording(false)
      setInputLevel(0)
      if (recorder?.state === 'recording') recorder.stop()
      stream?.getTracks().forEach(track => track.stop())
      currentSpeech?.abort()
      controller.abort()
    }
    setAutoStartPending(true)
    setRequestingMic(true)
    setRecordingStage('正在准备麦克风，请稍候再作答…')
    setInputLevel(0)
    setReceivedSound(false)
    setRecordingError('')
    setSpeechNotice('')
    try {
      // Avoid startup gain/noise gating cutting quiet opening syllables.
      // Question playback has ended; retain echo cancellation for residual sound.
      stream = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false,
      } })
      if (!isCurrent() || timeoutHandled.current) {
        stream.getTracks().forEach(track => track.stop())
        return
      }
      mediaStream.current = stream
      setCaptureId('')
      setLiveText('')
      if (speechContext.current.enabled) {
        currentSpeech = await startSpeech(stream, { kind: 'interview', target_id: speechContext.current.id,
          question_id: expectedQuestionId, phase: speechContext.current.phase }, text => { if (isCurrent()) setLiveText(text) }, failRecording, {
          signal: controller.signal,
          onNotice: notice => { if (isCurrent() && !failed) setSpeechNotice(notice) },
          onStage: stage => {
            if (isCurrent()) setRecordingStage(stage === 'connecting' ? '正在连接语音服务，请稍候再作答…' : '正在确认麦克风采音，请稍候再作答…')
          },
          onLevel: rms => {
            if (!isCurrent() || failed) return
            setInputLevel(Math.min(100, Math.max(0, (20 * Math.log10(Math.max(rms, 0.00001)) + 60) / 60 * 100)))
            if (rms > 0.005) setReceivedSound(true)
          },
        })
        if (!isCurrent() || timeoutHandled.current || failed) {
          currentSpeech.abort()
          stream.getTracks().forEach(track => track.stop())
          return
        }
        speech.current = currentSpeech
      }
      chunks.current = []
      discardRecording.current = false
      setRecordedBlob(null)
      setRecordedUrl(previous => {
        if (previous) URL.revokeObjectURL(previous)
        return ''
      })
      recorder = new MediaRecorder(stream)
      const activeRecorder = recorder
      const activeStream = stream
      mediaRecorder.current = recorder
      recorder.ondataavailable = event => { if (isCurrent() && event.data.size) chunks.current.push(event.data) }
      recorder.onstop = () => {
        if (!isCurrent()) return
        pauseAnswerTimer()
        if (currentSpeech && !failed) {
          setRecognizing(true)
          void currentSpeech.stop().then(result => {
            if (!isCurrent() || failed) return
            setCaptureId(result.text.trim() ? result.capture_id : '')
            if (!result.text.trim()) failRecording('没有识别到有效语音，录音已保留，请重新录制')
          }).catch(failRecording).finally(() => { if (isCurrent()) { setRecognizing(false); setSpeechNotice('') } })
        }
        const shouldDiscard = discardRecording.current
        discardRecording.current = false
        if (!shouldDiscard) {
          const blob = new Blob(chunks.current, { type: activeRecorder.mimeType || 'audio/webm' })
          setRecordedBlob(blob)
          setRecordedUrl(previous => {
            if (previous) URL.revokeObjectURL(previous)
            return URL.createObjectURL(blob)
          })
        }
        activeStream.getTracks().forEach(track => track.stop())
        if (mediaRecorder.current === activeRecorder) mediaRecorder.current = null
        if (mediaStream.current === activeStream) mediaStream.current = null
        setRecording(false)
        setInputLevel(0)
      }
      recorder.onerror = () => failRecording('录音设备发生异常，请检查麦克风连接后重试。')
      stream.getAudioTracks?.().forEach(track => track.addEventListener('ended', () => {
        if (activeRecorder.state === 'recording') failRecording('麦克风连接已中断。请重新连接设备后重试，剩余答题时间已保留。')
      }))
      recorder.onstart = () => {
        if (!isCurrent() || failed) return
        resumeAnswerTimer()
        setRecording(true)
        setAutoStartPending(false)
        setRequestingMic(false)
        if (automatic) message.success('录音已就绪，现在可以开始回答')
      }
      recorder.start(250)
    } catch (cause) {
      failRecording(cause)
    } finally {
      if (isCurrent()) recordingRequest.current = false
    }
  }, [pauseAnswerTimer, resumeAnswerTimer])

  useEffect(() => {
    if (!question || interview?.status !== 'in_progress' || renewingConsent) return
    activeQuestionId.current = question.id
    const timeLimit = followup ? FOLLOWUP_TIME_LIMIT : question.time_limit
    deadline.current = null
    remainingMs.current = timeLimit * 1000
    setTimerRunning(false)
    setTimerStarted(false)
    setRecording(false)
    setRecognizing(false)
    setRemaining(timeLimit)
    timeoutHandled.current = false
    answerSubmission.current = false
    setAutoStartPending(true)
    setRequestingMic(false)
    setRecordingError('')
    if (mediaRecorder.current?.state === 'recording') {
      discardRecording.current = true
      mediaRecorder.current.stop()
    }
    mediaStream.current?.getTracks().forEach(track => track.stop())
    setRecordedBlob(null)
    setRecordedUrl(previous => {
      if (previous) URL.revokeObjectURL(previous)
      return ''
    })
    speech.current = null
    setCaptureId('')
    setLiveText('')
    setSpeechNotice('')

    let cancelled = false
    let started = false
    let startTimer: number | undefined
    const beginAutoRecording = () => {
      if (cancelled || started) return
      started = true
      if (startTimer) window.clearTimeout(startTimer)
      startTimer = window.setTimeout(() => { if (!cancelled) void startRecording(true, question.id) }, 180)
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(followup?.text || question.content)
      utterance.lang = 'zh-CN'
      utterance.rate = 0.92
      utterance.onend = beginAutoRecording
      utterance.onerror = beginAutoRecording
      window.speechSynthesis.speak(utterance)
    } else {
      beginAutoRecording()
    }
    return () => {
      cancelled = true
      recordingAttempt.current += 1
      speechStart.current?.abort()
      recordingRequest.current = false
      speech.current?.abort()
      speech.current = null
      if (mediaRecorder.current?.state === 'recording') mediaRecorder.current.stop()
      mediaStream.current?.getTracks().forEach(track => track.stop())
      if (startTimer) window.clearTimeout(startTimer)
      window.speechSynthesis?.cancel()
    }
  }, [followup?.answerId, question?.id, interview?.status, renewingConsent, startRecording])

  const submitTimeout = useCallback(async () => {
    if (!interview || !question || timeoutHandled.current) return
    timeoutHandled.current = true
    answerSubmission.current = false
    remainingMs.current = 0
    deadline.current = null
    setTimerRunning(false)
    if (mediaRecorder.current?.state === 'recording') {
      discardRecording.current = true
      mediaRecorder.current.stop()
    }
    try {
      const result = await speech.current?.stop().catch(() => undefined)
      const answer = await send<AnswerResult>(`/interviews/${interview.id}/answers`, 'POST', { question_id: question.id, capture_id: result?.text.trim() ? result.capture_id : '', transcript: '', timed_out: true, generate_followup: true })
      message.warning(answer.followup ? `第 ${question.sequence} 题已超时并留痕，已根据当前回答生成动态追问` : `第 ${question.sequence} 题已超时并留痕；未取得有效回答证据，直接进入下一题`)
      await load()
    } catch (error) { message.error((error as Error).message) }
  }, [interview, question, load])

  const submitFollowupTimeout = useCallback(async () => {
    if (!interview || !question || !followup || timeoutHandled.current) return
    timeoutHandled.current = true
    answerSubmission.current = false
    remainingMs.current = 0
    deadline.current = null
    setTimerRunning(false)
    if (mediaRecorder.current?.state === 'recording') {
      discardRecording.current = true
      mediaRecorder.current.stop()
    }
    try {
      const result = await speech.current?.stop().catch(() => undefined)
      await send(`/interviews/${interview.id}/answers/${followup.answerId}/followup`, 'POST', {
        transcript: '', capture_id: result?.text.trim() ? result.capture_id : '', audio_data_url: '', timed_out: true,
      })
      message.warning(`第 ${question.sequence} 题的动态追问已超时并留痕`)
      await load()
    } catch (error) { message.error((error as Error).message) }
  }, [interview, question, followup, load])

  useEffect(() => {
    if (interview?.status !== 'in_progress' || !question || renewingConsent) return
    const tick = () => {
      if (deadline.current === null || timeoutHandled.current) return
      const next = Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000))
      setRemaining(next)
      if (next === 0 && !answerSubmission.current) {
        if (followup) void submitFollowupTimeout()
        else void submitTimeout()
      }
    }
    tick()
    const timer = window.setInterval(tick, 250)
    return () => window.clearInterval(timer)
  }, [interview?.status, question?.id, followup, renewingConsent, submitTimeout, submitFollowupTimeout])

  const consent = async (value: boolean) => {
    if (!interview || savingConsent) return
    setSavingConsent(true)
    setConsentError('')
    try {
      await send(`/interviews/${interview.id}/consent`, 'POST', { consented: value, notice_version: interview.available_consent_version })
      if (!value) { setAgreed(false); leave(); return }
      await load()
      // 同意后进入设备检测；此前已通过检测的，保留结果并可直接继续。
      setChosenStep(null)
      setRecheckMic(true)
    } catch (error) { setConsentError((error as Error).message) }
    finally { setSavingConsent(false) }
  }
  const saveProfile = async () => {
    if (profileSaving.current) return
    profileSaving.current = true
    setProfileError('')
    try {
      const values = await profileForm.validateFields()
      setSavingProfile(true)
      await send('/interviews/me/profile', 'PUT', values)
      message.success('个人信息已保存，请继续阅读合规须知')
      await load()
      setChosenStep('consent')
    } catch (error) {
      if (error instanceof Error) setProfileError(error.message)
    } finally { profileSaving.current = false; setSavingProfile(false) }
  }
  const testMic = async () => {
    if (!interview) return
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return message.error('当前浏览器不支持录音，请使用最新版 Edge 或 Chrome')
    setMicTesting(true)
    setRecordingError('')
    setMicRecognizedText('')
    let audioContext: AudioContext | undefined
    let source: MediaStreamAudioSourceNode | undefined
    let stream: MediaStream | undefined
    let recognition: MicSpeechRecognition | undefined
    let testSpeech: SpeechHandle | undefined
    let recognitionActive = false
    let recognizedText = ''
    let phraseMatched = false
    let recognitionError = ''
    let recognitionEndResolve: (() => void) | undefined
    const recognitionEnded = new Promise<void>(resolve => { recognitionEndResolve = resolve })
    try {
      setMicTestStage('正在连接麦克风和语音服务，请暂时保持安静…')
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      if (!window.AudioContext) throw new Error('当前浏览器不支持麦克风音量检测，请使用最新版 Edge 或 Chrome')
      if (interview.asr_mode === 'doubao') {
        testSpeech = await startSpeech(stream, { kind: 'mic_check', target_id: interview.id }, text => {
          recognizedText = text
          setMicRecognizedText(text)
          phraseMatched = validateMicPhrase(text)
        }, error => { recognitionError = error }, { onNotice: setMicTestStage })
      } else {
        const Recognition = (window as Window & { SpeechRecognition?: MicSpeechRecognitionCtor; webkitSpeechRecognition?: MicSpeechRecognitionCtor }).SpeechRecognition
          || (window as Window & { webkitSpeechRecognition?: MicSpeechRecognitionCtor }).webkitSpeechRecognition
        if (!Recognition) throw new Error('当前浏览器不支持语音内容核验，请使用最新版 Edge 或 Chrome')
        recognition = new Recognition()
        recognition.lang = 'zh-CN'
        recognition.interimResults = true
        // Keep the browser recognizer alive for the whole test window. With
        // continuous=false Chromium can end it before the candidate finishes
        // speaking, which made a valid phrase look like no response.
        recognition.continuous = true
        recognition.onresult = event => {
          const parts: string[] = []
          for (let index = 0; index < event.results.length; index += 1) parts.push(event.results[index]?.[0]?.transcript || '')
          recognizedText = parts.join('')
          setMicRecognizedText(recognizedText)
          if (validateMicPhrase(recognizedText)) {
            phraseMatched = true
            setMicTestStage('已识别完整测试口令，正在确认麦克风音量…')
          }
        }
        recognition.onerror = event => { recognitionError = event.error || '语音内容核验失败' }
        recognition.onend = () => { recognitionActive = false; recognitionEndResolve?.() }
        recognition.start()
        recognitionActive = true
      }
      setMicTestStage('正在校准环境噪声，请暂时保持安静…')
      audioContext = new AudioContext()
      await audioContext.resume()
      source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 2048
      source.connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      const levels: number[] = []
      recorder.start()
      const startedAt = Date.now()
      const calibrationFrames = 10
      // Leave enough time for a normal Chinese sentence and for the browser
      // recognizer to return its final result after speech stops.
      for (let frame = 0; frame < 60; frame += 1) {
        if (recognitionError) throw new Error(recognitionError)
        if (frame === calibrationFrames) setMicTestStage('请开始清晰地说：“麦克风测试，一二三”')
        analyser.getFloatTimeDomainData(samples)
        let sum = 0
        for (const value of samples) sum += value * value
        levels.push(Math.sqrt(sum / samples.length))
        await new Promise(resolve => window.setTimeout(resolve, 80))
        // Once the exact phrase is recognized, finish as soon as the minimum
        // audio window is complete instead of making the candidate wait for
        // the full test duration.
        if (phraseMatched && Date.now() - startedAt >= 2200) break
      }
      const result = evaluateMicLevels(levels, calibrationFrames, Date.now() - startedAt)
      await new Promise<void>(resolve => { recorder.onstop = () => resolve(); recorder.stop() })
      if (testSpeech) {
        setMicTestStage('正在核验测试口令，请稍候…')
        const final = await testSpeech.stop()
        recognizedText = final.text
        testSpeech = undefined
      }
      if (recognitionActive && recognition) {
        recognition?.stop()
        // onend/result callbacks are asynchronous in Edge/Chrome. Waiting
        // for onend prevents the old 120ms race where spoken text was lost.
        await Promise.race([recognitionEnded, new Promise(resolve => window.setTimeout(resolve, 2200))])
      }
      stream.getTracks().forEach(track => track.stop())
      setMicRecognizedText(recognizedText)
      if (!result.passed) throw new Error('未检测到持续有效的人声。请在提示出现后清晰说完整句话，再重新检测')
      if (!validateMicPhrase(recognizedText)) {
        throw new Error(recognitionError || '未识别到指定测试口令，请在提示出现后清晰说“麦克风测试，一二三”，再重新检测')
      }
      await send(`/interviews/${interview.id}/mic-check`, 'POST', {
        passed: true,
        peak_rms: result.peakRms,
        speech_frames: result.speechFrames,
        duration_ms: result.durationMs,
        speech_text: recognizedText,
      })
      message.success('麦克风和声音输入检测通过')
      await load()
      setChosenStep(null)
      setRecheckMic(false)
    } catch (error) {
      setRecordingError(recordingErrorMessage(error))
    } finally {
      testSpeech?.abort()
      if (recognitionActive) recognition?.stop()
      stream?.getTracks().forEach(track => track.stop())
      setMicTesting(false)
      setMicTestStage('')
    }
    if (source) source.disconnect()
    if (audioContext && audioContext.state !== 'closed') void audioContext.close()
  }
  const startInterview = async () => {
    if (!interview || startingInterview) return
    setStartingInterview(true)
    setRecordingError('')
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('当前浏览器不支持录音，请使用最新版 Edge 或 Chrome')
      // A saved microphone check may belong to another device or an earlier connection.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach(track => track.stop())
      await send(`/interviews/${interview.id}/start`, 'POST')
      await load()
    } catch (error) { setRecordingError(recordingErrorMessage(error)) }
    finally { setStartingInterview(false) }
  }
  const stopRecording = () => {
    pauseAnswerTimer()
    if (mediaRecorder.current?.state === 'recording') mediaRecorder.current.stop()
  }
  const replayQuestion = () => {
    if (recording) return message.info('正在录音时不能重新播报，请先停止录音')
    if (!question || !('speechSynthesis' in window)) return message.info('当前浏览器不支持语音播报')
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(followup?.text || question.content)
    utterance.lang = 'zh-CN'
    window.speechSynthesis.speak(utterance)
  }
  const submitAnswer = async () => {
    if (!interview || !question) return
    if (!recordedBlob) return message.warning('请先录制作答，再提交回答')
    if (speechContext.current.enabled && !captureId) return message.warning('请等待有效的最终转写后再提交')
    answerSubmission.current = true
    setSubmitting(true)
    try {
      const result = await send<AnswerResult>(`/interviews/${interview.id}/answers`, 'POST', { question_id: question.id, capture_id: captureId, transcript: '', timed_out: false, generate_followup: true })
      setTranscript(result.transcript)
      const dataUrl = await blobToDataUrl(recordedBlob)
      await send(`/interviews/${interview.id}/audio/${question.id}`, 'POST', { data_url: dataUrl })
      if (result.followup) {
        setFollowup({ questionId: question.id, answerId: result.answer_id, text: result.followup, basis: result.followup_basis || result.transcript.slice(0, 34) })
        message.success('主体回答已转写，已根据回答生成一次动态追问')
      } else {
        await load()
      }
    } catch (error) {
      answerSubmission.current = false
      message.error((error as Error).message)
    }
    finally { setSubmitting(false) }
  }
  const submitFollowup = async () => {
    if (!interview || !followup) return
    if (!recordedBlob) return message.warning('请先完成动态追问录音，再提交回答')
    if (speechContext.current.enabled && !captureId) return message.warning('请等待有效的最终转写后再提交')
    answerSubmission.current = true
    setSubmitting(true)
    try {
      const dataUrl = await blobToDataUrl(recordedBlob)
      await send(`/interviews/${interview.id}/answers/${followup.answerId}/followup`, 'POST', {
        transcript: '', capture_id: captureId, audio_data_url: dataUrl, timed_out: false,
      })
      message.success('动态追问录音和转写已保存；本主体题不会再次生成追问')
      await load()
    } catch (error) {
      answerSubmission.current = false
      message.error((error as Error).message)
    }
    finally { setSubmitting(false) }
  }
  const submitInterview = async () => {
    if (!interview || submitting) return
    setSubmitting(true)
    setSubmitError('')
    try {
      // 提交即结束：回答立即归档，报告由后台生成后交工作人员复核，候选人不需要等待，也不读取报告。
      await send(`/interviews/${interview.id}/submit`, 'POST')
      setInterview(current => current ? { ...current, status: 'completed', completed_at: current.completed_at || new Date().toISOString() } : current)
    } catch (error) {
      setSubmitError((error as Error).message)
      // 可能已在别处提交或状态已变化，以服务端记录为准。
      if (error instanceof ApiError && error.status === 409) await load()
    }
    finally { setSubmitting(false) }
  }

  if (loading) return <div className="candidate-loading"><Spin size="large" /><Typography.Text>正在恢复面试状态…</Typography.Text></div>
  if (!interview) {
    return (
      <main className="candidate-page">
        <header className="candidate-header"><Brand label="AI面试" /><Space wrap><ScreenControls preferred={onsite} /></Space></header>
        <div className="candidate-shell">
          <Card className="candidate-card">
            <Alert type="error" showIcon message="暂时无法读取面试信息" description={loadError || '请稍后重试；仍无法进入时请联系招聘工作人员。'} />
            <Space wrap className="candidate-actions">
              <Button onClick={leave}>{onsite ? '返回候选人名单' : '返回登录'}</Button>
              <Button type="primary" onClick={() => { setLoading(true); void load() }}>重新读取</Button>
            </Space>
          </Card>
        </div>
      </main>
    )
  }

  const preparing = isPreparing(interview)
  const prepBusy = savingProfile || savingConsent || micTesting || startingInterview
  const steps = flowSteps(interview)
  const reached = reachedStep(interview)
  const returned = chosenStep && steps.indexOf(chosenStep) >= 0 && steps.indexOf(chosenStep) < steps.indexOf(reached) ? chosenStep : null
  const currentStep: StepKey = preparing ? returned || reached : interview.status === 'completed' ? 'done' : 'interview'
  const stepIndex = steps.indexOf(currentStep)
  const goBack = (step: StepKey) => {
    if (!preparing || prepBusy || steps.indexOf(step) < 0 || steps.indexOf(step) >= stepIndex) return
    setRecordingError('')
    setConsentError('')
    setChosenStep(step)
  }
  const micPassed = interview.mic_checked && interview.status === 'ready'
  const previousOf = (step: StepKey) => steps[steps.indexOf(step) - 1] as StepKey | undefined
  const beforeConsent = previousOf('consent')
  const beforeDevice = previousOf('device')
  // 每题的时限由题目决定，每道主体题最多追问一次。
  const longestMinutes = Math.ceil(interview.questions.reduce((total, item) => total + item.time_limit + FOLLOWUP_TIME_LIMIT, 0) / 60)
  const answering = interview.status === 'in_progress' && !renewingConsent
  const allAnswered = interview.current_question > interview.questions.length
  // 同一时刻只显示一个环节。
  const showProfile = preparing && currentStep === 'profile'
  const showConsent = (preparing && currentStep === 'consent') || renewingConsent
  const showMicCheck = preparing && currentStep === 'device' && (!micPassed || recheckMic)
  const showReady = preparing && currentStep === 'device' && micPassed && !recheckMic
  const showQuestion = answering && !allAnswered && Boolean(question)
  const showSubmit = answering && allAnswered
  const showDone = interview.status === 'completed'
  const nothingShown = !(showProfile || showConsent || showMicCheck || showReady || showQuestion || showSubmit || showDone)
  // 语音转写没有配置时录音转不成文字，面试无从评价：准备阶段如实说明，不让候选人开始。
  const speechUnavailable = preparing && interview.asr_mode === 'unavailable'
  const recordingIssue = recordingError ? <Alert className="recording-alert" type="warning" showIcon message="录音暂不可用" description={<>{recordingError}{interview.status === 'in_progress' && <div>答题计时已暂停，重新检测成功后继续。</div>}</>} /> : null
  const inputMeter = recording && interview.asr_mode === 'doubao' ? <div className="audio-input-feedback">
    <div className="audio-input-label"><AudioOutlined /> 麦克风输入<span>{inputLevel > 23 ? '收到声音' : '等待声音'}</span></div>
    <div className="audio-input-meter" role="meter" aria-label="麦克风输入音量" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(inputLevel)}><span style={{ width: inputLevel + '%' }} /></div>
    <Typography.Text type="secondary">音量条反映收音情况，识别文字会稍后显示。</Typography.Text>
  </div> : null
  const liveTranscript = interview.asr_mode === 'doubao' && (recording || recognizing || liveText) ? <section className="live-transcript" aria-label="实时转写"><Typography.Text strong>{recognizing ? '正在完成语音转写…' : '实时转写'}</Typography.Text>{speechNotice && <div className="live-transcript-notice" role="status">{speechNotice}</div>}<div className="live-transcript-text" aria-live="polite">{liveText || (receivedSound ? '已收到声音，正在等待识别文字，请继续回答。' : '请开始说话，识别文字会显示在这里。')}</div></section> : null

  return (
    <main className="candidate-page">
      <header className="candidate-header">
        <Brand label="AI面试" />
        <Space wrap><EnvironmentBadge /><ScreenControls preferred={onsite} /><Button type="text" icon={<LogoutOutlined />} onClick={leave}>退出</Button></Space>
      </header>
      <div className="candidate-shell">
        <Steps className="candidate-steps" current={stepIndex} size="small" responsive={false}
          onChange={preparing && !prepBusy ? index => goBack(steps[index]) : undefined}
          items={steps.map((key, index) => ({ title: STEP_TITLES[key], disabled: !preparing || prepBusy || index >= stepIndex }))} />
        {preparing && (
          <Typography.Paragraph type="secondary">
            {stepIndex > 0 ? '正式开始前，可点击上方已完成的步骤返回修改。' : ''}面试开始后不能返回准备步骤，提交后不能重新面试。
          </Typography.Paragraph>
        )}
        {speechUnavailable && (
          <Alert className="recording-alert" type="error" showIcon message="暂时不能进行AI面试"
            description="语音转写服务尚未配置，录音无法转成文字。请联系工作人员，配置完成后刷新本页。" />
        )}

        {showProfile && (
          <CandidateProfileForm form={profileForm} candidate={interview.candidate} saving={savingProfile} error={profileError} onSave={() => void saveProfile()} />
        )}

        {showConsent && (
          <ConsentCard
            version={interview.available_consent_version || interview.consent_version}
            text={interview.consent_text}
            agreed={agreed}
            saving={savingConsent}
            busy={prepBusy}
            error={consentError}
            declined={interview.status === 'consent_declined'}
            backLabel={preparing && beforeConsent ? `上一步：${STEP_TITLES[beforeConsent]}` : undefined}
            onBack={preparing && beforeConsent ? () => goBack(beforeConsent) : undefined}
            onAgreedChange={setAgreed}
            onAgree={() => void consent(true)}
            onDecline={() => void consent(false)}
          />
        )}

        {showMicCheck && (
          <Card className="candidate-card">
            <div className={`mic-visual ${micTesting ? 'active' : ''}`}><AudioOutlined /></div>
            <Typography.Title level={2}>麦克风检测</Typography.Title>
            <Typography.Paragraph type="secondary">点击检测后，系统先校准环境噪声，再提示你连续说出“麦克风测试，一二三”。系统会同时核验声音强度和语音内容，口令未识别正确不会通过；测试音频不用于评分。</Typography.Paragraph>
            <Button type="primary" size="large" loading={micTesting} disabled={speechUnavailable} icon={<AudioOutlined />} onClick={testMic}>{micTesting ? '正在检测…' : '开始麦克风检测'}</Button>
            {(beforeDevice || micPassed) && (
              <Space wrap className="candidate-actions">
                {beforeDevice && <Button disabled={prepBusy} onClick={() => goBack(beforeDevice)}>上一步：{STEP_TITLES[beforeDevice]}</Button>}
                {micPassed && <Button disabled={prepBusy || Boolean(recordingError)} onClick={() => setRecheckMic(false)}>检测已通过，继续</Button>}
              </Space>
            )}
            {micTesting && <Alert type="info" showIcon message={micTestStage || '正在准备麦克风…'} />}
            {micRecognizedText && <Alert type="success" showIcon message="已识别到语音内容" description={`识别结果：${micRecognizedText}`} />}
            {recordingIssue}
            <Typography.Text type="secondary">建议使用最新版 Edge 或 Chrome，并确认系统麦克风未被其他程序占用。</Typography.Text>
          </Card>
        )}

        {showReady && (
          <Card className="candidate-card">
            <div className="candidate-icon success"><CheckCircleFilled /></div>
            <Typography.Title level={2}>设备已就绪</Typography.Title>
            <Typography.Paragraph>本次有 {interview.questions.length} 道主体题，每题最多追问 1 次；全部作答时间最长约 {longestMinutes} 分钟。每题的时限以题目页显示为准，录音开始后才计时。</Typography.Paragraph>
            <Alert type="warning" showIcon message="请勿在回答中提供身份证号、住址、健康、婚育、宗教等与岗位无关的私人信息。" />
            {recordingIssue}
            <Typography.Paragraph>点击“开始面试”后将进入正式作答，本次面试提交后不能重新作答。</Typography.Paragraph>
            <Space wrap className="candidate-actions">
              <Button disabled={prepBusy} onClick={() => { setRecordingError(''); setRecheckMic(true) }}>重新检测麦克风</Button>
              <Button type="primary" size="large" loading={startingInterview} disabled={speechUnavailable} icon={<PlayCircleOutlined />} onClick={startInterview}>{startingInterview ? '正在检查麦克风' : '开始面试'}</Button>
            </Space>
          </Card>
        )}

        {showQuestion && question && (
          <div className="interview-stage">
            <div className="interview-topline">
              <div><Typography.Text type="secondary">当前题号</Typography.Text><Typography.Title level={3}>{question.sequence} / {interview.questions.length}</Typography.Title></div>
              <Progress percent={Math.round((question.sequence - 1) / interview.questions.length * 100)} showInfo={false} />
              <div className="countdown-wrap"><div className={remaining <= 15 && timerStarted ? 'countdown danger' : 'countdown'} role="timer" aria-label="剩余答题时间"><ClockCircleOutlined /> {Math.floor(remaining / 60).toString().padStart(2, '0')}:{(remaining % 60).toString().padStart(2, '0')}</div><span className="countdown-hint">{timerRunning ? '录音计时中' : remaining === 0 && timerStarted ? '本题时间已到' : timerStarted ? '计时已暂停' : '录音后开始计时'}</span></div>
            </div>
            <Card className="question-card">
              <div className="ai-interviewer"><div className="avatar-orbit"><RobotOutlined /></div><div><Tag color="green">{question.dimension}</Tag><Typography.Text type="secondary">AI 面试官</Typography.Text></div></div>
              <Typography.Title level={2} className="question-text">{question.content}</Typography.Title>
              <Button type="link" icon={<SoundOutlined />} disabled={recording || requestingMic || Boolean(followup)} onClick={replayQuestion}>重新播报问题</Button>
            </Card>
            {!followup ? (
              <Card className="recording-card">
                {!recordingError && <div className="recording-status"><span className={recording ? 'record-dot pulse' : 'record-dot'} />{recording ? '正在录音，请清晰作答' : requestingMic ? recordingStage : autoStartPending ? '问题播报中，结束后将自动开始录音' : recordedBlob ? '录音已完成，可试听或重新录制' : '正在准备自动录音'}</div>}
                {recordingIssue}
                {recording ? <Button danger size="large" shape="round" icon={<PauseOutlined />} onClick={stopRecording}>停止录音</Button> : <Button type="primary" size="large" shape="round" icon={<AudioOutlined />} disabled={recognizing || submitting || requestingMic} loading={autoStartPending} onClick={() => void startRecording(false)}>{recordingError ? '重新检测并录音' : recordedBlob ? '重新录制' : '手动开始录音'}</Button>}
                {inputMeter}
                {liveTranscript}
                {recordedUrl && <audio className="audio-player" controls src={recordedUrl}>你的浏览器不支持音频播放。</audio>}
                <Button size="large" icon={<SendOutlined />} disabled={!recordedBlob || recording || recognizing || (interview.asr_mode === 'doubao' && !captureId)} loading={submitting} onClick={submitAnswer}>保存录音并提交回答</Button>
                <Typography.Text type="secondary" className="recording-help">仅在录音时计时；停止录音或设备异常时暂停，重录沿用剩余时间。录音和转写按采集告知保存。</Typography.Text>
              </Card>
            ) : (
              <Card className="followup-card">
                <Alert type="success" showIcon message="主体回答语音转写" description={transcript} />
                <Tag color="purple">追问</Tag>
                <Typography.Text type="secondary">追问依据：{followup.basis}</Typography.Text>
                <Typography.Title level={3}>{followup.text}</Typography.Title>
                <Button type="link" icon={<SoundOutlined />} disabled={recording || requestingMic} onClick={replayQuestion}>重新播报动态追问</Button>
                {!recordingError && <div className="recording-status"><span className={recording ? 'record-dot pulse' : 'record-dot'} />{recording ? '正在录制动态追问回答' : requestingMic ? recordingStage : autoStartPending ? '动态追问播报中，结束后将自动开始录音' : recordedBlob ? '追问录音已完成，可试听或重新录制' : '正在准备追问录音'}</div>}
                {recordingIssue}
                {recording ? <Button danger size="large" shape="round" icon={<PauseOutlined />} onClick={stopRecording}>停止录音</Button> : <Button type="primary" size="large" shape="round" icon={<AudioOutlined />} disabled={recognizing || submitting || requestingMic} loading={autoStartPending} onClick={() => void startRecording(false)}>{recordingError ? '重新检测并录音' : recordedBlob ? '重新录制追问回答' : '手动开始追问录音'}</Button>}
                {inputMeter}
                {liveTranscript}
                {recordedUrl && <audio className="audio-player" controls src={recordedUrl}>你的浏览器不支持音频播放。</audio>}
                <Button type="primary" size="large" icon={<SendOutlined />} disabled={!recordedBlob || recording || recognizing || (interview.asr_mode === 'doubao' && !captureId)} loading={submitting} onClick={submitFollowup}>保存追问录音并进入下一题</Button>
                <Typography.Text type="secondary" className="recording-help">追问限时 {FOLLOWUP_TIME_LIMIT} 秒，仅在录音时计时；暂停和重录保留剩余时间。本题不会再次追问。</Typography.Text>
              </Card>
            )}
          </div>
        )}

        {showSubmit && (
          <Card className="candidate-card">
            <div className="candidate-icon success"><CheckCircleFilled /></div>
            <Typography.Title level={2}>全部题目已完成</Typography.Title>
            <Typography.Paragraph>已保存 {interview.answers.length} 道主体题的回答。提交后本次面试结束，不能修改或重新作答。</Typography.Paragraph>
            {submitError && <Alert type="error" showIcon message="面试尚未提交" description={<>{submitError}<div>请重新提交；多次未成功时请联系招聘工作人员，已保存的回答不会丢失。</div></>} />}
            <Button type="primary" size="large" icon={<SendOutlined />} loading={submitting} onClick={submitInterview}>提交面试</Button>
          </Card>
        )}

        {showDone && <CompletionCard onsite={onsite} onLeave={leave} />}

        {nothingShown && (
          <Card className="candidate-card">
            <Alert type="warning" showIcon message="当前面试状态无法继续" description="请联系招聘工作人员核对面试记录；已保存的回答不会丢失。" />
            <Button onClick={leave}>{onsite ? '返回候选人名单' : '返回登录'}</Button>
          </Card>
        )}
      </div>
      <footer className="candidate-footer">{interview.candidate.name} · {interview.candidate.code} · 刷新页面后可从当前进度继续</footer>
    </main>
  )
}
