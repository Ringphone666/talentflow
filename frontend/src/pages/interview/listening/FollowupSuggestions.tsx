import { SoundOutlined } from '@ant-design/icons'
import { Alert, Button, Checkbox, Empty, Space, Tag, Typography } from 'antd'
import { QuestionCard } from './QuestionCard'
import type { ListeningState, QuestionAction, Suggestion } from './types'

interface Props {
  suggestions: Suggestion[]
  status: ListeningState['status']
  /** 语音转写可用，可以录音。 */
  recordable: boolean
  autoSuggest: boolean
  suggesting: boolean
  /** 本次分析的说明：没有新增回答、分析未完成的原因等。 */
  note: string
  busy: boolean
  acting: string
  onAutoSuggestChange: (value: boolean) => void
  onSuggest: () => void
  onAct: (suggestion: Suggestion, action: 'adopted' | 'ignored') => void
  onEdit: (suggestion: Suggestion) => void
}

function actionsOf(status: string): QuestionAction[] {
  if (status === 'adopted' || status === 'edited') return ['edited', 'ignored']
  if (status === 'ignored') return ['adopted']
  return ['adopted', 'edited', 'ignored']
}

/** 旁听过程中的补充提问：依据候选人的现场回答生成，面试官决定是否采用。在提问建议卡片中占一栏。 */
export function FollowupSuggestions({ suggestions, status, recordable, autoSuggest, suggesting, note, busy, acting, onAutoSuggestChange, onSuggest, onAct, onEdit }: Props) {
  const running = status === 'running'
  // 最新的补充提问针对候选人最近的回答，放在最前面；处理过的不挪位置。
  const ordered = [...suggestions].sort((a, b) => b.id - a.id)
  const firstPending = ordered.find(item => item.status === 'pending')?.id
  return (
    <div className="listening-section">
      {running && recordable && (
        <div className="toolbar">
          <Checkbox checked={autoSuggest} onChange={event => onAutoSuggestChange(event.target.checked)}>随新增转写自动补充提问</Checkbox>
          <Button icon={<SoundOutlined />} loading={suggesting} disabled={busy || suggesting} onClick={onSuggest}>立即分析当前对话</Button>
        </div>
      )}
      {note && <Alert type="info" showIcon message={note} />}
      {ordered.length === 0 && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={status === 'completed'
            ? '本场旁听没有生成补充提问'
            : running
              ? '保存候选人的回答后，系统会结合回答内容给出补充提问'
              : '开始旁听后，系统会结合候选人的现场回答给出补充提问'}
        />
      )}
      {ordered.map((suggestion, index) => (
        <QuestionCard
          key={suggestion.id}
          name={`补充提问 ${ordered.length - index}`}
          index={ordered.length - index}
          tags={<>
            {suggestion.status === 'pending' && <Tag color={suggestion.id === firstPending ? 'success' : 'default'}>{suggestion.id === firstPending ? '优先追问' : '备选'}</Tag>}
            {suggestion.dimension && <Tag color="green">{suggestion.dimension}</Tag>}
            {suggestion.status === 'adopted' && <Tag color="success">已采用</Tag>}
            {suggestion.status === 'edited' && <Tag color="success">已修改后采用</Tag>}
            {suggestion.status === 'ignored' && <Tag>已忽略</Tag>}
            {suggestion.provisional && suggestion.status === 'pending' && <Tag color="gold">依据尚未保存的实时转写</Tag>}
          </>}
          text={suggestion.edited_text || suggestion.text}
          reason={suggestion.reason}
          quotes={[
            { label: '候选人现场回答', text: suggestion.answer_excerpt },
            { label: '第一阶段报告原文', text: suggestion.stage_one_excerpt },
            { label: '简历原文', text: suggestion.resume_excerpt },
          ]}
          note={suggestion.speaker_inferred && (
            <Space direction="vertical" size={2}>
              <Typography.Text type="warning">回答归属按对话语境推测，请面试官核对</Typography.Text>
              {suggestion.speaker_basis && <div className="evidence-text">{suggestion.speaker_basis}</div>}
            </Space>
          )}
          handled={suggestion.status !== 'pending'}
          actions={running ? actionsOf(suggestion.status) : []}
          busy={busy || acting === `followup-${suggestion.id}`}
          onAdopt={() => onAct(suggestion, 'adopted')}
          onEdit={() => onEdit(suggestion)}
          onIgnore={() => onAct(suggestion, 'ignored')}
        />
      ))}
    </div>
  )
}
