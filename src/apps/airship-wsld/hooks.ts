import { useEffect, useRef } from 'react'
import type { AppApi, ShellEvent } from '@airship/contract'

/**
 * 订阅应用自带后端推回来的事件（任务分块输出与结束）。
 *
 * 处理函数每次渲染都是新的，而订阅只在挂载时挂一次：
 * 用 ref 转手，事件永远落在最新那份闭包里，不会读到上一次渲染的状态。
 */
export function useShellEvents(api: AppApi, handler: (event: ShellEvent) => void): void {
  const sink = useRef(handler)
  sink.current = handler

  useEffect(() => api.on((event) => sink.current(event)), [api])
}
