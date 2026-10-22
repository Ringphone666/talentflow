import { Alert, Button, Card, Result, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'

/** 现场共用设备：提交后停留片刻，自动回到候选人名单，交给下一位候选人。 */
export const ONSITE_RETURN_SECONDS = 10

interface Props {
  /** 经线下集中面试现场入口进入。 */
  onsite: boolean
  /** 现场入口：返回候选人名单；账号登录：返回登录页。 */
  onLeave: () => void
}

/**
 * 面试提交后的完成页。回答提交即结束，候选人不需要等待任何处理；
 * 页面不显示报告内容和评分，结果由招聘工作人员另行通知。
 */
export function CompletionCard({ onsite, onLeave }: Props) {
  const [remaining, setRemaining] = useState(ONSITE_RETURN_SECONDS)
  const leave = useRef(onLeave)
  leave.current = onLeave

  useEffect(() => {
    if (!onsite) return
    const timer = window.setInterval(() => setRemaining(value => Math.max(0, value - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [onsite])

  useEffect(() => {
    if (onsite && remaining === 0) leave.current()
  }, [onsite, remaining])

  return (
    <Card className="candidate-card">
      <Result
        status="success"
        title="面试已提交"
        subTitle="你的回答已全部提交，本次面试到此结束，不需要等待。面试结果由招聘工作人员另行通知。"
        extra={onsite
          ? <Button type="primary" size="large" onClick={onLeave}>返回候选人名单</Button>
          : <Button type="primary" onClick={onLeave}>返回登录</Button>}
      />
      {onsite && <Typography.Text type="secondary" role="status">{remaining} 秒后自动返回候选人名单，请把设备交还给现场工作人员。</Typography.Text>}
      <Alert type="info" showIcon message="面试评价由招聘工作人员复核后使用，不会由系统自动作出录用或淘汰决定。" />
    </Card>
  )
}
