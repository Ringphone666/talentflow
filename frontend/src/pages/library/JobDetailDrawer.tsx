import { DownloadOutlined, EditOutlined } from '@ant-design/icons'
import { Alert, Button, Drawer, Form, Skeleton, Space, Tabs, Tag, Typography } from 'antd'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, send } from '../../api'
import { StatusTag } from '../../components/StatusTag'
import { formatTime } from '../../lib/format'
import { InterviewStandardTab } from './InterviewStandardTab'
import { JobProfileFields, JobScorecardFields } from './JobFormFields'
import { JobProfileView, JobScorecardView } from './JobViews'
import { useFeedback } from './feedback'
import { buildPayload, profileAffectsMatching, profileValuesOf, scorecardValuesOf, splitLines } from './jobModel'
import type { JobProfileFormValues, JobScorecardFormValues } from './jobModel'
import { safeFileName, saveBlob } from './operations'
import type { CapabilityTags, JobDetail } from './types'

export type JobTab = 'profile' | 'scorecard' | 'standard'

export function isJobTab(value: string | null | undefined): value is JobTab {
  return value === 'profile' || value === 'scorecard' || value === 'standard'
}

interface EditSession {
  version: number
  profile: JobProfileFormValues
  scorecard: JobScorecardFormValues
}

interface Notice {
  type: 'success' | 'warning'
  title: string
  text: string
}

interface Props {
  jobId: string
  initialMode: 'view' | 'edit'
  initialTab?: JobTab
  canEdit: boolean
  onClose: () => void
  /** 岗位内容或面试评价标准有变化，列表需要刷新。 */
  onChanged: () => void
}

