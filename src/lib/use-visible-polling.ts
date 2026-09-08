'use client'

import { useEffect, useRef } from 'react'

/**
 * Runs `task` on an interval, but only while the tab is actually visible.
 *
 * A wall-mounted iPad sits on this app all week. Polling a sleeping screen
 * costs real request quota on both free hosting tiers and tells nobody
 * anything, so every background poll in the app goes through here: it stops
 * when the page is hidden and fires once immediately when it comes back, so
 * the first thing a volunteer sees is current.
 */
export function useVisiblePolling(task: () => void | Promise<void>, intervalMs: number) {
  const taskRef = useRef(task)
  taskRef.current = task

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null
    let cancelled = false

    const run = () => {
      if (!cancelled) void taskRef.current()
    }

    const start = () => {
      if (timer !== null) return
      run()
      timer = setInterval(run, intervalMs)
    }

    const stop = () => {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    }

    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop())

    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [intervalMs])
}
