import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { AutoComplete, Button, Collapse, Empty, Input, Typography } from 'antd'
import './CompetencyEditor.css'

export interface Competency {
  dimension: string
  behavior: string
  levels: Record<string, string>
  source_competency_categories?: string[]
  source_evaluation_basis?: string[]
  [key: string]: unknown
}

interface Props {
  value?: Competency[]
  onChange?: (value: Competency[]) => void
  dimensions: Array<{ name: string; definition: string }>
  id?: string
}

export function validateCompetencies(value: Competency[] | undefined): string | undefined {
  if (!value?.length) return '请至少添加一项能力评价标准'
  const names = new Set<string>()
  for (const [index, item] of value.entries()) {
    const prefix = `第${index + 1}项能力`
    const name = item.dimension?.trim()
    if (!name) return `${prefix}：请填写能力维度`
    if (names.has(name)) return `${prefix}：能力维度重复，请合并或修改名称`
    names.add(name)
    if (!item.behavior?.trim()) return `${prefix}：请填写考察要求`
    for (const score of ['1', '3', '5']) {
      if (!item.levels?.[score]?.trim()) return `${prefix}：请填写${score}分表现标准`
    }
  }
}

export function CompetencyEditor({ value = [], onChange, dimensions, id }: Props) {
  const update = (index: number, patch: Partial<Competency>) => {
    onChange?.(value.map((item, row) => row === index ? { ...item, ...patch } : item))
  }
  const levelInput = (item: Competency, index: number, score: string, optional = false) => (
    <label className="competency-score" key={score}>
      <span>{score}分表现{optional ? '（选填）' : ''}</span>
      <Input.TextArea
        aria-label={`第${index + 1}项${score}分表现`}
        autoSize={{ minRows: 2, maxRows: 6 }}
        value={item.levels?.[score] || ''}
        placeholder={optional ? '可补充相邻等级之间的表现标准' : '描述可从回答中观察到的具体表现'}
        onChange={event => update(index, { levels: { ...item.levels, [score]: event.target.value } })}
      />
    </label>
  )

  return <div className="competency-editor" id={id}>
    <Typography.Paragraph type="secondary">
      按行填写需要考察的能力，以及回答达到不同分数时应具备的表现。建议沿用六个评价维度，按岗位调整标准。
      通用0分标准：已作答但答非所问，仅问候、测试口令或无关内容。未采集到回答时不评分。
    </Typography.Paragraph>
    {!value.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未添加能力评价标准" /> : (
      <div className="competency-table-wrap">
        <table className="competency-table" aria-label="岗位能力评价标准">
          <thead><tr><th scope="col">能力维度与考察要求</th><th scope="col">评分标准</th><th scope="col">操作</th></tr></thead>
          <tbody>{value.map((item, index) => <tr key={index}>
            <td className="competency-description">
              <label><span>能力维度 <Typography.Text type="secondary">{index + 1}</Typography.Text></span>
                <AutoComplete
                  aria-label={`第${index + 1}项能力维度`}
                  value={item.dimension}
                  options={dimensions.map(dimension => ({ value: dimension.name }))}
                  onChange={dimension => update(index, { dimension })}
                  placeholder="选择或填写能力名称"
                  style={{ width: '100%' }}
                />
              </label>
              <label><span>考察要求</span><Input.TextArea
                aria-label={`第${index + 1}项考察要求`}
                value={item.behavior}
                autoSize={{ minRows: 3, maxRows: 6 }}
                placeholder="例如：能够发现质量异常，说明处理步骤和依据"
                onChange={event => update(index, { behavior: event.target.value })}
              /></label>
            </td>
            <td>
              <div className="competency-scores">{['1', '3', '5'].map(score => levelInput(item, index, score))}</div>
              <Collapse
                ghost size="small"
                items={[{
                  key: 'additional', label: '补充2分、4分标准与评价依据（选填）',
                  children: <>
                    <div className="competency-extra-scores">{['2', '4'].map(score => levelInput(item, index, score, true))}</div>
                    <label className="competency-evidence"><span>评价依据（每行一条）</span><Input.TextArea
                      aria-label={`第${index + 1}项评价依据`}
                      value={(item.source_evaluation_basis || []).join('\n')}
                      autoSize={{ minRows: 2, maxRows: 6 }}
                      placeholder="例如：回答中的具体行动、结果及复盘"
                      onChange={event => update(index, { source_evaluation_basis: event.target.value.split('\n') })}
                    /></label>
                    {!!item.source_competency_categories?.length && <Typography.Paragraph type="secondary">资料分类：{item.source_competency_categories.join('、')}</Typography.Paragraph>}
                  </>,
                }]}
              />
            </td>
            <td className="competency-action"><Button type="text" danger icon={<DeleteOutlined />} aria-label={`删除第${index + 1}项能力`} onClick={() => onChange?.(value.filter((_, row) => row !== index))}>删除</Button></td>
          </tr>)}</tbody>
        </table>
      </div>
    )}
    <Button className="competency-add" type="dashed" block icon={<PlusOutlined />} onClick={() => onChange?.([...value, { dimension: '', behavior: '', levels: { '1': '', '3': '', '5': '' } }])}>添加能力维度</Button>
  </div>
}
