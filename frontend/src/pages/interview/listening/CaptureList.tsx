import { DownloadOutlined, LinkOutlined } from '@ant-design/icons'
import { Button, Empty, Select, Space, Tag, Typography } from 'antd'
import { captureStatusLabels } from '../../../businessLabels'
import { speakerOptions } from './labels'
import type { Capture, ListeningState } from './types'

interface Props {
  state: ListeningState
  /** 正在下载、关联或标注的录音编号。 */
  working: string
  locked: boolean
  onDownload: (capture: Capture, index: number) => void
  onAttach: (capture: Capture) => void
  onLabel: (capture: Capture, speaker: string) => void
}

function analysisLabel(capture: Capture): string {
  if (capture.speaker_status === 'completed') return '已完成声音分组'
  if (capture.speaker_status === 'processing') return '声音分组分析中'
  if (capture.speaker_status === 'failed') return '声音分组未完成，按对话语境核对'
  return '保存后分析声音分组'
}

/** 本人录制的原始录音：回听下载、关联转写、标注发言人。 */
export function CaptureList({ state, working, locked, onDownload, onAttach, onLabel }: Props) {
  const running = state.status === 'running'
  if (!state.captures.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有录音。开始旁听后，每次暂停保存一段录音。" />
  return (
    <ul className="listening-captures">
      {state.captures.map((capture, index) => {
        const label = state.speakers?.[capture.id]?.speaker
        const voices = new Set((capture.speaker_analysis?.turns || []).map(turn => turn.cluster_id)).size
        const pending = capture.status === 'created' || capture.status === 'recording'
        return (
          <li key={capture.id} className="listening-capture" aria-label={`第 ${index + 1} 段录音`}>
            <Space wrap size={[8, 8]}>
              <Typography.Text strong>第 {index + 1} 段录音</Typography.Text>
              <Tag color={['interrupted', 'failed'].includes(capture.status) ? 'error' : capture.status === 'recording' ? 'processing' : capture.status === 'linked' ? 'green' : 'default'}>
                {captureStatusLabels[capture.status] || '状态待核实'}
              </Tag>
              <Tag color={capture.speaker_status === 'completed' ? 'green' : 'default'}>{analysisLabel(capture)}</Tag>
              {voices > 0 && <Typography.Text type="secondary">识别到 {voices} 组声音，身份须人工核对</Typography.Text>}
            </Space>
            <div className="evidence-text">{capture.text || '暂无有效转写'}</div>
            <Space wrap size={[8, 8]}>
              <Button icon={<DownloadOutlined />} loading={working === `download-${capture.id}`} disabled={pending} onClick={() => onDownload(capture, index)}>下载 MP3 音频</Button>
              {running && capture.status === 'completed' && Boolean(capture.text) && (
                <Button icon={<LinkOutlined />} loading={working === `attach-${capture.id}`} disabled={locked} onClick={() => onAttach(capture)}>关联已完成转写</Button>
              )}
              {running && !pending && (
                <Select
                  className="listening-speaker-select"
                  aria-label={`第 ${index + 1} 段录音的发言人`}
                  value={label || 'dialogue'}
                  loading={working === `label-${capture.id}`}
                  disabled={locked || working === `label-${capture.id}`}
                  options={speakerOptions}
                  onChange={value => onLabel(capture, value)}
                />
              )}
            </Space>
            {running && capture.status === 'completed' && Boolean(capture.text) && (
              <Typography.Text type="secondary">这段录音已完成转写但还没有计入本场记录，关联后才会出现在转写和分析中。</Typography.Text>
            )}
          </li>
        )
      })}
      {running && (
        <li className="listening-capture-hint">
          <Typography.Text type="secondary">录音默认按面试官和候选人的连续对话处理：系统按对话语境逐段区分是谁说的（标为“推断”），可以在“已保存的转写”里逐段改正。整段只有一方发言时可以在这里标注；标为面试官发言或无法确定的录音不作为候选人回答的依据。</Typography.Text>
        </li>
      )}
    </ul>
  )
}
