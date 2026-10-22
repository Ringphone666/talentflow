import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CandidatesPage from '../pages/interview/CandidatesPage'
import { credentialsCsv } from '../pages/interview/CredentialsModal'
import { batch, chooseOption, findDialog, httpError, permissions, quietComputedStyle, renderPage, stubApi, stubDownloads, type Call } from './interview-helpers'

const candidate = (overrides: Record<string, unknown> = {}) => ({
  id: 1, code: 'B-2026-01-001', name: '已有候选人', profile: {}, batch_id: 1, batch_name: '第一批次', batch_mode: 'ai_interview',
  job_id: 11, job_name: '制造工艺岗', library_person_id: null, interview_status: 'consent_pending', entry_mode: 'account',
  report_status: 'not_generated', listening_status: 'not_started',
  resume: { uploaded: false, original_name: '', ocr_status: 'not_requested', source: 'candidate', library_person_id: null, text_preview: '' },
  login_username: 'B-2026-01-001', has_login: true, password_set_at: '2026-09-27T01:00:00', login_locked: false, ...overrides,
})
const listeningBatch = batch({ id: 2, code: 'B-LISTEN', name: '旁听批次', mode: 'listening_only', mode_label: '仅人工面试旁听', question_version: 0 })
const PASSWORD = 'Xk7#mPq2$Lw9'

let list: Array<ReturnType<typeof candidate>>
let batches: Array<ReturnType<typeof batch>>

function backend(extra?: (call: Call) => unknown) {
  return stubApi(call => {
    const custom = extra?.(call)
    if (custom !== undefined) return custom
    if (call.method !== 'GET') return undefined
    if (call.path === '/batches') return batches
    if (call.path === '/candidates') return structuredClone(list)
    const filtered = call.path.match(/^\/candidates\?batch_id=(\d+)$/)
    if (filtered) return structuredClone(list.filter(item => item.batch_id === Number(filtered[1])))
    return undefined
  })
}

const created = (overrides: Record<string, unknown> = {}) => ({
  ...candidate({ id: 2, code: 'B-2026-01-002', name: '新候选人', login_username: 'B-2026-01-002' }),
  credentials: { candidate_id: 2, name: '新候选人', username: 'B-2026-01-002', password: PASSWORD },
  ...overrides,
})

async function openCreateForm(batchName = '第一批次 · 制造工艺岗') {
  renderPage(<CandidatesPage />, { granted: permissions.hr })
  await screen.findByText('已有候选人')
  fireEvent.click(screen.getByRole('button', { name: /新增候选人/ }))
  const form = await findDialog('新增候选人')
  fireEvent.change(form.getByLabelText('候选人姓名'), { target: { value: '新候选人' } })
  fireEvent.mouseDown(form.getByLabelText('招聘批次'))
  await chooseOption(batchName)
  return form
}

beforeEach(() => {
  quietComputedStyle()
  list = [candidate()]
  batches = [batch(), listeningBatch]
})
afterEach(() => vi.restoreAllMocks())

