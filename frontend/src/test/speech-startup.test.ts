import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import { startSpeech } from '../speech'
import workletCode from '../../public/pcm-worklet.js?raw'

vi.mock('../api', () => ({ api: vi.fn(), API_BASE: 'http://127.0.0.1:8000/api' }))
class Port extends EventTarget {
  onmessage: ((event: { data: unknown }) => void) | null = null
  emit(data: unknown) { this.onmessage?.({ data }); this.dispatchEvent(new MessageEvent('message', { data })) }
  postMessage(data: unknown) {
    if (data === 'flush') {
      this.emit(new Int16Array([99, 100]).buffer)
      this.emit('flushed')
    }
  }
}
let processor: Processor
class Processor {
  port = new Port()
  disconnect = vi.fn()
  constructor() { processor = this }
  connect(node: unknown) { return node }
}
let socket: Socket
class Socket {
  static OPEN = 1
  readyState = 1
  bufferedAmount = 0
  onmessage?: (event: { data: string }) => void
  onerror?: () => void
  onclose?: () => void
  constructor() { socket = this }
  emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
  send = vi.fn((value: unknown) => {
    if (value === 'finish') queueMicrotask(() => this.emit({ type: 'final', text: '完整的开头和结尾', capture_id: 'test' }))
  })
  close = vi.fn(() => { this.readyState = 3 })
}
let context: Context
let loadModule: () => Promise<void>
class Context {
  sampleRate = 16000
  state = 'running'
  destination = {}
  audioWorklet = { addModule: () => loadModule() }
  source = { connect: vi.fn(), disconnect: vi.fn() }
  constructor() { context = this }
  createMediaStreamSource() { return this.source }
  createGain() { return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() } }
  resume = vi.fn().mockResolvedValue(undefined)
  close = vi.fn(() => { this.state = 'closed'; return Promise.resolve() })
}
const stream = {} as MediaStream
const target = { kind: 'interview' as const, target_id: 1, question_id: 1 }
async function settle() { await vi.advanceTimersByTimeAsync(0) }
function frame(value: number) { return new Int16Array(2048).fill(value).buffer }
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('AudioContext', Context)
  vi.stubGlobal('AudioWorkletNode', Processor)
  vi.stubGlobal('WebSocket', Socket)
  loadModule = async () => {}
  vi.mocked(api).mockResolvedValue({ ticket: 'test', capture_id: 'test' })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it('连接尚未完成时缓存所有开头帧，连接后按顺序发送且结尾不丢帧', async () => {
  let ticketReady!: (value: unknown) => void
  vi.mocked(api).mockImplementation(() => new Promise(resolve => { ticketReady = resolve }))
  const onText = vi.fn(), onError = vi.fn(), onLevel = vi.fn()
  const starting = startSpeech(stream, target, onText, onError, { onLevel })
  await settle()
  const frames = [frame(100), frame(200), frame(300)]
  frames.forEach(value => processor.port.emit(value))
  ticketReady({ ticket: 'test', capture_id: 'test' })
  await settle()
  expect(socket.send).not.toHaveBeenCalled()
  socket.emit({ type: 'ready' })
  const handle = await starting
  processor.port.emit(frame(400))
  expect(socket.send.mock.calls.slice(0, 4).map(([bytes]) => new Int16Array(bytes as ArrayBuffer)[0])).toEqual([100, 200, 300, 400])
  expect(onLevel).toHaveBeenCalledTimes(4)
  const stopped = handle.stop()
  expect(handle.stop()).toBe(stopped)
  await expect(stopped).resolves.toMatchObject({ text: '完整的开头和结尾' })
  expect(Array.from(new Int16Array(socket.send.mock.calls[4][0] as ArrayBuffer))).toEqual([99, 100])
  expect(socket.send.mock.calls[5][0]).toBe('finish')
  expect(onError).not.toHaveBeenCalled()
  expect(context.close).toHaveBeenCalled()
})

it('连接成功不等于采音就绪，必须实际收到足量音频帧，静音也能就绪', async () => {
  let ready = false
  const starting = startSpeech(stream, target, vi.fn(), vi.fn()).then(value => { ready = true; return value })
  await settle()
  socket.emit({ type: 'ready' })
  await settle()
  expect(ready).toBe(false)
  processor.port.emit(frame(0))
  processor.port.emit(frame(0))
  await settle()
  expect(ready).toBe(false)
  processor.port.emit(frame(0))
  const handle = await starting
  expect(ready).toBe(true)
  await handle.stop()
})

it('麦克风不输出帧则报错，不进入录音就绪状态', async () => {
  const onError = vi.fn()
  const starting = startSpeech(stream, target, vi.fn(), onError)
  const outcome = starting.catch(error => error)
  await settle()
  socket.emit({ type: 'ready' })
  await vi.advanceTimersByTimeAsync(5001)
  expect((await outcome).message).toContain('麦克风尚未输出音频')
  expect(onError).toHaveBeenCalledOnce()
  expect(context.close).toHaveBeenCalled()
})

