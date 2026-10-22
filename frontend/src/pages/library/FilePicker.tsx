import { DeleteOutlined, PaperClipOutlined, UploadOutlined } from '@ant-design/icons'
import { Button, Typography } from 'antd'
import { useRef } from 'react'
import type { ReactNode } from 'react'
import { formatFileSize } from '../../lib/format'

interface PickerProps {
  label: string
  accept: string
  multiple?: boolean
  disabled?: boolean
  loading?: boolean
  primary?: boolean
  onPick: (files: File[]) => void
}

/** 选择本地文件。只负责选择，是否上传、何时上传由页面决定。 */
export function FilePicker({ label, accept, multiple = false, disabled = false, loading = false, primary = false, onPick }: PickerProps) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={input}
        type="file"
        hidden
        aria-label={label}
        accept={accept}
        multiple={multiple}
        disabled={disabled || loading}
        onChange={event => {
          const files = Array.from(event.target.files || [])
          event.target.value = ''
          if (files.length) onPick(files)
        }}
      />
      <Button type={primary ? 'primary' : 'default'} icon={<UploadOutlined />} disabled={disabled} loading={loading} onClick={() => input.current?.click()}>{label}</Button>
    </>
  )
}

/** 已选文件的一行：文件名完整显示，右侧可放对应关系等控件。 */
export function FileRow({ file, onRemove, disabled = false, children }: { file: File; onRemove: () => void; disabled?: boolean; children?: ReactNode }) {
  return (
    <li className="file-row">
      <PaperClipOutlined className="file-row-icon" />
      <span className="file-row-name">{file.name}</span>
      <Typography.Text type="secondary" className="file-row-size">{formatFileSize(file.size)}</Typography.Text>
      {children && <span className="file-row-extra">{children}</span>}
      <Button type="text" size="small" danger icon={<DeleteOutlined />} disabled={disabled} aria-label={`移除 ${file.name}`} onClick={onRemove} />
    </li>
  )
}
