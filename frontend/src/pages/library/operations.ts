import { waitForOperation } from '../../api'
import type { Operation } from '../../api'

/**
 * 轮询间隔（毫秒），测试中可调小。
 * intervalMs：等待一次后台处理；pendingMs：列表中有“解析中”的简历时自动刷新。
 */
export const polling = { intervalMs: 1500, pendingMs: 5000 }

/** 等待后台处理结束，期间把进度说明交给页面显示。 */
export function followOperation<T>(operation: Operation<T>, onProgress?: (text: string) => void): Promise<T> {
  return waitForOperation<T>(operation, onProgress, polling.intervalMs)
}

/** 触发浏览器保存一段由页面生成的内容。 */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

/** 去掉文件名中不能使用的字符。 */
export function safeFileName(name: string, fallback = '未命名'): string {
  const cleaned = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  return cleaned || fallback
}
