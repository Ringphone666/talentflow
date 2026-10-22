import { vi } from 'vitest'

type Handler = (body: Record<string, unknown>, url: URL) => unknown

/**
 * 按“方法 路径”模拟后端接口；未提供的接口返回 404，避免测试悄悄通过。
 * 路径不带 /api 前缀，如 'GET /listening/21'。
 */
export function stubServer(routes: Record<string, Handler>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    const url = new URL(String(input))
    const path = url.pathname.replace(/^\/api/, '')
    const key = `${options?.method || 'GET'} ${path}`
    const handler = routes[key]
    if (!handler) return Response.json({ detail: `测试未提供接口 ${key}` }, { status: 404 })
    const result = handler(options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : {}, url)
    return result instanceof Response ? result : Response.json(result)
  })
}

export type ServerMock = ReturnType<typeof stubServer>

/** 某个接口收到的请求（方法 + 路径），返回每次请求的内容。 */
export function requestsTo(server: ServerMock, method: string, path: string) {
  return server.mock.calls
    .filter(([input, options]) => (options?.method || 'GET') === method && new URL(String(input)).pathname === `/api${path}`)
    .map(([input, options]) => ({
      url: new URL(String(input)),
      body: options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : undefined,
      headers: new Headers(options?.headers),
    }))
}
