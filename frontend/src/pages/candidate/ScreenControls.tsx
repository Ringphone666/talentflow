import { CompressOutlined, ExpandOutlined, FullscreenExitOutlined, FullscreenOutlined } from '@ant-design/icons'
import { Button, Tooltip } from 'antd'
import { useBigScreen, useFullscreen } from './bigScreen'
import './bigScreen.css'

/**
 * 候选人端页面右上角的显示设置：大屏显示和全屏。
 * 只在足够宽的屏幕上出现（会议室智慧屏、投屏），普通电脑和手机上不显示。
 */
export function ScreenControls({ preferred }: { preferred: boolean }) {
  const screen = useBigScreen(preferred)
  const fullscreen = useFullscreen()
  if (!screen.available) return null
  return (
    <>
      <Tooltip title={screen.enabled ? '恢复普通大小' : '按屏幕大小放大页面，离屏幕较远时也能看清'}>
        <Button type="text" aria-pressed={screen.enabled} icon={screen.enabled ? <CompressOutlined /> : <ExpandOutlined />} onClick={screen.toggle}>
          {screen.enabled ? '关闭大屏显示' : '大屏显示'}
        </Button>
      </Tooltip>
      {fullscreen.supported && (
        <Button type="text" aria-pressed={fullscreen.active} icon={fullscreen.active ? <FullscreenExitOutlined /> : <FullscreenOutlined />} onClick={() => void fullscreen.toggle()}>
          {fullscreen.active ? '退出全屏' : '全屏'}
        </Button>
      )}
    </>
  )
}
