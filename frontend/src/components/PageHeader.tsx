import { Breadcrumb, Typography } from 'antd'
import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { locate } from '../navigation'
import { PRODUCT_NAME } from './Brand'

/** 页面标题区。面包屑中的所属菜单按当前路径自动带出，也可用 section 指定。 */
export function PageHeader({ title, description, actions, section }: { title: string; description: string; actions?: ReactNode; section?: string }) {
  const { pathname } = useLocation()
  const group = section ?? locate(pathname).section?.label
  return (
    <div className="page-heading">
      <div className="page-heading-copy">
        <Breadcrumb items={[{ title: PRODUCT_NAME }, ...(group ? [{ title: group }] : []), { title }]} />
        <Typography.Title level={2}>{title}</Typography.Title>
        <Typography.Paragraph type="secondary">{description}</Typography.Paragraph>
      </div>
      {actions && <div className="page-heading-actions">{actions}</div>}
    </div>
  )
}

export function AiNotice() {
  return <div className="ai-notice">AI辅助生成，须人工复核</div>
}
