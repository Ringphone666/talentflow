import { RightOutlined } from '@ant-design/icons'
import { Alert, Badge, Button, Card, Col, Collapse, Descriptions, Empty, List, Row, Skeleton, Space, Statistic, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { AiNotice, PageHeader } from '../components/PageHeader'
import { can, useAdminSession } from '../lib/access'

interface Overview {
  role_label: string
  library?: { jobs: number; person_batches: number; persons: number; persons_failed: number }
  matching?: { tasks: number; running: number; with_failures: number; pending_review: number; stale: number }
  interview?: {
    batches: number; candidates: number; interviewing: number; completed: number; questions_pending_review: number
    reports_generating: number; reports_failed: number; reports_pending: number; reports_confirmed: number
  }
  todo: Array<{ title: string; count: number; path: string }>
}

interface Health {
  status: string
  text_models?: {
    mode?: string; generation?: string; evaluation?: string; asr?: string
    ocr?: { mode?: string; health?: { status?: string } }
    retrieval?: { mode?: string; embedding?: string; reranker?: string }
    forced_aligner?: { mode?: string }
    speaker_services?: { mode?: string }
  }
  matching_models?: { mode?: string; scoring_model?: string; extraction_model?: string; note?: string }
}

interface ModuleCard {
  key: string
  title: string
  summary: string
  stats: Array<[label: string, value: number]>
  links: Array<{ label: string; path: string; permission: string }>
}

function serviceTag(health: Health | null, mode: string | undefined, enabledValue = 'live') {
  if (!health) return { color: 'default', text: '检查中' }
  if (!mode) return { color: 'warning', text: '状态未获取' }
  if (mode === enabledValue) return { color: 'default', text: '已启用，待使用验证' }
  if (mode === 'mock') return { color: 'warning', text: '测试模式' }
  if (mode === 'unavailable') return { color: 'error', text: '未配置' }
  return { color: 'warning', text: '未启用' }
}

export default function DashboardPage() {
  const session = useAdminSession()
  const navigate = useNavigate()
  const [data, setData] = useState<Overview | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    api<Overview>('/overview').then(setData).catch(e => setError((e as Error).message))
    api<Health>('/health').then(setHealth).catch(() => setHealth({ status: 'unavailable' }))
  }, [])

  const modules: ModuleCard[] = []
  if (data?.library) modules.push({
    key: 'library', title: '基础数据', summary: '岗位库和人员库由人岗匹配、AI面试共用。',
    stats: [['岗位', data.library.jobs], ['人员批次', data.library.person_batches], ['人员', data.library.persons]],
    links: [{ label: '岗位库', path: '/library/jobs', permission: 'job:read' }, { label: '人员库', path: '/library/persons', permission: 'person:read' }],
  })
  if (data?.matching) modules.push({
    key: 'matching', title: '人岗匹配', summary: '从人员库选人，按岗位标准分析匹配度，人工复核后出具报告。',
    stats: [['匹配任务', data.matching.tasks], ['分析中', data.matching.running], ['待人工复核', data.matching.pending_review]],
    links: [{ label: '岗位选才', path: '/matching/job-to-people', permission: 'matching:view' }, { label: '人才适岗', path: '/matching/people-to-jobs', permission: 'matching:view' }],
  })
  if (data?.interview) modules.push({
    key: 'interview', title: 'AI面试', summary: 'AI面试、人工面试旁听和面试报告复核。',
    stats: [['招聘批次', data.interview.batches], ['候选人', data.interview.candidates], ['报告待复核', data.interview.reports_pending], ['报告已确认', data.interview.reports_confirmed]],
    links: [
      { label: '批次与题目', path: '/ai-interview/batches', permission: 'question:read' },
      { label: '候选人管理', path: '/ai-interview/candidates', permission: 'candidate:read' },
      { label: 'AI旁听', path: '/ai-interview/listening', permission: 'listening:use' },
      { label: '面试报告', path: '/ai-interview/reports', permission: 'report:read' },
      { label: '候选人对比', path: '/ai-interview/comparison', permission: 'compare:read' },
    ],
  })

  const models = health?.text_models
  const online = !health ? { color: 'default', text: '检查中' } : health.status === 'ok' ? { color: 'success', text: '业务服务在线' } : { color: 'error', text: '业务服务异常' }
  const speaker = models?.speaker_services?.mode === 'live' ? { color: 'success', text: '已运行' }
    : models?.speaker_services?.mode === 'configured_not_running' ? { color: 'error', text: '服务未运行' } : serviceTag(health, models?.speaker_services?.mode)
  const ocr = models?.ocr?.health?.status === 'ready' ? { color: 'success', text: '服务可连接' }
    : models?.ocr?.health?.status === 'unavailable' ? { color: 'error', text: '服务不可用' } : serviceTag(health, models?.ocr?.mode)
  const services: Array<[string, { color: string; text: string }]> = [
    ['人岗匹配评分', serviceTag(health, health?.matching_models?.mode)],
    ['面试出题与报告分析', serviceTag(health, models?.mode)],
    ['语音转写', serviceTag(health, models?.asr, 'doubao')],
    ['发言人区分', speaker],
    ['资料文字识别', ocr],
    ['证据检索', serviceTag(health, models?.retrieval?.mode)],
    ['录音与文字时间对应', serviceTag(health, models?.forced_aligner?.mode)],
  ]

  return (
    <>
      <PageHeader title="工作台" description="查看需要处理的事项，进入人岗匹配和AI面试。" actions={<AiNotice />} />
      {error && <Alert className="page-alert" type="error" showIcon message={error} />}
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={9}>
          <Card title="待办事项" className="full-height-card">
            {!data ? <Skeleton active /> : data.todo.length === 0
              ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="目前没有需要处理的事项" />
              : <List dataSource={data.todo} renderItem={item => (
                <List.Item className="todo-item" onClick={() => navigate(item.path)} actions={[<RightOutlined key="go" />]}>
                  <Space><Badge count={item.count} overflowCount={999} color="#197465" /><Typography.Text>{item.title}</Typography.Text></Space>
                </List.Item>
              )} />}
          </Card>
        </Col>
        <Col xs={24} xl={15}>
          <Card size="small" className="full-height-card" title="外部服务状态" extra={<Tag color={online.color}>{online.text}</Tag>}>
            <Space wrap size={[8, 8]}>
              {services.map(([name, tag]) => <Tag key={name} color={tag.color}>{name}：{tag.text}</Tag>)}
            </Space>
            {health?.matching_models?.note && <Alert className="section-row" type="warning" showIcon message={health.matching_models.note} />}
            <Typography.Paragraph type="secondary" style={{ margin: '12px 0 0' }}>这里显示的是配置状态，不代表服务当前一定可用；正式使用前请做一次试用验证。</Typography.Paragraph>
            {can(session, 'audit:read') && <Collapse ghost style={{ marginTop: 8 }} items={[{ key: 'technical', label: '模型标识', children: <Descriptions size="small" column={{ xs: 1, md: 2 }} items={[
              { key: 'scoring', label: '人岗匹配评分', children: health?.matching_models?.scoring_model || '未获取' },
              { key: 'extraction', label: '简历与岗位识别', children: health?.matching_models?.extraction_model || '未获取' },
              { key: 'generation', label: '面试出题', children: models?.generation || '未获取' },
              { key: 'evaluation', label: '面试评价', children: models?.evaluation || '未获取' },
              { key: 'embedding', label: '检索', children: models?.retrieval?.embedding || '未获取' },
              { key: 'reranker', label: '排序', children: models?.retrieval?.reranker || '未获取' },
            ]} /> }]} />}
          </Card>
        </Col>
      </Row>
      <Row gutter={[16, 16]} className="section-row">
        {!data && !error && [0, 1, 2].map(index => <Col xs={24} lg={8} key={index}><Card><Skeleton active /></Card></Col>)}
        {modules.map(module => (
          <Col xs={24} lg={24 / Math.min(modules.length, 3)} key={module.key}>
            <Card className="module-card" title={module.title}>
              <Typography.Paragraph type="secondary">{module.summary}</Typography.Paragraph>
              <div className="module-stats">
                {module.stats.map(([label, value]) => <Statistic key={label} title={label} value={value} />)}
              </div>
              <Space wrap className="section-row">
                {module.links.filter(link => can(session, link.permission)).map(link => <Button key={link.path} onClick={() => navigate(link.path)}>{link.label}</Button>)}
              </Space>
            </Card>
          </Col>
        ))}
      </Row>
    </>
  )
}
