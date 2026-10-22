import { api, API_BASE } from './api'

export interface SpeechResult { capture_id: string; text: string; recovered?: boolean }
export interface SpeechHandle { stop: () => Promise<SpeechResult>; abort: () => void; captureId: string }
export interface SpeechOptions {
  signal?: AbortSignal
  onLevel?: (rms: number) => void
  onStage?: (stage: 'connecting' | 'preparing') => void
  /** 服务端的过程提示：实时转写中断但录音仍在保存、正在用录音重新转写。 */
  onNotice?: (message: string) => void
}

/** 停止录音后等最终转写的时间；服务端改用录音重新转写时，按服务端给出的时间等。 */
const FINAL_WAIT = 30000
const RECOVERY_WAIT = 120000

export async function startSpeech(stream: MediaStream,
  target: { kind: 'interview' | 'listening' | 'mic_check'; target_id: number; question_id?: number; phase?: string },
  onText: (text: string) => void, onError: (message: string) => void,
  options: SpeechOptions = {}): Promise<SpeechHandle> {
  let socket: WebSocket | undefined
  let context: AudioContext | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let processor: AudioWorkletNode | undefined
  let mute: GainNode | undefined
  let finished = false
  let remoteReady = false
  let sampled = 0
  let bufferedBytes = 0
  let failure: Error | undefined
  const pendingAudio: ArrayBuffer[] = []
  let stopped: Promise<SpeechResult> | undefined
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  let resolveAudio!: () => void
  let rejectAudio!: (error: Error) => void
  let resolveFinal!: (result: SpeechResult) => void
  let rejectFinal!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const audioReady = new Promise<void>((resolve, reject) => { resolveAudio = resolve; rejectAudio = reject })
  const result = new Promise<SpeechResult>((resolve, reject) => { resolveFinal = resolve; rejectFinal = reject })
  void ready.catch(() => {})
  void audioReady.catch(() => {})
  void result.catch(() => {})
  let audioTimer: number | undefined
  let readyTimer: number | undefined
  let finalTimer: number | undefined
  let finalWait = FINAL_WAIT
  const controller = new AbortController()
  const cleanup = () => {
    window.clearTimeout(audioTimer)
    window.clearTimeout(readyTimer)
    window.clearTimeout(finalTimer)
    options.signal?.removeEventListener('abort', cancel)
    source?.disconnect()
    processor?.disconnect()
    if (processor) processor.port.onmessage = null
    mute?.disconnect()
    pendingAudio.length = 0
    if (context && context.state !== 'closed') void context.close()
  }
  const fail = (text: string) => {
    if (finished) return
    finished = true
    failure = new Error(text)
    controller.abort()
    rejectReady(failure)
    rejectAudio(failure)
    rejectFinal(failure)
    cleanup()
    socket?.close()
    onError(text)
  }
  const cancel = () => fail('录音已中断，已传输内容仍保留')
  const checkActive = () => { if (finished) throw failure || new Error('录音已结束') }
  const sendAudio = (bytes: ArrayBuffer) => {
    if (finished) return
    if (socket?.readyState !== WebSocket.OPEN) throw new Error('实时语音连接已中断，请重新录制')
    if (socket.bufferedAmount > 32000 * 10) throw new Error('音频上传积压，请检查网络后重录')
    socket.send(bytes)
  }
  const waitForFinal = () => {
    window.clearTimeout(finalTimer)
    finalTimer = window.setTimeout(() => fail('等待最终转写超时，录音已保留，请重新录制'), finalWait)
  }

  options.signal?.addEventListener('abort', cancel, { once: true })
  readyTimer = window.setTimeout(() => fail('语音服务连接超时'), 30000)
  let captureId = ''
  try {
    if (options.signal?.aborted) cancel()
    checkActive()
    options.onStage?.('preparing')
    // Start sampling before network setup and keep every opening audio frame.
    context = new AudioContext({ sampleRate: 16000 })
    if (context.sampleRate !== 16000) throw new Error('当前浏览器不支持 16kHz 实时采音，请使用 Edge 或 Chrome')
    await context.audioWorklet.addModule('/pcm-worklet.js')
    checkActive()
    source = context.createMediaStreamSource(stream)
    processor = new AudioWorkletNode(context, 'interview-pcm')
    mute = context.createGain()
    mute.gain.value = 0
    processor.connect(mute).connect(context.destination)
    processor.port.onmessage = event => {
      if (finished || !(event.data instanceof ArrayBuffer)) return
      try {
        const bytes = event.data
        const samples = new Int16Array(bytes)
        let sum = 0
        for (const sample of samples) sum += (sample / 32768) ** 2
        options.onLevel?.(samples.length ? Math.sqrt(sum / samples.length) : 0)
        if (remoteReady) sendAudio(bytes)
        else {
          bufferedBytes += bytes.byteLength
          if (bufferedBytes > 32000 * 10) throw new Error('语音服务尚未就绪，开头音频缓存已满，请重试')
          pendingAudio.push(bytes)
        }
        sampled += samples.length
        // Require 300 ms of input frames. Silence is valid: readiness must not
        // depend on speaking, and quiet audio must never be dropped.
        if (sampled >= 4800) {
          window.clearTimeout(audioTimer)
          resolveAudio()
        }
      } catch (error) { fail((error as Error).message) }
    }
    source.connect(processor)
    audioTimer = window.setTimeout(() => fail('麦克风尚未输出音频，请检查输入设备后重试'), 5000)
    await context.resume()
    checkActive()
    options.onStage?.('connecting')
    const ticket = await api<{ ticket: string; capture_id: string }>('/speech/tickets', {
      method: 'POST', body: JSON.stringify({ ...target, consented: true }), signal: controller.signal,
    })
    checkActive()
    captureId = ticket.capture_id
    const url = new URL(`${API_BASE}/speech/stream`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('ticket', ticket.ticket)
    socket = new WebSocket(url)
    socket.onmessage = event => {
      if (finished) return
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'ready') {
          for (const bytes of pendingAudio) sendAudio(bytes)
          pendingAudio.length = 0
          bufferedBytes = 0
          remoteReady = true
          if (sampled < 4800) options.onStage?.('preparing')
          resolveReady()
        } else if (data.type === 'partial') onText(data.text)
        else if (data.type === 'notice') options.onNotice?.(data.message)
        else if (data.type === 'recovering') {
          // 整段录音重新转写需要的时间比实时转写收尾长，延长等待。
          finalWait = Number(data.wait_seconds) > 0 ? Number(data.wait_seconds) * 1000 : RECOVERY_WAIT
          if (finalTimer !== undefined) waitForFinal()
          options.onNotice?.(data.message)
        } else if (data.type === 'final') {
          finished = true
          onText(data.text)
          resolveFinal({ capture_id: data.capture_id, text: data.text, recovered: Boolean(data.recovered) })
          cleanup()
          socket?.close()
        } else if (data.type === 'error') fail(data.message)
      } catch (error) { fail(error instanceof SyntaxError ? '语音服务返回了无法解析的结果' : (error as Error).message) }
    }
    socket.onerror = () => fail('无法连接实时语音服务，请检查后端与网络')
    socket.onclose = () => { if (!finished) fail('实时语音连接已中断；已传输音频保留，请重新录制') }
    await Promise.all([ready, audioReady])
    checkActive()
  } catch (error) {
    fail((error as Error).message)
    throw failure || error
  } finally { window.clearTimeout(readyTimer) }
  return {
    captureId,
    abort: cancel,
    stop: () => {
      if (stopped) return stopped
      stopped = (async () => {
        if (!finished) {
          source?.disconnect()
          await new Promise<void>((resolve, reject) => {
            const flushTimer = window.setTimeout(() => reject(new Error('音频结束帧发送失败')), 2000)
            const handler = (event: MessageEvent) => {
              if (event.data === 'flushed') { window.clearTimeout(flushTimer); processor?.port.removeEventListener('message', handler); resolve() }
            }
            processor!.port.addEventListener('message', handler)
            processor!.port.postMessage('flush')
          })
          if (socket?.readyState === WebSocket.OPEN) socket.send('finish')
        }
        waitForFinal()
        try { return await result } finally { cleanup() }
      })().catch(error => { fail((error as Error).message); throw error })
      return stopped
    },
  }
}

