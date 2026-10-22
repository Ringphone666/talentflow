import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, download, openFile, setSession, uploadFile } from '../api'
import { formatConnectionError, formatResponseError } from '../requestErrors'

describe('可读的操作失败提示', () => {
  it('保留后端中文业务原因，包括登录和人工复核要求', () => {
    expect(formatResponseError(401, { detail: '账号或密码错误' })).toBe('账号或密码错误')
    expect(formatResponseError(409, { detail: '未经人工确认的报告不得导出' })).toBe('未经人工确认的报告不得导出')
    expect(formatResponseError(422, { detail: { message: '请至少选择一名候选人' } })).toBe('请至少选择一名候选人')
  })

  it('将后端字段校验转换为中文字段和修正要求，不回显提交数据', () => {
    const message = formatResponseError(422, { detail: [
      { type: 'string_too_short', loc: ['body', 'initial_password'], msg: 'String should have at least 8 characters', input: 'secret', ctx: { min_length: 8 } },
      { type: 'missing', loc: ['body', 'competency_model', 0, 'dimension'], msg: 'Field required', input: { internal: 'raw' } },
      { type: 'greater_than_equal', loc: ['body', 'time_limit'], msg: 'Input should be greater than or equal to 30', input: 2, ctx: { ge: 30 } },
    ] })
    expect(message).toBe('初始密码：至少填写 8 个字符；胜任力标准 · 第 1 项 · 评价维度：不能为空；回答时限：不能小于 30')
    expect(message).not.toMatch(/secret|initial_password|raw|Field required/)
  })

  it('未知字段和英文校验不暴露内部属性名', () => {
    expect(formatResponseError(422, { detail: [
      { type: 'custom_validator', loc: ['body', 'internal_secret'], msg: 'Unsafe internal error', input: 'private' },
    ] })).toBe('填写内容：填写格式不正确，请检查后重试')
  })

  it.each([
    { detail: { traceback: 'private-stack', input: 'private-content' } },
    { detail: ['private-content'] },
    { detail: 'Internal Server Error' },
    { detail: '调用失败：Traceback (most recent call last)' },
    { detail: '调用失败：ValueError (private data)' },
    { detail: '{"内部信息":"private"}' },
    null,
  ])('未知服务错误只显示可操作提示', body => {
    expect(formatResponseError(500, body)).toBe('服务暂时无法完成操作，请稍后重试；如仍失败，请联系管理员')
  })

  it('将权限标识与网络错误改为中文提示', () => {
    expect(formatResponseError(403, { detail: '当前角色无权限执行：job:edit' })).toBe('当前账号无权执行此操作，请联系管理员调整权限')
    expect(formatConnectionError(new TypeError('Failed to fetch'))).toBe('无法连接服务，请检查网络后重试；如仍失败，请联系管理员')
    expect(formatConnectionError(new DOMException('The operation was aborted', 'AbortError'))).toBe('操作已取消，请重新操作')
  })
})

describe('全部请求入口的失败处理', () => {
  const fetchMock = vi.fn<typeof fetch>()
  const previewClose = vi.fn()
  const entryPoints = [
    { name: '普通请求', invoke: () => api('/jobs') },
    { name: '上传文件', invoke: () => uploadFile('/jobs/1/materials', new File(['PDF'], '岗位.pdf', { type: 'application/pdf' })) },
    { name: '下载报告', invoke: () => download('/reports/1/export') },
    { name: '预览文件', invoke: () => openFile('/candidates/1/resume') },
  ]

  beforeEach(() => {
    fetchMock.mockReset()
    previewClose.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'open').mockReturnValue({ close: previewClose, location: { href: '' } } as unknown as Window)
    setSession(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    setSession(null)
  })

  it.each(entryPoints)('$name：网络中断仍然拒绝请求，给出中文原因', async ({ name, invoke }) => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(invoke()).rejects.toThrow('无法连接服务，请检查网络后重试')
    if (name === '预览文件') expect(previewClose).toHaveBeenCalledOnce()
  })

  it.each(entryPoints)('$name：代理返回非数据错误页时不显示解析异常', async ({ name, invoke }) => {
    fetchMock.mockResolvedValue(new Response('<html>Bad gateway: private data</html>', { status: 502 }))
    await expect(invoke()).rejects.toThrow('服务暂时无法完成操作，请稍后重试')
    if (name === '预览文件') expect(previewClose).toHaveBeenCalledOnce()
  })

  it.each(entryPoints)('$name：保留业务失败原因', async ({ invoke }) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ detail: '岗位不存在' }), { status: 404 }))
    await expect(invoke()).rejects.toThrow('岗位不存在')
  })

  it('返回结果无法解析时提示先刷新核对，不声称保存成功', async () => {
    fetchMock.mockResolvedValue(new Response('<html>Unexpected response</html>', { status: 200 }))
    await expect(api('/jobs', { method: 'POST', body: '{}' })).rejects.toThrow('未能读取处理结果，请刷新查看')
  })

  it('正常请求继续携带原认证信息，原样返回数据', async () => {
    setSession({
      access_token: 'test-session-token', expires_at: Math.floor(Date.now() / 1000) + 3600,
      username: 'test-user', display_name: '测试人员', role: 'hr_admin', role_label: 'HR管理员', permissions: [],
    })
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 7, name: '生产岗位' }), { status: 200 }))
    await expect(api('/jobs/7')).resolves.toEqual({ id: 7, name: '生产岗位' })
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/jobs/7'), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer test-session-token', 'Content-Type': 'application/json' }),
    }))
  })
})
