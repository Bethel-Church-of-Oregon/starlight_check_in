'use client'

import { useCallback, useEffect, useState } from 'react'
import Avatar, { displayName } from '@/components/Avatar'
import { RefreshIcon, TrashIcon } from '@/components/icons'
import { useVisiblePolling } from '@/lib/use-visible-polling'
import { Notice, Panel, Stat, formatClock } from './shared'

interface Row {
  id: string
  security_code: string
  service_name: string | null
  grade: string | null
  checked_in_at: string
  checked_out_at: string | null
  reprints: number
  student_id: string
  korean_name: string | null
  english_name: string | null
}

interface Payload {
  date: string
  timezone: string
  total: number
  checkedOut: number
  byGrade: { grade: string; count: number }[]
  checkIns: Row[]
}

/** Live view of who is in the building right now. */
export default function TodayPanel() {
  const [date, setDate] = useState('')
  const [data, setData] = useState<Payload | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Once the admin session lapses, stop refreshing — see the polling note below. */
  const [expired, setExpired] = useState(false)

  const load = useCallback(
    async (forDate?: string) => {
      setBusy(true)
      setError(null)
      try {
        const query = forDate ? `?date=${encodeURIComponent(forDate)}` : ''
        const response = await fetch(`/api/checkins/today${query}`, { cache: 'no-store' })
        if (response.status === 401) {
          setExpired(true)
          return
        }
        const payload = await response.json()
        if (!response.ok) throw new Error(payload.error ?? 'failed')
        setData(payload)
        setDate(payload.date)
      } catch {
        setError('체크인 현황을 불러올 수 없습니다.')
      } finally {
        setBusy(false)
      }
    },
    []
  )

  // A settings screen left open on a laptop during service should stay current
  // — but not while it is a background tab, and not forever: each refresh
  // wakes the database, and a tab left open all week would keep Neon's compute
  // running around the clock (≈180 CU-hours against the free plan's 100).
  // The admin session lasts 30 minutes; when it lapses, refreshing stops.
  useVisiblePolling(() => (expired ? undefined : load(date || undefined)), 30000)

  const toggleCheckOut = async (row: Row) => {
    await fetch(`/api/checkins/${row.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkedOut: !row.checked_out_at }),
    })
    void load(date)
  }

  const remove = async (row: Row) => {
    const name = displayName(row.korean_name, row.english_name)
    if (!confirm(`${name} 의 체크인 기록을 삭제할까요? 되돌릴 수 없습니다.`)) return
    await fetch(`/api/checkins/${row.id}`, { method: 'DELETE' })
    void load(date)
  }

  const timezone = data?.timezone ?? 'America/Los_Angeles'
  const present = (data?.total ?? 0) - (data?.checkedOut ?? 0)

  return (
    <Panel
      title="오늘 체크인 현황"
      actions={
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="date"
            value={date}
            onChange={(event) => {
              setDate(event.target.value)
              void load(event.target.value)
            }}
            style={{
              background: '#fff',
              border: '1px solid var(--field-border)',
              borderRadius: 6,
              padding: '7px 10px',
              fontSize: 14,
            }}
          />
          <button
            type="button"
            className="iconBtn"
            onClick={() => void load(date)}
            aria-label="Refresh"
          >
            {busy ? <span className="spinner" /> : <RefreshIcon size={18} />}
          </button>
        </span>
      }
    >
      {expired && (
        <Notice kind="warn">
          관리자 세션이 만료되어 자동 새로고침을 멈췄습니다. 톱니바퀴를 눌러 코드를 다시
          입력해 주세요.
        </Notice>
      )}
      {error && <Notice kind="error">{error}</Notice>}

      <div className="statRow" style={{ marginBottom: 18 }}>
        <Stat value={data?.total ?? 0} label="총 체크인" />
        <Stat value={present} label="현재 있는 인원" />
        <Stat value={data?.checkedOut ?? 0} label="체크아웃" />
        <Stat value={data?.byGrade.length ?? 0} label="학년 수" />
      </div>

      {(data?.byGrade.length ?? 0) > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
          {data!.byGrade.map((g) => (
            <span key={g.grade} className="chip">
              {g.grade} · {g.count}
            </span>
          ))}
        </div>
      )}

      <div className="tableScroll">
        <table className="table">
          <thead>
            <tr>
              <th>이름</th>
              <th>학년</th>
              <th>회차</th>
              <th>코드</th>
              <th>체크인</th>
              <th>체크아웃</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(data?.checkIns ?? []).map((row) => (
              <tr key={row.id}>
                <td>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Avatar korean={row.korean_name} english={row.english_name} size="sm" />
                    <span>
                      {displayName(row.korean_name, row.english_name)}
                      {row.reprints > 0 && (
                        <span className="fieldHint"> 재인쇄 {row.reprints}회</span>
                      )}
                    </span>
                  </span>
                </td>
                <td>{row.grade ?? '—'}</td>
                <td>{row.service_name ?? '—'}</td>
                <td>
                  <span className="chip chipBlue" style={{ letterSpacing: 1, fontWeight: 700 }}>
                    {row.security_code}
                  </span>
                </td>
                <td>{formatClock(row.checked_in_at, timezone)}</td>
                <td>
                  {row.checked_out_at ? (
                    <span className="chip chipGreen">{formatClock(row.checked_out_at, timezone)}</span>
                  ) : (
                    <button type="button" className="btn" onClick={() => void toggleCheckOut(row)}>
                      체크아웃
                    </button>
                  )}
                </td>
                <td>
                  <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    {row.checked_out_at && (
                      <button type="button" className="btn" onClick={() => void toggleCheckOut(row)}>
                        취소
                      </button>
                    )}
                    <button
                      type="button"
                      className="iconBtn"
                      onClick={() => void remove(row)}
                      aria-label="Delete check-in"
                    >
                      <TrashIcon size={17} />
                    </button>
                  </span>
                </td>
              </tr>
            ))}
            {(data?.checkIns.length ?? 0) === 0 && (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 26 }}>
                  아직 체크인한 학생이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
