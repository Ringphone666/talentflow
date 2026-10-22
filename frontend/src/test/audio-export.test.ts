import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setSession } from '../api'
import { decodePcmWav, downloadAudioAsMp3, encodePcmToMp3 } from '../audioExport'
import type { Session } from '../types'

function wav(samples: number[], sampleRate = 16000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const text = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE')
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, samples.length * 2, true)
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true))
  return buffer
}

describe('MP3 导出前的 WAV 解码', () => {
  it('可以读取后端保存的 16 位 PCM WAV', () => {
    const result = decodePcmWav(wav([0, 1000, -1000, 32767]))
    expect(result.sampleRate).toBe(16000)
    expect(Array.from(result.samples)).toEqual([0, 1000, -1000, 32767])
  })

  it('可以把 PCM 音频编码成非空 MP3 Blob', () => {
    const samples = new Int16Array(16000)
    for (let index = 0; index < samples.length; index += 1) samples[index] = Math.round(Math.sin(index / 12) * 12000)
    const blob = encodePcmToMp3(samples, 16000)
    expect(blob.type).toBe('audio/mpeg')
    expect(blob.size).toBeGreaterThan(100)
  })
})

describe('下载旁听录音', () => {
  const interviewer: Session = { access_token: 'signed-session-token', expires_at: 4102444800, username: 'interviewer-a', display_name: '面试官甲', role: 'interviewer', role_label: '面试官', permissions: ['listening:use'] }
  const originalCreateUrl = URL.createObjectURL
  const originalRevokeUrl = URL.revokeObjectURL
  let downloads: Array<{ name: string; href: string }>

  beforeEach(() => {
    downloads = []
    window.history.replaceState(null, '', '/ai-interview/listening')
    setSession(interviewer, 'admin')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:mp3') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ name: this.download, href: this.href })
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    setSession(null, 'admin')
    window.history.replaceState(null, '', '/')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeUrl })
  })

  it('用当前登录会话的令牌读取录音，不再发送旧的身份请求头', async () => {
    const samples = Array.from({ length: 3200 }, (_, index) => Math.round(Math.sin(index / 10) * 9000))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(wav(samples), { headers: { 'Content-Type': 'audio/wav' } }))

    await downloadAudioAsMp3('/speech/captures/capture-1/audio', '面试录音-XZ-021-第1段')

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, options] = fetchMock.mock.calls[0]
    expect(String(url)).toMatch(/\/api\/speech\/captures\/capture-1\/audio$/)
    const headers = new Headers(options?.headers)
    expect(headers.get('Authorization')).toBe('Bearer signed-session-token')
    expect(headers.has('X-User-Role')).toBe(false)
    expect(headers.has('X-User-Name')).toBe(false)
    expect(downloads).toEqual([{ name: '面试录音-XZ-021-第1段.mp3', href: 'blob:mp3' }])
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob
    expect(blob.type).toBe('audio/mpeg')
    expect(blob.size).toBeGreaterThan(100)
  })

  it('会话失效或无权读取时给出可读的原因，不下载文件', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ detail: '登录状态已失效，请重新登录' }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ detail: '无权读取录音' }, { status: 403 }))
      .mockResolvedValueOnce(new Response('<html>Bad Gateway</html>', { status: 502 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(downloadAudioAsMp3('/speech/captures/a/audio', 'a.mp3')).rejects.toThrow('登录状态已失效，请重新登录')
    await expect(downloadAudioAsMp3('/speech/captures/a/audio', 'a.mp3')).rejects.toThrow('无权读取录音')
    await expect(downloadAudioAsMp3('/speech/captures/a/audio', 'a.mp3')).rejects.toThrow('服务暂时无法完成操作')
    await expect(downloadAudioAsMp3('/speech/captures/a/audio', 'a.mp3')).rejects.toThrow('无法连接服务')
    expect(downloads).toHaveLength(0)
  })

  it('返回的不是录音文件时说明原因', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array(64)))
    await expect(downloadAudioAsMp3('/speech/captures/a/audio', 'a.mp3')).rejects.toThrow('录音文件不是有效的 WAV 音频')
    expect(downloads).toHaveLength(0)
  })
})
