import '@ant-design/v5-patch-for-react-19'
import { act, screen, waitFor } from '@testing-library/react'
import { message } from 'antd'
import { afterEach, expect, it } from 'vitest'

afterEach(async () => { await act(async () => { message.destroy() }) })

it('React 19 下能显示并关闭操作失败提示', async () => {
  await act(async () => { message.error({ key: 'duplicate-candidate', content: '候选人编号已存在', duration: 0 }) })
  expect(await screen.findByText('候选人编号已存在')).toBeVisible()
  await act(async () => { message.destroy('duplicate-candidate') })
  await waitFor(() => expect(screen.queryByText('候选人编号已存在')).not.toBeInTheDocument())
})
