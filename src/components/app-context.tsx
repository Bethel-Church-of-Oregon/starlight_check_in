'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { DEFAULT_GENERAL, DEFAULT_LABEL, DEFAULT_GRADES, DEFAULT_PRINTER } from '@/lib/settings'
import type { GeneralSettings, LabelSettings, PrinterSettings } from '@/lib/types'

interface AppContextValue {
  ready: boolean
  admin: boolean
  /** True when the server could not reach the database and served defaults. */
  degraded: boolean
  general: GeneralSettings
  label: LabelSettings
  grades: string[]
  /** Full print settings — the iPad assembles jobs and calls the bridge itself. */
  printer: PrinterSettings
  refresh: () => Promise<void>
}

const FALLBACK: Omit<AppContextValue, 'refresh'> = {
  ready: false,
  admin: false,
  degraded: false,
  general: DEFAULT_GENERAL,
  label: DEFAULT_LABEL,
  grades: DEFAULT_GRADES,
  printer: DEFAULT_PRINTER,
}

const AppContext = createContext<AppContextValue>({ ...FALLBACK, refresh: async () => {} })

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(FALLBACK)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/settings', { cache: 'no-store' })
      if (!response.ok) throw new Error(`settings ${response.status}`)
      const data = await response.json()
      setState({
        ready: true,
        admin: Boolean(data.admin),
        degraded: Boolean(data.degraded),
        general: { ...DEFAULT_GENERAL, ...data.general },
        label: { ...DEFAULT_LABEL, ...data.label },
        grades: Array.isArray(data.grades) && data.grades.length ? data.grades : DEFAULT_GRADES,
        printer: { ...FALLBACK.printer, ...data.printer },
      })
    } catch (error) {
      // The kiosk should still paint if the settings call blips, so fall back
      // to defaults rather than blocking.
      console.error('could not load settings', error)
      setState((previous) => ({ ...previous, ready: true, degraded: true }))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const value = useMemo(() => ({ ...state, refresh }), [state, refresh])
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp() {
  return useContext(AppContext)
}
