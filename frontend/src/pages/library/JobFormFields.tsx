import { BulbOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { Alert, Button, Col, Collapse, Form, Input, InputNumber, Modal, Radio, Row, Space, Spin, Table, Tag, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { send } from '../../api'
import { AiNotice } from '../../components/PageHeader'
import { useFeedback } from './feedback'
import {
  MAX_DIMENSIONS, MAX_DIMENSION_NAME, blankDimension, equalWeights, formatWeight, isTotalValid, joinKeywords, parseKeywords,
  splitLines, validateDimensions, weightTotal,
} from './jobModel'
import type { DimensionFormValue, ScorecardContext } from './jobModel'
import type { ScorecardBasis, ScorecardSuggestion } from './types'

const linesRequired = (message: string) => async (_: unknown, value: string) => {
  if (!splitLines(value).length) throw new Error(message)
}

/** 岗位说明：基本信息、职责、任职要求、硬性条件和补充信息。放在任意 Form 内使用。 */
export function JobProfileFields({ expandExtra = false }: { expandExtra?: boolean }) {
  return (
    <>
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item name="name" label="岗位名称" rules={[{ required: true, whitespace: true, message: '请填写岗位名称' }, { max: 120, message: '岗位名称最多 120 个字' }]}>
            <Input placeholder="例如：制造生产储备岗" />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item name="jd_version" label="岗位说明书版本" rules={[{ max: 60, message: '版本最多 60 个字' }]}>
            <Input placeholder="例如：2026.09 第1版（选填）" />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item name="sequence" label="序列" rules={[{ required: true, whitespace: true, message: '请填写岗位序列' }, { max: 120, message: '序列最多 120 个字' }]}>
            <Input placeholder="例如：生产类、营销类、职能类" />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item name="level" label="层级" rules={[{ required: true, whitespace: true, message: '请填写岗位层级' }, { max: 60, message: '层级最多 60 个字' }]}>
            <Input placeholder="例如：专员、主管；未定可填“待确认”" />
          </Form.Item>
        </Col>
      </Row>
      <Form.Item name="responsibilities" label="岗位职责" required extra="每行填写一项，说明这个岗位要做什么。" rules={[{ validator: linesRequired('请至少填写一项岗位职责') }]}>
        <Input.TextArea autoSize={{ minRows: 4, maxRows: 18 }} placeholder={'例如：\n负责制造车间日常生产组织\n落实质量与安全管理要求'} />
      </Form.Item>
      <Form.Item name="requirements" label="任职要求" required extra="每行填写一项，说明需要什么能力或经验。" rules={[{ validator: linesRequired('请至少填写一项任职要求') }]}>
        <Input.TextArea autoSize={{ minRows: 4, maxRows: 18 }} placeholder={'例如：\n熟悉工业产品制造工艺流程\n具备班组管理经验'} />
      </Form.Item>
      <Form.Item name="hard_conditions" label="硬性条件" extra="每行填写一项，没有可留空。人岗匹配时逐条核验是否满足。">
        <Input.TextArea autoSize={{ minRows: 2, maxRows: 12 }} placeholder={'例如：\n本科及以上学历\n3年以上相关工作经验'} />
      </Form.Item>
      <Collapse
        ghost
        className="job-extra-collapse"
        defaultActiveKey={expandExtra ? ['extra'] : []}
        items={[{
          key: 'extra', label: '补充信息（选填）', forceRender: true,
          children: (
            <>
              <Form.Item name="scope" label="适用范围或资料来源" rules={[{ max: 500, message: '最多 500 个字' }]}>
                <Input.TextArea autoSize={{ minRows: 1, maxRows: 6 }} placeholder="例如：适用于各制造车间；依据 2026 年岗位说明书整理" />
              </Form.Item>
              <Form.List name="extra_sections">
                {(fields, { add, remove }) => (
                  <>
                    {fields.map((field, index) => (
                      <div className="extra-section-row" key={field.key}>
                        <Form.Item name={[field.name, 'name']} noStyle>
                          <Input aria-label={`第${index + 1}项补充信息名称`} placeholder="信息名称，例如：工作地点" maxLength={60} />
                        </Form.Item>
                        <Form.Item name={[field.name, 'content']} noStyle>
                          <Input.TextArea aria-label={`第${index + 1}项补充信息内容`} autoSize={{ minRows: 1, maxRows: 8 }} placeholder="具体内容" />
                        </Form.Item>
                        <Button type="text" danger icon={<DeleteOutlined />} aria-label={`删除第${index + 1}项补充信息`} onClick={() => remove(field.name)} />
                      </div>
                    ))}
                    <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ name: '', content: '' })}>添加补充信息</Button>
                  </>
                )}
              </Form.List>
            </>
          ),
        }]}
      />
    </>
  )
}

