'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useVisiblePolling } from '@/lib/use-visible-polling'
import { usePathname, useRouter } from 'next/navigation'
import { useApp } from './app-context'
import { bridgeConfigured, fetchBridgeStatus, type BridgeStatus } from '@/lib/print-client'
import { GearIcon, PrinterIcon } from './icons'
import AdminCodeDialog from './AdminCodeDialog'

/**
 * The persistent chrome: the title bar with "Start over" and the footer with
 * the printer indicator and the gear. Both stay on screen on every route,
 * which is what makes the app feel like the kiosk it replaces.
 */
export default function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const { general, admin, refresh, printer } = useApp()
  const [status, setStatus] = useState<BridgeStatus | null>(null)
  const [codeOpen, setCodeOpen] = useState(false)

  // --- printer heartbeat -------------------------------------------------
  // Asks the bridge on the LAN, never the cloud, so a kiosk left on all week
  // does not keep the database awake. Only while the screen is on.
  useVisiblePolling(async () => {
    if (!printer.enabled || !bridgeConfigured(printer)) {
      setStatus(null)
      return
    }
    setStatus(await fetchBridgeStatus(printer))
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

  const dot = printerDotClass(status, printer)

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
        <span className="printerWrap" title={printerTitle(status, printer)}>
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

function printerDotClass(
  status: BridgeStatus | null,
  printer: { enabled: boolean; bridgeUrl?: string }
): string {
  if (!printer.enabled || !bridgeConfigured({ bridgeUrl: printer.bridgeUrl ?? '' })) return 'dotIdle'
  if (!status) return 'dotIdle'
  if (!status.bridgeReachable || !status.printerReachable) return 'dotOffline'
  if (!status.ok) return 'dotBusy'
  return 'dotOnline'
}

function printerTitle(
  status: BridgeStatus | null,
  printer: { enabled: boolean; bridgeUrl?: string }
): string {
  if (!printer.enabled) return '인쇄가 꺼져 있습니다'
  if (!bridgeConfigured({ bridgeUrl: printer.bridgeUrl ?? '' })) return '브릿지 주소가 없습니다 — 세팅에서 입력'
  if (!status) return '프린터 상태 확인 중'
  if (!status.bridgeReachable) return '프린트 브릿지에 연결할 수 없습니다'
  if (!status.printerReachable) return status.messages[0] ?? '브릿지가 프린터에 연결하지 못했습니다'
  if (!status.ok) return status.messages.join(' / ') || '프린터 오류'
  return '프린터 정상'
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