describe('新增候选人与登录凭据', () => {
  it('不再填写密码；随机密码只显示一次，可复制和下载，关闭后不再出现也不再请求', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const downloads = stubDownloads()
    const api = backend(call => {
      if (call.method !== 'POST' || call.path !== '/candidates') return undefined
      list = [candidate({ id: 2, code: 'B-2026-01-002', name: '新候选人', login_username: 'B-2026-01-002' }), ...list]
      return created()
    })
    const form = await openCreateForm()
    // 不再由工作人员设置密码：表单里没有密码输入框。
    expect(form.queryByLabelText(/初始密码/)).not.toBeInTheDocument()
    expect(document.querySelector('.ant-modal input[type="password"]')).toBeNull()
    expect(form.getByLabelText('候选人编号')).toHaveValue('')
    fireEvent.click(form.getByRole('button', { name: /添\s*加/ }))

    const dialog = await findDialog('候选人已添加，请保存登录凭据')
    expect(api.requests('POST', '/candidates')[0].body).toEqual({ name: '新候选人', batch_id: 1, code: '', profile: {}, create_login: true })
    expect(dialog.getByText('密码只显示这一次，之后无法再次查看')).toBeInTheDocument()
    expect(dialog.getByText(/如遗失，只能在候选人列表中“重置密码”重新生成/)).toBeInTheDocument()
    expect(dialog.getByText('B-2026-01-002')).toBeInTheDocument()
    expect(dialog.getByText(PASSWORD)).toBeInTheDocument()

    fireEvent.click(dialog.getByRole('button', { name: /复\s*制/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText.mock.calls[0][0]).toContain(`密码：${PASSWORD}`)
    fireEvent.click(dialog.getByRole('button', { name: /下载本次凭据 \(CSV\)/ }))
    expect(downloads.names[0]).toMatch(/^候选人登录凭据_新候选人_\d{8}-\d{4}\.csv$/)
    expect(downloads.blobs[0].type).toContain('text/csv')

    fireEvent.click(dialog.getByRole('button', { name: '已保存，关闭' }))
    await waitFor(() => expect(screen.queryByText(PASSWORD)).not.toBeInTheDocument())
    expect(await screen.findByText('新候选人')).toBeInTheDocument()
    expect(screen.queryByText(/密码：/)).not.toBeInTheDocument()
    expect(api.writes()).toHaveLength(1)
    expect(api.calls.some(call => /password|credential/.test(call.path))).toBe(false)
    expect(api.unexpected).toEqual([])
  })

  it('凭据文件带 BOM，容易被表格软件误读的内容按文本写入', () => {
    const csv = credentialsCsv([
      { candidate_id: 1, name: '张三', username: '2026-04-001', password: '=Ab3$xyz9Qw+' },
      { candidate_id: 2, name: '李四', username: 'B-2026-01-002', password: PASSWORD },
    ], 'http://hr.example/interview')
    const lines = csv.split('\r\n')
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(lines[0].slice(1)).toBe('姓名,登录账号,密码,登录地址')
    expect(lines[1]).toBe('张三,"=""2026-04-001""","=""=Ab3$xyz9Qw+""",http://hr.example/interview')
    expect(lines[2]).toBe(`李四,B-2026-01-002,${PASSWORD},http://hr.example/interview`)
  })

  it('服务端编号冲突时保留输入并持续显示错误，修改后可重试成功', async () => {
    let attempts = 0
    const api = backend(call => {
      if (call.method !== 'POST') return undefined
      return ++attempts === 1 ? httpError(409, '候选人编号 B-2026-01-001 已存在') : created({ credentials: null })
    })
    const form = await openCreateForm()
    fireEvent.change(form.getByLabelText('候选人编号'), { target: { value: 'B-2026-01-001' } })
    fireEvent.click(form.getByRole('button', { name: /添\s*加/ }))
    expect(await form.findByText('添加未完成')).toBeInTheDocument()
    expect(form.getByText('候选人编号 B-2026-01-001 已存在')).toBeInTheDocument()
    expect(form.getByLabelText('候选人姓名')).toHaveValue('新候选人')
    fireEvent.change(form.getByLabelText('候选人编号'), { target: { value: 'B-2026-01-009' } })
    fireEvent.click(form.getByRole('button', { name: /添\s*加/ }))
    await waitFor(() => expect(api.requests('POST', '/candidates')).toHaveLength(2))
    expect(api.requests('POST', '/candidates')[1].body).toMatchObject({ code: 'B-2026-01-009', name: '新候选人' })
    await waitFor(() => expect(screen.queryByText('添加未完成')).not.toBeInTheDocument())
  })

  it('连续点击只提交一次，等待期间显示加载状态', async () => {
    let finish!: (value: unknown) => void
    const pending = new Promise(resolve => { finish = resolve })
    const api = backend(call => call.method === 'POST' ? pending : undefined)
    const form = await openCreateForm()
    const submit = form.getByRole('button', { name: /添\s*加/ })
    fireEvent.click(submit)
    fireEvent.click(submit)
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(submit).toHaveClass('ant-btn-loading')
    fireEvent.click(submit)
    await act(async () => { finish(created()); await pending })
    expect(await screen.findByText('候选人已添加，请保存登录凭据')).toBeInTheDocument()
    expect(api.writes()).toHaveLength(1)
  })

  it('仅人工面试旁听的批次不生成登录凭据，列表中也没有登录操作', async () => {
    list = [candidate(), candidate({ id: 5, code: 'B-LISTEN-001', name: '旁听候选人', batch_id: 2, batch_name: '旁听批次', batch_mode: 'listening_only', interview_status: 'not_required', login_username: '', has_login: false })]
    const api = backend(call => call.method === 'POST' ? created({ id: 6, name: '新候选人', batch_mode: 'listening_only', credentials: null }) : undefined)
    const form = await openCreateForm('旁听批次 · 制造工艺岗（仅人工面试旁听）')
    expect(await form.findByText('该批次仅做人工面试旁听，候选人无需登录，不生成登录凭据。')).toBeInTheDocument()
    expect(form.queryByRole('checkbox', { name: '生成登录账号和密码' })).not.toBeInTheDocument()
    fireEvent.click(form.getByRole('button', { name: /添\s*加/ }))
    await waitFor(() => expect(api.requests('POST', '/candidates')).toHaveLength(1))
    expect(api.requests('POST', '/candidates')[0].body).toEqual({ name: '新候选人', batch_id: 2, code: '', profile: {} })
    await waitFor(() => expect(screen.queryByText('新增候选人', { selector: '.ant-modal-title' })).not.toBeInTheDocument())
    expect(screen.queryByText(/请保存登录凭据/)).not.toBeInTheDocument()

    const row = within(screen.getByText('旁听候选人').closest('tr') as HTMLElement)
    expect(row.getByText('无需登录')).toBeInTheDocument()
    expect(row.getByText('不做AI面试')).toBeInTheDocument()
    expect(row.queryByRole('button', { name: /重置密码|生成凭据/ })).not.toBeInTheDocument()
    expect(within(screen.getByText('已有候选人').closest('tr') as HTMLElement).getByRole('button', { name: /重置密码/ })).toBeInTheDocument()
  })

  it('重置密码需确认，新密码同样只显示一次；未保存就关闭时再次提醒', async () => {
    const api = backend(call => call.method === 'POST' && call.path === '/candidates/1/password'
      ? { credentials: { candidate_id: 1, name: '已有候选人', username: 'B-2026-01-001', password: PASSWORD } } : undefined)
    renderPage(<CandidatesPage />, { granted: permissions.hr })
    fireEvent.click(await screen.findByRole('button', { name: /重置密码/ }))
    expect(await screen.findByText('原密码立即失效；新密码只显示一次，请及时交给候选人。')).toBeInTheDocument()
    expect(api.writes()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '确认重置' }))
    const dialog = await findDialog('密码已重置，原密码立即失效')
    expect(dialog.getByText(PASSWORD)).toBeInTheDocument()
    expect(api.requests('POST', '/candidates/1/password')).toHaveLength(1)

    fireEvent.click(dialog.getByRole('button', { name: '已保存，关闭' }))
    expect(await screen.findByText('尚未复制或下载')).toBeInTheDocument()
    expect(dialog.getByText(PASSWORD)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认关闭' }))
    await waitFor(() => expect(screen.queryByText(PASSWORD)).not.toBeInTheDocument())
    expect(api.writes()).toHaveLength(1)
  })
})

