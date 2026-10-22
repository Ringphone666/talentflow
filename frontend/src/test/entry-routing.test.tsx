import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from '../App'
import { getSession, setSession } from '../api'

vi.mock('../components/AdminShell', () => ({ AdminShell: () => <div>管理工作台已进入</div> }))
vi.mock('../pages/candidate/CandidateInterviewPage', () => ({ default: ({ onLogout }: { onLogout: () => void }) => <button onClick={onLogout}>退出个人面试</button> }))
const session = { access_token: 'entry-token', expires_at: 4102444800, username: 'local-workbench', display_name: '管理工作台', role: 'system_admin' as const, role_label: '系统管理员', permissions: ['*'] }
beforeEach(() => {
  setSession(null, 'admin'); setSession(null, 'candidate')
  window.history.replaceState(null, '', '/')
})
afterEach(() => { vi.restoreAllMocks(); setSession(null, 'admin'); setSession(null, 'candidate') })

it('管理页自动进入，无账号密码表单', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(session)))
  render(<MemoryRouter initialEntries={['/questions']}><App /></MemoryRouter>)
  expect(await screen.findByText('管理工作台已进入')).toBeInTheDocument()
  expect(screen.queryByPlaceholderText('请输入密码')).not.toBeInTheDocument()
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/auth/admin-entry'), expect.objectContaining({ method: 'POST' }))
})

it('管理会话不会跳过应聘者登录，两个入口会话独立', async () => {
  setSession(session)
  const fetch = vi.spyOn(globalThis, 'fetch')
  render(<MemoryRouter initialEntries={['/interview']}><App /></MemoryRouter>)
  expect(screen.getByText('登录参加面试')).toBeInTheDocument()
  expect(fetch).not.toHaveBeenCalled()
  expect(getSession('admin')?.role).toBe('system_admin')
  expect(getSession('candidate')).toBeNull()
})

it('应聘者退出只清理个人会话，不影响管理工作台', async () => {
  setSession(session)
  setSession({ ...session, role: 'candidate', username: 'candidate', role_label: '候选人' })
  render(<MemoryRouter initialEntries={['/interview']}><App /></MemoryRouter>)
  fireEvent.click(screen.getByText('退出个人面试'))
  expect(screen.getByText('登录参加面试')).toBeInTheDocument()
  expect(getSession('admin')?.role).toBe('system_admin')
  expect(getSession('candidate')).toBeNull()
})

it('主系统授权验证失败时显示重试，不降级成管理员', async () => {
  window.history.replaceState(null, '', '/#host_session=invalid')
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ detail: '授权失效' }), { status: 401 }))
  render(<MemoryRouter><App /></MemoryRouter>)
  expect(await screen.findByText('暂时无法进入管理端')).toBeInTheDocument()
  await waitFor(() => expect(window.location.hash).toBe(''))
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(getSession('admin')).toBeNull()
})
