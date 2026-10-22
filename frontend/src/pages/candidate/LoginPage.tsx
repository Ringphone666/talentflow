import { ArrowRightOutlined, AuditOutlined, LockOutlined, SafetyCertificateOutlined, TeamOutlined, UserOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Form, Input, Typography, message } from 'antd'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, ApiError, setSession } from '../../api'
import type { Session } from '../../types'
import { Brand, EnvironmentBadge } from '../../components/Brand'
import { ONSITE_PATH, readEntryToken } from './onsiteEntry'
import './loginPage.css'

interface LoginValues { username: string; password: string }

interface Props {
  onLogin: (session: Session) => void
  /** 这台设备上已经登录的候选人；从管理端的“应聘者入口”进来时，先让使用者选择继续还是换账号。 */
  current?: Session | null
  onContinue?: () => void
}

export default function LoginPage({ onLogin, current, onContinue }: Props) {
  const [params] = useSearchParams()
  // 工作人员生成登录凭据后打开本页时带上账号，省去手工输入；密码不会出现在地址里。
  const account = (params.get('account') || '').trim().slice(0, 64)
  const [submitting, setSubmitting] = useState(false)
  const [locked, setLocked] = useState('')
  // 只有工作人员已在本设备开启现场入口时，才显示返回现场入口的链接。
  const [onsiteOpened] = useState(() => Boolean(readEntryToken()))

  const login = async (values: LoginValues) => {
    setSubmitting(true)
    setLocked('')
    try {
      const session = await api<Session>('/auth/login', { method: 'POST', body: JSON.stringify(values) })
      if (session.role !== 'candidate') throw new Error('请使用应聘者账号参加面试')
      setSession(session)
      onLogin(session)
    } catch (error) {
      // 连续输错密码后账号临时锁定：需要等待或找工作人员重置，提示保留在页面上。
      if (error instanceof ApiError && error.status === 423) setLocked(error.message)
      else message.error((error as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="login-page">
      <section className="login-hero">
        <div className="hero-decoration hero-one" />
        <div className="hero-decoration hero-two" />
        <div className="login-hero-content">
          <Brand label="AI面试" />
          <EnvironmentBadge />
          <Typography.Title>欢迎参加<br />AI面试</Typography.Title>
          <Typography.Paragraph>
            请使用招聘方提供的应聘者账号登录，完成个人信息、设备检测后开始面试。
          </Typography.Paragraph>
          <div className="hero-points">
            <span><SafetyCertificateOutlined /><strong>合规管理</strong><small>展示前检查面试内容</small></span>
            <span><AuditOutlined /><strong>操作记录</strong><small>记录主要业务操作</small></span>
            <span><TeamOutlined /><strong>个人面试</strong><small>仅查看和完成自己的面试</small></span>
          </div>
        </div>
      </section>
      <section className="login-panel">
        <Card className="login-card" variant="borderless">
          <div className="login-card-heading">
            <span className="login-eyebrow">应聘者入口</span>
            <Typography.Title level={2}>登录参加面试</Typography.Title>
            <Typography.Paragraph type="secondary">请输入管理员分配给你的账号和密码。</Typography.Paragraph>
          </div>
          {current && (
            <Alert
              className="login-current"
              type="info"
              showIcon
              message={`这台设备上已登录：${current.display_name}（${current.username}）`}
              description={(
                <>
                  <div>要换一位候选人，直接在下面用他的账号登录；原来那位的面试进度保留在系统里，重新登录后可以继续。</div>
                  {onContinue && <Button size="small" onClick={onContinue}>继续该候选人的面试</Button>}
                </>
              )}
            />
          )}
          <Form<LoginValues>
            className="login-form"
            layout="vertical"
            requiredMark={false}
            onFinish={login}
            autoComplete="on"
            initialValues={{ username: account }}
          >
            <Form.Item name="username" label="登录账号" rules={[{ required: true, message: '请输入登录账号' }]}>
              <Input size="large" prefix={<UserOutlined />} placeholder="请输入账号" autoComplete="username" allowClear />
            </Form.Item>
            <Form.Item name="password" label="登录密码" rules={[{ required: true, message: '请输入登录密码' }]}>
              <Input.Password size="large" prefix={<LockOutlined />} placeholder="请输入密码" autoComplete="current-password" />
            </Form.Item>
            {locked && <Alert className="login-locked" type="warning" showIcon message="账号已临时锁定" description={locked} />}
            <div className="login-session-hint"><SafetyCertificateOutlined /> 登录后将在本设备保持会话，刷新页面无需重新登录</div>
            <Button type="primary" size="large" block htmlType="submit" icon={<ArrowRightOutlined />} iconPosition="end" loading={submitting}>
              登录
            </Button>
          </Form>
          {onsiteOpened && <div className="login-onsite-link"><Link to={ONSITE_PATH}>返回现场面试名单</Link></div>}
        </Card>
      </section>
    </main>
  )
}
