'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Avatar, { displayName } from '@/components/Avatar'
import { AlertIcon, ArrowLeftIcon, CheckIcon, PrinterIcon } from '@/components/icons'
import { useApp } from '@/components/app-context'
import { randomCheckInMessage } from '@/lib/messages'
import { renderLabelStream, waitForFonts } from '@/lib/label'
import { base64FromBytes } from '@/lib/raster'
import type { LabelPayload, Service, Student } from '@/lib/types'

type Phase = 'loading' | 'select' | 'submitting' | 'confirm'
type PrintPhase =
  | 'idle'
  | 'rendering'
  | 'queued'
  | 'printing'
  | 'done'
  /** Still in the queue after our wait window, but the agent is alive. */
  | 'pending'
  | 'failed'
  | 'skipped'

interface HistoryRow {
  id: string
  session_date: string
  service_name: string | null
  security_code: string
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
  const [serviceId, setServiceId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [message] = useState(() => randomCheckInMessage())
  const [result, setResult] = useState<{
    labelPayload: LabelPayload
    alreadyCheckedIn: boolean
  } | null>(null)
  const [printPhase, setPrintPhase] = useState<PrintPhase>('idle')
  const [printError, setPrintError] = useState<string | null>(null)
  const [returnSeconds, setReturnSeconds] = useState<number | null>(null)

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

  // Pre-select the service that is closest to right now.
  useEffect(() => {
    if (serviceId !== null || app.services.length === 0) return
    setServiceId(nearestService(app.services, app.general.timezone))
  }, [app.services, app.general.timezone, serviceId])

  const alreadyToday = useMemo(() => {
    const todayRow = history.find((h) => isToday(h.session_date, app.general.timezone))
    return todayRow ?? null
  }, [history, app.general.timezone])

  // --- check in -----------------------------------------------------------
  const submit = useCallback(async () => {
    if (!selected || phase === 'submitting') return
    setPhase('submitting')
    setError(null)

    try {
      const response = await fetch('/api/checkins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId, serviceId }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? 'check-in failed')

      setResult({ labelPayload: data.labelPayload, alreadyCheckedIn: data.alreadyCheckedIn })
      setPhase('confirm')

      void printLabel({
        labelPayload: data.labelPayload,
        label: data.label,
        print: data.print,
        timezone: data.timezone,
        checkInId: data.checkIn?.id ?? null,
        setPrintPhase,
        setPrintError,
      })

      setReturnSeconds(data.autoReturnSeconds ?? app.general.autoReturnSeconds ?? 5)
    } catch (err) {
      setError(err instanceof Error ? err.message : '체크인에 실패했습니다.')
      setPhase('select')
    }
  }, [selected, phase, studentId, serviceId, app.general.autoReturnSeconds])

  // --- auto-return to the default screen ----------------------------------
  const goHome = useCallback(() => router.push('/'), [router])

  useEffect(() => {
    if (phase !== 'confirm' || returnSeconds === null) return
    if (printPhase === 'failed') return // hold on screen so a volunteer notices
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
                {[result.labelPayload.grade, result.labelPayload.serviceName]
                  .filter(Boolean)
                  .join(' · ')}
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
          <button
            type="button"
            className="btn btnLarge"
            style={{ marginTop: 22 }}
            onClick={goHome}
          >
            확인
          </button>
        ) : (
          returnSeconds !== null && (
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
                        오늘 체크인됨 · {alreadyToday.security_code}
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

              {app.services.length > 1 && (
                <div className="serviceChoice">
                  {app.services.map((service) => (
                    <button
                      key={service.id}
                      type="button"
                      className={`serviceBtn ${serviceId === service.id ? 'serviceBtnOn' : ''}`}
                      onClick={() => setServiceId(service.id)}
                    >
                      {service.name}
                      {service.start_time ? ` · ${formatTime(service.start_time)}` : ''}
                    </button>
                  ))}
                </div>
              )}
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

// ---------------------------------------------------------------- printing

async function printLabel(args: {
  labelPayload: LabelPayload
  label: Parameters<typeof renderLabelStream>[0]['label']
  print: { enabled: boolean; mediaWidthMm: number; labelLengthMm: number; threshold: number }
  timezone: string
  checkInId: string | null
  setPrintPhase: (phase: PrintPhase) => void
  setPrintError: (error: string | null) => void
}) {
  const { setPrintPhase, setPrintError } = args

  if (!args.print?.enabled) {
    setPrintPhase('skipped')
    return
  }

  try {
    setPrintPhase('rendering')
    await waitForFonts()

    const { stream, rasterCount } = renderLabelStream({
      payload: args.labelPayload,
      label: args.label,
      timezone: args.timezone,
      mediaWidthMm: args.print.mediaWidthMm,
      labelLengthMm: args.print.labelLengthMm,
      threshold: args.print.threshold,
    })

    const response = await fetch('/api/print/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stream: base64FromBytes(stream),
        rasterCount,
        checkInId: args.checkInId,
        kind: 'label',
        label: `${args.labelPayload.koreanName ?? args.labelPayload.englishName ?? ''} ${
          args.labelPayload.securityCode
        }`.trim(),
      }),
    })

    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? '인쇄 대기열에 넣지 못했습니다.')

    setPrintPhase('queued')
    await waitForJob(data.job.id, setPrintPhase, setPrintError)
  } catch (err) {
    setPrintError(err instanceof Error ? err.message : '인쇄에 실패했습니다.')
    setPrintPhase('failed')
  }
}

/** Poll the queued job so the screen can say "printed" rather than "sent". */
async function waitForJob(
  jobId: string,
  setPrintPhase: (phase: PrintPhase) => void,
  setPrintError: (error: string | null) => void
) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    await sleep(700)
    try {
      const response = await fetch(`/api/print/jobs?id=${jobId}`, { cache: 'no-store' })
      if (!response.ok) continue
      const { job } = await response.json()
      if (job.status === 'done') return setPrintPhase('done')
      if (job.status === 'error') {
        setPrintError(job.error ?? '프린터가 응답하지 않습니다.')
        return setPrintPhase('failed')
      }
      if (job.status === 'claimed') setPrintPhase('printing')
    } catch {
      /* keep waiting */
    }
  }

