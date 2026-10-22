import '@ant-design/v5-patch-for-react-19'
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { message } from 'antd'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSession, setSession } from '../api'
import LoginPage from '../pages/candidate/LoginPage'
import OnsiteEntryPage from '../pages/candidate/OnsiteEntryPage'
import { requestsTo, stubServer } from './stub-server'

vi.setConfig({ testTimeout: 30_000 })
configure({ asyncUtilTimeout: 10_000 })

const ENTRY_KEY = 'talentflow-onsite-entry'
const ENTRY_TOKEN = 'eyJzdWIiOiJvbnNpdGUtZW50cnk6MyJ9.c2lnbmF0dXJl-_x'
const EXPIRED = '现场入口已关闭或过期，请联系工作人员重新开启'

const people = [
  { id: 21, code: 'XZ-021', name: '候选人甲', status: 'waiting' },
  { id: 22, code: 'XZ-022', name: '候选人乙', status: 'in_progress' },
  { id: 23, code: 'XZ-023', name: '候选人丙', status: 'completed' },
  { id: 24, code: 'XZ-024', name: '候选人丁', status: 'unavailable' },
]
const list = (overrides: Record<string, unknown> = {}) => ({
  batch: { id: 2, name: '2026年校园招聘', job_name: '制造工艺员' },
  consent_attested: true, expires_at: '2026-09-28T12:00:00', candidates: people, ...overrides,
})
const candidateSession = {
  username: 'XZ-021', display_name: '候选人甲', role: 'candidate', role_label: '候选人', permissions: ['interview:use'],
  access_token: 'candidate-session-token', expires_at: 4102444800, candidate_id: 21, entry_mode: 'onsite',
}

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname}</output>
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/interview/onsite']}>
      <Where />
      <Routes>
        <Route path="/interview/onsite" element={<OnsiteEntryPage />} />
        <Route path="/interview" element={<div>候选人面试页面</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

const tile = (name: string) => screen.getByText(name, { selector: '.onsite-candidate-name' }).closest('button') as HTMLButtonElement

beforeEach(() => {
  sessionStorage.clear()
  setSession(null, 'candidate')
  window.history.replaceState(null, '', '/interview/onsite')
})
afterEach(async () => {
  await act(async () => { message.destroy() })
  vi.restoreAllMocks()
  sessionStorage.clear()
  setSession(null, 'candidate')
  window.history.replaceState(null, '', '/')
})

describe('线下集中面试现场入口', () => {
  it('工作人员打开入口后保存入口凭证，地址中不再保留凭证，并显示候选人名单', async () => {
    window.history.replaceState(null, '', `/interview/onsite#entry=${ENTRY_TOKEN}`)
    const server = stubServer({ 'GET /onsite/candidates': () => list() })
    mount()

    expect(await screen.findByText('请选择你本人')).toBeVisible()
    expect(sessionStorage.getItem(ENTRY_KEY)).toBe(ENTRY_TOKEN)
    expect(window.location.hash).toBe('')
    expect(window.location.pathname).toBe('/interview/onsite')
    expect(window.location.href).not.toContain(ENTRY_TOKEN)
    expect(screen.getByText('2026年校园招聘 · 应聘岗位：制造工艺员')).toBeVisible()
    const requests = requestsTo(server, 'GET', '/onsite/candidates')
    expect(requests).toHaveLength(1)
    expect(requests[0].headers.get('Authorization')).toBe(`Bearer ${ENTRY_TOKEN}`)

    expect(within(tile('候选人甲')).getByText('待面试')).toBeVisible()
    expect(within(tile('候选人甲')).getByText('XZ-021')).toBeVisible()
    expect(within(tile('候选人乙')).getByText('面试中')).toBeVisible()
    expect(within(tile('候选人丙')).getByText('已完成')).toBeVisible()
    expect(screen.getByText('共 4 人，待面试 1 人，面试中 1 人，已完成 1 人')).toBeVisible()
    // 已完成或没有面试安排的候选人不能选择。
    expect(tile('候选人甲')).toBeEnabled()
    expect(tile('候选人乙')).toBeEnabled()
    expect(tile('候选人丙')).toBeDisabled()
    expect(tile('候选人丁')).toBeDisabled()
    expect(screen.getByText(/工作人员已在现场说明录音和信息采集事项并取得同意。选择本人后直接进入设备检测/)).toBeVisible()
    expect(screen.getByText(/有效期至 2026-09-28/)).toBeVisible()
  })

  it('现场没有确认同意时，说明进入后需要先阅读采集须知', async () => {
    sessionStorage.setItem(ENTRY_KEY, ENTRY_TOKEN)
    stubServer({ 'GET /onsite/candidates': () => list({ consent_attested: false }) })
    mount()
    expect(await screen.findByText(/选择本人后，需要先阅读并同意录音和信息采集须知，再进入设备检测/)).toBeVisible()
    expect(screen.queryByText(/工作人员已在现场说明/)).not.toBeInTheDocument()
    fireEvent.click(tile('候选人甲'))
    expect(await screen.findByText(/确认后先阅读采集须知，再进入设备检测和面试。/)).toBeInTheDocument()
  })

  it('刷新页面后沿用已保存的入口凭证；可以按姓名或编号查找并刷新名单', async () => {
    sessionStorage.setItem(ENTRY_KEY, ENTRY_TOKEN)
    let current = people
    const server = stubServer({ 'GET /onsite/candidates': () => list({ candidates: current }) })
    mount()
    await screen.findByText('请选择你本人')
    expect(requestsTo(server, 'GET', '/onsite/candidates')[0].headers.get('Authorization')).toBe(`Bearer ${ENTRY_TOKEN}`)

    fireEvent.change(screen.getByRole('textbox', { name: '查找候选人' }), { target: { value: 'xz-022' } })
    expect(screen.queryByText('候选人甲')).not.toBeInTheDocument()
    expect(tile('候选人乙')).toBeVisible()
    fireEvent.change(screen.getByRole('textbox', { name: '查找候选人' }), { target: { value: '丙' } })
    expect(tile('候选人丙')).toBeVisible()
    expect(screen.queryByText('候选人乙')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: '查找候选人' }), { target: { value: '不存在的人' } })
    expect(screen.getByText('没有找到符合条件的候选人，请核对姓名或编号')).toBeVisible()
    fireEvent.change(screen.getByRole('textbox', { name: '查找候选人' }), { target: { value: '' } })

    current = people.map(item => item.id === 21 ? { ...item, status: 'completed' } : item)
    fireEvent.click(screen.getByRole('button', { name: /刷新名单/ }))
    await waitFor(() => expect(tile('候选人甲')).toBeDisabled())
    expect(requestsTo(server, 'GET', '/onsite/candidates')).toHaveLength(2)
  })

  it('确认本人后建立面试会话并进入面试，不需要登录', async () => {
    sessionStorage.setItem(ENTRY_KEY, ENTRY_TOKEN)
    const server = stubServer({
      'GET /onsite/candidates': () => list(),
      'POST /onsite/sessions': () => candidateSession,
    })
    mount()
    await screen.findByText('请选择你本人')
    fireEvent.click(tile('候选人甲'))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('确认你是 候选人甲（XZ-021）')).toBeInTheDocument()
    expect(within(dialog).getByText(/确认后进入设备检测，随后开始面试。/)).toBeInTheDocument()
    expect(requestsTo(server, 'POST', '/onsite/sessions')).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: /是我，开始/ }))

    expect(await screen.findByText('候选人面试页面')).toBeVisible()
    expect(screen.getByTestId('where')).toHaveTextContent('/interview')
    const requests = requestsTo(server, 'POST', '/onsite/sessions')
    expect(requests).toHaveLength(1)
    expect(requests[0].body).toEqual({ candidate_id: 21 })
    expect(requests[0].headers.get('Authorization')).toBe(`Bearer ${ENTRY_TOKEN}`)
    expect(getSession('candidate')).toMatchObject({ access_token: 'candidate-session-token', username: 'XZ-021', role: 'candidate', entry_mode: 'onsite' })
    // 入口凭证留在本设备上，下一位候选人还要使用。
    expect(sessionStorage.getItem(ENTRY_KEY)).toBe(ENTRY_TOKEN)
  })

  it('选错人时可以返回，不建立面试会话；未完成的面试可以继续', async () => {
    sessionStorage.setItem(ENTRY_KEY, ENTRY_TOKEN)
    const server = stubServer({ 'GET /onsite/candidates': () => list(), 'POST /onsite/sessions': () => ({ ...candidateSession, username: 'XZ-022', display_name: '候选人乙', candidate_id: 22 }) })
    mount()
    await screen.findByText('请选择你本人')
    fireEvent.click(tile('候选人甲'))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /不是我，返回/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(requestsTo(server, 'POST', '/onsite/sessions')).toHaveLength(0)
    expect(getSession('candidate')).toBeNull()
    expect(screen.getByTestId('where')).toHaveTextContent('/interview/onsite')

    fireEvent.click(tile('候选人乙'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('确认你是 候选人乙（XZ-022）')).toBeInTheDocument()
    expect(within(dialog).getByText(/你有一场尚未完成的面试，确认后从上次的进度继续。/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: /是我，继续面试/ }))
    expect(await screen.findByText('候选人面试页面')).toBeVisible()
    expect(requestsTo(server, 'POST', '/onsite/sessions')[0].body).toEqual({ candidate_id: 22 })
  })

  it('入口过期或被关闭（401）时清除已保存的凭证，并说明需要工作人员重新开启', async () => {
    window.history.replaceState(null, '', `/interview/onsite#entry=${ENTRY_TOKEN}`)
    const server = stubServer({ 'GET /onsite/candidates': () => Response.json({ detail: EXPIRED }, { status: 401 }) })
    mount()
    expect(await screen.findByText('现场入口已过期或已关闭')).toBeVisible()
    expect(screen.getByText(EXPIRED)).toBeVisible()
    expect(sessionStorage.getItem(ENTRY_KEY)).toBeNull()
    expect(window.location.hash).toBe('')
    expect(screen.queryByText('请选择你本人')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /刷新名单/ })).not.toBeInTheDocument()
    expect(requestsTo(server, 'GET', '/onsite/candidates')).toHaveLength(1)
  })

  it('确认本人时入口已失效（401）：不进入面试，清除凭证并说明原因', async () => {
    sessionStorage.setItem(ENTRY_KEY, ENTRY_TOKEN)
    stubServer({
      'GET /onsite/candidates': () => list(),
      'POST /onsite/sessions': () => Response.json({ detail: EXPIRED }, { status: 401 }),
    })
    mount()
    await screen.findByText('请选择你本人')
    fireEvent.click(tile('候选人甲'))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /是我，开始/ }))
    expect(await screen.findByText('现场入口已过期或已关闭')).toBeVisible()
    expect(sessionStorage.getItem(ENTRY_KEY)).toBeNull()
    expect(getSession('candidate')).toBeNull()
    expect(screen.getByTestId('where')).toHaveTextContent('/interview/onsite')
    expect(screen.queryByText('候选人甲')).not.toBeInTheDocument()
  })

  it('候选人的面试已经提交（409）时说明原因并刷新名单', async () => {
    sessionStorage.setItem(ENTRY_KEY, ENTRY_TOKEN)
    let current = people
    const server = stubServer({
      'GET /onsite/candidates': () => list({ candidates: current }),
      'POST /onsite/sessions': () => {
        current = people.map(item => item.id === 21 ? { ...item, status: 'completed' } : item)
        return Response.json({ detail: '该候选人的面试已提交，不能重新面试' }, { status: 409 })
      },
    })
    mount()
    await screen.findByText('请选择你本人')
    fireEvent.click(tile('候选人甲'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /是我，开始/ }))
    expect(await within(dialog).findByText('该候选人的面试已提交，不能重新面试')).toBeInTheDocument()
    await waitFor(() => expect(requestsTo(server, 'GET', '/onsite/candidates')).toHaveLength(2))
    // 名单刷新后该候选人已是“已完成”，不能再次确认进入。
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /是我，开始/ })).toBeDisabled())
    expect(tile('候选人甲')).toBeDisabled()
    expect(requestsTo(server, 'POST', '/onsite/sessions')).toHaveLength(1)
    expect(sessionStorage.getItem(ENTRY_KEY)).toBe(ENTRY_TOKEN)
    expect(getSession('candidate')).toBeNull()
    expect(screen.getByTestId('where')).toHaveTextContent('/interview/onsite')
  })

  it('名单暂时读取不到时可以重试，不清除入口凭证', async () => {
    sessionStorage.setItem(ENTRY_KEY, ENTRY_TOKEN)
    let fail = true
    stubServer({ 'GET /onsite/candidates': () => fail ? Response.json({ detail: '服务暂时不可用' }, { status: 503 }) : list() })
    mount()
    expect(await screen.findByText('候选人名单暂时无法读取')).toBeVisible()
    expect(sessionStorage.getItem(ENTRY_KEY)).toBe(ENTRY_TOKEN)
    fail = false
    fireEvent.click(screen.getByRole('button', { name: /重新读取/ }))
    expect(await screen.findByText('请选择你本人')).toBeVisible()
  })

  it('工作人员指定了候选人时，打开入口后直接进入该候选人的面试', async () => {
    window.history.replaceState(null, '', `/interview/onsite#entry=${ENTRY_TOKEN}&candidate=21`)
    const server = stubServer({ 'GET /onsite/candidates': () => list(), 'POST /onsite/sessions': () => candidateSession })
    mount()

    expect(await screen.findByText('候选人面试页面')).toBeVisible()
    expect(screen.getByTestId('where')).toHaveTextContent('/interview')
    const requests = requestsTo(server, 'POST', '/onsite/sessions')
    expect(requests).toHaveLength(1)
    expect(requests[0].body).toEqual({ candidate_id: 21 })
    expect(requests[0].headers.get('Authorization')).toBe(`Bearer ${ENTRY_TOKEN}`)
    expect(getSession('candidate')).toMatchObject({ username: 'XZ-021', entry_mode: 'onsite' })
    // 地址里不保留凭证；入口凭证留在本设备上，面试结束后回到名单接着面试下一位。
    expect(window.location.href).not.toContain(ENTRY_TOKEN)
    expect(sessionStorage.getItem(ENTRY_KEY)).toBe(ENTRY_TOKEN)
  })

  it('指定的候选人已经提交或不在名单中时，留在名单上并说明原因', async () => {
    window.history.replaceState(null, '', `/interview/onsite#entry=${ENTRY_TOKEN}&candidate=23`)
    const server = stubServer({ 'GET /onsite/candidates': () => list(), 'POST /onsite/sessions': () => candidateSession })
    const first = mount()
    expect(await screen.findByText('请选择你本人')).toBeVisible()
    expect(screen.getByText('候选人丙 的面试已经提交，不能重新进入。')).toBeVisible()
    expect(requestsTo(server, 'POST', '/onsite/sessions')).toHaveLength(0)
    expect(screen.getByTestId('where')).toHaveTextContent('/interview/onsite')
    // 名单照常可用。
    expect(tile('候选人甲')).toBeEnabled()
    first.unmount()

    sessionStorage.clear()
    window.history.replaceState(null, '', `/interview/onsite#entry=${ENTRY_TOKEN}&candidate=999`)
    mount()
    expect(await screen.findByText('名单中没有工作人员指定的候选人，请在名单中选择。')).toBeVisible()
    expect(requestsTo(server, 'POST', '/onsite/sessions')).toHaveLength(0)
  })

  it('直接进入未成功时留在名单上，说明原因，仍可以从名单中选择', async () => {
    window.history.replaceState(null, '', `/interview/onsite#entry=${ENTRY_TOKEN}&candidate=21`)
    let refused = true
    const server = stubServer({
      'GET /onsite/candidates': () => list(),
      'POST /onsite/sessions': () => refused ? Response.json({ detail: '该候选人没有AI面试记录' }, { status: 409 }) : candidateSession,
    })
    mount()
    expect(await screen.findByText('未能直接进入 候选人甲 的面试：该候选人没有AI面试记录')).toBeVisible()
    expect(screen.getByTestId('where')).toHaveTextContent('/interview/onsite')
    expect(getSession('candidate')).toBeNull()
    refused = false
    fireEvent.click(tile('候选人甲'))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /是我，开始/ }))
    expect(await screen.findByText('候选人面试页面')).toBeVisible()
    expect(requestsTo(server, 'POST', '/onsite/sessions')).toHaveLength(2)
  })

  it('没有入口凭证时说明需要工作人员开启，不请求名单', async () => {
    const server = stubServer({ 'GET /onsite/candidates': () => list() })
    mount()
    expect(await screen.findByText('请由工作人员开启现场入口')).toBeVisible()
    expect(server).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /使用账号密码登录/ }))
    expect(await screen.findByText('候选人面试页面')).toBeVisible()
  })
})