/** 能力标签与权重：人岗匹配按这些标签和权重评分。放在任意 Form 内使用。 */
export function JobScorecardFields({ getContext }: { getContext: () => ScorecardContext }) {
  const form = Form.useFormInstance()
  const { message } = useFeedback()
  const dimensions = Form.useWatch('dimensions', { form, preserve: true }) as DimensionFormValue[] | undefined
  const [suggesting, setSuggesting] = useState<{ context: ScorecardContext; current: DimensionFormValue[] } | null>(null)
  const total = weightTotal(dimensions)
  const valid = isTotalValid(total)

  useEffect(() => {
    // 保存未通过后，随着修改及时更新提示。
    if (form.getFieldError('dimensions').length) void form.validateFields(['dimensions']).catch(() => undefined)
  }, [dimensions, form])

  const distribute = () => {
    const rows = (form.getFieldValue('dimensions') || []) as DimensionFormValue[]
    if (!rows.length) return
    const named = rows.map((item, index) => item?.name?.trim() ? index : -1).filter(index => index >= 0)
    const targets = named.length ? named : rows.map((_, index) => index)
    const weights = equalWeights(targets.length)
    form.setFieldValue('dimensions', rows.map((item, index) => {
      const position = targets.indexOf(index)
      return position < 0 ? item : { ...blankDimension(), ...item, weight: weights[position] }
    }))
  }

  const openSuggestion = () => {
    const context = getContext()
    if (!context.responsibilities.length && !context.requirements.length) {
      message.warning('请先填写岗位职责和任职要求，再生成能力标签建议')
      return
    }
    setSuggesting({ context, current: ((form.getFieldValue('dimensions') || []) as DimensionFormValue[]).filter(item => item?.name?.trim()) })
  }

  return (
    <>
      <Typography.Paragraph type="secondary">
        每行一项能力标签，权重合计须为 100%。证据关键词用于从人员简历中识别相关能力，用顿号或逗号分隔；未填写时以标签名称作为关键词。
      </Typography.Paragraph>
      <Form.List name="dimensions" rules={[{ validator: async (_, value) => { const error = validateDimensions(value); if (error) throw new Error(error) } }]}>
        {(fields, { add, remove }, { errors }) => (
          <>
            <div className="dimension-table">
              <div className="dimension-row dimension-head" aria-hidden="true">
                <span>能力标签</span><span>权重（%）</span><span>证据关键词</span><span>排除关键词（选填）</span><span />
              </div>
              {fields.map((field, index) => (
                <div className="dimension-row" key={field.key}>
                  <div className="dimension-cell dimension-cell-name">
                    <span className="dimension-cell-label" aria-hidden="true">能力标签</span>
                    <Form.Item name={[field.name, 'name']} noStyle>
                      <Input aria-label={`第${index + 1}项能力标签`} maxLength={MAX_DIMENSION_NAME} placeholder="例如：质量管理" />
                    </Form.Item>
                  </div>
                  <div className="dimension-cell dimension-cell-weight">
                    <span className="dimension-cell-label" aria-hidden="true">权重（%）</span>
                    <Form.Item name={[field.name, 'weight']} noStyle>
                      <InputNumber aria-label={`第${index + 1}项权重`} min={0} max={100} step={5} className="dimension-weight" placeholder="0–100" />
                    </Form.Item>
                  </div>
                  <div className="dimension-cell dimension-cell-keywords">
                    <span className="dimension-cell-label" aria-hidden="true">证据关键词</span>
                    <Form.Item name={[field.name, 'keywords']} noStyle>
                      <Input.TextArea aria-label={`第${index + 1}项证据关键词`} autoSize={{ minRows: 1, maxRows: 6 }} placeholder="例如：质量体系、异常处理" />
                    </Form.Item>
                  </div>
                  <div className="dimension-cell dimension-cell-negative">
                    <span className="dimension-cell-label" aria-hidden="true">排除关键词（选填）</span>
                    <Form.Item name={[field.name, 'negative_keywords']} noStyle>
                      <Input.TextArea aria-label={`第${index + 1}项排除关键词`} autoSize={{ minRows: 1, maxRows: 6 }} placeholder="需要排除的词" />
                    </Form.Item>
                  </div>
                  <Button className="dimension-remove" type="text" danger icon={<DeleteOutlined />} aria-label={`删除第${index + 1}项能力标签`} onClick={() => remove(field.name)} />
                </div>
              ))}
            </div>
            <Form.ErrorList errors={errors} className="dimension-errors" />
            <div className="dimension-actions">
              <Space wrap>
                <Button type="dashed" icon={<PlusOutlined />} disabled={fields.length >= MAX_DIMENSIONS} onClick={() => add(blankDimension())}>添加能力标签</Button>
                <Button onClick={distribute}>平均分配</Button>
                <Button icon={<BulbOutlined />} onClick={openSuggestion}>AI生成能力标签建议</Button>
              </Space>
              <Tag color={valid ? 'green' : 'gold'} className="dimension-total" role="status">
                权重合计 {formatWeight(total)}%{valid ? '' : total < 100 ? `，还差 ${formatWeight(100 - total)}%` : `，超出 ${formatWeight(total - 100)}%`}
              </Tag>
            </div>
          </>
        )}
      </Form.List>
      <ScorecardSuggestionModal
        state={suggesting}
        onClose={() => setSuggesting(null)}
        onApply={rows => {
          form.setFieldValue('dimensions', rows)
          setSuggesting(null)
          message.success('建议已填入表格，请核对后保存')
        }}
      />
    </>
  )
}

