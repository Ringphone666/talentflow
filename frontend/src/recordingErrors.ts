/** Explain browser recording failures without exposing browser-specific English errors. */
export function recordingErrorMessage(cause: unknown): string {
  const name = cause && typeof cause === 'object' && 'name' in cause ? String(cause.name) : ''
  const text = typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : ''
  if (['NotFoundError', 'DevicesNotFoundError'].includes(name) || /requested device not found|no (audio )?device|audio-capture/i.test(text)) {
    return '未找到可用麦克风。请连接带麦克风的耳机或 USB 麦克风，并在 Windows“设置 → 系统 → 声音 → 输入”中确认设备可用，然后重试。'
  }
  if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(name) || /permission denied|not-allowed|service-not-allowed/i.test(text)) {
    return '麦克风访问被阻止。请在浏览器地址栏的网站权限中允许使用麦克风，并确认 Windows 麦克风隐私设置允许桌面应用访问，然后重试。'
  }
  if (['NotReadableError', 'TrackStartError'].includes(name) || /could not start audio|device.*in use/i.test(text)) {
    return '麦克风暂时无法使用，可能被其他程序占用。请关闭占用麦克风的程序，检查设备连接后重试。'
  }
  if (name === 'OverconstrainedError') return '当前麦克风不支持录音要求，请在系统声音设置中选择其他输入设备后重试。'
  if (name === 'AbortError') return '录音启动被中断，请检查麦克风连接后重试。'
  if (text === 'no-speech') return '没有识别到声音，请靠近麦克风清晰说出测试口令后重试。'
  if (text === 'network') return '语音识别服务连接失败，请检查网络后重试。'
  return /[\u3400-\u9fff]/.test(text) ? text : '录音或语音识别暂时不可用，请检查麦克风和网络后重试。'
}