describe('从人员库选择', () => {
  const persons = [
    { id: 'p-1', name: '张三', source_filename: '张三.pdf', status: '已解析', confirmed: true, education: '示例大学 本科', work_experience: '某制造业 质量主管' },
    { id: 'p-2', name: '李四', source_filename: '李四.docx', status: '已解析', confirmed: false, education: '四川大学 硕士', work_experience: '某集团 工艺工程师' },
    { id: 'p-3', name: '王五', source_filename: '王五.pdf', status: '解析失败', confirmed: false, education: '', work_experience: '' },
    { id: 'p-4', name: '赵六', source_filename: '赵六.pdf', status: '已解析', confirmed: true, education: '江南大学 本科', work_experience: '某制造企业 班组长' },
  ]

  it('只能选择已解析且不在本批次的人员，加入后列出全部新凭据和被跳过的人员', async () => {
    list = [candidate(), candidate({ id: 3, name: '赵六', code: 'B-2026-01-003', library_person_id: 'p-4' })]
    const api = backend(call => {
      if (call.path === '/library/person-batches') return [{ id: 'pb-1', name: '2026社招简历', category: '社招', total_count: 4, parsed_count: 3, failed_count: 1, pending_count: 0 }]
      if (call.path === '/library/person-batches/pb-1') return { id: 'pb-1', name: '2026社招简历', persons }
      if (call.method === 'POST' && call.path === '/candidates/import') {
        return {
          created: 2,
          skipped: [{ person_id: 'p-9', name: '钱七', reason: '已在本批次中' }],
          credentials: [
            { candidate_id: 7, name: '张三', username: 'B-2026-01-004', password: PASSWORD },
            { candidate_id: 8, name: '李四', username: 'B-2026-01-005', password: 'Qw8%rTy3&Zp5' },
          ],
          candidates: [],
        }
      }
      return undefined
    })
    renderPage(<CandidatesPage />, { granted: permissions.hr, entry: '/?batch=1' })
    await screen.findByText('已有候选人')
    fireEvent.click(screen.getByRole('button', { name: /从人员库选择/ }))
    const picker = await findDialog('从人员库选择')
    expect(picker.getByRole('button', { name: '加入批次' })).toBeDisabled()
    fireEvent.mouseDown(picker.getByRole('combobox', { name: '人员库批次' }))
    await chooseOption('2026社招简历 · 社招 · 已解析 3/4 人')
    expect(await picker.findByText('张三')).toBeInTheDocument()
    expect(picker.getByText('解析失败')).toBeInTheDocument()
    expect(picker.getByText('已在本批次')).toBeInTheDocument()
    expect(picker.getByRole('checkbox', { name: '选择 王五' })).toBeDisabled()
    expect(picker.getByRole('checkbox', { name: '选择 赵六' })).toBeDisabled()
    fireEvent.click(picker.getByRole('checkbox', { name: '选择 张三' }))
    fireEvent.click(picker.getByRole('checkbox', { name: '选择 李四' }))
    fireEvent.click(await picker.findByRole('button', { name: '加入批次（2 人）' }))

    const dialog = await findDialog('已添加 2 人，请保存登录凭据')
    expect(api.requests('POST', '/candidates/import')[0].body).toEqual({ batch_id: 1, person_ids: ['p-1', 'p-2'], create_login: true })
    for (const text of ['B-2026-01-004', PASSWORD, 'B-2026-01-005', 'Qw8%rTy3&Zp5', '已添加 2 人，跳过 1 人', '钱七：已在本批次中']) {
      expect(dialog.getByText(text)).toBeInTheDocument()
    }
    expect(dialog.getByRole('button', { name: /复制全部/ })).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: /下载本次凭据 \(CSV\)/ })).toBeInTheDocument()
    expect(api.unexpected).toEqual([])
  })
})

