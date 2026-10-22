import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import SettingsPage from '../pages/system/SettingsPage'
import type { Session } from '../types'

afterEach(() => vi.restoreAllMocks())

function renderSettings(rules: Record<string, string[]> = { 个人隐私: ['年龄', '家庭住址'] }, role: Session['role'] = 'system_admin', failLoad = false) {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    if (String(input).endsWith('/config/sensitive-rules')) {
      if (options?.method === 'PUT') return Response.json({ ok: true })
      if (failLoad) return Response.json({ detail: '暂时无法连接服务' }, { status: 503 })
      return Response.json({ rules })
    }
    return Response.json({ version: 'test-v1', text: '用于测试的个人信息采集告知正文，请在面试前阅读确认。' })
  })
  const permissions = role === 'system_admin' ? ['*'] : role === 'hr_admin' ? ['config:edit', 'question:read'] : ['question:read', 'question:review']
  const session: Session = { access_token: 'test-token', expires_at: 4102444800, username: 'test', display_name: '测试人员', role, role_label: '测试人员', permissions }
  const Layout = () => <Outlet context={{ session }} />
  render(<MemoryRouter initialEntries={['/settings']}><Routes><Route element={<Layout />}><Route path="/settings" element={<SettingsPage />} /></Route></Routes></MemoryRouter>)
  return fetchMock
}

const savedCalls = (fetchMock: ReturnType<typeof renderSettings>) => fetchMock.mock.calls.filter(([, options]) => options?.method === 'PUT')

it('分类与关键词可以增删并保存，已有匹配规则与特殊字符原样保留', async () => {
  const originalRules = { 个人隐私: ['(?i:年龄|几岁)', ' 原样保留的词 ', '包含,逗号'], 待删除分类: ['旧词'] }
  const fetchMock = renderSettings(originalRules)
  expect(await screen.findByLabelText('第1类规则名称')).toHaveValue('个人隐私')
  expect(screen.queryByText(/JSON格式/)).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '删除第2个分类' }))
  fireEvent.click(screen.getByRole('button', { name: '为第1类添加关键词' }))
  fireEvent.change(screen.getByLabelText('第1类第3个关键词'), { target: { value: '新增词' } })
  fireEvent.click(screen.getByRole('button', { name: '为第1类添加关键词' }))
  fireEvent.click(screen.getByRole('button', { name: '删除第1类第4个关键词' }))
  fireEvent.click(screen.getByRole('button', { name: /添加规则分类/ }))
  fireEvent.change(screen.getByLabelText('第2类规则名称'), { target: { value: '不当评价' } })
  fireEvent.change(screen.getByLabelText('第2类第1个关键词'), { target: { value: '测试关键词' } })
  fireEvent.click(screen.getByRole('button', { name: /保存规则/ }))
  await waitFor(() => expect(savedCalls(fetchMock)).toHaveLength(1))
  expect(JSON.parse(String(savedCalls(fetchMock)[0][1]?.body))).toEqual({
    rules: { 个人隐私: [...originalRules.个人隐私, '新增词'], 不当评价: ['测试关键词'] },
  })
})

it('新增或修改关键词时将标点保存为字面匹配，不产生无效表达式或匹配任意字符', async () => {
  const fetchMock = renderSettings({ 特殊字符: ['旧词'] })
  await screen.findByLabelText('第1类规则名称')
  const literals = ['[', '.', '\\', '价格(元)', '^开头$', 'a+b*?', '含 空格#&~']
  for (const [index, literal] of literals.entries()) {
    if (index) fireEvent.click(screen.getByRole('button', { name: '为第1类添加关键词' }))
    fireEvent.change(screen.getByLabelText(`第1类第${index + 1}个关键词`), { target: { value: literal } })
  }
  fireEvent.click(screen.getByRole('button', { name: /保存规则/ }))
  await waitFor(() => expect(savedCalls(fetchMock)).toHaveLength(1))
  const saved = JSON.parse(String(savedCalls(fetchMock)[0][1]?.body)).rules.特殊字符 as string[]
  expect(saved).toEqual(['\\[', '\\.', '\\\\', '价格\\(元\\)', '\\^开头\\$', 'a\\+b\\*\\?', '含\\ 空格\\#\\&\\~'])
  for (const [index, pattern] of saved.entries()) {
    expect(new RegExp(pattern).test(`前文${literals[index]}后文`)).toBe(true)
    expect(new RegExp(pattern).test('完全无关的普通回答')).toBe(false)
  }
})

