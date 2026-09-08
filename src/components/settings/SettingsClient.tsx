'use client'

import { useCallback, useEffect, useState } from 'react'
import { useApp } from '@/components/app-context'
import type { GeneralSettings, LabelSettings, PrinterSettings, Service } from '@/lib/types'
import { DEFAULT_GENERAL, DEFAULT_LABEL, DEFAULT_PRINTER, DEFAULT_GRADES } from '@/lib/settings'
import TodayPanel from './TodayPanel'
import RosterPanel from './RosterPanel'
import PrinterPanel from './PrinterPanel'
import StatsPanel from './StatsPanel'
import GeneralPanel from './GeneralPanel'
import { Notice } from './shared'

const TABS = [
  { id: 'today', label: '오늘' },
  { id: 'roster', label: '학생 명단' },
  { id: 'printer', label: '프린터' },
  { id: 'stats', label: '통계' },
  { id: 'general', label: '일반' },
] as const

type TabId = (typeof TABS)[number]['id']

interface FullSettings {
  general: GeneralSettings
  printer: PrinterSettings
  label: LabelSettings
  grades: string[]
  services: Service[]
}

export default function SettingsClient() {
  const app = useApp()
  const [tab, setTab] = useState<TabId>('today')
  const [settings, setSettings] = useState<FullSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/settings', { cache: 'no-store' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? 'failed')
      setSettings({
        general: { ...DEFAULT_GENERAL, ...data.general },
        printer: { ...DEFAULT_PRINTER, ...data.printer },
        label: { ...DEFAULT_LABEL, ...data.label },
        grades: data.grades?.length ? data.grades : DEFAULT_GRADES,
        services: data.services ?? [],
      })
      setError(null)
    } catch {
      setError('설정을 불러올 수 없습니다.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(
    async (patch: Record<string, unknown>) => {
      const response = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? '저장에 실패했습니다.')
      await load()
      // The kiosk chrome reads the church name, grades and services from here.
      await app.refresh()
    },
    [load, app]
  )

  const saveServices = useCallback(
    async (services: { id?: string; name: string; startTime: string | null }[]) => {
      const response = await fetch('/api/services', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ services }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? '저장에 실패했습니다.')
      await load()
      await app.refresh()
    },
    [load, app]
  )

  return (
    <div className="stack" style={{ maxWidth: 1080 }}>
      <div className="card">
        <div className="cardBody" style={{ padding: 12 }}>
          <div className="tabBar" role="tablist">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="card">
          <div className="cardBody">
            <Notice kind="error">{error}</Notice>
          </div>
        </div>
      )}

      {tab === 'today' && <TodayPanel />}
      {tab === 'roster' && <RosterPanel />}
      {tab === 'stats' && <StatsPanel />}

      {tab === 'printer' && settings && (
        <PrinterPanel
          printer={settings.printer}
          label={settings.label}
          timezone={settings.general.timezone}
          onSave={save}
        />
      )}

      {tab === 'general' && settings && (
        <GeneralPanel
          general={settings.general}
          grades={settings.grades}
          services={settings.services}
          onSave={save}
          onSaveServices={saveServices}
        />
      )}

      {(tab === 'printer' || tab === 'general') && !settings && !error && (
        <div className="card">
          <div className="emptyState">설정을 불러오는 중…</div>
        </div>
      )}
    </div>
  )
}
