'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PrinterIcon, RefreshIcon } from '@/components/icons'
import { renderLabelPreview, renderLabelStream, waitForFonts } from '@/lib/label'
import { base64FromBytes } from '@/lib/raster'
import type { LabelPayload, LabelSettings, PrinterSettings } from '@/lib/types'
import { useVisiblePolling } from '@/lib/use-visible-polling'
import { Notice, Panel, Stat, Toggle, formatDateTime } from './shared'

const SAMPLE: LabelPayload = {
  koreanName: '김민준',
  englishName: 'Minjun Kim',
  grade: '3rd',
  securityCode: 'H7KM',
  serviceName: '1부 예배',
  checkedInAt: new Date().toISOString(),
}

const MEDIA_WIDTHS = [62, 54, 50, 38, 29]

interface Status {
  online: boolean
  enabled: boolean
  configured: boolean
  agents: {
    id: string
    name: string | null
    printer_host: string | null
    version: string | null
    last_seen_at: string
    last_error: string | null
    online: boolean
  }[]
  counts: { queued: number; claimed: number; failed: number }
  recent: {
    id: string
    kind: string
    label: string | null
    status: string
    attempts: number
    error: string | null
    created_at: string
    completed_at: string | null
  }[]
}

export default function PrinterPanel({
  printer,
  label,
  timezone,
  onSave,
}: {
  printer: PrinterSettings
  label: LabelSettings
  timezone: string
  onSave: (patch: { printer?: Partial<PrinterSettings>; label?: Partial<LabelSettings> }) => Promise<void>
}) {
  const [draft, setDraft] = useState<PrinterSettings>(printer)
  const [labelDraft, setLabelDraft] = useState<LabelSettings>(label)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [preview, setPreview] = useState<string>('')

  useEffect(() => setDraft(printer), [printer])
  useEffect(() => setLabelDraft(label), [label])

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/print/status', { cache: 'no-store' })
      setStatus(await response.json())
    } catch {
      /* the panel is still usable without it */
    }
  }, [])

  useVisiblePolling(loadStatus, 10000)

  // Redraw the preview whenever anything that affects the label changes.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await waitForFonts()
      if (cancelled) return
      try {
        setPreview(
          renderLabelPreview({
            payload: SAMPLE,
            label: labelDraft,
            timezone,
            mediaWidthMm: draft.mediaWidthMm,
            labelLengthMm: draft.labelLengthMm,
            cssWidth: 760,
          })
        )
      } catch {
        setPreview('')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [labelDraft, draft.mediaWidthMm, draft.labelLengthMm, timezone])

  const dirty = useMemo(
    () =>
      JSON.stringify(draft) !== JSON.stringify(printer) ||
      JSON.stringify(labelDraft) !== JSON.stringify(label),
    [draft, printer, labelDraft, label]
  )

  const save = async () => {
    setSaving(true)
    setMessage(null)
    try {
      await onSave({ printer: draft, label: labelDraft })
      setMessage({ kind: 'ok', text: '저장되었습니다.' })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : '저장 실패' })
    } finally {
      setSaving(false)
    }
  }

  const testPrint = async () => {
    setMessage(null)
    if (dirty) {
      setMessage({ kind: 'warn', text: '먼저 저장한 뒤 테스트 인쇄를 실행해 주세요.' })
      return
    }
    try {
      await waitForFonts()
      const { stream, rasterCount } = renderLabelStream({
        payload: { ...SAMPLE, checkedInAt: new Date().toISOString() },
        label: labelDraft,
        timezone,
        mediaWidthMm: draft.mediaWidthMm,
        labelLengthMm: draft.labelLengthMm,
        threshold: draft.threshold,
      })
      const response = await fetch('/api/print/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stream: base64FromBytes(stream),
          rasterCount,
          kind: 'test',
          label: 'Test print',
          copies: 1,
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? '테스트 인쇄 실패')
      setMessage({
        kind: 'ok',
        text: `테스트 라벨을 대기열에 넣었습니다 (${(data.bytes / 1024).toFixed(1)} KB).`,
      })
      void loadStatus()
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : '테스트 인쇄 실패' })
    }
  }

  const queueAction = async (action: 'requeue' | 'clear') => {
    await fetch(`/api/print/jobs?action=${action}`, { method: 'PATCH' })
    void loadStatus()
  }

  const set = <K extends keyof PrinterSettings>(key: K, value: PrinterSettings[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))
  const setLabel = <K extends keyof LabelSettings>(key: K, value: LabelSettings[K]) =>
    setLabelDraft((d) => ({ ...d, [key]: value }))

  return (
    <>
      <Panel
        title="프린터 설정"
        actions={
          <button type="button" className="iconBtn" onClick={() => void loadStatus()} aria-label="Refresh">
            <RefreshIcon size={18} />
          </button>
        }
        footer={
          <>
            <button type="button" className="btn" onClick={() => void testPrint()}>
              <PrinterIcon size={16} /> 테스트 인쇄
            </button>
            <button type="button" className="btn btnPrimary" onClick={() => void save()} disabled={!dirty || saving}>
              {saving ? <span className="spinner" /> : dirty ? '변경사항 저장' : '저장됨'}
            </button>
          </>
        }
      >
        {message && <Notice kind={message.kind}>{message.text}</Notice>}

        {status && !status.online && status.enabled && (
          <Notice kind="warn">
            프린트 에이전트가 응답하지 않습니다. 교회 PC에서 <code>npm run agent</code> 가 실행 중인지
            확인해 주세요. 그동안의 인쇄 작업은 대기열에 보관됩니다.
          </Notice>
        )}
        {status && status.online && !draft.host && (
          <Notice kind="warn">
            에이전트는 연결되었지만 프린터 IP가 비어 있습니다. QL-820NWB의 IP를 입력해 주세요.
          </Notice>
        )}

        <div className="statRow" style={{ margin: '14px 0 20px' }}>
          <Stat value={status?.online ? '연결됨' : '끊김'} label="에이전트" />
          <Stat value={status?.counts.queued ?? 0} label="대기 중" />
          <Stat value={status?.counts.claimed ?? 0} label="인쇄 중" />
          <Stat value={status?.counts.failed ?? 0} label="실패" />
        </div>

        <h3 className="sectionTitle">연결</h3>
        <div className="fieldGrid">
          <div className="field">
            <label htmlFor="host">프린터 IP 주소</label>
            <input
              id="host"
              value={draft.host}
              onChange={(event) => set('host', event.target.value)}
              placeholder="192.168.1.50"
              inputMode="decimal"
              autoComplete="off"
            />
            <span className="fieldHint">QL-820NWB 본체에서 [메뉴 → WLAN/유선 LAN → IP 주소]</span>
          </div>
          <div className="field">
            <label htmlFor="port">포트</label>
            <input
              id="port"
              type="number"
              value={draft.port}
              onChange={(event) => set('port', Number(event.target.value))}
            />
            <span className="fieldHint">Brother raw 포트는 9100 입니다</span>
          </div>
        </div>

        <h3 className="sectionTitle" style={{ marginTop: 22 }}>
          용지 / 인쇄
        </h3>
        <div className="fieldGrid">
          <div className="field">
            <label htmlFor="mediaWidth">테이프 폭 (mm)</label>
            <select
              id="mediaWidth"
              value={draft.mediaWidthMm}
              onChange={(event) => set('mediaWidthMm', Number(event.target.value))}
            >
              {MEDIA_WIDTHS.map((mm) => (
                <option key={mm} value={mm}>
                  {mm} mm{mm === 62 ? ' (DK-2205 기본)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="labelLength">라벨 길이 (mm)</label>
            <input
              id="labelLength"
              type="number"
              min={20}
              max={300}
              value={draft.labelLengthMm}
              onChange={(event) => set('labelLengthMm', Number(event.target.value))}
            />
          </div>
          <div className="field">
            <label htmlFor="copies">한 번에 인쇄할 장수</label>
            <input
              id="copies"
              type="number"
              min={1}
              max={5}
              value={draft.copies}
              onChange={(event) => set('copies', Number(event.target.value))}
            />
            <span className="fieldHint">2로 두면 보호자 픽업용 태그가 함께 나옵니다</span>
          </div>
          <div className="field">
            <label htmlFor="feed">여백 피드 (dots)</label>
            <input
              id="feed"
              type="number"
              min={0}
              max={500}
              value={draft.feedDots}
              onChange={(event) => set('feedDots', Number(event.target.value))}
            />
          </div>
          <div className="field">
            <label htmlFor="threshold">흑백 임계값</label>
            <input
              id="threshold"
              type="range"
              min={40}
              max={240}
              value={draft.threshold}
              onChange={(event) => set('threshold', Number(event.target.value))}
              style={{ background: 'transparent', padding: 0 }}
            />
            <span className="fieldHint">{draft.threshold} — 글자가 흐리면 값을 올리세요</span>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <Toggle label="인쇄 사용" value={draft.enabled} onChange={(v) => set('enabled', v)} />
          <Toggle label="라벨마다 자동 커팅" value={draft.autocut} onChange={(v) => set('autocut', v)} />
          <Toggle label="마지막 라벨 후 커팅" value={draft.cutAtEnd} onChange={(v) => set('cutAtEnd', v)} />
          <Toggle
            label="180° 회전"
            hint="라벨이 거꾸로 나오면 켜세요"
            value={draft.rotate180}
            onChange={(v) => set('rotate180', v)}
          />
        </div>
      </Panel>

      <Panel title="라벨 내용">
        <div className="labelPreview" style={{ marginBottom: 18 }}>
          {preview ? <img src={preview} alt="Label preview" /> : <div className="emptyState">미리보기 생성 중…</div>}
        </div>

        <Toggle label="한글 이름" value={labelDraft.showKorean} onChange={(v) => setLabel('showKorean', v)} />
        <Toggle label="영어 이름" value={labelDraft.showEnglish} onChange={(v) => setLabel('showEnglish', v)} />
        <Toggle label="학년" value={labelDraft.showGrade} onChange={(v) => setLabel('showGrade', v)} />
        <Toggle label="회차 이름" value={labelDraft.showService} onChange={(v) => setLabel('showService', v)} />
        <Toggle label="픽업 보안코드" value={labelDraft.showCode} onChange={(v) => setLabel('showCode', v)} />
        <Toggle label="날짜 / 시간" value={labelDraft.showDateTime} onChange={(v) => setLabel('showDateTime', v)} />

        <div className="field" style={{ marginTop: 16 }}>
          <label htmlFor="nameScale">이름 크기 ({labelDraft.nameScale.toFixed(2)}×)</label>
          <input
            id="nameScale"
            type="range"
            min={0.6}
            max={1.6}
            step={0.05}
            value={labelDraft.nameScale}
            onChange={(event) => setLabel('nameScale', Number(event.target.value))}
            style={{ background: 'transparent', padding: 0 }}
          />
        </div>
      </Panel>

      <Panel
        title="인쇄 대기열"
        footer={
          <>
            <button type="button" className="btn" onClick={() => void queueAction('requeue')}>
              실패한 작업 재시도
            </button>
            <button type="button" className="btn btnDanger" onClick={() => void queueAction('clear')}>
              대기열 비우기
            </button>
          </>
        }
      >
        {(status?.agents.length ?? 0) > 0 && (
          <div style={{ marginBottom: 16 }}>
            {status!.agents.map((agent) => (
              <div key={agent.id} className="toggleRow">
                <span>
                  <span style={{ fontWeight: 500 }}>
                    {agent.name || agent.id}{' '}
                    <span className={`chip ${agent.online ? 'chipGreen' : 'chipWarn'}`}>
                      {agent.online ? 'online' : 'offline'}
                    </span>
                  </span>
                  <span className="fieldHint" style={{ display: 'block' }}>
                    {agent.printer_host ?? '주소 미보고'} · v{agent.version ?? '?'} ·{' '}
                    {formatDateTime(agent.last_seen_at, timezone)}
                    {agent.last_error ? ` · ${agent.last_error}` : ''}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="tableScroll">
          <table className="table">
            <thead>
              <tr>
                <th>작업</th>
                <th>상태</th>
                <th>시각</th>
              </tr>
            </thead>
            <tbody>
              {(status?.recent ?? []).map((job) => (
                <tr key={job.id}>
                  <td>
                    {job.label || job.kind}
                    {job.error && (
                      <span className="fieldHint" style={{ display: 'block', color: 'var(--red)' }}>
                        {job.error}
                      </span>
                    )}
                  </td>
                  <td>
                    <span
                      className={`chip ${
                        job.status === 'done'
                          ? 'chipGreen'
                          : job.status === 'error'
                            ? 'chipWarn'
                            : 'chipBlue'
                      }`}
                    >
                      {job.status}
                      {job.attempts > 1 ? ` ×${job.attempts}` : ''}
                    </span>
                  </td>
                  <td>{formatDateTime(job.completed_at ?? job.created_at, timezone)}</td>
                </tr>
              ))}
              {(status?.recent.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={3} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 22 }}>
                    인쇄 기록이 없습니다.
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
