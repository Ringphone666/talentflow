import {afterEach, expect, it, vi} from 'vitest'
import {transcriptTrigger} from '../transcript-trigger'
afterEach(() => vi.useRealTimers())
it('新转写触发而非轮询；忙碌时合并更新；相同内容不重复请求', async () => {
  vi.useFakeTimers()
  let finish!: () => void
  const run = vi.fn().mockImplementationOnce(() => new Promise<void>(r => {finish=r})).mockResolvedValue(undefined)
  const trigger = transcriptTrigger(run)
  await vi.advanceTimersByTimeAsync(15000)
  expect(run).not.toHaveBeenCalled()
  trigger.update('候选人：我先记录异常并报告')
  await vi.advanceTimersByTimeAsync(400)
  expect(run).toHaveBeenCalledTimes(1)
  trigger.update('候选人：我先记录异常并报告班组长')
  await vi.advanceTimersByTimeAsync(1000)
  expect(run).toHaveBeenCalledTimes(1)
  finish()
  await vi.advanceTimersByTimeAsync(400)
  expect(run).toHaveBeenCalledTimes(2)
  trigger.update('候选人：我先记录异常并报告班组长')
  await vi.advanceTimersByTimeAsync(15000)
  expect(run).toHaveBeenCalledTimes(2)
  trigger.close()
})
