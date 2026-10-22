import { ONSITE_CONSENT_METHOD, type ListeningState } from './types'

/**
 * 开始旁听前是否需要面试官确认“已当面告知采集事项并取得同意”。
 * 候选人在系统内同意过当前版本的告知，或本场旁听已经记录过现场确认的，不需要再次确认。
 */
export function needsAttestation(state: ListeningState): boolean {
  if (state.prior_consent_valid) return false
  const record = state.consent_record
  // 新记录带有稳定的 method_code；旧记录只有中文说明。
  const attested = record?.method_code ? record.method_code === 'onsite_attested' : record?.method === ONSITE_CONSENT_METHOD
  return !(state.status === 'running' && record?.accepted && attested)
}

/** 转写行的格式为“[录音 <录音编号>] 文字”；旧记录可能没有前缀。 */
export function parseTranscriptLine(line: string): { captureId: string; text: string } {
  const match = line.match(/^\[录音 ([^\]\s]+)\]\s?([\s\S]*)$/)
  return match ? { captureId: match[1], text: match[2] } : { captureId: '', text: line }
}

/** 采集告知按段落显示：空行分段，段内换行保留。 */
export function noticeParagraphs(text: string | undefined): string[] {
  return (text || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(part => part.trim()).filter(Boolean)
}
