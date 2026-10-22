import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { AdminShell } from '../components/AdminShell'
import { PageHeader } from '../components/PageHeader'
import { getSession, setSession } from '../api'
import { locate, visibleNavigation } from '../navigation'
import { can } from '../lib/access'
import { formatTime } from '../lib/format'
import type { Session } from '../types'

afterEach(() => {
  localStorage.clear()
  document.cookie = 'talentflow-session=; Path=/; Max-Age=0; SameSite=Lax'
})

const base = { access_token: 'test-token', expires_at: 4102444800, username: 'tester', display_name: '测试人员' }
const sessions: Record<string, Session> = {
  admin: { ...base, role: 'system_admin', role_label: '系统管理员', permissions: ['*'] },
  interviewer: { ...base, role: 'interviewer', role_label: '面试官', permissions: ['dashboard', 'job:read', 'person:read', 'report:read', 'listening:use', 'compare:read', 'matching:view', 'matching:review'] },
  reviewer: { ...base, role: 'question_reviewer', role_label: '题目审核人', permissions: ['dashboard', 'job:read', 'batch:read', 'question:read', 'question:review', 'question:publish', 'question:disable'] },
  business: { ...base, role: 'business_user', role_label: '用人部门', permissions: ['dashboard', 'job:read', 'person:read', 'report:read', 'compare:read', 'matching:view', 'matching:review', 'matching:export'] },
}

function renderShell(session: Session, path = '/') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route element={<AdminShell session={session} />}>
        <Route path="*" element={<PageHeader title="当前页面" description="说明" />} />
      </Route></Routes>
    </MemoryRouter>,
  )
  return within(document.querySelector('.sider-menu') as HTMLElement)
}

describe('多级菜单', () => {
  it('人岗匹配和AI面试各为一级菜单，岗位库和人员库归入基础数据', () => {
    const menu = renderShell(sessions.admin)
    for (const group of ['基础数据', '人岗匹配', 'AI面试', '系统管理']) expect(menu.getByText(group)).toBeInTheDocument()
    for (const page of ['工作台', '岗位库', '人员库', '岗位选才', '人才适岗', '批次与题目', '候选人管理', 'AI旁听', '面试报告', '候选人对比', '合规与规则', '审计日志']) {
      expect(menu.getByText(page)).toBeInTheDocument()
    }
    expect(menu.queryByText('岗位与胜任力')).not.toBeInTheDocument()
    expect(menu.queryByText('综合报告')).not.toBeInTheDocument()
    expect(menu.queryByText(/人才库/)).not.toBeInTheDocument()
  })

  it('按权限显示菜单，没有可见页面的分组整体不显示', () => {
    const menu = renderShell(sessions.reviewer)
    expect(menu.getByText('岗位库')).toBeInTheDocument()
    expect(menu.getByText('批次与题目')).toBeInTheDocument()
    for (const hidden of ['人员库', '人岗匹配', '岗位选才', '候选人管理', 'AI旁听', '面试报告', '系统管理', '审计日志']) {
      expect(menu.queryByText(hidden)).not.toBeInTheDocument()
    }
  })

  it('面试官能进入AI旁听和人岗匹配，看不到候选人管理和系统管理', () => {
    const menu = renderShell(sessions.interviewer)
    for (const page of ['AI旁听', '面试报告', '候选人对比', '岗位选才']) expect(menu.getByText(page)).toBeInTheDocument()
    for (const hidden of ['候选人管理', '批次与题目', '合规与规则', '审计日志']) expect(menu.queryByText(hidden)).not.toBeInTheDocument()
  })

  it('用人部门角色只看到查看、复核和导出相关的入口', () => {
    const tree = visibleNavigation(sessions.business)
    expect(tree.map(item => item.label)).toEqual(['工作台', '基础数据', '人岗匹配', 'AI面试'])
    expect(tree.find(item => item.key === 'ai-interview')?.children?.map(item => item.label)).toEqual(['面试报告', '候选人对比'])
    expect(can(sessions.business, 'matching:create')).toBe(false)
    expect(can(sessions.business, 'matching:export')).toBe(true)
  })

  it('面包屑带出所属菜单，任务详情页归到所属的匹配方式', () => {
    renderShell(sessions.admin, '/matching/people-to-jobs/TASK-1')
    const breadcrumb = screen.getByRole('navigation')
    expect(within(breadcrumb).getByText('人岗匹配')).toBeInTheDocument()
    expect(locate('/matching/people-to-jobs/TASK-1').page?.label).toBe('人才适岗')
    expect(locate('/library/persons').section?.label).toBe('基础数据')
    expect(locate('/').section).toBeUndefined()
  })
})

describe('会话与时间', () => {
  it('刷新时从持久化会话恢复当前账号', () => {
    setSession(sessions.admin)
    // 模拟浏览器刷新前 localStorage 被清理，但同源会话 Cookie 仍然存在。
    localStorage.removeItem('talentflow-session')
    expect(getSession()).toEqual(sessions.admin)
    expect(JSON.parse(localStorage.getItem('talentflow-session') || '{}')).toMatchObject({ username: 'tester', role: 'system_admin' })
  })

  it('不带时区的时间按 UTC 解析，带时区的按原时区解析，显示为本地时间', () => {
    const pad = (value: number) => String(value).padStart(2, '0')
    const local = (value: Date) => `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`
    expect(formatTime('2026-09-28T03:04:05.123456')).toBe(local(new Date('2026-09-28T03:04:05Z')))
    expect(formatTime('2026-09-28T11:04:05+08:00')).toBe(local(new Date('2026-09-28T03:04:05Z')))
    expect(formatTime('2026-09-28 03:04:05')).toBe(local(new Date('2026-09-28T03:04:05Z')))
    expect(formatTime('')).toBe('—')
    expect(formatTime('不是时间')).toBe('—')
  })
})
