import { Alert, Button, Card, Col, Input, Modal, Row, Skeleton, Tag, Typography, message } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, send } from '../../api'
import { downloadAudioAsMp3 } from '../../audioExport'
import { AiNotice, PageHeader } from '../../components/PageHeader'
import { StatusTag } from '../../components/StatusTag'
import { can, useAdminSession } from '../../lib/access'
import { recordingErrorMessage } from '../../recordingErrors'
import { startSpeech, type SpeechHandle } from '../../speech'
import { transcriptTrigger } from '../../transcript-trigger'
import { CandidatePicker } from './listening/CandidatePicker'
import { CaptureList } from './listening/CaptureList'
import { needsAttestation } from './listening/consent'
import { FollowupSuggestions } from './listening/FollowupSuggestions'
import { PreparedQuestions } from './listening/PreparedQuestions'
import { ReferencePanel } from './listening/ReferencePanel'
import { ReportProgress } from './listening/ReportProgress'
import { ReportSummary } from './listening/ReportSummary'
import { SessionPanel } from './listening/SessionPanel'
import { turnKey } from './listening/TranscriptLines'
import type {
  BatchOption, Capture, ListeningCandidate, ListeningState, QuestionAction, QuestionSource, SessionPhase,
  SpeakerRole, SpeakerTurn, Suggestion, SuggestionResult,
} from './listening/types'
import './listening/listening.css'

const REPORTS_PATH = '/ai-interview/reports?type=comprehensive'
/** 后台处理进行中时，每隔多久读取一次进度。 */
const POLL_INTERVAL = 2000

interface EditTarget {
  source: QuestionSource
  id: number
  text: string
}

function toId(value: string | null): number | undefined {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : undefined
}

const actionDone: Record<QuestionAction, string> = {
  adopted: '已采用该问题',
  edited: '已按修改后的内容采用',
  ignored: '已忽略该问题',
}

/** 提问建议卡片里的两栏：开始前准备的提问、现场补充提问。 */
type QuestionTab = 'prepared' | 'followup'

function TabLabel({ text, pending }: { text: string; pending: number }) {
  return (
    <span className="listening-tab-label">
      {text}
      {pending > 0 && <span className="listening-tab-count" aria-label={`${pending} 条待处理`}>{pending}</span>}
    </span>
  )
}

