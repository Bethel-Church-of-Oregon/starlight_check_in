'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { displayName } from '@/components/Avatar'
import { RefreshIcon } from '@/components/icons'
import { AttendanceBars, CategoryBars } from './Charts'
import { Notice, Panel, Stat } from './shared'

interface Payload {
  range: { from: string; to: string }
  today: string
  timezone: string
  daily: { session_date: string; total: number; students: number }[]
  byGrade: { grade: string; total: number; students: number }[]
  perStudent: {
    id: string
    korean_name: string | null
    english_name: string | null
    grade: string
    visits: number
    last_visit: string | null
  }[]
  roster: { active_students: number; new_last_30_days: number }
}

const RANGES = [
  { label: '4주', days: 27 },
  { label: '12주', days: 83 },
  { label: '6개월', days: 182 },
  { label: '1년', days: 364 },
]

export default function StatsPanel() {
  const [days, setDays] = useState(83)
  const [data, setData] = useState<Payload | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (span: number) => {
    setBusy(true)
    setError(null)
    try {
      const to = new Date()
      const from = new Date(to.getTime() - span * 86400000)
      const params = new URLSearchParams({
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
      })
      const response = await fetch(`/api/stats?${params}`, { cache: 'no-store' })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error ?? 'failed')
      setData(payload)
    } catch {
      setError('통계를 불러올 수 없습니다.')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load(days)
  }, [load, days])

  const sessions = data?.daily ?? []

  const totals = useMemo(() => {
    const checkIns = sessions.reduce((sum, d) => sum + d.total, 0)
    const average = sessions.length > 0 ? Math.round(checkIns / sessions.length) : 0
    const busiest = sessions.reduce(
      (best, d) => (d.total > (best?.total ?? -1) ? d : best),
      null as Payload['daily'][number] | null
    )
    return { checkIns, average, busiest, sessionCount: sessions.length }
  }, [sessions])

  const dailySeries = useMemo(
    () =>
      sessions.map((d) => ({
        key: d.session_date,
        label: shortDate(d.session_date),
        value: d.total,
      })),
    [sessions]
  )

  const gradeSeries = useMemo(
    () =>
      (data?.byGrade ?? []).map((g) => ({ key: g.grade, label: g.grade, value: g.total })),
    [data?.byGrade]
  )

  const attended = (data?.perStudent ?? []).filter((s) => s.visits > 0)
  const neverAttended = (data?.perStudent ?? []).filter((s) => s.visits === 0)

  return (
    <>
      <Panel
        title="출석 통계"
        actions={
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span className="tabBar" style={{ padding: 4 }}>
              {RANGES.map((range) => (
                <button
                  key={range.days}
                  type="button"
                  aria-selected={days === range.days}
                  onClick={() => setDays(range.days)}
                  style={{ padding: '6px 12px', fontSize: 14 }}
                >
                  {range.label}
                </button>
              ))}
            </span>
            <button type="button" className="iconBtn" onClick={() => void load(days)} aria-label="Refresh">
              {busy ? <span className="spinner" /> : <RefreshIcon size={18} />}
            </button>
          </span>
        }
      >
        {error && <Notice kind="error">{error}</Notice>}

        <div className="statRow" style={{ marginBottom: 22 }}>
          <Stat value={totals.checkIns} label="기간 내 총 체크인" />
          <Stat value={totals.average} label="세션 평균 인원" />
          <Stat value={totals.sessionCount} label="세션 수" />
          <Stat value={data?.roster.active_students ?? 0} label="활성 학생" />
          <Stat value={data?.roster.new_last_30_days ?? 0} label="최근 30일 신규" />
        </div>

        <h3 className="sectionTitle">세션별 체크인 인원</h3>
        <AttendanceBars
          data={dailySeries}
          formatLabel={(key) => longDate(key)}
          emptyText="이 기간에는 체크인 기록이 없습니다."
        />
        {totals.busiest && (
          <p className="fieldHint" style={{ marginTop: 8 }}>
            가장 많았던 날 · {longDate(totals.busiest.session_date)} · {totals.busiest.total}명
          </p>
        )}
      </Panel>

      <Panel title="학년별 체크인">
        <CategoryBars data={gradeSeries} emptyText="이 기간에는 체크인 기록이 없습니다." />

      </Panel>

      <Panel title={`학생별 출석 (${attended.length}명 참석 / ${neverAttended.length}명 미참석)`}>
        <div className="tableScroll" style={{ maxHeight: 460, overflowY: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>이름</th>
                <th>학년</th>
                <th style={{ textAlign: 'right' }}>출석 횟수</th>
                <th>마지막 출석</th>
              </tr>
            </thead>
            <tbody>
              {(data?.perStudent ?? []).map((student) => (
                <tr key={student.id} style={{ opacity: student.visits === 0 ? 0.55 : 1 }}>
                  <td>{displayName(student.korean_name, student.english_name)}</td>
                  <td>{student.grade}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{student.visits}</td>
                  <td>{student.last_visit ? longDate(student.last_visit) : '—'}</td>
                </tr>
              ))}
              {(data?.perStudent.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 26 }}>
                    학생이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  )
}

function shortDate(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`)
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'numeric', day: 'numeric' }).format(
    date
  )
}

function longDate(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`)
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date)
}
