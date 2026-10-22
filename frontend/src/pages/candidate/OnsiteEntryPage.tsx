import { ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Empty, Input, Modal, Result, Space, Spin, Tag, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError, setSession } from '../../api'
import { Brand } from '../../components/Brand'
import { formatTime } from '../../lib/format'
import {
  clearEntryToken, INTERVIEW_PATH, readEntryCandidate, readEntryFragment, readEntryToken, removeEntryFragment, storeEntryToken,
  type CandidateSession,
} from './onsiteEntry'
import { ScreenControls } from './ScreenControls'
import './onsiteEntry.css'

type OnsiteStatus = 'waiting' | 'in_progress' | 'completed' | 'unavailable'

interface OnsiteCandidate {
  id: number
  code: string
  name: string
  status: OnsiteStatus
}

interface OnsiteList {
  batch: { id: number; name: string; job_name: string }
  consent_attested: boolean
  expires_at: string
  candidates: OnsiteCandidate[]
}

interface Problem {
  /** expired：入口过期或已被关闭，需要工作人员重新开启；failed：本次读取未成功，可以重试。 */
  kind: 'expired' | 'failed'
  message: string
}

const statusTags: Record<OnsiteStatus, { label: string; color: string }> = {
  waiting: { label: '待面试', color: 'blue' },
  in_progress: { label: '面试中', color: 'processing' },
  completed: { label: '已完成', color: 'green' },
  unavailable: { label: '未安排面试', color: 'default' },
}

const selectable = (candidate: OnsiteCandidate) => candidate.status === 'waiting' || candidate.status === 'in_progress'

