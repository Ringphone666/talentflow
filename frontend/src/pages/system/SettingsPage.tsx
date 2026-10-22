import { SaveOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Form, Input, Tabs, message } from 'antd'
import { useEffect, useState } from 'react'
import { api, send } from '../../api'
import { PageHeader } from '../../components/PageHeader'
import { createSensitiveRuleEntries, SensitiveRulesEditor, serializeSensitiveRules } from '../../components/SensitiveRulesEditor'
import type { SensitiveRuleEntry } from '../../components/SensitiveRulesEditor'
import { can, useAdminSession } from '../../lib/access'

export default function SettingsPage() {
  const session = useAdminSession()
  const [rules, setRules] = useState<SensitiveRuleEntry[]>([])
  const [rulesLoading, setRulesLoading] = useState(true)
  const [rulesLoaded, setRulesLoaded] = useState(false)
  const [rulesError, setRulesError] = useState('')
  const [version, setVersion] = useState('')
  const [noticeText, setNoticeText] = useState('')
  const [saving, setSaving] = useState(false)
  const canEdit = can(session, 'config:edit')
  const loadRules = async () => {
    setRulesLoading(true)
    setRulesError('')
    try {
      const data = await api<{ rules: Record<string, string[]> }>('/config/sensitive-rules')
      setRules(createSensitiveRuleEntries(data.rules))
      setRulesLoaded(true)
    } catch (error) {
      setRulesError(`规则加载失败：${(error as Error).message}`)
    } finally { setRulesLoading(false) }
  }
  useEffect(() => {
    void loadRules()
    api<{ version: string; text: string }>('/config/consent-notice').then(data => { setVersion(data.version); setNoticeText(data.text) }).catch(error => message.error(error.message))
  }, [])
  const saveRules = async () => {
    if (!canEdit || !rulesLoaded || rulesLoading) return
    try {
      const value = serializeSensitiveRules(rules)
      setRulesError('')
      setSaving(true)
      await send('/config/sensitive-rules', 'PUT', { rules: value })
      message.success('敏感规则已保存')
    } catch (error) { setRulesError((error as Error).message) } finally { setSaving(false) }
  }
  const saveNotice = async () => {
    try {
      setSaving(true)
      await send('/config/consent-notice', 'PUT', { version, text: noticeText })
      message.success('合规告知版本已发布')
    } catch (error) { message.error((error as Error).message) } finally { setSaving(false) }
  }
  return <>
    <PageHeader title="合规与规则" description="维护AI面试的敏感内容规则和采集告知；修改会写入审计日志。" />
    <Alert className="page-alert" type="warning" showIcon message="规则与告知版本发布后将用于后续面试，请完成HR、法务及信息安全审核后再发布。" />
    <Tabs items={[{
      key: 'rules', label: '敏感内容规则', children: <Card loading={rulesLoading} extra={canEdit && <Button type="primary" icon={<SaveOutlined />} loading={saving} disabled={!rulesLoaded || rulesLoading} onClick={() => void saveRules()}>保存规则</Button>}>
        {rulesError && <Alert className="page-alert" type="error" showIcon message={rulesError} action={!rulesLoaded ? <Button size="small" onClick={() => void loadRules()}>重新加载</Button> : undefined} />}
        <SensitiveRulesEditor value={rules} onChange={value => { setRules(value); setRulesError('') }} disabled={!canEdit || !rulesLoaded || saving} />
      </Card>,
    }, {
      key: 'notice', label: '采集告知', children: <Card extra={canEdit && <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void saveNotice()}>发布版本</Button>}>
        <Alert className="page-alert" type="info" showIcon message="候选人在面试前阅读并同意这份告知。线下集中面试由工作人员当面告知，开启现场入口时确认。" />
        <Form layout="vertical">
          <Form.Item label="版本号"><Input value={version} disabled={!canEdit} onChange={event => setVersion(event.target.value)} /></Form.Item>
          <Form.Item label="告知正文"><Input.TextArea rows={14} value={noticeText} disabled={!canEdit} onChange={event => setNoticeText(event.target.value)} /></Form.Item>
        </Form>
      </Card>,
    }]} />
  </>
}
