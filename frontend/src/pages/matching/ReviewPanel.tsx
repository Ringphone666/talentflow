import { Alert, Button, Checkbox, Form, Input, Radio, Select, Space, Tag, Typography, message } from 'antd'
import { useRef, useState } from 'react'
import { send } from '../../api'
import { formatTime } from '../../lib/format'
import { decisionLabel } from './shared'
import type { Assessment, CandidateDetail, DecisionOption, MatchingMode } from './types'

interface ReviewValues {
  decision?: string
  comment?: string
  material_checked?: boolean
}

/** 保存后的去向：留在当前内容、转到本人下一个未复核的岗位、转到下一位待审核人员。 */
export type AfterReview = { kind: 'stay' } | { kind: 'job'; jobId: string } | { kind: 'person' }

interface FieldsProps {
  detail: CandidateDetail
  fit: boolean
  decisions: DecisionOption[]
  assessment?: Assessment
  blocked: boolean
  hasNext: boolean
  onJobChange: (jobId: string) => void
  onSaved: (after: AfterReview) => void
}

export const DECISION_COLORS: Record<string, string> = {
  进入下一轮: 'green', 保留: 'blue', 淘汰: 'red', 推荐至该岗位: 'green', 作为备选岗位: 'blue', 暂不推荐: 'red',
}

