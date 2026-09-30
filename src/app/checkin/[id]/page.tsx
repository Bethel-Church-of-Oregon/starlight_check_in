'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Avatar, { displayName } from '@/components/Avatar'
import { AlertIcon, ArrowLeftIcon, CheckIcon, PrinterIcon } from '@/components/icons'
import { useApp } from '@/components/app-context'
import { randomCheckInMessage } from '@/lib/messages'
import { PrintError, buildLabelJob, sendToBridge } from '@/lib/print-client'
import type { LabelPayload, LabelSettings, PrinterSettings, Student } from '@/lib/types'

type Phase = 'loading' | 'select' | 'submitting' | 'confirm'
type PrintPhase = 'idle' | 'rendering' | 'sending' | 'done' | 'failed' | 'skipped'

interface HistoryRow {
  id: string
  session_date: string
  checked_in_at: string
}

export default function CheckInScreen() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const studentId = params.id
  const app = useApp()

  const [phase, setPhase] = useState<Phase>('loading')
  const [student, setStudent] = useState<Student | null>(null)
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [selected, setSelected] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [message] = useState(() => randomCheckInMessage())
  const [result, setResult] = useState<{
    labelPayload: LabelPayload
    alreadyCheckedIn: boolean
  } | null>(null)
  const [printPhase, setPrintPhase] = useState<PrintPhase>('idle')
  const [printError, setPrintError] = useState<string | null>(null)
  const [returnSeconds, setReturnSeconds] = useState<number | null>(null)
  /** The assembled job, kept so "다시 인쇄" resends the exact same label. */
  const lastJob = useRef<{ bytes: Uint8Array; printer: PrinterSettings; label: string } | null>(null)

  // --- load the student ---------------------------------------------------
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const response = await fetch(`/api/students/${studentId}`, { cache: 'no-store' })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error ?? 'not found')
        if (cancelled) return
        setStudent(data.student)
        setHistory(data.history ?? [])
        setPhase('select')
      } catch {
        if (!cancelled) {
          setError('학생 정보를 불러올 수 없습니다.')
          setPhase('select')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [studentId])

  const alreadyToday = useMemo(() => {
    const todayRow = history.find((h) => isToday(h.session_date, app.general.timezone))
    return todayRow ?? null
  }, [history, app.general.timezone])

  // --- printing -------------------------------------------------------------
  const send = useCallback(async () => {
    const job = lastJob.current
    if (!job) return
    setPrintPhase('sending')
    setPrintError(null)
    try {
      await sendToBridge(job.printer, job.bytes, job.label)
      setPrintPhase('done')
    } catch (err) {
      setPrintError(err instanceof Error ? err.message : '인쇄에 실패했습니다.')
      setPrintPhase('failed')
    }
  }, [])

  const runPrint = useCallback(
    async (args: {
      labelPayload: LabelPayload
      label: LabelSettings
      printer: PrinterSettings
      timezone: string
    }) => {
      if (!args.printer?.enabled) {
        setPrintPhase('skipped')
        return
      }
      try {
        setPrintPhase('rendering')
        const bytes = await buildLabelJob({
          payload: args.labelPayload,
          label: args.label,
          printer: args.printer,
          timezone: args.timezone,
        })
        const name = args.labelPayload.koreanName ?? args.labelPayload.englishName ?? ''
        lastJob.current = {
          bytes,
          printer: args.printer,
          label: `${name} ${args.labelPayload.securityCode}`.trim(),
        }
      } catch (err) {
        setPrintError(err instanceof PrintError ? err.message : '이름표를 만들지 못했습니다.')
        setPrintPhase('failed')
        return
      }
      await send()
    },
    [send]
  )

  // --- check in -----------------------------------------------------------
  const submit = useCallback(async () => {
    if (!selected || phase === 'submitting') return
    setPhase('submitting')
    setError(null)

    try {
      const response = await fetch('/api/checkins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? 'check-in failed')

      setResult({ labelPayload: data.labelPayload, alreadyCheckedIn: data.alreadyCheckedIn })
      setPhase('confirm')

      void runPrint({
        labelPayload: data.labelPayload,
        label: data.label,
        printer: data.printer,
        timezone: data.timezone,
      })

      setReturnSeconds(data.autoReturnSeconds ?? app.general.autoReturnSeconds ?? 5)
    } catch (err) {
      setError(err instanceof Error ? err.message : '체크인에 실패했습니다.')
      setPhase('select')
    }
  }, [selected, phase, studentId, app.general.autoReturnSeconds, runPrint])

  // --- auto-return to the default screen ----------------------------------
  // The countdown starts once the label has actually come out, so a child is
  // never sent back to the search screen while their tag is still printing.
  const goHome = useCallback(() => router.push('/'), [router])

  useEffect(() => {
    if (phase !== 'confirm' || returnSeconds === null) return
    if (printPhase !== 'done' && printPhase !== 'skipped') return
    const id = setTimeout(goHome, returnSeconds * 1000)
    return () => clearTimeout(id)
  }, [phase, returnSeconds, printPhase, goHome])

  // ---------------------------------------------------------------- render
  if (phase === 'confirm' && result) {
    return (
      <div className="confirm">
        <p className="confirmBig">{message.big}</p>
        <p className="confirmSmall">{message.small}</p>

        <div className="confirmNames">
          <div className="confirmCard">
            <Avatar
              korean={result.labelPayload.koreanName}
              english={result.labelPayload.englishName}
              size="lg"
            />
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontSize: 28, fontWeight: 700 }}>
                {displayName(result.labelPayload.koreanName, result.labelPayload.englishName)}
              </div>
              <div style={{ fontSize: 16, opacity: 0.9 }}>
                {result.labelPayload.grade}
              </div>
            </div>
            <div className="confirmCodeBox">{result.labelPayload.securityCode}</div>
          </div>
        </div>

        {result.alreadyCheckedIn && (
          <p className="confirmSmall" style={{ marginTop: 14 }}>
            이미 체크인되어 있어서 이름표만 다시 인쇄했어요
          </p>
        )}

        <div className="confirmStatus" role="status">
          <PrinterIcon size={18} />
          <span>{printStatusText(printPhase, printError)}</span>
        </div>

        {printPhase === 'failed' ? (
          <div style={{ display: 'flex', gap: 10, marginTop: 22, flexWrap: 'wrap', justifyContent: 'center' }}>
            {lastJob.current && (
              <button type="button" className="btn btnLarge" onClick={() => void send()}>
                다시 인쇄
              </button>
            )}
            <button type="button" className="btn btnLarge" onClick={goHome}>
              확인
            </button>
          </div>
        ) : (
          returnSeconds !== null &&
          (printPhase === 'done' || printPhase === 'skipped') && (
            <div className="progressTrack" aria-hidden="true">
              <div
                className="progressBar"
                style={{ animationDuration: `${returnSeconds}s` }}
              />
            </div>
          )
        )}
      </div>
    )
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="cardHeader">
          <span>Please choose</span>
        </div>

        <div className="cardBody">
          {error && (
            <div className="banner bannerError" style={{ marginBottom: 14 }} role="alert">
              <AlertIcon size={18} />
              <span>{error}</span>
            </div>
          )}

          {phase === 'loading' && <div className="emptyState">불러오는 중…</div>}

          {student && (
            <>
              <div className="personRow">
                <button
                  type="button"
                  className={`checkbox ${selected ? 'checkboxOn' : ''}`}
                  aria-pressed={selected}
                  aria-label={`Select ${displayName(student.korean_name, student.english_name)}`}
                  onClick={() => setSelected((v) => !v)}
                >
                  <CheckIcon size={20} />
                </button>

                <Avatar korean={student.korean_name} english={student.english_name} />

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="personName">
                    {displayName(student.korean_name, student.english_name)}
                  </div>
                  {student.korean_name && student.english_name && (
                    <div style={{ color: 'var(--text-muted)', fontSize: 16, marginTop: 2 }}>
                      {student.english_name}
                    </div>
                  )}
                  <div className="personMeta">
                    <span className="chip">{student.grade}</span>
                    {alreadyToday && (
                      <span className="chip chipGreen">
                        오늘 체크인됨
                      </span>
                    )}
                    {student.allergies && (
                      <span className="chip chipWarn">알레르기: {student.allergies}</span>
                    )}
                    {student.medical_notes && (
                      <span className="chip chipWarn">{student.medical_notes}</span>
                    )}
                  </div>
                </div>
              </div>

            </>
          )}
        </div>

        <div className="cardFooter">
          <button type="button" className="btn" onClick={() => router.push('/')}>
            <ArrowLeftIcon size={16} />
            Go back
          </button>
          <button
            type="button"
            className="btn btnPrimary btnLarge"
            disabled={!selected || phase === 'submitting' || !student}
            onClick={() => void submit()}
          >
            {phase === 'submitting' ? (
              <>
                <span className="spinner" /> 체크인 중…
              </>
            ) : alreadyToday ? (
              '이름표 다시 인쇄'
            ) : (
              'Check in 1 person'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

function printStatusText(phase: PrintPhase, error: string | null): string {
  switch (phase) {
    case 'idle':
    case 'rendering':
      return '이름표 준비 중…'
    case 'sending':
      return '이름표 인쇄 중…'
    case 'done':
      return '이름표 인쇄 완료'
    case 'skipped':
      return '인쇄가 꺼져 있습니다'
    case 'failed':
      return error ?? '인쇄에 실패했습니다'
  }
}

// ---------------------------------------------------------------- helpers

function isToday(sessionDate: string, timezone: string): boolean {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
  return sessionDate.slice(0, 10) === today
}
