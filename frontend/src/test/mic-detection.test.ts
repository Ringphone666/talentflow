import { describe, expect, it } from 'vitest'
import { evaluateMicLevels, validateMicPhrase } from '../micDetection'

describe('麦克风人声检测', () => {
  it('静音不能通过', () => {
    const result = evaluateMicLevels(Array(40).fill(0.001), 8, 3200)
    expect(result.passed).toBe(false)
    expect(result.speechFrames).toBe(0)
  })

  it('单次噪声尖峰不能通过', () => {
    const levels = [...Array(8).fill(0.002), 0.08, ...Array(31).fill(0.002)]
    const result = evaluateMicLevels(levels, 8, 3200)
    expect(result.passed).toBe(false)
    expect(result.speechFrames).toBe(1)
  })

  it('持续说话可以通过', () => {
    const levels = [...Array(8).fill(0.002), ...Array(12).fill(0.06), ...Array(20).fill(0.004)]
    const result = evaluateMicLevels(levels, 8, 3200)
    expect(result.passed).toBe(true)
    expect(result.speechFrames).toBe(12)
  })

  it('设备检测必须识别指定测试口令', () => {
    expect(validateMicPhrase('麦克风测试，一二三')).toBe(true)
    expect(validateMicPhrase('麦克风测试123')).toBe(true)
    expect(validateMicPhrase('麦克风测试，一二')).toBe(false)
    expect(validateMicPhrase('请进行麦克风测试，一二三，谢谢')).toBe(false)
    expect(validateMicPhrase('我听不清楚')).toBe(false)
  })
})
