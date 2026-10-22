import { BulbOutlined, LoadingOutlined } from '@ant-design/icons'
import { Alert, Button, Empty, Popconfirm, Tag, Typography } from 'antd'
import { elapsedText } from './labels'
import { QuestionCard } from './QuestionCard'
import type { PreparedQuestion, QuestionAction, TaskState } from './types'

interface Props {
  questions: PreparedQuestion[]
  /** 旁听已结束：只能查看。 */
  readOnly: boolean
  preparing: boolean
  /** 后台生成的进度；刚发起、还没有读到进度时为空。 */
  task?: TaskState | null
  error: string
  /** 正在处理的问题标识，处理期间不能重复操作。 */
  acting: string
  hasResume: boolean
  linked: boolean
  onPrepare: () => void
  onAct: (question: PreparedQuestion, action: 'adopted' | 'ignored') => void
  onEdit: (question: PreparedQuestion) => void
}

function actionsOf(status: string): QuestionAction[] {
  if (status === 'adopted') return ['edited', 'ignored']
  if (status === 'ignored') return ['adopted']
  return ['adopted', 'edited', 'ignored']
}

/** 旁听开始前准备的提问：依据简历和岗位要求生成，不需要第一阶段面试，也不需要语音服务。在提问建议卡片中占一栏。 */
export function PreparedQuestions({ questions, readOnly, preparing, task, error, acting, hasResume, linked, onPrepare, onAct, onEdit }: Props) {
  const basis = `${hasResume ? '简历和' : ''}岗位要求${linked ? '，以及第一阶段AI面试中待核实的内容' : ''}`
  // 顺序固定（按生成时的编号），处理过的问题不挪位置，面试官可以按序号指认。
  const ordered = [...questions].sort((a, b) => a.id - b.id)
  return (
    <div className="listening-section">
      <div className="toolbar">
        <Typography.Text type="secondary">依据{basis}生成</Typography.Text>
        {!readOnly && (questions.length
          ? (
            <Popconfirm
              title="重新生成提问建议？"
              description="重新生成会替换现有的提问建议，已采用和已忽略的记录也会被替换。"
              okText="重新生成"
              cancelText="取消"
              disabled={preparing}
              onConfirm={onPrepare}
            >
              <Button icon={<BulbOutlined />} loading={preparing}>重新生成</Button>
            </Popconfirm>
          )
          : <Button type="primary" icon={<BulbOutlined />} loading={preparing} onClick={onPrepare}>生成提问建议</Button>)}
      </div>
      {preparing && (
        <div className="question-generation-wait" role="status">
          <LoadingOutlined className="question-generation-spinner" />
          <Typography.Text strong>正在生成提问建议{task?.status === 'running' ? `，已用时 ${elapsedText(task.elapsed_seconds)}` : ''}</Typography.Text>
          {task?.status === 'running' && task.progress && <Typography.Text>{task.progress}</Typography.Text>}
          <Typography.Text type="secondary">依据{basis}生成，一般需要几十秒。生成在后台进行，不用停在这里等：可以先查看候选人资料，也可以先开始旁听。</Typography.Text>
        </div>
      )}
      {error && !preparing && (
        <Alert
          className="generation-error"
          type="error"
          showIcon
          message="提问建议没有生成"
          description={error}
          action={!readOnly && <Button size="small" onClick={onPrepare}>重新生成</Button>}
        />
      )}
      {!preparing && questions.length === 0 && !error && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={readOnly ? '本场旁听没有准备提问建议' : `还没有提问建议。生成后，系统依据${basis}提出 4 至 6 个可以直接提问的问题。`}
        />
      )}
      {ordered.map((question, index) => (
        <QuestionCard
          key={question.id}
          name={`准备的提问 ${index + 1}`}
          index={index + 1}
          tags={<>
            <Tag color="green">{question.dimension}</Tag>
            {question.status === 'adopted' && <Tag color="success">已采用</Tag>}
            {question.status === 'adopted' && question.edited && <Tag>已修改</Tag>}
            {question.status === 'ignored' && <Tag>已忽略</Tag>}
          </>}
          text={question.text}
          reason={question.reason}
          quotes={[
            { label: '简历原文', text: question.resume_excerpt },
            { label: '岗位要求原文', text: question.job_excerpt },
          ]}
          handled={question.status !== 'pending'}
          actions={readOnly ? [] : actionsOf(question.status)}
          busy={preparing || acting === `prepared-${question.id}`}
          onAdopt={() => onAct(question, 'adopted')}
          onEdit={() => onEdit(question)}
          onIgnore={() => onAct(question, 'ignored')}
        />
      ))}
    </div>
  )
}
