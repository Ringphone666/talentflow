import { CopyOutlined, DownloadOutlined } from '@ant-design/icons'
import { Alert, Button, Modal, Popconfirm, Space, Table, Typography, message } from 'antd'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { copyText } from './shared'

export interface Credential {
  candidate_id: number
  name: string
  username: string
  password: string
}

export interface CredentialNotice {
  title: string
  items: Credential[]
  /** 下载文件名中使用的批次或候选人名称。 */
  fileLabel: string
  /** 附加说明，例如导入时被跳过的人员。 */
  note?: ReactNode
}

/** 表格软件会把以 = + - @ 开头或纯数字、日期样式的内容当作公式或数值，这类内容按文本写入。 */
function csvCell(value: string): string {
  const guarded = /^[=+\-@]/.test(value) || /^[\d\s.,/:-]+$/.test(value) ? `="${value.replace(/"/g, '""')}"` : value
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

/** 本次生成的登录凭据（UTF-8 带 BOM，Excel 可直接打开）。 */
export function credentialsCsv(items: Credential[], loginUrl: string): string {
  const rows = [['姓名', '登录账号', '密码', '登录地址'], ...items.map(item => [item.name, item.username, item.password, loginUrl])]
  return '﻿' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

function timestamp(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

function credentialText(item: Credential): string {
  return `姓名：${item.name}\n登录账号：${item.username}\n密码：${item.password}`
}

/** 候选人登录凭据只在生成时显示一次：关闭后无法再次查看，只能重置密码重新生成。 */
export function CredentialsModal({ notice, onClose }: { notice: CredentialNotice | null; onClose: () => void }) {
  const [kept, setKept] = useState(false)
  const loginUrl = `${window.location.origin}/interview`
  if (!notice) return null
  const { items } = notice
  const close = () => { setKept(false); onClose() }

  const copy = async (text: string, done: string) => {
    if (await copyText(text)) {
      setKept(true)
      message.success(done)
    } else {
      message.warning('未能自动复制，请手动选中后复制')
    }
  }
  const download = () => {
    const blob = new Blob([credentialsCsv(items, loginUrl)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `候选人登录凭据_${notice.fileLabel.replace(/[\\/:*?"<>|\s]+/g, '_')}_${timestamp()}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
    setKept(true)
  }

  return (
    <Modal
      open
      className="interview-credential-modal"
      title={notice.title}
      width={items.length > 1 ? 720 : 520}
      closable={false}
      maskClosable={false}
      keyboard={false}
      footer={
        <Space wrap className="interview-drawer-actions">
          <Button icon={<CopyOutlined />} onClick={() => void copy(items.map(credentialText).join('\n\n'), items.length > 1 ? `已复制 ${items.length} 人的凭据` : '凭据已复制')}>
            {items.length > 1 ? '复制全部' : '复制'}
          </Button>
          <Button icon={<DownloadOutlined />} onClick={download}>下载本次凭据 (CSV)</Button>
          {kept
            ? <Button type="primary" onClick={close}>已保存，关闭</Button>
            : (
              <Popconfirm title="尚未复制或下载" description="关闭后无法再次查看密码，确认关闭？" okText="确认关闭" cancelText="返回" onConfirm={close}>
                <Button type="primary">已保存，关闭</Button>
              </Popconfirm>
            )}
        </Space>
      }
    >
      <Alert
        type="warning"
        showIcon
        message="密码只显示这一次，之后无法再次查看"
        description="密码为随机生成，系统不保存明文。请立即复制或下载，并通过安全渠道交给候选人；如遗失，只能在候选人列表中“重置密码”重新生成。"
      />
      {notice.note}
      {items.length === 1 ? (
        <div className="credential-box">
          <dl>
            <dt>姓名</dt><dd>{items[0].name}</dd>
            <dt>登录账号</dt><dd>{items[0].username}</dd>
            <dt>密码</dt><dd>{items[0].password}</dd>
          </dl>
        </div>
      ) : (
        <Table
          className="interview-credential-table"
          rowKey="candidate_id"
          size="small"
          pagination={false}
          scroll={{ y: 360 }}
          dataSource={items}
          columns={[
            { title: '姓名', dataIndex: 'name' },
            { title: '登录账号', dataIndex: 'username', render: (value: string) => <span className="interview-credential-secret">{value}</span> },
            { title: '密码', dataIndex: 'password', render: (value: string) => <span className="interview-credential-secret">{value}</span> },
            { title: '操作', key: 'copy', width: 90, render: (_, item) => <Button type="link" size="small" onClick={() => void copy(credentialText(item), `${item.name} 的凭据已复制`)}>复制</Button> },
          ]}
        />
      )}
      <Typography.Paragraph className="interview-credential-address" type="secondary">
        候选人登录地址：{loginUrl}
        {items.length === 1 && (
          <> · <a href={`${loginUrl}?login=1&account=${encodeURIComponent(items[0].username)}`} target="_blank" rel="noopener noreferrer">在新窗口打开登录页（已填好账号）</a></>
        )}
      </Typography.Paragraph>
    </Modal>
  )
}
