import { Select, Space, Tag, Typography } from 'antd'
import { parseTranscriptLine } from './consent'
import { roleColors, roleNames, speakerLabel } from './labels'
import type { ListeningState, SpeakerRole, SpeakerTurn } from './types'

interface Props {
  state: ListeningState
  /** 旁听进行中、且当前没有在保存或生成时，可以改正发言人。 */
  editable: boolean
  /** 正在处理的操作标识。 */
  working: string
  onTurn: (captureId: string, turn: SpeakerTurn, role: SpeakerRole) => void
}

const basisTags: Record<SpeakerTurn['basis'], [label: string, color: string]> = {
  inferred: ['推断', 'gold'],
  confirmed: ['已确认', 'success'],
  pending: ['尚未区分', 'default'],
}

function choices(turn: SpeakerTurn) {
  const roles: SpeakerRole[] = ['interviewer', 'candidate', 'unknown']
  return roles.map(role => ({
    value: role,
    label: role === turn.role ? (role === 'unknown' ? '确认无法判断' : `确认是${roleNames[role]}`) : `改为${roleNames[role]}`,
  }))
}

export function turnKey(captureId: string, turn: SpeakerTurn): string {
  return `turn-${captureId}-${turn.first}`
}

/** 已保存的转写。连续对话按“面试官 / 候选人”逐段显示；推断的结果标明，面试官可以逐段确认或改正。 */
export function TranscriptLines({ state, editable, working, onTurn }: Props) {
  return (
    <ol className="listening-transcript" aria-label="已保存的转写">
      {state.transcript.map((line, index) => {
        const { captureId, text } = parseTranscriptLine(line)
        const label = state.speakers?.[captureId]
        const turns = label?.speaker === 'dialogue' ? label.turns || [] : []
        // 只能改正本人采集的录音。
        const own = state.captures.some(capture => capture.id === captureId)
        return (
          <li key={index} className={`listening-line ${label?.speaker === 'interviewer' ? 'speaker-interviewer' : 'speaker-candidate'}`}>
            <span className="transcript-time">{String(index + 1).padStart(2, '0')}</span>
            <div className="listening-line-body">
              {turns.length > 0
                ? (
                  <>
                    <Typography.Text type="secondary" className="evidence-source">
                      连续对话 · 系统按对话语境区分了发言人，标为“推断”的请核对
                    </Typography.Text>
                    <ul className="listening-turns" aria-label={`第 ${index + 1} 段转写的发言`}>
                      {turns.map((turn, order) => (
                        <li key={`${turn.first}-${turn.last}`} className={`listening-turn role-${turn.role}`}>
                          <Space size={4} wrap>
                            <Tag color={roleColors[turn.role]}>{roleNames[turn.role]}</Tag>
                            <Tag color={basisTags[turn.basis][1]}>{basisTags[turn.basis][0]}</Tag>
                            {editable && own && turn.basis !== 'pending' && (
                              <Select<SpeakerRole>
                                size="small"
                                variant="borderless"
                                className="listening-turn-select"
                                aria-label={`第 ${index + 1} 段转写第 ${order + 1} 段发言的发言人`}
                                placeholder="核对发言人"
                                value={null}
                                popupMatchSelectWidth={false}
                                loading={working === turnKey(captureId, turn)}
                                disabled={Boolean(working)}
                                options={choices(turn)}
                                onChange={role => onTurn(captureId, turn, role)}
                              />
                            )}
                          </Space>
                          <div className="evidence-text">{turn.text}</div>
                        </li>
                      ))}
                    </ul>
                  </>
                )
                : (
                  <>
                    <Typography.Text type="secondary" className="evidence-source">{speakerLabel(label?.speaker)}</Typography.Text>
                    {label?.speaker === 'dialogue' && label.roles_status === 'failed' && (
                      <Typography.Text type="warning" className="listening-roles-note">
                        这段对话没有区分出发言人（{label.roles_error || '原因未知'}），按连续对话处理，引用时请核对是谁说的。
                      </Typography.Text>
                    )}
                    <div className="evidence-text">{text}</div>
                  </>
                )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