  // Still queued. Whether that is a problem depends entirely on whether the
  // agent is alive: outside a scheduled service it polls every ten seconds, so
  // the very first label of an unscheduled event can legitimately land after
  // our wait window — and every one after it is instant. An agent that is not
  // there at all is a different matter and should hold the screen.
  try {
    const response = await fetch('/api/print/status', { cache: 'no-store' })
    const status = await response.json()
    if (status.online) {
      setPrintError(null)
      return setPrintPhase('pending')
    }
  } catch {
    /* fall through to the failure case */
  }

  setPrintError('프린터 에이전트 응답 없음 — 이름표는 대기열에 남아 있습니다.')
  setPrintPhase('failed')
}

function printStatusText(phase: PrintPhase, error: string | null): string {
  switch (phase) {
    case 'idle':
    case 'rendering':
      return '이름표 준비 중…'
    case 'queued':
      return '프린터로 보내는 중…'
    case 'printing':
      return '이름표 인쇄 중…'
    case 'done':
      return '이름표 인쇄 완료'
    case 'pending':
      return '이름표가 곧 인쇄됩니다'
    case 'skipped':
      return '인쇄가 꺼져 있습니다'
    case 'failed':
      return error ?? '인쇄에 실패했습니다'
  }
}

// ---------------------------------------------------------------- helpers

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatTime(value: string): string {
  const [h, m] = value.split(':')
  const hour = Number(h)
  if (!Number.isFinite(hour)) return value
  const suffix = hour < 12 ? 'am' : 'pm'
  const display = hour % 12 === 0 ? 12 : hour % 12
  return `${display}:${m ?? '00'} ${suffix}`
}

/** Minutes since midnight, in the church's timezone. */
function minutesNow(timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date())
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
  return hour * 60 + minute
}

function nearestService(services: Service[], timezone: string): string | null {
  if (services.length === 0) return null
  const now = minutesNow(timezone)
  let best = services[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const service of services) {
    if (!service.start_time) continue
    const [h, m] = service.start_time.split(':').map(Number)
    const distance = Math.abs(h * 60 + (m || 0) - now)
    if (distance < bestDistance) {
      bestDistance = distance
      best = service
    }
  }
  return best.id
}

function isToday(sessionDate: string, timezone: string): boolean {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
  return sessionDate.slice(0, 10) === today
}