export function ScorecardBasisList({ basis }: { basis: ScorecardBasis[] }) {
  return (
    <div className="basis-list">
      {basis.map(item => (
        <div className="basis-item" key={item.dimension}>
          <Typography.Text strong>{item.dimension}</Typography.Text>
          <div className="evidence-text">{item.reason}</div>
          {item.evidence.map((text, index) => <div className="evidence-quote" key={index}>岗位原文：{text}</div>)}
        </div>
      ))}
    </div>
  )
}

type SuggestionMode = 'keep' | 'fresh'

function ScorecardSuggestionModal({ state, onClose, onApply }: {
  state: { context: ScorecardContext; current: DimensionFormValue[] } | null
  onClose: () => void
  onApply: (rows: DimensionFormValue[]) => void
}) {
  const [mode, setMode] = useState<SuggestionMode>('fresh')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ScorecardSuggestion | null>(null)
  const request = useRef(0)

  const generate = async (target: SuggestionMode) => {
    if (!state) return
    const id = ++request.current
    const keep = target === 'keep'
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const suggestion = await send<ScorecardSuggestion>('/library/jobs/scorecard-suggestion', 'POST', {
        name: state.context.name,
        responsibilities: state.context.responsibilities,
        requirements: state.context.requirements,
        // 保留现有标签时，只带上已填写的关键词和权重，缺少的部分由建议补全。
        dimensions: keep ? state.current.map(item => {
          const keywords = parseKeywords(item.keywords)
          return { name: item.name.trim(), ...(keywords.length ? { keywords } : {}), negative_keywords: parseKeywords(item.negative_keywords) }
        }) : [],
        weights: keep ? Object.fromEntries(state.current.filter(item => Number(item.weight) > 0).map(item => [item.name.trim(), Number(item.weight)])) : {},
      })
      if (request.current === id) setResult(suggestion)
    } catch (e) {
      if (request.current === id) setError((e as Error).message)
    } finally {
      if (request.current === id) setLoading(false)
    }
  }

  useEffect(() => {
    request.current += 1
    setLoading(false)
    setError('')
    setResult(null)
    if (!state) return
    const initial: SuggestionMode = state.current.length ? 'keep' : 'fresh'
    setMode(initial)
    // 表格里还没有能力标签时直接生成；已有标签时先让使用者选择方式。
    if (!state.current.length) void generate('fresh')
    // 只在打开窗口或换了岗位内容时执行，generate 每次渲染都会重新创建，不作为依赖。
  }, [state])

  const apply = () => {
    if (!result) return
    onApply(result.dimensions.map(item => {
      const weight = result.weights[item.name]
      return {
        name: item.name,
        weight: typeof weight === 'number' && Number.isFinite(weight) ? weight : null,
        keywords: joinKeywords(item.keywords),
        negative_keywords: joinKeywords(item.negative_keywords),
      }
    }))
  }

  const basisOf = (name: string) => result?.basis.find(item => item.dimension === name)
  return (
    <Modal
      title="AI生成能力标签建议"
      open={Boolean(state)}
      width={920}
      onCancel={onClose}
      destroyOnHidden
      footer={(
        <Space wrap>
          <Button onClick={onClose}>取消</Button>
          {result && <Button disabled={loading} onClick={() => void generate(mode)}>重新生成</Button>}
          {result && <Button type="primary" onClick={apply}>采用建议</Button>}
        </Space>
      )}
    >
      <Space direction="vertical" size={12} className="full-width">
        <AiNotice />
        {Boolean(state?.current.length) && (
          <div>
            <Radio.Group
              value={mode}
              disabled={loading}
              onChange={event => setMode(event.target.value as SuggestionMode)}
              options={[
                { value: 'keep', label: '保留现有能力标签，补全缺少的权重和证据关键词' },
                { value: 'fresh', label: '根据岗位职责和任职要求重新生成' },
              ]}
            />
            <div className="section-row">
              <Button type="primary" ghost loading={loading} onClick={() => void generate(mode)}>{result || error ? '按所选方式重新生成' : '开始生成'}</Button>
            </div>
          </div>
        )}
        {loading && (
          <div className="library-progress" role="status" aria-live="polite">
            <Spin />
            <Typography.Text>正在根据岗位职责和任职要求生成建议，通常需要几十秒，请稍候…</Typography.Text>
          </div>
        )}
        {error && <Alert type="error" showIcon message="建议未生成" description={<div className="evidence-text">{error}{'\n'}可稍后重试，或直接手工填写能力标签。</div>} />}
        {result && (
          <>
            <Typography.Text type="secondary">采用后会替换表格中现有的能力标签，保存岗位后才会生效。</Typography.Text>
            <Table
              size="small"
              rowKey="name"
              pagination={false}
              dataSource={result.dimensions}
              scroll={{ x: 760 }}
              columns={[
                { title: '能力标签', dataIndex: 'name', width: 140 },
                { title: '建议权重', key: 'weight', width: 96, render: (_, row) => `${formatWeight(result.weights[row.name] ?? 0)}%` },
                { title: '证据关键词', dataIndex: 'keywords', width: 200, render: (value: string[]) => <Space size={[4, 4]} wrap>{(value || []).map(word => <Tag key={word}>{word}</Tag>)}</Space> },
                {
                  title: '建议依据', key: 'basis', render: (_, row) => {
                    const basis = basisOf(row.name)
                    if (!basis) return <Typography.Text type="secondary">—</Typography.Text>
                    return <><div className="evidence-text">{basis.reason}</div>{basis.evidence.map((text, index) => <div className="evidence-quote" key={index}>岗位原文：{text}</div>)}</>
                  },
                },
              ]}
            />
          </>
        )}
      </Space>
    </Modal>
  )
}