it('已转义关键词以正常文字显示且保存不变，高级规则折叠只读并能删除替换', async () => {
  const originalRules = { 个人隐私: ['\\[', '\\.', '\\(家庭\\)', '(?i:年龄|几岁)', '\\d+'] }
  const fetchMock = renderSettings(originalRules)
  expect(await screen.findByLabelText('第1类第1个关键词')).toHaveValue('[')
  expect(screen.getByLabelText('第1类第2个关键词')).toHaveValue('.')
  expect(screen.getByLabelText('第1类第3个关键词')).toHaveValue('(家庭)')
  expect(screen.queryByLabelText('第1类第1条已有高级规则')).not.toBeInTheDocument()
  fireEvent.click(screen.getByText('已有高级匹配规则（2）'))
  expect(await screen.findByLabelText('第1类第1条已有高级规则')).toHaveAttribute('readonly')
  expect(screen.getByLabelText('第1类第1条已有高级规则')).toHaveValue('(?i:年龄|几岁)')
  fireEvent.click(screen.getByRole('button', { name: /保存规则/ }))
  await waitFor(() => expect(savedCalls(fetchMock)).toHaveLength(1))
  expect(JSON.parse(String(savedCalls(fetchMock)[0][1]?.body))).toEqual({ rules: originalRules })
  await waitFor(() => expect(screen.getByRole('button', { name: '删除第1类第1条已有高级规则' })).not.toBeDisabled())
  fireEvent.change(screen.getByLabelText('第1类规则名称'), { target: { value: '更新分类' } })
  fireEvent.click(screen.getByRole('button', { name: '删除第1类第1条已有高级规则' }))
  fireEvent.click(screen.getByRole('button', { name: '为第1类添加关键词' }))
  fireEvent.change(screen.getByLabelText('第1类第4个关键词'), { target: { value: '年龄[岁]' } })
  fireEvent.click(screen.getByRole('button', { name: /保存规则/ }))
  await waitFor(() => expect(savedCalls(fetchMock)).toHaveLength(2))
  expect(JSON.parse(String(savedCalls(fetchMock)[1][1]?.body))).toEqual({ rules: { 更新分类: ['\\[', '\\.', '\\(家庭\\)', '\\d+', '年龄\\[岁\\]'] } })
})

it('重复分类名称不能覆盖已有分类的数据', async () => {
  const fetchMock = renderSettings()
  await screen.findByLabelText('第1类规则名称')
  fireEvent.click(screen.getByRole('button', { name: /添加规则分类/ }))
  fireEvent.change(screen.getByLabelText('第2类规则名称'), { target: { value: ' 个人隐私 ' } })
  fireEvent.change(screen.getByLabelText('第2类第1个关键词'), { target: { value: '新词' } })
  fireEvent.click(screen.getByRole('button', { name: /保存规则/ }))
  expect(await screen.findByText('分类名称“个人隐私”重复，请修改后保存')).toBeInTheDocument()
  expect(savedCalls(fetchMock)).toHaveLength(0)
  expect(screen.getByLabelText('第1类第1个关键词')).toHaveValue('年龄')
})

it.each([
  ['第1类规则名称', '   ', '请填写第 1 个分类的名称'],
  ['第1类第2个关键词', '   ', '请填写“个人隐私”的第 2 个关键词，或删除空白项'],
  ['第1类第2个关键词', ' 年龄 ', '“个人隐私”中有重复关键词“年龄”，请删除重复项'],
])('阻止无效规则保存：%s / %s', async (field, value, error) => {
  const fetchMock = renderSettings()
  await screen.findByLabelText('第1类规则名称')
  fireEvent.change(screen.getByLabelText(field), { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: /保存规则/ }))
  expect(await screen.findByText(error)).toBeInTheDocument()
  expect(savedCalls(fetchMock)).toHaveLength(0)
})

it('不能保存没有关键词的分类或删除全部分类后的空配置', async () => {
  const fetchMock = renderSettings({ 个人隐私: ['年龄'] })
  await screen.findByLabelText('第1类规则名称')
  fireEvent.click(screen.getByRole('button', { name: '删除第1类第1个关键词' }))
  fireEvent.click(screen.getByRole('button', { name: /保存规则/ }))
  expect(await screen.findByText('“个人隐私”至少需要一个关键词')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '删除第1个分类' }))
  fireEvent.click(screen.getByRole('button', { name: /保存规则/ }))
  expect(await screen.findByText('请至少添加一个规则分类')).toBeInTheDocument()
  expect(savedCalls(fetchMock)).toHaveLength(0)
})

it('规则加载失败时不能用空表单覆盖规则', async () => {
  const fetchMock = renderSettings(undefined, 'system_admin', true)
  expect(screen.getByRole('button', { name: /保存规则/ })).toBeDisabled()
  expect(await screen.findByText('规则加载失败：暂时无法连接服务')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /保存规则/ })).toBeDisabled()
  expect(screen.getByRole('button', { name: /添加规则分类/ })).toBeDisabled()
  expect(savedCalls(fetchMock)).toHaveLength(0)
})

it('没有配置权限的角色可查看规则，但看不到保存和发布入口', async () => {
  renderSettings(undefined, 'question_reviewer')
  expect(await screen.findByLabelText('第1类规则名称')).toBeDisabled()
  expect(screen.getByLabelText('第1类第1个关键词')).toBeDisabled()
  expect(screen.queryByRole('button', { name: /保存规则/ })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: /添加规则分类/ })).toBeDisabled()
})

it('HR管理员可以保存规则', async () => {
  const fetchMock = renderSettings(undefined, 'hr_admin')
  await screen.findByLabelText('第1类规则名称')
  fireEvent.click(screen.getByRole('button', { name: /保存规则/ }))
  await waitFor(() => expect(savedCalls(fetchMock)).toHaveLength(1))
})