describe('简历', () => {
  it('含扫描页时须确认授权后重新提交；解析完成后显示人员库档案', async () => {
    let uploads = 0
    const api = backend(call => {
      if (call.method !== 'POST' || call.path !== '/candidates/1/resume') return undefined
      if (++uploads === 1) return httpError(409, { message: '简历包含扫描页，需确认已获识别服务处理授权后才能上传', scans: [{ file: '简历.pdf', pages: [2, 3], page_count: 3, text_pages: 1, blank_pages: 0 }] })
      list = [candidate({ library_person_id: 'p-77', resume: { uploaded: true, original_name: '简历.pdf', ocr_status: 'completed', source: 'library', library_person_id: 'p-77', text_preview: '2019年起在某制造业公司负责质量管理' } })]
      return { id: 'op-1', kind: 'candidate_resume', label: '解析简历', status: 'completed', progress: '', error: '', result: { status: 'completed', message: '', library_person_id: 'p-77' } }
    })
    renderPage(<CandidatesPage />, { granted: permissions.hr })
    const row = (await screen.findByText('已有候选人')).closest('tr') as HTMLElement
    expect(within(row).getByText('未关联简历')).toBeInTheDocument()
    const file = new File(['%PDF-1.4 test'], '简历.pdf', { type: 'application/pdf' })
    fireEvent.change(row.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } })

    const dialog = await findDialog('简历包含扫描页，需要文字识别')
    expect(dialog.getByText('简历.pdf：第 2、3 页需要识别（共 3 页）')).toBeInTheDocument()
    expect((api.requests('POST', '/candidates/1/resume')[0].body as FormData).get('allow_ocr')).toBeNull()
    fireEvent.click(dialog.getByRole('button', { name: '已获授权，继续上传' }))

    await waitFor(() => expect(api.requests('POST', '/candidates/1/resume')).toHaveLength(2))
    const second = api.requests('POST', '/candidates/1/resume')[1].body as FormData
    expect(second.get('allow_ocr')).toBe('true')
    expect((second.get('file') as File).name).toBe('简历.pdf')
    const updated = within((await screen.findByText('简历.pdf')).closest('tr') as HTMLElement)
    expect(updated.getByText('已解析')).toBeInTheDocument()
    expect(updated.getByRole('link', { name: '人员库档案' })).toHaveAttribute('href', '/library/persons?person=p-77')
    expect(updated.getByRole('button', { name: /替换简历/ })).toBeInTheDocument()
    fireEvent.click(updated.getByRole('button', { name: '文字摘录' }))
    expect(await updated.findByText('2019年起在某制造业公司负责质量管理')).toHaveClass('evidence-quote')
  })
})

