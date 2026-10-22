import { useEffect, useState } from 'react'
import { Alert, Button, Spin } from 'antd'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { api, getSession, setSession } from './api'
import type { Session } from './types'
import { AdminShell } from './components/AdminShell'
import DashboardPage from './pages/DashboardPage'
import JobLibraryPage from './pages/library/JobLibraryPage'
import PersonLibraryPage from './pages/library/PersonLibraryPage'
import MatchingTasksPage from './pages/matching/MatchingTasksPage'
import MatchingTaskPage, { MatchingTaskRedirect } from './pages/matching/MatchingTaskPage'
import BatchesPage from './pages/interview/BatchesPage'
import CandidatesPage from './pages/interview/CandidatesPage'
import ListeningPage from './pages/interview/ListeningPage'
import ReportsPage from './pages/interview/ReportsPage'
import ComparisonPage from './pages/interview/ComparisonPage'
import SettingsPage from './pages/system/SettingsPage'
import AuditsPage from './pages/system/AuditsPage'
import LoginPage from './pages/candidate/LoginPage'
import CandidateInterviewPage from './pages/candidate/CandidateInterviewPage'
import OnsiteEntryPage from './pages/candidate/OnsiteEntryPage'

// 旧版地址（两个系统合并前）转到新的菜单位置。
const legacyPaths: Record<string, string> = {
  '/jobs': '/library/jobs',
  '/questions': '/ai-interview/batches',
  '/candidates': '/ai-interview/candidates',
  '/listening': '/ai-interview/listening',
  '/reports': '/ai-interview/reports',
  '/comprehensive-reports': '/ai-interview/reports?type=comprehensive',
  '/comparison': '/ai-interview/comparison',
  '/settings': '/system/settings',
  '/audits': '/system/audits',
}

export default function App() {
  const location = useLocation()
  if (location.pathname.startsWith('/interview/onsite')) return <OnsiteEntryPage />
  return location.pathname.startsWith('/interview') ? <CandidateEntry /> : <AdminEntry />
}

function CandidateEntry() {
  const location = useLocation()
  const navigate = useNavigate()
  const [session, setCurrentSession] = useState<Session | null>(() => getSession('candidate'))
  const logout = () => {
    setSession(null, 'candidate')
    setCurrentSession(null)
  }
  // 管理端的“应聘者入口”带 login=1：即使这台设备上已有候选人登录，也先显示登录页，便于换账号。
  const choosing = new URLSearchParams(location.search).get('login') === '1'
  const enter = () => navigate('/interview', { replace: true })
  if (!session || choosing) {
    return <LoginPage current={session} onContinue={session ? enter : undefined} onLogin={next => { setCurrentSession(next); enter() }} />
  }
  return <CandidateInterviewPage key={session.username} session={session} onLogout={logout} />
}

function AdminEntry() {
  const [hostToken] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('host_session'))
  const [session, setCurrentSession] = useState<Session | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let disposed = false
    setError('')
    const enter = async () => {
      // 主系统将短期会话放在 URL fragment 中；消费后立即清除，不写入访问日志。
      if (hostToken) window.history.replaceState(null, '', window.location.pathname + window.location.search)
      let result: Session
      if (hostToken) {
        result = await api<Session>('/auth/session', { headers: { Authorization: `Bearer ${hostToken}` } })
      } else if (getSession('admin')) {
        try { result = await api<Session>('/auth/session') }
        catch { result = await api<Session>('/auth/admin-entry', { method: 'POST' }) }
      } else {
        result = await api<Session>('/auth/admin-entry', { method: 'POST' })
      }
      if (result.role === 'candidate') throw new Error('此入口需要主系统授予管理权限')
      if (!disposed) { setSession(result, 'admin'); setCurrentSession(result) }
    }
    enter().catch(e => { if (!disposed) setError((e as Error).message) })
    return () => { disposed = true }
  }, [attempt, hostToken])
  if (!session) return <main className="candidate-loading">{error
    ? <><Alert type="error" showIcon message="暂时无法进入管理端" description={error} /><Button onClick={() => setAttempt(n => n + 1)}>重新进入</Button></>
    : <><Spin size="large" /><span>正在进入管理工作台…</span></>}</main>
  return (
    <Routes>
      <Route element={<AdminShell session={session} />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/library/jobs" element={<JobLibraryPage />} />
        <Route path="/library/persons" element={<PersonLibraryPage />} />
        <Route path="/matching/job-to-people" element={<MatchingTasksPage mode="job_to_people" />} />
        <Route path="/matching/people-to-jobs" element={<MatchingTasksPage mode="people_to_jobs" />} />
        <Route path="/matching/job-to-people/:taskId" element={<MatchingTaskPage mode="job_to_people" />} />
        <Route path="/matching/people-to-jobs/:taskId" element={<MatchingTaskPage mode="people_to_jobs" />} />
        <Route path="/matching/tasks/:taskId" element={<MatchingTaskRedirect />} />
        <Route path="/ai-interview/batches" element={<BatchesPage />} />
        <Route path="/ai-interview/candidates" element={<CandidatesPage />} />
        <Route path="/ai-interview/listening" element={<ListeningPage />} />
        <Route path="/ai-interview/reports" element={<ReportsPage />} />
        <Route path="/ai-interview/comparison" element={<ComparisonPage />} />
        <Route path="/system/settings" element={<SettingsPage />} />
        <Route path="/system/audits" element={<AuditsPage />} />
        {Object.entries(legacyPaths).map(([from, to]) => <Route key={from} path={from} element={<Navigate to={to} replace />} />)}
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