export default function OnsiteEntryPage() {
  const navigate = useNavigate()
  const [fragmentToken] = useState(readEntryFragment)
  // 工作人员在管理端对某位候选人点了“现场面试”：名单读到后直接进入该候选人的面试。
  const [direct, setDirect] = useState<number | null>(() => fragmentToken ? readEntryCandidate() : null)
  const [directNote, setDirectNote] = useState('')
  const [token, setToken] = useState<string | null>(() => fragmentToken || readEntryToken())
  const [list, setList] = useState<OnsiteList | null>(null)
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [keyword, setKeyword] = useState('')
  const [picked, setPicked] = useState<OnsiteCandidate | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState('')
  const request = useRef(0)

  useEffect(() => {
    if (!fragmentToken) return
    storeEntryToken(fragmentToken)
    removeEntryFragment()
  }, [fragmentToken])

  const fail = useCallback((error: unknown) => {
    const text = (error as Error).message
    if (error instanceof ApiError && error.status === 401) {
      clearEntryToken()
      setToken(null)
      setList(null)
      setPicked(null)
      setProblem({ kind: 'expired', message: text })
      return
    }
    setProblem({ kind: 'failed', message: text })
  }, [])

  const load = useCallback(async () => {
    if (!token) return
    const current = ++request.current
    setLoading(true)
    try {
      const data = await api<OnsiteList>('/onsite/candidates', { headers: { Authorization: `Bearer ${token}` } })
      if (current !== request.current) return
      setList(data)
      setProblem(null)
    } catch (error) {
      if (current === request.current) fail(error)
    } finally {
      if (current === request.current) setLoading(false)
    }
  }, [token, fail])

  useEffect(() => { void load() }, [load])

  const begin = async (candidate: OnsiteCandidate | null = picked) => {
    if (!candidate || !token || starting) return
    setStarting(true)
    setStartError('')
    try {
      const session = await api<CandidateSession>('/onsite/sessions', {
        method: 'POST',
        body: JSON.stringify({ candidate_id: candidate.id }),
        headers: { Authorization: `Bearer ${token}` },
      })
      setSession(session, 'candidate')
      navigate(INTERVIEW_PATH)
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        fail(error)
        return
      }
      setStartError((error as Error).message)
      // 直接进入未成功时留在名单上，由候选人在名单中选择。
      if (!picked) setDirectNote(`未能直接进入 ${candidate.name} 的面试：${(error as Error).message}`)
      // 名单上的状态可能已经变化（例如刚刚提交），刷新后再由候选人确认。
      void load()
    } finally {
      setStarting(false)
    }
  }

  useEffect(() => {
    if (!direct || !list) return
    setDirect(null)
    const candidate = list.candidates.find(item => item.id === direct)
    if (!candidate) setDirectNote('名单中没有工作人员指定的候选人，请在名单中选择。')
    else if (!selectable(candidate)) setDirectNote(`${candidate.name} 的面试${candidate.status === 'completed' ? '已经提交，不能重新进入' : '尚未安排'}。`)
    else void begin(candidate)
    // 只在名单第一次读到时处理一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direct, list])

  const visible = useMemo(() => {
    const text = keyword.trim().toLowerCase()
    const people = list?.candidates || []
    return text ? people.filter(item => item.name.toLowerCase().includes(text) || item.code.toLowerCase().includes(text)) : people
  }, [keyword, list])
  const count = (status: OnsiteStatus) => (list?.candidates || []).filter(item => item.status === status).length
  // 确认窗口打开期间名单可能刷新：以最新状态为准，已提交的不能再进入。
  const pickedNow = picked ? list?.candidates.find(item => item.id === picked.id) || picked : null

  return (
    <main className="candidate-page onsite-page">
      <header className="candidate-header">
        <Brand label="AI面试" />
        <Space wrap>
          <ScreenControls preferred />
          {list && <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新名单</Button>}
        </Space>
      </header>
      <div className="candidate-shell">
        {!token && problem?.kind !== 'expired' && (
          <Card className="candidate-card">
            <Result
              status="info"
              title="请由工作人员开启现场入口"
              subTitle="本页面用于线下集中面试，需要工作人员在这台设备上打开现场入口后才能选择候选人。"
              extra={<Button size="large" onClick={() => navigate(INTERVIEW_PATH)}>使用账号密码登录</Button>}
            />
          </Card>
        )}

        {problem?.kind === 'expired' && (
          <Card className="candidate-card">
            <Result status="warning" title="现场入口已过期或已关闭" subTitle={problem.message} />
            <Typography.Text type="secondary">请联系现场工作人员重新开启入口；已经提交的面试不受影响。</Typography.Text>
          </Card>
        )}

        {token && !list && loading && (
          <div className="onsite-loading" role="status"><Spin size="large" /><Typography.Text>正在读取候选人名单…</Typography.Text></div>
        )}

        {token && list && direct !== null && (
          <div className="onsite-loading" role="status"><Spin size="large" /><Typography.Text>正在进入面试…</Typography.Text></div>
        )}

        {token && !list && !loading && problem?.kind === 'failed' && (
          <Card className="candidate-card">
            <Alert type="error" showIcon message="候选人名单暂时无法读取" description={problem.message} />
            <Button type="primary" size="large" icon={<ReloadOutlined />} onClick={() => void load()}>重新读取</Button>
          </Card>
        )}

        {token && list && direct === null && starting && !picked && (
          <div className="onsite-loading" role="status"><Spin size="large" /><Typography.Text>正在进入面试…</Typography.Text></div>
        )}

        {token && list && direct === null && !(starting && !picked) && (
          <Card className="candidate-card onsite-card">
            <div className="onsite-heading">
              <Typography.Title level={2}>请选择你本人</Typography.Title>
              <Typography.Paragraph className="onsite-batch">{list.batch.name} · 应聘岗位：{list.batch.job_name}</Typography.Paragraph>
            </div>
            <Alert
              type="info"
              showIcon
              message={list.consent_attested
                ? '工作人员已在现场说明录音和信息采集事项并取得同意。选择本人后直接进入设备检测，不需要登录和填写个人信息。'
                : '选择本人后，需要先阅读并同意录音和信息采集须知，再进入设备检测；不需要登录和填写个人信息。'}
            />
            {directNote && <Alert type="warning" showIcon closable message={directNote} onClose={() => setDirectNote('')} />}
            {problem?.kind === 'failed' && <Alert type="error" showIcon message="名单刷新未成功，当前显示的是上一次读取的内容" description={problem.message} />}
            <div className="onsite-toolbar">
              <Input
                allowClear
                size="large"
                prefix={<SearchOutlined />}
                placeholder="输入姓名或候选人编号查找"
                aria-label="查找候选人"
                value={keyword}
                onChange={event => setKeyword(event.target.value)}
              />
              <Typography.Text className="onsite-count">
                共 {list.candidates.length} 人，待面试 {count('waiting')} 人，面试中 {count('in_progress')} 人，已完成 {count('completed')} 人
              </Typography.Text>
            </div>
            {visible.length === 0
              ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={list.candidates.length ? '没有找到符合条件的候选人，请核对姓名或编号' : '本批次还没有候选人，请联系现场工作人员'} />
              : (
                <ul className="onsite-list" aria-label="候选人名单">
                  {visible.map(candidate => (
                    <li key={candidate.id}>
                      <button
                        type="button"
                        className="onsite-candidate"
                        disabled={!selectable(candidate)}
                        onClick={() => { setStartError(''); setPicked(candidate) }}
                      >
                        <span className="onsite-candidate-name">{candidate.name}</span>
                        <span className="onsite-candidate-code">{candidate.code}</span>
                        <Tag color={statusTags[candidate.status]?.color || 'default'}>{statusTags[candidate.status]?.label || '状态待核实'}</Tag>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            <Typography.Text type="secondary">已完成的面试不能重新进入。名单中没有你的名字时，请联系现场工作人员。</Typography.Text>
          </Card>
        )}
      </div>
      {list && <footer className="candidate-footer">线下集中面试现场入口 · 有效期至 {formatTime(list.expires_at)}</footer>}

      <Modal
        className="onsite-confirm"
        centered
        open={Boolean(picked)}
        title={picked ? `确认你是 ${picked.name}（${picked.code}）` : ''}
        okText={picked?.status === 'in_progress' ? '是我，继续面试' : '是我，开始'}
        cancelText={pickedNow && !selectable(pickedNow) ? '返回名单' : '不是我，返回'}
        confirmLoading={starting}
        maskClosable={!starting}
        closable={!starting}
        okButtonProps={{ disabled: Boolean(pickedNow && !selectable(pickedNow)) }}
        cancelButtonProps={{ disabled: starting }}
        onOk={() => void begin()}
        onCancel={() => { if (!starting) setPicked(null) }}
      >
        <Typography.Paragraph>
          {picked?.status === 'in_progress'
            ? '你有一场尚未完成的面试，确认后从上次的进度继续。'
            : list?.consent_attested
              ? '确认后进入设备检测，随后开始面试。'
              : '确认后先阅读采集须知，再进入设备检测和面试。'}
          面试只能进行一次，请不要选择他人。
        </Typography.Paragraph>
        {startError && <Alert type="error" showIcon message="暂时无法进入面试" description={startError} />}
      </Modal>
    </main>
  )
}