describe('筛选与权限', () => {
  it('批次筛选来自地址栏并用于查询', async () => {
    list = [candidate(), candidate({ id: 5, name: '旁听候选人', batch_id: 2, batch_mode: 'listening_only', interview_status: 'not_required', has_login: false })]
    const api = backend()
    renderPage(<CandidatesPage />, { granted: permissions.hr, entry: '/?batch=2' })
    expect(await screen.findByText('旁听候选人')).toBeInTheDocument()
    expect(screen.queryByText('已有候选人')).not.toBeInTheDocument()
    expect(api.requests('GET', '/candidates?batch_id=2')).toHaveLength(1)
    expect(api.requests('GET', '/candidates')).toHaveLength(0)
  })

  it('只有查看权限时不显示新增、导入、上传、重置密码、编辑和删除', async () => {
    list = [candidate({ resume: { uploaded: true, original_name: '简历.pdf', ocr_status: 'completed', source: 'library', library_person_id: 'p-1', text_preview: '' } })]
    backend()
    renderPage(<CandidatesPage />, { granted: ['candidate:read', 'report:read'] })
    const row = within((await screen.findByText('已有候选人')).closest('tr') as HTMLElement)
    expect(row.getByRole('button', { name: /查\s*看/ })).toBeInTheDocument()
    for (const hidden of [/新增候选人/, /从人员库选择/, /上传简历|替换简历/, /移除关联/, /重置密码/, /编辑/, /删除/]) {
      expect(screen.queryByRole('button', { name: hidden })).not.toBeInTheDocument()
    }
    expect(screen.queryByRole('link', { name: '人员库档案' })).not.toBeInTheDocument()
    expect(document.querySelector('input[type="file"]')).toBeNull()
  })
})

