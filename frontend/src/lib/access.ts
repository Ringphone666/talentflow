import { useOutletContext } from 'react-router-dom'
import type { Session } from '../types'

/** 权限由后端随会话下发；页面只据此决定显示哪些入口，真正的校验在后端。 */
export function can(session: Pick<Session, 'permissions'> | null | undefined, permission: string): boolean {
  const granted = session?.permissions || []
  return granted.includes('*') || granted.includes(permission)
}

export function canAny(session: Pick<Session, 'permissions'> | null | undefined, ...permissions: string[]): boolean {
  return permissions.some(permission => can(session, permission))
}

/** 管理端页面取得当前会话。 */
export function useAdminSession(): Session {
  return useOutletContext<{ session: Session }>().session
}
