import type { Session } from './types'
import { formatConnectionError, formatResponseError } from './requestErrors'

// 开发时前端由 Vite 提供，接口在本机 8000 端口；构建后由后端一并提供页面，接口与页面同源。
const configuredBase = import.meta.env.VITE_API_BASE || (import.meta.env.DEV ? 'http://127.0.0.1:8000/api' : '/api')
export const API_BASE = new URL(configuredBase, window.location.origin).href.replace(/\/$/, '')
const SESSION_KEY = 'talentflow-session'
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12
type SessionScope = 'admin' | 'candidate'
const sessionKey = (scope?: SessionScope) => (scope || (window.location.pathname.startsWith('/interview') ? 'candidate' : 'admin')) === 'candidate' ? 'talentflow-candidate-session' : SESSION_KEY

function readSessionCookie(key: string): string | null {
  const prefix = `${key}=`
  const item = document.cookie.split('; ').find(value => value.startsWith(prefix))
  if (!item) return null
  try {
    return decodeURIComponent(item.slice(prefix.length))
  } catch {
    return null
  }
}

function writeSessionCookie(value: string | null, key: string) {
  if (value) {
    document.cookie = `${key}=${encodeURIComponent(value)}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; SameSite=Lax`
  } else {
    document.cookie = `${key}=; Path=/; Max-Age=0; SameSite=Lax`
  }
}

function parseSession(raw: string | null): Session | null {
  if (!raw) return null
  try {
    const session = JSON.parse(raw) as Partial<Session>
    if (!session.access_token || !session.expires_at || session.expires_at * 1000 <= Date.now()) return null
    if (!session.username || !session.role || !session.display_name || !session.role_label) return null
    return session as Session
  } catch {
    return null
  }
}

export function getSession(scope?: SessionScope): Session | null {
  const key = sessionKey(scope)
  let localValue: string | null = null
  try {
    localValue = localStorage.getItem(key)
  } catch {
    // Some hardened browsers can deny localStorage while still allowing cookies.
  }
  const session = parseSession(localValue) || parseSession(readSessionCookie(key))
  if (!session) return null
  if ((key === 'talentflow-candidate-session') !== (session.role === 'candidate')) return null
  const serialized = JSON.stringify(session)
  try {
    localStorage.setItem(key, serialized)
  } catch {
    // The cookie remains the refresh fallback.
  }
  writeSessionCookie(serialized, key)
  return session
}

export function setSession(session: Session | null, scope?: SessionScope) {
  const key = sessionKey(scope || (session ? session.role === 'candidate' ? 'candidate' : 'admin' : undefined))
  const serialized = session ? JSON.stringify(session) : null
  try {
    if (serialized) localStorage.setItem(key, serialized)
    else localStorage.removeItem(key)
  } catch {
    // Continue with the same-origin cookie fallback.
  }
  writeSessionCookie(serialized, key)
}

function authHeaders(session: Session | null): Record<string, string> {
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
}

async function request(path: string, options: RequestInit): Promise<Response> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, options)
  } catch (error) {
    throw new Error(formatConnectionError(error))
  }
  if (!response.ok) {
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      // Proxies and unavailable services may return HTML or an empty body.
    }
    throw new ApiError(formatResponseError(response.status, body), response.status, body)
  }
  return response
}

/** 需要读取状态码或附加信息（如同名岗位冲突、扫描页清单）时使用；一般页面只显示 message。 */
export class ApiError extends Error {
  status: number
  detail: unknown
  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = body && typeof body === 'object' ? (body as { detail?: unknown }).detail : undefined
  }
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T
  } catch {
    throw new Error('未能读取处理结果，请刷新查看；如仍失败，请联系管理员')
  }
}

async function readFile(response: Response): Promise<Blob> {
  try {
    return await response.blob()
  } catch {
    throw new Error('文件接收未完成，请检查网络后重试')
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const session = getSession()
  const response = await request(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(session),
      ...options.headers,
    },
  })
  return readJson<T>(response)
}

/** 提交 JSON 的简写。 */
export function send<T>(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<T> {
  return api<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
}

/** 下载文件名：中文名称由后端放在 X-Download-Name（百分号编码）中。 */
export function downloadName(response: Response, fallback: string): string {
  const encoded = response.headers.get('X-Download-Name')
  if (encoded) {
    try { return decodeURIComponent(encoded) } catch { /* 使用下面的回退名称 */ }
  }
  const disposition = response.headers.get('Content-Disposition') || ''
  const extended = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (extended) {
    try { return decodeURIComponent(extended) } catch { /* 使用下面的回退名称 */ }
  }
  return disposition.match(/filename="(.+?)"/)?.[1] || fallback
}

/** 取回文件内容（如录音），由调用方自行处理。 */
export async function fetchFile(path: string): Promise<Blob> {
  const response = await request(path, { headers: { ...authHeaders(getSession()) } })
  return readFile(response)
}

export async function download(path: string, fallback = '下载文件') {
  const session = getSession()
  const response = await request(path, { headers: { ...authHeaders(session) } })
  const blob = await readFile(response)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = downloadName(response, fallback)
  anchor.click()
  URL.revokeObjectURL(url)
}

/** 提交表单（含文件）。不要手动设置 Content-Type，浏览器会自动补 multipart boundary。 */
export async function postForm<T>(path: string, form: FormData): Promise<T> {
  const session = getSession()
  const response = await request(path, { method: 'POST', body: form, headers: { ...authHeaders(session) } })
  return readJson<T>(response)
}

export async function uploadFile<T>(path: string, file: File, fields: Record<string, string> = {}): Promise<T> {
  const form = new FormData()
  form.append('file', file)
  Object.entries(fields).forEach(([key, value]) => form.append(key, value))
  return postForm<T>(path, form)
}

export async function openFile(path: string) {
  const session = getSession()
  // 先在用户点击的同步阶段打开空白页，避免异步 fetch 完成后被浏览器拦截弹窗。
  const preview = window.open('', '_blank')
  try {
    const response = await request(path, { headers: { ...authHeaders(session) } })
    const blob = await readFile(response)
    const url = URL.createObjectURL(blob)
    if (preview) preview.location.href = url
    else window.open(url, '_blank', 'noopener,noreferrer')
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (error) {
    preview?.close()
    throw error
  }
}

/** 耗时处理（简历解析、岗位说明书识别等）在后台进行，接口返回处理记录，页面轮询直到结束。 */
export interface Operation<T = unknown> {
  id: string
  kind: string
  label: string
  status: 'running' | 'completed' | 'failed'
  progress: string
  result: T | null
  error: string
}

export async function waitForOperation<T>(operation: Operation<T>, onProgress?: (text: string) => void, intervalMs = 1500): Promise<T> {
  let current = operation
  while (current.status === 'running') {
    if (current.progress) onProgress?.(current.progress)
    await new Promise(resolve => window.setTimeout(resolve, intervalMs))
    current = await api<Operation<T>>(`/library/operations/${current.id}`)
  }
  if (current.status === 'failed') throw new Error(current.error || '处理未完成，请稍后重试')
  return current.result as T
}
