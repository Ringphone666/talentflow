import { Mp3Encoder } from 'lamejs'
import MPEGMode from 'lamejs/src/js/MPEGMode.js'
import Lame from 'lamejs/src/js/Lame.js'
import BitStream from 'lamejs/src/js/BitStream.js'
import GainAnalysis from 'lamejs/src/js/GainAnalysis.js'
import { API_BASE, getSession } from './api'
import { formatConnectionError, formatResponseError } from './requestErrors'

// lamejs 1.2.1 leaves two CommonJS globals implicit in its browser bundle.
// Vite's strict ESM bundle therefore throws before creating an encoder unless
// these package-level values are installed first.
const lameGlobals = globalThis as typeof globalThis & { MPEGMode?: unknown; Lame?: unknown; BitStream?: unknown; GainAnalysis?: unknown }
lameGlobals.MPEGMode = MPEGMode
lameGlobals.Lame = Lame
lameGlobals.BitStream = BitStream
lameGlobals.GainAnalysis = GainAnalysis

interface WavPcm {
  samples: Int16Array
  sampleRate: number
}

function readAscii(view: DataView, offset: number, length: number) {
  return String.fromCharCode(...Array.from({ length }, (_, index) => view.getUint8(offset + index)))
}

/** Decode the PCM WAV written by the backend without relying on AudioContext. */
export function decodePcmWav(buffer: ArrayBuffer): WavPcm {
  const view = new DataView(buffer)
  if (view.byteLength < 44 || readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') throw new Error('录音文件不是有效的 WAV 音频')
  let offset = 12
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataOffset = -1
  let dataLength = 0
  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4)
    const chunkLength = view.getUint32(offset + 4, true)
    const chunkStart = offset + 8
    if (chunkStart + chunkLength > view.byteLength) throw new Error('录音文件内容不完整')
    if (chunkId === 'fmt ' && chunkLength >= 16) {
      const format = view.getUint16(chunkStart, true)
      channels = view.getUint16(chunkStart + 2, true)
      sampleRate = view.getUint32(chunkStart + 4, true)
      bitsPerSample = view.getUint16(chunkStart + 14, true)
      if (format !== 1) throw new Error('暂不支持非 PCM 录音')
    } else if (chunkId === 'data') {
      dataOffset = chunkStart
      dataLength = chunkLength
      break
    }
    offset = chunkStart + chunkLength + (chunkLength % 2)
  }
  if (dataOffset < 0 || !channels || !sampleRate || bitsPerSample !== 16) throw new Error('录音格式不受支持，仅支持 16 位 PCM WAV')
  const frameCount = Math.floor(dataLength / (channels * 2))
  const samples = new Int16Array(frameCount)
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) sum += view.getInt16(dataOffset + (frame * channels + channel) * 2, true)
    samples[frame] = Math.round(sum / channels)
  }
  return { samples, sampleRate }
}

export function encodePcmToMp3(samples: Int16Array, sampleRate: number) {
  const encoder = new Mp3Encoder(1, sampleRate, 128)
  const chunks: Uint8Array[] = []
  const blockSize = 1152
  for (let offset = 0; offset < samples.length; offset += blockSize) {
    const block = samples.subarray(offset, Math.min(offset + blockSize, samples.length))
    const encoded = encoder.encodeBuffer(block)
    if (encoded.length) chunks.push(new Uint8Array(encoded))
  }
  const final = encoder.flush()
  if (final.length) chunks.push(new Uint8Array(final))
  return new Blob(chunks.map(chunk => chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer), { type: 'audio/mpeg' })
}

/**
 * Fetch the locally retained WAV capture and encode it in the browser as a real MP3 file.
 * The recording endpoint only accepts the signed session of the current user.
 */
export async function downloadAudioAsMp3(path: string, filename: string) {
  const token = getSession()?.access_token
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  } catch (error) {
    throw new Error(formatConnectionError(error))
  }
  if (!response.ok) {
    let body: unknown = null
    try { body = await response.json() } catch { /* 非 JSON 响应按状态码说明原因 */ }
    throw new Error(formatResponseError(response.status, body))
  }
  let audio: ArrayBuffer
  try {
    audio = await response.arrayBuffer()
  } catch {
    throw new Error('录音文件接收未完成，请检查网络后重试')
  }
  const { samples, sampleRate } = decodePcmWav(audio)
  const blob = encodePcmToMp3(samples, sampleRate)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename.toLowerCase().endsWith('.mp3') ? filename : `${filename}.mp3`
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  // Keep the object URL alive briefly so Edge has time to start the download.
  window.setTimeout(() => { anchor.remove(); URL.revokeObjectURL(url) }, 1000)
}
