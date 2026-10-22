import { MenuFoldOutlined, MenuUnfoldOutlined, TeamOutlined } from '@ant-design/icons'
import { Avatar, Button, Drawer, Grid, Layout, Menu, Space, Tag, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import type { MenuProps } from 'antd'
import type { Session } from '../types'
import { locate, visibleNavigation } from '../navigation'
import { Brand, EnvironmentBadge, PRODUCT_NAME } from './Brand'

const { Header, Sider, Content } = Layout

export function AdminShell({ session }: { session: Session }) {
  const screens = Grid.useBreakpoint()
  const mobile = !screens.md
  const [collapsed, setCollapsed] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const tree = useMemo(() => visibleNavigation(session), [session])
  const items = useMemo<MenuProps['items']>(() => tree.map(item => ({
    key: item.key, label: item.label, icon: item.icon,
    children: item.children?.map(child => ({ key: child.key, label: child.label, icon: child.icon })),
  })), [tree])
  const current = locate(location.pathname)
  const selected = current.page?.key || (location.pathname === '/' ? '/' : '')
  const [openKeys, setOpenKeys] = useState<string[]>(() => tree.filter(item => item.children).map(item => item.key))
  useEffect(() => {
    // 进入某个分组下的页面时保证该分组展开，其余分组保持使用者的展开状态。
    const section = current.section?.key
    if (section) setOpenKeys(keys => keys.includes(section) ? keys : [...keys, section])
  }, [current.section?.key])

  const menu = (inline: boolean) => (
    <Menu
      mode="inline"
      selectedKeys={selected ? [selected] : []}
      {...(inline && collapsed ? {} : { openKeys, onOpenChange: keys => setOpenKeys(keys as string[]) })}
      items={items}
      onClick={({ key }) => {
        navigate(key)
        setDrawerOpen(false)
      }}
    />
  )

  return (
    <Layout className="admin-layout">
      {!mobile && (
        <Sider width={232} collapsed={collapsed} theme="light" className="admin-sider">
          <div className="sider-brand"><Brand compact={collapsed} /></div>
          <div className="sider-menu">{menu(true)}</div>
          {!collapsed && <div className="sider-foot">AI生成内容须人工复核</div>}
        </Sider>
      )}
      <Layout>
        <Header className="admin-header">
          <Space size={12} className="admin-header-context">
            <Button
              type="text"
              aria-label="切换菜单"
              icon={mobile ? <MenuUnfoldOutlined /> : (collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />)}
              onClick={() => mobile ? setDrawerOpen(true) : setCollapsed(value => !value)}
            />
            {mobile && <Typography.Text strong ellipsis>{PRODUCT_NAME}</Typography.Text>}
            {!mobile && <EnvironmentBadge />}
          </Space>
          <Space size={10} className="admin-header-account">
            <Tag color="green">{session.role_label}</Tag>
            {!mobile && <Typography.Text className="admin-display-name" ellipsis>{session.display_name}</Typography.Text>}
            <Avatar size="small" icon={<TeamOutlined />} />
            <Button type="link" href="/interview?login=1" target="_blank" rel="noopener noreferrer">应聘者入口</Button>
          </Space>
        </Header>
        <Content className="admin-content">
          {mobile && <div className="mobile-environment-line"><EnvironmentBadge /></div>}
          <Outlet context={{ session }} />
        </Content>
      </Layout>
      <Drawer title={<Brand />} placement="left" width={300} open={drawerOpen} onClose={() => setDrawerOpen(false)} styles={{ body: { padding: 8 } }}>
        {menu(false)}
      </Drawer>
    </Layout>
  )
}
