import { Alert, Checkbox, Modal, Typography, message } from 'antd'
import { useRef, useState } from 'react'
import { send } from '../../api'
import { onsiteLink } from '../candidate/onsiteEntry'
import { errorMessage } from './shared'

interface OpenedEntry {
  id: number
  entry_token: string
  expires_at: string
  consent_attested: boolean
  reused: boolean
}

interface Props {
  batch: { id: number; name: string }
  /** 指定候选人时直接进入该候选人的面试；不指定时打开本批次的候选人名单。 */
  candidate?: { id: number; name: string; code: string }
  onClose: () => void
}

/**
 * 现场面试：在这台设备上直接进入面试，不需要账号密码，也不填写个人信息。
 * 用于会议室的智慧屏，或把电脑投到大屏上的现场面试。
 */
export function OnsiteLaunchModal({ batch, candidate, onClose }: Props) {
  const [attested, setAttested] = useState(false)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')
  // 浏览器拦截了新窗口时，留下链接让使用者自己点开。
  const [blocked, setBlocked] = useState('')
  const lock = useRef(false)

  const open = async () => {
    if (lock.current) return
    lock.current = true
    setOpening(true)
    setError('')
    // 浏览器只允许在点击的当下打开新窗口：先打开空白页，取得入口后再转到现场面试页面。
    const tab = window.open('', '_blank')
    try {
      const entry = await send<OpenedEntry>(`/batches/${batch.id}/onsite-entries`, 'POST', {
        consent_attested: attested, hours: 8, reuse: true,
      })
      const link = onsiteLink(entry.entry_token, candidate?.id)
      if (tab) {
        tab.opener = null
        tab.location.replace(link)
        message.success('现场面试已在新窗口打开')
        onClose()
      } else {
        setBlocked(link)
      }
    } catch (cause) {
      tab?.close()
      setError(errorMessage(cause))
    } finally {
      lock.current = false
      setOpening(false)
    }
  }

  return (
    <Modal
      open
      title={candidate ? `现场面试 · ${candidate.name}（${candidate.code}）` : `现场面试 · ${batch.name}`}
      okText={blocked ? '关闭' : '进入现场面试'}
      cancelText="取消"
      confirmLoading={opening}
      cancelButtonProps={{ disabled: opening, style: blocked ? { display: 'none' } : undefined }}
      maskClosable={!opening}
      closable={!opening}
      onOk={() => blocked ? onClose() : void open()}
      onCancel={() => { if (!opening) onClose() }}
    >
      <Typography.Paragraph>
        {candidate
          ? '在这台设备上直接进入该候选人的AI面试：不需要账号密码，不填写个人信息，从设备检测开始。'
          : '在这台设备上打开本批次的候选人名单，候选人选择本人后直接进入设备检测和面试，不需要账号密码。'}
        适用于会议室的智慧屏，或把电脑投到大屏上的现场面试；页面会按屏幕大小放大显示。
      </Typography.Paragraph>
      {blocked ? (
        <Alert
          type="warning"
          showIcon
          message="浏览器拦截了新窗口"
          description={<>请点击 <a href={blocked} target="_blank" rel="noopener noreferrer" onClick={onClose}>打开现场面试</a>。</>}
        />
      ) : (
        <>
          <Checkbox checked={attested} disabled={opening} onChange={event => setAttested(event.target.checked)}>
            已在现场向候选人告知采集事项并取得同意
          </Checkbox>
          <Typography.Paragraph type="secondary" className="interview-onsite-note">
            {attested
              ? '候选人进入后不再显示合规须知；这项确认会记录在您的名下。'
              : '不勾选时，候选人进入后先在屏幕上阅读并同意合规须知，再进行设备检测。'}
            面试提交后页面回到候选人名单，可以接着面试下一位。
          </Typography.Paragraph>
        </>
      )}
      {error && <Alert type="error" showIcon message="暂时无法进入现场面试" description={error} />}
    </Modal>
  )
}
