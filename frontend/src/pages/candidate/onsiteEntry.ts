import type { Session } from '../../types'

/**
 * 线下集中面试的现场入口。
 * 工作人员在现场设备上打开 /interview/onsite#entry=<入口凭证>；凭证只保存在当前标签页的会话存储中，
 * 读取后立即从地址栏移除，关闭标签页即失效。
 */
export const ONSITE_ENTRY_KEY = 'talentflow-onsite-entry'
export const ONSITE_PATH = '/interview/onsite'
export const INTERVIEW_PATH = '/interview'

/** 候选人会话。经现场入口进入时，后端在会话中标明 entry_mode。 */
export type CandidateSession = Session & { entry_mode?: 'account' | 'onsite' }

export function readEntryToken(): string | null {
  try {
    return window.sessionStorage.getItem(ONSITE_ENTRY_KEY) || null
  } catch {
    return null
  }
}

export function storeEntryToken(token: string) {
  try {
    window.sessionStorage.setItem(ONSITE_ENTRY_KEY, token)
  } catch {
    // 会话存储不可用时，凭证只保留在当前页面，刷新后需工作人员重新打开入口。
  }
}

export function clearEntryToken() {
  try {
    window.sessionStorage.removeItem(ONSITE_ENTRY_KEY)
  } catch {
    // 无需处理：没有可清除的内容。
  }
}

/** 地址 # 之后携带的入口凭证；没有时返回 null。 */
export function readEntryFragment(): string | null {
  const value = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('entry')
  return value?.trim() || null
}

/**
 * 工作人员在管理端对某位候选人点“现场面试”时，地址 # 之后另带候选人编号：
 * 打开入口后直接进入该候选人的面试，不用再从名单里找。没有时返回 null。
 */
export function readEntryCandidate(): number | null {
  const value = Number(new URLSearchParams(window.location.hash.replace(/^#/, '')).get('candidate'))
  return Number.isInteger(value) && value > 0 ? value : null
}

/** 现场面试页面的地址。凭证放在 # 之后，不会发给服务器，也不会写进访问日志。 */
export function onsiteLink(token: string, candidateId?: number): string {
  const fragment = new URLSearchParams({ entry: token })
  if (candidateId) fragment.set('candidate', String(candidateId))
  return `${window.location.origin}${ONSITE_PATH}#${fragment.toString()}`
}

/** 把入口凭证从地址栏移除，避免留在浏览记录或被旁人看到。 */
export function removeEntryFragment() {
  if (!window.location.hash) return
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
}
