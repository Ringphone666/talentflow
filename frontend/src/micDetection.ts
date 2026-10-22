export interface MicDetectionResult {
  passed: boolean
  peakRms: number
  speechFrames: number
  threshold: number
  durationMs: number
}

export function normalizeMicPhrase(text: string) {
  return text
    .replace(/[\s，。、“”‘’！？!?：:；;,.，、]/g, '')
    .replace(/[壹一]/g, '一')
    .replace(/[贰二两]/g, '二')
    .replace(/[叁三]/g, '三')
    .toLowerCase()
}

export function validateMicPhrase(text: string) {
  const normalized = normalizeMicPhrase(text)
  return normalized === '麦克风测试一二三' || normalized === '麦克风测试123'
}

export function evaluateMicLevels(levels: number[], calibrationFrames: number, durationMs: number): MicDetectionResult {
  const calibration = levels.slice(0, Math.max(1, calibrationFrames)).sort((a, b) => a - b)
  const noiseFloor = calibration[Math.floor(calibration.length / 2)] || 0
  const threshold = Math.max(0.02, noiseFloor * 2.5, noiseFloor + 0.015)
  const speechLevels = levels.slice(calibrationFrames)
  const speechFrames = speechLevels.filter(level => level >= threshold).length
  const peakRms = speechLevels.length ? Math.max(...speechLevels) : 0
  return {
    passed: durationMs >= 2200 && peakRms >= 0.02 && speechFrames >= 5,
    peakRms,
    speechFrames,
    threshold,
    durationMs,
  }
}
