import { FileDoneOutlined, ReloadOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Popconfirm, Space, Tag, Typography } from 'antd'
import { AiNotice } from '../../../components/PageHeader'
import { StatusTag } from '../../../components/StatusTag'
import { findingColor } from './labels'
import type { ComprehensiveReport } from './types'

interface Props {
  report: ComprehensiveReport
  /** 综合报告的复核状态。 */
  status?: string
  /** 有查看报告的权限时提供，进入综合报告页。 */
  onOpen?: () => void
  /** 报告还是AI生成的原样（没有人工修改或确认）时提供，可以重新生成。 */
  onRegenerate?: () => void
  /** 正在重新生成。 */
  regenerating?: boolean
}

/** 结束旁听后生成的综合报告摘要；复核、对比和导出在“面试报告”中进行。 */
export function ReportSummary({ report, status, onOpen, onRegenerate, regenerating = false }: Props) {
  const standalone = report.mode === 'standalone' || !report.stage_one
  const findings = report.findings || []
  // 没有得到模型的分析，报告里只保全了原文证据。
  const preserved = report.generation_mode === '证据保全降级'
  return (
    <Card
      className="section-card listening-report"
      title="综合报告已生成"
      extra={<Space wrap><AiNotice />{onOpen && <Button type="primary" icon={<FileDoneOutlined />} onClick={onOpen}>进入综合报告</Button>}</Space>}
    >
      <Space wrap size={[8, 8]}>
        <StatusTag kind="report" value={status || 'pending_review'} />
        <Tag color={standalone ? 'blue' : 'green'}>{standalone ? '仅依据简历和岗位要求' : '关联第一阶段AI面试报告'}</Tag>
        {report.generation_mode && report.generation_mode !== '文本模型分析' && <Tag color="gold">{preserved ? '只保全了原文证据' : report.generation_mode}</Tag>}
      </Space>
      {preserved && (
        <Alert
          type="warning"
          showIcon
          message="这份报告没有得到模型的分析结果，只保全了原文证据"
          description={<>
            {report.generation_note && <div>原因：{report.generation_note}</div>}
            <div>
              {status === 'generating'
                ? '正在重新生成，完成后这里显示新的内容。'
                : onRegenerate ? '可以重新生成；也可以在综合报告中由人工补充结论。' : '请在综合报告中由人工补充结论。'}
            </div>
          </>}
          action={onRegenerate && (
            <Popconfirm
              title="重新生成综合报告？"
              description="重新生成的内容记为新版本，现在这一版保留在版本记录里。"
              okText="重新生成"
              cancelText="取消"
              disabled={regenerating}
              onConfirm={onRegenerate}
            >
              <Button size="small" icon={<ReloadOutlined />} loading={regenerating}>重新生成</Button>
            </Popconfirm>
          )}
        />
      )}
      {report.stage_one_summary && (
        <div className="listening-block">
          <Typography.Text strong>{standalone ? '分析依据' : '第一阶段AI面试纪要'}</Typography.Text>
          <div className="evidence-text">{report.stage_one_summary}</div>
        </div>
      )}
      {report.stage_two_summary && (
        <div className="listening-block">
          <Typography.Text strong>人工面试记录</Typography.Text>
          <div className="evidence-text">{report.stage_two_summary}</div>
        </div>
      )}
      {findings.length > 0 && (
        <div className="listening-block">
          <Typography.Text strong>综合分析</Typography.Text>
          <ul className="listening-list">
            {findings.map((finding, index) => (
              <li key={`${finding.dimension}-${index}`}>
                <Space size={6} wrap>
                  <Typography.Text strong>{finding.dimension}</Typography.Text>
                  <Tag color={findingColor(finding.status)}>{finding.status}</Tag>
                  {finding.speaker_inferred && <Tag color="gold">回答归属待核对</Tag>}
                </Space>
                <div className="evidence-text">{finding.analysis}</div>
                {finding.answer_excerpt && <blockquote className="evidence-quote"><Typography.Text type="secondary" className="evidence-source">候选人现场回答</Typography.Text>{finding.answer_excerpt}</blockquote>}
                {finding.stage_one_excerpt && <blockquote className="evidence-quote"><Typography.Text type="secondary" className="evidence-source">第一阶段报告原文</Typography.Text>{finding.stage_one_excerpt}</blockquote>}
                {finding.resume_excerpt && <blockquote className="evidence-quote"><Typography.Text type="secondary" className="evidence-source">简历原文</Typography.Text>{finding.resume_excerpt}</blockquote>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {Boolean(report.adopted_questions?.length) && (
        <div className="listening-block">
          <Typography.Text strong>本场采用的提问</Typography.Text>
          <ul className="listening-list">
            {report.adopted_questions?.map((item, index) => <li key={index} className="evidence-text">{item}</li>)}
          </ul>
        </div>
      )}
      {Boolean(report.risks?.length) && (
        <div className="listening-block">
          <Typography.Text strong>复核时请注意</Typography.Text>
          <ul className="listening-list">
            {report.risks?.map((item, index) => <li key={index} className="evidence-text">{item}</li>)}
          </ul>
        </div>
      )}
      <Typography.Paragraph type="secondary" className="listening-report-next">
        综合报告须经人工复核后才能导出；复核、候选人对比和导出在“面试报告”的综合报告中进行。
      </Typography.Paragraph>
    </Card>
  )
}
