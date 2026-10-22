import { Alert, Card, Collapse, Descriptions, List, Tag, Typography } from 'antd'

export interface ResumeContext {
  status?: string; text?: string; note?: string; truncated?: boolean; version?: string
}
export interface ResumeCheck {
  resume_excerpt: string; answer_code?: string; answer_excerpt?: string; finding: string; status: string
}
export function ResumeEvidence({ context, checks = [] }: { context?: ResumeContext; checks?: ResumeCheck[] }) {
  const ready = context?.status === 'ready'
  const states: Record<string, string> = { not_requested: '未上传或尚未识别', processing: '文字识别中', failed: '文字识别失败', empty: '没有可用简历文字' }
  return <Card size="small" title="简历与回答核对" extra={<Tag color={ready ? 'green' : 'default'}>{ready ? '已接入简历' : context ? states[context.status || ''] || '简历不可用' : '历史报告未接入简历'}</Tag>}>
    <Typography.Paragraph type="secondary">简历用于核实项目、技能和本人职责；未提及不代表不属实，核对结果须由面试官确认。</Typography.Paragraph>
    {context?.truncated && <Alert type="warning" message="简历较长，本次只分析前24000字，请同时核对完整简历" />}
    <List dataSource={checks} locale={{ emptyText: ready ? '暂无简历对照项，可结合下方资料人工核实' : '本次依据面试回答分析；请在候选人管理中上传并完成简历文字识别' }} renderItem={item => <List.Item><div style={{ width: '100%', overflowWrap: 'anywhere' }}><Tag color={item.status === '回答支持' ? 'green' : 'orange'}>{item.status}</Tag><Typography.Paragraph>{item.finding}</Typography.Paragraph><Descriptions size="small" column={1} items={[{ key: 'resume', label: '简历原文', children: item.resume_excerpt }, { key: 'answer', label: `回答原文${item.answer_code ? `（${item.answer_code}）` : ''}`, children: item.answer_excerpt || '尚无对应回答，待面试官核实' }]} /></div></List.Item>} />
    {context?.text && <Collapse ghost items={[{ key: 'text', label: '查看本次分析使用的简历文字', children: <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 300, overflowY: 'auto' }}>{context.text}</Typography.Paragraph> }]} />}
  </Card>
}
