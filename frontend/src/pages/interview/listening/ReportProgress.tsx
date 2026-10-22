import { LoadingOutlined, ReloadOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Typography } from 'antd'
import { elapsedText } from './labels'
import type { TaskState } from './types'

interface Props {
  task: TaskState
  /** 已经有一份综合报告，这次是重新生成。 */
  regenerated: boolean
  busy: boolean
  /** 可以重新生成时提供。 */
  onRegenerate?: () => void
}

/** 综合报告在后台生成：显示进度；没有生成出来时说明原因，可以重新生成。 */
export function ReportProgress({ task, regenerated, busy, onRegenerate }: Props) {
  if (task.status === 'running') {
    return (
      <Card className="section-card listening-report" title={regenerated ? '综合报告正在重新生成' : '综合报告正在生成'}>
        <div className="question-generation-wait listening-report-wait" role="status">
          <LoadingOutlined className="question-generation-spinner" />
          <Typography.Text strong>{task.progress || '正在生成综合报告'}，已用时 {elapsedText(task.elapsed_seconds)}</Typography.Text>
          <Typography.Text type="secondary">
            本场旁听已经结束，录音和转写已保存。综合报告一般需要一到两分钟，生成在后台进行，不用停在这里等：可以接着旁听下一位候选人，稍后回到这里或在“面试报告”中查看。
          </Typography.Text>
        </div>
      </Card>
    )
  }
  return (
    <Alert
      className="section-row"
      type="error"
      showIcon
      message={task.status === 'interrupted' ? '综合报告的生成被中断' : regenerated ? '综合报告没有重新生成' : '综合报告没有生成'}
      description={<>
        <div>原因：{task.error || '原因未知'}</div>
        <div>本场的录音和转写已经保存，不受影响。{regenerated ? '此前的综合报告仍然保留。' : ''}{onRegenerate ? '' : '请联系有权限的人员重新生成。'}</div>
      </>}
      action={onRegenerate && <Button size="small" icon={<ReloadOutlined />} loading={busy} onClick={onRegenerate}>重新生成</Button>}
    />
  )
}
