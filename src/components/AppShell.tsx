'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useVisiblePolling } from '@/lib/use-visible-polling'
import { usePathname, useRouter } from 'next/navigation'
import { useApp } from './app-context'
import { GearIcon, PrinterIcon } from './icons'
import AdminCodeDialog from './AdminCodeDialog'

interface PrintStatus {
  online: boolean
  enabled: boolean
  configured: boolean
  counts?: { queued: number; claimed: number; failed: number }
}

/**
 * The persistent chrome: the title bar with "Start over" and the footer with
 * the printer indicator and the gear. Both stay on screen on every route,
 * which is what makes the app feel like the kiosk it replaces.
 */
export default function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const { general, admin, refresh } = useApp()
  const [status, setStatus] = useState<PrintStatus | null>(null)
  const [codeOpen, setCodeOpen] = useState(false)

  // --- printer heartbeat -------------------------------------------------
  // Only while the screen is awake; see lib/use-visible-polling.
  useVisiblePolling(async () => {
    try {
      const response = await fetch('/api/print/status', { cache: 'no-store' })
      setStatus(await response.json())
    } catch {
      setStatus((previous) => (previous ? { ...previous, online: false } : null))
    }
  }, 30000)

  useKeepAwake()

  const startOver = useCallback(() => {
    if (pathname === '/') {
      // Already home: clear whatever is in the search box.
      window.dispatchEvent(new CustomEvent('starlight:start-over'))
    } else {
      router.push('/')
    }
  }, [pathname, router])

  const openSettings = useCallback(async () => {
    if (pathname === '/settings') {
      router.push('/')
      return
    }
    // Re-check the session: a volunteer who just typed the code should not have
    // to type it again on the way back in.
    try {
      const response = await fetch('/api/admin/auth', { cache: 'no-store' })
      const data = await response.json()
      if (data.authenticated) {
        router.push('/settings')
        return
      }
    } catch {
      /* fall through to the dialog */
    }
    setCodeOpen(true)
  }, [pathname, router])

  const dot = printerDotClass(status)

  return (
    <div className="shell">
      <header className="appHeader">
        <h1>{general.churchName}</h1>
        <button type="button" className="btn" onClick={startOver}>
          Start over
        </button>
      </header>

      <main className="appMain">{children}</main>

      <footer className="appFooter">
        <span className="printerWrap" title={printerTitle(status)}>
          <PrinterIcon size={20} />
          <span className={`printerDot ${dot}`} />
        </span>
        <span className="footerLocation">{general.locationName}</span>
        <button
          type="button"
          className="iconBtn"
          onClick={openSettings}
          aria-label={pathname === '/settings' ? 'Leave settings' : 'Settings'}
        >
          <GearIcon size={19} />
        </button>
      </footer>

      {codeOpen && (
        <AdminCodeDialog
          onClose={() => setCodeOpen(false)}
          onSuccess={async () => {
            setCodeOpen(false)
            await refresh()
            router.push('/settings')
          }}
        />
      )}

      {admin && pathname !== '/settings' && <span className="srOnly">admin session active</span>}
    </div>
  )
}

function printerDotClass(status: PrintStatus | null): string {
  if (!status) return 'dotIdle'
  if (!status.enabled) return 'dotIdle'
  if (!status.online) return 'dotOffline'
  if ((status.counts?.failed ?? 0) > 0) return 'dotBusy'
  return 'dotOnline'
}

function printerTitle(status: PrintStatus | null): string {
  if (!status) return 'Printer status unknown'
  if (!status.enabled) return 'Printing is turned off'
  if (!status.configured) return 'Printer IP is not set — open Settings'
  if (!status.online) return 'Print agent offline'
  const failed = status.counts?.failed ?? 0
  const queued = status.counts?.queued ?? 0
  if (failed > 0) return `Printer online — ${failed} failed job(s)`
  if (queued > 0) return `Printer online — ${queued} in queue`
  return 'Printer online'
}

/**
 * Keeps the iPad's screen from sleeping between families. Safari 16.4+ only;
 * everywhere else this is a no-op.
 */
function useKeepAwake() {
  const sentinel = useRef<WakeLockSentinel | null>(null)

  useEffect(() => {
    let cancelled = false

    const acquire = async () => {
      try {
        const nav = navigator as Navigator & { wakeLock?: WakeLock }
        if (!nav.wakeLock || document.visibilityState !== 'visible') return
        const lock = await nav.wakeLock.request('screen')
        if (cancelled) {
          void lock.release()
          return
        }
        sentinel.current = lock
      } catch {
        /* denied or unsupported — nothing to do */
      }
    }

    void acquire()
    document.addEventListener('visibilitychange', acquire)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', acquire)
      void sentinel.current?.release().catch(() => {})
      sentinel.current = null
    }
  }, [])
}
