import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { vi } from 'vitest'
import type { Session } from '../types'

/** AI面试管理端页面测试共用：会话、页面渲染和接口模拟。 */

// 页面渲染完整的 Ant Design 组件。按角色查找时默认要逐个元素计算样式来判断是否可见，
// 每次查找要几秒；这里改为不做可见性判断，需要区分时用 within() 限定到当前页签或对话框，
// 或者显式传入 hidden: false。
configure({ asyncUtilTimeout: 10000, defaultHidden: true })
// 打开对话框、下拉框、气泡确认框在 jsdom 中各要约一秒，操作较多的用例在机器繁忙时会超过默认时限。
vi.setConfig({ testTimeout: 60000 })

export const permissions = {
  admin: ['*'],
  hr: [
    'dashboard', 'job:read', 'job:edit', 'person:read', 'person:edit', 'config:edit', 'audit:read',
    'batch:read', 'batch:create', 'batch:edit', 'batch:delete',
    'question:read', 'question:generate', 'question:edit', 'question:submit',
    'candidate:read', 'candidate:create', 'candidate:edit', 'candidate:delete',
    'report:read', 'report:export', 'compare:read', 'onsite:manage',
  ],
  questionReviewer: ['dashboard', 'job:read', 'batch:read', 'question:read', 'question:review', 'question:publish', 'question:disable'],
  reportReviewer: ['dashboard', 'job:read', 'person:read', 'report:read', 'report:edit', 'report:return', 'report:confirm', 'report:export', 'compare:read', 'listening:use'],
  interviewer: ['dashboard', 'job:read', 'person:read', 'report:read', 'listening:use', 'compare:read'],
}

export function sessionWith(granted: string[], role: Session['role'] = 'hr_admin'): Session {
  return { access_token: 'test-token', expires_at: 4102444800, username: 'tester', display_name: '测试人员', role, role_label: '测试人员', permissions: granted }
}

function Layout({ session }: { session: Session }) {
  const location = useLocation()
  return (
    <>
      <span data-testid="location">{location.pathname + location.search}</span>
      <Outlet context={{ session }} />
    </>
  )
}

/** 管理端页面通过 Outlet 的 context 取得会话。 */
export function renderPage(page: ReactElement, options: { granted?: string[]; path?: string; entry?: string } = {}) {
  const { granted = permissions.admin, path = '/', entry = path } = options
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route element={<Layout session={sessionWith(granted)} />}>
          <Route path={path} element={page} />
          <Route path="*" element={<span>已离开当前页面</span>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

export interface Call {
  method: string
  /** 不含 /api 前缀，含查询参数。 */
  path: string
  body: unknown
}

export const httpError = (status: number, detail: unknown) => Response.json({ detail }, { status })

/** 模拟后端。handler 返回普通对象时按 JSON 成功响应处理，也可以直接返回 Response。 */
export function stubApi(handler: (call: Call) => unknown) {
  const calls: Call[] = []
  /** 页面发出的、测试没有准备应答的请求；正常应为空。 */
  const unexpected: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body
    const call: Call = { method: (init?.method || 'GET').toUpperCase(), path: url.pathname.replace(/^\/api/, '') + url.search, body }
    calls.push(call)
    const result = await handler(call)
    if (result === undefined) {
      unexpected.push(`${call.method} ${call.path}`)
      return httpError(404, '测试未准备该接口')
    }
    return result instanceof Response ? result : Response.json(result)
  })
  return {
    calls,
    unexpected,
    writes: () => calls.filter(call => call.method !== 'GET'),
    requests: (method: string, pattern: RegExp | string) => calls.filter(call => call.method === method && (typeof pattern === 'string' ? call.path === pattern : pattern.test(call.path))),
  }
}

/** antd 表格会读取带伪元素的样式，jsdom 不支持，这里退回到普通读取。 */
export function quietComputedStyle() {
  const computedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element))
}

/** 文件下载：jsdom 没有 createObjectURL，也不支持点击下载链接。 */
export function stubDownloads() {
  const blobs: Blob[] = []
  const names: string[] = []
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: (blob: Blob) => { blobs.push(blob); return 'blob:test' } })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: () => undefined })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download) })
  return { blobs, names }
}

export const batch = (overrides: Record<string, unknown> = {}) => ({
  id: 1, code: 'B-2026-01', name: '第一批次', recruitment_type: '社会招聘', job_id: 11, job_name: '制造工艺岗',
  library_job_id: 'job-brew', job_audit_status: 'approved', mode: 'ai_interview', mode_label: 'AI面试 + 人工面试旁听',
  status: 'active', question_version: 1, candidate_count: 2, accepts_candidates: true, ...overrides,
})

export const hardIndicators = (overrides: Record<string, unknown> = {}) => ({
  available: true, reason: '', profile: null,
  facts: [
    { key: 'education', label: '教育经历', value: '示例大学 工业工程 本科', status: '已确认' },
    { key: 'work_experience', label: '工作经历', value: '某制造业公司 质量主管 5年', status: '已确认' },
  ],
  hard_checks: [
    { condition: '本科及以上学历', status: '满足', evidence: '示例大学 工业工程 本科', source: '关键词初核，待人工核实' },
    { condition: '持有食品检验工证书', status: '无法确认', evidence: '简历中未提及', source: '关键词初核，待人工核实' },
  ],
  matching: null, counted_in_score: false,
  notice: '硬指标依据简历档案核对，供考官综合测评参考；是否计入评分及具体规则待人力资源部确认。',
  ...overrides,
})

/** 在已展开的下拉框中选择一项（下拉框的无障碍列表里另有一份同名选项，按文字查找会重复）。 */
export async function chooseOption(text: string) {
  const option = await waitFor(() => {
    const found = Array.from(document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content'))
      .find(node => node.textContent === text)
    if (!found) throw new Error(`没有找到选项：${text}`)
    return found
  })
  fireEvent.click(option)
}

/** 当前选中的页签内容（未选中的页签内容仍留在页面中，只是隐藏）。 */
export function activePane(container: ParentNode = document) {
  const pane = container.querySelector<HTMLElement>('.ant-tabs-tabpane-active')
  if (!pane) throw new Error('没有找到当前页签')
  return within(pane)
}

/**
 * 按标题找到对话框或抽屉。测试环境中 antd 生成的元素编号都相同，打开过气泡确认框之后，
 * 按无障碍名称查找对话框会取到气泡框的文字，所以按标题文字查找。
 */
export async function findDialog(title: string | RegExp) {
  const heading = await screen.findByText(title, { selector: '.ant-modal-title, .ant-drawer-title' })
  return within(heading.closest('.ant-modal, .ant-drawer') as HTMLElement)
}
