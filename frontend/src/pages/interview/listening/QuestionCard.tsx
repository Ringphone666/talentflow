import { CheckOutlined, CloseOutlined, EditOutlined } from '@ant-design/icons'
import { Button, Space, Typography } from 'antd'
import type { ReactNode } from 'react'
import type { QuestionAction } from './types'

interface Quote {
  label: string
  text?: string
}

interface Props {
  /** 供读屏和测试定位的名称，如“准备的提问 1”。 */
  name: string
  /** 序号，显示在问题左侧，便于面试官口头指认（“问第 3 个”）。 */
  index: number
  tags: ReactNode
  text: string
  reason?: string
  quotes: Quote[]
  note?: ReactNode
  /** 已处理的问题用较浅的底色。 */
  handled?: boolean
  /** 可以执行的操作；不传则只读。 */
  actions?: QuestionAction[]
  busy?: boolean
  onAdopt?: () => void
  onEdit?: () => void
  onIgnore?: () => void
}

/**
 * 一条提问建议。问题是主体；提问理由和引用的原文完整显示在问题下方，字号略小，不折叠、不截断。
 * 位置固定（处理后不重新排序），处理过的用浅底色和标签区分。
 */
export function QuestionCard({ name, index, tags, text, reason, quotes, note, handled = false, actions = [], busy = false, onAdopt, onEdit, onIgnore }: Props) {
  const shown = quotes.filter(item => item.text)
  return (
    <section className={`listening-question${handled ? ' handled' : ''}`} aria-label={name}>
      <div className="listening-question-head">
        <span className="listening-question-number" aria-hidden="true">{index}</span>
        <Space size={[6, 4]} wrap>{tags}</Space>
      </div>
      <div className="listening-question-text evidence-text">{text}</div>
      {(reason || shown.length > 0) && (
        <div className="listening-question-basis">
          {reason && <div className="evidence-text"><Typography.Text type="secondary">提问理由</Typography.Text>{reason}</div>}
          {shown.map(item => (
            <blockquote key={item.label} className="evidence-quote">
              <Typography.Text type="secondary" className="evidence-source">{item.label}</Typography.Text>
              {item.text}
            </blockquote>
          ))}
        </div>
      )}
      {note}
      {actions.length > 0 && (
        <Space wrap className="listening-question-actions">
          {actions.includes('adopted') && <Button size="small" type="primary" icon={<CheckOutlined />} disabled={busy} onClick={onAdopt}>采用</Button>}
          {actions.includes('edited') && <Button size="small" icon={<EditOutlined />} disabled={busy} onClick={onEdit}>修改后采用</Button>}
          {actions.includes('ignored') && <Button size="small" type="text" icon={<CloseOutlined />} disabled={busy} onClick={onIgnore}>忽略</Button>}
        </Space>
      )}
    </section>
  )
}
