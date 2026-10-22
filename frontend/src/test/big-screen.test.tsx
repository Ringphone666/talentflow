import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { screenScale } from '../pages/candidate/bigScreen'
import { ScreenControls } from '../pages/candidate/ScreenControls'

const root = document.documentElement
// 按钮的名称里带图标的名称，这里只认“大屏显示”而不是“关闭大屏显示”。
const TURN_ON = /(?<!关闭)大屏显示/
const original = { width: window.innerWidth, height: window.innerHeight }

function resize(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
  act(() => { window.dispatchEvent(new Event('resize')) })
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  resize(original.width, original.height)
  localStorage.clear()
})

describe('大屏显示', () => {
  it('放大倍数按屏幕的宽和高取较小的一边，不小于 1，不超过上限', () => {
    expect(screenScale(1920, 1080)).toBe(1.5)
    expect(screenScale(3840, 2160)).toBe(3)
    expect(screenScale(1600, 900)).toBe(1.25)
    // 浏览器有工具栏时可用高度变小，按高度折算，页面不会超出屏幕。
    expect(screenScale(1920, 945)).toBe(1.31)
    expect(screenScale(1280, 720)).toBe(1)
    expect(screenScale(1024, 768)).toBe(1)
    expect(screenScale(7680, 4320)).toBe(3.2)
  })

  it('普通电脑和手机上不出现大屏显示的设置，页面不放大', () => {
    resize(1440, 900)
    const { container } = render(<ScreenControls preferred />)
    expect(container).toBeEmptyDOMElement()
    expect(root).not.toHaveClass('big-screen')
    expect(root.style.getPropertyValue('--screen-zoom')).toBe('')
  })

  it('现场面试在大屏上默认放大；可以关闭，选择会记住；离开页面后恢复原样', () => {
    resize(1920, 1080)
    const first = render(<ScreenControls preferred />)
    expect(root).toHaveClass('big-screen')
    expect(root.style.getPropertyValue('--screen-zoom')).toBe('1.5')
    fireEvent.click(screen.getByRole('button', { name: /关闭大屏显示/ }))
    expect(root).not.toHaveClass('big-screen')
    expect(screen.getByRole('button', { name: TURN_ON })).toHaveAttribute('aria-pressed', 'false')
    first.unmount()

    // 下一位候选人进入时沿用上次的选择。
    const second = render(<ScreenControls preferred />)
    expect(root).not.toHaveClass('big-screen')
    fireEvent.click(screen.getByRole('button', { name: TURN_ON }))
    expect(root).toHaveClass('big-screen')
    second.unmount()
    expect(root).not.toHaveClass('big-screen')
    expect(root.style.getPropertyValue('--screen-zoom')).toBe('')
  })

  it('账号登录的候选人在大屏上默认不放大，可以手动开启；窗口大小变化后倍数随之调整', () => {
    resize(1920, 1080)
    render(<ScreenControls preferred={false} />)
    expect(root).not.toHaveClass('big-screen')
    fireEvent.click(screen.getByRole('button', { name: TURN_ON }))
    expect(root.style.getPropertyValue('--screen-zoom')).toBe('1.5')
    resize(2560, 1440)
    expect(root.style.getPropertyValue('--screen-zoom')).toBe('2')
    resize(1366, 768)
    expect(root).not.toHaveClass('big-screen')
    expect(screen.queryByRole('button', { name: /大屏显示/ })).not.toBeInTheDocument()
  })
})
