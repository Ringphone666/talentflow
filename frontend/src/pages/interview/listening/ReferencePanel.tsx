import { Alert, Collapse, Descriptions, Empty, Space, Tag, Typography } from 'antd'
import { HardIndicators } from '../../../components/HardIndicators'
import { StatusTag } from '../../../components/StatusTag'
import { formatScore, formatTime } from '../../../lib/format'
import { ResumeStatusTag } from './labels'
import type { ListeningState, StageOne, StageOneEvaluation } from './types'

function TextList({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null
  return (
    <div className="listening-block">
      <Typography.Text strong>{title}</Typography.Text>
      <ul className="listening-list">
        {items.map((item, index) => <li key={index} className="evidence-text">{item}</li>)}
      </ul>
    </div>
  )
}

function evaluationGrade(item: StageOneEvaluation): string {
  if (item.insufficient || item.score === null || item.score === undefined) return '证据不足'
  return `${formatScore(item.score)} / 5${item.level ? ` · ${item.level}` : ''}`
}

function StageOneSummary({ stage }: { stage: StageOne }) {
  const content = stage.content || {}
  // 证据不足的维度排在前面，便于面试官优先核实。
  const evaluations = [...(content.evaluations || [])].sort((a, b) => Number(Boolean(b.insufficient)) - Number(Boolean(a.insufficient)))
  const score = content.match_analysis?.score
  return (
    <div className="listening-reference">
      <Space wrap size={[8, 8]}>
        <Tag>报告 #{stage.report_id} · v{stage.version}</Tag>
        <StatusTag kind="report" value={stage.status} />
        {typeof score === 'number' && <Tag color="green">辅助匹配度 {formatScore(score)}%</Tag>}
      </Space>
      {stage.status !== 'confirmed' && <Alert type="warning" showIcon message="该报告尚未经人工确认，内容仅供提问参考。" />}
      <div className="listening-block">
        <Typography.Text strong>面试纪要</Typography.Text>
        <div className="evidence-text">{content.summary || '报告中没有面试纪要'}</div>
      </div>
      {evaluations.length > 0 && (
        <div className="listening-block">
          <Typography.Text strong>各维度评价</Typography.Text>
          <ul className="listening-list">
            {evaluations.map(item => (
              <li key={item.dimension}>
                <Space size={6} wrap><Typography.Text strong>{item.dimension}</Typography.Text><Tag color={item.insufficient ? 'gold' : 'default'}>{evaluationGrade(item)}</Tag></Space>
                <div className="evidence-text">{item.reason}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <TextList title="待核实的内容" items={content.match_analysis?.to_verify} />
      <TextList title="建议人工面试追问" items={content.offline_questions} />
      <TextList title="风险提示" items={content.risks} />
    </div>
  )
}

function ResumeBlock({ state }: { state: ListeningState }) {
  const resume = state.resume_context
  const ready = resume?.status === 'ready'
  return (
    <div className="listening-reference">
      <Space wrap size={[8, 8]}>
        <ResumeStatusTag status={resume?.status} />
        {resume?.source && <Typography.Text type="secondary">来源：{resume.source}</Typography.Text>}
        {resume?.uploaded_at && <Typography.Text type="secondary">上传时间：{formatTime(resume.uploaded_at)}</Typography.Text>}
      </Space>
      {!ready && <Alert type="info" showIcon message="没有可用的简历文字，提问建议只依据岗位要求生成。" description="在候选人管理中关联人员库或上传简历并完成识别后，刷新本页即可使用。" />}
      {resume?.truncated && <Alert type="warning" showIcon message="简历较长，AI只分析前24000字，请同时核对完整简历。" />}
      <div className="listening-block">
        <Typography.Text strong>硬指标（简历档案中可核对的事实）</Typography.Text>
        <HardIndicators data={state.hard_indicators} />
      </div>
      {ready && resume?.text && (
        <Collapse
          className="listening-resume-text"
          items={[{
            key: 'resume',
            label: '查看简历全文（已隐藏姓名、电话等个人标识）',
            children: <div className="evidence-text">{resume.text}</div>,
          }]}
        />
      )}
      {resume?.note && <Typography.Text type="secondary">{resume.note}</Typography.Text>}
    </div>
  )
}

/** 旁听开始前的准备资料：依据、岗位要求、简历与硬指标、第一阶段AI面试报告（如有）。 */
export function ReferencePanel({ state }: { state: ListeningState }) {
  const linked = state.mode === 'linked' && state.stage_one
  const items = [
    {
      key: 'basis',
      label: '旁听依据与岗位要求',
      children: (
        <div className="listening-reference">
          <Space wrap size={[8, 8]}>
            <Typography.Text strong>依据</Typography.Text>
            <Tag color={linked ? 'green' : 'blue'}>{linked ? '关联第一阶段AI面试报告' : '仅依据简历和岗位要求'}</Tag>
          </Space>
          <Typography.Text type="secondary">
            {linked
              ? '候选人已完成第一阶段AI面试，提问建议和综合报告会关联该报告。'
              : '候选人没有第一阶段AI面试报告，提问建议和综合报告依据简历和岗位要求，流程与关联报告时相同。'}
          </Typography.Text>
          {state.job
            ? (
              <Descriptions size="small" column={1} bordered items={[
                { key: 'job', label: '应聘岗位', children: state.job.name },
                { key: 'duties', label: '岗位职责', children: <div className="evidence-text">{state.job.duties || '岗位资料中未填写'}</div> },
                { key: 'requirements', label: '任职要求', children: <div className="evidence-text">{state.job.requirements || '岗位资料中未填写'}</div> },
              ]} />
            )
            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未找到该候选人应聘的岗位资料" />}
        </div>
      ),
    },
    { key: 'resume', label: '简历与硬指标', children: <ResumeBlock state={state} /> },
    ...(linked && state.stage_one ? [{ key: 'stage-one', label: '第一阶段AI面试报告（软性评价）', children: <StageOneSummary stage={state.stage_one} /> }] : []),
  ]
  return <Collapse className="listening-references" defaultActiveKey={items.map(item => item.key)} items={items} />
}
