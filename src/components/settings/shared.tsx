'use client'

import type { ReactNode } from 'react'

export function Toggle({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint?: string
  value: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="toggleRow">
      <span>
        <span style={{ fontSize: 15, fontWeight: 500 }}>{label}</span>
        {hint && <span className="fieldHint" style={{ display: 'block' }}>{hint}</span>}
      </span>
      <button
        type="button"
        className="switch"
        aria-pressed={value}
        aria-label={label}
        onClick={() => onChange(!value)}
      />
    </div>
  )
}

export function Panel({
  title,
  actions,
  children,
  footer,
}: {
  title: string
  actions?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <section className="card">
      <div className="cardHeader">
        <span>{title}</span>
        {actions}
      </div>
      <div className="cardBody">{children}</div>
      {footer && <div className="cardFooter">{footer}</div>}
    </section>
  )
}

export function Stat({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="stat">
      <div className="statValue">{value}</div>
      <div className="statLabel">{label}</div>
    </div>
  )
}

export function Notice({ kind, children }: { kind: 'ok' | 'error' | 'warn' | 'info'; children: ReactNode }) {
  const cls =
    kind === 'ok'
      ? 'bannerOk'
      : kind === 'error'
        ? 'bannerError'
        : kind === 'warn'
          ? 'bannerWarn'
          : 'bannerInfo'
  return (
    <div className={`banner ${cls}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  )
}

export function formatDateTime(iso: string | null, timezone: string): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

export function formatClock(iso: string | null, timezone: string): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}