describe('应聘者账号登录页', () => {
  const renderLogin = (onLogin = vi.fn(), path = '/interview', props: Partial<Parameters<typeof LoginPage>[0]> = {}) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <Where />
        <Routes>
          <Route path="/interview" element={<LoginPage onLogin={onLogin} {...props} />} />
          <Route path="/interview/onsite" element={<div>现场入口页面</div>} />
        </Routes>
      </MemoryRouter>,
    )
    return onLogin
  }
  const submit = (username: string, password: string) => {
    fireEvent.change(screen.getByPlaceholderText('请输入账号'), { target: { value: username } })
    fireEvent.change(screen.getByPlaceholderText('请输入密码'), { target: { value: password } })
    fireEvent.click(screen.getByRole('button', { name: /登录/ }))
  }

  it('账号密码登录方式保留：登录成功后进入面试', async () => {
    const account = { ...candidateSession, entry_mode: undefined, access_token: 'account-token' }
    const server = stubServer({ 'POST /auth/login': () => account })
    const onLogin = renderLogin()
    expect(screen.getByText('登录参加面试')).toBeVisible()
    submit('XZ-021', 'Abcd@2345xyz')
    await waitFor(() => expect(onLogin).toHaveBeenCalledOnce())
    expect(requestsTo(server, 'POST', '/auth/login')[0].body).toEqual({ username: 'XZ-021', password: 'Abcd@2345xyz' })
    expect(getSession('candidate')?.access_token).toBe('account-token')
    expect(screen.queryByText('账号已临时锁定')).not.toBeInTheDocument()
  })

  it('连续输错密码被临时锁定（423）时，锁定说明保留在页面上', async () => {
    const locked = '密码连续输错次数过多，账号已临时锁定，请约 10 分钟后再试或联系工作人员重置密码'
    let status = 423
    stubServer({ 'POST /auth/login': () => status === 423 ? Response.json({ detail: locked }, { status }) : Response.json({ detail: '账号或密码错误' }, { status }) })
    const onLogin = renderLogin()
    submit('XZ-021', 'wrong-password')
    expect(await screen.findByText('账号已临时锁定')).toBeVisible()
    expect(screen.getByText(locked)).toBeVisible()
    expect(onLogin).not.toHaveBeenCalled()
    expect(getSession('candidate')).toBeNull()
    // 其他登录错误不显示锁定说明。
    status = 401
    fireEvent.click(screen.getByRole('button', { name: /登录/ }))
    expect(await screen.findByText('账号或密码错误')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('账号已临时锁定')).not.toBeInTheDocument())
  })

  it('本设备开启过现场入口时才显示“返回现场面试名单”', async () => {
    const first = render(<MemoryRouter><LoginPage onLogin={vi.fn()} /></MemoryRouter>)
    expect(screen.getByText('登录参加面试')).toBeVisible()
    expect(screen.queryByText('返回现场面试名单')).not.toBeInTheDocument()
    first.unmount()

    sessionStorage.setItem(ENTRY_KEY, ENTRY_TOKEN)
    renderLogin()
    fireEvent.click(screen.getByRole('link', { name: '返回现场面试名单' }))
    expect(await screen.findByText('现场入口页面')).toBeVisible()
    expect(screen.getByTestId('where')).toHaveTextContent('/interview/onsite')
  })

  it('工作人员带着账号打开登录页时，账号已经填好，地址里没有密码', async () => {
    const account = { ...candidateSession, entry_mode: undefined, access_token: 'account-token' }
    const server = stubServer({ 'POST /auth/login': () => account })
    const onLogin = renderLogin(vi.fn(), '/interview?login=1&account=XZ-021')
    expect(screen.getByPlaceholderText('请输入账号')).toHaveValue('XZ-021')
    expect(screen.getByPlaceholderText('请输入密码')).toHaveValue('')
    expect(screen.queryByText(/这台设备上已登录/)).not.toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('请输入密码'), { target: { value: 'Abcd@2345xyz' } })
    fireEvent.click(screen.getByRole('button', { name: /登录/ }))
    await waitFor(() => expect(onLogin).toHaveBeenCalledOnce())
    expect(requestsTo(server, 'POST', '/auth/login')[0].body).toEqual({ username: 'XZ-021', password: 'Abcd@2345xyz' })
  })

  it('这台设备上已有候选人登录时，可以继续该候选人的面试，也可以换账号登录', async () => {
    const current = { ...candidateSession, username: 'XZ-022', display_name: '候选人乙', candidate_id: 22 }
    const onContinue = vi.fn()
    renderLogin(vi.fn(), '/interview?login=1', { current: current as never, onContinue })
    expect(screen.getByText('这台设备上已登录：候选人乙（XZ-022）')).toBeVisible()
    expect(screen.getByPlaceholderText('请输入账号')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '继续该候选人的面试' }))
    expect(onContinue).toHaveBeenCalledOnce()
  })
})
