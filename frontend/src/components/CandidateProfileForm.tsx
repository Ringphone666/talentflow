import { ArrowRightOutlined, MailOutlined, PhoneOutlined, UserOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Form, Input, Select, Typography } from 'antd'
import type { FormInstance } from 'antd'
import './candidateProfile.css'

interface Props {
  form: FormInstance
  candidate: { name: string; code: string }
  saving: boolean
  error: string
  onSave: () => void
}

export function CandidateProfileForm({ form, candidate, saving, error, onSave }: Props) {
  return <Card className="candidate-profile-card">
    <header className="candidate-profile-heading">
      <span className="candidate-profile-icon"><UserOutlined /></span>
      <div>
        <span className="candidate-profile-eyebrow">面试前准备 · 第一步</span>
        <Typography.Title level={2}>完善个人信息</Typography.Title>
        <Typography.Paragraph>请核对并填写以下信息，方便招聘方了解你的教育背景与相关经历。</Typography.Paragraph>
      </div>
    </header>
    <dl className="candidate-profile-identity">
      <div><dt>应聘者</dt><dd>{candidate.name}</dd></div>
      <div><dt>候选人编号</dt><dd>{candidate.code}</dd></div>
    </dl>
    <Form form={form} layout="vertical" size="large" requiredMark className="candidate-profile-form" onFinish={onSave} scrollToFirstError>
      <section aria-labelledby="profile-contact-heading">
        <div className="candidate-profile-section-title"><h3 id="profile-contact-heading">联系方式</h3><span>请填写本人常用的联系方式</span></div>
        <div className="candidate-profile-grid">
          <Form.Item name="phone" label="手机号" rules={[{ required: true, whitespace: true, message: '请输入手机号' }, { min: 5, max: 32, message: '请检查手机号是否完整' }]}>
            <Input prefix={<PhoneOutlined />} type="tel" autoComplete="tel" maxLength={32} placeholder="请输入常用手机号" />
          </Form.Item>
          <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email', message: '请输入有效邮箱，如 name@example.com' }, { max: 128, message: '邮箱最多128个字符' }]}>
            <Input prefix={<MailOutlined />} type="email" autoComplete="email" maxLength={128} placeholder="例如 name@example.com" />
          </Form.Item>
        </div>
      </section>
      <section aria-labelledby="profile-background-heading">
        <div className="candidate-profile-section-title"><h3 id="profile-background-heading">教育与经历</h3><span>请按实际情况填写</span></div>
        <div className="candidate-profile-grid">
          <Form.Item name="education" label="最高学历" rules={[{ required: true, message: '请选择最高学历' }]}>
            <Select placeholder="请选择最高学历" options={['大专', '本科', '硕士', '博士', '其他'].map(value => ({ value, label: value }))} />
          </Form.Item>
          <Form.Item name="major" label="所学专业" rules={[{ required: true, whitespace: true, message: '请输入所学专业' }]}>
            <Input maxLength={128} placeholder="例如 食品科学与工程" />
          </Form.Item>
          <Form.Item name="years" label="相关经历年限" extra="应届毕业生可填写“应届生”。" rules={[{ required: true, whitespace: true, message: '请输入相关经历年限，应届毕业生可填写“应届生”' }]}>
            <Input maxLength={32} placeholder="例如 应届生、1年、3年" />
          </Form.Item>
        </div>
      </section>
      {error && <Alert type="error" showIcon message="个人信息未保存" description={error} />}
      <footer className="candidate-profile-footer">
        <div><strong>下一步：采集告知</strong><span>保存后，请阅读并确认面试信息采集说明。</span></div>
        <Button type="primary" size="large" htmlType="submit" loading={saving}>保存并继续 <ArrowRightOutlined /></Button>
      </footer>
    </Form>
  </Card>
}
