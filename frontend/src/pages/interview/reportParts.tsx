import { ExclamationCircleOutlined } from '@ant-design/icons'
import { Alert, Card, Col, Descriptions, Empty, Input, List, Modal, Row, Space, Tag, Typography } from 'antd'
import { useState } from 'react'
import { formatTime } from '../../lib/format'
import type { Evaluation } from '../../types'

/** AI面试报告和综合报告共用的展示部件。 */

export interface VersionRecord {
  version: number
  version_type: string
  editor: string
  reason: string
  created_at: string
}

const versionLabels: Record<string, string> = {
  ai_original: 'AI原始版本',
  ai_regenerated: 'AI重新评分版本',
  human_modified: '人工修改版本',
  human_edit: '人工修改版本',
}

export function versionLabel(type: string): string {
  return versionLabels[type] || '其他历史版本'
}

/** 报告列表固定列的宽度；批次、岗位两列平分其余宽度，每列至少 textMin，屏幕更窄时才横向滚动。 */
export const REPORT_COLUMNS = { candidate: 130, status: 124, match: 84, updated: 150, actions: 136, textMin: 140 }
export const REPORT_TABLE_WIDTH = REPORT_COLUMNS.candidate + REPORT_COLUMNS.status + REPORT_COLUMNS.match
  + REPORT_COLUMNS.updated + REPORT_COLUMNS.actions + 2 * REPORT_COLUMNS.textMin

export function scoreText(score: number | null | undefined): string {
  return score === null || score === undefined ? '证据不足' : `${score} / 5`
}

export function EvaluationList({ evaluations }: { evaluations: Evaluation[] }) {
  if (!evaluations.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无六维评价" />
  return (
    <Row gutter={[12, 12]}>
      {evaluations.map(item => (
        <Col xs={24} xl={12} key={item.dimension}>
          <Card size="small" className={item.insufficient ? 'evidence-card insufficient' : 'evidence-card'}>
            <div className="evaluation-title">
              <Space wrap>
                <Typography.Text strong>{item.dimension}</Typography.Text>
                {item.level && <Tag color={item.insufficient ? 'warning' : 'green'}>{item.level}</Tag>}
                {typeof item.weight === 'number' && <Tag>权重 {item.weight}%</Tag>}
              </Space>
              <span className="score-pill">{scoreText(item.score)}</span>
            </div>
            <div className="evidence-text">{item.reason}</div>
            <Descriptions size="small" column={1} items={[
              { key: 'answers', label: '关联回答', children: item.answer_ids?.length ? item.answer_ids.join('、') : <Typography.Text type="warning">证据不足</Typography.Text> },
              { key: 'excerpt', label: '证据摘录', children: <div className="evidence-text">{item.evidence_excerpt || '证据不足'}</div> },
              ...(item.evidence_sufficiency ? [{ key: 'sufficiency', label: '充分程度', children: <Tag color={item.evidence_sufficiency === '充分' ? 'success' : 'warning'}>{item.evidence_sufficiency}</Tag> }] : []),
            ]} />
          </Card>
        </Col>
      ))}
    </Row>
  )
}

export function RiskList({ risks, empty = '暂无风险提示' }: { risks: string[]; empty?: string }) {
  return (
    <List
      size="small"
      dataSource={risks}
      locale={{ emptyText: empty }}
      renderItem={item => (
        <List.Item>
          <Space align="start" size={0}>
            <ExclamationCircleOutlined className="warning-icon" />
            <span className="evidence-text">{item}</span>
          </Space>
        </List.Item>
      )}
    />
  )
}

export function VersionHistory({ versions, current }: { versions: VersionRecord[]; current: number }) {
  return (
    <List
      dataSource={[...versions].reverse()}
      locale={{ emptyText: '暂无版本记录' }}
      renderItem={item => (
        <List.Item>
          <List.Item.Meta
            title={
              <Space wrap>
                <span>v{item.version}</span>
                <Tag color={item.version_type.startsWith('ai_') ? 'blue' : 'green'}>{versionLabel(item.version_type)}</Tag>
                {item.version === current && <Tag>当前版本</Tag>}
              </Space>
            }
            description={
              <>
                <div>{item.editor} · {formatTime(item.created_at)}</div>
                <div className="evidence-text">{item.reason}</div>
              </>
            }
          />
        </List.Item>
      )}
    />
  )
}

export type ReviewAction = 'return' | 'confirm'

/** 退回或人工确认前填写处理原因（写入审计日志）。 */
export function ReasonModal({ action, subject, onCancel, onSubmit }: {
  action: ReviewAction
  /** 例如“张三的AI面试报告”。 */
  subject: string
  onCancel: () => void
  /** 返回失败原因；成功时返回空。 */
  onSubmit: (reason: string) => Promise<string | void>
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const confirm = action === 'confirm'
  const submit = async () => {
    if (busy) return
    if (reason.trim().length < 2) { setError('请填写至少2个字的处理原因'); return }
    setBusy(true)
    setError('')
    const failure = await onSubmit(reason.trim())
    setBusy(false)
    if (failure) setError(failure)
  }
  return (
    <Modal
      open
      title={confirm ? '人工确认报告' : '退回报告'}
      okText={confirm ? '确认并允许导出' : '确认退回'}
      cancelText="取消"
      okButtonProps={{ danger: !confirm }}
      confirmLoading={busy}
      onOk={() => void submit()}
      onCancel={() => { if (!busy) onCancel() }}
      destroyOnHidden
    >
      <Alert
        type={confirm ? 'warning' : 'info'}
        showIcon
        message={confirm ? `确认后允许导出${subject}；报告仍不构成录用结论。` : `退回后${subject}不能导出，需修改并重新确认。`}
        description="处理原因会写入审计日志。"
      />
      <div className="modal-form">
        <label htmlFor="review-reason"><Typography.Text strong>处理原因</Typography.Text></label>
        <Input.TextArea id="review-reason" rows={3} value={reason} status={error ? 'error' : undefined} onChange={event => setReason(event.target.value)} placeholder={confirm ? '例如：已核对回答原文和评分依据' : '例如：评分依据与回答原文不符，请修改'} />
        {error && <Typography.Text type="danger">{error}</Typography.Text>}
      </div>
    </Modal>
  )
}