/** 岗位详情：岗位说明、能力标签与权重、面试评价标准。 */
export function JobDetailDrawer({ jobId, initialMode, initialTab, canEdit, onClose, onChanged }: Props) {
  const { message, modal } = useFeedback()
  const [job, setJob] = useState<JobDetail | null>(null)
  const [loadError, setLoadError] = useState('')
  const [tab, setTab] = useState<JobTab>(initialTab || 'profile')
  const [editing, setEditing] = useState<EditSession | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [exporting, setExporting] = useState(false)
  const [profileForm] = Form.useForm<JobProfileFormValues>()
  const [scorecardForm] = Form.useForm<JobScorecardFormValues>()
  const sessions = useRef(0)
  const openInEdit = useRef(initialMode === 'edit')

  const beginEdit = useCallback((detail: JobDetail) => {
    setSaveError('')
    setNotice(null)
    setEditing({ version: ++sessions.current, profile: profileValuesOf(detail), scorecard: scorecardValuesOf(detail.dimensions, detail.weights) })
    setTab(current => current === 'standard' ? 'profile' : current)
  }, [])

  const load = useCallback(async () => {
    try {
      const detail = await api<JobDetail>(`/library/jobs/${jobId}`)
      setJob(detail)
      setLoadError('')
      return detail
    } catch (e) {
      setLoadError((e as Error).message)
      return null
    }
  }, [jobId])

  useEffect(() => {
    let disposed = false
    setJob(null)
    setEditing(null)
    setNotice(null)
    setSaveError('')
    void load().then(detail => {
      if (disposed || !detail) return
      if (openInEdit.current && canEdit && detail.is_active) beginEdit(detail)
      openInEdit.current = false
    })
    return () => { disposed = true }
  }, [load, beginEdit, canEdit])

  const session = editing?.version
  useLayoutEffect(() => {
    // 表单实例在多次编辑之间复用：每次进入编辑时回到岗位当前保存的内容。
    if (!session) return
    profileForm.resetFields()
    scorecardForm.resetFields()
  }, [session, profileForm, scorecardForm])

  const currentPayload = () => buildPayload(
    profileForm.getFieldsValue(true) as JobProfileFormValues,
    scorecardForm.getFieldsValue(true) as JobScorecardFormValues,
  )

  const hasUnsavedChanges = () => Boolean(editing)
    && JSON.stringify(currentPayload()) !== JSON.stringify(buildPayload(editing!.profile, editing!.scorecard))

  const confirmDiscard = (action: () => void) => {
    if (!hasUnsavedChanges()) { action(); return }
    modal.confirm({
      title: '放弃未保存的修改？',
      content: '岗位说明或能力标签的修改尚未保存，放弃后无法找回。',
      okText: '放弃修改',
      cancelText: '继续编辑',
      okButtonProps: { danger: true },
      onOk: action,
    })
  }

  const save = async () => {
    if (!job || !editing) return
    try {
      await profileForm.validateFields()
    } catch {
      setTab('profile')
      message.warning('请检查岗位说明中标红的内容')
      return
    }
    try {
      await scorecardForm.validateFields()
    } catch {
      setTab('scorecard')
      message.warning('请检查能力标签与权重')
      return
    }
    const payload = currentPayload()
    const affectsProfile = profileAffectsMatching(job, payload)
    setSaving(true)
    setSaveError('')
    try {
      const saved = await send<JobDetail>(`/library/jobs/${job.id}`, 'PUT', payload)
      setJob(saved)
      setEditing(null)
      const change = saved.scorecard_change
      const reasons = [
        ...(affectsProfile ? ['岗位名称、职责、任职要求或硬性条件'] : []),
        ...(change?.changed ? ['能力标签或证据关键词'] : []),
      ]
      if (reasons.length && saved.matching_task_count > 0) {
        setNotice({
          type: 'warning',
          title: '该岗位已有的匹配结果需要重新分析',
          text: `本次修改了${reasons.join('和')}。该岗位已用于 ${saved.matching_task_count} 个匹配任务，已有匹配结果已标记为“需重新分析”，请到对应的匹配任务中重新分析后再复核。`,
        })
      } else if (change && !change.changed && change.synchronized > 0) {
        setNotice({
          type: 'success',
          title: '已按新权重重新计算匹配得分',
          text: `能力标签没有变化，只调整了权重：已按新权重重新计算 ${change.synchronized} 人的匹配得分，不需要重新分析。`,
        })
      } else {
        setNotice(null)
      }
      message.success('岗位已保存')
      onChanged()
    } catch (e) {
      setSaveError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const exportTags = async () => {
    if (!job) return
    setExporting(true)
    try {
      const data = await api<CapabilityTags>(`/library/jobs/${job.id}/capability-tags`)
      saveBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }), `${safeFileName(data.job_name || job.name)}_能力标签.json`)
      message.success('能力标签已导出')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setExporting(false)
    }
  }

  const editable = canEdit && Boolean(job?.is_active)
  return (
    <Drawer
      className="job-drawer"
      open
      width="min(1120px, 100vw)"
      title={job ? (
        <Space wrap size={8}>
          <span>{job.name}</span>
          {!job.is_active && <Tag>已删除</Tag>}
          <Typography.Text type="secondary" className="drawer-subtitle">{job.sequence} · {job.level} · 更新于 {formatTime(job.updated_at)}</Typography.Text>
        </Space>
      ) : '岗位详情'}
      extra={job && editable && !editing && tab !== 'standard' ? <Button type="primary" icon={<EditOutlined />} onClick={() => beginEdit(job)}>编辑岗位</Button> : undefined}
      footer={editing ? (
        <Space wrap>
          <Button type="primary" loading={saving} onClick={() => void save()}>保存岗位说明与能力标签</Button>
          <Button disabled={saving} onClick={() => confirmDiscard(() => setEditing(null))}>取消编辑</Button>
        </Space>
      ) : undefined}
      onClose={() => { if (!saving) confirmDiscard(onClose) }}
    >
      {loadError && !job && <Alert type="error" showIcon message="岗位加载失败" description={loadError} action={<Button size="small" onClick={() => void load()}>重新加载</Button>} />}
      {!job && !loadError && <Skeleton active />}
      {job && (
        <>
          {!job.is_active && <Alert className="page-alert" type="warning" showIcon message="该岗位已删除，恢复后才能编辑和用于新任务" />}
          {notice && <Alert className="page-alert" type={notice.type} showIcon closable onClose={() => setNotice(null)} message={notice.title} description={notice.text} />}
          {saveError && <Alert className="page-alert" type="error" showIcon message="保存未完成" description={<div className="evidence-text">{saveError}</div>} />}
          {editing && <Alert className="page-alert" type="info" showIcon message="岗位说明和能力标签一起保存。修改职责、任职要求、硬性条件或能力标签后，该岗位已有的匹配结果需要重新分析；只调整权重时系统会直接重新计算得分。" />}
          <Tabs
            activeKey={tab}
            onChange={key => { if (isJobTab(key)) setTab(key) }}
            items={[
              {
                key: 'profile', label: '岗位说明', forceRender: true,
                children: editing
                  ? <Form key={editing.version} form={profileForm} name="job-profile" layout="vertical" initialValues={editing.profile} disabled={saving}><JobProfileFields expandExtra={Boolean(editing.profile.scope || editing.profile.extra_sections.length)} /></Form>
                  : <JobProfileView job={job} />,
              },
              {
                key: 'scorecard', label: '能力标签与权重', forceRender: true,
                children: editing
                  ? (
                    <Form key={editing.version} form={scorecardForm} name="job-scorecard" layout="vertical" initialValues={editing.scorecard} disabled={saving}>
                      <JobScorecardFields getContext={() => ({
                        name: String(profileForm.getFieldValue('name') || '').trim(),
                        responsibilities: splitLines(profileForm.getFieldValue('responsibilities')),
                        requirements: splitLines(profileForm.getFieldValue('requirements')),
                      })} />
                    </Form>
                  )
                  : (
                    <>
                      <div className="tab-actions">
                        <Typography.Text type="secondary">结构化输出岗位的硬性条件和能力标签，供业务系统存储和横向对比。</Typography.Text>
                        <Button icon={<DownloadOutlined />} loading={exporting} onClick={() => void exportTags()}>导出能力标签 (JSON)</Button>
                      </div>
                      <JobScorecardView job={job} />
                    </>
                  ),
              },
              {
                key: 'standard',
                label: <Space size={6}>面试评价标准<StatusTag kind="standard" value={job.interview.audit_status} /></Space>,
                children: <InterviewStandardTab job={job} canEdit={canEdit} onChanged={() => { void load(); onChanged() }} />,
              },
            ]}
          />
        </>
      )}
    </Drawer>
  )
}