describe('现场面试', () => {
  const ENTRY = { id: 7, batch_id: 1, entry_token: 'entry-token.signature', expires_at: '2026-09-29T20:00:00', consent_attested: true, reused: false }
  const opened = () => {
    const tab = { opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() }
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
    return tab
  }

  it('对候选人点“现场面试”：确认已现场告知后，在新窗口直接进入该候选人的面试', async () => {
    const api = backend(call => call.method === 'POST' && call.path === '/batches/1/onsite-entries' ? ENTRY : undefined)
    const tab = opened()
    renderPage(<CandidatesPage />, { granted: permissions.hr })
    const row = within((await screen.findByText('已有候选人')).closest('tr') as HTMLElement)
    fireEvent.click(row.getByRole('button', { name: /现场面试/ }))
    const dialog = await findDialog('现场面试 · 已有候选人（B-2026-01-001）')
    expect(dialog.getByText(/不需要账号密码，不填写个人信息，从设备检测开始/)).toBeInTheDocument()
    expect(dialog.getByText(/不勾选时，候选人进入后先在屏幕上阅读并同意合规须知/)).toBeInTheDocument()
    fireEvent.click(dialog.getByRole('checkbox'))
    expect(dialog.getByText(/这项确认会记录在您的名下/)).toBeInTheDocument()
    fireEvent.click(dialog.getByRole('button', { name: '进入现场面试' }))

    await waitFor(() => expect(tab.location.replace).toHaveBeenCalledOnce())
    // 沿用已开启的入口；凭证放在地址的 # 之后，并带上候选人编号。
    expect(api.requests('POST', '/batches/1/onsite-entries')[0].body).toEqual({ consent_attested: true, hours: 8, reuse: true })
    expect(tab.location.replace).toHaveBeenCalledWith(`${window.location.origin}/interview/onsite#entry=entry-token.signature&candidate=1`)
    expect(tab.opener).toBeNull()
    await waitFor(() => expect(screen.queryByText('现场面试 · 已有候选人（B-2026-01-001）')).not.toBeInTheDocument())
  })

  it('选中批次后可以打开该批次的现场面试名单；没有选批次时按钮不可用', async () => {
    const api = backend(call => call.method === 'POST' && call.path === '/batches/1/onsite-entries' ? { ...ENTRY, consent_attested: false, reused: true } : undefined)
    const tab = opened()
    const first = renderPage(<CandidatesPage />, { granted: permissions.hr })
    await screen.findByText('已有候选人')
    expect(screen.getByRole('button', { name: /现场面试名单/ })).toBeDisabled()
    first.unmount()

    renderPage(<CandidatesPage />, { granted: permissions.hr, entry: '/?batch=1' })
    await screen.findByText('已有候选人')
    fireEvent.click(screen.getByRole('button', { name: /现场面试名单/ }))
    const dialog = await findDialog('现场面试 · 第一批次')
    fireEvent.click(dialog.getByRole('button', { name: '进入现场面试' }))
    await waitFor(() => expect(tab.location.replace).toHaveBeenCalledOnce())
    expect(api.requests('POST', '/batches/1/onsite-entries')[0].body).toEqual({ consent_attested: false, hours: 8, reuse: true })
    expect(tab.location.replace).toHaveBeenCalledWith(`${window.location.origin}/interview/onsite#entry=entry-token.signature`)
  })

  it('浏览器拦截新窗口时给出可以点击的链接；入口打不开时说明原因', async () => {
    let refuse = true
    backend(call => {
      if (call.method !== 'POST' || call.path !== '/batches/1/onsite-entries') return undefined
      return refuse ? httpError(409, '批次尚未发布题目，不能开启现场入口') : ENTRY
    })
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderPage(<CandidatesPage />, { granted: permissions.hr })
    const row = within((await screen.findByText('已有候选人')).closest('tr') as HTMLElement)
    fireEvent.click(row.getByRole('button', { name: /现场面试/ }))
    const dialog = await findDialog('现场面试 · 已有候选人（B-2026-01-001）')
    fireEvent.click(dialog.getByRole('button', { name: '进入现场面试' }))
    expect(await dialog.findByText('批次尚未发布题目，不能开启现场入口')).toBeInTheDocument()

    refuse = false
    fireEvent.click(dialog.getByRole('button', { name: '进入现场面试' }))
    expect(await dialog.findByText('浏览器拦截了新窗口')).toBeInTheDocument()
    expect(dialog.getByRole('link', { name: '打开现场面试' })).toHaveAttribute('href', `${window.location.origin}/interview/onsite#entry=entry-token.signature&candidate=1`)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('面试已提交、仅旁听的候选人，以及没有现场面试权限的人，看不到“现场面试”', async () => {
    list = [
      candidate({ id: 3, name: '已提交的候选人', interview_status: 'completed' }),
      candidate({ id: 5, name: '旁听候选人', batch_id: 2, batch_mode: 'listening_only', interview_status: 'not_required', has_login: false }),
    ]
    backend()
    const first = renderPage(<CandidatesPage />, { granted: permissions.hr })
    await screen.findByText('已提交的候选人')
    expect(screen.queryByRole('button', { name: /^现场面试$/ })).not.toBeInTheDocument()
    first.unmount()

    list = [candidate()]
    renderPage(<CandidatesPage />, { granted: permissions.hr.filter(item => item !== 'onsite:manage') })
    await screen.findByText('已有候选人')
    expect(screen.queryByRole('button', { name: /现场面试/ })).not.toBeInTheDocument()
  })
})
