import { useCallback, useEffect, useState } from 'react'

/**
 * 大屏显示：现场面试用会议室的智慧屏或投屏时，候选人和旁边的工作人员离屏幕较远。
 * 开启后页面按屏幕大小等比放大（相当于把 1280×720 的页面铺满屏幕），文字、按钮、题目一起变大。
 */
const PREFERENCE_KEY = 'talentflow-big-screen'
const BASE_WIDTH = 1280
const BASE_HEIGHT = 720
/** 屏幕宽度达到这个数才提供大屏显示；普通电脑和手机上不需要。 */
export const BIG_SCREEN_MIN_WIDTH = 1600
const MAX_SCALE = 3.2

function readPreference(): boolean | null {
  try {
    const value = window.localStorage.getItem(PREFERENCE_KEY)
    return value === 'on' ? true : value === 'off' ? false : null
  } catch {
    return null
  }
}

function savePreference(value: boolean) {
  try {
    window.localStorage.setItem(PREFERENCE_KEY, value ? 'on' : 'off')
  } catch {
    // 不能保存时只在本次页面内生效。
  }
}

/** 放大倍数：宽和高都不能超出屏幕，保留两位小数。 */
export function screenScale(width: number, height: number): number {
  const scale = Math.min(width / BASE_WIDTH, height / BASE_HEIGHT, MAX_SCALE)
  return Math.max(1, Math.floor(scale * 100) / 100)
}

/**
 * @param preferred 没有保存过选择时是否默认开启（现场面试默认开启）。
 */
export function useBigScreen(preferred: boolean) {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const [choice, setChoice] = useState<boolean | null>(readPreference)
  const available = size.width >= BIG_SCREEN_MIN_WIDTH
  const enabled = available && (choice ?? preferred)
  const scale = enabled ? screenScale(size.width, size.height) : 1

  useEffect(() => {
    const update = () => setSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    if (scale > 1) {
      root.classList.add('big-screen')
      root.style.setProperty('--screen-zoom', String(scale))
    } else {
      root.classList.remove('big-screen')
      root.style.removeProperty('--screen-zoom')
    }
    return () => {
      root.classList.remove('big-screen')
      root.style.removeProperty('--screen-zoom')
    }
  }, [scale])

  const toggle = useCallback(() => {
    setChoice(current => {
      const next = !(current ?? preferred)
      savePreference(next)
      return next
    })
  }, [preferred])

  return { available, enabled, scale, toggle }
}

/** 全屏显示：隐藏浏览器的地址栏和标签栏。浏览器不支持时 supported 为 false。 */
export function useFullscreen() {
  const supported = typeof document.documentElement.requestFullscreen === 'function'
  const [active, setActive] = useState(() => Boolean(document.fullscreenElement))

  useEffect(() => {
    const update = () => setActive(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', update)
    return () => document.removeEventListener('fullscreenchange', update)
  }, [])

  const toggle = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
    } catch {
      // 浏览器拒绝全屏（例如不是由点击触发）时保持原样。
    }
  }, [])

  return { supported, active, toggle }
}