/** 复核表单。换人、换岗位或已保存的资料、结论变化后重新建立，按已保存的内容填入。 */
function ReviewFields({ detail, fit, decisions, assessment, blocked, hasNext, onJobChange, onSaved }: FieldsProps) {
  const [form] = Form.useForm<ReviewValues>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const after = useRef<AfterReview>({ kind: 'stay' })
  // 人才适岗逐个岗位给结论：保存后可直接转到本人下一个还没有结论、且评分有效的岗位。
  const nextJob = fit ? detail.assessments.find(item => item.job_id !== assessment?.job_id && !item.decision && !item.stale) : undefined

  const submit = async (values: ReviewValues) => {
    if (!assessment || blocked || saving) return
    setSaving(true)
    setError('')
    try {
      await send(`/matching/candidates/${encodeURIComponent(detail.candidate_id)}/review`, 'POST', {
        decision: values.decision,
        comment: (values.comment || '').trim(),
        material_checked: true,
        expected_material_version: detail.material.material_version,
        ...(fit ? { job_id: assessment.job_id } : {}),
      })
      message.success(fit ? `“${assessment.job_name}”的人工复核已保存` : '人工复核已保存')
      form.setFieldValue('material_checked', false)
      onSaved(after.current)
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Form<ReviewValues>
      form={form} layout="vertical" disabled={blocked || saving}
      initialValues={{
        decision: decisions.some(item => item.value === assessment?.decision) ? assessment?.decision : undefined,
        comment: assessment?.review_comment || '',
        material_checked: false,
      }}
      onFinish={values => void submit(values)}
    >
      {error && <Alert className="page-alert" type="error" showIcon message="复核未保存" description={error} />}
      {fit && detail.assessments.length > 0 && (
        <Form.Item label="复核岗位" required extra="每次对一个岗位给出结论；上方的分析内容会切换到所选岗位。">
          <Select
            // 某个岗位暂时不能复核时，仍可切换到其他岗位。
            aria-label="复核岗位" value={assessment?.job_id} onChange={onJobChange} disabled={saving}
            options={detail.assessments.map(item => ({
              value: item.job_id,
              label: `${item.job_name} · ${item.decision ? decisionLabel(item.decision, decisions) : '未复核'}`,
            }))}
          />
        </Form.Item>
      )}
      <Form.Item
        name="material_checked" valuePropName="checked"
        rules={[{ validator: (_, value) => value ? Promise.resolve() : Promise.reject(new Error('请先确认已核对本人资料和评分依据')) }]}
      >
        <Checkbox>已核对本人资料和评分依据</Checkbox>
      </Form.Item>
      <Form.Item
        name="comment" label="复核意见" required
        rules={[
          { validator: (_, value) => String(value || '').trim().length >= 2 ? Promise.resolve() : Promise.reject(new Error('请填写复核意见，至少 2 个字')) },
          { max: 2000, message: '复核意见最多 2000 个字' },
        ]}
      >
        <Input.TextArea autoSize={{ minRows: 3 }} maxLength={2000} showCount placeholder="写明核对了哪些资料和依据，以及作出结论的理由" />
      </Form.Item>
      <Form.Item name="decision" label={fit ? '岗位推荐结论' : '复核结论'} rules={[{ required: true, message: '请选择复核结论' }]}>
        <Radio.Group options={decisions.map(item => ({ value: item.value, label: item.label }))} />
      </Form.Item>
      <Space wrap>
        <Button type="primary" htmlType="submit" loading={saving} onClick={() => { after.current = { kind: 'stay' } }}>提交人工复核</Button>
        {nextJob
          ? <Button htmlType="submit" onClick={() => { after.current = { kind: 'job', jobId: nextJob.job_id } }}>提交并复核下一个岗位（{nextJob.job_name}）</Button>
          : hasNext && <Button htmlType="submit" onClick={() => { after.current = { kind: 'person' } }}>提交并查看下一位待审核人员</Button>}
      </Space>
      <Typography.Paragraph type="secondary" className="matching-note">
        提交后，本人资料同时记为“人工已核对”，不需要另外保存资料确认。
      </Typography.Paragraph>
    </Form>
  )
}

/**
 * 人工复核：勾选已核对、填写复核意见、选择结论，一次提交完成。
 * 提交规则与后端一致：任务分析中、评分已失效时不能提交；提交失败时显示后端给出的原因。
 */
export default function ReviewPanel({ detail, mode, decisions, assessment, canReview, running, reanalyze, hasNext, onJobChange, onSaved }: {
  detail: CandidateDetail
  mode: MatchingMode
  decisions: DecisionOption[]
  assessment?: Assessment
  canReview: boolean
  running: boolean
  reanalyze?: { busy: boolean; run: () => void }
  hasNext: boolean
  onJobChange: (jobId: string) => void
  onSaved: (after: AfterReview) => void
}) {
  const fit = mode === 'people_to_jobs'
  const saved = assessment?.decision ? (
    <div className="matching-current-review">
      <Space size={[8, 4]} wrap>
        <Typography.Text type="secondary">{fit ? `“${assessment.job_name}”当前结论` : '当前结论'}</Typography.Text>
        <Tag color={DECISION_COLORS[assessment.decision] || 'default'}>{decisionLabel(assessment.decision, decisions)}</Tag>
        {detail.reviewer && <Typography.Text type="secondary">复核人 {detail.reviewer}{detail.reviewed_at ? ` · ${formatTime(detail.reviewed_at)}` : ''}</Typography.Text>}
      </Space>
      {assessment.review_comment && <div className="evidence-text">复核意见：{assessment.review_comment}</div>}
    </div>
  ) : (
    <Typography.Paragraph type="secondary">{fit && assessment ? `“${assessment.job_name}”尚未复核。` : '尚未复核。'}</Typography.Paragraph>
  )
  if (!canReview) return saved

  const blocked = running
    ? '任务正在分析，分析完成后才能提交人工复核。'
    : !assessment
      ? '该人员还没有匹配分析结果，暂时不能复核。请先在任务页重试未完成项。'
      : assessment.stale
        ? `${assessment.stale_reason || '人员资料或岗位标准已变更'}，评分已失效。请先重新分析，再提交人工复核。`
        : ''

  return (
    <div className="matching-review">
      {saved}
      {blocked && (
        <Alert
          className="page-alert" type="warning" showIcon message="暂时不能提交复核" description={blocked}
          action={assessment?.stale && !running && reanalyze
            ? <Button size="small" type="primary" loading={reanalyze.busy} onClick={reanalyze.run}>重新分析</Button>
            : undefined}
        />
      )}
      {!blocked && assessment && assessment.total === null && (
        <Alert
          className="page-alert" type="info" showIcon message="评分尚未完成"
          description={`当前分析状态：${assessment.analysis_status}。可以先保存复核结论；评分完成前不能导出正式报告。`}
        />
      )}
      <ReviewFields
        key={`${detail.candidate_id}:${assessment?.job_id}:${detail.material.material_version}:${assessment?.decision}:${assessment?.review_comment}`}
        detail={detail} fit={fit} decisions={decisions} assessment={assessment} blocked={Boolean(blocked)}
        hasNext={hasNext} onJobChange={onJobChange} onSaved={onSaved}
      />
    </div>
  )
}