export default function ListeningPage({ pollIntervalMs = POLL_INTERVAL }: { pollIntervalMs?: number }) {
  const session = useAdminSession()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const batchId = toId(params.get('batch'))
  const candidateId = toId(params.get('candidate'))

  const [batches, setBatches] = useState<BatchOption[]>([])
  const [batchesLoading, setBatchesLoading] = useState(true)
  const [candidates, setCandidates] = useState<ListeningCandidate[]>([])
  const [candidatesLoading, setCandidatesLoading] = useState(false)
  const [pickerError, setPickerError] = useState('')
  const [state, setState] = useState<ListeningState | null>(null)
  const [stateLoading, setStateLoading] = useState(false)
  const [stateError, setStateError] = useState('')

  const [attested, setAttested] = useState(false)
  const [recording, setRecording] = useState(false)
  const [phase, setPhase] = useState<SessionPhase>('idle')
  const [liveText, setLiveText] = useState('')
  const [speechError, setSpeechError] = useState('')
  const [speechNotice, setSpeechNotice] = useState('')
  const [autoSuggest, setAutoSuggest] = useState(true)
  const [suggesting, setSuggesting] = useState(false)
  const [suggestNote, setSuggestNote] = useState('')
  const [requestingPrepare, setRequestingPrepare] = useState(false)
  const [prepareError, setPrepareError] = useState('')
  const [regenerating, setRegenerating] = useState(false)
  const [acting, setActing] = useState('')
  const [working, setWorking] = useState('')
  const [edit, setEdit] = useState<EditTarget | null>(null)
  const [editError, setEditError] = useState('')
  const [tab, setTab] = useState<QuestionTab>('prepared')

  const candidatesRequest = useRef(0)
  const stateRequest = useRef(0)
  const speech = useRef<SpeechHandle | null>(null)
  const microphone = useRef<MediaStream | null>(null)
  const suggestPending = useRef(false)
  // 分析进行中又有新的请求时记下来，结束后再分析一次；'show' 表示分析完要切到补充提问栏。
  const suggestAgain = useRef<false | true | 'show'>(false)
  const suggestLatest = useRef<(show?: boolean) => Promise<void>>(async () => {})
  // 提问建议栏按候选人选定初始显示的一栏。
  const tabCandidate = useRef<number | undefined>(undefined)
  const evidenceTrigger = useRef<ReturnType<typeof transcriptTrigger> | null>(null)
  // 本页发起的后台处理：结束时给出结果提示。值是候选人编号。
  const watching = useRef<{ prepare?: number; report?: number }>({})
  const seen = useRef<{ prepare?: string; report?: string }>({})

  const recordable = state?.asr_mode === 'doubao'
  const busy = phase !== 'idle'
  const prepareTask = state?.tasks?.prepare || null
  const reportTask = state?.tasks?.report || null
  const preparing = requestingPrepare || prepareTask?.status === 'running'
  const reportRunning = reportTask?.status === 'running'
  // 录音、保存期间不切换候选人，避免结果记到别人名下。提问建议和综合报告在后台生成，不影响切换。
  const locked = recording || busy || requestingPrepare || suggesting
  // 两类提问各占一栏，互不挤占位置；不能录音又没有补充提问时只有准备的提问，不显示栏切换。
  const followupTab = Boolean(state && (recordable || state.suggestions.length > 0))
  const activeTab: QuestionTab = followupTab ? tab : 'prepared'
  const pendingPrepared = state?.prepared_questions.filter(item => item.status === 'pending').length || 0
  const pendingFollowups = state?.suggestions.filter(item => item.status === 'pending').length || 0

  const select = useCallback((batch: number | undefined, candidate: number | undefined) => {
    setParams(current => {
      const next = new URLSearchParams(current)
      if (batch) next.set('batch', String(batch))
      else next.delete('batch')
      if (candidate) next.set('candidate', String(candidate))
      else next.delete('candidate')
      return next
    }, { replace: true })
  }, [setParams])
  // 供只在进入页面时运行一次的逻辑读取最新的选择。
  const selection = useRef({ batchId, candidateId, select })
  selection.current = { batchId, candidateId, select }

  const loadBatches = useCallback(async (): Promise<BatchOption[]> => {
    setBatchesLoading(true)
    try {
      const data = await api<BatchOption[]>('/batches')
      setBatches(data)
      setPickerError('')
      return data
    } catch (error) {
      setPickerError((error as Error).message)
      return []
    } finally {
      setBatchesLoading(false)
    }
  }, [])

  const loadCandidates = useCallback(async (batch: number | undefined) => {
    const current = ++candidatesRequest.current
    if (!batch) {
      setCandidates([])
      setCandidatesLoading(false)
      return
    }
    setCandidatesLoading(true)
    try {
      const data = await api<ListeningCandidate[]>(`/listening/candidates?batch_id=${batch}`)
      if (current !== candidatesRequest.current) return
      setCandidates(data)
      setPickerError('')
    } catch (error) {
      if (current !== candidatesRequest.current) return
      setCandidates([])
      setPickerError((error as Error).message)
    } finally {
      if (current === candidatesRequest.current) setCandidatesLoading(false)
    }
  }, [])

  /** quiet：操作完成后的刷新，不清空当前内容。silent：定时读取进度，读取失败时不打扰，下一次再读。 */
  const loadState = useCallback(async (candidate: number, quiet = false, silent = false) => {
    const current = ++stateRequest.current
    if (!quiet) setStateLoading(true)
    try {
      const data = await api<ListeningState>(`/listening/${candidate}`)
      if (current !== stateRequest.current) return
      setState(data)
      setStateError('')
    } catch (error) {
      if (current !== stateRequest.current) return
      if (silent) return
      if (quiet) message.error((error as Error).message)
      else {
        setState(null)
        setStateError((error as Error).message)
      }
    } finally {
      if (current === stateRequest.current && !quiet) setStateLoading(false)
    }
  }, [])

  const releaseMicrophone = () => {
    microphone.current?.getTracks().forEach(track => track.stop())
    microphone.current = null
  }

  useEffect(() => {
    void loadBatches().then(data => {
      // 只有一个批次时直接选中；有多个批次时由使用者选择。
      if (data.length === 1 && !selection.current.batchId && !selection.current.candidateId) selection.current.select(data[0].id, undefined)
    })
  }, [loadBatches])

  useEffect(() => () => {
    // 离开页面时停止采音并释放麦克风。
    speech.current?.abort()
    speech.current = null
    releaseMicrophone()
  }, [])

  useEffect(() => { void loadCandidates(batchId) }, [batchId, loadCandidates])

  useEffect(() => {
    stateRequest.current += 1
    setState(null)
    setStateError('')
    setStateLoading(false)
    setAttested(false)
    setLiveText('')
    setSpeechError('')
    setSpeechNotice('')
    setSuggestNote('')
    setPrepareError('')
    setEdit(null)
    if (candidateId) void loadState(candidateId)
  }, [candidateId, loadState])

  useEffect(() => {
    if (!candidateId || !(prepareTask?.status === 'running' || reportRunning)) return
    const timer = window.setInterval(() => { void loadState(candidateId, true, true) }, pollIntervalMs)
    return () => window.clearInterval(timer)
  }, [candidateId, prepareTask?.status, reportRunning, loadState, pollIntervalMs])

  useEffect(() => {
    // 本页发起的后台处理结束时提示结果；打开页面时已经结束的不重复提示。
    const candidate = state?.candidate_id
    const prepare = prepareTask?.status
    if (prepare !== seen.current.prepare && watching.current.prepare === candidate && prepare && prepare !== 'running') {
      watching.current.prepare = undefined
      const count = state?.prepared_questions.length || 0
      if (prepare === 'completed' && count) message.success(`已生成 ${count} 个提问建议`)
      else if (prepare === 'completed') setPrepareError('本次没有生成可用的提问建议，请重新生成')
    }
    seen.current.prepare = prepare
    const report = reportTask?.status
    if (report !== seen.current.report && watching.current.report === candidate && report && report !== 'running') {
      watching.current.report = undefined
      if (report === 'completed') message.success('综合报告已生成，请进行人工复核')
      else message.error(`综合报告没有生成：${reportTask?.error || '原因未知'}`)
      void loadCandidates(batchId)
    }
    seen.current.report = report
  }, [state, prepareTask?.status, reportTask?.status, reportTask?.error, loadCandidates, batchId])

  useEffect(() => {
    // 通过链接直接打开某位候选人时，批次以候选人所在的批次为准。
    if (state && state.candidate_id === candidateId && state.batch && state.batch.id !== batchId) select(state.batch.id, candidateId)
  }, [state, candidateId, batchId, select])

  useEffect(() => {
    // 换候选人后选定先看哪一栏：旁听进行中且已有补充提问时看补充提问，其余情况看准备的提问。
    if (!state || state.candidate_id === tabCandidate.current) return
    tabCandidate.current = state.candidate_id
    setTab(state.status === 'running' && state.suggestions.length > 0 ? 'followup' : 'prepared')
  }, [state])

  const refresh = async () => {
    if (candidateId) await loadState(candidateId, true)
    void loadCandidates(batchId)
  }
  const refreshLatest = useRef(refresh)
  refreshLatest.current = refresh

  /** show：分析完切到补充提问栏（暂停保存一段回答之后），让面试官看到针对这段回答的结果或没有结果的原因。 */
  const suggest = async (show = false) => {
    if (!candidateId) return
    if (suggestPending.current) {
      suggestAgain.current = show ? 'show' : suggestAgain.current || true
      return
    }
    const candidate = candidateId
    suggestPending.current = true
    setSuggesting(true)
    setSuggestNote('')
    try {
      const result = await send<{ suggestions: Suggestion[]; skipped?: string }>(`/listening/${candidate}/suggest`, 'POST')
      setState(current => current && current.candidate_id === candidate ? { ...current, suggestions: result.suggestions } : current)
      if (result.skipped) setSuggestNote(result.skipped)
    } catch (error) {
      setSuggestNote((error as Error).message)
    } finally {
      suggestPending.current = false
      setSuggesting(false)
      if (show) setTab('followup')
      if (suggestAgain.current) {
        const again = suggestAgain.current
        suggestAgain.current = false
        queueMicrotask(() => { void suggestLatest.current(again === 'show') })
      }
    }
  }
  suggestLatest.current = suggest

  useEffect(() => {
    if (!recordable || !autoSuggest || !recording) return
    const trigger = transcriptTrigger(() => suggestLatest.current())
    evidenceTrigger.current = trigger
    return () => {
      trigger.close()
      evidenceTrigger.current = null
    }
  }, [recordable, autoSuggest, recording, candidateId])
  useEffect(() => { evidenceTrigger.current?.update(liveText) }, [liveText, recording, autoSuggest])

  const start = async () => {
    if (!state || !candidateId || !recordable || busy || recording || state.status === 'completed') return
    const attest = needsAttestation(state)
    if (attest && !attested) {
      message.warning('请先确认已当面向候选人告知采集事项并取得同意')
      return
    }
    setPhase('starting')
    setSpeechError('')
    setSpeechNotice('')
    setLiveText('')
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不能使用麦克风，请使用最新版 Edge 或 Chrome，并通过安全地址访问本系统')
      await send(`/listening/${candidateId}/start`, 'POST', {
        consented: true,
        ...(attest ? { candidate_confirmed: true } : {}),
        candidate_code: state.candidate.code,
        notice_version: state.notice_version,
      })
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      microphone.current = stream
      const handle = await startSpeech(stream, { kind: 'listening', target_id: candidateId }, setLiveText, text => {
        // 录音过程中连接中断：已收到的录音和转写留在“录音留存”中，可以继续录下一段。
        setSpeechError(text)
        setSpeechNotice('')
        setRecording(false)
        setLiveText('')
        speech.current = null
        releaseMicrophone()
        void refreshLatest.current()
      }, { onNotice: setSpeechNotice })
      speech.current = handle
      setRecording(true)
    } catch (error) {
      speech.current?.abort()
      speech.current = null
      releaseMicrophone()
      setSpeechError(recordingErrorMessage(error))
    } finally {
      setPhase('idle')
      await refresh()
    }
  }

  /** 保存的录音按对话语境区分发言人。在后台进行，不耽误继续录音；区分不出来时转写照常按连续对话显示。 */
  const separate = (candidate: number, captureId: string) => {
    void send<{ speakers: ListeningState['speakers'] }>(`/listening/${candidate}/roles`, 'POST', { capture_id: captureId })
      .then(result => setState(current => current && current.candidate_id === candidate ? { ...current, speakers: result.speakers } : current))
      .catch(() => undefined)
  }

  /** 结束当前这一段录音，保存最终转写并计入本场记录。 */
  const stopSegment = async (requestSuggestion: boolean) => {
    const handle = speech.current
    if (!handle || !candidateId) return
    setRecording(false)
    try {
      const result = await handle.stop()
      if (result.text.trim()) {
        await send(`/listening/${candidateId}/capture`, 'POST', { capture_id: result.capture_id })
        // 结束本场时由综合报告的生成过程区分发言人，这里不重复发起。
        if (requestSuggestion) separate(candidateId, result.capture_id)
        if (requestSuggestion && autoSuggest) await suggestLatest.current(true)
      } else {
        message.warning('本段没有识别到文字，音频仍已保存')
      }
      setLiveText('')
    } finally {
      speech.current = null
      setSpeechNotice('')
      releaseMicrophone()
      await refresh()
    }
  }

  const pause = async () => {
    setPhase('saving')
    try {
      await stopSegment(true)
    } catch (error) {
      setLiveText('')
      setSpeechError(recordingErrorMessage(error))
    } finally {
      setPhase('idle')
    }
  }

  const finish = async () => {
    if (!candidateId || busy) return
    const candidate = candidateId
    setPhase('finishing')
    setSpeechError('')
    message.loading({ content: '正在保存最后一段转写…', key: 'listening-finish', duration: 0 })
    try {
      // 先保存最后一段录音，再结束本场；综合报告在后台生成，结束过程中不再请求补充提问。
      await stopSegment(false)
      await send(`/listening/${candidate}/finish`, 'POST', { background: true })
      watching.current.report = candidate
      await refresh()
      message.destroy('listening-finish')
    } catch (error) {
      message.error({ content: (error as Error).message, key: 'listening-finish' })
    } finally {
      setPhase('idle')
    }
  }

  const prepare = async () => {
    if (!candidateId || preparing) return
    const candidate = candidateId
    setRequestingPrepare(true)
    setPrepareError('')
    try {
      // 在后台生成：接口立即返回，进度和结果从旁听状态里读取。
      await send(`/listening/${candidate}/prepare`, 'POST', { background: true })
      watching.current.prepare = candidate
      await loadState(candidate, true)
    } catch (error) {
      setPrepareError((error as Error).message)
    } finally {
      setRequestingPrepare(false)
    }
  }

  const regenerate = async () => {
    if (!candidateId || regenerating || reportRunning) return
    const candidate = candidateId
    setRegenerating(true)
    try {
      await send(`/listening/${candidate}/report/regenerate`, 'POST')
      watching.current.report = candidate
      await refresh()
    } catch (error) {
      message.error((error as Error).message)
    } finally {
      setRegenerating(false)
    }
  }

  const act = async (source: QuestionSource, id: number, action: QuestionAction, text = ''): Promise<boolean> => {
    if (!candidateId) return false
    const candidate = candidateId
    setActing(`${source}-${id}`)
    try {
      const result = await send<SuggestionResult>(`/listening/${candidate}/suggestions`, 'POST', {
        suggestion_id: id, action, edited_text: text, source,
      })
      setState(current => current && current.candidate_id === candidate
        ? { ...current, suggestions: result.suggestions, prepared_questions: result.prepared_questions }
        : current)
      message.success(actionDone[action])
      return true
    } catch (error) {
      if (action === 'edited') setEditError((error as Error).message)
      else message.error((error as Error).message)
      return false
    } finally {
      setActing('')
    }
  }

  const openEdit = (source: QuestionSource, id: number, text: string) => {
    setEditError('')
    setEdit({ source, id, text })
  }

  const saveEdit = async () => {
    if (!edit) return
    const text = edit.text.trim()
    if (!text) {
      setEditError('请填写修改后的问题')
      return
    }
    if (await act(edit.source, edit.id, 'edited', text)) setEdit(null)
  }

  const runOnCapture = async (key: string, task: () => Promise<void>) => {
    setWorking(key)
    try {
      await task()
    } catch (error) {
      message.error((error as Error).message)
    } finally {
      setWorking('')
    }
  }

  const download = (capture: Capture, index: number) => runOnCapture(`download-${capture.id}`, async () => {
    await downloadAudioAsMp3(`/speech/captures/${capture.id}/audio`, `面试录音-${state?.candidate.code || candidateId}-第${index + 1}段.mp3`)
    message.success('MP3 音频已开始下载')
  })

  const attach = (capture: Capture) => runOnCapture(`attach-${capture.id}`, async () => {
    await send(`/listening/${candidateId}/capture`, 'POST', { capture_id: capture.id })
    message.success('转写已计入本场记录')
    if (candidateId) separate(candidateId, capture.id)
    await refresh()
  })

  const label = (capture: Capture, speaker: string) => runOnCapture(`label-${capture.id}`, async () => {
    await send(`/listening/${candidateId}/speaker`, 'POST', { capture_id: capture.id, speaker })
    message.success('发言人已标注')
    if (candidateId && speaker === 'dialogue') separate(candidateId, capture.id)
    await refresh()
  })

  const confirmTurn = (captureId: string, turn: SpeakerTurn, role: SpeakerRole) => runOnCapture(turnKey(captureId, turn), async () => {
    const candidate = candidateId
    const result = await send<{ turns: SpeakerTurn[] }>(`/listening/${candidate}/turns`, 'POST', {
      capture_id: captureId, first: turn.first, last: turn.last, role,
    })
    setState(current => current && current.candidate_id === candidate
      ? { ...current, speakers: { ...current.speakers, [captureId]: { ...(current.speakers?.[captureId] || { speaker: 'dialogue' }), turns: result.turns } } }
      : current)
    message.success(role === turn.role ? '已确认这段话的发言人' : '已改正这段话的发言人')
  })

  // 综合报告还是AI生成的原样（没有人工修改或确认）时可以重新生成。
  const reportMeta = state?.comprehensive_report_meta
  const regenerable = state?.status === 'completed' && reportMeta?.status !== 'confirmed'
    && (reportMeta?.versions || []).every(version => version.version_type === 'ai_original')

  const editBusy = Boolean(edit) && acting === `${edit?.source}-${edit?.id}`
  return (
    <>
      <PageHeader title="AI旁听" description="人工面试时记录对话并给出提问建议；结束后生成综合报告，交人工复核。" actions={<AiNotice />} />
      <CandidatePicker
        batches={batches}
        batchesLoading={batchesLoading}
        batchId={batchId}
        candidates={candidates}
        candidatesLoading={candidatesLoading}
        candidateId={candidateId}
        locked={locked}
        error={pickerError}
        onBatchChange={id => select(id, undefined)}
        onCandidateChange={id => select(batchId, id)}
        onRefresh={() => { void loadBatches(); void loadCandidates(batchId) }}
      />

      {candidateId && stateLoading && <Card className="section-card"><Skeleton active /></Card>}
      {candidateId && stateError && (
        <Alert
          className="section-row"
          type="error"
          showIcon
          message="候选人的旁听资料暂时无法读取"
          description={stateError}
          action={<Button size="small" onClick={() => void loadState(candidateId)}>重新读取</Button>}
        />
      )}

      {state && (
        <>
          <div className="listening-workspace-title">
            <Typography.Title level={3}>{state.candidate.name}</Typography.Title>
            <Typography.Text type="secondary">{state.candidate.code}</Typography.Text>
            {state.batch && <Tag>{state.batch.name}</Tag>}
            {state.job && <Tag>{state.job.name}</Tag>}
            <StatusTag kind="listening" value={state.status} />
          </div>
          {!recordable && (
            <Alert
              className="page-alert"
              type="warning"
              showIcon
              message="语音转写服务尚未配置，暂时不能录音和转写"
              description="可以先查看候选人的简历、硬指标和岗位要求，生成并处理提问建议。语音转写服务配置完成后刷新本页，即可开始旁听；已准备的提问建议会保留。"
            />
          )}
          <ReferencePanel key={`${state.candidate_id}-${state.mode}`} state={state} />
          <Row gutter={[16, 16]} className="section-row">
            <Col xs={24} xl={recordable ? 12 : 24}>
              <Card
                title="提问建议"
                className="full-height-card listening-questions-card"
                tabList={followupTab ? [
                  { key: 'prepared', label: <TabLabel text="开始前准备的提问" pending={pendingPrepared} /> },
                  { key: 'followup', label: <TabLabel text="现场补充提问" pending={pendingFollowups} /> },
                ] : undefined}
                activeTabKey={activeTab}
                onTabChange={key => setTab(key as QuestionTab)}
                tabProps={{ size: 'middle' }}
              >
                {activeTab === 'prepared' && (
                  <PreparedQuestions
                    questions={state.prepared_questions}
                    readOnly={state.status === 'completed'}
                    preparing={preparing}
                    task={prepareTask}
                    error={prepareError || (prepareTask?.status === 'failed' ? prepareTask.error : '')}
                    acting={acting}
                    hasResume={state.resume_context?.status === 'ready'}
                    linked={state.mode === 'linked'}
                    onPrepare={() => void prepare()}
                    onAct={(question, action) => void act('prepared', question.id, action)}
                    onEdit={question => openEdit('prepared', question.id, question.text)}
                  />
                )}
                {activeTab === 'followup' && (
                  <FollowupSuggestions
                    suggestions={state.suggestions}
                    status={state.status}
                    recordable={recordable}
                    autoSuggest={autoSuggest}
                    suggesting={suggesting}
                    note={suggestNote}
                    busy={busy}
                    acting={acting}
                    onAutoSuggestChange={setAutoSuggest}
                    onSuggest={() => void suggest()}
                    onAct={(suggestion, action) => void act('followup', suggestion.id, action)}
                    onEdit={suggestion => openEdit('followup', suggestion.id, suggestion.edited_text || suggestion.text)}
                  />
                )}
              </Card>
            </Col>
            {recordable && (
              <Col xs={24} xl={12}>
                <Card title="旁听记录" className="listening-control-card">
                  <SessionPanel
                    state={state}
                    recording={recording}
                    phase={phase}
                    suggesting={suggesting}
                    liveText={liveText}
                    speechError={speechError}
                    speechNotice={speechNotice}
                    attested={attested}
                    working={working}
                    onAttestedChange={setAttested}
                    onStart={() => void start()}
                    onPause={() => void pause()}
                    onFinish={() => void finish()}
                    onTurn={(captureId, turn, role) => void confirmTurn(captureId, turn, role)}
                  />
                </Card>
                <Card title="录音留存" className="section-card">
                  <CaptureList state={state} working={working} locked={busy} onDownload={download} onAttach={attach} onLabel={label} />
                </Card>
              </Col>
            )}
          </Row>
          {state.status === 'completed' && reportTask && reportTask.status !== 'completed' && (
            <ReportProgress
              task={reportTask}
              regenerated={Boolean(state.comprehensive_report)}
              busy={regenerating}
              onRegenerate={regenerable ? () => void regenerate() : undefined}
            />
          )}
          {state.comprehensive_report && (
            <ReportSummary
              report={state.comprehensive_report}
              status={reportRunning ? 'generating' : state.comprehensive_report_meta?.status}
              onOpen={can(session, 'report:read') ? () => navigate(REPORTS_PATH) : undefined}
              onRegenerate={regenerable && !reportRunning ? () => void regenerate() : undefined}
              regenerating={regenerating}
            />
          )}
        </>
      )}

      <Modal
        title="修改后采用"
        open={Boolean(edit)}
        okText="保存并采用"
        cancelText="取消"
        confirmLoading={editBusy}
        onCancel={() => { if (!editBusy) setEdit(null) }}
        onOk={() => void saveEdit()}
      >
        <Typography.Paragraph type="secondary">改成你准备提问的原话；保存后按修改后的内容记为已采用。</Typography.Paragraph>
        <Input.TextArea
          aria-label="修改后的问题"
          rows={4}
          maxLength={400}
          showCount
          value={edit?.text || ''}
          onChange={event => { setEditError(''); setEdit(current => current ? { ...current, text: event.target.value } : current) }}
        />
        {editError && <Alert className="section-row" type="error" showIcon message={editError} />}
      </Modal>
    </>
  )
}
