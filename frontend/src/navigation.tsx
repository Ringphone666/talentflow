import {
  ApartmentOutlined,
  AuditOutlined,
  BarChartOutlined,
  ContactsOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  FileSearchOutlined,
  FormOutlined,
  IdcardOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  SolutionOutlined,
  SoundOutlined,
  TeamOutlined,
  UserSwitchOutlined,
} from '@ant-design/icons'
import type { ReactNode } from 'react'
import type { Session } from './types'
import { can } from './lib/access'

export interface NavigationItem {
  key: string
  label: string
  icon: ReactNode
  permission?: string
  children?: NavigationItem[]
}

/**
 * 多级菜单：人岗匹配与AI面试各为独立的一级菜单，两者共用的岗位库、人员库归入“基础数据”。
 * key 以 “/” 开头的是页面路径，其余是分组。
 */
export const navigation: NavigationItem[] = [
  { key: '/', label: '工作台', icon: <DashboardOutlined />, permission: 'dashboard' },
  {
    key: 'library', label: '基础数据', icon: <DatabaseOutlined />, children: [
      { key: '/library/jobs', label: '岗位库', icon: <SolutionOutlined />, permission: 'job:read' },
      { key: '/library/persons', label: '人员库', icon: <ContactsOutlined />, permission: 'person:read' },
    ],
  },
  {
    key: 'matching', label: '人岗匹配', icon: <ApartmentOutlined />, children: [
      { key: '/matching/job-to-people', label: '岗位选才', icon: <IdcardOutlined />, permission: 'matching:view' },
      { key: '/matching/people-to-jobs', label: '人才适岗', icon: <UserSwitchOutlined />, permission: 'matching:view' },
    ],
  },
  {
    key: 'ai-interview', label: 'AI面试', icon: <SoundOutlined />, children: [
      { key: '/ai-interview/batches', label: '批次与题目', icon: <FormOutlined />, permission: 'question:read' },
      { key: '/ai-interview/candidates', label: '候选人管理', icon: <TeamOutlined />, permission: 'candidate:read' },
      { key: '/ai-interview/listening', label: 'AI旁听', icon: <SoundOutlined />, permission: 'listening:use' },
      { key: '/ai-interview/reports', label: '面试报告', icon: <FileSearchOutlined />, permission: 'report:read' },
      { key: '/ai-interview/comparison', label: '候选人对比', icon: <BarChartOutlined />, permission: 'compare:read' },
    ],
  },
  {
    key: 'system', label: '系统管理', icon: <SettingOutlined />, children: [
      { key: '/system/settings', label: '合规与规则', icon: <SafetyCertificateOutlined />, permission: 'config:edit' },
      { key: '/system/audits', label: '审计日志', icon: <AuditOutlined />, permission: 'audit:read' },
    ],
  },
]

/** 当前会话可见的菜单；没有可见子项的分组不显示。 */
export function visibleNavigation(session: Session): NavigationItem[] {
  return navigation.flatMap(item => {
    if (!item.children) return !item.permission || can(session, item.permission) ? [item] : []
    const children = item.children.filter(child => !child.permission || can(session, child.permission))
    return children.length ? [{ ...item, children }] : []
  })
}

/** 路径所属的页面与分组（详情页如 /matching/tasks/1 归到所属分组）。 */
export function locate(pathname: string): { section?: NavigationItem; page?: NavigationItem } {
  for (const item of navigation) {
    if (!item.children) {
      if (item.key === pathname) return { page: item }
      continue
    }
    const page = item.children.find(child => pathname === child.key || pathname.startsWith(`${child.key}/`))
    if (page) return { section: item, page }
    if (pathname.startsWith(`/${item.key}/`)) return { section: item }
  }
  return {}
}
