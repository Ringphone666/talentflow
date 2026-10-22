import { Modal, message } from 'antd'
import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'

type MessageApi = ReturnType<typeof message.useMessage>[0]
type ModalApi = ReturnType<typeof Modal.useModal>[0]

interface Feedback {
  message: MessageApi
  modal: ModalApi
}

const FeedbackContext = createContext<Feedback | null>(null)

/** 轻提示与确认框：使用 hook 方式，沿用页面主题，并随页面一起卸载。 */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [messageApi, messageHolder] = message.useMessage()
  const [modalApi, modalHolder] = Modal.useModal()
  const value = useMemo(() => ({ message: messageApi, modal: modalApi }), [messageApi, modalApi])
  return (
    <FeedbackContext.Provider value={value}>
      {messageHolder}
      {modalHolder}
      {children}
    </FeedbackContext.Provider>
  )
}

export function useFeedback(): Feedback {
  const value = useContext(FeedbackContext)
  if (!value) throw new Error('useFeedback 只能在 FeedbackProvider 内使用')
  return value
}
