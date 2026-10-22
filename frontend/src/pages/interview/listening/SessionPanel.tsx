import { PauseCircleOutlined, PlayCircleOutlined } from '@ant-design/icons'
import { Alert, Button, Checkbox, Collapse, Empty, Popconfirm, Space, Tag, Typography } from 'antd'
import { StatusTag } from '../../../components/StatusTag'
import { formatTime } from '../../../lib/format'
import { needsAttestation, noticeParagraphs } from './consent'
import { TranscriptLines } from './TranscriptLines'
import type { ListeningState, SessionPhase, SpeakerRole, SpeakerTurn } from './types'

interface Props {
  state: ListeningState
  recording: boolean
  phase: SessionPhase
  suggesting: boolean
  liveText: string
  speechError: string
  /** 转写过程中的提示：实时转写中断但录音仍在保存、正在用录音重新转写。 */
  speechNotice?: string
  attested: boolean
  /** 正在处理的录音操作（下载、关联、标注、改正发言人）。 */
  working?: string
  onAttestedChange: (value: boolean) => void
  onStart: () => void
  onPause: () => void
  onFinish: () => void
  onTurn?: (captureId: string, turn: SpeakerTurn, role: SpeakerRole) => void
}

function Notice({ state }: { state: ListeningState }) {
  const paragraphs = noticeParagraphs(state.notice_text)
  return (
    <>
      {paragraphs.length
        ? paragraphs.map((paragraph, index) => <Typography.Paragraph key={index} className="evidence-text">{paragraph}</Typography.Paragraph>)
        : <Typography.Text type="secondary">未读取到采集告知正文，请在“合规与规则”中核对。</Typography.Text>}
    </>
  )
}

/** 旁听记录：采集告知与同意、录音控制、实时转写和已保存的转写。 */
export function SessionPanel({ state, recording, phase, suggesting, liveText, speechError, speechNotice, attested, working = '', onAttestedChange, onStart, onPause, onFinish, onTurn }: Props) {
  const busy = phase !== 'idle'
  const completed = state.status === 'completed'
  const attest = !completed && needsAttestation(state)
  const record = state.consent_record
  const canStart = !attest || attested
  // 至少保存过一段转写，或正在录音（结束时先保存这一段），才能生成综合报告。
  const finishDisabled = busy || suggesting || (!recording && state.transcript.length === 0)
  const showNotice = !completed && (state.status === 'ready' || attest)
  return (
    <div className="listening-section">
      {showNotice && (
        <div className="listening-notice" aria-label="采集告知">
          <Space wrap size={[8, 8]}>
            <Typography.Text strong>采集告知</Typography.Text>
            <Tag>{state.notice_version}</Tag>
          </Space>
          <Notice state={state} />
          {state.prior_consent_valid
            ? <Alert type="success" showIcon message="候选人已在系统内同意当前版本的采集告知，开始旁听时引用该记录。" />
            : attest
              ? (
                <>
                  <Alert type="warning" showIcon message="系统内没有候选人对当前版本告知的同意记录" description="请当面向候选人说明以上采集事项并取得同意，再勾选确认。确认人和时间会写入审计日志。" />
                  <Checkbox checked={attested} disabled={busy || recording} onChange={event => onAttestedChange(event.target.checked)}>
                    已当面向候选人告知采集事项并取得同意
                  </Checkbox>
                </>
              )
              : null}
        </div>
      )}
      {!showNotice && record?.accepted && (
        <Collapse
          ghost
          size="small"
          className="listening-consent-record"
          items={[{
            key: 'notice',
            label: `采集同意：${record.method || '已记录'}${record.confirmed_at ? ` · ${formatTime(record.confirmed_at)}` : ''}${record.recorded_by ? ` · 记录人 ${record.recorded_by}` : ''}`,
            children: <><Tag>{record.notice_version || state.notice_version}</Tag><Notice state={state} /></>,
          }]}
        />
      )}

      {completed
        ? <Alert type="success" showIcon message="本场旁听已结束，录音和转写已保存，不能继续录音。" />
        : (
          <Space wrap>
            <Button type="primary" icon={<PlayCircleOutlined />} disabled={busy || recording || !canStart} loading={phase === 'starting'} onClick={onStart}>
              {state.status === 'running' ? '继续录音' : '开始AI旁听'}
            </Button>
            <Button icon={<PauseCircleOutlined />} disabled={busy || !recording} loading={phase === 'saving'} onClick={onPause}>暂停并保存</Button>
            <Popconfirm
              title="结束本场旁听并生成综合报告？"
              description="结束后不能继续录音或追加转写。综合报告在后台生成，不用停在这里等；生成后交人工复核。"
              okText="结束并生成"
              cancelText="继续旁听"
              disabled={finishDisabled}
              onConfirm={onFinish}
            >
              <Button type="primary" ghost loading={phase === 'finishing'} disabled={finishDisabled}>结束并生成综合报告</Button>
            </Popconfirm>
          </Space>
        )}
      {!completed && !canStart && <Typography.Text type="secondary">勾选上方确认后才能开始旁听。</Typography.Text>}
      {speechError && <Alert type="error" showIcon message="录音或转写未完成" description={speechError} />}

      {!completed && (recording || phase === 'saving' || phase === 'finishing') && (
        <Alert
          type="info"
          message={recording ? '麦克风采集中 · 实时转写' : '处理中，请等待最终转写保存'}
          description={(
            <>
              {speechNotice && <div className="listening-speech-notice" role="status">{speechNotice}</div>}
              <div className="evidence-text" aria-live="polite">{liveText || '尚未识别到有效语音；请确认麦克风音量后清晰说话'}</div>
            </>
          )}
        />
      )}
      {!completed && state.status === 'running' && !recording && !busy && (
        <Typography.Text type="secondary">录音已暂停，已保存的转写见下方。点击“继续录音”录制下一段。</Typography.Text>
      )}

      <div className="toolbar listening-transcript-title">
        <Typography.Text strong>已保存的转写</Typography.Text>
        <Space size={6}>{recording && <span className="live-dot pulse" role="img" aria-label="正在录音" />}<StatusTag kind="listening" value={state.status} /></Space>
      </div>
      {state.transcript.length === 0
        ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={completed ? '本场旁听没有保存转写' : '开始旁听并保存录音后，转写文字显示在这里'} />
        : (
          <TranscriptLines
            state={state}
            editable={Boolean(onTurn) && state.status === 'running' && !busy}
            working={working}
            onTurn={(captureId, turn, role) => onTurn?.(captureId, turn, role)}
          />
        )}
    </div>
  )
}