it('缓存过量显式失败，不能静默扔掉开头音频', async () => {
  const onError = vi.fn()
  const starting = startSpeech(stream, target, vi.fn(), onError)
  const outcome = starting.catch(error => error)
  await settle()
  for (let i = 0; i < 80; i++) processor.port.emit(frame(i))
  expect((await outcome).message).toContain('缓存已满')
  expect(onError).toHaveBeenCalledOnce()
  expect(socket.send).not.toHaveBeenCalled()
})

it('初始化过程中取消，迟到的模块加载不能再次打开连接', async () => {
  let loaded!: () => void
  loadModule = () => new Promise(resolve => { loaded = resolve })
  const controller = new AbortController()
  const onError = vi.fn()
  const starting = startSpeech(stream, target, vi.fn(), onError, { signal: controller.signal })
  const outcome = starting.catch(error => error)
  controller.abort()
  loaded()
  expect((await outcome).message).toContain('录音已中断')
  expect(api).not.toHaveBeenCalled()
  expect(context.close).toHaveBeenCalledOnce()
})

it('语音服务初始化失败释放采音资源', async () => {
  const onError = vi.fn()
  const starting = startSpeech(stream, target, vi.fn(), onError)
  const outcome = starting.catch(error => error)
  await settle()
  socket.emit({ type: 'error', message: '语音服务不可用' })
  expect((await outcome).message).toBe('语音服务不可用')
  expect(context.close).toHaveBeenCalledOnce()
  expect(onError).toHaveBeenCalledOnce()
})

async function recordingWithLostLiveTranscription(onError = vi.fn(), onNotice = vi.fn()) {
  const starting = startSpeech(stream, target, vi.fn(), onError, { onNotice })
  await settle()
  socket.emit({ type: 'ready' })
  for (let i = 0; i < 3; i++) processor.port.emit(frame(1))
  const handle = await starting
  socket.emit({ type: 'notice', message: '实时转写暂时中断，录音仍在保存' })
  // 停止录音后不会马上收到最终结果：服务端要先用录音重新转写。
  socket.send.mockImplementation(() => {})
  return handle
}

it('实时转写中断后继续上传录音；改用录音重新转写时按服务端给的时间等待', async () => {
  const onError = vi.fn(), onNotice = vi.fn()
  const handle = await recordingWithLostLiveTranscription(onError, onNotice)
  expect(onNotice).toHaveBeenLastCalledWith('实时转写暂时中断，录音仍在保存')
  processor.port.emit(frame(2))
  expect(socket.send).toHaveBeenCalledTimes(4)
  const stopped = handle.stop()
  await settle()
  expect(socket.send).toHaveBeenLastCalledWith('finish')
  socket.emit({ type: 'recovering', message: '正在用已保存的录音重新转写', wait_seconds: 90 })
  expect(onNotice).toHaveBeenLastCalledWith('正在用已保存的录音重新转写')
  // 超过了平时等最终结果的 30 秒，仍在等待。
  await vi.advanceTimersByTimeAsync(60000)
  expect(onError).not.toHaveBeenCalled()
  socket.emit({ type: 'final', text: '用录音重新转写的回答', capture_id: 'test', recovered: true })
  await expect(stopped).resolves.toEqual({ capture_id: 'test', text: '用录音重新转写的回答', recovered: true })
  expect(onError).not.toHaveBeenCalled()
})

it('重新转写超过服务端给的时间仍没有结果时如实报错', async () => {
  const onError = vi.fn()
  const handle = await recordingWithLostLiveTranscription(onError)
  const outcome = handle.stop().catch(error => error)
  await settle()
  socket.emit({ type: 'recovering', message: '正在用已保存的录音重新转写', wait_seconds: 90 })
  await vi.advanceTimersByTimeAsync(89000)
  expect(onError).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1001)
  expect((await outcome).message).toContain('等待最终转写超时')
  expect(onError).toHaveBeenCalledOnce()
})

it('真实PCM处理器保留首帧顺序并在结束时发送未满一包的尾部', () => {
  const output: unknown[] = []
  let Worklet!: new () => { process: (input: Float32Array[][]) => void; port: { onmessage: (event: { data: string }) => void } }
  class Base { port = { postMessage: (value: unknown) => output.push(value), onmessage: () => {} } }
  new Function('AudioWorkletProcessor', 'registerProcessor', workletCode)(Base, (_name: string, ctor: typeof Worklet) => { Worklet = ctor })
  const worklet = new Worklet()
  worklet.process([[new Float32Array(2048).fill(0.25)]])
  worklet.process([[new Float32Array(57).fill(-0.5)]])
  worklet.port.onmessage({ data: 'flush' })
  expect(Array.from(new Int16Array(output[0] as ArrayBuffer))).toEqual(Array(2048).fill(8192))
  expect(Array.from(new Int16Array(output[1] as ArrayBuffer))).toEqual(Array(57).fill(-16384))
  expect(output[2]).toBe('flushed')
})
