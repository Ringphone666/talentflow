import { SafetyCertificateOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Checkbox, Space, Tag, Typography } from 'antd'
import { noticeParagraphs } from './candidateFlow'

interface Props {
  /** 采集须知的版本和正文，均由后端下发。 */
  version: string
  text: string | undefined
  agreed: boolean
  saving: boolean
  busy: boolean
  error: string
  declined: boolean
  /** 返回上一步的按钮文字；没有上一步时不传。 */
  backLabel?: string
  onBack?: () => void
  onAgreedChange: (value: boolean) => void
  onAgree: () => void
  onDecline: () => void
}

/** 合规须知：候选人阅读采集告知并选择是否同意。 */
export function ConsentCard({ version, text, agreed, saving, busy, error, declined, backLabel, onBack, onAgreedChange, onAgree, onDecline }: Props) {
  const paragraphs = noticeParagraphs(text)
  return (
    <Card className="candidate-card consent-card">
      <div className="candidate-icon"><SafetyCertificateOutlined /></div>
      <Typography.Title level={2}>音频及个人信息采集告知</Typography.Title>
      {version && <Tag>{version}</Tag>}
      {paragraphs.length > 0
        ? <>
          <Alert type="info" showIcon message="请阅读以下内容，并确认是否同意采集。" />
          <div className="consent-copy" aria-label="采集告知正文">
            {paragraphs.map((paragraph, index) => <Typography.Paragraph key={index} className="evidence-text">{paragraph}</Typography.Paragraph>)}
          </div>
        </>
        : <Alert type="error" showIcon message="未能读取采集告知内容" description="请刷新页面后重试；仍无法显示时请联系招聘工作人员。未显示告知内容前不能确认同意。" />}
      <Checkbox checked={agreed} disabled={saving || paragraphs.length === 0} onChange={event => onAgreedChange(event.target.checked)}>
        我已完整阅读并理解上述告知，自愿同意本次面试采集
      </Checkbox>
      {error && <Alert type="error" showIcon message="告知确认未完成" description={error} />}
      <Space wrap className="candidate-actions">
        {backLabel && onBack && <Button disabled={busy} onClick={onBack}>{backLabel}</Button>}
        <Button disabled={saving} onClick={onDecline}>不同意并退出</Button>
        <Button type="primary" size="large" loading={saving} disabled={!agreed || paragraphs.length === 0} onClick={onAgree}>同意并继续</Button>
      </Space>
      {declined && <Alert type="warning" showIcon message="你已选择不同意，因此不能开始面试。可重新勾选同意后继续。" />}
    </Card>
  )
}
