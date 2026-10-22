export const RESUME_FILE_TYPES = ['.pdf', '.docx', '.txt']
export const RESUME_MAX_BYTES = 50 * 1024 * 1024
/** 人员库单次导入上限 = 单个匹配任务人数上限 × 5（后端 persons.py 的规则）。 */
export const IMPORT_LIMIT_FACTOR = 5
export const UNKNOWN_NAME = '待人工确认'
export const OCR_AUTHORISATION = '扫描页需要发送到文字识别服务处理，我确认已获得授权'

export const categoryColors: Record<string, string> = { 社招: 'blue', 校招: 'green', 内聘: 'purple', 未分类: 'default' }

export interface AttachmentChoice {
  file: File
  /** 对应简历的文件名；null 表示未指定（不会导入）。 */
  resume: string | null
  /** 使用者手动选过对应关系后，不再自动对应。 */
  manual: boolean
}

/** 与后端保存上传文件时的文件名处理一致，简历与附加材料按这个名称对应。 */
export function uploadName(name: string): string {
  const base = String(name || '').replace(/\\/g, '/').split('/').pop() || ''
  const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^[ .]+|[ .]+$/g, '')
  return cleaned.slice(-160) || '未命名文件'
}

export function stemOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(0, index) : name
}

export function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index < 0 ? '' : name.slice(index).toLowerCase()
}

/** 选择文件时的检查；返回问题说明，没有问题返回空字符串。 */
export function fileProblem(file: File, label: string): string {
  if (!RESUME_FILE_TYPES.includes(extensionOf(file.name))) return `${file.name}：${label}仅支持 PDF、Word（.docx）和 TXT 文件`
  if (!file.size) return `${file.name}：文件内容为空`
  if (file.size > RESUME_MAX_BYTES) return `${file.name}：超过单文件 50MB 上限，请压缩后重新选择`
  return ''
}

/**
 * 按文件名自动对应：附加材料名为“简历文件名_面试纪要”时对应到该简历（与后端规则一致）。
 * 一份简历只在恰好有一份候选材料时才自动对应；已手动选择的不改动；简历被移除后对应关系随之清除。
 */
export function pairAttachments(resumeNames: string[], attachments: AttachmentChoice[]): AttachmentChoice[] {
  const result = attachments.map(item => item.resume && !resumeNames.includes(item.resume) ? { ...item, resume: null, manual: false } : item)
  const taken = new Set(result.map(item => item.resume).filter((name): name is string => Boolean(name)))
  for (const resume of resumeNames) {
    if (taken.has(resume)) continue
    const prefix = `${stemOf(resume)}_`
    const matches = result
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !item.resume && !item.manual && stemOf(uploadName(item.file.name)).startsWith(prefix))
    if (matches.length === 1) {
      result[matches[0].index] = { ...matches[0].item, resume }
      taken.add(resume)
    }
  }
  return result
}

/** 同一份简历对应了多份材料时返回该简历的文件名。 */
export function duplicatedAssignment(attachments: AttachmentChoice[]): string | null {
  const seen = new Set<string>()
  for (const item of attachments) {
    if (!item.resume) continue
    if (seen.has(item.resume)) return item.resume
    seen.add(item.resume)
  }
  return null
}

export function selectionSignature(files: File[]): string {
  return files.map(file => `${file.name}|${file.size}|${file.lastModified}`).join('\n')
}

/** 操作人标识为“业务角色｜登录名”，界面只显示登录名。 */
export function operatorName(operator: string): string {
  const parts = String(operator || '').split('｜')
  return parts[parts.length - 1] || '—'
}

export function fieldStatusColor(status: string): string {
  if (/已确认|已复核/.test(status)) return 'green'
  if (/待|未/.test(status)) return 'gold'
  return 'default'
}
