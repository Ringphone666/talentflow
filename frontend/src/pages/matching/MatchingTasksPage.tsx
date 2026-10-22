import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Empty, Popconfirm, Progress, Space, Table, Tooltip, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, send } from '../../api'
import { PageHeader } from '../../components/PageHeader'
import { StatusTag } from '../../components/StatusTag'
import { can, useAdminSession } from '../../lib/access'
import { formatTime } from '../../lib/format'
import CreateTaskDrawer from './CreateTaskDrawer'
import { JobTags, MODES, MatchingTheme, POLL_INTERVAL_MS, ReviewTags, matchingAccess, taskPath, usePolling } from './shared'
import type { MatchingMode, MatchingOptions, TaskSummary } from './types'
import './matching.css'

interface Props {
  mode: MatchingMode
  /** 自动刷新间隔（毫秒），默认 3 秒。 */
  pollIntervalMs?: number
}

/** 岗位选才 / 人才适岗的任务列表与新建任务。两种任务共用本页，切换菜单时重新载入。 */
export default function MatchingTasksPage({ mode, pollIntervalMs }: Props) {
  return <MatchingTheme><TaskList key={mode} mode={mode} pollIntervalMs={pollIntervalMs} /></MatchingTheme>
}

function TaskList({ mode, pollIntervalMs = POLL_INTERVAL_MS }: Props) {
  const session = useAdminSession()
  const navigate = useNavigate()
  const meta = MODES[mode]
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null)
  const [options, setOptions] = useState<MatchingOptions | null>(null)
  const [error, setError] = useState('')
  const [refreshError, setRefreshError] = useState('')
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deletingId, setDeletingId] = useState('')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true)
    try {
      const result = await api<TaskSummary[]>(`/matching/tasks?mode=${mode}`)
      if (!alive.current) return
      setTasks(result)
      setError('')
      setRefreshError('')
    } catch (failure) {
      if (!alive.current) return
      if (background) setRefreshError((failure as Error).message)
      else setError((failure as Error).message)
    } finally {
      if (alive.current && !background) setLoading(false)
    }
  }, [mode])

  useEffect(() => {
    void load()
    api<MatchingOptions>('/matching/options')
      .then(value => { if (alive.current) setOptions(value) })
      .catch(failure => { if (alive.current) setError((failure as Error).message) })
  }, [load])

  const running = Boolean(tasks?.some(task => task.running))
  usePolling(running, () => load(true), pollIntervalMs)

  const access = matchingAccess(session, options)
  const open = (task: TaskSummary) => navigate(taskPath(mode, task.id))
  const remove = async (task: TaskSummary) => {
    setDeletingId(task.id)
    try {
      await send(`/matching/tasks/${encodeURIComponent(task.id)}`, 'DELETE')
      message.success(`任务“${task.name}”已删除`)
      await load(true)
    } catch (failure) {
      message.error((failure as Error).message)
    } finally {
      if (alive.current) setDeletingId('')
    }
  }

  // 每一列都给出宽度，合计即表格的最小宽度：窗口较窄时表格横向滚动，任务名称和操作固定在两侧，不会把某一列挤窄。
  const columns: ColumnsType<TaskSummary> = [
    {
      title: '任务名称', key: 'name', width: 220, fixed: 'left', render: (_, task) => (
        <>
          <div className="matching-task-name">{task.name}</div>
          <Typography.Text type="secondary" className="evidence-source">{task.id}</Typography.Text>
        </>
      ),
    },
    { title: mode === 'people_to_jobs' ? '比较岗位' : '岗位', key: 'jobs', width: 136, render: (_, task) => <JobTags jobs={task.jobs} limit={4} /> },
    { title: '人数', dataIndex: 'total', width: 56 },
    {
      title: '进度', key: 'progress', width: 128, render: (_, task) => (
        <div className="matching-progress">
          <span>{task.status === '待处理' ? '排队中，即将开始' : `已处理 ${task.processed}/${task.total}`}</span>
          {task.status === '处理中' && <Progress size="small" status="active" showInfo={false} percent={task.total ? Math.round(task.processed * 100 / task.total) : 0} />}
        </div>
      ),
    },
    {
      title: '状态', key: 'status', width: 100, render: (_, task) => (
        <Space size={[4, 4]} wrap>
          <StatusTag kind="task" value={task.status} />
          {task.failed > 0 && <Typography.Text type="secondary">{task.failed} 项未完成</Typography.Text>}
        </Space>
      ),
    },
    { title: '复核进度', key: 'review', width: 164, render: (_, task) => <ReviewTags review={task.review} /> },
    {
      title: '可导出报告数', key: 'exportable', width: 84, render: (_, task) => task.review
        ? <><span className="match-score">{task.review.exportable}</span> / {task.review.people}</>
        : <Typography.Text type="secondary">—</Typography.Text>,
    },
    { title: '创建时间', dataIndex: 'created_at', width: 100, render: (value: string) => formatTime(value) },
    {
      title: '操作', key: 'actions', width: 104, fixed: 'right', render: (_, task) => (
        // 确认框里的点击也会沿组件树向上传递，这里拦住，避免触发整行的“打开任务”。
        <Space size={0} onClick={event => event.stopPropagation()}>
          <Button type="link" size="small" onClick={() => open(task)}>查看</Button>
          {access.remove && (task.running
            ? <Tooltip title="任务正在分析，完成后才能删除"><Button danger type="link" size="small" disabled>删除</Button></Tooltip>
            : (
              <Popconfirm
                title={`确认删除任务“${task.name}”？`}
                description="将删除该任务的匹配结果、人工复核记录和已生成的报告，不可恢复；人员库和岗位库中的资料不受影响。"
                okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => remove(task)}
              >
                <Button danger type="link" size="small" loading={deletingId === task.id}>删除</Button>
              </Popconfirm>
            ))}
        </Space>
      ),
    },
  ]
  const tableWidth = columns.reduce((sum, column) => sum + Number(column.width || 0), 0)

  const createButton = access.create && options
    ? <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>新建任务</Button>
    : null

  return (
    <>
      <PageHeader title={meta.title} description={meta.description} actions={(
        <Space>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>
          {createButton}
        </Space>
      )} />
      {error && <Alert className="page-alert" type="error" showIcon message="任务列表未能读取" description={error}
        action={<Button size="small" onClick={() => void load()}>重试</Button>} />}
      {refreshError && <Alert className="page-alert" type="warning" showIcon message="自动刷新未成功，稍后会继续重试" description={refreshError} />}
      {running && <Alert className="page-alert" type="info" showIcon message="有任务正在后台分析，进度会自动更新；离开本页不影响分析。" />}
      {tasks && !tasks.length ? (
        <Card>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`还没有${meta.title}任务`}>
            <div className="matching-empty-guide">
              <Typography.Paragraph>开始前请确认两项准备工作已完成：</Typography.Paragraph>
              <ol>
                <li>岗位库中已有岗位，并配置了能力维度、权重和硬性条件。{can(session, 'job:read') && <Link to="/library/jobs">前往岗位库</Link>}</li>
                <li>人员库中已导入简历，且简历已解析。{can(session, 'person:read') && <Link to="/library/persons">前往人员库</Link>}</li>
              </ol>
              <Typography.Paragraph type="secondary">
                {access.create
                  ? `准备好后点击“新建任务”，选择${mode === 'people_to_jobs' ? '至少两个岗位' : '一个岗位'}和参加匹配的人员。`
                  : '当前账号可以查看和复核任务；新建任务请联系招聘人员。'}
              </Typography.Paragraph>
              {createButton}
            </div>
          </Empty>
        </Card>
      ) : (
        <Card>
          <Table<TaskSummary>
            rowKey="id" size="middle" columns={columns} dataSource={tasks || []} loading={!tasks && !error}
            pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
            scroll={{ x: tableWidth }}
            onRow={task => ({ className: 'matching-task-row', onClick: () => open(task) })}
          />
        </Card>
      )}
      {creating && options && (
        <CreateTaskDrawer
          mode={mode} maxPeople={options.max_people} onClose={() => setCreating(false)}
          onCreated={task => { setCreating(false); navigate(taskPath(task.mode, task.id)) }}
        />
      )}
    </>
  )
}
